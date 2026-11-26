import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { KernelVariableInfo } from '@scideveloper/shared';
import type { SandboxOutputHandler } from './python-sandbox.js';

const runFile = promisify(execFile);
const executable = 'Rscript';
const kernelScript = fileURLToPath(new URL('../r/r_kernel.R', import.meta.url));

export interface RAvailability {
  available: boolean;
  persistentReady: boolean;
  version?: string;
  executable?: string;
}

export interface RExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  figures: string[];
  createdFiles: string[];
  rVersion?: string;
}

export interface RExecuteOptions {
  onOutput?: SandboxOutputHandler;
  signal?: AbortSignal;
}

function abortError(): Error {
  return new DOMException('R sandbox execution aborted', 'AbortError');
}

function emitOutput(handler: SandboxOutputHandler | undefined, stream: 'stdout' | 'stderr', chunk: string): void {
  if (!chunk) return;
  try { handler?.(stream, chunk); } catch { /* Output observers cannot interrupt the kernel. */ }
}

const fromHex = (value: string) => Buffer.from(value, 'hex').toString('utf8');

async function listOutputFiles(outputDir: string): Promise<string[]> {
  const entries = await fs.readdir(outputDir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

type CellResult = Pick<RExecResult, 'exitCode' | 'stdout' | 'stderr' | 'rVersion'>;

interface RKernel {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<string>;
  fail: (error: Error) => void;
  request?: { id: string; resolve: (result: unknown) => void; reject: (error: Error) => void };
}

class RKernelTimeoutError extends Error {}

function setReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
  const method = referenced ? 'ref' : 'unref';
  child[method]();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const pipe = stream as typeof stream & { ref?: () => void; unref?: () => void };
    pipe[method]?.();
  }
}

export class RScriptSandboxWorker {
  private readonly kernels = new Map<string, RKernel>();
  private readonly stoppingKernels = new Set<Promise<void>>();
  private fallback?: AbortController;
  private queue = Promise.resolve();
  private generation = 0;
  private currentKernel?: RKernel;

  static async isAvailable(): Promise<RAvailability> {
    let version: string | undefined;
    try {
      const { stdout, stderr } = await runFile(executable, ['--version'], { timeout: 3000, windowsHide: true });
      version = `${stdout}\n${stderr}`.match(/\bversion\s+(\d+(?:\.\d+)+)/i)?.[1];
    } catch {
      return { available: false, persistentReady: false };
    }
    const worker = new RScriptSandboxWorker();
    try {
      version = await worker.startKernel().ready;
      return { available: true, persistentReady: true, version, executable };
    } catch {
      return { available: true, persistentReady: false, version, executable };
    } finally {
      await worker.disposeAsync();
    }
  }

  execute(code: string, outputDir: string, workspaceDir?: string, timeoutMs = 45_000,
          options: RExecuteOptions = {}): Promise<RExecResult> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    const generation = this.generation;
    const result = this.queue.then(() => this.executeCell(code, outputDir, workspaceDir, timeoutMs, generation, options));
    this.queue = result.then(() => undefined, () => undefined);
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError());
      signal.addEventListener('abort', cancel, { once: true });
      void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }

  listVariables(): Promise<KernelVariableInfo[]> {
    const generation = this.generation;
    const result = this.queue.then(async () => {
      const kernel = this.currentKernel;
      if (!kernel || generation !== this.generation) return [];
      try {
        const entries = await this.sendRequest(kernel, 'vars', [], 5000) as Array<
          Required<Pick<KernelVariableInfo, 'name' | 'typeName' | 'shape' | 'preview' | 'columns' | 'sizeBytes'>>
        >;
        return entries.map(({ name, typeName, shape, preview, sizeBytes, columns }) => ({
          name: fromHex(name), typeName: fromHex(typeName), shape: fromHex(shape), preview: fromHex(preview),
          sizeBytes, ...(columns.length && { columns: columns.map(fromHex) }),
        }));
      } catch {
        return [];
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async reset(): Promise<void> {
    await this.disposeAsync();
  }

  private async executeCell(code: string, outputDir: string, workspaceDir: string | undefined, timeoutMs: number,
                            generation: number, { signal, onOutput }: RExecuteOptions): Promise<RExecResult> {
    const checkDisposed = () => {
      if (signal?.aborted) throw abortError();
      if (generation !== this.generation) throw new Error('R sandbox worker disposed');
    };
    checkDisposed();
    const output = path.resolve(outputDir);
    const workspace = path.resolve(workspaceDir ?? output);
    const workspaceKey = workspaceDir === undefined ? '' : process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    await fs.mkdir(output, { recursive: true });
    const before = new Set(await listOutputFiles(output));
    checkDisposed();
    const started = performance.now();
    const prefix = `figure_${randomUUID()}`;
    let kernel: RKernel | undefined;
    const cancelStartup = () => kernel?.fail(abortError());
    try {
      kernel = this.startKernel(workspaceKey);
      signal?.addEventListener('abort', cancelStartup, { once: true });
      await kernel.ready;
      if (this.kernels.get(workspaceKey) !== kernel) kernel = undefined;
    } catch {
      // Startup failed before the cell was sent, so a one-shot run is safe.
      kernel = undefined;
    } finally {
      signal?.removeEventListener('abort', cancelStartup);
    }
    checkDisposed();
    let result: CellResult;
    if (kernel) {
      this.currentKernel = kernel;
      try {
        const response = await this.sendRequest(kernel, 'exec', [code, output, workspace, prefix], timeoutMs, signal) as {
          exitCode?: number; stdoutHex?: string; stderrHex?: string; rVersion?: string;
        } | undefined;
        if (typeof response?.exitCode !== 'number' || typeof response.stdoutHex !== 'string' ||
            typeof response.stderrHex !== 'string') {
          kernel.fail(new Error('Invalid response from the Rscript kernel'));
          throw new Error('Invalid response from the Rscript kernel');
        }
        result = { exitCode: response.exitCode, stdout: fromHex(response.stdoutHex),
          stderr: fromHex(response.stderrHex), rVersion: response.rVersion };
      } catch (error) {
        checkDisposed();
        result = { exitCode: error instanceof RKernelTimeoutError ? 124 : 1, stdout: '', stderr: String(error) };
      }
      emitOutput(onOutput, 'stdout', result.stdout);
      emitOutput(onOutput, 'stderr', result.stderr);
    } else {
      this.currentKernel = undefined;
      const fallback = new AbortController();
      this.fallback = fallback;
      try {
        const runSignal = signal ? AbortSignal.any([signal, fallback.signal]) : fallback.signal;
        result = await this.executeOnce(code, output, workspace, prefix, timeoutMs, runSignal, onOutput);
      } finally {
        this.fallback = undefined;
      }
    }
    const createdFiles = (await listOutputFiles(output)).filter((file) => !before.has(file));
    checkDisposed();
    return {
      ...result,
      durationMs: Math.round(performance.now() - started),
      figures: createdFiles.filter((file) => path.extname(file).toLowerCase() === '.png'),
      createdFiles,
    };
  }

  private startKernel(workspaceKey = ''): RKernel {
    const existing = this.kernels.get(workspaceKey);
    if (existing) return existing;
    const child = spawn(executable, ['--vanilla', kernelScript, '--persistent'], { windowsHide: true });
    let markReady!: (version: string) => void;
    let rejectStartup!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      markReady = resolve;
      rejectStartup = reject;
    });
    const stopped = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.stoppingKernels.add(stopped);
    void stopped.then(() => this.stoppingKernels.delete(stopped));
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = '';
    const kernel: RKernel = {
      process: child, ready,
      fail: (error) => {
        if (this.kernels.get(workspaceKey) !== kernel) return;
        this.kernels.delete(workspaceKey);
        clearTimeout(timer);
        lines.close();
        rejectStartup(error);
        kernel.request?.reject(error);
        kernel.request = undefined;
        if (this.currentKernel === kernel) this.currentKernel = undefined;
        if (child.exitCode === null && child.signalCode === null) {
          setReferenced(child, true);
          child.kill('SIGKILL');
        }
      },
    };
    this.kernels.set(workspaceKey, kernel);
    const timer = setTimeout(() => kernel.fail(new Error('Rscript kernel startup timed out')), 5000);
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.jsonrpc !== '2.0') return;
      if (message.method === 'ready' && typeof message.params?.version === 'string') {
        clearTimeout(timer);
        markReady(message.params.version);
        setReferenced(child, false);
      } else if (kernel.request && message.id === kernel.request.id) {
        kernel.request.resolve(message.result);
        kernel.request = undefined;
        setReferenced(child, false);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr = (stderr + data).slice(-16_384); });
    child.on('error', (error) => kernel.fail(error));
    child.stdin.on('error', (error) => kernel.fail(error));
    child.on('close', () => kernel.fail(new Error(`Rscript kernel exited unexpectedly${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    return kernel;
  }

  private async sendRequest(kernel: RKernel, method: 'exec' | 'vars', values: string[], timeoutMs: number,
                            signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    setReferenced(kernel.process, true);
    const id = randomUUID();
    const promise = new Promise((resolve, reject) => { kernel.request = { id, resolve, reject }; });
    const timer = setTimeout(() => kernel.fail(new RKernelTimeoutError(`Rscript execution timed out after ${timeoutMs}ms`)), timeoutMs);
    const cancel = () => kernel.fail(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const params = values.map((value) => Buffer.from(value, 'utf8').toString('hex'));
      kernel.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return await promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private async executeOnce(code: string, output: string, workspace: string, prefix: string, timeoutMs: number,
                            signal: AbortSignal, onOutput?: SandboxOutputHandler): Promise<CellResult> {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scidev-r-'));
    try {
      const sourcePath = path.join(temporaryDir, 'cell.R');
      const versionPath = path.join(temporaryDir, 'version');
      await fs.writeFile(sourcePath, code, 'utf8');

      const args = ['--vanilla', kernelScript, sourcePath, output, workspace, versionPath, prefix];
      let exitCode = 0;
      let stdout = '';
      let stderr = '';
      let streamedStdout = false;
      let streamedStderr = false;
      try {
        const running = runFile(executable, args, {
          cwd: output,
          signal,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        running.child?.stdout?.setEncoding('utf8').on('data', (chunk) => {
          streamedStdout = true;
          emitOutput(onOutput, 'stdout', chunk);
        });
        running.child?.stderr?.setEncoding('utf8').on('data', (chunk) => {
          streamedStderr = true;
          emitOutput(onOutput, 'stderr', chunk);
        });
        ({ stdout, stderr } = await running);
      } catch (error) {
        const failure = error as Error & { code?: number | string | null; killed?: boolean; stdout?: string; stderr?: string };
        const timedOut = failure.killed && failure.code === null;
        exitCode = timedOut ? 124 : typeof failure.code === 'number' ? failure.code : 1;
        stdout = failure.stdout ?? '';
        stderr = failure.stderr ?? '';
        if (timedOut) {
          stderr += `\nRscript execution timed out after ${timeoutMs}ms\n`;
        } else if (!stderr || typeof failure.code === 'string') {
          stderr += `\nRscript: ${failure.message}\n`;
        }
      }
      if (!streamedStdout) emitOutput(onOutput, 'stdout', stdout);
      if (!streamedStderr) emitOutput(onOutput, 'stderr', stderr);
      const rVersion = await fs.readFile(versionPath, 'utf8').then((version) => version.trim(), (error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      return { exitCode, stdout, stderr, rVersion };
    } finally {
      await fs.rm(temporaryDir, { recursive: true, force: true });
    }
  }

  dispose(): void {
    this.generation++;
    for (const kernel of this.kernels.values()) kernel.fail(new Error('R sandbox worker disposed'));
    this.fallback?.abort();
  }

  async disposeAsync(): Promise<void> {
    const finished = this.queue;
    this.dispose();
    await Promise.all([finished, ...this.stoppingKernels]);
  }
}
