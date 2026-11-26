import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ComputeTarget, SlurmJobRecord, SlurmJobSpec, SshConnectionTestResult } from '@scideveloper/shared';
import { DockerSandboxWorker } from './docker-sandbox.js';
import type { PermissionGate } from './permission-gate.js';

export interface SlurmHpcAdapterOptions {
  onJobUpdated?: (job: SlurmJobRecord) => void;
  initialTargets?: readonly ComputeTarget[];
  initialJobs?: readonly SlurmJobRecord[];
}

interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const slurmStates: Partial<Record<string, SlurmJobRecord['status']>> = {
  PENDING: 'queued', CONFIGURING: 'queued', REQUEUED: 'queued', REQUEUE_FED: 'queued',
  REQUEUE_HOLD: 'queued', RESV_DEL_HOLD: 'queued', RESIZING: 'running', RUNNING: 'running',
  COMPLETING: 'running', STAGE_OUT: 'running', SIGNALING: 'running', SUSPENDED: 'running',
  STOPPED: 'running', COMPLETED: 'completed', CANCELLED: 'cancelled',
  FAILED: 'failed', BOOT_FAIL: 'failed', DEADLINE: 'failed', NODE_FAIL: 'failed',
  OUT_OF_MEMORY: 'failed', PREEMPTED: 'failed', REVOKED: 'failed', TIMEOUT: 'failed',
};

function isActive(job: SlurmJobRecord): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function parseSlurmState(state: string): SlurmJobRecord['status'] | undefined {
  const name = state.trim().split(/[\s+]/, 1)[0];
  return Object.hasOwn(slurmStates, name) ? slurmStates[name] : undefined;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function remoteDirectoryArgument(value: string): string {
  if (value === '~') return '"$HOME"';
  return value.startsWith('~/') ? '"$HOME"/' + shellQuote(value.slice(2)) : shellQuote(value);
}

function destination(target: ComputeTarget, forScp = false): string {
  const host = target.host!;
  const address = forScp && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return target.username ? `${target.username}@${address}` : address;
}

function connectionOptions(target: ComputeTarget, portFlag: '-p' | '-P', timeout: number): string[] {
  return [
    portFlag, String(target.port ?? 22), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`,
    ...(target.identityFile ? ['-i', target.identityFile] : []),
    ...(target.jumpHost ? ['-J', target.jumpHost] : []),
  ];
}

export class SlurmHpcAdapter {
  private readonly targets = new Map<string, ComputeTarget>();
  private readonly jobs = new Map<string, SlurmJobRecord>();
  private readonly jobOperations = new Map<string, Promise<SlurmJobRecord>>();
  private readonly onJobUpdated?: (job: SlurmJobRecord) => void;

  constructor(options: SlurmHpcAdapterOptions | SlurmHpcAdapterOptions['onJobUpdated'] = {}) {
    const { onJobUpdated, initialTargets, initialJobs } = typeof options === 'function'
      ? { onJobUpdated: options }
      : options;
    this.onJobUpdated = onJobUpdated;

    // Default compute targets
    this.registerTarget({
      id: 'local-sandbox',
      name: 'Local Python/R Sandbox',
      kind: 'local-sandbox',
      status: 'online',
      defaultCpus: 4,
      defaultMemGb: 16,
      description: 'Persistent local scientific sandbox (data never leaves this workstation).',
    });

    const simulatedTarget: ComputeTarget = {
      id: 'lab-hpc-slurm',
      name: 'Lab HPC Cluster (Slurm Simulator / SSH)',
      kind: 'hpc-slurm',
      status: 'simulated',
      host: 'hpc.lab.internal',
      port: 22,
      username: 'researcher',
      partition: 'gpu-a100',
      gpuType: 'A100-80GB',
      defaultCpus: 16,
      defaultMemGb: 64,
      condaEnv: 'bioinfo-py312',
      description:
        'Slurm batch scheduler target. Runs in realistic simulation mode when no live SSH host is configured, or dispatches via SSH sbatch when live credentials are configured.',
    };
    for (const target of initialTargets ?? [simulatedTarget]) this.registerTarget(structuredClone(target));
    if (!this.targets.has('docker-sandbox')) this.registerTarget({
      id: 'docker-sandbox',
      name: 'Docker Sandbox',
      kind: 'container-docker',
      status: 'configured',
      dockerImage: 'python:3.12-slim',
      memoryLimitMb: 4096,
      cpuLimit: 2,
      allowContainerNetwork: false,
      description: 'Docker execution sandbox with a read-only workspace and resource limits.',
    });
    for (const job of initialJobs ?? []) this.jobs.set(job.id, structuredClone(job));
  }

  registerTarget(target: ComputeTarget): ComputeTarget {
    this.targets.set(target.id, target);
    return target;
  }

  removeTarget(id: string): boolean {
    if (id === 'local-sandbox') throw new Error('Cannot remove the local-sandbox compute target');
    return this.targets.delete(id);
  }

  listTargets(): ComputeTarget[] {
    return Array.from(this.targets.values());
  }

  getTarget(id: string): ComputeTarget | undefined {
    return this.targets.get(id);
  }

  listJobs(): SlurmJobRecord[] {
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.submittedAt.localeCompare(a.submittedAt)
    );
  }

  getJob(id: string): SlurmJobRecord | undefined {
    return this.jobs.get(id);
  }

  async testSshConnection(targetId: string): Promise<SshConnectionTestResult> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`Compute target not found: ${targetId}`);
    if (target.kind === 'local-sandbox') {
      return { targetId, ok: true, mode: 'simulated', latencyMs: 0, remoteHostInfo: os.hostname(), message: 'Local sandbox is reachable.' };
    }
    if (target.kind === 'container-docker') {
      const started = performance.now();
      const { available, version } = await DockerSandboxWorker.isAvailable();
      return {
        targetId, mode: 'docker', ok: available, latencyMs: Math.round(performance.now() - started),
        remoteHostInfo: version ? `Docker ${version}` : undefined,
        message: available ? 'Docker daemon is reachable.' : 'Docker daemon is unavailable.',
      };
    }
    if (target.status === 'simulated') {
      return {
        targetId, ok: true, mode: 'simulated', latencyMs: 24,
        remoteHostInfo: `${target.host ?? target.name}\nslurm 24.11 (simulated)`,
        message: 'Simulated SSH and Slurm checks passed.',
      };
    }
    if (!target.host) {
      return { targetId, ok: false, mode: 'live-ssh', latencyMs: 0, message: 'SSH hostname is missing.' };
    }
    const started = performance.now();
    const result = await this.runSsh(target, ['hostname && sinfo --version'], undefined, 5, 10_000);
    return {
      targetId, mode: 'live-ssh', ok: result.exitCode === 0, latencyMs: Math.round(performance.now() - started),
      remoteHostInfo: result.stdout.trim() || undefined,
      message: result.exitCode === 0 ? 'SSH and Slurm checks passed.' : result.stderr.trim() || `SSH exited with code ${result.exitCode}.`,
    };
  }

  async syncRemoteArtifacts(jobId: string, localDestDir: string): Promise<{ job: SlurmJobRecord; syncedFiles: string[] }> {
    const local = path.resolve(localDestDir);
    const job = await this.operateOnJob(jobId, async (record) => {
      let syncedFiles: string[];
      if (record.mode === 'simulated') {
        await fs.mkdir(local, { recursive: true });
        const prefix = `slurm-${record.slurmJobId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const summary = path.join(local, `${prefix}-summary.csv`);
        const log = path.join(local, `${prefix}.log`);
        const fields = [record.slurmJobId, record.status, record.spec.partition, record.spec.cpus, record.spec.memGb, record.submittedAt];
        const values = fields.map((value) => `"${String(value).replaceAll('"', '""')}"`);
        await Promise.all([
          fs.writeFile(summary, `job_id,status,partition,cpus,memory_gb,submitted_at\n${values.join(',')}\n`),
          fs.writeFile(log, `[SciDeveloper simulated Slurm] ${record.spec.jobName}\n${record.stdout}${record.stderr}`),
        ]);
        syncedFiles = [summary, log].sort();
      } else {
        syncedFiles = await this.copyRemoteArtifacts(this.getJobTarget(record), local);
      }
      record.syncedFiles = syncedFiles;
      return this.updateJob(record, record.status);
    });
    return { job, syncedFiles: [...job.syncedFiles!] };
  }

  generateSbatchScript(spec: SlurmJobSpec): string {
    const safeName = spec.jobName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const lines = [
      '#!/bin/bash',
      `#SBATCH --job-name=${safeName}`,
      `#SBATCH --partition=${spec.partition}`,
      `#SBATCH --cpus-per-task=${spec.cpus}`,
      `#SBATCH --mem=${spec.memGb}G`,
      `#SBATCH --time=${spec.walltime}`,
      spec.gpus && spec.gpus > 0 ? `#SBATCH --gres=gpu:${spec.gpus}` : null,
      `#SBATCH --output=logs/${safeName}_%j.out`,
      `#SBATCH --error=logs/${safeName}_%j.err`,
      '',
      'set -euo pipefail',
      'mkdir -p logs',
      spec.workingDir ? `cd -- ${shellQuote(spec.workingDir)}` : null,
      ...(spec.modules ?? []).map((mod) => `module load ${mod}`),
      spec.condaEnv ? `source "$(conda info --base)/etc/profile.d/conda.sh" && conda activate ${spec.condaEnv}` : null,
      '',
      `echo "[SciDeveloper HPC] Started job $SLURM_JOB_ID on $(hostname) at $(date -Iseconds)"`,
      spec.command,
      `echo "[SciDeveloper HPC] Completed job $SLURM_JOB_ID at $(date -Iseconds)"`,
      '',
    ];
    return lines.filter((l) => l !== null).join('\n');
  }

  async submitJob(
    sessionId: string,
    spec: SlurmJobSpec,
    permissionGate: PermissionGate,
    options?: { liveSsh?: boolean }
  ): Promise<SlurmJobRecord> {
    const target = this.targets.get(spec.targetId);
    if (!target) {
      throw new Error(`Compute target not found: ${spec.targetId}`);
    }

    await permissionGate.assertAllowed(
      sessionId,
      'remote_hpc_submit',
      `${target.id} (${target.host ?? 'local'})`,
      `Submit Slurm job "${spec.jobName}" (${spec.cpus} CPUs, ${spec.memGb}GB RAM${spec.gpus ? `, ${spec.gpus} GPUs` : ''})`
    );

    const scriptContent = this.generateSbatchScript(spec);
    const now = new Date().toISOString();
    const id = `job_${crypto.randomUUID().slice(0, 10)}`;
    const useLiveSsh = Boolean(options?.liveSsh && target.host && target.status === 'online');

    if (useLiveSsh) {
      return this.submitViaSsh(id, target, spec, scriptContent, now);
    }

    // Realistic local Slurm queue simulator for offline testing & dry-run verification
    const slurmJobId = String(Math.floor(100000 + Math.random() * 899999));
    const record: SlurmJobRecord = {
      id,
      slurmJobId,
      targetId: target.id,
      spec,
      scriptContent,
      mode: 'simulated',
      status: 'queued',
      stdout: `Submitted batch job ${slurmJobId} to partition ${spec.partition} (simulated HPC scheduler)\n`,
      stderr: '',
      submittedAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, record);
    this.onJobUpdated?.(record);

    // Advance simulated Slurm states asynchronously
    setTimeout(() => {
      if (record.status !== 'queued') return;
      this.updateJob(record, 'running', `Job ${slurmJobId} allocated on node ${target.partition ?? 'compute'}-04 (${spec.cpus} CPUs, ${spec.memGb}GB RAM)\n`);
    }, 600).unref();

    setTimeout(() => {
      if (record.status !== 'running') return;
      this.updateJob(record, 'completed', `Executed command: ${spec.command}\nJob ${slurmJobId} completed with exit code 0 (State: COMPLETED)\n`);
    }, 1800).unref();

    return record;
  }

  pollJobStatus(jobId: string): Promise<SlurmJobRecord> {
    return this.operateOnJob(jobId, async (job) => {
      if (job.mode === 'simulated' || !isActive(job)) return job;
      const target = this.getJobTarget(job);
      const jobFlag = `--jobs=${job.slurmJobId}`;
      const queue = await this.runSsh(target, ['squeue', '--noheader', jobFlag, '--format=%T']);
      let status = queue.exitCode === 0 ? parseSlurmState(queue.stdout) : undefined;
      if (!status) {
        const account = await this.runSsh(target, [
          'sacct', '--noheader', '--parsable2', '--allocations', jobFlag, '--format=JobIDRaw,State%40',
        ]);
        if (account.exitCode !== 0) {
          throw new Error(`Could not poll Slurm job ${job.slurmJobId}: ${account.stderr.trim() || queue.stderr.trim() || 'sacct failed'}`);
        }
        for (const line of account.stdout.split(/\r?\n/)) {
          const [id, state] = line.split('|');
          if (id.trim() === job.slurmJobId && state) {
            status = parseSlurmState(state);
            break;
          }
        }
      }
      return status && status !== job.status ? this.updateJob(job, status) : job;
    });
  }

  cancelJob(jobId: string): Promise<SlurmJobRecord> {
    return this.operateOnJob(jobId, async (job) => {
      if (!isActive(job)) return job;
      if (job.mode === 'live-ssh') {
        const result = await this.runSsh(this.getJobTarget(job), ['scancel', job.slurmJobId]);
        if (result.exitCode !== 0) {
          throw new Error(`Could not cancel Slurm job ${job.slurmJobId}: ${result.stderr.trim() || 'scancel failed'}`);
        }
      }
      return this.updateJob(job, 'cancelled', `Job ${job.slurmJobId} cancelled\n`);
    });
  }

  private async operateOnJob(
    id: string,
    operation: (job: SlurmJobRecord) => Promise<SlurmJobRecord>
  ): Promise<SlurmJobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Slurm job not found: ${id}`);
    const previous = this.jobOperations.get(id);
    const pending = previous ? previous.then(() => operation(job), () => operation(job)) : operation(job);
    this.jobOperations.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.jobOperations.get(id) === pending) this.jobOperations.delete(id);
    }
  }

  private getJobTarget(job: SlurmJobRecord): ComputeTarget {
    if (!/^\d+$/.test(job.slurmJobId)) throw new Error(`Invalid Slurm job ID: ${job.slurmJobId}`);
    const target = this.targets.get(job.targetId);
    if (!target?.host) throw new Error(`SSH target not configured: ${job.targetId}`);
    return target;
  }

  private updateJob(job: SlurmJobRecord, status: SlurmJobRecord['status'], message?: string): SlurmJobRecord {
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (message) job.stdout += `[${job.updatedAt}] ${message}`;
    this.onJobUpdated?.(job);
    return job;
  }

  private async submitViaSsh(
    id: string,
    target: ComputeTarget,
    spec: SlurmJobSpec,
    scriptContent: string,
    now: string
  ): Promise<SlurmJobRecord> {
    const workDir = target.remoteWorkDir && remoteDirectoryArgument(target.remoteWorkDir);
    const command = workDir
      ? [`mkdir -p -- ${workDir} && cd -- ${workDir} && mkdir -p logs && sbatch --parsable`]
      : ['sbatch', '--parsable'];
    const { exitCode, stdout, stderr } = await this.runSsh(target, command, scriptContent);
    const slurmJobId = stdout.trim().match(/^(?:Submitted batch job )?(\d+)(?:;[^\r\n]+)?$/m)?.[1];
    const record: SlurmJobRecord = {
      id,
      slurmJobId: slurmJobId ?? 'unknown',
      targetId: target.id,
      spec,
      scriptContent,
      mode: 'live-ssh',
      status: exitCode === 0 && slurmJobId ? 'queued' : 'failed',
      stdout,
      stderr: stderr || (exitCode === 0 && !slurmJobId ? 'Could not parse the job ID returned by sbatch' : ''),
      submittedAt: now,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, record);
    this.onJobUpdated?.(record);
    return record;
  }

  private async copyRemoteArtifacts(target: ComputeTarget, local: string): Promise<string[]> {
    const remote = target.remoteWorkDir?.replace(/\/+$/, '');
    if (!remote || remote === '.' || /[\0\r\n*?\[\]\\]/.test(remote)) {
      throw new Error(`Set a remote work directory for SSH target ${target.id}`);
    }
    await fs.mkdir(local, { recursive: true });
    const staging = await fs.mkdtemp(path.join(local, '.scidev-scp-'));
    try {
      const args = [...connectionOptions(target, '-P', 10), '-r', '--', `${destination(target, true)}:${remote}`, staging];
      const result = await this.runTransfer('scp', args, undefined, 120_000);
      if (result.exitCode !== 0) throw new Error(`Could not sync Slurm artifacts: ${result.stderr.trim() || 'scp failed'}`);
      const [root, ...extra] = await fs.readdir(staging, { withFileTypes: true });
      if (!root?.isDirectory() || extra.length) throw new Error('scp did not return the configured work directory');
      const copied = path.join(staging, root.name);
      const files = await fs.readdir(copied, { recursive: true, withFileTypes: true });
      await fs.cp(copied, local, { recursive: true });
      return files.filter((file) => file.isFile()).map((file) =>
        path.join(local, path.relative(copied, file.parentPath), file.name)).sort();
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private runSsh(target: ComputeTarget, command: string[], input?: string, connectTimeout = 10, timeout = 30_000): Promise<SshResult> {
    const args = [...connectionOptions(target, '-p', connectTimeout), '--', destination(target), ...command];
    return this.runTransfer('ssh', args, input, timeout);
  }

  private runTransfer(executable: 'ssh' | 'scp', args: string[], input: string | undefined, timeout: number): Promise<SshResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        stderr += `\n${executable} timed out after ${timeout / 1000} seconds\n`;
        child.kill();
        resolve({ exitCode: 124, stdout, stderr });
      }, timeout);
      child.stdout.setEncoding('utf8').on('data', (data) => (stdout += data));
      child.stderr.setEncoding('utf8').on('data', (data) => (stderr += data));
      child.stdin.on('error', (error) => (stderr += error.message + '\n'));
      child.on('error', (error) => (stderr += error.message + '\n'));
      child.stdin.end(input);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
