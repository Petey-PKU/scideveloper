import crypto from 'node:crypto';
import path from 'node:path';
import type {
  PermissionAction,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from '@scideveloper/shared';

export interface PermissionGateOptions {
  policy?: PermissionPolicyPatch;
  onRequest?: (req: PermissionRequest) => void;
  onDecided?: (req: PermissionRequest) => void;
  approvalTimeoutMs?: number;
}

type PermissionPolicyPatch = Partial<Omit<PermissionPolicy, 'rules'>> & {
  rules?: Partial<PermissionPolicy['rules']>;
};

export class PermissionDeniedError extends Error {
  public readonly request: PermissionRequest;
  constructor(request: PermissionRequest) {
    super(`Permission denied for ${request.action} on "${request.target}" (${request.reason})`);
    this.name = 'PermissionDeniedError';
    this.request = request;
  }
}

export class PermissionGate {
  private policy: PermissionPolicy;
  private readonly pending = new Map<
    string,
    { request: PermissionRequest; resolve: (approved: boolean) => void }
  >();
  private readonly history: PermissionRequest[] = [];
  private readonly onRequest?: (req: PermissionRequest) => void;
  private readonly onDecided?: (req: PermissionRequest) => void;
  private readonly approvalTimeoutMs: number;

  constructor(options: PermissionGateOptions = {}) {
    this.policy = {
      allowedWorkspaceRoots: options.policy?.allowedWorkspaceRoots ?? [process.cwd()],
      allowedNetworkHosts: options.policy?.allowedNetworkHosts ?? [
        'pubmed',
        'rcsb-pdb',
        'uniprot',
        'chembl',
        'ensembl',
        'clinvar',
        'geo',
        'arxiv-biorxiv',
        'string-db',
        'kegg',
        'reactome',
        'alphafold-db',
        'cbioportal',
        'opentargets',
        'pubchem',
        'eln-benchling',
        'eutils.ncbi.nlm.nih.gov',
        'www.ebi.ac.uk',
        'data.rcsb.org',
        'files.rcsb.org',
        'rest.uniprot.org',
        'www.ebi.ac.uk/chembl',
        'rest.ensembl.org',
        '127.0.0.1',
        'localhost',
      ],
      rules: {
        fs_read: 'allow',
        fs_write: 'allow',
        local_exec: 'allow',
        network_connector: 'allow',
        remote_hpc_submit: 'ask',
        package_install: 'ask',
        ...(options.policy?.rules ?? {}),
      },
      autoApproveReadOnly: options.policy?.autoApproveReadOnly ?? true,
      strictSandboxGuard: options.policy?.strictSandboxGuard ?? true,
    };
    this.onRequest = options.onRequest;
    this.onDecided = options.onDecided;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
  }

  getPolicy(): PermissionPolicy {
    return structuredClone(this.policy);
  }

  updatePolicy(patch: PermissionPolicyPatch): PermissionPolicy {
    this.policy = {
      ...this.policy,
      ...patch,
      rules: {
        ...this.policy.rules,
        ...(patch.rules ?? {}),
      },
    };
    return this.getPolicy();
  }

  listPending(): PermissionRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  listHistory(): PermissionRequest[] {
    return [...this.history];
  }

  isPathWithinWorkspace(targetPath: string): boolean {
    return this.policy.allowedWorkspaceRoots.some((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(targetPath));
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
  }

  isHostAllowed(host: string): boolean {
    const normalized = host.toLowerCase();
    return this.policy.allowedNetworkHosts.some(
      (allowed) => normalized === allowed.toLowerCase() || normalized.endsWith('.' + allowed.toLowerCase())
    );
  }

  evaluateDecision(action: PermissionAction, target: string): PermissionDecision {
    if ((action === 'fs_read' || action === 'fs_write') && !this.isPathWithinWorkspace(target)) {
      return 'ask';
    }
    if (action === 'network_connector' && !this.isHostAllowed(target)) {
      return 'ask';
    }
    if (action === 'fs_read' && this.policy.autoApproveReadOnly) {
      return 'allow';
    }
    return this.policy.rules[action] ?? 'ask';
  }

  async assertAllowed(
    sessionId: string,
    action: PermissionAction,
    target: string,
    reason: string
  ): Promise<PermissionRequest> {
    const decision = this.evaluateDecision(action, target);
    const now = new Date().toISOString();
    const request: PermissionRequest = {
      id: `perm_${crypto.randomUUID().slice(0, 10)}`,
      sessionId,
      action,
      target,
      reason,
      status: decision === 'allow' ? 'approved' : decision === 'deny' ? 'denied' : 'pending',
      createdAt: now,
      decidedAt: decision === 'ask' ? undefined : now,
    };

    if (decision === 'allow') {
      this.history.push(request);
      return request;
    }

    if (decision === 'deny') {
      this.history.push(request);
      throw new PermissionDeniedError(request);
    }

    // Interactive 'ask' flow
    const approved = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(request.id)) {
          this.pending.delete(request.id);
          request.status = 'denied';
          request.decidedAt = new Date().toISOString();
          this.history.push(request);
          this.onDecided?.(request);
          resolve(false);
        }
      }, this.approvalTimeoutMs);

      this.pending.set(request.id, {
        request,
        resolve: (val: boolean) => {
          clearTimeout(timer);
          resolve(val);
        },
      });
      try {
        this.onRequest?.(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(error);
      }
    });

    if (!approved) {
      throw new PermissionDeniedError(request);
    }
    return request;
  }

  decide(requestId: string, approve: boolean): PermissionRequest {
    const entry = this.pending.get(requestId);
    if (!entry) {
      throw new Error(`No pending permission request with id: ${requestId}`);
    }
    this.pending.delete(requestId);
    entry.request.status = approve ? 'approved' : 'denied';
    entry.request.decidedAt = new Date().toISOString();
    this.history.push(entry.request);
    this.onDecided?.(entry.request);
    entry.resolve(approve);
    return entry.request;
  }
}
