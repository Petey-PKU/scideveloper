import type {
  ArtifactSnapshotRecord, BundleReplayResult, ComputeTarget, ConnectorInfo, ConnectorQueryResult,
  CustomSpecialist, DiscoveredModelInfo, DistilledSkillDraft, EnvironmentDoctorReport,
  EvidenceGrade, EvidenceStance, ExternalMcpServerConfig, HypothesisEvidence, HypothesisStatus,
  KernelVariableInfo, LiteraturePageView, LiteraturePaper, LiteraturePassage, LlmProviderKind,
  LlmProviderPreset, LlmSettings, ManuscriptDraft, McpToolDescriptor, ModelConnectionTestResult,
  NotebookCell, NotebookDocument, PermissionPolicy, PermissionRequest, ProjectOverview,
  ProvenanceManifest, PythonEnvironmentInfo, ReproducibilityBundle, ResearchHypothesis,
  ResearchMemoryCategory, ResearchMemoryItem, ResearchProject, ReviewReport, SafeLlmSettings,
  ScientificArtifact, Session, SessionNode, SessionSearchResult, SessionTree, SkillDocument,
  SkillMetadata, SlurmJobRecord, SlurmJobSpec, SpecialistDomain, SshConnectionTestResult,
  WorkbenchEvent, WorkspaceFileEntry, WorkspaceFilePreview,
} from '@scideveloper/shared';

export interface Health {
  ok: boolean;
  version: string;
  pythonAvailable: boolean;
  rAvailable?: boolean;
  rVersion?: string;
  dockerAvailable?: boolean;
  dockerVersion?: string;
  pythonEnvironments?: PythonEnvironmentInfo[];
  allowLiveConnectors?: boolean;
  computeTargetsCount: number;
  llm: SafeLlmSettings;
  skillsCount: number;
  connectorsCount: number;
  pythonVersion?: string | null;
  python?: string | { available?: boolean; version?: string } | null;
  activeComputeTargetId?: string;
}

export interface WorkflowDemo {
  id: string;
  title: string;
  domain: SpecialistDomain;
  description: string;
  prompt: string;
  badges: string[];
}

export type CatalogSkill = SkillMetadata & { loaded?: boolean };
export type NewSession = { title: string; workspacePath?: string; computeTargetId?: string; projectId?: string | null };
export type NewProject = {
  name: string;
  description?: string;
  instructions?: string;
  workspacePath?: string;
  defaultComputeTargetId?: string;
  defaultSkills?: string[];
  color?: string;
  pinned?: boolean;
};
export type UpdateProject = Partial<NewProject> & { archived?: boolean };
export type Prompt = {
  content: string;
  parentNodeId?: string;
  specialist?: SpecialistDomain;
  customSpecialistId?: string;
  attachedFiles?: string[];
  computeTargetId?: string;
  mode?: 'standard' | 'deep_research';
};
export type Query = { operation: string; params?: Record<string, unknown>; allowLive?: boolean };
export type SlurmSubmission = { spec: SlurmJobSpec; sessionId?: string; liveSsh?: boolean };
export interface PromptResult {
  userNode: SessionNode;
  finalNode: SessionNode;
  artifacts: ScientificArtifact[];
  tree: SessionTree;
}
interface ConnectorCatalog { connectors: ConnectorInfo[]; externalServers: ExternalMcpServerConfig[] }

const encode = encodeURIComponent;
const session = (id: string) => '/api/sessions/' + encode(id);
const artifact = (id: string, artifactId: string) => session(id) + '/artifacts/' + encode(artifactId);

async function response(url: string, init?: RequestInit) {
  const result = await fetch(url, init);
  if (result.ok) return result;
  const raw = await result.text();
  let message = 'Request failed (' + result.status + ')';
  try {
    const body: { error?: unknown; message?: unknown } = JSON.parse(raw);
    const detail = body?.error ?? body?.message;
    if (typeof detail === 'string') message = detail;
  } catch {
    if (raw && !raw.trimStart().startsWith('<')) message = raw.slice(0, 500);
  }
  throw new Error(message);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const result = await response(url, init);
  if (result.status === 204) return undefined as T;
  return result.json() as Promise<T>;
}

function write<T>(url: string, body: unknown, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') {
  return json<T>(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const eventTypes: WorkbenchEvent['type'][] = [
  'project_updated', 'project_deleted',
  'hypothesis_updated', 'hypothesis_deleted',
  'notebook_updated', 'deep_research_progress', 'skill_saved',
  'session_updated', 'node_created', 'node_delta', 'thinking_delta', 'skill_loaded',
  'subagent_started', 'subagent_finished', 'tool_started', 'tool_output_delta', 'tool_finished',
  'artifact_created', 'review_completed', 'permission_requested', 'permission_decided',
  'slurm_job_updated', 'steering_applied', 'session_compacted', 'token_usage_updated',
  'memory_updated', 'run_cancelled', 'run_completed', 'run_error',
];

export const api = {
  health: () => json<Health>('/api/health'),
  modelPresets: async () => (await json<{ presets: LlmProviderPreset[] }>('/api/models/presets')).presets,
  testModel: (body: { provider: LlmProviderKind; model: string; baseUrl?: string; apiKey?: string }) =>
    write<ModelConnectionTestResult>('/api/models/test', body),
  discoverModels: async (body: { provider: LlmProviderKind; baseUrl?: string; apiKey?: string }) =>
    (await write<{ models: DiscoveredModelInfo[] }>('/api/models/discover', body)).models,

  projects: async (includeArchived = false) =>
    (await json<{ projects: ResearchProject[] }>('/api/projects' + (includeArchived ? '?includeArchived=true' : ''))).projects,
  createProject: async (body: NewProject) =>
    (await write<{ project: ResearchProject }>('/api/projects', body)).project,
  projectOverview: (id: string) => json<ProjectOverview>('/api/projects/' + encode(id) + '/overview'),
  updateProject: async (id: string, body: UpdateProject) =>
    (await write<{ project: ResearchProject }>('/api/projects/' + encode(id), body, 'PATCH')).project,
  deleteProject: (id: string, deleteSessions = false) =>
    write<{ deleted: boolean }>('/api/projects/' + encode(id) + (deleteSessions ? '?deleteSessions=true' : ''), undefined, 'DELETE'),

  // v0.5 Project Hypothesis Board
  hypotheses: async (projectId: string) =>
    (await json<{ hypotheses: ResearchHypothesis[] }>('/api/projects/' + encode(projectId) + '/hypotheses')).hypotheses,
  createHypothesis: async (projectId: string, body: {
    title: string; statement: string; status?: HypothesisStatus; confidence?: number; nextExperiment?: string; sourceSessionId?: string;
  }) => (await write<{ hypothesis: ResearchHypothesis }>('/api/projects/' + encode(projectId) + '/hypotheses', body)).hypothesis,
  updateHypothesis: async (projectId: string, hypothesisId: string, body: {
    title?: string; statement?: string; status?: HypothesisStatus; confidence?: number; nextExperiment?: string | null;
  }) => (await write<{ hypothesis: ResearchHypothesis }>('/api/projects/' + encode(projectId) + '/hypotheses/' + encode(hypothesisId), body, 'PATCH')).hypothesis,
  addHypothesisEvidence: async (projectId: string, hypothesisId: string, body: {
    kind: EvidenceStance; summary: string; sourceType?: HypothesisEvidence['sourceType']; sourceId?: string; citation?: string; grade?: EvidenceGrade;
  }) => (await write<{ hypothesis: ResearchHypothesis }>('/api/projects/' + encode(projectId) + '/hypotheses/' + encode(hypothesisId) + '/evidence', body)).hypothesis,
  deleteHypothesis: (projectId: string, hypothesisId: string) =>
    write<{ deleted: boolean }>('/api/projects/' + encode(projectId) + '/hypotheses/' + encode(hypothesisId), undefined, 'DELETE'),

  sessions: async (projectId?: string) =>
    (await json<{ sessions: Session[] }>('/api/sessions' + (projectId ? '?projectId=' + encode(projectId) : ''))).sessions,
  searchSessions: async (q: string, projectId?: string) =>
    (await json<{ results: SessionSearchResult[] }>(
      '/api/sessions/search?q=' + encode(q) + (projectId ? '&projectId=' + encode(projectId) : ''),
    )).results,
  createSession: async (body: NewSession) => (await write<{ session: Session }>('/api/sessions', body)).session,
  updateSession: async (id: string, body: { title?: string; pinned?: boolean; projectId?: string | null }) =>
    (await write<{ session: Session }>(session(id), body, 'PATCH')).session,
  deleteSession: (id: string) => write<{ deleted: boolean }>(session(id), undefined, 'DELETE'),
  session: (id: string, signal?: AbortSignal) => json<SessionTree>(session(id), { signal }),
  compactSession: (id: string) =>
    write<{ session: Session; summary: string; compactedNodeCount: number; tree: SessionTree }>(session(id) + '/compact', {}),
  updateWorkspace: async (id: string, workspacePath: string) =>
    (await write<{ session: Session }>(session(id) + '/workspace', { workspacePath }, 'PUT')).session,
  workspaceFiles: (id: string, subPath?: string) =>
    json<{ workspacePath: string; files: WorkspaceFileEntry[] }>(
      session(id) + '/files' + (subPath ? '?path=' + encode(subPath) : ''),
    ),
  previewWorkspaceFile: (id: string, relativePath: string) =>
    json<WorkspaceFilePreview>(session(id) + '/files/preview?path=' + encode(relativePath)),
  uploadWorkspaceFile: async (id: string, body: { filename: string; content: string; isBase64?: boolean }) =>
    (await write<{ file: WorkspaceFileEntry }>(session(id) + '/files/upload', body)).file,
  fork: (id: string, body: { fromNodeId: string; title?: string }) => write<SessionTree>(session(id) + '/fork', body),
  message: (id: string, body: Prompt) => write<PromptResult>(session(id) + '/messages', body),
  cancelRun: (id: string) => write<{ cancelled: boolean }>(session(id) + '/cancel', {}),
  steerRun: (id: string, message: string) => write<{ queued: boolean }>(session(id) + '/steer', { message }),

  runCodeCell: (
    id: string,
    body: { language: 'python' | 'r'; code: string; title?: string; methods?: string; sourceArtifactId?: string },
  ) =>
    write<{
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      artifacts: ScientificArtifact[];
      review?: ReviewReport;
      tree: SessionTree;
    }>(session(id) + '/cells/run', body),
  kernelVariables: (id: string) =>
    json<{ python: KernelVariableInfo[]; r: KernelVariableInfo[] }>(session(id) + '/kernel/variables'),
  resetKernel: (id: string, language: 'python' | 'r' | 'all' = 'all') =>
    write<{ reset: boolean }>(session(id) + '/kernel/reset', { language }),

  // v0.5 Multi-Cell Jupyter Notebook Studio (.ipynb bidirectional import/export)
  notebook: async (id: string) => (await json<{ notebook: NotebookDocument }>(session(id) + '/notebook')).notebook,
  saveNotebook: async (id: string, body: { title?: string; cells: NotebookCell[] }) =>
    (await write<{ notebook: NotebookDocument }>(session(id) + '/notebook', body, 'PUT')).notebook,
  importNotebook: (id: string, body: { filename: string; content: string; isBase64?: boolean }) =>
    write<{ notebook: NotebookDocument; importedCells: number }>(session(id) + '/notebook/import', body),
  exportNotebookUrl: (id: string) => session(id) + '/notebook/export.ipynb',
  runNotebookCell: (id: string, cellId: string, body?: { source?: string; language?: 'python' | 'r' }) =>
    write<{ cell: NotebookCell; notebook: NotebookDocument; artifacts: ScientificArtifact[]; tree: SessionTree }>(
      session(id) + '/notebook/cells/' + encode(cellId) + '/run',
      body ?? {},
    ),
  runAllNotebookCells: (id: string) =>
    write<{ notebook: NotebookDocument; artifacts: ScientificArtifact[]; tree: SessionTree; failedCellId?: string }>(
      session(id) + '/notebook/run-all',
      {},
    ),

  // v0.5 Workflow-to-Skill Distillation & Custom Skills
  distillSkill: async (id: string, body?: { name?: string; title?: string; domain?: SpecialistDomain }) =>
    (await write<{ draft: DistilledSkillDraft }>(session(id) + '/distill-skill', body ?? {})).draft,
  saveCustomSkill: async (body: DistilledSkillDraft & { attachToProjectId?: string }) =>
    (await write<{ skill: SkillDocument }>('/api/skills/custom', body)).skill,
  deleteCustomSkill: (name: string) => write<{ deleted: boolean }>('/api/skills/custom/' + encode(name), undefined, 'DELETE'),
  snapshots: async (id: string, artifactId?: string) =>
    (
      await json<{ snapshots: ArtifactSnapshotRecord[] }>(
        session(id) + '/snapshots' + (artifactId ? '?artifactId=' + encode(artifactId) : ''),
      )
    ).snapshots,

  memoryList: async (params?: { workspacePath?: string; projectId?: string; scope?: 'global' | 'workspace' | 'project'; category?: ResearchMemoryCategory }) => {
    const qs = new URLSearchParams();
    if (params?.workspacePath) qs.set('workspacePath', params.workspacePath);
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.scope) qs.set('scope', params.scope);
    if (params?.category) qs.set('category', params.category);
    const suffix = qs.toString() ? '?' + qs.toString() : '';
    return (await json<{ items: ResearchMemoryItem[] }>('/api/memory' + suffix)).items;
  },
  saveMemory: async (body: Omit<ResearchMemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
    (await write<{ item: ResearchMemoryItem }>('/api/memory', body)).item,
  deleteMemory: (id: string) => write<{ deleted: boolean }>('/api/memory/' + encode(id), undefined, 'DELETE'),

  literatureList: async (projectId?: string) =>
    (await json<{ papers: LiteraturePaper[] }>('/api/literature' + (projectId ? '?projectId=' + encode(projectId) : ''))).papers,
  importLiterature: async (body: {
    filename: string;
    content: string;
    isBase64?: boolean;
    projectId?: string | null;
    title?: string;
    authors?: string[];
    year?: number;
    journal?: string;
    doi?: string;
    pmid?: string;
  }) => (await write<{ paper: LiteraturePaper }>('/api/literature/import', body)).paper,
  searchLiterature: async (q: string, projectId?: string) =>
    (await json<{ passages: LiteraturePassage[] }>(
      '/api/literature/search?q=' + encode(q) + (projectId ? '&projectId=' + encode(projectId) : ''),
    )).passages,
  literaturePage: async (paperId: string, page: number, q?: string) =>
    (await json<{ pageView: LiteraturePageView }>(
      '/api/literature/' + encode(paperId) + '/page/' + encode(String(page)) + (q ? '?q=' + encode(q) : ''),
    )).pageView,
  deleteLiterature: (id: string) => write<{ deleted: boolean }>('/api/literature/' + encode(id), undefined, 'DELETE'),

  subscribe(id: string, onEvent: (event: WorkbenchEvent) => void, onConnection: (connected: boolean) => void) {
    const stream = new EventSource(session(id) + '/events');
    const receive = (event: MessageEvent<string>) => {
      let payload: WorkbenchEvent;
      try {
        const value = JSON.parse(event.data);
        if (!value || typeof value !== 'object') return;
        payload = { ...value, type: value.type ?? event.type };
        if (!eventTypes.includes(payload.type)) return;
      } catch {
        return;
      }
      onEvent(payload);
    };
    stream.onmessage = receive;
    for (const type of eventTypes) stream.addEventListener(type, receive);
    stream.onopen = () => onConnection(true);
    stream.onerror = () => onConnection(false);
    return () => stream.close();
  },
  provenance: (id: string, aid: string, signal?: AbortSignal) => json<ProvenanceManifest>(artifact(id, aid) + '/provenance', { signal }),
  exportBundle: (id: string, aid: string) => write<ReproducibilityBundle>(artifact(id, aid) + '/export', {}),
  replayBundle: (id: string, body: { manifest: ProvenanceManifest; code?: string }) =>
    write<{ replay: BundleReplayResult; artifact?: ScientificArtifact; tree: SessionTree }>(
      session(id) + '/bundles/replay',
      body,
    ),
  artifactUrl: (id: string, aid: string) => artifact(id, aid) + '/content',
  vectorArtifactUrl: (id: string, aid: string, format: 'svg' | 'pdf') => artifact(id, aid) + '/vector/' + format,
  artifactText: async (id: string, aid: string, signal?: AbortSignal) =>
    (await response(artifact(id, aid) + '/content', { signal })).text(),
  refineArtifact: (id: string, aid: string, instruction: string) =>
    write<{ artifact: ScientificArtifact; node: SessionNode; review: ReviewReport; tree: SessionTree }>(
      artifact(id, aid) + '/refine',
      { instruction },
    ),
  review: (id: string, body: { nodeId?: string; allowLiveCitations?: boolean } = {}) =>
    write<ReviewReport>(session(id) + '/review', body),
  autoFixReview: (id: string, reviewId?: string) =>
    write<PromptResult>(session(id) + '/review/autofix', reviewId ? { reviewId } : {}),
  compileManuscript: (id: string, body: { title?: string } = {}) =>
    write<{ manuscript: ManuscriptDraft; artifact: ScientificArtifact; tree: SessionTree }>(
      session(id) + '/manuscript',
      body,
    ),
  exportManuscriptBinary: async (id: string, format: 'overleaf-zip' | 'docx', title?: string): Promise<Blob> => {
    const res = await response(session(id) + '/manuscript/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, title }),
    });
    return res.blob();
  },
  skills: async () => (await json<{ skills: CatalogSkill[] }>('/api/skills')).skills,
  skill: (name: string) => json<SkillDocument>('/api/skills/' + encode(name)),
  specialists: async () => (await json<{ specialists: CustomSpecialist[] }>('/api/specialists')).specialists,
  createSpecialist: async (body: Omit<CustomSpecialist, 'id' | 'createdAt'>) =>
    (await write<{ specialist: CustomSpecialist }>('/api/specialists', body)).specialist,
  deleteSpecialist: (id: string) => write<{ deleted: boolean }>('/api/specialists/' + encode(id), undefined, 'DELETE'),
  connectors: () => json<ConnectorCatalog>('/api/connectors'),
  query: (id: string, body: Query) => write<ConnectorQueryResult>('/api/connectors/' + encode(id) + '/query', body),
  saveConnectorCredential: (id: string, apiKey: string) =>
    write<{ connectorId: string; hasCredential: boolean }>('/api/connectors/' + encode(id) + '/credential', { apiKey }, 'PUT'),
  registerMcp: async (body: ExternalMcpServerConfig) =>
    (await write<{ server: ExternalMcpServerConfig }>('/api/connectors/external', body)).server,
  discoverMcpTools: (id: string) =>
    write<{ tools: McpToolDescriptor[]; connectors: ConnectorInfo[] }>('/api/connectors/external/' + encode(id) + '/discover', {}),
  removeExternalMcp: (id: string) =>
    write<{ deleted: boolean }>('/api/connectors/external/' + encode(id), undefined, 'DELETE'),
  targets: async () => (await json<{ targets: ComputeTarget[] }>('/api/compute/targets')).targets,
  saveTarget: async (body: ComputeTarget) => (await write<{ target: ComputeTarget }>('/api/compute/targets', body)).target,
  removeTarget: (id: string) => write<{ deleted: boolean }>('/api/compute/targets/' + encode(id), undefined, 'DELETE'),
  testTarget: (id: string) => write<SshConnectionTestResult>('/api/compute/targets/' + encode(id) + '/test', {}),
  computeEnvironments: () =>
    json<{ pythonEnvironments: PythonEnvironmentInfo[]; rRuntime: { available: boolean; persistentReady?: boolean; version?: string; executable?: string } }>(
      '/api/compute/environments',
    ),
  doctor: () => json<EnvironmentDoctorReport>('/api/compute/doctor'),
  installPackages: (sessionId: string | undefined, packages: string[]) =>
    write<{ exitCode: number; stdout: string; stderr: string; command: string }>('/api/compute/doctor/install', {
      sessionId,
      packages,
    }),
  slurmPreview: (body: SlurmJobSpec) => write<{ script: string }>('/api/compute/slurm/preview', body),
  slurmSubmit: async (body: SlurmSubmission) => (await write<{ job: SlurmJobRecord }>('/api/compute/slurm/submit', body)).job,
  pollSlurmJob: async (jobId: string) => (await write<{ job: SlurmJobRecord }>('/api/compute/slurm/jobs/' + encode(jobId) + '/poll', {})).job,
  cancelSlurmJob: async (jobId: string) => (await write<{ job: SlurmJobRecord }>('/api/compute/slurm/jobs/' + encode(jobId) + '/cancel', {})).job,
  syncSlurmArtifacts: (jobId: string, sessionId?: string) =>
    write<{ job: SlurmJobRecord; syncedFiles: string[] }>('/api/compute/slurm/jobs/' + encode(jobId) + '/sync', { sessionId }),
  jobs: async () => (await json<{ jobs: SlurmJobRecord[] }>('/api/compute/slurm/jobs')).jobs,
  policy: async () => (await json<{ policy: PermissionPolicy }>('/api/permissions/policy')).policy,
  savePolicy: async (body: Partial<Omit<PermissionPolicy, 'rules'>> & { rules?: Partial<PermissionPolicy['rules']> }) =>
    (await write<{ policy: PermissionPolicy }>('/api/permissions/policy', body, 'PUT')).policy,
  pending: () => json<{ pending: PermissionRequest[]; history: PermissionRequest[] }>('/api/permissions/pending'),
  decide: async (id: string, approve: boolean) =>
    (await write<{ request: PermissionRequest }>('/api/permissions/' + encode(id) + '/decide', { approve })).request,
  settings: async () => (await json<{ settings: SafeLlmSettings }>('/api/settings')).settings,
  saveSettings: async (body: Partial<LlmSettings>) => (await write<{ settings: SafeLlmSettings }>('/api/settings', body, 'PUT')).settings,
  demos: async () => (await json<{ demos: WorkflowDemo[] }>('/api/demos')).demos,
};

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
