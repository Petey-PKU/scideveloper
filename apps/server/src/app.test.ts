import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PythonSandboxWorker } from '@scideveloper/compute';
import type {
  ArtifactSnapshotRecord, BundleReplayResult, ConnectorInfo, ConnectorQueryResult, CustomSpecialist, DistilledSkillDraft, LiteraturePaper, ManuscriptDraft, McpToolDescriptor, ProvenanceManifest,
  LiteraturePageView, NotebookDocument, ProjectOverview, ReproducibilityBundle, ResearchHypothesis, ResearchMemoryItem, ResearchProject, ReviewReport, ScientificArtifact, Session, SessionNode, SessionTree, SkillMetadata,
  SlurmJobRecord, SlurmJobSpec, WorkbenchEvent, WorkspaceFileEntry, WorkspaceFilePreview,
} from '@scideveloper/shared';
import { createSciDeveloperApp } from './app.js';

const endpoint = 'https://model-fixture.example/v1';
const realFetch = globalThis.fetch.bind(globalThis);

function reply(content: string, tools: Array<[string, Record<string, unknown>]> = [], reasoning?: string) {
  return Response.json({
    choices: [{ message: {
      content, reasoning_content: reasoning,
      ...(tools.length && { tool_calls: tools.map(([name, args], index) => ({
        id: 'call-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })) }),
    } }],
    usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
  });
}

const defaultProvider: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
  const { messages, tools } = JSON.parse(String(init?.body));
  const system = messages[0].role === 'system' ? messages[0].content : '';
  const last = messages.at(-1);
  if (last.content === 'Reply with OK') return reply('OK');
  if (String(system).includes('Summarize the research session')) return reply('## Summary\nThe calibration objective was recorded.');
  if (!tools?.length) return reply(String(system).includes('Modify the standalone') ? '' : '[]');
  if (String(last.content).includes('Run single-cell QC')) {
    return reply('', [['run_python', { code: [
      'from pathlib import Path',
      'Path(SCIDEV_OUTPUT_DIR, "qc.csv").write_text("cell_id,count\\nA,1\\n", encoding="utf-8")',
      'print("QC output recorded")',
    ].join('\n') }]], 'Preparing the QC table.');
  }
  if (last.role === 'tool') return reply('The requested tool calls completed.');
  if (String(last.content).includes('Initial local dataset profile')) {
    return reply('The recorded profile contains 4 rows, 3 columns and missing values: 1.');
  }
  return reply('The calibration objective was recorded.');
};

function fixturePdf(pageText: string): Buffer {
  const stream = 'BT /F1 12 Tf 30 100 Td (' + pageText + ') Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(pdf);
}

const jobSpec: SlurmJobSpec = {
  targetId: 'lab-hpc-slurm', jobName: 'qc analysis', partition: 'gpu-a100', cpus: 4,
  memGb: 16, gpus: 1, walltime: '00:30:00', command: 'python analysis.py',
};

describe('SciDeveloper HTTP API', () => {
  let directory: string;
  let workbench: ReturnType<typeof createSciDeveloperApp>;
  let url: string;
  const providerFetch = vi.fn<typeof fetch>(defaultProvider);

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'scideveloper-http-'));
    const webDistDir = path.join(directory, 'web');
    await mkdir(webDistDir);
    await writeFile(path.join(webDistDir, 'index.html'), '<main>Workbench</main>');
    await writeFile(path.join(webDistDir, 'client.js'), 'console.log("workbench");');
    workbench = createSciDeveloperApp({ dataDir: directory, workspaceRoot: directory, webDistDir });
    ({ url } = await workbench.start(0));
    await json('/api/settings', write({ provider: 'openai', baseUrl: endpoint, apiKey: 'fixture-openai-key' }, 'PUT'));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith(endpoint + '/')
      ? providerFetch(input, init) : realFetch(input, init));
    await json('/api/permissions/policy', write({ allowedNetworkHosts: ['pubmed'] }, 'PUT'));
  });

  afterEach(() => { providerFetch.mockReset().mockImplementation(defaultProvider); });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await workbench?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  function write(body: unknown, method = 'POST'): RequestInit {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  async function json<T>(route: string, init?: RequestInit, status = 200): Promise<T> {
    const response = await fetch(url + route, init);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
  }

  it('reports health and serves the built workbench without shadowing API errors', async () => {
    expect(new URL(url).hostname).toBe('127.0.0.1');
    const health = await json('/api/health');
    expect(health).toMatchObject({
      ok: true, version: '0.5.0', dockerAvailable: expect.any(Boolean), pythonAvailable: expect.any(Boolean),
      computeTargetsCount: expect.any(Number), skillsCount: 20,
      connectorsCount: 19, llm: { provider: 'openai', isConfigured: true },
      rAvailable: expect.any(Boolean), pythonEnvironments: expect.any(Array), allowLiveConnectors: false,
    });
    await expect(fetch(url + '/research/session').then((response) => response.text())).resolves.toContain('Workbench');
    await expect(fetch(url + '/client.js').then((response) => response.text())).resolves.toContain('console.log');
    await json('/api/missing', undefined, 404);
  });

  it('imports, edits, executes, and downloads a notebook through its HTTP API', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Notebook API' }), 201);
    const sessionRoute = '/api/sessions/' + session.id;
    const route = sessionRoute + '/notebook';
    await json(sessionRoute + '/messages', write({ content: 'Check the optical reference.' }));
    await expect(json(route)).resolves.toMatchObject({ notebook: { cells: [
      { kind: 'markdown', source: 'Check the optical reference.' },
      { kind: 'markdown', source: 'The calibration objective was recorded.' },
    ] } });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT9sAAAAASUVORK5CYII=';
    const imported = await json<{ notebook: NotebookDocument; importedCells: number }>(route + '/import', write({
      filename: 'Calibration.ipynb',
      content: JSON.stringify({
        nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
        cells: [
          { id: 'notes', cell_type: 'markdown', metadata: {}, source: '# Calibration' },
          { id: 'init', cell_type: 'code', metadata: {}, source: ['value = 4\n', 'print(value)'], execution_count: 1, outputs: [
            { output_type: 'stream', name: 'stdout', text: '4\n' },
            { output_type: 'display_data', data: { 'image/png': png }, metadata: {} },
          ] },
        ],
      }),
    }), 201);
    expect(imported).toMatchObject({ importedCells: 2, notebook: { title: 'Calibration', cells: [
      { id: 'notes', source: '# Calibration' }, { id: 'init', output: { stdout: '4\n', imagesBase64: [{ data: png }] } },
    ] } });
    const file = await fetch(url + route + '/export.ipynb');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('application/x-ipynb+json');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="calibration.ipynb"');
    expect(await file.json()).toMatchObject({ nbformat: 4, nbformat_minor: 5, cells: [
      { id: 'notes', cell_type: 'markdown' }, { id: 'init', execution_count: 1, outputs: [
        { output_type: 'stream', name: 'stdout', text: '4\n' }, { output_type: 'display_data', data: { 'image/png': png } },
      ] },
    ] });
    await json(route + '/import', write({ filename: 'invalid.ipynb', content: 'not JSON' }), 400);
    await json(route, write({ cells: [{ id: 'bad', kind: 'code', language: 'ruby', source: 'puts 1' }] }, 'PUT'), 400);
    await expect(json(route)).resolves.toEqual({ notebook: imported.notebook });
    const { notebook } = await json<{ notebook: NotebookDocument }>(route, write({ title: 'Edited Calibration', cells: [
      ...imported.notebook.cells,
      { id: 'next', kind: 'code', language: 'python', source: 'print(value * 2)' },
      { id: 'stop', kind: 'code', language: 'python', source: 'raise RuntimeError("stop the notebook")' },
      { id: 'skip', kind: 'code', language: 'python', source: 'print("skipped")' },
    ] }, 'PUT'));
    expect(notebook.title).toBe('Edited Calibration');
    await json(route + '/cells/unknown/run', write({}), 404);
    await json(route + '/cells/notes/run', write({}), 400);
    const override = [
      'from pathlib import Path',
      'import base64',
      'value = 5',
      'Path(SCIDEV_OUTPUT_DIR, "generated.png").write_bytes(base64.b64decode("' + png + '"))',
      'print(value)',
    ].join('\n');
    const execute = vi.spyOn(PythonSandboxWorker.prototype, 'execute').mockImplementation(async (code, outputDir) => {
      const result = { exitCode: 0, stdout: '', stderr: '', durationMs: 5, figures: [], createdFiles: [], metrics: null };
      if (code.includes('value = 5')) {
        await mkdir(outputDir, { recursive: true });
        const figure = path.join(outputDir, 'generated.png');
        await writeFile(figure, Buffer.from(png, 'base64'));
        return { ...result, stdout: '5\n', figures: [figure] };
      }
      if (code.includes('print(value * 2)')) return { ...result, stdout: '10\n' };
      if (code.includes('stop the notebook')) return { ...result, exitCode: 1, stderr: 'RuntimeError: stop the notebook' };
      throw new Error('Unexpected notebook execution');
    });
    const environment = vi.spyOn(PythonSandboxWorker.prototype, 'captureEnvironment').mockResolvedValue({
      capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, nodeVersion: process.version,
      computeTargetId: 'local-sandbox', computeTargetKind: 'local-sandbox', packages: {}, workingDirectory: directory,
    });
    try {
      await expect(json(route + '/cells/init/run', write({ source: override, language: 'python' }))).resolves.toMatchObject({
        cell: { id: 'init', source: override, executionCount: 2, output: {
          stdout: '5\n', exitCode: 0, durationMs: 5, imagesBase64: [{ data: png }], artifactIds: [expect.any(String)],
        } },
        artifacts: [{ type: 'figure', mimeType: 'image/png' }], tree: { session: { id: session.id } },
      });
      const result = await json<{ notebook: NotebookDocument; failedCellId: string }>(route + '/run-all', write({}));
      expect(result.failedCellId).toBe('stop');
      expect(result.notebook.cells.slice(1)).toMatchObject([
        { id: 'init', executionCount: 3 },
        { id: 'next', executionCount: 4, output: { stdout: '10\n', exitCode: 0 } },
        { id: 'stop', executionCount: 5, output: { stderr: expect.stringContaining('stop the notebook'), exitCode: 1 } },
        { id: 'skip', executionCount: null },
      ]);
      expect(execute).toHaveBeenCalledTimes(4);
      expect(new Set(execute.mock.contexts).size).toBe(1);
      await expect(json(route)).resolves.toEqual({ notebook: result.notebook });
      await json('/api/sessions/missing/notebook', undefined, 404);
    } finally {
      execute.mockRestore();
      environment.mockRestore();
    }
  }, 30_000);

  it('manages hypothesis boards and attaches a distilled custom skill to the project', async () => {
    const { project } = await json<{ project: ResearchProject }>('/api/projects', write({ name: 'Workflow project' }), 201);
    const { project: other } = await json<{ project: ResearchProject }>('/api/projects', write({ name: 'Separate board' }), 201);
    const projectRoute = '/api/projects/' + project.id;
    const board = projectRoute + '/hypotheses';
    const otherBoard = '/api/projects/' + other.id + '/hypotheses';
    await expect(json(board)).resolves.toEqual({ hypotheses: [] });
    await json('/api/projects/missing/hypotheses', undefined, 404);
    const { hypothesis } = await json<{ hypothesis: ResearchHypothesis }>(board, write({
      title: 'Optical baseline', statement: 'Calibration reduces baseline drift.', nextExperiment: 'Repeat once',
    }), 201);
    const hypothesisRoute = board + '/' + hypothesis.id;
    await json(otherBoard + '/' + hypothesis.id, write({ status: 'supported' }, 'PATCH'), 404);
    await json(otherBoard + '/' + hypothesis.id + '/evidence', write({ kind: 'neutral', summary: 'Cross-project write' }), 404);
    await json(otherBoard + '/' + hypothesis.id, { method: 'DELETE' }, 404);
    await json(hypothesisRoute, write({ confidence: 120 }, 'PATCH'), 400);
    const updated = await json<{ hypothesis: ResearchHypothesis }>(hypothesisRoute, write({ status: 'testing', confidence: 64, nextExperiment: null }, 'PATCH'));
    expect(updated.hypothesis).toMatchObject({ status: 'testing', confidence: 64 });
    expect(updated.hypothesis).not.toHaveProperty('nextExperiment');
    await expect(json(hypothesisRoute + '/evidence', write({
      kind: 'supporting', summary: 'A repeat showed lower drift.', grade: 'computational', citation: 'Repeat A',
    }), 201)).resolves.toMatchObject({ hypothesis: {
      evidence: [{ id: expect.any(String), sourceType: 'manual', kind: 'supporting', grade: 'computational', citation: 'Repeat A' }],
    } });
    await expect(json(projectRoute + '/overview')).resolves.toMatchObject({ hypotheses: [{ id: hypothesis.id, status: 'testing' }] });
    await expect(json(board)).resolves.toMatchObject({ hypotheses: [{ id: hypothesis.id }] });
    await expect(json(hypothesisRoute, { method: 'DELETE' })).resolves.toEqual({ deleted: true });
    await expect(json(board)).resolves.toEqual({ hypotheses: [] });

    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Optical workflow', projectId: project.id }), 201);
    const sessionRoute = '/api/sessions/' + session.id;
    await json(sessionRoute + '/messages', write({ content: 'Record the optical standard.' }));
    const { draft } = await json<{ draft: DistilledSkillDraft }>(sessionRoute + '/distill-skill', write({ domain: 'statistics' }));
    expect(draft).toMatchObject({ name: 'optical-workflow', title: session.title, sourceSessionId: session.id, domain: 'statistics' });
    expect(draft.instructions).toContain('Record the optical standard.');
    await json('/api/skills/custom', write({ ...draft, attachToProjectId: 'missing' }), 404);
    await json('/api/skills/optical-workflow', undefined, 404);
    const { skill } = await json<{ skill: SkillMetadata }>('/api/skills/custom', write({ ...draft, attachToProjectId: project.id }), 201);
    expect(skill).toMatchObject({ name: 'optical-workflow', isCustom: true });
    await json('/api/skills/custom', write({ ...draft, attachToProjectId: project.id }), 201);
    await expect(json(projectRoute)).resolves.toMatchObject({ project: { defaultSkills: [skill.name] } });
    await expect(json('/api/skills/' + skill.name)).resolves.toMatchObject({ instructions: draft.instructions });
    await expect(json('/api/skills/custom/' + skill.name, { method: 'DELETE' })).resolves.toEqual({ deleted: true });
    await json('/api/skills/' + skill.name, undefined, 404);
    await json('/api/skills/custom/' + skill.name, { method: 'DELETE' }, 404);
    await json('/api/skills/custom/statistical-validation', { method: 'DELETE' }, 400);
    await json(projectRoute + '?deleteSessions=true', { method: 'DELETE' });
    await json('/api/projects/' + other.id, { method: 'DELETE' });
  }, 15_000);

  it('streams session-scoped Deep Research progress and downloads a dossier from both prompt routes', async () => {
    const { project } = await json<{ project: ResearchProject }>('/api/projects', write({ name: 'Deep Research API' }), 201);
    const { paper } = await json<{ paper: LiteraturePaper }>('/api/literature/import', write({
      filename: 'optical-reference.txt', content: 'The optical reference reduced instrumental drift.', projectId: project.id,
    }), 201);
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Deep Research', projectId: project.id }), 201);
    const route = '/api/sessions/' + session.id;
    const query = vi.spyOn(workbench.orchestrator.connectors, 'query').mockImplementation(async (connectorId, operation, params, options) => {
      expect(params.query).toBe('optical reference');
      expect(options?.allowLive).toBe(false);
      return {
        connectorId, operation, source: 'offline-fallback', fetchedAt: new Date().toISOString(),
        summary: 'One fixture', spilled: false, data: [{ title: 'Evidence from ' + connectorId }],
      };
    });
    const synthesis = '## Executive Synthesis\nThe optical reference reduced drift.\n\n## Evidence Matrix\n\n## Consensus vs. Contradicting Findings\nMore trials are needed.';
    providerFetch.mockImplementation(async (_input, init) => {
      const { messages, tools } = JSON.parse(String(init?.body));
      if (!tools?.length) return reply('[]');
      const system = messages[0].content;
      expect(system).toContain(paper.id);
      expect(system).toContain('Consensus vs. Contradicting Findings');
      for (const name of ['pubmed', 'openalex', 'clinicaltrials', 'arxiv-biorxiv']) expect(system).toContain('Evidence from ' + name);
      return reply(synthesis);
    });
    const controller = new AbortController();
    const stream = await fetch(url + route + '/events', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await json(route + '/messages', write({ content: 'optical reference', mode: 'bad' }), 400);
      for (const [endpoint, mode] of [['/messages', 'deep_research'], ['/deep-research', 'standard']]) {
        const run = await json<{ finalNode: SessionNode; artifacts: ScientificArtifact[]; tree: SessionTree }>(
          route + endpoint, write({ content: 'optical reference', mode }),
        );
        const dossier = run.artifacts.find(({ type }) => type === 'manuscript')!;
        expect(dossier).toMatchObject({ title: 'Deep Research Synthesis Dossier', nodeId: run.finalNode.id });
        expect(run.finalNode.artifactIds).toContain(dossier.id);
        const file = await fetch(url + route + '/artifacts/' + dossier.id + '/content');
        expect(file.status).toBe(200);
        expect(await file.text()).toContain(synthesis);
      }
      let pending = '';
      const progress: Array<Extract<WorkbenchEvent, { type: 'deep_research_progress' }>['progress']> = [];
      while (progress.filter(({ stage }) => stage === 'completed').length < 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream closed before Deep Research completed');
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop()!;
        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          const event: WorkbenchEvent = JSON.parse(frame.slice(6));
          if (event.type === 'deep_research_progress') progress.push(event.progress);
        }
      }
      expect(progress.map(({ stage }) => stage)).toEqual(
        Array.from({ length: 2 }, () => ['planning', 'retrieving', 'cross_checking', 'synthesizing', 'completed']).flat(),
      );
      expect(progress.every(({ sessionId }) => sessionId === session.id)).toBe(true);
      expect(progress.at(-1)?.sourcesReviewed).toBe(5);
      expect(query).toHaveBeenCalledTimes(8);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      query.mockRestore();
      await json('/api/literature/' + paper.id, { method: 'DELETE' });
      await json('/api/projects/' + project.id + '?deleteSessions=true', { method: 'DELETE' });
    }
  }, 18_000);

  it('returns indexed literature pages with query highlight offsets', async () => {
    const { paper } = await json<{ paper: LiteraturePaper }>('/api/literature/import', write({
      filename: 'reader.txt', content: 'Spectral calibration used a ruby reference.',
    }), 201);
    try {
      const route = '/api/literature/' + paper.id + '/page/';
      const { pageView } = await json<{ pageView: LiteraturePageView }>(route + '1?q=RUBY');
      expect(pageView).toMatchObject({ paper: { id: paper.id }, page: 1, totalPages: 1, matchedTerms: ['ruby'] });
      expect(pageView.highlightSpans).toHaveLength(1);
      const [highlight] = pageView.highlightSpans;
      expect(pageView.text.slice(highlight.start, highlight.end)).toBe('ruby');
      await expect(json(route + '1')).resolves.toMatchObject({ pageView: { highlightSpans: [], matchedTerms: [] } });
      await json(route + '2?q=ruby', undefined, 404);
      await json(route + '0', undefined, 400);
      await json('/api/literature/missing/page/1', undefined, 404);
    } finally {
      await json('/api/literature/' + paper.id, { method: 'DELETE' });
    }
  });

  it('creates a session, runs a prompt with SSE, exports provenance, and forks the session', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'QC study' }), 201);
    expect(session.workspacePath).toBe(directory);
    const { sessions } = await json<{ sessions: Session[] }>('/api/sessions');
    expect(sessions).toContainEqual(session);
    const route = '/api/sessions/' + session.id;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]);
    const response = await fetch(url + route + '/events', { signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      const initial = await reader.read();
      expect(decoder.decode(initial.value)).toBe(': connected\n\n');
      const { userNode, finalNode, artifacts, tree } = await json<{
        userNode: SessionNode; finalNode: SessionNode; artifacts: ScientificArtifact[]; tree: SessionTree;
      }>(route + '/messages', write({ content: 'Run single-cell QC on a synthetic dataset.' }));
      expect(tree.session.activeNodeId).toBe(finalNode.id);
      expect(tree.nodes).toContainEqual(userNode);

      const events: WorkbenchEvent[] = [];
      let pending = '';
      while (!events.some(({ type }) => type === 'run_completed')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended before the prompt completed');
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as WorkbenchEvent);
        }
      }
      expect(events).toContainEqual({ type: 'node_created', node: userNode });
      expect(events).toContainEqual({ type: 'run_completed', sessionId: session.id, activeNodeId: finalNode.id });
      expect(events).toContainEqual(expect.objectContaining({ type: 'thinking_delta', delta: 'Preparing the QC table.' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_output_delta', stream: 'stdout', chunk: expect.stringContaining('QC output recorded') }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'token_usage_updated', tokenUsage: expect.objectContaining({ inputTokens: 40 }) }));
      expect(tree.nodes).toContainEqual(expect.objectContaining({ role: 'coordinator', thinking: 'Preparing the QC table.' }));

      const artifact = artifacts.find(({ type }) => type === 'table');
      expect(artifact).toBeDefined();
      const artifactRoute = route + '/artifacts/' + artifact!.id;
      const manifest = await json<ProvenanceManifest>(artifactRoute + '/provenance');
      expect(manifest).toMatchObject({ artifactId: artifact!.id, sessionId: session.id, outputSha256: artifact!.sha256 });
      expect(manifest.conversationalLineage.some(({ nodeId }) => nodeId === userNode.id)).toBe(true);
      const content = await fetch(url + artifactRoute + '/content');
      expect(content.status).toBe(200);
      expect(content.headers.get('content-type')).toContain(artifact!.mimeType);
      expect(await content.text()).toContain('cell_id');
      const bundle = await json<ReproducibilityBundle>(artifactRoute + '/export', write({}));
      expect(path.dirname(bundle.exportDir)).toBe(path.join(directory, 'exports'));
      for (const file of bundle.files) await access(path.join(bundle.exportDir, file.relativePath));
      const review = await json<ReviewReport>(route + '/review', write({ nodeId: finalNode.id }));
      expect(review).toMatchObject({ sessionId: session.id, nodeId: finalNode.id });

      const fork = await json<SessionTree>(route + '/fork', write({ fromNodeId: userNode.id, title: 'QC follow-up' }), 201);
      expect(fork.session).toMatchObject({ title: 'QC follow-up', forkedFromSessionId: session.id, forkedFromNodeId: userNode.id });
      expect(fork.session.id).not.toBe(session.id);
      await json('/api/sessions/' + fork.session.id + '/artifacts/' + artifact!.id + '/content', undefined, 404);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 60_000);

  it('analyzes an uploaded CSV, exports vectors, refines the figure, compiles a manuscript, and re-verifies an auto-fix', async () => {
    const workspacePath = path.join(directory, 'dataset study');
    await mkdir(workspacePath);
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Growth results' }), 201);
    const route = '/api/sessions/' + session.id;
    await expect(json(route + '/workspace', write({ workspacePath }, 'PUT')))
      .resolves.toMatchObject({ session: { workspacePath } });
    const csv = 'sample,dose,response\na,1,2\nb,2,4\nc,3,\nd,4,8\n';
    const { file } = await json<{ file: WorkspaceFileEntry }>(route + '/files/upload', write({
      filename: 'growth.csv', content: Buffer.from(csv).toString('base64'), isBase64: true,
    }), 201);
    expect(file.relativePath).toBe('datasets/growth.csv');
    await expect(json(route + '/files?path=datasets')).resolves.toMatchObject({ workspacePath, files: [file] });
    const preview = await json<WorkspaceFilePreview>(route + '/files/preview?path=' + encodeURIComponent(file.relativePath));
    expect(preview).toMatchObject({ previewText: csv, headers: ['sample', 'dose', 'response'], format: 'csv' });
    await json(route + '/files/preview?path=..%2Foutside.csv', undefined, 400);
    await json(route + '/files/upload', write({ filename: 'growth.csv', content: csv }), 409);

    const { specialist } = await json<{ specialist: CustomSpecialist }>('/api/specialists', write({
      name: 'Dose Response Analyst', domain: 'statistics', description: 'Study dose and response',
      systemPrompt: 'Summarize descriptive results.', defaultSkills: ['statistical-validation'],
    }), 201);
    await expect(json('/api/specialists')).resolves.toMatchObject({ specialists: [specialist] });
    const { finalNode, artifacts, tree } = await json<{ finalNode: SessionNode; artifacts: ScientificArtifact[]; tree: SessionTree }>(
      route + '/messages', write({
        content: 'Profile this dataset.', attachedFiles: [file.relativePath], customSpecialistId: specialist.id,
      }),
    );
    expect(tree.reviews[0].overallStatus).toBe('pass');
    expect(tree.reviews[0].visionAuditUsed).toBe(true);
    expect(tree.nodes).toContainEqual(expect.objectContaining({ agentName: specialist.name, role: 'specialist' }));
    const table = artifacts.find(({ type }) => type === 'table')!;
    const figure = artifacts.find(({ type }) => type === 'figure')!;
    expect(figure.previewData).toMatchObject({ rows: 4, columns: 3, missing_values: 1, numeric_columns: 2 });
    expect(await readFile(table.filePath, 'utf8')).toMatch(/response,float64,3,1,/);
    const figureRoute = route + '/artifacts/' + figure.id;
    const manifest = await json<ProvenanceManifest>(figureRoute + '/provenance');
    expect(manifest.executionCode.code).toContain('os.path.join(SCIDEV_WORKSPACE_DIR, "datasets/growth.csv")');
    expect(manifest.inputHashes[file.relativePath]).toBe(preview.sha256);
    const png = await fetch(url + figureRoute + '/content');
    expect(png.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    for (const [format, mime, signature] of [['svg', 'image/svg+xml', '<svg'], ['pdf', 'application/pdf', '%PDF']]) {
      const vector = await fetch(url + figureRoute + '/vector/' + format);
      expect(vector.status).toBe(200);
      expect(vector.headers.get('content-type')).toContain(mime);
      expect(vector.headers.get('content-disposition')).toContain('attachment');
      expect(await vector.text()).toContain(signature);
    }
    const refined = await json<{ artifact: ScientificArtifact; node: SessionNode; review: ReviewReport; tree: SessionTree }>(
      figureRoute + '/refine', write({ instruction: 'Use a dark, colorblind palette with larger fonts, turn off the grid, and set the title to "Dose response" at 300 DPI.' }),
    );
    expect(refined.artifact).toMatchObject({ refinedFromArtifactId: figure.id, reviewStatus: 'pass', nodeId: refined.node.id });
    expect(refined.review.overallStatus).toBe('pass');
    expect(refined.artifact.sha256).not.toBe(figure.sha256);
    const svg = await readFile(refined.artifact.vectorExports!.svgPath!, 'utf8');
    expect(svg).toContain('Dose response');
    expect(svg).toContain('#111827');
    const refinedPng = await readFile(refined.artifact.filePath);
    const density = refinedPng.indexOf('pHYs');
    expect(density).toBeGreaterThan(0);
    expect(refinedPng.readUint32BE(density + 4)).toBeCloseTo(11_811, 0);
    await access(refined.artifact.vectorExports!.pdfPath!);

    const { manuscript, artifact } = await json<{ manuscript: ManuscriptDraft; artifact: ScientificArtifact }>(
      route + '/manuscript', write({ title: 'Growth & response_1' }),
    );
    expect(manuscript.sections.map(({ heading }) => heading))
      .toEqual(['Abstract', 'Introduction', 'Methods', 'Results', 'Discussion', 'References']);
    expect(manuscript.figureArtifactIds).toEqual(expect.arrayContaining([figure.id, refined.artifact.id]));
    expect(manuscript.markdownSource).toContain('missing values: 1');
    expect(manuscript.latexSource).toContain('\\documentclass{article}');
    expect(manuscript.latexSource).toContain('\\title{Growth \\& response\\_1}');
    expect(manuscript.latexSource).toContain('\\section{Methods}');
    expect(manuscript.latexSource).toContain('\\begin{figure}');
    expect(manuscript.latexSource).toContain('\\begin{thebibliography}');
    expect(manuscript.latexSource.trimEnd().endsWith('\\end{document}')).toBe(true);
    expect(await readFile(artifact.filePath, 'utf8')).toBe(manuscript.markdownSource);
    expect(await readFile(artifact.filePath.replace(/\.md$/, '.tex'), 'utf8')).toBe(manuscript.latexSource);
    expect(await readFile(artifact.filePath.replace(/\.md$/, '.bib'), 'utf8')).toBe(manuscript.bibtexSource);
    for (const match of manuscript.latexSource.matchAll(/\\includegraphics\[[^\]]+\]\{([^}]+)\}/g)) {
      await access(path.join(path.dirname(artifact.filePath), match[1]));
    }
    for (const [format, mimeType, filename, part] of [
      ['overleaf-zip', 'application/zip', 'Growth-response-1.zip', 'references.bib'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Growth-response-1.docx', 'word/document.xml'],
    ]) {
      const response = await fetch(url + route + '/manuscript/export', write({ format }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(mimeType);
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
      expect(bytes.includes(Buffer.from(part))).toBe(true);
      if (format === 'overleaf-zip') {
        expect(bytes.includes(Buffer.from(`figures/${manuscript.id}_figure_1.png`))).toBe(true);
        expect(bytes.includes(Buffer.from(`figures/${manuscript.id}_figure_1.pdf`))).toBe(true);
      }
    }
    await json(route + '/manuscript/export', write({ format: 'pdf' }), 400);
    await expect(json('/api/settings', write({ enableVisionAudit: false }, 'PUT')))
      .resolves.toMatchObject({ settings: { enableVisionAudit: false } });
    try {
      const settingsAudit = await json<ReviewReport>(route + '/review', write({ nodeId: finalNode.id }));
      expect(settingsAudit.visionAuditUsed).toBeUndefined();
      expect(settingsAudit.findings.some(({ category }) => category === 'visual_inspection')).toBe(false);
    } finally {
      await json('/api/settings', write({ enableVisionAudit: true }, 'PUT'));
    }

    await writeFile(figure.filePath, 'modified output');
    const audit = await json<ReviewReport>(route + '/review', write({ nodeId: finalNode.id }));
    expect(audit.overallStatus).toBe('fail');
    expect(audit.autoFixPrompt).toContain('SHA-256 integrity');
    const repaired = await json<{ userNode: SessionNode; artifacts: ScientificArtifact[]; tree: SessionTree }>(
      route + '/review/autofix', write({ reviewId: audit.id }),
    );
    expect(repaired.userNode.parentId).toBe(audit.nodeId);
    expect(repaired.tree.reviews[0].overallStatus).toBe('pass');
    expect(repaired.artifacts).toHaveLength(2);
    expect(repaired.artifacts.every(({ id }) => id !== figure.id && id !== table.id)).toBe(true);
    await expect(json('/api/specialists/' + specialist.id, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
  }, 60_000);

  it('accepts steering and stop requests and forwards delegation and cancellation events over SSE', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Live control' }), 201);
    const route = '/api/sessions/' + session.id;
    await expect(json(route + '/cancel', write({}))).resolves.toEqual({ cancelled: false });
    await expect(json(route + '/steer', write({ message: 'idle' }))).resolves.toEqual({ queued: false });
    await expect(json(route + '/steer', write({ message: '   ' }), 400)).resolves.toEqual({ error: 'Steering message is required' });
    await json('/api/settings', write({ provider: 'openai', apiKey: 'fixture-openai-key' }, 'PUT'));
    const ctl = new AbortController();
    const stream = await fetch(url + route + '/events', { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(15_000)]) });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.spyOn(workbench.orchestrator.llm, 'completeWithTools')
      .mockImplementationOnce(async () => {
        await paused;
        return { text: '', toolCalls: [{ id: 'delegated', name: 'spawn_specialist', arguments: { domain: 'statistics', task: 'Review the sample size.' } }] };
      })
      .mockResolvedValueOnce({ text: 'The sample size was documented.', toolCalls: [] })
      .mockImplementationOnce((_messages, _tools, _maxTokens, options) => {
        const signal = typeof options === 'object' ? options.signal : undefined;
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
    const run = json<{ finalNode: SessionNode; tree: SessionTree }>(route + '/messages', write({ content: 'Analyze this session.' }));
    try {
      await expect.poll(() => model.mock.calls.length).toBe(1);
      await expect(json(route + '/steer', write({ message: '  Prioritize data quality  ' }))).resolves.toEqual({ queued: true });
      release();
      await expect.poll(() => model.mock.calls.length).toBe(3);
      expect(model.mock.calls[2][0].at(-1)).toEqual({ role: 'user', content: '[Researcher mid-run steering]: Prioritize data quality' });
      await expect(json(route + '/cancel', write({}))).resolves.toEqual({ cancelled: true });
      const result = await run;
      expect(result.finalNode.content).toMatch(/^Run cancelled by researcher/);
      const events: WorkbenchEvent[] = [];
      let pending = '';
      while (!events.some(({ type }) => type === 'run_completed')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('The event stream closed before the run completed');
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as WorkbenchEvent);
        }
      }
      expect(events.map(({ type }) => type)).toEqual(expect.arrayContaining([
        'subagent_started', 'subagent_finished', 'steering_applied', 'run_cancelled', 'run_completed',
      ]));
      expect(events).toContainEqual({ type: 'run_cancelled', sessionId: session.id, reason: 'Cancelled by researcher' });
      expect(result.tree.session.activeNodeId).toBe(result.finalNode.id);
    } finally {
      release();
      workbench.orchestrator.cancelRun(session.id);
      await run.catch(() => undefined);
      model.mockRestore();
      ctl.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 20_000);

  it('replays a portable provenance manifest and reports code and output hashes', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Bundle replay' }), 201);
    const route = '/api/sessions/' + session.id + '/bundles/replay';
    const hash = (content: string) => createHash('sha256').update(content).digest('hex');
    const code = 'from pathlib import Path\n(Path(SCIDEV_OUTPUT_DIR) / "result.txt").write_bytes(b"replayed")';
    const now = new Date().toISOString();
    const manifest: ProvenanceManifest = {
      id: 'imported', artifactId: 'previous-artifact', sessionId: 'previous-session', nodeId: 'previous-node',
      executionCode: { code, codeSha256: hash(code), language: 'python', executedAt: now },
      outputSha256: hash('replayed'), inputHashes: {}, createdAt: now, conversationalLineage: [],
      plainLanguageSummary: 'Write a fixed byte sequence.',
      environmentSnapshot: { capturedAt: now, platform: process.platform, arch: process.arch, nodeVersion: process.version,
        workingDirectory: directory, packages: {}, computeTargetId: 'local-sandbox', computeTargetKind: 'local-sandbox' },
    };
    await json(route, write({ manifest: {} }), 400);
    await json(route, write({ manifest, code: ' ' }), 400);
    await json(route, write({ manifest: { ...manifest, executionCode: { ...manifest.executionCode, language: 'slurm' } } }), 422);
    const { replay, artifact, tree } = await json<{ replay: BundleReplayResult; artifact: ScientificArtifact; tree: SessionTree }>(route, write({ manifest }));
    expect(replay).toMatchObject({
      exitCode: 0, codeSha256Matched: true, outputSha256Matched: true, replayedArtifactId: artifact.id,
    });
    expect(await readFile(artifact.filePath, 'utf8')).toBe('replayed');
    expect(tree.nodes).toContainEqual(expect.objectContaining({ id: artifact.nodeId, agentName: 'Replay Verification' }));
    await json('/api/permissions/policy', write({ strictSandboxGuard: false }, 'PUT'));
    try {
      const override = 'from pathlib import Path\n(Path(SCIDEV_WORKSPACE_DIR) / "guard-check.txt").write_text("test")';
      const guarded = await json<{ replay: BundleReplayResult; artifact?: ScientificArtifact }>(route, write({ manifest, code: override }));
      expect(guarded.replay).toMatchObject({
        exitCode: 1, codeSha256Matched: false, outputSha256Matched: false, stderr: expect.stringContaining('Sandbox Guard'),
      });
      expect(guarded.artifact).toBeUndefined();
      await expect(access(path.join(directory, 'guard-check.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await json('/api/permissions/policy', write({ strictSandboxGuard: true }, 'PUT'));
    }
  }, 20_000);

  it('loads skills and queries catalogued connectors with offline fixtures', async () => {
    const { skills } = await json<{ skills: SkillMetadata[] }>('/api/skills');
    expect(skills.length).toBeGreaterThan(0);
    await expect(json('/api/skills/' + skills[0].name)).resolves.toMatchObject({ instructions: expect.any(String) });
    const { connectors } = await json<{ connectors: ConnectorInfo[] }>('/api/connectors');
    expect(connectors.some(({ id }) => id === 'pubmed')).toBe(true);
    const result = await json<ConnectorQueryResult>('/api/connectors/pubmed/query', write({
      operation: 'search', params: { query: 'single cell quality control' }, allowLive: false,
    }));
    expect(result.source).toBe('offline-fallback');
  });

  it('previews Slurm scripts and returns 403 for a denied submission', async () => {
    const { script } = await json<{ script: string }>('/api/compute/slurm/preview', write(jobSpec));
    expect(script).toContain('#SBATCH --job-name=qc_analysis');
    expect(script).toContain('#SBATCH --gres=gpu:1');
    expect(script).toContain(jobSpec.command);
    await json('/api/compute/slurm/preview', write({ ...jobSpec, cpus: 'four' }), 400);
    await json('/api/permissions/policy', write({ rules: { remote_hpc_submit: 'deny' } }, 'PUT'));
    await json('/api/compute/slurm/submit', write({ spec: jobSpec }), 403);
  });

  it('discovers and queries an external MCP tool, then removes the configuration', async () => {
    const methods: string[] = [];
    const mcp = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(method);
      if (id === undefined) { res.writeHead(202).end(); return; }
      const result = method === 'initialize' ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} } }
        : method === 'tools/list' ? { tools: [{ name: 'study_lookup', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: params.arguments.accession }], structuredContent: { accession: params.arguments.accession } };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
    await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
    try {
      await json('/api/connectors/external', write({
        id: 'fixture-mcp', name: 'Fixture MCP', transport: 'http',
        url: 'http://127.0.0.1:' + (mcp.address() as { port: number }).port, enabled: true,
      }), 201);
      const discovered = await json<{ tools: McpToolDescriptor[] }>('/api/connectors/external/fixture-mcp/discover', write({}));
      expect(discovered.tools).toEqual([{ name: 'study_lookup', inputSchema: { type: 'object' } }]);
      await expect(json('/api/connectors/fixture-mcp/query', write({
        operation: 'study_lookup', params: { accession: 'GSE131907' },
      }))).resolves.toMatchObject({ source: 'live', data: { accession: 'GSE131907' } });
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
      await expect(json('/api/connectors/external/fixture-mcp', write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
      await json('/api/connectors/fixture-mcp/query', write({ operation: 'study_lookup' }), 404);
    } finally {
      await new Promise<void>((resolve, reject) => mcp.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exposes runtime discovery and one-click Slurm polling and cancellation', async () => {
    await expect(json('/api/compute/environments')).resolves.toMatchObject({
      pythonEnvironments: expect.any(Array), rRuntime: { available: expect.any(Boolean) },
    });
    await json('/api/permissions/policy', write({ rules: { remote_hpc_submit: 'allow' } }, 'PUT'));
    await json('/api/compute/targets', write({
      id: 'test-slurm', name: 'Test Slurm', kind: 'hpc-slurm', status: 'simulated', description: 'Fixture',
      identityFile: '~/.ssh/lab_key', jumpHost: 'lab-gateway', remoteWorkDir: '/scratch/lab',
    }), 201);
    await expect(json('/api/compute/targets')).resolves.toMatchObject({ targets: expect.arrayContaining([
      expect.objectContaining({ id: 'test-slurm', identityFile: '~/.ssh/lab_key', jumpHost: 'lab-gateway', remoteWorkDir: '/scratch/lab' }),
    ]) });
    await expect(json('/api/compute/targets/test-slurm/test', write({}))).resolves
      .toMatchObject({ targetId: 'test-slurm', mode: 'simulated', ok: true });
    await json('/api/compute/targets/missing/test', write({}), 404);
    const { job } = await json<{ job: SlurmJobRecord }>('/api/compute/slurm/submit', write({
      spec: { ...jobSpec, targetId: 'test-slurm' },
    }));
    const route = '/api/compute/slurm/jobs/' + job.id;
    await expect(json(route + '/poll', write({}))).resolves.toMatchObject({ job: { id: job.id, mode: 'simulated' } });
    await expect(json(route + '/cancel', write({}))).resolves.toMatchObject({ job: { id: job.id, status: 'cancelled' } });
    await json('/api/compute/slurm/jobs/missing/sync', write({}), 404);
    const workspacePath = path.join(directory, 'slurm workspace');
    await mkdir(workspacePath);
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Slurm sync', workspacePath }), 201);
    for (const [body, root] of [[{}, directory], [{ sessionId: session.id }, workspacePath]] as const) {
      const { job: synced, syncedFiles } = await json<{ job: SlurmJobRecord; syncedFiles: string[] }>(route + '/sync', write(body));
      expect(synced.id).toBe(job.id);
      expect(syncedFiles).toHaveLength(2);
      expect(synced.syncedFiles).toEqual(syncedFiles);
      for (const file of syncedFiles) {
        expect(path.dirname(file)).toBe(path.join(root, 'slurm_outputs', job.id));
        await access(file);
      }
    }
    await expect(json('/api/compute/targets/test-slurm', write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
  });

  it('reports environment diagnostics and honors sandbox and package installation policy', async () => {
    const policyRoute = '/api/permissions/policy';
    await expect(json(policyRoute, write({ strictSandboxGuard: false, rules: { package_install: 'deny' } }, 'PUT')))
      .resolves.toMatchObject({ policy: { strictSandboxGuard: false, rules: { package_install: 'deny' } } });
    await json(policyRoute, write({ strictSandboxGuard: 'false' }, 'PUT'), 400);
    await expect(json('/api/compute/doctor')).resolves.toMatchObject({
      python: { available: expect.any(Boolean), executable: expect.any(String) },
      r: { available: expect.any(Boolean) }, sandboxGuardSupported: expect.any(Boolean),
      packages: expect.arrayContaining([expect.objectContaining({ name: 'numpy', installed: expect.any(Boolean) })]),
    });
    const installRoute = '/api/compute/doctor/install';
    await json(installRoute, write({ packages: [] }), 400);
    await json(installRoute, write({ packages: ['bad path'] }), 400);
    await expect(json(installRoute, write({ packages: ['numpy'] }), 403))
      .resolves.toMatchObject({ error: expect.stringContaining('Permission denied for package_install') });
    await json(policyRoute, write({ strictSandboxGuard: true, rules: { package_install: 'ask' } }, 'PUT'));
  }, 15_000);

  it('serves all model presets, tests and discovers models, and returns a clean 412 or 502', async () => {
    const presets = await json<{ presets: Array<{ id: string }> }>('/api/models/presets');
    expect(new Set(presets.presets.map(({ id }) => id)).size).toBe(15);
    await expect(json('/api/models/test', write({ provider: 'openai', model: 'fixture-model' })))
      .resolves.toMatchObject({ ok: true, model: 'fixture-model', replyPreview: 'OK', latencyMs: expect.any(Number) });
    expect(providerFetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-openai-key' });
    await expect(json('/api/models/discover', write({ provider: 'openai' })))
      .resolves.toMatchObject({ models: [{ id: 'fixture-model' }] });
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Model preconditions' }), 201);
    const route = '/api/sessions/' + session.id;
    const payload = write({ content: 'Analyze this session.' });
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    try {
      await json('/api/settings', write({ provider: 'anthropic' }, 'PUT'));
      await expect(json(route + '/messages', payload, 412))
        .resolves.toMatchObject({ error: expect.stringContaining('No frontier AI model is configured.') });
      await expect(json(route)).resolves.toMatchObject({ nodes: [] });
    } finally {
      vi.unstubAllEnvs();
      await json('/api/settings', write({ provider: 'openai' }, 'PUT'));
    }
    providerFetch.mockResolvedValueOnce(new Response('Provider is busy', { status: 503 }));
    await expect(json(route + '/messages', payload, 502)).resolves.toMatchObject({ error: expect.stringContaining('HTTP 503') });
    await json('/api/settings', write({ routing: { reviewer: { provider: 'missing', model: 'fixture' } } }, 'PUT'), 400);
    await json('/api/settings', write({ memoryLimitMb: 1.5 }, 'PUT'), 400);
  });

  it('renames, pins, searches, compacts and deletes a session while retaining token totals', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Calibration notebook' }), 201);
    const route = '/api/sessions/' + session.id;
    await expect(json(route, write({ title: 'Calibration renamed', pinned: true }, 'PATCH')))
      .resolves.toMatchObject({ session: { title: 'Calibration renamed', pinned: true } });
    await expect(json('/api/sessions/search?q=Calibration%20renamed'))
      .resolves.toMatchObject({ results: [{ sessionId: session.id, matchKind: 'title' }] });
    const turn = await json<{ tree: SessionTree }>(route + '/messages', write({ content: 'Record the unique calibration objective.' }));
    expect(turn.tree.session.tokenUsage).toMatchObject({
      inputTokens: expect.any(Number), outputTokens: expect.any(Number), cachedTokens: expect.any(Number), contextWindowLimit: 400000,
    });
    expect(turn.tree.session.tokenUsage!.inputTokens).toBeGreaterThanOrEqual(40);
    const result = await json<{ session: Session; summary: string; compactedNodeCount: number; tree: SessionTree }>(
      route + '/compact', write({}));
    expect(result.summary).toContain('The calibration objective was recorded.');
    expect(result.compactedNodeCount).toBe(turn.tree.nodes.length);
    expect(result.session.compactedUpToNodeId).toBe(turn.tree.session.activeNodeId);
    expect(result.tree.session.tokenUsage!.inputTokens).toBeGreaterThan(turn.tree.session.tokenUsage!.inputTokens);
    expect(result.tree.nodes).toEqual(turn.tree.nodes);
    providerFetch.mockClear();
    await json(route + '/messages', write({ content: 'What comes next?' }));
    const coordinator = String(providerFetch.mock.calls[0][1]?.body);
    expect(coordinator).toContain('Summary of earlier conversation');
    expect(coordinator).not.toContain('Record the unique calibration objective.');
    await expect(json(route, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
    await expect(json(route, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: false });
    await json(route, undefined, 404);
  }, 20_000);

  it('runs interactive code with Plotly, Matplotlib, snapshots, provenance and persistent variables', async () => {
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Interactive code' }), 201);
    const route = '/api/sessions/' + session.id;
    const code = [
      'import sys',
      'import matplotlib.pyplot as plt',
      'import plotly.graph_objects as go',
      'from pathlib import Path',
      'experiment_values = [1, 3, 5]',
      'plt.plot(experiment_values)',
      'SCIDEV_PLOTLY_CHARTS = [go.Figure(data=[go.Scatter(y=experiment_values)])]',
      'Path(SCIDEV_OUTPUT_DIR, "run.csv").write_text("value\\n1\\n3\\n5\\n", encoding="utf-8")',
      'print("cell printed")',
      'print("cell diagnostic", file=sys.stderr)',
    ].join('\n');
    const result = await json<{
      exitCode: number; stdout: string; stderr: string; durationMs: number;
      artifacts: ScientificArtifact[]; review?: ReviewReport; tree: SessionTree;
    }>(route + '/cells/run', write({ language: 'python', code, title: 'Interactive trace' }));
    expect(result).toMatchObject({
      exitCode: 0, stdout: expect.stringContaining('cell printed'), stderr: expect.stringContaining('cell diagnostic'),
      review: { artifactIds: expect.any(Array) }, durationMs: expect.any(Number),
    });
    expect(result.artifacts.map(({ type }) => type).sort()).toEqual(['figure', 'interactive_chart', 'table']);
    const chart = result.artifacts.find(({ type }) => type === 'interactive_chart')!;
    const artifactRoute = route + '/artifacts/' + chart.id;
    expect(chart.mimeType).toBe('application/json');
    await expect(json(artifactRoute + '/content')).resolves.toMatchObject({ data: [{ type: 'scatter', y: [1, 3, 5] }] });
    await expect(json(artifactRoute + '/provenance')).resolves.toMatchObject({
      executionCode: { editedByResearcher: true, code },
    });
    const { snapshots } = await json<{ snapshots: ArtifactSnapshotRecord[] }>(route + '/snapshots');
    expect(snapshots).toHaveLength(3);
    await expect(json(route + '/snapshots?artifactId=' + chart.id)).resolves.toMatchObject({
      snapshots: [{ artifactId: chart.id, sha256: chart.sha256, code }],
    });
    const variables = route + '/kernel/variables';
    await expect(json(variables)).resolves.toMatchObject({
      python: expect.arrayContaining([expect.objectContaining({ name: 'experiment_values' })]), r: [],
    });
    await expect(json(route + '/kernel/reset', write({ language: 'all' }))).resolves.toEqual({ reset: true });
    await expect(json(variables)).resolves.toEqual({ python: [], r: [] });
  }, 30_000);

  it('uses the Docker worker with target overrides when a session selects a container', async () => {
    const target = {
      id: 'docker-fixture', name: 'Docker fixture', kind: 'container-docker', status: 'configured',
      description: 'Container test', dockerImage: 'science:fixture', memoryLimitMb: 1024, cpuLimit: 1.5, allowContainerNetwork: false,
    };
    await expect(json('/api/compute/targets', write(target), 201)).resolves.toEqual({ target });
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Docker session', computeTargetId: target.id }), 201);
    const docker = vi.spyOn(workbench.orchestrator.dockerWorker, 'execute')
      .mockImplementationOnce(async (_code, _directory, options) => {
        options?.onOutput?.('stdout', 'container output');
        return { exitCode: 0, stdout: 'container output', stderr: '', durationMs: 5, figures: [], createdFiles: [], metrics: null };
      });
    try {
      await expect(json('/api/sessions/' + session.id + '/cells/run', write({ language: 'python', code: 'print("container output")' })))
        .resolves.toMatchObject({ exitCode: 0, stdout: 'container output' });
      expect(docker).toHaveBeenCalledExactlyOnceWith('print("container output")', expect.any(String), expect.objectContaining({
        workspaceDir: directory, image: target.dockerImage, memoryLimitMb: 1024, cpuLimit: 1.5, allowNetwork: false,
      }));
    } finally {
      docker.mockRestore();
    }
  });

  it('indexes an uploaded PDF and exposes library and memory tools to the coordinator', async () => {
    const { item } = await json<{ item: ResearchMemoryItem }>('/api/memory', write({
      title: 'Spectral convention', content: 'Report absorbance with the instrument ID.', category: 'convention', scope: 'global', tags: ['absorbance'],
    }), 201);
    await expect(json('/api/memory?scope=global&category=convention')).resolves.toEqual({ items: [item] });
    const { paper } = await json<{ paper: LiteraturePaper }>('/api/literature/import', write({
      filename: 'calibration.pdf', isBase64: true, content: fixturePdf('Spectral calibration used a ruby reference.').toString('base64'),
      title: 'Spectral trial', authors: ['A Researcher'], year: 2025,
    }), 201);
    expect(paper).toMatchObject({ title: 'Spectral trial', pageCount: 1, chunkCount: 1, sha256: expect.any(String) });
    await expect(json('/api/literature')).resolves.toMatchObject({ papers: [{ id: paper.id }] });
    await expect(json('/api/literature/search?q=ruby')).resolves.toMatchObject({
      passages: [{ paperId: paper.id, page: 1, text: expect.stringContaining('ruby reference') }],
    });
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Memory-backed research' }), 201);
    providerFetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.messages[0].content).toContain('Spectral convention');
      return reply('', [
        ['save_memory', { category: 'finding', title: 'Spectral reference', content: 'A ruby reference was used.', tags: ['spectra'] }],
        ['search_memory', { query: 'ruby' }],
        ['search_local_papers', { query: 'ruby', limit: 2 }],
        ['read_paper_passage', { paperId: paper.id, page: 1 }],
      ]);
    }).mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const tools = request.messages.filter(({ role }: { role: string }) => role === 'tool');
      expect(tools).toHaveLength(4);
      expect(tools[1].content).toContain('A ruby reference was used.');
      expect(tools[2].content).toContain(paper.id);
      expect(tools[3].content).toContain('ruby reference');
      return reply('Recorded the calibration reference from page 1.');
    });
    await json('/api/sessions/' + session.id + '/messages', write({ content: 'Find and remember the calibration reference.' }));
    await expect(json('/api/memory?scope=workspace&workspacePath=' + encodeURIComponent(directory))).resolves.toMatchObject({
      items: [{ title: 'Spectral reference', sourceSessionId: session.id, workspacePath: directory }],
    });
    await expect(json('/api/memory/' + item.id, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
    await expect(json('/api/literature/' + paper.id, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
    await expect(json('/api/literature/search?q=ruby')).resolves.toEqual({ passages: [] });
  }, 20_000);

  it('stores and clears PubMed credentials through the encrypted connector resolver', async () => {
    const route = '/api/connectors/pubmed/credential';
    const credential = 'pubmed-test-credential-72d97a';
    await expect(json(route, write({ apiKey: credential }, 'PUT'))).resolves.toEqual({ connectorId: 'pubmed', hasCredential: true });
    await expect(json('/api/connectors')).resolves.toMatchObject({ connectors: expect.arrayContaining([
      expect.objectContaining({ id: 'pubmed', hasCredential: true }),
    ]) });
    expect(workbench.orchestrator.provenance.getSecret('connector_cred:pubmed')).toBe(credential);
    for (const filename of ['scideveloper.sqlite', 'scideveloper.sqlite-wal']) {
      const bytes = await readFile(path.join(directory, filename)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return Buffer.alloc(0);
      });
      expect(bytes.includes(Buffer.from(credential))).toBe(false);
    }
    await expect(json(route, write({ apiKey: '' }, 'PUT'))).resolves.toEqual({ connectorId: 'pubmed', hasCredential: false });
  });

  it('manages projects and returns their sessions, memories, papers, and recent artifacts', async () => {
    const workspacePath = path.join(directory, 'project-workspace');
    await mkdir(workspacePath);
    const { project: projectA } = await json<{ project: ResearchProject }>('/api/projects', write({
      name: ' Project A ', description: 'A calibration project', instructions: 'Use SI units.',
      workspacePath: 'project-workspace', defaultComputeTargetId: 'docker-sandbox', defaultSkills: ['statistical-validation'],
      color: '#4e7256', pinned: true,
    }), 201);
    const { project: projectB } = await json<{ project: ResearchProject }>('/api/projects', write({ name: 'Project B' }), 201);
    const routeA = '/api/projects/' + projectA.id;
    const routeB = '/api/projects/' + projectB.id;
    expect(projectA).toMatchObject({ name: 'Project A', workspacePath, defaultComputeTargetId: 'docker-sandbox', pinned: true });
    expect(projectB).toMatchObject({ workspacePath: directory, defaultComputeTargetId: 'local-sandbox' });
    expect(workbench.orchestrator.permissions.getPolicy().allowedWorkspaceRoots).toContain(workspacePath);
    await expect(json(routeA)).resolves.toEqual({ project: projectA });
    await expect(json('/api/projects')).resolves.toEqual({ projects: [projectA, projectB] });
    await expect(json(routeB, write({ name: 'Project B archive', archived: true }, 'PATCH'))).resolves.toMatchObject({
      project: { name: 'Project B archive', archived: true },
    });
    await expect(json('/api/projects')).resolves.toEqual({ projects: [projectA] });
    await expect(json('/api/projects?includeArchived=true')).resolves.toMatchObject({ projects: [projectA, { id: projectB.id }] });
    await expect(json(routeB, write({ name: 'Project B', archived: false, workspacePath: 'project-workspace' }, 'PATCH')))
      .resolves.toMatchObject({ project: { workspacePath, archived: false } });
    await json('/api/projects', write({ name: '   ' }), 400);
    await json(routeA, write({ name: '   ' }, 'PATCH'), 400);
    await expect(json(routeA, write({ workspacePath: 'missing-directory' }, 'PATCH'), 400))
      .resolves.toEqual({ error: 'Workspace path must be an existing directory' });
    await json('/api/projects', write({ name: 'Invalid path', workspacePath: 'project\0workspace' }), 400);
    await json('/api/projects', write({ name: 'Invalid compute target', defaultComputeTargetId: 'missing' }), 404);

    await json('/api/sessions', write({ title: 'Missing project', projectId: 'missing' }), 404);
    const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Project flow calibration', projectId: projectA.id }), 201);
    expect(session).toMatchObject({ projectId: projectA.id, workspacePath, computeTargetId: 'docker-sandbox' });
    const { session: override } = await json<{ session: Session }>('/api/sessions', write({
      title: 'Project flow override', projectId: projectB.id, workspacePath: '.', computeTargetId: 'lab-hpc-slurm',
    }), 201);
    expect(override).toMatchObject({ projectId: projectB.id, workspacePath: directory, computeTargetId: 'lab-hpc-slurm' });
    const { session: unassigned } = await json<{ session: Session }>('/api/sessions', write({ title: 'Unassigned', projectId: null }), 201);
    await expect(json('/api/sessions?projectId=unassigned')).resolves.toMatchObject({ sessions: expect.arrayContaining([unassigned]) });
    await expect(json('/api/sessions?projectId=' + projectA.id)).resolves.toEqual({ sessions: [session] });
    await expect(json('/api/sessions/search?q=Project+flow&projectId=' + projectA.id)).resolves.toEqual({
      results: [expect.objectContaining({ sessionId: session.id })],
    });

    const memory = { scope: 'project', projectId: projectA.id, category: 'finding', title: 'Titanium standard', content: 'Titanium baseline was stable.', tags: ['titanium'], sourceSessionId: session.id };
    const { item } = await json<{ item: ResearchMemoryItem }>('/api/memory', write(memory), 201);
    const upload = { filename: 'titanium.txt', content: 'Titanium is a calibration standard.', projectId: projectA.id };
    const { paper } = await json<{ paper: LiteraturePaper }>('/api/literature/import', write(upload), 201);
    await json('/api/memory', write({ ...memory, projectId: null }), 400);
    await json('/api/literature/import', write({ ...upload, projectId: 'missing' }), 404);
    await expect(json('/api/memory?scope=project&projectId=' + projectA.id)).resolves.toEqual({ items: [item] });
    await expect(json('/api/memory?scope=project&projectId=' + projectB.id)).resolves.toEqual({ items: [] });
    await expect(json('/api/literature?projectId=' + projectA.id)).resolves.toEqual({ papers: [paper] });
    await expect(json('/api/literature?projectId=' + projectB.id)).resolves.toEqual({ papers: [] });
    await expect(json('/api/literature/search?q=titanium&projectId=' + projectA.id)).resolves.toMatchObject({ passages: [{ paperId: paper.id }] });
    await expect(json('/api/literature/search?q=titanium&projectId=' + projectB.id)).resolves.toEqual({ passages: [] });

    const sessionRoute = '/api/sessions/' + session.id;
    const { userNode } = await json<{ userNode: SessionNode }>(sessionRoute + '/messages', write({ content: 'Record the titanium baseline.' }));
    const docker = vi.spyOn(workbench.orchestrator.dockerWorker, 'execute').mockImplementationOnce(async (_code, outputDir) => {
      const file = path.join(outputDir, 'titanium.csv');
      await mkdir(outputDir, { recursive: true });
      await writeFile(file, 'sample,reading\nstandard,1\n');
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 5, figures: [], createdFiles: [file], metrics: null };
    });
    let artifact: ScientificArtifact;
    try {
      const { artifacts } = await json<{ artifacts: ScientificArtifact[] }>(sessionRoute + '/cells/run', write({
        language: 'python', code: 'print("Titanium calibration")',
      }));
      expect(artifacts).toHaveLength(1);
      [artifact] = artifacts;
    } finally {
      docker.mockRestore();
    }
    const overview = await json<ProjectOverview>(routeA + '/overview');
    expect(overview).toMatchObject({
      project: { id: projectA.id, sessionCount: 1, memoryCount: 1, paperCount: 1, artifactCount: 1 },
      sessions: [{ id: session.id }], memories: expect.arrayContaining([item]),
      papers: expect.arrayContaining([paper]), recentArtifacts: [artifact],
    });
    const overviewB = await json<ProjectOverview>(routeB + '/overview');
    expect(overviewB.memories).not.toContainEqual(item);
    expect(overviewB.papers).not.toContainEqual(paper);
    expect(overviewB.recentArtifacts).toEqual([]);

    await json(sessionRoute, write({ projectId: 'missing' }, 'PATCH'), 404);
    await expect(json(sessionRoute, write({ projectId: projectB.id, title: 'Moved calibration', pinned: true }, 'PATCH')))
      .resolves.toMatchObject({ session: { projectId: projectB.id, title: 'Moved calibration', pinned: true } });
    await expect(json(routeA + '/overview')).resolves.toMatchObject({ sessions: [], recentArtifacts: [] });
    await expect(json(routeB + '/overview')).resolves.toMatchObject({ recentArtifacts: [artifact] });
    const fork = await json<SessionTree>(sessionRoute + '/fork', write({ fromNodeId: userNode.id }), 201);
    expect(fork.session).toMatchObject({ projectId: projectB.id, forkedFromSessionId: session.id });
    await expect(json('/api/sessions/' + override.id, write({ projectId: null }, 'PATCH'))).resolves.toMatchObject({ session: { projectId: null } });

    await expect(json(routeB, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
    await expect(json(sessionRoute)).resolves.toMatchObject({ session: { projectId: null }, artifacts: [artifact] });
    await expect(json('/api/sessions/' + fork.session.id)).resolves.toMatchObject({ session: { projectId: null } });
    await expect(json(routeB + '/overview', undefined, 404)).resolves.toEqual({ error: 'Project not found' });
    await json(routeB, undefined, 404);
    await json(routeB, write({ pinned: true }, 'PATCH'), 404);
    await expect(json(routeB, write(undefined, 'DELETE'))).resolves.toEqual({ deleted: false });
    await json(sessionRoute, write({ projectId: projectA.id }, 'PATCH'));
    await expect(json(routeA + '?deleteSessions=true', write(undefined, 'DELETE'))).resolves.toEqual({ deleted: true });
    await json(sessionRoute, undefined, 404);
    await expect(json('/api/literature/search?q=titanium')).resolves.toEqual({ passages: [] });
  }, 20_000);

  it('broadcasts project updates and deletion to multiple session streams', async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
    try {
      const readers = await Promise.all([1, 2].map(async () => {
        const { session } = await json<{ session: Session }>('/api/sessions', write({ title: 'Project event listener' }), 201);
        const response = await fetch(url + '/api/sessions/' + session.id + '/events', { signal });
        return response.body!.getReader();
      }));
      const { project } = await json<{ project: ResearchProject }>('/api/projects', write({ name: 'SSE project' }), 201);
      const route = '/api/projects/' + project.id;
      const { project: renamed } = await json<{ project: ResearchProject }>(route, write({ name: 'Renamed SSE project' }, 'PATCH'));
      await json(route, write(undefined, 'DELETE'));

      await Promise.all(readers.map(async (reader) => {
        const decoder = new TextDecoder();
        const events: WorkbenchEvent[] = [];
        let pending = '';
        while (!events.some(({ type }) => type === 'project_deleted')) {
          const { value, done } = await reader.read();
          if (done) throw new Error('SSE stream ended before the project deletion');
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split('\n\n');
          pending = frames.pop() ?? '';
          for (const frame of frames) {
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as WorkbenchEvent);
          }
        }
        expect(events).toEqual([
          { type: 'project_updated', project }, { type: 'project_updated', project: renamed }, { type: 'project_deleted', projectId: project.id },
        ]);
      }));
    } finally {
      controller.abort();
    }
  }, 10_000);
});
