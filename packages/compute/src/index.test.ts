import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import type { SlurmJobSpec } from '@scideveloper/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseEnvironment,
  DockerSandboxWorker,
  extractPdfPages,
  installPythonPackages,
  listPythonEnvironments,
  PermissionDeniedError,
  PermissionGate,
  PythonSandboxWorker,
  RScriptSandboxWorker,
  SlurmHpcAdapter,
  WorkspaceExplorer,
} from './index.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: vi.fn(promisify(actual.execFile)),
  });
  return { ...actual, execFile, spawn: vi.fn(actual.spawn) };
});

const testDirectories: string[] = [];

function makeTestDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-compute-'));
  testDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const directory of testDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('@scideveloper/compute core', () => {
  it('enforces permission gates including interactive ask/approve and path boundaries', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-perm-'));
    const gate = new PermissionGate({
      policy: {
        allowedWorkspaceRoots: [tmpDir],
        rules: {
          fs_read: 'allow',
          fs_write: 'allow',
          local_exec: 'allow',
          network_connector: 'allow',
          remote_hpc_submit: 'ask',
        },
      },
    });

    expect(gate.evaluateDecision('fs_write', path.join(tmpDir, 'out.csv'))).toBe('allow');
    expect(gate.evaluateDecision('fs_write', path.join(os.tmpdir(), 'outside.csv'))).toBe('ask');

    // Interactive approval test
    let requestedId = '';
    const askGate = new PermissionGate({
      onRequest: (req) => {
        requestedId = req.id;
        setTimeout(() => askGate.decide(req.id, true), 20);
      },
    });
    const approved = await askGate.assertAllowed('sess_1', 'remote_hpc_submit', 'lab-hpc', 'Run job');
    expect(approved.status).toBe('approved');
    expect(requestedId).toBe(approved.id);

    // Deny rule test
    gate.updatePolicy({ rules: { ...gate.getPolicy().rules, local_exec: 'deny' } });
    await expect(
      gate.assertAllowed('sess_1', 'local_exec', 'python', 'test')
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes persistent Python scientific code and generates matplotlib figures', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-py-'));
    const outDir = path.join(tmpDir, 'artifacts');
    const worker = new PythonSandboxWorker(tmpDir);

    const env = await worker.captureEnvironment();
    expect(env.pythonVersion).toBeTruthy();

    // Cell 1: set variable
    const res1 = await worker.execute('x = 21 * 2\nprint("answer=", x)', outDir);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain('answer= 42');

    // Cell 2: reuse variable across persistent kernel and plot a figure
    const res2 = await worker.execute(
      `
import matplotlib.pyplot as plt
plt.figure(figsize=(4, 3))
plt.plot([1, 2, 3], [x, x + 5, x + 12])
plt.title("Persistent State Plot")
SCIDEV_METRICS = {"final_x": x, "n_points": 3}
`,
      outDir
    );
    expect(res2.exitCode).toBe(0);
    expect(res2.figures.length).toBe(1);
    expect(fs.existsSync(res2.figures[0])).toBe(true);
    expect(res2.metrics).toEqual({ final_x: 42, n_points: 3 });

    await worker.disposeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('generates valid Slurm sbatch scripts and simulates HPC job submission', async () => {
    const adapter = new SlurmHpcAdapter();
    const gate = new PermissionGate({
      policy: {
        rules: {
          fs_read: 'allow',
          fs_write: 'allow',
          local_exec: 'allow',
          network_connector: 'allow',
          remote_hpc_submit: 'allow',
        },
      },
    });

    const script = adapter.generateSbatchScript({
      targetId: 'lab-hpc-slurm',
      jobName: 'rnaseq_align',
      partition: 'gpu-a100',
      cpus: 16,
      memGb: 64,
      gpus: 1,
      walltime: '04:00:00',
      condaEnv: 'bioinfo',
      command: 'python run_pipeline.py --threads 16',
    });
    expect(script).toContain('#SBATCH --job-name=rnaseq_align');
    expect(script).toContain('#SBATCH --gres=gpu:1');
    expect(script).toContain('conda activate bioinfo');

    const job = await adapter.submitJob('sess_1', {
      targetId: 'lab-hpc-slurm',
      jobName: 'rnaseq_align',
      partition: 'gpu-a100',
      cpus: 16,
      memGb: 64,
      walltime: '01:00:00',
      command: 'echo hello',
    }, gate);
    expect(job.mode).toBe('simulated');
    expect(job.slurmJobId).toMatch(/^\d+$/);
  });
});

describe('Python publication exports and environment discovery', () => {
  it('exports every open figure as PNG, SVG, and PDF, and reads data from the workspace', async () => {
    const workspace = makeTestDirectory();
    const workingDir = path.join(workspace, 'kernel');
    const output = path.join(workspace, 'artifacts');
    fs.writeFileSync(path.join(workspace, 'data.csv'), 'x,y\n1,2\n3,5\n', 'utf8');
    const worker = new PythonSandboxWorker(workingDir);
    try {
      const env = await worker.captureEnvironment();
      expect(env.pythonExecutable).toBeTruthy();
      expect(path.isAbsolute(env.pythonExecutable!)).toBe(true);
      const result = await worker.execute(`
import csv
from pathlib import Path
import matplotlib.pyplot as plt

with (Path(SCIDEV_WORKSPACE_DIR) / "data.csv").open() as data:
    rows = list(csv.DictReader(data))
for column in ("x", "y"):
    plt.figure()
    plt.plot([int(row[column]) for row in rows])
`, output, undefined, workspace);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.figureBundles).toHaveLength(2);
      expect(result.figures).toEqual(result.figureBundles!.map((bundle) => bundle.pngPath));
      for (const { pngPath, svgPath, pdfPath } of result.figureBundles!) {
        const basename = pngPath.slice(0, -4);
        expect(path.basename(basename)).toMatch(/^figure_\d+_[01]$/);
        expect(svgPath).toBe(basename + '.svg');
        expect(pdfPath).toBe(basename + '.pdf');
        expect(result.createdFiles).toEqual(expect.arrayContaining([pngPath, svgPath, pdfPath]));
        expect(fs.readFileSync(pngPath).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(fs.readFileSync(svgPath!, 'utf8')).toContain('<svg');
        expect(fs.readFileSync(pdfPath!).subarray(0, 5).toString()).toBe('%PDF-');
      }
      const next = await worker.execute('print(SCIDEV_WORKSPACE_DIR)', output);
      expect(next.stdout.trim()).toBe(workingDir);
      expect(next.figureBundles).toEqual([]);
    } finally {
      await worker.disposeAsync();
    }
  });

  it('finds the active Python and local virtual environments whether Conda responds or is unavailable', async () => {
    const workspace = makeTestDirectory();
    const localPython = path.join(workspace, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const condaPrefix = path.join(workspace, 'conda', 'scientific');
    const condaPython = path.join(condaPrefix, process.platform === 'win32' ? 'python.exe' : 'bin/python');
    for (const executable of [localPython, condaPython]) {
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, 'Discovered interpreters should not be executed');
    }
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    const condaBin = path.join(workspace, 'conda-executable');
    vi.stubEnv('CONDA_EXE', condaBin);
    const interpreter = {
      stdout: JSON.stringify({ executable: condaPython, version: '3.12.4', prefix: condaPrefix, virtual: false }),
      stderr: '',
    };
    const runFile = vi.mocked(promisify(execFile));
    runFile.mockClear();
    runFile
      .mockResolvedValueOnce(interpreter)
      .mockResolvedValueOnce({ stdout: JSON.stringify({ envs: [condaPrefix] }), stderr: '' })
      .mockResolvedValueOnce(interpreter)
      .mockRejectedValueOnce(new Error('Conda is unavailable'));
    const environments = await listPythonEnvironments(condaPython);
    expect(environments[0]).toEqual(expect.objectContaining({
      active: true,
      executable: condaPython,
      kind: 'conda',
      name: 'scientific',
      version: '3.12.4',
    }));
    expect(environments.filter((entry) => entry.active)).toHaveLength(1);
    expect(environments).toContainEqual(expect.objectContaining({
      kind: 'venv',
      name: '.venv',
      executable: localPython,
      active: false,
    }));
    expect(new Set(environments.map((entry) => entry.id)).size).toBe(environments.length);
    const fallback = await listPythonEnvironments(condaPython);
    expect(fallback.filter((entry) => entry.active)).toHaveLength(1);
    expect(fallback[0].executable).toBe(condaPython);
    expect(fallback[1].executable).toBe(localPython);
    expect(runFile.mock.calls.map(([command]) => command)).toEqual([condaPython, condaBin, condaPython, condaBin]);
    expect(runFile).toHaveBeenNthCalledWith(2, condaBin, ['info', '--envs', '--json'], expect.any(Object));
  });
});

describe('Python cell streaming and inspection', () => {
  it('delivers stdout and stderr while Python is still waiting for the caller', async () => {
    const output = makeTestDirectory();
    const worker = new PythonSandboxWorker(output);
    const received = { stdout: '', stderr: '' };
    try {
      const result = await worker.execute(`
import sys, time
from pathlib import Path
release = Path(SCIDEV_OUTPUT_DIR) / "release"
sys.stdout.write("first output")
sys.stderr.write("first warning")
for _ in range(300):
    if release.exists():
        break
    time.sleep(0.01)
else:
    raise RuntimeError("Live output never arrived")
print(" finished")
`, output, 10_000, undefined, {
        onOutput(stream, chunk) {
          received[stream] += chunk;
          if (received.stdout === 'first output' && received.stderr === 'first warning') {
            fs.writeFileSync(path.join(output, 'release'), '');
          }
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(received).toEqual({ stdout: 'first output finished\n', stderr: 'first warning' });
      expect(result).toMatchObject(received);
    } finally {
      await worker.disposeAsync();
    }
  }, 15_000);

  it('describes persistent DataFrames, arrays, scalars and AnnData-like objects', async () => {
    const output = makeTestDirectory();
    const worker = new PythonSandboxWorker(output);
    try {
      const result = await worker.execute(`
import pandas as pd
import numpy as np
frame = pd.DataFrame({"dose": [1, 2], "response": [3, 4]})
matrix = np.zeros((2, 3), dtype=np.float32)
count = 42
labels = ["low", "high"]
_private = 9
def fn():
    pass
class Dataset:
    n_obs = 40
    n_vars = 15
experiment = Dataset()
`, output);
      expect(result.exitCode, result.stderr).toBe(0);
      const variables = await worker.listVariables();
      expect(variables.map(({ name }) => name)).toEqual(['frame', 'matrix', 'count', 'labels', 'experiment']);
      expect(variables).toMatchObject([
        { name: 'frame', typeName: 'DataFrame', shape: '2 × 2', columns: ['dose', 'response'],
          sizeBytes: expect.any(Number), preview: expect.stringContaining('response') },
        { name: 'matrix', typeName: 'ndarray[float32]', shape: '2 × 3', sizeBytes: 24 },
        { name: 'count', typeName: 'int', preview: '42' },
        { name: 'labels', typeName: 'list', shape: '2', preview: "['low', 'high']" },
        { name: 'experiment', typeName: 'AnnData', shape: '40 cells × 15 genes' },
      ]);
      await worker.reset();
      expect(await worker.listVariables()).toEqual([]);
    } finally {
      await worker.disposeAsync();
    }
  }, 20_000);

  it('exports Plotly chart descriptors, figure objects, and JSON files created by the cell', async () => {
    const output = makeTestDirectory();
    const worker = new PythonSandboxWorker(output);
    try {
      const result = await worker.execute(`
import json
from pathlib import Path
class Figure:
    def to_dict(self):
        return {"data": [{"type": "bar"}], "layout": {"title": {"text": "Figure object"}}}
SCIDEV_PLOTLY_CHARTS = [
    {"title": "Cell descriptor", "description": "Measured response", "data": [{"y": [1, 3]}], "layout": {}},
    Figure(),
]
Path(SCIDEV_OUTPUT_DIR, "direct.plotly.json").write_text(json.dumps({
    "data": [], "layout": {"title": "Direct file"},
}), encoding="utf-8")
`, output, undefined, undefined, { memoryLimitMb: 4096 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.plotlyCharts).toEqual([
        { filePath: path.join(output, 'plotly_chart_0.plotly.json'), title: 'Cell descriptor', description: 'Measured response' },
        { filePath: path.join(output, 'plotly_chart_1.plotly.json'), title: 'Figure object' },
        { filePath: path.join(output, 'direct.plotly.json'), title: 'Direct file' },
      ]);
      expect(result.createdFiles).toEqual(result.plotlyCharts!.map(({ filePath }) => filePath).sort());
      expect(JSON.parse(fs.readFileSync(result.plotlyCharts![0].filePath, 'utf8'))).toMatchObject({ data: [{ y: [1, 3] }] });
      expect((await worker.execute('pass', output)).plotlyCharts).toBeUndefined();
    } finally {
      await worker.disposeAsync();
    }
  }, 20_000);

  it.runIf(['win32', 'linux', 'darwin'].includes(process.platform))('stops a Python kernel above its RSS budget', async () => {
    const output = makeTestDirectory();
    const worker = new PythonSandboxWorker(output);
    try {
      await expect(worker.execute('value = 1', output, 10_000, undefined, { memoryLimitMb: 1 }))
        .rejects.toThrow('memory limit exceeded (1 MB RSS)');
      expect(await worker.listVariables()).toEqual([]);
      expect((await worker.execute('print("fresh kernel")', output)).stdout.trim()).toBe('fresh kernel');
    } finally {
      await worker.disposeAsync();
    }
  }, 20_000);
});

describe('R sandbox', () => {
  it('checks Rscript availability and reports an execution result', async () => {
    const worker = new RScriptSandboxWorker();
    const availability = await RScriptSandboxWorker.isAvailable();
    const workspace = makeTestDirectory();
    fs.writeFileSync(path.join(workspace, 'values.txt'), '1 2 3\n');
    try {
      expect(await worker.listVariables()).toEqual([]);
      const output = path.join(workspace, 'output space');
      const result = await worker.execute(`
values <- scan(file.path(SCIDEV_WORKSPACE_DIR, "values.txt"), quiet = TRUE)
writeLines(as.character(sum(values)), file.path(SCIDEV_OUTPUT_DIR, "sum.txt"))
plot(values)
`, output, workspace);
      if (availability.available) {
        expect(availability.executable).toBe('Rscript');
        expect(availability.persistentReady).toBe(true);
        expect(availability.version).toMatch(/^\d+\.\d+/);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.rVersion).toBe(availability.version);
        expect(result.createdFiles).toHaveLength(2);
        expect(result.figures).toHaveLength(1);
        expect(fs.readFileSync(result.figures[0]).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(fs.readFileSync(path.join(output, 'sum.txt'), 'utf8').trim()).toBe('6');
        const failed = await worker.execute('stop("expected error")', output, workspace);
        expect(failed.exitCode).toBe(1);
        expect(failed.stderr).toContain('expected error');
        const otherWorkspace = makeTestDirectory();
        const isolated = await worker.execute('cat(exists("values", envir = .GlobalEnv, inherits = FALSE))',
          path.join(otherWorkspace, 'output'), otherWorkspace);
        expect(isolated.stdout).toBe('FALSE');
        const chunks = { stdout: '', stderr: '' };
        const next = await worker.execute('message("stderr"); cat("sum=", sum(values), sep="")', output, workspace, undefined, {
          onOutput: (stream, chunk) => { chunks[stream] += chunk; },
        });
        expect(next.exitCode, next.stderr).toBe(0);
        expect(next.stdout).toBe('sum=6');
        expect(next.stderr).toContain('stderr');
        expect(chunks).toEqual({ stdout: next.stdout, stderr: next.stderr });
        expect(await worker.listVariables()).toContainEqual(expect.objectContaining({
          name: 'values', typeName: 'numeric', shape: '3', preview: expect.stringContaining('1 2 3'),
        }));
        await worker.reset();
        expect(await worker.listVariables()).toEqual([]);
        expect((await worker.execute('cat(exists("values", inherits = FALSE))', output, workspace)).stdout).toBe('FALSE');
      } else {
        expect(availability).toEqual({ available: false, persistentReady: false });
        expect(result.exitCode).toBeGreaterThan(0);
        expect(result.stderr).toContain('Rscript');
        expect(result.figures).toEqual([]);
        expect(await worker.listVariables()).toEqual([]);
      }
    } finally {
      await worker.disposeAsync();
    }
  }, 15_000);

  it('falls back to one-shot R execution when the persistent kernel exits before readiness', async () => {
    const output = makeTestDirectory();
    const runner = vi.mocked(promisify(execFile));
    runner.mockClear();
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end('persistent startup failed');
        child.emit('close', 1);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    runner.mockImplementationOnce((_executable, args) => {
      if (!args) throw new Error('Expected Rscript arguments');
      expect(fs.readFileSync(args[2], 'utf8')).toBe('cat("one shot")');
      fs.writeFileSync(args[5], '4.5.0\n');
      return Object.assign(Promise.resolve({ stdout: 'one shot', stderr: '' }), {
        child: new EventEmitter() as unknown as ChildProcessWithoutNullStreams,
      });
    });
    const worker = new RScriptSandboxWorker();
    try {
      expect(await worker.execute('cat("one shot")', output)).toMatchObject({
        exitCode: 0, stdout: 'one shot', stderr: '', rVersion: '4.5.0',
      });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      await worker.disposeAsync();
    }
  });

  it('aborts an active persistent R cell and clears kernel state', async () => {
    const output = makeTestDirectory();
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, ref: vi.fn(), unref: vi.fn(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      }),
    });
    child.stdin.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      expect(request.method).toBe('exec');
      controller.abort();
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.write('{"jsonrpc":"2.0","method":"ready","params":{"version":"4.5.0"}}\n'));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const worker = new RScriptSandboxWorker();
    try {
      await expect(worker.execute('Sys.sleep(30)', output, undefined, 1000, { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(await worker.listVariables()).toEqual([]);
    } finally {
      await worker.disposeAsync();
    }
  });
});

describe('Python runtime sandbox guard', () => {
  it('allows reading raw data and writes to output while blocking raw mutations and outbound sockets', async () => {
    const workspace = makeTestDirectory();
    const workingDir = path.join(workspace, 'kernel');
    const output = path.join(workspace, 'artifacts');
    const raw = path.join(workspace, 'datasets');
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, 'source.csv'), 'value\n42\n');
    fs.writeFileSync(path.join(workspace, 'raw.txt'), 'keep');
    const worker = new PythonSandboxWorker(workingDir);
    try {
      const result = await worker.execute(`
import os, shutil, socket, tempfile
from pathlib import Path
workspace = Path(SCIDEV_WORKSPACE_DIR)
raw = workspace / "datasets" / "source.csv"
output = Path(SCIDEV_OUTPUT_DIR)
text = raw.read_text()
(output / "copy.csv").write_text(text)
(Path(SCIDEV_WORK_DIR) / "scratch.txt").write_text("work")
with tempfile.TemporaryFile() as scratch:
    assert scratch.write(b"temp") == 4
mutations = {
    "remove": lambda: os.remove(raw),
    "unlink": lambda: os.unlink(raw),
    "write": lambda: raw.write_text("changed"),
    "append": lambda: raw.open("a"),
    "exclusive": lambda: (raw.parent / "new.csv").open("x"),
    "readwrite": lambda: raw.open("r+"),
    "os.open": lambda: os.open(raw, os.O_WRONLY),
    "rename_source": lambda: os.rename(raw, output / "moved.csv"),
    "rename_destination": lambda: os.replace(output / "copy.csv", raw),
    "rmdir": lambda: os.rmdir(raw.parent),
    "rmtree": lambda: shutil.rmtree(raw.parent),
    "truncate": lambda: os.truncate(raw, 0),
    "workspace_root_file": lambda: (workspace / "raw.txt").write_text("changed"),
}
for name, operation in mutations.items():
    try:
        operation()
    except PermissionError as error:
        assert str(error) == "SciDeveloper Sandbox Guard: write/delete blocked outside session output directory"
        print(name)
    else:
        raise AssertionError(name + " was allowed")
with socket.socket() as connection:
    try:
        connection.connect(("192.0.2.5", 443))
    except PermissionError as error:
        assert str(error) == "SciDeveloper Sandbox Guard: unauthorized outbound network connection blocked"
        print("connect")
    else:
        raise AssertionError("outbound socket was allowed")
`, output, undefined, workspace);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(14);
      expect(fs.readFileSync(path.join(raw, 'source.csv'), 'utf8').replace(/\r\n/g, '\n')).toBe('value\n42\n');
      expect(fs.readFileSync(path.join(output, 'copy.csv'), 'utf8').replace(/\r\n/g, '\n')).toBe('value\n42\n');

      const override = await worker.execute(`
raw.write_text("updated")
`, output, undefined, workspace, { strictSandbox: false });
      expect(override.exitCode, override.stderr).toBe(0);
      expect(fs.readFileSync(path.join(raw, 'source.csv'), 'utf8')).toBe('updated');
    } finally {
      await worker.disposeAsync();
    }
  }, 15_000);

  it('kills a running cell on abort and respawns a fresh kernel', async () => {
    const workingDir = makeTestDirectory();
    const output = path.join(workingDir, 'artifacts');
    const worker = new PythonSandboxWorker(workingDir);
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const previous = await worker.execute('import os\nprior_pid = os.getpid()\nprint(prior_pid)', output);
      expect(previous.exitCode, previous.stderr).toBe(0);
      const running = worker.execute(`
import time
from pathlib import Path
(Path(SCIDEV_OUTPUT_DIR) / "started").touch()
time.sleep(30)
`, output, undefined, undefined, { signal: controller.signal });
      timer = setInterval(() => {
        if (fs.existsSync(path.join(output, 'started'))) controller.abort();
      }, 20);
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      const next = await worker.execute('import os\nprint(os.getpid())\nprint("prior_pid" in globals())', output);
      expect(next.exitCode, next.stderr).toBe(0);
      expect(next.stdout.trim().split(/\r?\n/)).toEqual([expect.not.stringMatching(`^${previous.stdout.trim()}$`), 'False']);
      await expect(worker.execute('raise AssertionError()', output, undefined, undefined, { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearInterval(timer);
      await worker.disposeAsync();
    }
  }, 15_000);

  it('terminates the active Python process on cancellation and leaves the replacement request intact', async () => {
    const workingDir = makeTestDirectory();
    const outputDir = path.join(workingDir, 'artifacts');
    const worker = new PythonSandboxWorker(workingDir);
    const controller = new AbortController();
    const mockedSpawn = vi.mocked(spawn);
    mockedSpawn.mockClear();
    const mockKernel = (onExec: (id: string, stdout: PassThrough) => void) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, exitCode: null as number | null, signalCode: null as string | null,
      });
      child.stdin.on('data', (line) => onExec(JSON.parse(line.toString()).id, child.stdout));
      return Object.assign(child, {
        kill: vi.fn((signal: string) => {
          child.killed = true;
          queueMicrotask(() => {
            child.signalCode = signal;
            child.stdout.end();
            child.emit('exit');
            child.emit('close');
          });
          return true;
        }),
      });
    };
    const first = mockKernel(() => setImmediate(() => controller.abort()));
    const second = mockKernel((id, stdout) => stdout.write(JSON.stringify({ id, ok: true, result: { exitCode: 0 } }) + '\n'));
    mockedSpawn.mockReturnValueOnce(first as unknown as ChildProcessWithoutNullStreams)
      .mockReturnValueOnce(second as unknown as ChildProcessWithoutNullStreams);
    try {
      await expect(worker.execute('import time; time.sleep(60)', outputDir, undefined, undefined, { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(first.kill).toHaveBeenCalledWith('SIGKILL');
      expect(await worker.execute('print(42)', outputDir)).toMatchObject({ exitCode: 0 });
      expect(second.kill).not.toHaveBeenCalled();
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    } finally {
      await worker.disposeAsync();
    }
  });
});

describe('workspace explorer', () => {
  it('lists workspace files within the requested depth and previews quoted CSV and TSV', async () => {
    const root = makeTestDirectory();
    fs.mkdirSync(path.join(root, 'data', 'nested'), { recursive: true });
    for (const ignored of ['node_modules', '.git', 'dist', '.scideveloper', '__pycache__']) {
      fs.mkdirSync(path.join(root, ignored));
      fs.writeFileSync(path.join(root, ignored, 'ignore.txt'), 'ignored');
    }
    const csv = '\uFEFFsample,notes,count\r\n"run, A","called ""positive""",3\r\nrun B,"line 1\r\nline 2",4\r\n' +
      Array.from({ length: 31 }, (_, index) => `repeat ${index},note,1\r\n`).join('');
    const csvPath = path.join(root, 'data', 'runs.csv');
    fs.writeFileSync(csvPath, csv);
    fs.writeFileSync(path.join(root, 'data', 'nested', 'runs.tsv'), 'sample\tnotes\nrun A\t"first\tsecond"');
    const gate = new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } });
    const explorer = new WorkspaceExplorer(gate);

    expect((await explorer.listFiles('s', root, '', 1)).map((file) => file.relativePath)).toEqual(['data']);
    expect((await explorer.listFiles('s', root, 'data', 1)).map((file) => file.relativePath)).toEqual(['data/nested', 'data/runs.csv']);
    const preview = await explorer.previewFile('s', root, 'data/runs.csv');
    expect(preview).toMatchObject({
      format: 'csv',
      headers: ['sample', 'notes', 'count'],
      sha256: createHash('sha256').update(csv).digest('hex'),
      totalLines: 35,
    });
    expect(preview.rows).toHaveLength(30);
    expect(preview.rows?.slice(0, 2)).toEqual([['run, A', 'called "positive"', '3'], ['run B', 'line 1\r\nline 2', '4']]);
    expect(await explorer.previewFile('s', root, 'data/nested/runs.tsv')).toMatchObject({
      format: 'tsv',
      rows: [['run A', 'first\tsecond']],
    });
    expect(gate.listHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'fs_read', target: csvPath, status: 'approved' }),
    ]));
  });

  it('bounds the preview and hashes the full file without splitting UTF-8 characters', async () => {
    const root = makeTestDirectory();
    const content = 'a'.repeat(64 * 1024 - 1) + 'é\nlast line';
    fs.writeFileSync(path.join(root, 'large.txt'), content);
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 255, 2]));
    const explorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const preview = await explorer.previewFile('s', root, 'large.txt', 1024 * 1024);
    expect(preview.previewText).toBe(content.slice(0, 64 * 1024 - 1));
    expect(preview.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(preview.totalLines).toBe(2);
    expect(await explorer.previewFile('s', root, 'binary.bin')).toMatchObject({ format: 'binary', previewText: '' });
  });

  it('sanitizes uploaded filenames, decodes base64, and rejects traversal and escaping links', async () => {
    const base = makeTestDirectory();
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'workspace-elsewhere');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.csv'), 'secret');
    let canSymlink = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    } catch {
      canSymlink = false;
    }
    const explorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const content = 'id,value\nA,42\n';
    const entry = await explorer.saveUploadedFile('s', root, '../../unsafe:name.csv', Buffer.from(content).toString('base64'), true);
    expect(entry).toMatchObject({ relativePath: 'datasets/unsafe_name.csv', kind: 'file', sizeBytes: Buffer.byteLength(content) });
    expect(fs.readFileSync(entry.absolutePath, 'utf8')).toBe(content);
    await expect(explorer.saveUploadedFile('s', root, 'unsafe_name.csv', 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(explorer.listFiles('s', root, '../workspace-elsewhere')).rejects.toThrow(/outside the workspace/);
    if (canSymlink) {
      await expect(explorer.previewFile('s', root, 'escape/secret.csv')).rejects.toThrow(/outside the workspace/);
      expect((await explorer.listFiles('s', root)).map((file) => file.relativePath)).not.toContain('escape');

      const linkedRoot = path.join(base, 'linked-workspace');
      fs.mkdirSync(linkedRoot);
      fs.symlinkSync(outside, path.join(linkedRoot, 'datasets'), 'junction');
      const linkedExplorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [linkedRoot] } }));
      await expect(linkedExplorer.saveUploadedFile('s', linkedRoot, 'new.csv', 'content')).rejects.toThrow();
      expect(fs.existsSync(path.join(outside, 'new.csv'))).toBe(false);
    }
  });

  it('rejects workspace reads and writes denied by the permission gate', async () => {
    const root = makeTestDirectory();
    fs.writeFileSync(path.join(root, 'input.csv'), 'header\ndata');
    const gate = new PermissionGate({ policy: { allowedWorkspaceRoots: [root], autoApproveReadOnly: false } });
    gate.updatePolicy({ rules: { ...gate.getPolicy().rules, fs_read: 'deny', fs_write: 'deny' } });
    const explorer = new WorkspaceExplorer(gate);
    await expect(explorer.listFiles('s', root)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(explorer.previewFile('s', root, 'input.csv')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(explorer.saveUploadedFile('s', root, 'output.csv', 'data')).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(fs.existsSync(path.join(root, 'datasets'))).toBe(false);
  });
});

function makePdf(...pageTexts: string[]): Buffer {
  const kids = pageTexts.map((_, index) => `${4 + 2 * index} 0 R`).reverse();
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  for (const text of [...pageTexts].reverse()) {
    const content = deflateSync(Buffer.from(`BT /F1 12 Tf 30 100 Td (${text}) Tj ET\n`));
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents [${objects.length + 2} 0 R] >>`),
      Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')]),
    );
  }
  const info = objects.push(Buffer.from('<< /Title (Calibration report) >>'));
  const buffers = [Buffer.from('%PDF-1.4\n')];
  const offsets = ['0000000000 65535 f \n'];
  let offset = buffers[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
    const buffer = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    offset += buffer.length;
    buffers.push(buffer);
  }
  buffers.push(Buffer.from(`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(buffers);
}

describe('scientific file previews', () => {
  const inspector = fileURLToPath(new URL('../python/file_inspector.py', import.meta.url));

  it('reads XLSX sheet relationships, shared strings, sparse cells, and up to 30 data rows', async () => {
    const root = makeTestDirectory();
    const file = path.join(root, 'experiment.xlsx');
    execFileSync('python', ['-S', '-c', `
import sys, zipfile
m = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
p = 'http://schemas.openxmlformats.org/package/2006/relationships'
t = 'http://schemas.openxmlformats.org/package/2006/content-types'
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as f:
    f.writestr('[Content_Types].xml', f'<Types xmlns="{t}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    f.writestr('_rels/.rels', f'<Relationships xmlns="{p}"><Relationship Id="rId1" Type="{r}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    f.writestr('xl/workbook.xml', f'<workbook xmlns="{m}" xmlns:r="{r}"><sheets><sheet name="Assay" sheetId="2" r:id="rId2"/><sheet name="Notes" sheetId="1" r:id="rId1"/></sheets></workbook>')
    f.writestr('xl/_rels/workbook.xml.rels', f'<Relationships xmlns="{p}"><Relationship Id="rId2" Type="{r}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="{r}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="{r}/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    f.writestr('xl/sharedStrings.xml', f'<sst xmlns="{m}"><si><t>sample</t></si><si><r><t>run</t></r><r><t> A</t></r></si></sst>')
    rows = ['<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>value</t></is></c></row>']
    rows += [f'<row r="{n}"><c r="A{n}" t="s"><v>1</v></c><c r="C{n}"><v>{n}</v></c></row>' for n in range(2, 34)]
    f.writestr('xl/worksheets/sheet2.xml', f'<worksheet xmlns="{m}"><sheetData>{"".join(rows)}</sheetData></worksheet>')
    f.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{m}"><sheetData/></worksheet>')
`, file]);
    const explorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const upload = await explorer.saveUploadedFile('s', root, 'upload.xlsx', fs.readFileSync(file).toString('base64'), true);
    const preview = await explorer.previewFile('s', root, upload.relativePath);
    expect(preview).toMatchObject({ format: 'xlsx', sheets: ['Assay', 'Notes'], headers: ['sample', '', 'value'] });
    expect(preview.rows).toHaveLength(30);
    expect(preview.rows?.[0]).toEqual(['run A', '', '2']);
    expect(preview.rows?.[29]).toEqual(['run A', '', '31']);
    const standardLibrary = JSON.parse(execFileSync('python', ['-S', inspector, 'xlsx', file], { encoding: 'utf8' }));
    expect(standardLibrary.rows).toEqual(preview.rows);
  }, 15_000);

  it('extracts PDF page count and compressed text with or without optional libraries', async () => {
    const root = makeTestDirectory();
    const explorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const upload = await explorer.saveUploadedFile('s', root, 'report.pdf', makePdf('Calibrated sample').toString('base64'), true);
    const preview = await explorer.previewFile('s', root, upload.relativePath);
    expect(preview).toMatchObject({ format: 'pdf', pageCount: 1, previewText: expect.stringContaining('Calibrated sample') });
    const standardLibrary = JSON.parse(execFileSync('python', ['-S', inspector, 'pdf', upload.absolutePath], { encoding: 'utf8' }));
    expect(standardLibrary).toMatchObject({ pageCount: 1, previewText: 'Calibrated sample' });
  });

  it('extracts ordered PDF pages, document title, and blank pages through both entry points', async () => {
    const root = makeTestDirectory();
    const workspace = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const file = path.join(root, 'three pages.pdf');
    fs.writeFileSync(file, makePdf('First page with ET inside the text', '', 'Third page only'));
    const expected = {
      pageCount: 3, title: 'Calibration report',
      pages: [{ page: 1, text: 'First page with ET inside the text' }, { page: 2, text: '' }, { page: 3, text: 'Third page only' }],
    };
    const standardLibrary = JSON.parse(execFileSync('python', ['-S', inspector, 'pdf-pages', file], { encoding: 'utf8' }));
    expect(standardLibrary).toEqual(expected);
    for (const result of [await workspace.extractPdfPages(file), await extractPdfPages(file)]) {
      expect({ ...result, pages: result.pages.map(page => ({ ...page, text: page.text.trim() })) }).toEqual(expected);
    }
  }, 15_000);

  it('counts VCF records and extracts SDF and MOL2 molecule summaries', async () => {
    const root = makeTestDirectory();
    const explorer = new WorkspaceExplorer(new PermissionGate({ policy: { allowedWorkspaceRoots: [root] } }));
    const vcf = await explorer.saveUploadedFile('s', root, 'synthetic.vcf', [
      '##fileformat=VCFv4.2', '##source=simulated', '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
      ...Array.from({ length: 32 }, (_, index) => `chr1\t${index + 1}\t.\tA\tC\t60\tPASS\t.`),
    ].join('\n'));
    const variants = await explorer.previewFile('s', root, vcf.relativePath);
    expect(variants).toMatchObject({ format: 'vcf', headers: ['CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO'],
      structuredMetadata: { variantCount: 32, headerLines: ['##fileformat=VCFv4.2', '##source=simulated'] } });
    expect(variants.rows).toHaveLength(30);
    expect(variants.rows?.[0]).toEqual(['chr1', '1', '.', 'A', 'C', '60', 'PASS', '.']);

    const sdf = await explorer.saveUploadedFile('s', root, 'compounds.sdf', [
      'Methane', '  SciDev', '', '  1  0  0  0  0  0            999 V2000',
      '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
      'M  END', '>  <SAMPLE_ID>  (1)', 'M-1', '', '$$$$',
      'Water', '  SciDev', '', '  1  0  0  0  0  0            999 V2000',
      '    0.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
      'M  END', '>  <NOTE>', 'two lines', 'of text', '', '$$$$', '',
    ].join('\n'));
    expect(await explorer.previewFile('s', root, sdf.relativePath)).toMatchObject({
      format: 'sdf', headers: ['title', 'atomCount', 'bondCount', 'SAMPLE_ID', 'NOTE'],
      rows: [['Methane', '1', '0', 'M-1', ''], ['Water', '1', '0', '', 'two lines\nof text']],
      structuredMetadata: { moleculeCount: 2 },
    });
    const mol2 = await explorer.saveUploadedFile('s', root, 'single.mol2', [
      '@<TRIPOS>MOLECULE', 'Water', '1 0 0 0 0', 'SMALL', 'NO_CHARGES', '', '@<TRIPOS>ATOM', '1 O 0 0 0 O.3',
    ].join('\n'));
    expect(await explorer.previewFile('s', root, mol2.relativePath)).toMatchObject({
      format: 'sdf', rows: [['Water', '1', '0']], structuredMetadata: { moleculeCount: 1 },
    });
  });
});

describe('Slurm job lifecycle', () => {
  const spec: SlurmJobSpec = {
    targetId: 'lab-hpc-slurm',
    jobName: 'analysis',
    partition: 'compute',
    cpus: 4,
    memGb: 8,
    walltime: '00:10:00',
    command: 'echo hello',
  };

  const makeGate = () => {
    const gate = new PermissionGate();
    gate.updatePolicy({ rules: { ...gate.getPolicy().rules, remote_hpc_submit: 'allow' } });
    return gate;
  };

  it('keeps a cancelled simulated job terminal even after scheduler timers run', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const adapter = new SlurmHpcAdapter((job) => statuses.push(job.status));
    const job = await adapter.submitJob('s', spec, makeGate());
    expect((await adapter.pollJobStatus(job.id)).status).toBe('queued');
    await vi.advanceTimersByTimeAsync(600);
    expect((await adapter.pollJobStatus(job.id)).status).toBe('running');
    const cancelled = await adapter.cancelJob(job.id);
    expect(cancelled.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await adapter.pollJobStatus(job.id)).toEqual(cancelled);
    expect(await adapter.cancelJob(job.id)).toEqual(cancelled);
    expect(statuses).toEqual(['queued', 'running', 'cancelled']);
  });

  it('restores persisted targets and jobs and protects the local target', async () => {
    const original = new SlurmHpcAdapter();
    const target = { ...original.getTarget('lab-hpc-slurm')!, host: 'research-cluster.example.org', port: 2200 };
    const job = await original.submitJob('s', spec, makeGate());
    const persistedJob = { ...job, status: 'running' as const };
    const onJobUpdated = vi.fn();
    const restored = new SlurmHpcAdapter({ initialTargets: [target], initialJobs: [persistedJob], onJobUpdated });

    expect(restored.listJobs()).toEqual([persistedJob]);
    expect(restored.getTarget(target.id)).toEqual(target);
    expect((await restored.pollJobStatus(job.id)).status).toBe('running');
    expect(onJobUpdated).not.toHaveBeenCalled();
    expect((await restored.cancelJob(job.id)).status).toBe('cancelled');
    expect(onJobUpdated).toHaveBeenCalledTimes(1);
    expect(persistedJob.status).toBe('running');
    expect(() => restored.removeTarget('local-sandbox')).toThrow('Cannot remove');
    expect(restored.removeTarget(target.id)).toBe(true);
    expect(restored.getTarget(target.id)).toBeUndefined();
    expect(new SlurmHpcAdapter({ initialTargets: restored.listTargets() }).getTarget(target.id)).toBeUndefined();
  });

  it('polls live jobs through squeue and sacct and cancels them through scancel', async () => {
    const original = new SlurmHpcAdapter();
    const target = { ...original.getTarget(spec.targetId)!, status: 'online' as const };
    const simulated = await original.submitJob('s', spec, makeGate());
    const liveJob = { ...simulated, mode: 'live-ssh' as const, slurmJobId: '12345' };
    const secondJob = { ...liveJob, id: 'second-job', slurmJobId: '12346' };
    const adapter = new SlurmHpcAdapter({ initialTargets: [target], initialJobs: [liveJob, secondJob] });
    const ssh = vi.mocked(spawn);
    ssh.mockClear();
    const replies = [
      { stdout: 'RUNNING\n' },
      {},
      { stdout: '12345.batch|FAILED\n12345|COMPLETED\n' },
      { code: 1, stderr: 'cancellation denied' },
      {},
    ];
    for (const { stdout = '', stderr = '', code = 0 } of replies) {
      ssh.mockImplementationOnce(() => {
        const output = new PassThrough();
        const errors = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: output,
          stderr: errors,
        }) as unknown as ChildProcessWithoutNullStreams;
        queueMicrotask(() => {
          output.end(stdout);
          errors.end(stderr);
          child.emit('close', code);
        });
        return child;
      });
    }
    expect((await adapter.pollJobStatus(liveJob.id)).status).toBe('running');
    expect((await adapter.pollJobStatus(liveJob.id)).status).toBe('completed');
    await expect(adapter.cancelJob(secondJob.id)).rejects.toThrow('cancellation denied');
    expect(adapter.getJob(secondJob.id)?.status).toBe('queued');
    expect((await adapter.cancelJob(secondJob.id)).status).toBe('cancelled');
    expect(ssh.mock.calls.map(([bin, args]) => [bin, ...args.slice(8)])).toEqual([
      ['ssh', 'squeue', '--noheader', '--jobs=12345', '--format=%T'],
      ['ssh', 'squeue', '--noheader', '--jobs=12345', '--format=%T'],
      ['ssh', 'sacct', '--noheader', '--parsable2', '--allocations', '--jobs=12345', '--format=JobIDRaw,State%40'],
      ['ssh', 'scancel', '12346'],
      ['ssh', 'scancel', '12346'],
    ]);
  });

  it('allows the ClinVar, GEO, and preprint connectors under the default policy', () => {
    const gate = new PermissionGate();
    for (const id of ['clinvar', 'geo', 'arxiv-biorxiv']) {
      expect(gate.evaluateDecision('network_connector', id)).toBe('allow');
    }
  });

  it('tests local and simulated SSH targets and syncs simulated result files', async () => {
    const destination = makeTestDirectory();
    const onJobUpdated = vi.fn();
    const adapter = new SlurmHpcAdapter({ onJobUpdated });
    expect(await adapter.testSshConnection('local-sandbox')).toMatchObject({ ok: true, mode: 'simulated' });
    expect(await adapter.testSshConnection(spec.targetId)).toMatchObject({
      targetId: spec.targetId, ok: true, mode: 'simulated', remoteHostInfo: expect.stringContaining('slurm'),
    });
    const submitted = await adapter.submitJob('s', spec, makeGate());
    const { job, syncedFiles } = await adapter.syncRemoteArtifacts(submitted.id, destination);
    expect(syncedFiles).toHaveLength(2);
    expect(job.syncedFiles).toEqual(syncedFiles);
    expect(onJobUpdated.mock.calls.at(-1)?.[0].syncedFiles).toEqual(syncedFiles);
    const summary = syncedFiles.find((file) => file.endsWith('.csv'))!;
    const log = syncedFiles.find((file) => file.endsWith('.log'))!;
    expect(fs.readFileSync(summary, 'utf8')).toContain(`"${job.slurmJobId}"`);
    expect(fs.readFileSync(log, 'utf8')).toContain('Submitted batch job');
  });

  it('passes SSH identity and jump settings to the live check, submission, and SCP', async () => {
    const local = makeTestDirectory();
    const defaults = new SlurmHpcAdapter().getTarget(spec.targetId)!;
    const target = { ...defaults, status: 'online' as const, host: 'research.example.org', port: 2222,
      identityFile: path.join(local, 'private key'), jumpHost: 'research@bastion.example.org', remoteWorkDir: '/work/project files' };
    const adapter = new SlurmHpcAdapter({ initialTargets: [target] });
    const ssh = vi.mocked(spawn);
    ssh.mockClear();
    const mockTransfer = (reply: { stdout?: string; stderr?: string; code?: number }, copy = false) => {
      ssh.mockImplementationOnce((_bin, args) => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        });
        queueMicrotask(() => {
          if (copy) {
            const staged = path.join(args.at(-1)!, 'project files', 'results');
            fs.mkdirSync(staged, { recursive: true });
            fs.writeFileSync(path.join(staged, 'output.csv'), 'value\n42\n');
          }
          child.stdout.end(reply.stdout ?? '');
          child.stderr.end(reply.stderr ?? '');
          child.emit('close', reply.code ?? 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      });
    };
    mockTransfer({ stdout: 'compute-login\nslurm 24.11.0\n' });
    mockTransfer({ stderr: 'Permission denied (publickey).', code: 255 });
    mockTransfer({ stdout: '12345\n' });
    mockTransfer({}, true);
    expect(await adapter.testSshConnection(spec.targetId)).toMatchObject({
      ok: true, mode: 'live-ssh', remoteHostInfo: 'compute-login\nslurm 24.11.0',
    });
    expect(await adapter.testSshConnection(spec.targetId)).toMatchObject({ ok: false, message: 'Permission denied (publickey).' });
    const submitted = await adapter.submitJob('s', spec, makeGate(), { liveSsh: true });
    expect(submitted).toMatchObject({ status: 'queued', slurmJobId: '12345', mode: 'live-ssh' });
    const synced = await adapter.syncRemoteArtifacts(submitted.id, local);
    expect(synced.syncedFiles).toEqual([path.join(local, 'results', 'output.csv')]);
    expect(fs.readFileSync(synced.syncedFiles[0], 'utf8')).toBe('value\n42\n');
    expect(fs.readdirSync(local)).toEqual(['results']);
    expect(ssh.mock.calls[0].slice(0, 2)).toEqual(['ssh', [
      '-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-i', target.identityFile,
      '-J', target.jumpHost, '--', 'researcher@research.example.org', 'hostname && sinfo --version',
    ]]);
    expect(ssh.mock.calls[2][1].at(-1)).toContain("cd -- '/work/project files' && mkdir -p logs && sbatch --parsable");
    expect(ssh.mock.calls[3].slice(0, 2)).toEqual(['scp', [
      '-P', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', target.identityFile,
      '-J', target.jumpHost, '-r', '--', 'researcher@research.example.org:/work/project files', expect.any(String),
    ]]);
  });
});

describe('Docker sandbox', () => {
  function mockDockerProcess() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
    return child;
  }

  it('binds a read-only workspace, streams output, and maps container artifacts to host files', async () => {
    const workspace = fs.realpathSync(makeTestDirectory());
    const output = fs.realpathSync(makeTestDirectory());
    const child = mockDockerProcess();
    const code = 'print("hello")';
    let input = '';
    child.stdin.setEncoding('utf8').on('data', (chunk) => { input += chunk; });
    const received = { stdout: '', stderr: '' };
    let sawOutput!: () => void;
    const live = new Promise<void>(resolve => { sawOutput = resolve; });
    let completed = false;
    const result = new DockerSandboxWorker().execute(code, output, {
      workspaceDir: workspace, memoryLimitMb: 768, cpuLimit: 1.5,
      onOutput(stream, chunk) {
        received[stream] += chunk;
        if (received.stdout && received.stderr) sawOutput();
      },
    }).finally(() => { completed = true; });

    child.stdin.once('finish', () => {
      child.stdout.write('partial stdout');
      child.stderr.write('warning\n');
    });
    await live;
    const [command, args] = vi.mocked(spawn).mock.lastCall!;
    expect(command).toBe('docker');
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(args).toEqual(expect.arrayContaining([
      '--network=none', '--memory=768m', '--cpus=1.5', `${workspace}:/workspace:ro`, `${output}:/output:rw`,
      'SCIDEV_WORKSPACE_DIR=/workspace', 'SCIDEV_OUTPUT_DIR=/output', 'python:3.12-slim',
    ]));
    expect(JSON.parse(input)).toEqual({ code });
    expect(completed).toBe(false);
    for (const name of ['figure.png', 'figure.svg', 'figure.pdf', 'report.plotly.json']) {
      fs.writeFileSync(path.join(output, name), '');
    }
    const marker = args.at(-1)!;
    child.stdout.write(marker.slice(0, 5));
    child.stdout.end(marker.slice(5) + JSON.stringify({
      metrics: { count: 3 },
      figureBundles: [{ pngPath: '/output/figure.png', svgPath: '/output/figure.svg', pdfPath: '/output/figure.pdf' }],
      plotlyCharts: [{ filePath: '/output/report.plotly.json', title: 'Docker chart' },
        { filePath: '/output/../elsewhere.plotly.json', title: 'Invalid path' }],
    }) + '\n');
    child.emit('close', 0);
    await expect(result).resolves.toMatchObject({
      exitCode: 0, stdout: 'partial stdout', stderr: 'warning\n', metrics: { count: 3 },
      figures: [path.join(output, 'figure.png')],
      figureBundles: [{ pngPath: path.join(output, 'figure.png'), svgPath: path.join(output, 'figure.svg'),
        pdfPath: path.join(output, 'figure.pdf') }],
      plotlyCharts: [{ filePath: path.join(output, 'report.plotly.json'), title: 'Docker chart' }],
      createdFiles: ['figure.pdf', 'figure.png', 'figure.svg', 'report.plotly.json'].map(name => path.join(output, name)),
    });
    expect(received).toEqual({ stdout: 'partial stdout', stderr: 'warning\n' });
  });

  it('kills the client and removes the named container when execution is aborted', async () => {
    const output = makeTestDirectory();
    const child = mockDockerProcess();
    const runner = vi.mocked(promisify(execFile));
    runner.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const controller = new AbortController();
    child.stdin.once('finish', () => controller.abort());
    await expect(new DockerSandboxWorker().execute('pass', output, {
      signal: controller.signal, allowNetwork: true, image: 'example/python:3.12',
    })).rejects.toMatchObject({ name: 'AbortError' });
    const args = vi.mocked(spawn).mock.lastCall![1];
    expect(args).toContain('example/python:3.12');
    expect(args).not.toContain('--network=none');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runner).toHaveBeenLastCalledWith('docker', ['rm', '-f', args[args.indexOf('--name') + 1]],
      expect.objectContaining({ timeout: 3000 }));
  });

  it('adds a default target, preserves stored targets, and reports daemon availability', async () => {
    const adapter = new SlurmHpcAdapter();
    const target = adapter.getTarget('docker-sandbox')!;
    expect(target).toMatchObject({ kind: 'container-docker', status: 'configured', dockerImage: 'python:3.12-slim',
      memoryLimitMb: 4096, cpuLimit: 2, allowContainerNetwork: false });
    const custom = { ...target, dockerImage: 'custom/python', cpuLimit: 4 };
    expect(new SlurmHpcAdapter({ initialTargets: [custom] }).getTarget(target.id)).toEqual(custom);

    const runner = vi.mocked(promisify(execFile));
    runner.mockResolvedValueOnce({ stdout: '28.1.1\n', stderr: '' }).mockRejectedValueOnce(new Error('Docker offline'));
    await expect(adapter.testSshConnection(target.id)).resolves.toMatchObject({
      targetId: target.id, ok: true, mode: 'docker', remoteHostInfo: 'Docker 28.1.1',
    });
    expect(runner).toHaveBeenLastCalledWith('docker', ['version', '--format', '{{.Server.Version}}'],
      expect.objectContaining({ timeout: 3000 }));
    await expect(adapter.testSshConnection(target.id)).resolves.toMatchObject({ ok: false, mode: 'docker' });
  });
});

describe('environment doctor and package installation', () => {
  it('combines tool availability with missing recommended package diagnostics', async () => {
    const runner = vi.mocked(promisify(execFile));
    const python = path.join(makeTestDirectory(), 'doctor python');
    runner.mockResolvedValueOnce({ stdout: JSON.stringify({
      executable: python, version: '3.12.4', sandboxGuardSupported: true, versions: { numpy: '2.0.0' },
    }), stderr: '' }).mockRejectedValueOnce(new Error('R unavailable'))
      .mockResolvedValueOnce({ stdout: 'uv 0.11.0', stderr: '' })
      .mockRejectedValueOnce(new Error('Conda unavailable'))
      .mockResolvedValueOnce({ stdout: '28.1.1\n', stderr: '' });
    const report = await diagnoseEnvironment(python);
    expect(report).toMatchObject({
      python: { available: true, executable: python, version: '3.12.4' },
      r: { available: false, persistentReady: false }, uvAvailable: true, condaAvailable: false, sandboxGuardSupported: true,
      docker: { available: true, version: '28.1.1' },
    });
    expect(report.packages).toContainEqual(expect.objectContaining({ name: 'numpy', version: '2.0.0', installed: true }));
    expect(report.suggestedInstallCommand).toContain('pip install -- pandas');
    expect(report.suggestedInstallCommand).toContain('openpyxl pypdf biopython');
    expect(report.suggestedInstallCommand).not.toContain('numpy');
  });

  it('reports the active interpreter, audit hooks, tools, and all scientific packages', async () => {
    const report = await diagnoseEnvironment();
    expect(report.python).toMatchObject({ available: true, version: expect.stringMatching(/^3\./) });
    expect(path.isAbsolute(report.python.executable)).toBe(true);
    expect(report.sandboxGuardSupported).toBe(true);
    expect(report.r).toMatchObject({ available: expect.any(Boolean), persistentReady: expect.any(Boolean) });
    expect(report.docker).toMatchObject({ available: expect.any(Boolean) });
    expect(typeof report.uvAvailable).toBe('boolean');
    expect(typeof report.condaAvailable).toBe('boolean');
    expect(report.packages.map(({ name }) => name)).toEqual([
      'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'statsmodels',
      'openpyxl', 'pypdf', 'biopython', 'rdkit', 'scanpy',
    ]);
    const missing = report.packages.filter(({ installed, recommended }) => recommended && !installed);
    if (missing.length) {
      expect(report.suggestedInstallCommand).toContain('-m pip install');
      for (const { name } of missing) expect(report.suggestedInstallCommand).toContain(name);
    } else {
      expect(report.suggestedInstallCommand).toBeUndefined();
    }
    const unavailable = await diagnoseEnvironment(path.join(makeTestDirectory(), 'nonexistent-python'));
    expect(unavailable.python.available).toBe(false);
    expect(unavailable.sandboxGuardSupported).toBe(false);
    expect(unavailable.suggestedInstallCommand).toBeUndefined();
  }, 15_000);

  it('validates package names, requires authorization, and passes approved names as pip arguments', async () => {
    const runner = vi.mocked(promisify(execFile));
    runner.mockClear();
    const deny = new PermissionGate({ policy: { rules: { package_install: 'deny' } } });
    const defaults = new PermissionGate();
    expect(defaults.getPolicy()).toMatchObject({ strictSandboxGuard: true, rules: { package_install: 'ask' } });
    for (const id of ['string-db', 'kegg', 'reactome', 'alphafold-db', 'cbioportal', 'opentargets', 'pubchem', 'eln-benchling']) {
      expect(defaults.evaluateDecision('network_connector', id)).toBe('allow');
    }
    for (const name of ['numpy==2', '--index-url=https://example.org', '../numpy', 'numpy\n', 'scipy;echo']) {
      await expect(installPythonPackages('s', [name], defaults)).rejects.toThrow('Python package names');
    }
    await expect(installPythonPackages('s', ['numpy'], deny)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(runner).not.toHaveBeenCalled();

    const gate = new PermissionGate({ onRequest: (request) => { gate.decide(request.id, true); } });
    runner.mockResolvedValueOnce({ stdout: 'installed', stderr: '' });
    const result = await installPythonPackages('s', ['scikit-learn', 'openpyxl'], gate, 'custom-python');
    expect(result).toEqual({ exitCode: 0, stdout: 'installed', stderr: '', command: 'custom-python -m pip install -- scikit-learn openpyxl' });
    expect(runner).toHaveBeenCalledWith('custom-python', ['-m', 'pip', 'install', '--', 'scikit-learn', 'openpyxl'], expect.any(Object));
    expect(gate.listHistory()).toMatchObject([{ sessionId: 's', action: 'package_install', status: 'approved' }]);
  });
});
