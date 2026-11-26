import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { EnvironmentSnapshot, KernelVariableInfo, PythonEnvironmentInfo } from '@scideveloper/shared';

export type SandboxOutputHandler = (stream: 'stdout' | 'stderr', chunk: string) => void;

export interface PythonExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  figures: string[];
  figureBundles?: Array<{ pngPath: string; svgPath?: string; pdfPath?: string }>;
  plotlyCharts?: Array<{ filePath: string; title: string; description?: string }>;
  createdFiles: string[];
  metrics: Record<string, unknown> | null;
}

export interface PythonExecuteOptions {
  strictSandbox?: boolean;
  allowedHosts?: string[];
  signal?: AbortSignal;
  onOutput?: SandboxOutputHandler;
  memoryLimitMb?: number;
}

function abortError(): Error {
  return new DOMException('Python sandbox execution aborted', 'AbortError');
}

interface KernelResponse {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
  event?: 'output' | 'memory-limit';
  stream?: 'stdout' | 'stderr';
  chunk?: string;
}

const runFile = promisify(execFile);
const pythonProbe = [
  'import json, platform, sys',
  'print(json.dumps(dict(executable=sys.executable, version=platform.python_version(),',
  'prefix=sys.prefix, virtual=sys.prefix != sys.base_prefix)))',
].join('\n');

interface ActivePython {
  executable: string;
  version: string;
  prefix: string;
  virtual: boolean;
}

function samePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function probeActivePython(bin: string): Promise<ActivePython | undefined> {
  try {
    const { stdout } = await runFile(bin, ['-I', '-c', pythonProbe], { timeout: 3000, windowsHide: true });
    const info = JSON.parse(stdout) as Partial<ActivePython> | null;
    if (typeof info?.executable === 'string' && path.isAbsolute(info.executable) &&
        typeof info.prefix === 'string' && typeof info.version === 'string' && typeof info.virtual === 'boolean') {
      return info as ActivePython;
    }
  } catch {
    // The configured interpreter may be missing or unable to start.
  }
  return undefined;
}

async function findCondaPrefixes(): Promise<string[]> {
  try {
    const { stdout } = await runFile(process.env.CONDA_EXE || 'conda', ['info', '--envs', '--json'], {
      timeout: 5000,
      windowsHide: true,
    });
    const { envs } = JSON.parse(stdout) as { envs?: unknown };
    return Array.isArray(envs)
      ? envs.filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry))
      : [];
  } catch {
    return [];
  }
}

export async function listPythonEnvironments(activeBin?: string): Promise<PythonEnvironmentInfo[]> {
  const cwd = process.cwd();
  const [active, prefixes] = await Promise.all([
    probeActivePython(activeBin ?? process.env.SCIDEV_PYTHON_BIN ?? 'python'),
    findCondaPrefixes(),
  ]);
  const windows = process.platform === 'win32';
  const environments = new Map<string, PythonEnvironmentInfo>();
  const activeKey = active && samePathKey(active.executable);
  const activePrefixKey = active && samePathKey(active.prefix);
  const add = (name: string, executable: string, kind: PythonEnvironmentInfo['kind']) => {
    const id = samePathKey(executable);
    if (environments.has(id)) return;
    const isActive = id === activeKey;
    environments.set(id, { id, name, executable, kind, active: isActive, version: isActive ? active?.version : undefined });
  };
  const hasFile = async (file: string) => fs.promises.stat(file).then((stat) => stat.isFile(), () => false);
  const candidates = [
    ...prefixes.map((prefix) => ({
      name: path.basename(prefix),
      prefix,
      executable: path.join(prefix, windows ? 'python.exe' : 'bin/python'),
      kind: 'conda' as const,
    })),
    ...['.venv', 'venv'].map((name) => ({
      name,
      prefix: path.join(cwd, name),
      executable: path.join(cwd, name, windows ? 'Scripts/python.exe' : 'bin/python'),
      kind: 'venv' as const,
    })),
  ];
  const present = await Promise.all(candidates.map(({ executable }) => hasFile(executable)));
  for (const [index, { name, prefix, executable, kind }] of candidates.entries()) {
    if (!present[index]) continue;
    add(name, active && samePathKey(prefix) === activePrefixKey ? active.executable : executable, kind);
  }
  if (active && activeKey && !environments.has(activeKey)) {
    const conda = await fs.promises.stat(path.join(active.prefix, 'conda-meta')).then((stat) => stat.isDirectory(), () => false);
    const kind = active.virtual ? 'venv' : conda ? 'conda' : 'system';
    add(kind === 'system' ? 'System Python' : path.basename(active.prefix), active.executable, kind);
  }
  return Array.from(environments.values()).sort((a, b) => Number(b.active) - Number(a.active));
}

export class PythonSandboxWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; onOutput?: SandboxOutputHandler }
  >();
  private readonly pythonBin: string;
  private readonly kernelScriptPath: string;
  public readonly workingDir: string;

  constructor(workingDir: string, pythonBin?: string) {
    this.workingDir = path.resolve(workingDir);
    fs.mkdirSync(this.workingDir, { recursive: true });
    this.pythonBin = pythonBin ?? process.env.SCIDEV_PYTHON_BIN ?? 'python';
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    this.kernelScriptPath = path.resolve(currentDir, '../python/python_kernel.py');
  }

  private ensureStarted(): void {
    if (this.proc && !this.proc.killed) return;

    const proc = spawn(this.pythonBin, ['-u', '-B', this.kernelScriptPath], {
      cwd: this.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        MPLBACKEND: 'Agg',
      },
    });

    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (this.proc !== proc || !line.trim()) return;
      try {
        const msg = JSON.parse(line) as KernelResponse;
        const entry = msg.id ? this.pending.get(msg.id) : undefined;
        if (msg.id && entry) {
          if (msg.event === 'output') {
            if ((msg.stream === 'stdout' || msg.stream === 'stderr') && typeof msg.chunk === 'string') {
              entry.onOutput?.(msg.stream, msg.chunk);
            }
            return;
          }
          if (msg.event === 'memory-limit') {
            this.failProcess(proc, new Error(msg.error ?? 'Python sandbox memory limit exceeded'));
            proc.kill('SIGKILL');
            return;
          }
          this.pending.delete(msg.id);
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(new Error(msg.error ?? 'Python kernel error'));
        }
      } catch {
        // Ignore malformed non-JSON line
      }
    });

    proc.on('close', () => {
      this.failProcess(proc, new Error('Python sandbox worker exited unexpectedly'));
    });
    proc.on('error', (err) => this.failProcess(proc, err));
    proc.stdin.on('error', (err) => this.failProcess(proc, err));
    proc.stderr.resume();
  }

  private failProcess(proc: ChildProcessWithoutNullStreams, err: Error): void {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  private sendRequest<T>(
    payload: Record<string, unknown>, timeoutMs = 45_000, signal?: AbortSignal, onOutput?: SandboxOutputHandler,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    this.ensureStarted();
    const proc = this.proc!;
    const id = crypto.randomUUID().slice(0, 12);
    return new Promise<T>((resolve, reject) => {
      const stop = (error: Error) => {
        this.failProcess(proc, error);
        proc.kill('SIGKILL');
      };
      const onAbort = () => stop(abortError());
      const timer = setTimeout(() => stop(new Error(`Python sandbox execution timed out after ${timeoutMs}ms`)), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      this.pending.set(id, {
        onOutput,
        resolve: (val) => {
          cleanup();
          resolve(val as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.sendRequest({ op: 'ping' }, 5000);
      return true;
    } catch {
      return false;
    }
  }

  async captureEnvironment(computeTargetId = 'local-sandbox'): Promise<EnvironmentSnapshot> {
    const info = await this.sendRequest<{
      pythonVersion: string;
      pythonExecutable: string;
      packages: Record<string, string>;
      workingDirectory: string;
    }>({ op: 'env', workingDir: this.workingDir }, 15_000);

    return {
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      computeTargetId,
      computeTargetKind: 'local-sandbox',
      pythonVersion: info.pythonVersion,
      pythonExecutable: info.pythonExecutable,
      packages: info.packages,
      workingDirectory: info.workingDirectory,
    };
  }

  async execute(
    code: string, outputDir: string, timeoutMs = 45_000, workspaceDir?: string, options: PythonExecuteOptions = {}
  ): Promise<PythonExecResult> {
    if (options.signal?.aborted) throw abortError();
    fs.mkdirSync(outputDir, { recursive: true });
    return this.sendRequest<PythonExecResult>(
      {
        op: 'exec',
        code,
        outputDir: path.resolve(outputDir),
        workingDir: this.workingDir,
        workspaceDir: workspaceDir === undefined ? undefined : path.resolve(workspaceDir),
        strictSandbox: options.strictSandbox ?? true,
        allowedHosts: options.allowedHosts ?? [],
        memoryLimitMb: Number.isFinite(options.memoryLimitMb) && options.memoryLimitMb! > 0
          ? options.memoryLimitMb : undefined,
      },
      timeoutMs,
      options.signal,
      options.onOutput,
    );
  }

  async listVariables(): Promise<KernelVariableInfo[]> {
    return this.sendRequest({ op: 'vars' }, 15_000);
  }

  async reset(): Promise<void> {
    await this.sendRequest({ op: 'reset' }, 5000);
  }

  dispose(): void {
    const proc = this.proc;
    if (proc && !proc.killed) {
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      proc.kill();
    }
    if (proc) this.failProcess(proc, new Error('Python sandbox worker disposed'));
  }

  async disposeAsync(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 1500);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.dispose();
    await exited;
  }
}
