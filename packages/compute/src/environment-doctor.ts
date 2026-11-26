import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnvironmentDoctorPackage, EnvironmentDoctorReport } from '@scideveloper/shared';
import { DockerSandboxWorker } from './docker-sandbox.js';
import type { PermissionGate } from './permission-gate.js';
import { RScriptSandboxWorker } from './r-sandbox.js';

const runFile = promisify(execFile);
const packagesToCheck: Array<Omit<EnvironmentDoctorPackage, 'installed' | 'version'>> = [
  { name: 'numpy', purpose: 'Numerical arrays and linear algebra', recommended: true },
  { name: 'pandas', purpose: 'Tabular data analysis', recommended: true },
  { name: 'scipy', purpose: 'Scientific algorithms and statistics', recommended: true },
  { name: 'matplotlib', purpose: 'Scientific plots and figure export', recommended: true },
  { name: 'seaborn', purpose: 'Statistical visualization', recommended: true },
  { name: 'scikit-learn', purpose: 'Machine learning and preprocessing', recommended: true },
  { name: 'statsmodels', purpose: 'Statistical modeling', recommended: true },
  { name: 'openpyxl', purpose: 'Excel workbook analysis', recommended: true },
  { name: 'pypdf', purpose: 'PDF text extraction', recommended: true },
  { name: 'biopython', purpose: 'Biological sequence and structure analysis', recommended: true },
  { name: 'rdkit', purpose: 'Cheminformatics and molecular descriptors', recommended: false },
  { name: 'scanpy', purpose: 'Single-cell transcriptomics', recommended: false },
];

const pythonProbe = `
import json, platform, sys

versions = {}
try:
    from importlib.metadata import PackageNotFoundError, version
    for package in sys.argv[1:]:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            pass
except ImportError:
    pass

audit_events = []
if hasattr(sys, 'addaudithook'):
    sys.addaudithook(lambda event, args: audit_events.append(event) if event == 'scidev.doctor' else None)
    sys.audit('scidev.doctor')

print(json.dumps(dict(executable=sys.executable, version=platform.python_version(),
                      sandboxGuardSupported=bool(audit_events), versions=versions)))
`;

interface PythonProbe {
  executable: string;
  version: string;
  sandboxGuardSupported: boolean;
  versions: Record<string, string>;
}

async function probePython(executable: string): Promise<PythonProbe | undefined> {
  try {
    const { stdout } = await runFile(executable, ['-B', '-c', pythonProbe, ...packagesToCheck.map(({ name }) => name)], {
      timeout: 5000, windowsHide: true,
    });
    const result = JSON.parse(stdout) as PythonProbe;
    if (typeof result?.executable === 'string' && typeof result.version === 'string' && result.versions) return result;
  } catch {
    // The configured interpreter may be unavailable.
  }
  return undefined;
}

async function canRun(executable: string): Promise<boolean> {
  try {
    await runFile(executable, ['--version'], { timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function installCommand(executable: string, args: string[]): string {
  if (/^[a-zA-Z0-9._/-]+$/.test(executable)) return [executable, ...args].join(' ');
  if (process.platform === 'win32') return `& '${executable.replaceAll("'", "''")}' ${args.join(' ')}`;
  return `'${executable.replaceAll("'", "'\\''")}' ${args.join(' ')}`;
}

function pipInstallArgs(packages: string[]): string[] {
  return ['-m', 'pip', 'install', '--', ...packages];
}

export async function diagnoseEnvironment(pythonBin?: string): Promise<EnvironmentDoctorReport> {
  const executable = pythonBin ?? process.env.SCIDEV_PYTHON_BIN ?? 'python';
  const [probe, r, uvAvailable, condaAvailable, docker] = await Promise.all([
    probePython(executable), RScriptSandboxWorker.isAvailable(), canRun('uv'), canRun(process.env.CONDA_EXE || 'conda'),
    DockerSandboxWorker.isAvailable(),
  ]);
  const packages = packagesToCheck.map((pkg) => {
    const version = probe?.versions[pkg.name];
    return { ...pkg, installed: version !== undefined, version };
  });
  const missing = packages.filter((pkg) => pkg.recommended && !pkg.installed).map((pkg) => pkg.name);
  return {
    checkedAt: new Date().toISOString(),
    python: { available: Boolean(probe), executable: probe?.executable ?? executable, version: probe?.version },
    r,
    docker,
    uvAvailable,
    condaAvailable,
    sandboxGuardSupported: probe?.sandboxGuardSupported === true,
    packages,
    suggestedInstallCommand: probe && missing.length ? installCommand(probe.executable, pipInstallArgs(missing)) : undefined,
  };
}

export async function installPythonPackages(
  sessionId: string, packages: string[], permissionGate: PermissionGate, pythonBin?: string
): Promise<{ exitCode: number; stdout: string; stderr: string; command: string }> {
  const names = [...packages];
  if (!names.length || names.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name))) {
    throw new Error('Provide one or more Python package names using letters, digits, periods, underscores, or hyphens.');
  }
  const executable = pythonBin ?? process.env.SCIDEV_PYTHON_BIN ?? 'python';
  const args = pipInstallArgs(names);
  const command = installCommand(executable, args);
  await permissionGate.assertAllowed(sessionId, 'package_install', command, `Install Python packages: ${names.join(', ')}`);
  try {
    const { stdout, stderr } = await runFile(executable, args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { exitCode: 0, stdout, stderr, command };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '',
      stderr: failure.stderr || failure.message, command };
  }
}
