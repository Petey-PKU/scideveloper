// Core shared contracts for SciDeveloper AI Scientific Research Workbench (v0.5 — Notebook Studio, Hypothesis Board, Deep Research & Reusable Skills)

export type AgentRole = 'user' | 'coordinator' | 'specialist' | 'reviewer' | 'tool' | 'system';

export type SpecialistDomain =
  | 'genomics'
  | 'single-cell'
  | 'structural-biology'
  | 'cheminformatics'
  | 'statistics'
  | 'literature'
  | 'manuscript'
  | 'proteomics'
  | 'metabolomics'
  | 'clinical'
  | 'custom';

export type ArtifactType =
  | 'figure'
  | 'interactive_chart'
  | 'table'
  | 'protein_3d'
  | 'molecule_2d'
  | 'genome_track'
  | 'phylo_tree'
  | 'manuscript'
  | 'code_report'
  | 'raw_data';

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  estimatedContextTokens: number;
  contextWindowLimit: number;
  updatedAt: string;
}

export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  workspacePath: string;
  defaultComputeTargetId: string;
  defaultSkills: string[];
  color?: string;
  pinned?: boolean;
  archived?: boolean;
  sessionCount?: number;
  memoryCount?: number;
  paperCount?: number;
  artifactCount?: number;
  hypothesisCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectOverview {
  project: ResearchProject;
  sessions: Session[];
  memories: ResearchMemoryItem[];
  papers: LiteraturePaper[];
  recentArtifacts: ScientificArtifact[];
  hypotheses?: ResearchHypothesis[];
}

export interface Session {
  id: string;
  projectId?: string | null;
  title: string;
  workspacePath: string;
  rootNodeId: string | null;
  activeNodeId: string | null;
  forkedFromSessionId?: string | null;
  forkedFromNodeId?: string | null;
  computeTargetId: string;
  pinned?: boolean;
  compactedUpToNodeId?: string | null;
  compactionSummary?: string | null;
  tokenUsage?: SessionTokenUsage;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  snippet: string;
  matchKind: 'title' | 'node' | 'artifact';
  nodeId?: string;
  artifactId?: string;
  updatedAt: string;
}

export interface SessionNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: AgentRole;
  agentName: string;
  specialistDomain?: SpecialistDomain;
  content: string;
  thinking?: string;
  metadata?: Record<string, unknown>;
  artifactIds: string[];
  createdAt: string;
}

export interface SessionTree {
  session: Session;
  nodes: SessionNode[];
  artifacts: ScientificArtifact[];
  reviews: ReviewReport[];
  loadedSkills: string[];
}

export interface EnvironmentSnapshot {
  capturedAt: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  computeTargetId: string;
  computeTargetKind: ComputeTargetKind;
  pythonVersion?: string;
  pythonExecutable?: string;
  rVersion?: string;
  dockerImage?: string;
  packages: Record<string, string>;
  workingDirectory: string;
}

export interface ExecutionCodeRecord {
  language: 'python' | 'r' | 'bash' | 'slurm' | 'mcp-query';
  code: string;
  codeSha256: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  editedByResearcher?: boolean;
  executedAt: string;
}

export interface LineageStep {
  nodeId: string;
  role: AgentRole;
  agentName: string;
  summary: string;
  createdAt: string;
}

export interface ProvenanceManifest {
  id: string;
  artifactId: string;
  sessionId: string;
  nodeId: string;
  executionCode: ExecutionCodeRecord;
  environmentSnapshot: EnvironmentSnapshot;
  conversationalLineage: LineageStep[];
  plainLanguageSummary: string;
  inputHashes: Record<string, string>;
  outputSha256: string;
  createdAt: string;
}

export interface VectorExportFiles {
  svgPath?: string;
  pdfPath?: string;
}

export interface ScientificArtifact {
  id: string;
  sessionId: string;
  nodeId: string;
  type: ArtifactType;
  title: string;
  description: string;
  mimeType: string;
  filePath: string;
  fileSizeBytes: number;
  sha256: string;
  previewData?: Record<string, unknown>;
  vectorExports?: VectorExportFiles;
  refinedFromArtifactId?: string;
  provenanceId: string;
  reviewStatus: 'pending' | 'pass' | 'warn' | 'fail';
  createdAt: string;
}

export interface ReproducibilityBundle {
  bundleId: string;
  artifactId: string;
  exportDir: string;
  files: Array<{ name: string; relativePath: string; sha256: string }>;
  methodsMarkdown: string;
  reproScript: string;
  createdAt: string;
}

export interface BundleReplayResult {
  replayId: string;
  sourceArtifactId: string;
  replayedArtifactId?: string;
  codeSha256Matched: boolean;
  outputSha256Matched: boolean;
  expectedOutputSha256: string;
  actualOutputSha256?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  summary: string;
  replayedAt: string;
}

// Cross-Session Research Memory & Local Literature Library (v0.4)
export type ResearchMemoryCategory = 'convention' | 'hypothesis' | 'dataset' | 'finding' | 'preference';

export interface ResearchMemoryItem {
  id: string;
  scope: 'global' | 'workspace' | 'project';
  projectId?: string | null;
  workspacePath?: string;
  category: ResearchMemoryCategory;
  title: string;
  content: string;
  tags: string[];
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiteraturePaper {
  id: string;
  projectId?: string | null;
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  filePath?: string;
  pageCount: number;
  chunkCount: number;
  sha256?: string;
  addedAt: string;
}

export interface LiteraturePassage {
  paperId: string;
  paperTitle: string;
  page: number;
  chunkIndex: number;
  text: string;
  score: number;
  matchedTerms?: string[];
  matchMode?: 'hybrid' | 'semantic' | 'lexical';
  doi?: string;
  pmid?: string;
}

export interface LiteraturePageView {
  paper: LiteraturePaper;
  page: number;
  totalPages: number;
  text: string;
  matchedTerms: string[];
  highlightSpans: Array<{ start: number; end: number; term: string }>;
}

// Multi-Cell Jupyter Notebook Studio contracts (v0.5)
export type NotebookCellKind = 'markdown' | 'code';
export type NotebookCellLanguage = 'python' | 'r' | 'markdown';

export interface NotebookCellOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  artifactIds?: string[];
  imagesBase64?: Array<{ mimeType: string; data: string; title?: string }>;
  executedAt?: string;
}

export interface NotebookCell {
  id: string;
  kind: NotebookCellKind;
  language: NotebookCellLanguage;
  title?: string;
  source: string;
  executionCount?: number | null;
  sourceArtifactId?: string;
  sourceNodeId?: string;
  editedByResearcher?: boolean;
  output?: NotebookCellOutput;
}

export interface NotebookDocument {
  sessionId: string;
  title: string;
  cells: NotebookCell[];
  updatedAt: string;
}

// Project Hypothesis Board & Deep Research Synthesis contracts (v0.5)
export type HypothesisStatus = 'proposed' | 'testing' | 'supported' | 'refuted' | 'inconclusive';
export type EvidenceStance = 'supporting' | 'contradicting' | 'neutral';
export type EvidenceGrade = 'rct' | 'meta-analysis' | 'cohort' | 'preclinical' | 'computational' | 'preprint' | 'other';

export interface HypothesisEvidence {
  id: string;
  kind: EvidenceStance;
  summary: string;
  sourceType: 'paper' | 'artifact' | 'connector' | 'session' | 'manual';
  sourceId?: string;
  citation?: string;
  grade?: EvidenceGrade;
  createdAt: string;
}

export interface ResearchHypothesis {
  id: string;
  projectId: string;
  title: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number; // 0-100
  evidence: HypothesisEvidence[];
  nextExperiment?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeepResearchProgress {
  sessionId: string;
  stage: 'planning' | 'retrieving' | 'cross_checking' | 'synthesizing' | 'completed';
  message: string;
  sourcesReviewed: number;
  hypothesesEvaluated: number;
}

export interface KernelVariableInfo {
  name: string;
  typeName: string;
  shape?: string;
  sizeBytes?: number;
  preview: string;
  columns?: string[];
}

export interface ArtifactSnapshotRecord {
  id: string;
  sessionId: string;
  artifactId: string;
  label: string;
  filePath: string;
  sha256: string;
  code?: string;
  createdAt: string;
}

// Workspace File Explorer contracts (Local-First Data Analysis)
export interface WorkspaceFileEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  extension: string;
  modifiedAt: string;
}

export type WorkspacePreviewFormat =
  | 'csv'
  | 'tsv'
  | 'xlsx'
  | 'pdf'
  | 'h5ad'
  | 'parquet'
  | 'vcf'
  | 'sdf'
  | 'json'
  | 'pdb'
  | 'fasta'
  | 'markdown'
  | 'text'
  | 'binary';

export interface WorkspaceFilePreview {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  format: WorkspacePreviewFormat;
  headers?: string[];
  rows?: string[][];
  totalLines?: number;
  sheets?: string[];
  pageCount?: number;
  structuredMetadata?: Record<string, unknown>;
  previewText: string;
  sha256: string;
}

// Sub-Agent Delegation & Custom Specialist Agents
export interface CustomSpecialist {
  id: string;
  name: string;
  domain: SpecialistDomain;
  description: string;
  systemPrompt: string;
  defaultSkills: string[];
  createdAt: string;
}

export interface SubAgentRunSummary {
  runId: string;
  specialistName: string;
  domain: SpecialistDomain;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  artifactIds: string[];
  durationMs: number;
}

// Manuscript & Phylogenetic Tree contracts
export interface ManuscriptSection {
  id: string;
  heading: string;
  content: string;
}

export interface ManuscriptDraft {
  id: string;
  sessionId: string;
  title: string;
  authors: string[];
  sections: ManuscriptSection[];
  citations: Array<{ identifier: string; title: string; verified: boolean; year?: number; journal?: string; doi?: string }>;
  figureArtifactIds: string[];
  latexSource: string;
  bibtexSource: string;
  markdownSource: string;
  updatedAt: string;
}

export interface PhyloTreeNode {
  name: string;
  branchLength?: number;
  bootstrap?: number;
  clade?: string;
  children?: PhyloTreeNode[];
}

// Background Reviewer Agent contracts
export type ReviewSeverity = 'pass' | 'warn' | 'fail';

export type ReviewCheckCategory =
  | 'numeric_parity'
  | 'code_figure_alignment'
  | 'statistical_rigor'
  | 'citation_verification'
  | 'reproducibility'
  | 'methodology_semantics'
  | 'visual_inspection';

export interface ReviewFinding {
  id: string;
  category: ReviewCheckCategory;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  evidence?: string;
  suggestedFix?: string;
}

export interface ReviewReport {
  id: string;
  sessionId: string;
  nodeId: string;
  artifactIds: string[];
  overallStatus: ReviewSeverity;
  score: number; // 0-100
  summary: string;
  findings: ReviewFinding[];
  verifiedCitations: Array<{
    identifier: string;
    title?: string;
    verified: boolean;
    source?: string;
    journal?: string;
    year?: number;
    url?: string;
  }>;
  semanticAuditUsed?: boolean;
  visionAuditUsed?: boolean;
  autoFixPrompt?: string;
  createdAt: string;
}

// Progressive Disclosure Skills contracts
export interface SkillMetadata {
  name: string;
  title: string;
  description: string;
  domain: SpecialistDomain;
  tags: string[];
  recommendedConnectors: string[];
  filePath: string;
  hasScripts: boolean;
  isCustom?: boolean;
}

export interface SkillDocument extends SkillMetadata {
  instructions: string;
  scripts: Array<{ name: string; path: string; language: string }>;
}

export interface DistilledSkillDraft {
  name: string;
  title: string;
  description: string;
  domain: SpecialistDomain;
  tags: string[];
  recommendedConnectors: string[];
  instructions: string;
  sourceSessionId?: string;
}

// MCP Connectors & Spill-to-Disk contracts
export interface SpillHandle {
  spilled: true;
  spillId: string;
  filePath: string;
  format: 'json' | 'tsv' | 'csv' | 'pdb' | 'fasta' | 'txt';
  byteSize: number;
  lineCount: number;
  sha256: string;
  schemaSummary: string;
  previewLines: string[];
}

export interface ConnectorQueryResult<T = unknown> {
  connectorId: string;
  operation: string;
  source: 'live' | 'offline-fallback';
  fetchedAt: string;
  spilled: boolean;
  data?: T;
  spillHandle?: SpillHandle;
  summary: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  category:
    | 'literature'
    | 'genomics'
    | 'structural'
    | 'chemistry'
    | 'protein'
    | 'clinical'
    | 'pathways'
    | 'eln'
    | 'external-mcp';
  description: string;
  operations: string[];
  status: 'ready' | 'offline-fallback' | 'configured' | 'connected' | 'error';
  endpoint?: string;
  discoveredTools?: McpToolDescriptor[];
  supportsCredential?: boolean;
  hasCredential?: boolean;
  credentialLabel?: string;
}

export interface ExternalMcpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

// Permission-Gated I/O & Sandbox Guard contracts
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type PermissionAction =
  | 'fs_read'
  | 'fs_write'
  | 'local_exec'
  | 'network_connector'
  | 'remote_hpc_submit'
  | 'package_install';

export interface PermissionPolicy {
  allowedWorkspaceRoots: string[];
  allowedNetworkHosts: string[];
  rules: Record<PermissionAction, PermissionDecision>;
  autoApproveReadOnly: boolean;
  strictSandboxGuard?: boolean; // Enforces read-only raw datasets + socket host guard inside Python sandbox
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  action: PermissionAction;
  target: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  decidedAt?: string;
}

export type ComputeTargetKind =
  | 'local-sandbox'
  | 'container-docker'
  | 'ssh-workstation'
  | 'hpc-slurm'
  | 'cloud-gpu';

export interface PythonEnvironmentInfo {
  id: string;
  name: string;
  executable: string;
  version?: string;
  kind: 'system' | 'conda' | 'venv';
  active: boolean;
}

export interface EnvironmentDoctorPackage {
  name: string;
  purpose: string;
  installed: boolean;
  version?: string;
  recommended: boolean;
}

export interface EnvironmentDoctorReport {
  checkedAt: string;
  python: { available: boolean; executable: string; version?: string };
  r: { available: boolean; persistentReady: boolean; version?: string; executable?: string };
  docker: { available: boolean; version?: string };
  uvAvailable: boolean;
  condaAvailable: boolean;
  sandboxGuardSupported: boolean;
  packages: EnvironmentDoctorPackage[];
  suggestedInstallCommand?: string;
}

export interface ComputeTarget {
  id: string;
  name: string;
  kind: ComputeTargetKind;
  status: 'online' | 'configured' | 'simulated' | 'offline';
  host?: string;
  port?: number;
  username?: string;
  identityFile?: string;
  jumpHost?: string;
  remoteWorkDir?: string;
  partition?: string;
  gpuType?: string;
  defaultCpus?: number;
  defaultMemGb?: number;
  condaEnv?: string;
  dockerImage?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  allowContainerNetwork?: boolean;
  description: string;
}

export interface SshConnectionTestResult {
  targetId: string;
  ok: boolean;
  mode: 'live-ssh' | 'simulated' | 'docker';
  latencyMs: number;
  remoteHostInfo?: string;
  message: string;
}

export interface SlurmJobSpec {
  targetId: string;
  jobName: string;
  partition: string;
  cpus: number;
  memGb: number;
  gpus?: number;
  walltime: string;
  condaEnv?: string;
  modules?: string[];
  command: string;
  workingDir?: string;
}

export interface SlurmJobRecord {
  id: string;
  slurmJobId: string;
  targetId: string;
  spec: SlurmJobSpec;
  scriptContent: string;
  mode: 'live-ssh' | 'simulated';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stdout: string;
  stderr: string;
  syncedFiles?: string[];
  submittedAt: string;
  updatedAt: string;
}

// Multi-Provider Frontier LLM Gateway Contracts (v0.4 — No offline demo mode)
export type LlmProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'openrouter'
  | 'xai'
  | 'azure-openai'
  | 'together'
  | 'siliconflow'
  | 'dashscope'
  | 'zhipu'
  | 'moonshot'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible';

export type LlmProtocolKind = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export interface LlmProviderPreset {
  id: LlmProviderKind;
  name: string;
  protocol: LlmProtocolKind;
  defaultBaseUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsTools: boolean;
  contextWindowDefault: number;
  envKeyName?: string;
  description: string;
}

export interface RoleModelRoute {
  provider: LlmProviderKind;
  model: string;
  baseUrl?: string;
}

export interface ModelRoutingConfig {
  subagent?: RoleModelRoute;
  reviewer?: RoleModelRoute;
  compaction?: RoleModelRoute;
}

export interface LlmSettings {
  provider: LlmProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Optional provider target when storing/updating an API key without switching active provider */
  apiKeyProvider?: LlmProviderKind;
  providerBaseUrls?: Partial<Record<LlmProviderKind, string>>;
  providerModels?: Partial<Record<LlmProviderKind, string>>;
  routing?: ModelRoutingConfig;
  temperature: number;
  enableThinking?: boolean;
  thinkingBudgetTokens?: number;
  allowLiveConnectors?: boolean;
  pythonExecutable?: string;
  maxAgentIterations?: number;
  enableVisionAudit?: boolean;
  memoryLimitMb?: number;
  language?: 'zh' | 'en';
}

export interface SafeLlmSettings {
  provider: LlmProviderKind;
  model: string;
  baseUrl?: string;
  hasApiKey: boolean;
  configuredProviders: LlmProviderKind[];
  providerBaseUrls?: Partial<Record<LlmProviderKind, string>>;
  providerModels?: Partial<Record<LlmProviderKind, string>>;
  routing?: ModelRoutingConfig;
  keyProtection?: 'dpapi-safe-storage' | 'aes-256-gcm-vault' | 'none';
  temperature: number;
  enableThinking: boolean;
  thinkingBudgetTokens: number;
  allowLiveConnectors: boolean;
  pythonExecutable?: string;
  maxAgentIterations: number;
  enableVisionAudit: boolean;
  memoryLimitMb: number;
  language: 'zh' | 'en';
  isConfigured: boolean;
}

export interface ModelConnectionTestResult {
  ok: boolean;
  provider: LlmProviderKind;
  model: string;
  latencyMs: number;
  replyPreview?: string;
  error?: string;
}

export interface DiscoveredModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}

// Real-time Workbench Event Stream (SSE)
export type WorkbenchEvent =
  | { type: 'project_updated'; project: ResearchProject }
  | { type: 'project_deleted'; projectId: string }
  | { type: 'session_updated'; session: Session }
  | { type: 'node_created'; node: SessionNode }
  | { type: 'node_delta'; sessionId: string; nodeId: string; delta: string }
  | { type: 'thinking_delta'; sessionId: string; nodeId: string; delta: string }
  | { type: 'skill_loaded'; sessionId: string; skillName: string; domain: SpecialistDomain }
  | { type: 'subagent_started'; sessionId: string; runId: string; specialistName: string; domain: SpecialistDomain; task: string }
  | { type: 'subagent_finished'; sessionId: string; summary: SubAgentRunSummary }
  | { type: 'tool_started'; sessionId: string; nodeId: string; toolName: string; summary: string; iteration?: number }
  | { type: 'tool_output_delta'; sessionId: string; nodeId: string; toolName: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'tool_finished'; sessionId: string; nodeId: string; toolName: string; summary: string; spillHandle?: SpillHandle; exitCode?: number }
  | { type: 'artifact_created'; sessionId: string; artifact: ScientificArtifact }
  | { type: 'review_completed'; sessionId: string; report: ReviewReport }
  | { type: 'permission_requested'; request: PermissionRequest }
  | { type: 'permission_decided'; request: PermissionRequest }
  | { type: 'slurm_job_updated'; job: SlurmJobRecord }
  | { type: 'steering_applied'; sessionId: string; message: string }
  | { type: 'session_compacted'; sessionId: string; summary: string; compactedNodeCount: number; tokenUsage: SessionTokenUsage }
  | { type: 'token_usage_updated'; sessionId: string; tokenUsage: SessionTokenUsage }
  | { type: 'memory_updated'; item: ResearchMemoryItem }
  | { type: 'hypothesis_updated'; hypothesis: ResearchHypothesis }
  | { type: 'hypothesis_deleted'; projectId: string; hypothesisId: string }
  | { type: 'notebook_updated'; sessionId: string; cellCount: number }
  | { type: 'deep_research_progress'; progress: DeepResearchProgress }
  | { type: 'skill_saved'; skill: SkillMetadata }
  | { type: 'run_cancelled'; sessionId: string; reason: string }
  | { type: 'run_completed'; sessionId: string; activeNodeId: string }
  | { type: 'run_error'; sessionId: string; error: string };
