import { statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Response } from 'express';
import {
  evidenceGrades, evidenceSources, evidenceStances, hypothesisStatuses,
  LLM_PROVIDER_IDS, LLM_PROVIDER_PRESETS, memoryCategories, OrchestratorError, SciDeveloperOrchestrator,
  type AddHypothesisEvidenceInput, type CodeCellInput, type CreateHypothesisInput, type CreateProjectInput,
  type CustomSkillInput, type CustomSpecialistInput, type DistillSkillOptions, type LiteratureImportInput,
  type ModelConnectionInput, type ModelDiscoveryInput, type ResearchMemoryInput, type RunPromptInput,
  type NotebookCellOverride, type NotebookImportInput, type NotebookWriteInput, type UpdateHypothesisInput, type UpdateProjectInput,
} from '@scideveloper/agents';
import { DockerSandboxWorker, diagnoseEnvironment, installPythonPackages, listPythonEnvironments, PermissionDeniedError, RScriptSandboxWorker } from '@scideveloper/compute';
import type {
  ComputeTarget, ExternalMcpServerConfig, LlmProviderKind, LlmSettings, ModelRoutingConfig, PermissionPolicy, ProvenanceManifest,
  NotebookCell, ResearchMemoryCategory, RoleModelRoute,
  SlurmJobSpec, SpecialistDomain, WorkbenchEvent,
} from '@scideveloper/shared';

interface AppOptions {
  dataDir?: string;
  skillsDir?: string;
  workspaceRoot?: string;
  webDistDir?: string;
  allowLiveConnectors?: boolean;
}

interface StartedServer {
  server: http.Server;
  port: number;
  url: string;
}

interface SciDeveloperApp {
  app: Express;
  orchestrator: SciDeveloperOrchestrator;
  start(port?: number): Promise<StartedServer>;
  close(): Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const host = '127.0.0.1';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function found<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new HttpError(404, label + ' not found');
  return value;
}

type Check<T> = (value: unknown) => value is T;
type Schema<T> = { [K in keyof T]-?: Check<T[K]> };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const string = (value: unknown): value is string => typeof value === 'string';
const text = (value: unknown): value is string => string(value) && value.trim().length > 0;
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => number(value) && value > 0;
const positiveInteger = (value: unknown): value is number => positive(value) && Number.isSafeInteger(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const stringMap = (value: unknown): value is Record<string, string> => object(value) && Object.values(value).every(string);
const optional = <T>(check: Check<T>): Check<T | undefined> =>
  (value): value is T | undefined => value === undefined || check(value);
const projectIdOrNull = optional((value): value is string | null => value === null || text(value));
const oneOf = <T extends string>(...choices: T[]): Check<T> =>
  (value): value is T => choices.some((choice) => choice === value);

function readBody<T extends object>(value: unknown, schema: Schema<T>): T {
  if (value === undefined) value = {};
  if (!object(value)) throw new HttpError(400, 'Expected a JSON object');
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(schema) as (keyof T & string)[]) {
    const field = Object.hasOwn(value, key) ? value[key] : undefined;
    if (!schema[key](field)) throw new HttpError(400, 'Invalid or missing field: ' + key);
    if (field !== undefined) entries.push([key, field]);
  }
  return Object.fromEntries(entries) as T;
}

function workspaceQueryPath(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!string(value) || (required && !text(value)) || value.includes('\0')) {
    throw new HttpError(400, 'Invalid or missing query parameter: path');
  }
  return value;
}

async function workspaceOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (object(error)) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, 'Workspace path not found');
      if (error.code === 'EEXIST') throw new HttpError(409, 'A file with that name already exists');
      if (error.code === 'EACCES' || error.code === 'EPERM') throw new HttpError(403, 'Workspace path is inaccessible');
    }
    if (error instanceof Error && /^(?:Path is outside the workspace|Expected a relative workspace path|Expected a regular workspace file|Expected a workspace datasets directory|The upload filename)/.test(error.message)) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

const specialist = oneOf<SpecialistDomain>(
  'genomics', 'single-cell', 'structural-biology', 'cheminformatics',
  'statistics', 'literature', 'manuscript', 'proteomics', 'metabolomics', 'clinical', 'custom',
);
const provider = oneOf(...LLM_PROVIDER_IDS);
const memoryCategory = oneOf(...memoryCategories);
const memoryScope = oneOf('global', 'workspace', 'project');
const projectFields: Schema<Omit<CreateProjectInput, 'name'>> = {
  description: optional(string), instructions: optional(string), workspacePath: optional(string),
  defaultComputeTargetId: optional(text), defaultSkills: optional(strings), color: optional(string), pinned: optional(boolean),
};
const hypothesisFields = {
  status: optional(oneOf(...hypothesisStatuses)), confidence: optional(number), nextExperiment: optional(string),
};
const hypothesisEvidenceFields: Schema<AddHypothesisEvidenceInput> = {
  kind: oneOf(...evidenceStances), summary: text, sourceType: optional(oneOf(...evidenceSources)),
  sourceId: optional(text), citation: optional(text), grade: optional(oneOf(...evidenceGrades)),
};
const baseUrl = (value: unknown): value is string => {
  if (!string(value)) return false;
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search;
  } catch {
    return false;
  }
};
const providerMap = (check: Check<string>): Check<Partial<Record<LlmProviderKind, string>>> =>
  (value): value is Partial<Record<LlmProviderKind, string>> => object(value) &&
    Object.entries(value).every(([id, field]) => provider(id) && check(field));
const modelRoute = (value: unknown): value is RoleModelRoute => object(value) &&
  provider(value.provider) && text(value.model) && optional(baseUrl)(value.baseUrl) &&
  Object.keys(value).every((key) => ['provider', 'model', 'baseUrl'].includes(key));
const modelRouting = (value: unknown): value is ModelRoutingConfig => object(value) &&
  Object.entries(value).every(([role, route]) => ['subagent', 'reviewer', 'compaction'].includes(role) && modelRoute(route));

const specSchema: Schema<SlurmJobSpec> = {
  targetId: text, jobName: text, partition: text, cpus: positive, memGb: positive,
  gpus: optional((value): value is number => number(value) && value >= 0),
  walltime: text, condaEnv: optional(string), modules: optional(strings),
  command: text, workingDir: optional(string),
};

function matchesSession(event: WorkbenchEvent, id: string, projectId: () => string | null | undefined): boolean {
  switch (event.type) {
    case 'permission_requested':
    case 'permission_decided':
    case 'slurm_job_updated':
    case 'memory_updated':
    case 'project_updated':
    case 'project_deleted':
    case 'skill_saved':
      return true;
    case 'hypothesis_updated':
      return event.hypothesis.projectId === projectId();
    case 'hypothesis_deleted':
      return event.projectId === projectId();
    case 'deep_research_progress':
      return event.progress.sessionId === id;
    case 'node_created':
      return event.node.sessionId === id;
    case 'session_updated':
      return event.session.id === id;
    default:
      return event.sessionId === id;
  }
}

export function createSciDeveloperApp(options: AppOptions = {}): SciDeveloperApp {
  const dataDir = path.resolve(options.dataDir ?? path.join(repoRoot, '.scideveloper'));
  const workspaceRoot = path.resolve(options.workspaceRoot ?? repoRoot);
  const webDistDir = path.resolve(options.webDistDir ?? path.join(repoRoot, 'apps/web/dist'));
  const orchestrator = new SciDeveloperOrchestrator({
    dataDir,
    workspaceRoot,
    skillsDir: options.skillsDir ?? path.join(repoRoot, 'skills'),
    allowLiveConnectors: options.allowLiveConnectors,
  });
  const { provenance, skills, connectors, slurm, permissions, llm, workspace } = orchestrator;
  const app = express();
  const api = express.Router();
  const streams = new Set<Response>();
  const operations = new Set<Promise<unknown>>();
  let listener: Promise<StartedServer> | undefined;
  let shutdown: Promise<void> | undefined;

  interface ComputeEnvironments {
    pythonEnvironments: Awaited<ReturnType<typeof listPythonEnvironments>>;
    rRuntime: Awaited<ReturnType<typeof RScriptSandboxWorker.isAvailable>>;
    dockerRuntime: Awaited<ReturnType<typeof DockerSandboxWorker.isAvailable>>;
  }
  let envCache: { key: string; at: number; value: ComputeEnvironments } | undefined;
  let envInFlight: { key: string; promise: Promise<ComputeEnvironments> } | undefined;

  async function computeEnvironments() {
    const activeExec = llm.getSafeSettings().pythonExecutable || '';
    if (envCache && envCache.key === activeExec && Date.now() - envCache.at < 60_000) {
      return envCache.value;
    }
    if (envInFlight && envInFlight.key === activeExec) {
      return envInFlight.promise;
    }
    const promise = Promise.all([
      listPythonEnvironments(activeExec || undefined),
      RScriptSandboxWorker.isAvailable(),
      DockerSandboxWorker.isAvailable(),
    ]).then(([pythonEnvironments, rRuntime, dockerRuntime]) => {
      const value = { pythonEnvironments, rRuntime, dockerRuntime };
      envCache = { key: activeExec, at: Date.now(), value };
      return value;
    }).finally(() => {
      if (envInFlight?.promise === promise) envInFlight = undefined;
    });
    envInFlight = { key: activeExec, promise };
    return promise;
  }

  async function track<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    try {
      return await operation;
    } finally {
      operations.delete(operation);
    }
  }

  function session(id: string) {
    return found(provenance.getSession(id), 'Session');
  }

  function artifactFor(sessionId: string, artifactId: string) {
    const artifact = provenance.getArtifact(artifactId);
    return found(artifact?.sessionId === sessionId ? artifact : undefined, 'Artifact');
  }

  function nodeFor(sessionId: string, nodeId: string) {
    const node = provenance.getNode(nodeId);
    return found(node?.sessionId === sessionId ? node : undefined, 'Node');
  }

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  const rejectDuringShutdown: RequestHandler = (_req, _res, next) => {
    next(shutdown ? new HttpError(503, 'Server is shutting down') : undefined);
  };
  app.use(rejectDuringShutdown);

  api.get('/health', async (_req, res) => {
    const { pythonEnvironments, rRuntime, dockerRuntime } = await computeEnvironments();
    res.json({
      ok: true, version: '0.5.0', pythonAvailable: pythonEnvironments.some(({ active }) => active),
      rAvailable: rRuntime.available, rVersion: rRuntime.version, pythonEnvironments,
      dockerAvailable: dockerRuntime.available, dockerVersion: dockerRuntime.version,
      allowLiveConnectors: orchestrator.allowLiveConnectors,
      computeTargetsCount: slurm.listTargets().length,
      llm: llm.getSafeSettings(),
      skillsCount: skills.listCatalog().length,
      connectorsCount: connectors.listConnectors().length,
    });
  });
  api.get('/models/presets', (_req, res) => { res.json({ presets: LLM_PROVIDER_PRESETS }); });
  api.post('/models/test', async (req, res) => {
    const input = readBody<ModelConnectionInput>(req.body, {
      provider, model: text, baseUrl: optional(baseUrl), apiKey: optional(string),
    });
    res.json(await track(llm.testConnection(input)));
  });
  api.post('/models/discover', async (req, res) => {
    const input = readBody<ModelDiscoveryInput>(req.body, { provider, baseUrl: optional(baseUrl), apiKey: optional(string) });
    res.json({ models: await track(llm.discoverModels(input)) });
  });
  api.get('/demos', (_req, res) => { res.json({ demos: orchestrator.getDemoTemplates() }); });
  api.get('/projects', (req, res) => {
    res.json({ projects: provenance.listProjects({ includeArchived: req.query.includeArchived === 'true' }) });
  });
  api.post('/projects', (req, res) => {
    const input = readBody<CreateProjectInput>(req.body, { ...projectFields, name: string });
    res.status(201).json({ project: orchestrator.createProject(input) });
  });
  api.get('/projects/:id', (req, res) => {
    res.json({ project: found(provenance.getProject(req.params.id), 'Project') });
  });
  api.get('/projects/:id/overview', (req, res) => {
    res.json(orchestrator.getProjectOverview(req.params.id));
  });
  api.patch('/projects/:id', (req, res) => {
    const patch = readBody<UpdateProjectInput>(req.body, { ...projectFields, name: optional(string), archived: optional(boolean) });
    res.json({ project: orchestrator.updateProject(req.params.id, patch) });
  });
  api.delete('/projects/:id', (req, res) => {
    res.json({ deleted: orchestrator.deleteProject(req.params.id, { deleteSessions: req.query.deleteSessions === 'true' }) });
  });
  api.get('/projects/:id/hypotheses', (req, res) => {
    res.json({ hypotheses: orchestrator.listHypotheses(req.params.id) });
  });
  api.post('/projects/:id/hypotheses', (req, res) => {
    const input = readBody<CreateHypothesisInput>(req.body, {
      ...hypothesisFields, title: text, statement: text, sourceSessionId: optional(text),
      evidence: optional((value): value is AddHypothesisEvidenceInput[] =>
        Array.isArray(value) && value.every((item) => object(item) && Boolean(readBody(item, hypothesisEvidenceFields)))),
    });
    res.status(201).json({ hypothesis: orchestrator.createHypothesis(req.params.id, input) });
  });
  api.patch('/projects/:id/hypotheses/:hid', (req, res) => {
    const patch = readBody<UpdateHypothesisInput>(req.body, {
      ...hypothesisFields, title: optional(text), statement: optional(text),
      nextExperiment: optional((value): value is string | null => value === null || string(value)),
    });
    res.json({ hypothesis: orchestrator.updateHypothesis(req.params.id, req.params.hid, patch) });
  });
  api.post('/projects/:id/hypotheses/:hid/evidence', (req, res) => {
    const evidence = readBody(req.body, hypothesisEvidenceFields);
    res.status(201).json({ hypothesis: orchestrator.addHypothesisEvidence(req.params.id, req.params.hid, evidence) });
  });
  api.delete('/projects/:id/hypotheses/:hid', (req, res) => {
    res.json({ deleted: orchestrator.deleteHypothesis(req.params.id, req.params.hid) });
  });

  api.get('/sessions', (req, res) => {
    const { projectId } = readBody<{ projectId?: string }>(req.query, { projectId: optional(string) });
    const filters = projectId === 'unassigned' ? { unassignedOnly: true } : projectId ? { projectId } : undefined;
    res.json({ sessions: provenance.listSessions(filters) });
  });
  api.post('/sessions', (req, res) => {
    const body = readBody<{ title?: string; workspacePath?: string; computeTargetId?: string; projectId?: string | null }>(req.body, {
      title: optional(string), workspacePath: optional(text), computeTargetId: optional(text), projectId: projectIdOrNull,
    });
    const project = body.projectId == null ? null : found(provenance.getProject(body.projectId), 'Project');
    const created = provenance.createSession({
      title: body.title?.trim() || 'Untitled Session',
      workspacePath: path.resolve(workspaceRoot, body.workspacePath ?? project?.workspacePath ?? '.'),
      computeTargetId: body.computeTargetId ?? project?.defaultComputeTargetId,
      projectId: body.projectId,
    });
    res.status(201).json({ session: created });
  });
  api.get('/sessions/search', (req, res) => {
    const { q, projectId } = readBody<{ q?: string; projectId?: string }>(req.query, { q: optional(string), projectId: optional(string) });
    res.json({ results: provenance.searchSessions(q ?? '', 25, projectId || undefined) });
  });
  api.get('/sessions/:id', (req, res) => {
    res.json(found(provenance.getSessionTree(req.params.id), 'Session'));
  });
  api.patch('/sessions/:id', (req, res) => {
    const { projectId, ...patch } = readBody<{ title?: string; pinned?: boolean; projectId?: string | null }>(req.body, {
      title: optional(text), pinned: optional(boolean), projectId: projectIdOrNull,
    });
    const moved = projectId === undefined ? undefined : orchestrator.moveSessionToProject(req.params.id, projectId);
    const updated = moved && patch.title === undefined && patch.pinned === undefined
      ? moved : orchestrator.updateSession(req.params.id, patch);
    res.json({ session: updated });
  });
  api.delete('/sessions/:id', (req, res) => {
    res.json({ deleted: orchestrator.deleteSession(req.params.id) });
  });
  api.post('/sessions/:id/compact', async (req, res) => {
    const { id } = req.params;
    const result = await track(orchestrator.compactSession(id));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.post('/sessions/:id/cells/run', async (req, res) => {
    const { id } = req.params;
    const input = readBody<CodeCellInput>(req.body, {
      language: oneOf('python', 'r'), code: text, title: optional(string), methods: optional(string), sourceArtifactId: optional(text),
    });
    const result = await track(orchestrator.runCodeCell(id, input));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.get('/sessions/:id/notebook', (req, res) => {
    res.json({ notebook: orchestrator.getSessionNotebook(req.params.id) });
  });
  api.put('/sessions/:id/notebook', (req, res) => {
    const input = readBody<NotebookWriteInput>(req.body, {
      title: optional(string), cells: (value): value is NotebookCell[] => Array.isArray(value),
    });
    res.json({ notebook: orchestrator.saveSessionNotebook(req.params.id, input) });
  });
  api.post('/sessions/:id/notebook/import', (req, res) => {
    const input = readBody<NotebookImportInput>(req.body, { filename: text, content: string, isBase64: optional(boolean) });
    res.status(201).json(orchestrator.importSessionNotebook(req.params.id, input));
  });
  api.get('/sessions/:id/notebook/export.ipynb', (req, res) => {
    const { filename, content } = orchestrator.exportSessionNotebookIpynb(req.params.id);
    res.set('Content-Disposition', 'attachment; filename="' + filename + '"').type('application/x-ipynb+json').send(content);
  });
  api.post('/sessions/:id/notebook/cells/:cellId/run', async (req, res) => {
    const overrides = readBody<NotebookCellOverride>(req.body, { source: optional(string), language: optional(oneOf('python', 'r')) });
    res.json(await track(orchestrator.runNotebookCell(req.params.id, req.params.cellId, overrides)));
  });
  api.post('/sessions/:id/notebook/run-all', async (req, res) => {
    res.json(await track(orchestrator.runAllNotebookCells(req.params.id)));
  });
  api.post('/sessions/:id/distill-skill', async (req, res) => {
    const options = readBody<DistillSkillOptions>(req.body, {
      name: optional(text), title: optional(text), domain: optional(specialist),
    });
    res.json({ draft: await track(orchestrator.distillSessionSkill(req.params.id, options)) });
  });
  api.get('/sessions/:id/kernel/variables', async (req, res) => {
    res.json(await track(orchestrator.listKernelVariables(req.params.id)));
  });
  api.post('/sessions/:id/kernel/reset', async (req, res) => {
    const { language } = readBody<{ language?: 'python' | 'r' | 'all' }>(req.body, { language: optional(oneOf('python', 'r', 'all')) });
    await track(orchestrator.resetKernel(req.params.id, language));
    res.json({ reset: true });
  });
  api.get('/sessions/:id/snapshots', (req, res) => {
    const { id } = session(req.params.id);
    const { artifactId } = readBody<{ artifactId?: string }>(req.query, { artifactId: optional(text) });
    res.json({ snapshots: provenance.listArtifactSnapshots(id, artifactId) });
  });
  api.put('/sessions/:id/workspace', (req, res) => {
    const { workspacePath } = readBody<{ workspacePath: string }>(req.body, { workspacePath: text });
    res.json({ session: orchestrator.updateSessionWorkspace(req.params.id, workspacePath) });
  });
  api.get('/sessions/:id/files', async (req, res) => {
    const { id, workspacePath } = session(req.params.id);
    const relativePath = workspaceQueryPath(req.query.path);
    const files = await track(workspaceOperation(() => workspace.listFiles(id, workspacePath, relativePath)));
    res.json({ workspacePath, files });
  });
  api.get('/sessions/:id/files/preview', async (req, res) => {
    const { id, workspacePath } = session(req.params.id);
    const relativePath = workspaceQueryPath(req.query.path, true)!;
    res.json(await track(workspaceOperation(() => workspace.previewFile(id, workspacePath, relativePath))));
  });
  api.post('/sessions/:id/files/upload', async (req, res) => {
    const { id, workspacePath } = session(req.params.id);
    const { filename, content, isBase64 } = readBody<{ filename: string; content: string; isBase64?: boolean }>(req.body, {
      filename: text, content: string, isBase64: optional(boolean),
    });
    const file = await track(workspaceOperation(() => workspace.saveUploadedFile(id, workspacePath, filename, content, isBase64)));
    res.status(201).json({ file });
  });
  api.post('/sessions/:id/fork', (req, res) => {
    const { id } = req.params;
    const { fromNodeId, title } = readBody<{ fromNodeId: string; title?: string }>(req.body, {
      fromNodeId: text, title: optional(string),
    });
    session(id);
    nodeFor(id, fromNodeId);
    res.status(201).json(provenance.forkSession(id, fromNodeId, title));
  });
  const promptHandler = (forceDeepResearch = false): RequestHandler<{ id: string }> => async (req, res) => {
    const { id } = req.params;
    session(id);
    const input = readBody<Omit<RunPromptInput, 'sessionId'>>(req.body, {
      content: text,
      parentNodeId: optional((value): value is string | null => value === null || text(value)),
      specialist: optional(specialist),
      computeTargetId: optional(text),
      attachedFiles: optional(strings),
      customSpecialistId: optional(text),
      mode: optional(oneOf('standard', 'deep_research')),
    });
    if (input.parentNodeId) nodeFor(id, input.parentNodeId);
    const result = await track(orchestrator.runPrompt({
      ...input, sessionId: id, mode: forceDeepResearch ? 'deep_research' : input.mode,
    }));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  };
  api.post('/sessions/:id/messages', promptHandler());
  api.post('/sessions/:id/deep-research', promptHandler(true));
  api.post('/sessions/:id/cancel', (req, res) => {
    res.json({ cancelled: orchestrator.cancelRun(req.params.id) });
  });
  api.post('/sessions/:id/steer', (req, res) => {
    const { message } = readBody<{ message: string }>(req.body, { message: string });
    res.json({ queued: orchestrator.steerRun(req.params.id, message) });
  });
  api.post('/sessions/:id/bundles/replay', async (req, res) => {
    const { id } = req.params;
    const input = readBody<{ manifest: ProvenanceManifest; code?: string }>(req.body, {
      manifest: (value): value is ProvenanceManifest => object(value) && object(value.executionCode),
      code: optional(string),
    });
    const result = await track(orchestrator.replayBundle(id, input));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.get('/sessions/:id/events', (req, res) => {
    const { id } = req.params;
    session(id);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const unsubscribe = orchestrator.subscribe((event) => {
      if (matchesSession(event, id, () => provenance.getSession(id)?.projectId)) {
        res.write('data: ' + JSON.stringify(event) + '\n\n');
      }
    });
    const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 20_000);
    const cleanup = () => {
      unsubscribe();
      clearInterval(keepalive);
      streams.delete(res);
      req.off('close', cleanup);
      res.off('close', cleanup);
    };
    streams.add(res);
    req.once('close', cleanup);
    res.once('close', cleanup);
    res.write(': connected\n\n');
  });
  api.get('/sessions/:id/artifacts/:artifactId/provenance', (req, res) => {
    const artifact = artifactFor(req.params.id, req.params.artifactId);
    res.json(found(provenance.getProvenanceByArtifact(artifact.id), 'Provenance manifest'));
  });
  api.post('/sessions/:id/artifacts/:artifactId/export', (req, res) => {
    const artifact = artifactFor(req.params.id, req.params.artifactId);
    found(provenance.getProvenanceByArtifact(artifact.id), 'Provenance manifest');
    res.json(provenance.exportReproducibilityBundle(artifact.id, path.join(dataDir, 'exports')));
  });
  api.get('/sessions/:id/artifacts/:artifactId/content', (req, res) => {
    const artifact = artifactFor(req.params.id, req.params.artifactId);
    res.set({
      'Content-Type': artifact.mimeType,
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(path.resolve(artifact.filePath), { dotfiles: 'allow' });
  });
  api.get('/sessions/:id/artifacts/:artifactId/vector/:format', (req, res) => {
    const { id, artifactId, format } = req.params;
    if (format !== 'svg' && format !== 'pdf') throw new HttpError(400, 'Vector format must be svg or pdf');
    const artifact = artifactFor(id, artifactId);
    const file = format === 'svg' ? artifact.vectorExports?.svgPath : artifact.vectorExports?.pdfPath;
    const filePath = found(file && statSync(file, { throwIfNoEntry: false })?.isFile() ? file : undefined, 'Vector export');
    res.attachment(path.basename(filePath));
    res.set({
      'Content-Type': format === 'svg' ? 'image/svg+xml' : 'application/pdf',
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(path.resolve(filePath), { dotfiles: 'allow' });
  });
  api.post('/sessions/:id/artifacts/:artifactId/refine', async (req, res) => {
    const { id, artifactId } = req.params;
    const { instruction } = readBody<{ instruction: string }>(req.body, { instruction: text });
    const result = await track(orchestrator.refineArtifact(id, artifactId, instruction));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.post('/sessions/:id/review', async (req, res) => {
    const { id } = req.params;
    const tree = found(provenance.getSessionTree(id), 'Session');
    const body = readBody<{ nodeId?: string; allowLiveCitations?: boolean }>(req.body, {
      nodeId: optional(text), allowLiveCitations: optional(boolean),
    });
    const nodeId = found(body.nodeId ?? tree.session.activeNodeId, 'Review node');
    const node = nodeFor(id, nodeId);
    const metrics = node.metadata?.metrics;
    const { enableVisionAudit, pythonExecutable } = llm.getSafeSettings();
    const report = await track(orchestrator.auditSession({
      sessionId: id, nodeId, proseText: node.content, artifacts: tree.artifacts,
      computedMetrics: object(metrics) ? metrics : undefined,
      allowLiveCitations: body.allowLiveCitations ?? orchestrator.allowLiveConnectors,
      enableVisionAudit, pythonExecutable,
    }));
    res.json(report);
  });
  api.post('/sessions/:id/review/autofix', async (req, res) => {
    const { id } = req.params;
    const { reviewId } = readBody<{ reviewId?: string }>(req.body, { reviewId: optional(text) });
    const result = await track(orchestrator.autoFixReview(id, reviewId));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.post('/sessions/:id/manuscript', async (req, res) => {
    const { id } = req.params;
    const { title } = readBody<{ title?: string }>(req.body, { title: optional(string) });
    const result = await track(orchestrator.compileManuscript(id, title));
    res.json({ ...result, tree: provenance.getSessionTree(id) });
  });
  api.post('/sessions/:id/manuscript/export', async (req, res) => {
    const { format, title } = readBody<{ format: 'overleaf-zip' | 'docx'; title?: string }>(req.body, {
      format: oneOf('overleaf-zip', 'docx'), title: optional(string),
    });
    const { buffer, filename, mimeType } = await track(orchestrator.exportManuscriptBinary(req.params.id, format, title));
    res.set({ 'Content-Type': mimeType, 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(buffer);
  });
  api.get('/specialists', (_req, res) => { res.json({ specialists: orchestrator.listCustomSpecialists() }); });
  api.post('/specialists', (req, res) => {
    const input = readBody<CustomSpecialistInput>(req.body, {
      id: optional(text), name: text, domain: specialist, description: string,
      systemPrompt: text, defaultSkills: strings,
    });
    res.status(201).json({ specialist: orchestrator.saveCustomSpecialist(input) });
  });
  api.delete('/specialists/:id', (req, res) => {
    res.json({ deleted: orchestrator.deleteCustomSpecialist(req.params.id) });
  });

  api.get('/memory', (req, res) => {
    const filters = readBody<{ workspacePath?: string; projectId?: string; scope?: ResearchMemoryInput['scope']; category?: ResearchMemoryCategory }>(req.query, {
      workspacePath: optional(text), projectId: optional(text), scope: optional(memoryScope), category: optional(memoryCategory),
    });
    if (filters.workspacePath) filters.workspacePath = path.resolve(workspaceRoot, filters.workspacePath);
    res.json({ items: provenance.listMemoryItems(filters) });
  });
  api.post('/memory', (req, res) => {
    const input = readBody<ResearchMemoryInput>(req.body, {
      id: optional(text), scope: memoryScope, projectId: projectIdOrNull, workspacePath: optional(text), category: memoryCategory,
      title: text, content: text, tags: strings, sourceSessionId: optional(text),
    });
    res.status(201).json({ item: orchestrator.saveMemoryItem(input) });
  });
  api.delete('/memory/:id', (req, res) => {
    res.json({ deleted: provenance.deleteMemoryItem(req.params.id) });
  });

  api.get('/literature', (req, res) => {
    const { projectId } = readBody<{ projectId?: string }>(req.query, { projectId: optional(string) });
    res.json({ papers: provenance.listLiteraturePapers(projectId ? { projectId } : undefined) });
  });
  api.post('/literature/import', async (req, res) => {
    const input = readBody<LiteratureImportInput>(req.body, {
      filename: text, content: string, isBase64: optional(boolean), title: optional(string), authors: optional(strings),
      projectId: projectIdOrNull, year: optional(positiveInteger), journal: optional(string), doi: optional(string), pmid: optional(string),
    });
    const paper = await track(orchestrator.importLiteraturePaper(input));
    res.status(201).json({ paper });
  });
  api.get('/literature/search', (req, res) => {
    const { q, projectId } = readBody<{ q?: string; projectId?: string }>(req.query, { q: optional(string), projectId: optional(string) });
    res.json({ passages: provenance.searchLiteraturePassages(q ?? '', 8, projectId || undefined) });
  });
  api.get('/literature/:paperId/page/:page', (req, res) => {
    const page = Number(req.params.page);
    if (!/^\d+$/.test(req.params.page) || !positiveInteger(page)) throw new HttpError(400, 'Expected a positive page number');
    const { q } = readBody<{ q?: string }>(req.query, { q: optional(string) });
    res.json({ pageView: found(provenance.getLiteraturePage(req.params.paperId, page, q), 'Literature page') });
  });
  api.delete('/literature/:id', (req, res) => {
    res.json({ deleted: orchestrator.deleteLiteraturePaper(req.params.id) });
  });

  api.get('/skills', (_req, res) => { res.json({ skills: skills.listCatalog() }); });
  api.post('/skills/custom', (req, res) => {
    const draft = readBody<CustomSkillInput>(req.body, {
      name: text, title: text, description: text, domain: specialist, tags: strings, recommendedConnectors: strings,
      instructions: text, sourceSessionId: optional(text), attachToProjectId: optional(text),
    });
    res.status(201).json({ skill: orchestrator.saveCustomSkill(draft) });
  });
  api.delete('/skills/custom/:name', (req, res) => {
    res.json({ deleted: orchestrator.deleteCustomSkill(req.params.name) });
  });
  api.get('/skills/:name', (req, res) => {
    res.json(found(skills.loadSkill(req.params.name), 'Skill'));
  });
  api.get('/connectors', (_req, res) => {
    res.json({ connectors: connectors.listConnectors(), externalServers: connectors.listExternalServers() });
  });
  api.post('/connectors/external', (req, res) => {
    const config = readBody<ExternalMcpServerConfig>(req.body, {
      id: text, name: text, transport: oneOf('stdio', 'http'), command: optional(string),
      args: optional(strings), url: optional(string), env: optional(stringMap), headers: optional(stringMap), enabled: boolean,
    });
    res.status(201).json({ server: orchestrator.registerExternalMcp(config) });
  });
  api.post('/connectors/external/:id/discover', async (req, res) => {
    const { id } = req.params;
    const config = found(connectors.listExternalServers().find((entry) => entry.id === id), 'External MCP server');
    if (!config.enabled) throw new HttpError(409, 'External MCP server is disabled');
    try {
      const tools = await track(connectors.discoverExternalTools(id));
      res.json({ tools, connectors: connectors.listConnectors() });
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : 'External MCP discovery failed');
    }
  });
  api.delete('/connectors/external/:id', (req, res) => {
    res.json({ deleted: orchestrator.removeExternalMcp(req.params.id) });
  });
  api.put('/connectors/:id/credential', (req, res) => {
    const { apiKey } = readBody<{ apiKey: string }>(req.body, { apiKey: string });
    res.json(orchestrator.setConnectorCredential(req.params.id, apiKey));
  });
  api.post('/connectors/:id/query', async (req, res) => {
    const { id } = req.params;
    const { operation, params, allowLive } = readBody<{
      operation: string; params?: Record<string, unknown>; allowLive?: boolean;
    }>(req.body, { operation: text, params: optional(object), allowLive: optional(boolean) });
    const connector = found(connectors.listConnectors().find((entry) => entry.id === id), 'Connector');
    if (!connector.operations.includes(operation)) throw new HttpError(400, 'Unsupported connector operation');
    try {
      const result = await track(connectors.query(id, operation, params ?? {}, {
        allowLive: allowLive ?? orchestrator.allowLiveConnectors,
      }));
      res.json(result);
    } catch (error) {
      // The registry does not export its parameter error class.
      if (error instanceof Error && error.constructor.name === 'InvalidParameter') {
        throw new HttpError(400, error.message);
      }
      if (connector.category === 'external-mcp') {
        throw new HttpError(502, error instanceof Error ? error.message : 'External MCP tool failed');
      }
      throw error;
    }
  });

  api.get('/compute/targets', (_req, res) => { res.json({ targets: slurm.listTargets() }); });
  api.get('/compute/environments', async (_req, res) => {
    const { pythonEnvironments, rRuntime } = await computeEnvironments();
    res.json({ pythonEnvironments, rRuntime });
  });
  api.post('/compute/targets', (req, res) => {
    const target = readBody<ComputeTarget>(req.body, {
      id: text, name: text, kind: oneOf('local-sandbox', 'container-docker', 'ssh-workstation', 'hpc-slurm', 'cloud-gpu'),
      status: oneOf('online', 'configured', 'simulated', 'offline'),
      host: optional(string), port: optional(positive), username: optional(string),
      identityFile: optional(string), jumpHost: optional(string), remoteWorkDir: optional(string),
      partition: optional(string), gpuType: optional(string), defaultCpus: optional(positive),
      defaultMemGb: optional(positive), condaEnv: optional(string), description: string,
      dockerImage: optional(text), memoryLimitMb: optional(positiveInteger), cpuLimit: optional(positive),
      allowContainerNetwork: optional(boolean),
    });
    res.status(201).json({ target: orchestrator.registerComputeTarget(target) });
  });
  api.post('/compute/targets/:id/test', async (req, res) => {
    const { id } = req.params;
    found(slurm.getTarget(id), 'Compute target');
    res.json(await track(slurm.testSshConnection(id)));
  });
  api.get('/compute/doctor', async (_req, res) => {
    res.json(await track(diagnoseEnvironment(llm.getSafeSettings().pythonExecutable || undefined)));
  });
  api.post('/compute/doctor/install', async (req, res) => {
    const { sessionId, packages } = readBody<{ sessionId?: string; packages: string[] }>(req.body, {
      sessionId: optional(text),
      packages: (value): value is string[] => strings(value) && value.length > 0 &&
        value.every((entry) => /^[a-zA-Z0-9._-]+$/.test(entry)),
    });
    res.json(await track(installPythonPackages(sessionId ?? 'global', packages, permissions,
      llm.getSafeSettings().pythonExecutable || undefined)));
  });
  api.delete('/compute/targets/:id', (req, res) => {
    res.json({ deleted: orchestrator.removeComputeTarget(req.params.id) });
  });
  api.post('/compute/slurm/preview', (req, res) => {
    res.json({ script: slurm.generateSbatchScript(readBody(req.body, specSchema)) });
  });
  api.post('/compute/slurm/submit', async (req, res) => {
    const { sessionId, spec, liveSsh } = readBody<{
      sessionId?: string; spec: Record<string, unknown>; liveSsh?: boolean;
    }>(req.body, { sessionId: optional(text), spec: object, liveSsh: optional(boolean) });
    const jobSpec = readBody(spec, specSchema);
    if (sessionId) session(sessionId);
    found(slurm.getTarget(jobSpec.targetId), 'Compute target');
    const job = await track(slurm.submitJob(sessionId ?? 'global', jobSpec, permissions, { liveSsh }));
    res.json({ job });
  });
  api.get('/compute/slurm/jobs', (_req, res) => { res.json({ jobs: slurm.listJobs() }); });
  api.post('/compute/slurm/jobs/:jobId/poll', async (req, res) => {
    const { jobId } = req.params;
    found(slurm.getJob(jobId), 'Slurm job');
    res.json({ job: await track(slurm.pollJobStatus(jobId)) });
  });
  api.post('/compute/slurm/jobs/:jobId/cancel', async (req, res) => {
    const { jobId } = req.params;
    found(slurm.getJob(jobId), 'Slurm job');
    res.json({ job: await track(slurm.cancelJob(jobId)) });
  });
  api.post('/compute/slurm/jobs/:jobId/sync', async (req, res) => {
    const { jobId } = req.params;
    found(slurm.getJob(jobId), 'Slurm job');
    const { sessionId } = readBody<{ sessionId?: string }>(req.body, { sessionId: optional(text) });
    const destination = path.join(sessionId ? session(sessionId).workspacePath : dataDir, 'slurm_outputs', jobId);
    res.json(await track(slurm.syncRemoteArtifacts(jobId, destination)));
  });

  api.get('/permissions/policy', (_req, res) => { res.json({ policy: permissions.getPolicy() }); });
  api.put('/permissions/policy', (req, res) => {
    const decision = optional(oneOf('allow', 'ask', 'deny'));
    const patch = readBody<Partial<Omit<PermissionPolicy, 'rules'>> & { rules?: Record<string, unknown> }>(req.body, {
      allowedWorkspaceRoots: optional(strings), allowedNetworkHosts: optional(strings),
      rules: optional(object), autoApproveReadOnly: optional(boolean), strictSandboxGuard: optional(boolean),
    });
    const rules = readBody<Partial<PermissionPolicy['rules']>>(patch.rules, {
      fs_read: decision, fs_write: decision, local_exec: decision,
      network_connector: decision, remote_hpc_submit: decision, package_install: decision,
    });
    const policy = orchestrator.updatePermissionPolicy({ ...patch, rules });
    res.json({ policy });
  });
  api.get('/permissions/pending', (_req, res) => {
    res.json({ pending: permissions.listPending(), history: permissions.listHistory() });
  });
  api.post('/permissions/:requestId/decide', (req, res) => {
    const { requestId } = req.params;
    const { approve } = readBody<{ approve: boolean }>(req.body, { approve: boolean });
    found(permissions.listPending().find(({ id }) => id === requestId), 'Pending permission request');
    res.json({ request: permissions.decide(requestId, approve) });
  });
  api.get('/settings', (_req, res) => { res.json({ settings: llm.getSafeSettings() }); });
  api.put('/settings', (req, res) => {
    const patch = readBody<Partial<LlmSettings>>(req.body, {
      provider: optional(provider), model: optional(text), baseUrl: optional(baseUrl),
      apiKey: optional(string), apiKeyProvider: optional(provider), temperature: optional(number),
      providerBaseUrls: optional(providerMap(baseUrl)), providerModels: optional(providerMap(text)),
      routing: optional(modelRouting), allowLiveConnectors: optional(boolean), pythonExecutable: optional(string),
      enableVisionAudit: optional(boolean), maxAgentIterations: optional(positiveInteger),
      enableThinking: optional(boolean), thinkingBudgetTokens: optional(positiveInteger),
      memoryLimitMb: optional(positiveInteger), language: optional(oneOf('zh', 'en')),
    });
    res.json({ settings: orchestrator.updateSettings(patch) });
  });

  app.use('/api', api, (_req, _res, next) => next(new HttpError(404, 'API route not found')));
  if (statSync(webDistDir, { throwIfNoEntry: false })?.isDirectory()) {
    app.use(express.static(webDistDir));
    app.get(/.*/, (_req, res) => { res.sendFile(path.join(webDistDir, 'index.html')); });
  }
  const routeNotFound: RequestHandler = (_req, _res, next) => next(new HttpError(404, 'Route not found'));
  app.use(routeNotFound);
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    const detail = error instanceof Error ? error.message : 'Unknown error';
    let status = 500;
    if (error instanceof PermissionDeniedError) status = 403;
    else if (error instanceof HttpError || error instanceof OrchestratorError) status = error.status;
    else if (object(error) && number(error.status) && error.status >= 400 && error.status < 500) {
      status = error.status;
    }
    if (status === 500) console.error('SciDeveloper request failed:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : detail });
  };
  app.use(handleError);

  function start(port = 4318) {
    if (shutdown) return Promise.reject(new Error('Server has been closed'));
    listener ??= new Promise<StartedServer>((resolve, reject) => {
      const server = http.createServer(app);
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const actualPort = (server.address() as { port: number }).port;
        resolve({ server, port: actualPort, url: 'http://' + host + ':' + actualPort });
      });
    }).catch((error: unknown) => {
      listener = undefined;
      throw error;
    });
    return listener;
  }

  function close(): Promise<void> {
    shutdown ??= Promise.resolve().then(async () => {
      const started = await listener?.catch(() => undefined);
      const stopped = started && new Promise<void>((resolve, reject) => {
        started.server.close((error) => error ? reject(error) : resolve());
      });
      for (const stream of streams) stream.end();
      const denyPending = () => {
        for (const request of permissions.listPending()) permissions.decide(request.id, false);
      };
      const unsubscribe = orchestrator.subscribe((event) => {
        if (event.type === 'permission_requested') queueMicrotask(denyPending);
      });
      denyPending();
      for (const { id } of provenance.listSessions()) orchestrator.cancelRun(id);
      try {
        await Promise.allSettled([...operations, stopped]);
      } finally {
        unsubscribe();
        orchestrator.dispose();
      }
      await stopped;
    });
    return shutdown;
  }

  return { app, orchestrator, start, close };
}
