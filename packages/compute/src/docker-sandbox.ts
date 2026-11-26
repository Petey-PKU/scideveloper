import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { PythonExecResult, SandboxOutputHandler } from './python-sandbox.js';

const runFile = promisify(execFile);
const imageDefault = 'python:3.12-slim';

export interface DockerAvailability {
  available: boolean;
  version?: string;
}

export interface DockerExecuteOptions {
  workspaceDir?: string;
  image?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  allowNetwork?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: SandboxOutputHandler;
}

type ContainerArtifacts = Pick<PythonExecResult, 'figureBundles' | 'plotlyCharts' | 'metrics'>;
const abortError = () => new DOMException('Docker sandbox execution aborted', 'AbortError');

async function outputFiles(outputDir: string): Promise<Set<string>> {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
}

function mountedFile(outputDir: string, files: Set<string>, file: unknown): string | undefined {
  if (typeof file !== 'string' || !file.startsWith('/output/')) return undefined;
  const name = file.slice('/output/'.length);
  if (name.includes('/') || name.includes('\\') || !files.has(name)) return undefined;
  return path.join(outputDir, name);
}

function parseArtifacts(metadata: ContainerArtifacts | undefined, files: Set<string>, output: string): ContainerArtifacts {
  const figureBundles = (Array.isArray(metadata?.figureBundles) ? metadata.figureBundles : []).flatMap((bundle) => {
    const pngPath = mountedFile(output, files, bundle?.pngPath);
    if (!pngPath) return [];
    const svgPath = mountedFile(output, files, bundle.svgPath);
    const pdfPath = mountedFile(output, files, bundle.pdfPath);
    return [{ pngPath, ...(svgPath && { svgPath }), ...(pdfPath && { pdfPath }) }];
  });
  const plotlyCharts = (Array.isArray(metadata?.plotlyCharts) ? metadata.plotlyCharts : []).flatMap((chart) => {
    const filePath = mountedFile(output, files, chart?.filePath);
    if (!filePath || typeof chart.title !== 'string') return [];
    return [{ filePath, title: chart.title, ...(typeof chart.description === 'string' && { description: chart.description }) }];
  });
  const metrics = metadata?.metrics;
  return { figureBundles, ...(plotlyCharts.length && { plotlyCharts }),
    metrics: metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : null };
}

export class DockerSandboxWorker {
  static async isAvailable(): Promise<DockerAvailability> {
    try {
      const { stdout } = await runFile('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeout: 3000, windowsHide: true,
      });
      const version = stdout.trim();
      return version && version !== '<no value>' ? { available: true, version } : { available: false };
    } catch {
      return { available: false };
    }
  }

  async execute(code: string, outputDir: string, options: DockerExecuteOptions = {}): Promise<PythonExecResult> {
    const { image = imageDefault, memoryLimitMb = 4096, cpuLimit = 2, timeoutMs = 45_000, signal, onOutput } = options;
    if (signal?.aborted) throw abortError();
    if (!image || image.startsWith('-') || /\s/.test(image)) throw new Error('Expected a Docker image reference');
    if (!Number.isSafeInteger(memoryLimitMb) || memoryLimitMb <= 0) throw new RangeError('Docker memory limit must be a positive integer');
    if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) throw new RangeError('Docker CPU limit must be positive');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Docker timeout must be positive');

    await fs.mkdir(outputDir, { recursive: true });
    const output = await fs.realpath(outputDir);
    const workspace = options.workspaceDir === undefined ? undefined : await fs.realpath(options.workspaceDir);
    if (workspace !== undefined) {
      const relative = path.relative(output, workspace);
      if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
        throw new Error('Docker output directory must be separate from or inside the read-only workspace');
      }
      if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Docker workspace must be a directory');
    }
    // Docker's -v syntax treats colons as delimiters apart from a Windows drive prefix.
    for (const directory of [output, workspace]) {
      if (directory && directory.slice(path.parse(directory).root.length).includes(':')) {
        throw new Error('Docker bind mount paths cannot contain colons');
      }
    }
    const [before, artifacts, runner] = await Promise.all([
      outputFiles(output),
      fs.readFile(new URL('../python/execution_artifacts.py', import.meta.url), 'utf8'),
      fs.readFile(new URL('../python/docker_runner.py', import.meta.url), 'utf8'),
    ]);
    if (signal?.aborted) throw abortError();

    const name = `scidev-${randomUUID()}`;
    const marker = `\x1eSCIDEV_METRICS_${name} `;
    const args = [
      'run', '--rm', '-i', '--name', name,
      ...(!options.allowNetwork ? ['--network=none'] : []),
      `--memory=${memoryLimitMb}m`, `--cpus=${cpuLimit}`,
      '--security-opt=no-new-privileges', '--cap-drop=ALL',
      ...(workspace === undefined ? [] : ['-v', `${workspace}:/workspace:ro`]),
      '-v', `${output}:/output:rw`, '-w', '/output',
      '-e', 'SCIDEV_WORKSPACE_DIR=/workspace', '-e', 'SCIDEV_OUTPUT_DIR=/output',
      '-e', 'MPLBACKEND=Agg', '-e', 'PYTHONIOENCODING=utf-8',
      '--entrypoint=python', '--', image, '-u', '-B', '-c', artifacts + '\n' + runner, marker,
    ];
    const started = performance.now();
    const child = spawn('docker', args, { windowsHide: true, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let metadata: ContainerArtifacts | undefined;
    let buffer = '';

    function emit(stream: 'stdout' | 'stderr', chunk: string) {
      if (!chunk) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      try { onOutput?.(stream, chunk); } catch { /* Output observers cannot interrupt the container. */ }
    }

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer) {
        const start = buffer.indexOf('\x1e');
        if (start === -1) {
          emit('stdout', buffer);
          buffer = '';
          return;
        }
        emit('stdout', buffer.slice(0, start));
        buffer = buffer.slice(start);
        if (buffer.length < marker.length && marker.startsWith(buffer)) return;
        if (!buffer.startsWith(marker)) {
          emit('stdout', buffer[0]);
          buffer = buffer.slice(1);
          continue;
        }
        const end = buffer.indexOf('\n', marker.length);
        if (end === -1) return;
        try { metadata = JSON.parse(buffer.slice(marker.length, end)); } catch { /* Invalid artifact metadata. */ }
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => emit('stderr', chunk));
    child.stdin.on('error', () => { /* The Docker client may close stdin before consuming the cell. */ });
    let abort = false;
    let timedOut = false;
    const cancel = () => { abort = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const closed = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else child.stdin.end(JSON.stringify({ code }));

    let exitCode: number;
    try {
      exitCode = await closed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (abort || timedOut) {
        await runFile('docker', ['rm', '-f', name], { timeout: 3000, windowsHide: true }).catch(() => {});
      }
    }
    if (abort) throw abortError();
    if (timedOut) throw new Error(`Docker sandbox execution timed out after ${timeoutMs}ms`);
    emit('stdout', buffer);
    const files = await outputFiles(output);
    const result = parseArtifacts(metadata, files, output);
    return {
      ...result, exitCode, stdout, stderr, durationMs: Math.round(performance.now() - started),
      figures: (result.figureBundles ?? []).map((bundle) => bundle.pngPath),
      createdFiles: [...files].filter((file) => !before.has(file)).sort().map((file) => path.join(output, file)),
    };
  }
}
