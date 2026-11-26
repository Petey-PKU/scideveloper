export { PermissionGate, PermissionDeniedError, type PermissionGateOptions } from './permission-gate.js';
export { PythonSandboxWorker, listPythonEnvironments, type PythonExecResult, type PythonExecuteOptions } from './python-sandbox.js';
export { RScriptSandboxWorker, type RAvailability, type RExecResult, type RExecuteOptions } from './r-sandbox.js';
export { DockerSandboxWorker, type DockerAvailability, type DockerExecuteOptions } from './docker-sandbox.js';
export { SlurmHpcAdapter, type SlurmHpcAdapterOptions } from './slurm-adapter.js';
export { WorkspaceExplorer, extractPdfPages, type PdfPages } from './workspace-explorer.js';
export { diagnoseEnvironment, installPythonPackages } from './environment-doctor.js';
export type {
  EnvironmentDoctorPackage,
  EnvironmentDoctorReport,
  KernelVariableInfo,
  PythonEnvironmentInfo,
  SshConnectionTestResult,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
} from '@scideveloper/shared';
