import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ComputeTarget, ExternalMcpServerConfig, SlurmJobSpec, WorkbenchEvent } from '@scideveloper/shared';
import { ProvenanceStore } from '@scideveloper/provenance';
import { SciDeveloperOrchestrator } from './index.js';
import { datasetAnalysisScript } from './research-scripts.js';

const skillsDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), 'skills');

function createWorkbench() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-researcher-'));
  const options = { dataDir: path.join(directory, 'data'), skillsDir, workspaceRoot: directory, allowLiveConnectors: false };
  return {
    directory, options,
    clean: () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

function openAiReply(content: string, calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return Response.json({ choices: [{ message: {
    content, tool_calls: calls?.map(({ id, name, arguments: args }) => ({
      id, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })),
  } }] });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const notebookPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT9sAAAAASUVORK5CYII=';

describe('v0.5 research workflows', () => {
  it('assembles notebook turns and provenance, exports PNGs, and imports Jupyter outputs', () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    try {
      const session = workbench.provenance.createSession({ title: 'Notebook QC', workspacePath: temp.directory });
      const user = workbench.provenance.appendNode({
        sessionId: session.id, parentId: null, role: 'user', agentName: 'Researcher', content: 'Check the sample.',
      });
      const tool = workbench.provenance.appendNode({
        sessionId: session.id, parentId: user.id, role: 'tool', agentName: 'run_python', content: 'Sample QC',
      });
      const figurePath = path.join(temp.directory, 'plot.png');
      const tablePath = path.join(temp.directory, 'data.csv');
      fs.writeFileSync(figurePath, Buffer.from(notebookPng, 'base64'));
      fs.writeFileSync(tablePath, 'sample,value\nA,2\n');
      const code = 'print("sample 2")';
      const artifactIds = ([
        ['figure', 'image/png', figurePath], ['table', 'text/csv', tablePath],
      ] as const).map(([type, mimeType, filePath]) => workbench.provenance.recordArtifactWithProvenance({
        sessionId: session.id, nodeId: tool.id, type, mimeType, filePath, title: 'Sample QC', description: 'Calibration output',
        executionCode: {
          language: 'python', code, executedAt: tool.createdAt, exitCode: 0, durationMs: 42,
          stdout: 'sample 2\n', stderr: 'diagnostic\n',
        },
        environmentSnapshot: {
          capturedAt: tool.createdAt, platform: process.platform, arch: process.arch, nodeVersion: process.version,
          computeTargetId: 'local-sandbox', computeTargetKind: 'local-sandbox', packages: {}, workingDirectory: temp.directory,
        },
        inputHashes: {}, plainLanguageSummary: 'Run sample calibration.',
      }).artifact.id);
      const synthesis = workbench.provenance.appendNode({
        sessionId: session.id, parentId: tool.id,
        role: 'coordinator', agentName: 'Coordinator', content: 'Sample QC completed.',
      });
      const assembled = workbench.getSessionNotebook(session.id);
      expect(assembled.cells).toEqual([
        expect.objectContaining({ kind: 'markdown', sourceNodeId: user.id, source: user.content }),
        expect.objectContaining({
          kind: 'code', language: 'python', source: code, sourceArtifactId: expect.any(String),
          output: expect.objectContaining({
            stdout: expect.stringContaining('sample 2'), stderr: expect.stringContaining('diagnostic'),
            exitCode: 0, durationMs: expect.any(Number),
            artifactIds: expect.arrayContaining(artifactIds),
          }),
        }),
        expect.objectContaining({ kind: 'markdown', sourceNodeId: synthesis.id, source: synthesis.content }),
      ]);
      expect(workbench.provenance.getSessionNotebook(session.id)).toBeUndefined();
      const exported = workbench.exportSessionNotebookIpynb(session.id);
      expect(exported.filename).toBe('notebook-qc.ipynb');
      expect(JSON.parse(exported.content)).toMatchObject({
        nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', language: 'python' } },
        cells: [
          { cell_type: 'markdown', id: expect.any(String) },
          { cell_type: 'code', execution_count: 1, outputs: [
            { output_type: 'stream', name: 'stdout', text: expect.stringContaining('sample 2') },
            { output_type: 'stream', name: 'stderr', text: expect.stringContaining('diagnostic') },
            { output_type: 'display_data', data: { 'image/png': notebookPng }, metadata: {} },
          ] },
          { cell_type: 'markdown', id: expect.any(String) },
        ],
      });
      const input = {
        nbformat: 4, nbformat_minor: 4, metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' } },
        cells: [
          { cell_type: 'markdown', metadata: {}, source: ['# Results\n', 'Review the calibration.'] },
          { cell_type: 'code', metadata: {}, source: 'print(2)', execution_count: 7, outputs: [
            { output_type: 'stream', name: 'stdout', text: ['[1] ', '2\n'] },
            { output_type: 'stream', name: 'stderr', text: 'R warning\n' },
            { output_type: 'display_data', data: { 'image/png': [notebookPng.slice(0, 30), notebookPng.slice(30)] }, metadata: {} },
          ] },
          { cell_type: 'code', metadata: { language: 'python' }, source: ['print(', '2)'], execution_count: null, outputs: [] },
        ],
      };
      const { notebook, importedCells } = workbench.importSessionNotebook(session.id, {
        filename: 'Rounded results.ipynb', isBase64: true, content: Buffer.from(JSON.stringify(input)).toString('base64'),
      });
      expect(importedCells).toBe(3);
      expect(notebook).toMatchObject({ title: 'Rounded results', cells: [
        { language: 'markdown', source: '# Results\nReview the calibration.' },
        { language: 'r', executionCount: 7, output: {
          stdout: '[1] 2\n', stderr: 'R warning\n', imagesBase64: [{ mimeType: 'image/png', data: notebookPng }],
        } },
        { language: 'python', source: 'print(2)', executionCount: null },
      ] });
      const roundTrip = JSON.parse(workbench.exportSessionNotebookIpynb(session.id).content);
      expect(roundTrip.metadata.kernelspec).toMatchObject({ name: 'ir', language: 'r' });
      expect(roundTrip.cells[1].outputs[2].data['image/png']).toBe(notebookPng);
      expect(new Set(roundTrip.cells.map(({ id }: { id: string }) => id)).size).toBe(3);
      for (const content of ['{', '{}', JSON.stringify({ ...input, cells: [{ cell_type: 'code', source: 17 }] })]) {
        expect(() => workbench.importSessionNotebook(session.id, { filename: 'invalid.ipynb', content })).toThrow('Invalid Jupyter notebook');
      }
      expect(workbench.getSessionNotebook(session.id)).toEqual(notebook);
      expect(events.filter(({ type }) => type === 'notebook_updated')).toEqual([{ type: 'notebook_updated', sessionId: session.id, cellCount: 3 }]);
    } finally {
      workbench.dispose();
      temp.clean();
    }
  });

  it('runs notebook cells in the same kernel and persists results through the first failure', async () => {
    const temp = createWorkbench();
    const workbench = new SciDeveloperOrchestrator(temp.options);
    try {
      const session = workbench.provenance.createSession({ title: 'Kernel state', workspacePath: temp.directory });
      const notebook = workbench.saveSessionNotebook(session.id, {
        title: '  Kernel state  ',
        cells: [
          { id: 'note', kind: 'markdown', language: 'markdown', source: '## Plan' },
          { id: 'set', kind: 'code', language: 'python', source: 'count = 4' },
          { id: 'failure', kind: 'code', language: 'python', source: 'print(count)\nraise ValueError("stop here")' },
          { id: 'unreached', kind: 'code', language: 'python', source: 'unreached = True' },
        ],
      });
      expect(notebook.title).toBe('Kernel state');
      await expect(workbench.runNotebookCell(session.id, 'unknown')).rejects.toMatchObject({ status: 404 });
      await expect(workbench.runNotebookCell(session.id, 'note')).rejects.toMatchObject({ status: 400 });
      const running = workbench.runNotebookCell(session.id, 'set', { source: 'count = 9\nprint(count)' });
      expect(() => workbench.saveSessionNotebook(session.id, { cells: [] })).toThrow('already active');
      await expect(running).resolves.toMatchObject({
        cell: { id: 'set', executionCount: 1, editedByResearcher: true, output: { exitCode: 0, stdout: expect.stringContaining('9') } },
      });
      const result = await workbench.runAllNotebookCells(session.id);
      expect(result.failedCellId).toBe('failure');
      expect(result.notebook.cells.slice(1)).toMatchObject([
        { id: 'set', executionCount: 2, output: { exitCode: 0 } },
        { id: 'failure', executionCount: 3, output: { exitCode: 1, stdout: expect.stringContaining('9'), stderr: expect.stringContaining('stop here') } },
        { id: 'unreached', executionCount: null },
      ]);
      expect(workbench.getSessionNotebook(session.id)).toEqual(result.notebook);
      expect(result.tree.nodes.filter(({ role }) => role === 'tool')).toHaveLength(3);
    } finally {
      workbench.dispose();
      temp.clean();
    }
  }, 30_000);

  it('distills recorded goals, verified code, statistical checks, skills, and connectors with safe refinement fallback', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    let workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    try {
      workbench.updateSettings({ provider: 'openai', apiKey: '' });
      const project = workbench.createProject({ name: 'Assay analysis' });
      const session = workbench.provenance.createSession({ title: 'Calibration workflow', workspacePath: temp.directory, projectId: project.id });
      const user = workbench.provenance.appendNode({
        sessionId: session.id, parentId: null, role: 'user', agentName: 'Researcher', content: 'Quantify the reference sample.',
      });
      const node = workbench.provenance.appendNode({
        sessionId: session.id, parentId: user.id, role: 'tool', agentName: 'query_connector', content: 'Trial records retrieved',
        metadata: { arguments: { connectorId: 'clinicaltrials' } },
      });
      const filePath = path.join(temp.directory, 'result.csv');
      fs.writeFileSync(filePath, 'sample,value\nref,2\n');
      const { artifact } = workbench.provenance.recordArtifactWithProvenance({
        sessionId: session.id, nodeId: node.id, type: 'table', title: 'Calibration table', description: 'Reference result',
        mimeType: 'text/csv', filePath,
        executionCode: { language: 'r', code: 'mean(c(1, 3))', exitCode: 0, executedAt: node.createdAt },
        environmentSnapshot: {
          capturedAt: node.createdAt, platform: process.platform, arch: process.arch, nodeVersion: process.version,
          computeTargetId: 'local-sandbox', computeTargetKind: 'local-sandbox', packages: {}, workingDirectory: temp.directory,
        },
        inputHashes: {}, plainLanguageSummary: 'Calculate the mean of the calibrated reference values.',
      });
      workbench.provenance.recordReviewReport({
        id: 'calibration-review', sessionId: session.id, nodeId: node.id, artifactIds: [artifact.id],
        overallStatus: 'warn', score: 80, summary: 'Check repeatability', verifiedCitations: [], createdAt: node.createdAt,
        findings: [{ id: 'replicates', category: 'statistical_rigor', severity: 'warn', title: 'Replicates', detail: 'Record sample counts.' }],
      });
      workbench.provenance.markSkillLoaded(session.id, 'statistical-validation');
      const draft = await workbench.distillSessionSkill(session.id);
      expect(draft).toMatchObject({
        name: 'calibration-workflow', title: session.title, sourceSessionId: session.id, recommendedConnectors: ['clinicaltrials'],
      });
      for (const text of [user.content, 'mean(c(1, 3))', 'Record sample counts.', 'statistical-validation']) {
        expect(draft.instructions).toContain(text);
      }
      workbench.updateSettings({ apiKey: 'fixture-key' });
      const completion = vi.spyOn(workbench.llm, 'complete').mockResolvedValueOnce('{ malformed')
        .mockResolvedValueOnce('{"description":"Reusable assay QC","tags":["assay"],"guidance":"Verify the reference batch."}');
      await expect(workbench.distillSessionSkill(session.id)).resolves.toEqual(draft);
      const refined = await workbench.distillSessionSkill(session.id, { name: 'My assay', domain: 'statistics' });
      expect(completion).toHaveBeenCalledTimes(2);
      expect(refined).toMatchObject({ name: 'my-assay', domain: 'statistics', description: 'Reusable assay QC' });
      expect(refined.instructions).toContain('mean(c(1, 3))');
      expect(refined.instructions).toContain('Verify the reference batch.');
      const skill = workbench.saveCustomSkill({ ...refined, attachToProjectId: project.id });
      expect(skill).toMatchObject({ name: refined.name, isCustom: true });
      expect(events).toContainEqual({ type: 'skill_saved', skill });
      workbench.dispose();
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.skills.loadSkill(skill.name)?.instructions).toBe(refined.instructions);
      expect(workbench.getProjectOverview(project.id).project.defaultSkills).toEqual([skill.name]);
      expect(workbench.deleteCustomSkill(skill.name)).toBe(true);
      expect(() => workbench.deleteCustomSkill(skill.name)).toThrow('Custom skill not found');
      expect(() => workbench.deleteCustomSkill('statistical-validation')).toThrow('Built-in skills cannot be deleted');
    } finally {
      workbench.dispose();
      temp.clean();
    }
  });

  it('retrieves distinct evidence sources in parallel and records hypotheses through coordinator tools', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const retrieval = deferred();
    try {
      expect(workbench.permissions.getPolicy().allowedNetworkHosts).toEqual(expect.arrayContaining([
        'clinicaltrials.gov', 'api.openalex.org', 'api.zotero.org',
      ]));
      const project = workbench.createProject({ name: 'Assay evidence' });
      const other = workbench.createProject({ name: 'Other project' });
      const session = workbench.provenance.createSession({ title: 'Deep evidence', workspacePath: temp.directory, projectId: project.id });
      const first = workbench.createHypothesis(project.id, { title: 'Reference hypothesis', statement: 'The optical reference reduces drift.' });
      const hidden = workbench.createHypothesis(other.id, { title: 'Private hypothesis', statement: 'The control was horizontal.' });
      expect(() => workbench.updateHypothesis(project.id, hidden.id, { status: 'testing' })).toThrow('Hypothesis not found');
      expect(() => workbench.addHypothesisEvidence(project.id, hidden.id, { kind: 'neutral', summary: 'Wrong project' })).toThrow('Hypothesis not found');
      expect(() => workbench.deleteHypothesis(project.id, hidden.id)).toThrow('Hypothesis not found');
      expect(() => workbench.listHypotheses('missing')).toThrow('Project not found');
      const paper = await workbench.importLiteraturePaper({
        filename: 'reference.txt', content: 'The optical reference reduced calibration drift in a bench study.', projectId: project.id,
      });
      await workbench.importLiteraturePaper({
        filename: 'private.txt', content: 'The optical reference used the confidential control.', projectId: other.id,
      });
      workbench.updateSettings({ provider: 'openai', apiKey: 'fixture', maxAgentIterations: 1, allowLiveConnectors: true });
      const searches: string[] = [];
      const connectorsStarted = deferred();
      const query = vi.spyOn(workbench.connectors, 'query').mockImplementation(async (connectorId, operation, params, options) => {
        expect(params.query).toBe('optical reference');
        expect(options?.allowLive).toBe(true);
        searches.push(connectorId + '.' + operation);
        if (searches.length === 4) connectorsStarted.resolve();
        await retrieval.promise;
        if (connectorId === 'clinicaltrials') throw new Error('Clinical service unavailable');
        return {
          connectorId, operation, source: 'live', fetchedAt: new Date().toISOString(), spilled: false,
          data: [{ title: 'Unique evidence from ' + connectorId }], summary: 'One reference',
        };
      });
      let iteration = 0;
      let recordedId = '';
      const synthesis = '## Executive Synthesis\nReference evidence was retrieved.\n\n## Evidence Matrix\n\n## Consensus vs. Contradicting Findings\nBench results remain preliminary.';
      vi.spyOn(workbench.llm, 'completeWithTools').mockImplementation(async (messages, tools) => {
        if (!tools.length) return { text: '[]', toolCalls: [] };
        const system = messages[0].content;
        expect(system).toContain(first.title);
        expect(system).not.toContain(hidden.title);
        expect(system).toContain(paper.id);
        expect(system).not.toContain('confidential control');
        expect(system).toContain('Clinical service unavailable');
        expect(system).toContain('Unique evidence from pubmed');
        expect(system).toContain('Unique evidence from openalex');
        expect(system).toContain('Unique evidence from arxiv-biorxiv');
        expect(system).toContain('Meta-analysis');
        expect(tools.map(({ name }) => name)).toEqual(expect.arrayContaining(['record_hypothesis', 'add_hypothesis_evidence']));
        iteration++;
        if (iteration === 1) return { text: '', toolCalls: [{
          id: 'record', name: 'record_hypothesis', arguments: {
            title: 'Replication hypothesis', statement: 'A second reference batch reduces drift.', status: 'testing', confidence: 65,
          },
        }] };
        if (iteration === 2) {
          recordedId = JSON.parse(messages.at(-1)!.content as string).data.id;
          return { text: '', toolCalls: [{
            id: 'evidence', name: 'add_hypothesis_evidence', arguments: {
              hypothesisId: recordedId, kind: 'supporting', summary: 'A bench study observed lower drift.',
              sourceType: 'paper', sourceId: paper.id, citation: paper.title, grade: 'preclinical',
            },
          }] };
        }
        if (iteration < 10) return { text: '', toolCalls: [{
          id: 'search-' + iteration, name: 'search_local_papers', arguments: { query: 'optical reference', limit: 1 },
        }] };
        return { text: synthesis, toolCalls: [] };
      });
      const run = workbench.runPrompt({ sessionId: session.id, content: 'optical reference', mode: 'deep_research' });
      await Promise.race([connectorsStarted.promise, run]);
      expect(events.filter((event) => event.type === 'deep_research_progress').map(({ progress }) => progress.stage)).toEqual(['planning', 'retrieving']);
      retrieval.resolve();
      const { finalNode, artifacts } = await run;
      expect(query).toHaveBeenCalledTimes(4);
      expect(searches).toEqual(['pubmed.search', 'openalex.search_works', 'clinicaltrials.search_trials', 'arxiv-biorxiv.search_preprints']);
      expect(iteration).toBe(10);
      const dossier = artifacts.find(({ type }) => type === 'manuscript')!;
      expect(dossier).toMatchObject({ title: 'Deep Research Synthesis Dossier', nodeId: finalNode.id, mimeType: 'text/markdown' });
      expect(finalNode.artifactIds).toContain(dossier.id);
      expect(fs.readFileSync(dossier.filePath, 'utf8')).toContain(synthesis);
      expect(workbench.getProjectOverview(project.id).hypotheses).toContainEqual(expect.objectContaining({
        id: recordedId, status: 'testing', sourceSessionId: session.id,
        evidence: [expect.objectContaining({ sourceId: paper.id, kind: 'supporting', grade: 'preclinical' })],
      }));
      const progress = events.filter((event) => event.type === 'deep_research_progress').map(({ progress }) => progress);
      expect(progress.map(({ stage }) => stage)).toEqual(['planning', 'retrieving', 'cross_checking', 'synthesizing', 'completed']);
      expect(progress.at(-1)).toMatchObject({ sourcesReviewed: 4, hypothesesEvaluated: 1 });
      expect(workbench.updateHypothesis(project.id, recordedId, { status: 'supported' }).status).toBe('supported');
      expect(workbench.deleteHypothesis(project.id, recordedId)).toBe(true);
      expect(workbench.listHypotheses(project.id)).toEqual([first]);
      expect(events).toContainEqual({ type: 'hypothesis_deleted', projectId: project.id, hypothesisId: recordedId });
      expect(events.at(-1)).toMatchObject({ type: 'project_updated', project: { id: project.id, hypothesisCount: 1 } });
    } finally {
      retrieval.resolve();
      workbench.dispose();
      temp.clean();
    }
  }, 20_000);
});

function unpackZip(directory: string, filename: string, buffer: Buffer): Map<string, string> {
  expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  const file = path.join(directory, filename);
  fs.writeFileSync(file, buffer);
  const entries: Array<[string, string]> = JSON.parse(execFileSync('python', ['-c', [
    'import json, sys, zipfile',
    'from xml.etree import ElementTree as ET',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '    assert z.testzip() is None',
    '    for name in z.namelist():',
    '        if name.endswith((".xml", ".rels")):',
    '            ET.fromstring(z.read(name))',
    '    print(json.dumps([(name, z.read(name).decode("utf8") if name.endswith((".xml", ".tex", ".bib")) else "") for name in z.namelist()]))',
  ].join('\n'), file], { encoding: 'utf8' }));
  return new Map(entries);
}

describe('v0.4 research runs', () => {
  it('injects project instructions and skills and isolates private memories and papers in frontier runs', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    try {
      const projectA = workbench.createProject({
        name: 'Project A', description: 'Compare the cobalt reference samples.',
        instructions: 'Report cobalt readings in nanomoles.', defaultSkills: ['statistical-validation'],
      });
      const projectB = workbench.createProject({
        name: 'Project B', instructions: 'Report quartz spectra in wavenumbers.', defaultSkills: ['literature-review-pubmed'],
      });
      const sessionA = workbench.provenance.createSession({ title: 'Cobalt study', workspacePath: temp.directory, projectId: projectA.id });
      const sessionB = workbench.provenance.createSession({ title: 'Quartz study', workspacePath: temp.directory, projectId: projectB.id });
      const unassigned = workbench.provenance.createSession({ title: 'Unassigned study', workspacePath: temp.directory });
      const priorFinding = 'Private cobalt calibration used the second reference.';
      workbench.provenance.saveMemoryItem({
        scope: 'project', projectId: projectA.id, workspacePath: temp.directory,
        category: 'finding', title: 'Cobalt baseline', content: priorFinding, tags: [],
      });
      const paper = await workbench.importLiteraturePaper({
        filename: 'cobalt-private.txt', content: 'Cobalt standards were calibrated weekly.', projectId: projectA.id,
      });
      const sharedPaper = await workbench.importLiteraturePaper({
        filename: 'cobalt-shared.txt', content: 'Cobalt is used as a reference material.', projectId: null,
      });
      workbench.updateSettings({ provider: 'openai', apiKey: 'fake-key' });

      const lookup = [
        { id: 'memory', name: 'search_memory', arguments: { query: 'cobalt' } },
        { id: 'papers', name: 'search_local_papers', arguments: { query: 'cobalt' } },
        { id: 'passage', name: 'read_paper_passage', arguments: { paperId: paper.id, page: 1 } },
      ];
      const provider = vi.fn(async (_url: string, init: RequestInit) => {
        const { messages, tools } = JSON.parse(String(init.body));
        if (!tools) return openAiReply('[]');
        const system = messages[0].content;
        const task = messages.findLast(({ role }: { role: string }) => role === 'user').content;
        const inProjectA = task === 'Analyze cobalt in Project A';
        if (inProjectA) {
          expect(system).toContain('Active Research Project\nProject Name: Project A');
          expect(system).toContain(projectA.description);
          expect(system).toContain(projectA.instructions);
          expect(system).toContain('Project Default Skills: statistical-validation');
          expect(system).toContain('Skill statistical-validation:\n');
          expect(system).toContain(priorFinding);
          expect(system).not.toContain(projectB.instructions);
        } else if (task === 'Check Project B') {
          expect(system).toContain('Active Research Project\nProject Name: Project B');
          expect(system).toContain(projectB.instructions);
          expect(system).toContain('Skill literature-review-pubmed:\n');
          expect(system).not.toContain(projectA.instructions);
          expect(system).not.toContain(priorFinding);
        } else {
          expect(system).not.toContain('Active Research Project');
          expect(system).not.toContain(priorFinding);
        }
        if (messages.at(-1).role === 'user') {
          if (!inProjectA) return openAiReply('', lookup);
          expect(() => workbench.moveSessionToProject(sessionA.id, projectB.id)).toThrow('A research run is already active');
          expect(() => workbench.deleteProject(projectA.id)).toThrow('A research run is already active');
          expect(tools).toContainEqual(expect.objectContaining({ function: expect.objectContaining({
            name: 'save_memory', parameters: expect.objectContaining({ properties: expect.objectContaining({
              scope: expect.objectContaining({ enum: expect.arrayContaining(['project', 'global', 'workspace']) }),
            }) }),
          }) }));
          return openAiReply('', [
            { id: 'save', name: 'save_memory', arguments: {
              category: 'finding', title: 'Cobalt replicate', content: 'The cobalt triplicate agreed.',
            } },
            { id: 'save-explicit', name: 'save_memory', arguments: {
              scope: 'project', category: 'finding', title: 'Cobalt check', content: 'The cobalt control was stable.',
            } },
            ...lookup,
          ]);
        }
        const results = Object.fromEntries(messages.filter(({ role }: { role: string }) => role === 'tool')
          .map(({ tool_call_id, content }: { tool_call_id: string; content: string }) => [tool_call_id, JSON.parse(content)]));
        if (inProjectA) {
          expect(results.save.data).toMatchObject({ scope: 'project', projectId: projectA.id, sourceSessionId: sessionA.id });
          expect(results['save-explicit'].data).toMatchObject({ scope: 'project', projectId: projectA.id });
          expect(results.memory.data).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Cobalt replicate' })]));
          expect(results.papers.data).toEqual(expect.arrayContaining([expect.objectContaining({ paperId: paper.id })]));
          expect(results.passage.data).toEqual([expect.objectContaining({ paperId: paper.id })]);
        } else {
          expect(results.memory.data).toEqual([]);
          expect(results.papers.data).toEqual([expect.objectContaining({ paperId: sharedPaper.id })]);
          expect(results.passage).toMatchObject({ exitCode: 1, data: { error: 'Local paper not found' } });
        }
        return openAiReply('Research checks completed.');
      });
      vi.stubGlobal('fetch', provider);

      await workbench.runPrompt({ sessionId: sessionA.id, content: 'Analyze cobalt in Project A' });
      await workbench.runPrompt({ sessionId: sessionB.id, content: 'Check Project B' });
      await workbench.runPrompt({ sessionId: unassigned.id, content: 'Check the shared literature' });
      expect(workbench.provenance.listLoadedSkills(sessionA.id)).toEqual(projectA.defaultSkills);
      expect(workbench.provenance.listLoadedSkills(sessionB.id)).toEqual(projectB.defaultSkills);
      expect(events.filter(({ type }) => type === 'memory_updated')).toContainEqual(expect.objectContaining({
        item: expect.objectContaining({ title: 'Cobalt replicate', scope: 'project', projectId: projectA.id }),
      }));
      expect(events.filter(({ type }) => type === 'skill_loaded')).toEqual([
        expect.objectContaining({ sessionId: sessionA.id, skillName: 'statistical-validation' }),
        expect.objectContaining({ sessionId: sessionB.id, skillName: 'literature-review-pubmed' }),
      ]);
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  });

  it('encrypts API keys, restores them on restart, and scrubs legacy plaintext from SQLite and its WAL', () => {
    const temp = createWorkbench();
    const dbPath = path.join(temp.options.dataDir, 'scideveloper.sqlite');
    const key = 'sk-vault-test-31e847c31fb1492c';
    const legacyKey = 'sk-legacy-test-0a17197a8efe4d9f';
    const secondKey = 'sk-provider-test-c15846ace676ed1b';
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(name, undefined);
    const expectAbsentOnDisk = (value: string) => {
      for (const file of [dbPath, dbPath + '-wal']) {
        if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(Buffer.from(value))).toBe(false);
      }
    };
    let workbench = new SciDeveloperOrchestrator(temp.options);
    try {
      expect(workbench.updateSettings({ provider: 'openai', model: 'vault-test', apiKey: key }))
        .toMatchObject({ keyProtection: workbench.provenance.vault.protection, hasApiKey: true, enableVisionAudit: true });
      expect(workbench.provenance.getConfig('llm_settings')).not.toHaveProperty('apiKey');
      expect(workbench.updateSettings({ apiKeyProvider: 'anthropic', apiKey: secondKey }))
        .toMatchObject({ provider: 'openai', hasApiKey: true, configuredProviders: expect.arrayContaining(['anthropic', 'openai']) });
      expectAbsentOnDisk(secondKey);
      expectAbsentOnDisk(key);
      workbench.dispose();
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.provenance.getSecret('llm_key:openai')).toBe(key);
      expect(workbench.provenance.getSecret('llm_key:anthropic')).toBe(secondKey);
      expect(workbench.llm.getSafeSettings()).toMatchObject({ model: 'vault-test', hasApiKey: true });
      workbench.dispose();

      const legacy = new ProvenanceStore(dbPath);
      try {
        legacy.setConfig('llm_settings', { provider: 'gemini', model: 'legacy-model', apiKey: legacyKey, enableVisionAudit: false });
      } finally {
        legacy.close();
      }
      expect(fs.readFileSync(dbPath).includes(Buffer.from(legacyKey))).toBe(true);
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.provenance.getSecret('llm_key:gemini')).toBe(legacyKey);
      expect(workbench.provenance.getConfig('llm_settings'))
        .toEqual({ provider: 'gemini', model: 'legacy-model', enableVisionAudit: false });
      expect(workbench.llm.getSafeSettings()).toMatchObject({ model: 'legacy-model', enableVisionAudit: false });
      expectAbsentOnDisk(legacyKey);
      expect(workbench.updateSettings({ apiKey: '' })).toMatchObject({ provider: 'gemini', hasApiKey: false, isConfigured: false });
      expect(workbench.provenance.getSecret('llm_key:gemini')).toBeNull();
      expect(workbench.provenance.getSecret('llm_key:anthropic')).toBe(secondKey);
    } finally {
      workbench.dispose();
      vi.unstubAllEnvs();
      temp.clean();
    }
  });

  it('retains a stored key when upgrading a fallback vault to an Electron-provided master key', () => {
    const temp = createWorkbench();
    vi.stubEnv('SCIDEV_VAULT_KEY', undefined);
    let workbench = new SciDeveloperOrchestrator(temp.options);
    try {
      workbench.updateSettings({ provider: 'anthropic', apiKey: 'existing-key' });
      expect(workbench.llm.getSafeSettings().keyProtection).toBe('aes-256-gcm-vault');
      workbench.dispose();
      vi.stubEnv('SCIDEV_VAULT_KEY', '3'.repeat(64));
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.provenance.getSecret('llm_key:anthropic')).toBe('existing-key');
      expect(workbench.llm.getSafeSettings().keyProtection).toBe('dpapi-safe-storage');
      workbench.dispose();
      vi.stubEnv('SCIDEV_VAULT_KEY', undefined);
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.provenance.getSecret('llm_key:anthropic')).toBeNull();
      workbench.updateSettings({ model: 'new-model' });
      workbench.dispose();
      vi.stubEnv('SCIDEV_VAULT_KEY', '3'.repeat(64));
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.provenance.getSecret('llm_key:anthropic')).toBe('existing-key');
    } finally {
      workbench.dispose();
      vi.unstubAllEnvs();
      temp.clean();
    }
  });

  it('runs two specialist conversations in parallel, preserves their outputs, and synthesizes their compact summaries', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const release = deferred();
    const started: string[] = [];
    const session = workbench.provenance.createSession({ title: 'Parallel delegates', workspacePath: temp.directory });
    const custom = workbench.saveCustomSpecialist({
      name: 'Custom statistics', domain: 'statistics', description: 'Custom prompt for this test.',
      systemPrompt: 'Include the unit U.', defaultSkills: ['literature-review-pubmed'],
    });
    workbench.updateSettings({ provider: 'openai', apiKey: 'fake-key' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { messages, tools, stream } = JSON.parse(String(init.body));
      const task = messages.findLast((message: { role: string }) => message.role === 'user').content;
      const last = messages.at(-1);
      if (!tools) return openAiReply('[]');
      if (stream && last.role === 'user') {
        return openAiReply('', [
          { id: 'stats', name: 'spawn_specialist', arguments: { domain: 'statistics', task: 'Calculate statistics only', customSpecialistId: custom.id } },
          { id: 'literature', name: 'spawn_specialist', arguments: { domain: 'literature', task: 'Summarize literature only' } },
        ]);
      }
      if (stream) {
        const results = messages.filter(({ role }: { role: string }) => role === 'tool').map(({ content }: { content: string }) => JSON.parse(content).data);
        expect(results).toEqual([
          expect.objectContaining({ status: 'completed', summary: 'The measured result was 9 U.', artifactIds: [expect.any(String)] }),
          expect.objectContaining({ status: 'completed', summary: 'Literature evidence is limited.', artifactIds: [] }),
        ]);
        return openAiReply('Combined synthesis found 9 U and limited literature evidence.');
      }
      expect(tools.map(({ function: tool }: { function: { name: string } }) => tool.name)).not.toContain('spawn_specialist');
      expect(messages.map(({ content }: { content: string }) => content).join('\n')).not.toContain('Coordinate both domains');
      if (last.role === 'tool') {
        expect(last.content).toContain('"measurement":9');
        return openAiReply('The measured result was 9 U.');
      }
      started.push(task);
      await release.promise;
      if (task === 'Summarize literature only') {
        expect(messages[0].content).not.toContain('Include the unit U.');
        return openAiReply('Literature evidence is limited.');
      }
      expect(task).toBe('Calculate statistics only');
      expect(messages[0].content).toContain('Include the unit U.');
      expect(messages[0].content).toContain('Skill literature-review-pubmed');
      return openAiReply('', [{ id: 'measure', name: 'run_python', arguments: { code: [
        'from pathlib import Path',
        'SCIDEV_METRICS = {"measurement": 9}',
        '(Path(SCIDEV_OUTPUT_DIR) / "measurement.csv").write_bytes(b"value\\n9\\n")',
      ].join('\n') } }]);
    }));
    const run = workbench.runPrompt({ sessionId: session.id, content: 'Coordinate both domains' });
    try {
      await expect.poll(() => started.length).toBe(2);
      expect(events.filter(({ type }) => type === 'subagent_finished')).toHaveLength(0);
      release.resolve();
      const result = await run;
      const tree = workbench.provenance.getSessionTree(session.id)!;
      const children = tree.nodes.filter(({ role }) => role === 'specialist');
      expect(children.map(({ specialistDomain }) => specialistDomain)).toEqual(['statistics', 'literature']);
      expect(children[0].parentId).toBe(children[1].parentId);
      expect(result.artifacts).toHaveLength(1);
      expect(children[0].id).toBe(workbench.provenance.getNode(result.artifacts[0].nodeId)?.parentId);
      expect(events.filter(({ type }) => type === 'subagent_started')).toEqual(children.map(({ id, parentId }) =>
        expect.objectContaining({ runId: id, subagentId: id, parentNodeId: parentId })));
      expect(events.filter(({ type }) => type === 'subagent_finished')).toHaveLength(2);
      const synthesis = tree.nodes.find(({ id }) => id === result.finalNode.parentId);
      expect(synthesis?.content).toContain('Combined synthesis found 9 U');
      expect(Object.values(synthesis?.metadata?.metrics ?? {})).toContain(9);
    } finally {
      release.resolve();
      workbench.cancelRun(session.id);
      await run.catch(() => undefined);
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 30_000);

  it('injects queued steering into the next provider turn and finishes a cancelled run without another model call', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const session = workbench.provenance.createSession({ title: 'Steering', workspacePath: temp.directory });
    workbench.updateSettings({ provider: 'openai', apiKey: 'fake-key' });
    const first = deferred();
    const second = deferred();
    const release = deferred();
    const provider = vi.fn(async (_url: string, init: RequestInit) => {
      if (provider.mock.calls.length === 1) {
        first.resolve();
        await release.promise;
        return openAiReply('', [{ id: 'files', name: 'list_workspace_files', arguments: {} }]);
      }
      second.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', provider);
    const run = workbench.runPrompt({ sessionId: session.id, content: 'Inspect available inputs' });
    try {
      await first.promise;
      expect(workbench.steerRun(session.id, '  Focus on sample groups  ')).toBe(true);
      release.resolve();
      await second.promise;
      const body = JSON.parse(String(provider.mock.calls[1][1].body));
      expect(body.messages.at(-1)).toEqual({ role: 'user', content: '[Researcher mid-run steering]: Focus on sample groups' });
      expect(workbench.cancelRun(session.id)).toBe(true);
      const result = await run;
      expect(result.finalNode.content).toMatch(/^Run cancelled by researcher/);
      expect(result.artifacts).toEqual([]);
      expect(events).toContainEqual({ type: 'steering_applied', sessionId: session.id, message: 'Focus on sample groups' });
      expect(events).toContainEqual({ type: 'run_cancelled', sessionId: session.id, reason: 'Cancelled by researcher' });
      expect(events).toContainEqual({ type: 'run_completed', sessionId: session.id, activeNodeId: result.finalNode.id });
      expect(events.some(({ type }) => type === 'run_error')).toBe(false);
      expect(workbench.cancelRun(session.id)).toBe(false);
      expect(workbench.steerRun(session.id, 'Another note')).toBe(false);
      expect(() => workbench.steerRun(session.id, ' ')).toThrow('Steering message is required');
      expect(workbench.provenance.getSessionTree(session.id)?.nodes).toContainEqual(expect.objectContaining({
        role: 'user', content: 'Focus on sample groups', metadata: { steering: true },
      }));
    } finally {
      release.resolve();
      workbench.cancelRun(session.id);
      await run.catch(() => undefined);
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  });

  it('interrupts a running Python cell and keeps subsequent runs usable', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const session = workbench.provenance.createSession({ title: 'Stop Python', workspacePath: temp.directory });
    workbench.updateSettings({ provider: 'openai', apiKey: 'fake-key' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(openAiReply('', [{ id: 'compute', name: 'run_python', arguments: {
        code: [
          'from pathlib import Path', 'from time import sleep', 'output = Path(SCIDEV_OUTPUT_DIR)',
          '(output / "started").touch()', 'sleep(20)', '(output / "finished").touch()',
        ].join('\n'),
      } }]))
      .mockImplementation(() => Promise.resolve(openAiReply('[]'))));
    const run = workbench.runPrompt({ sessionId: session.id, content: 'Start a long computation' });
    try {
      const artifacts = path.join(temp.options.dataDir, 'sessions', session.id, 'artifacts');
      await expect.poll(() => fs.existsSync(artifacts) && fs.readdirSync(artifacts)
        .some((directory) => fs.existsSync(path.join(artifacts, directory, 'started'))), { timeout: 8000 }).toBe(true);
      expect(workbench.cancelRun(session.id)).toBe(true);
      await expect(run).resolves.toMatchObject({ finalNode: { metadata: { cancelled: true } }, artifacts: [] });
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_finished', toolName: 'run_python', summary: 'run_python cancelled' }));
      expect((await workbench.captureSessionEnvironment(session.id, 'local-sandbox')).pythonVersion).toBeTruthy();
    } finally {
      workbench.cancelRun(session.id);
      await run.catch(() => undefined);
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 15_000);

  it('profiles VCF attachments and reads XLSX using the ZIP/XML fallback', async () => {
    const temp = createWorkbench();
    const workbench = new SciDeveloperOrchestrator(temp.options);
    try {
      const session = workbench.provenance.createSession({ title: 'Dataset formats', workspacePath: temp.directory });
      workbench.updateSettings({ provider: 'openai', apiKey: 'fixture', enableVisionAudit: false });
      vi.stubGlobal('fetch', vi.fn(async () => openAiReply('The dataset profile is complete.')));
      fs.writeFileSync(path.join(temp.directory, 'variants.vcf'), [
        '##fileformat=VCFv4.2', '##source=fixture',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO', '1\t10\t.\tA\tG\t42\tPASS\t.',
      ].join('\n'));
      const { artifacts } = await workbench.runPrompt({
        sessionId: session.id, content: 'Profile the attached variants.', attachedFiles: ['variants.vcf'],
      });
      const figure = artifacts.find(({ type }) => type === 'figure');
      expect(figure?.previewData).toMatchObject({ rows: 1, columns: 8, missing_values: 2 });
      expect(fs.readFileSync(artifacts.find(({ type }) => type === 'table')!.filePath, 'utf8')).toContain('#CHROM,');
      const fixture = [
        'from zipfile import ZipFile',
        'import json, os, sys',
        'SCIDEV_WORKSPACE_DIR = SCIDEV_OUTPUT_DIR = sys.argv[1]',
        'with ZipFile(os.path.join(SCIDEV_WORKSPACE_DIR, "test.xlsx"), "w") as workbook:',
        '    workbook.writestr("xl/workbook.xml", \'<workbook xmlns:r="urn:r"><sheets><sheet r:id="rId5"/></sheets></workbook>\')',
        '    workbook.writestr("xl/_rels/workbook.xml.rels", \'<Relationships><Relationship Id="rId5" Target="worksheets/study.xml"/></Relationships>\')',
        '    workbook.writestr("xl/worksheets/study.xml", \'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>dose</t></is></c><c r="C1" t="inlineStr"><is><t>count</t></is></c></row><row><c r="A2"><v>2</v></c><c r="C2"><v>4</v></c></row></sheetData></worksheet>\')',
        'def missing_engine(*args, **kwargs):',
        '    raise ImportError("fixture: workbook engine unavailable")',
        'import pandas as pd',
        'pd.read_excel = missing_engine',
        datasetAnalysisScript('test.xlsx'),
        'print(json.dumps(SCIDEV_METRICS))',
        'try:',
        '    pd.DataFrame({"dose": [2, 4], "count": [1, 3]}).to_parquet(os.path.join(SCIDEV_WORKSPACE_DIR, "counts.parquet"))',
        '    print("parquet-available")',
        'except ImportError:',
        '    print("parquet-unavailable")',
      ].join('\n');
      const [dims, parquet] = execFileSync('python', ['-c', fixture, temp.directory], {
        encoding: 'utf8', env: { ...process.env, MPLBACKEND: 'Agg' },
      }).trimEnd().split(/\r?\n/).slice(-2);
      expect(JSON.parse(dims)).toEqual({ rows: 1, columns: 3, missing_values: 1, numeric_columns: 2 });
      if (parquet === 'parquet-available') {
        const profile = await workbench.runPrompt({
          sessionId: session.id, content: 'Profile the Parquet counts.', attachedFiles: ['counts.parquet'],
        });
        expect(profile.artifacts.find(({ type }) => type === 'figure')?.previewData)
          .toMatchObject({ rows: 2, columns: 2, numeric_columns: 2 });
      }
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 20_000);

  it('audits PNG pixels and sends live vision image blocks, exports a cited manuscript, and verifies replay hashes', async () => {
    const temp = createWorkbench();
    const workbench = new SciDeveloperOrchestrator(temp.options);
    try {
      const session = workbench.provenance.createSession({ title: 'PNG audit', workspacePath: temp.directory });
      const node = workbench.provenance.appendNode({
        sessionId: session.id, parentId: null, role: 'coordinator', agentName: 'Fixture', content: 'PMID:15118073',
      });
      const code = [
        'from pathlib import Path', 'from PIL import Image, ImageDraw',
        'image = Image.new("RGB", (320, 240), "white")',
        'ImageDraw.Draw(image).line((0, 30, 50, 30), fill="black", width=4)',
        'image.save(Path(SCIDEV_OUTPUT_DIR) / "figure.png")',
      ].join('\n');
      const figurePath = path.join(temp.directory, 'figure.png');
      execFileSync('python', ['-c', 'SCIDEV_OUTPUT_DIR = ' + JSON.stringify(temp.directory) + '\n' + code]);
      const { artifact: figure, provenance: manifest } = workbench.provenance.recordArtifactWithProvenance({
        sessionId: session.id, nodeId: node.id, type: 'figure', title: 'QC figure', description: 'A PNG fixture.',
        mimeType: 'image/png', filePath: figurePath,
        executionCode: { language: 'python', code, executedAt: new Date().toISOString() },
        environmentSnapshot: { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
          nodeVersion: process.version, workingDirectory: temp.directory, packages: {},
          computeTargetId: 'local-sandbox', computeTargetKind: 'local-sandbox' },
        plainLanguageSummary: 'A plotted diagnostic with one line.',
      });
      const ctx = { sessionId: session.id, nodeId: node.id, artifacts: [figure], proseText: node.content };
      workbench.updateSettings({ provider: 'anthropic', apiKey: '' });
      vi.stubEnv('ANTHROPIC_API_KEY', undefined);
      const local = await workbench.reviewer.audit(ctx);
      expect(local).toMatchObject({
        visionAuditUsed: true, findings: expect.arrayContaining([expect.objectContaining({
          category: 'visual_inspection', severity: 'warn', detail: expect.stringContaining('left border'),
          suggestedFix: expect.stringContaining('Increase figure margins'),
        })]),
      });
      const headerOnly = await workbench.reviewer.audit({ ...ctx, pythonExecutable: path.join(temp.directory, 'missing-python') });
      expect(headerOnly.findings).toContainEqual(expect.objectContaining({
        category: 'visual_inspection', detail: expect.stringContaining('320 × 240 px'),
      }));
      expect((await workbench.reviewer.audit({ ...ctx, enableVisionAudit: false })).visionAuditUsed).toBeUndefined();

      workbench.updateSettings({
        provider: 'anthropic', routing: { reviewer: { provider: 'openai', model: 'review-vision', baseUrl: 'https://review.example/v1' } },
        apiKeyProvider: 'openai', apiKey: 'test-vision-key',
      });
      const provider = vi.fn(async (endpoint: string, init: RequestInit) => {
        expect(endpoint).toBe('https://review.example/v1/chat/completions');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer test-vision-key' });
        const { messages, model } = JSON.parse(String(init.body));
        expect(model).toBe('review-vision');
        if (!Array.isArray(messages[1].content)) return openAiReply('[]');
        expect(messages[1].content[1]).toEqual({
          type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(figurePath, 'base64') },
        });
        return openAiReply(JSON.stringify([{ severity: 'warn', title: 'Missing axis units', detail: 'The figure omits the unit.' }]));
      });
      vi.stubGlobal('fetch', provider);
      const live = await workbench.reviewer.audit(ctx);
      expect(live.visionAuditUsed).toBe(true);
      expect(live.findings).toContainEqual(expect.objectContaining({ category: 'visual_inspection', title: 'Missing axis units' }));
      expect(provider).toHaveBeenCalledTimes(2);

      const { manuscript, artifact } = await workbench.compileManuscript(session.id, 'Figure & Methods <QC>');
      expect(manuscript.bibtexSource).toContain('@article{ref1');
      expect(manuscript.bibtexSource).toContain('PMID:15118073');
      expect(fs.readFileSync(artifact.filePath.replace(/\.md$/, '.bib'), 'utf8')).toBe(manuscript.bibtexSource);
      const zip = await workbench.exportManuscriptBinary(session.id, 'overleaf-zip');
      const files = unpackZip(temp.directory, zip.filename, zip.buffer);
      expect(files.get('main.tex')).toContain('\\graphicspath{{figures/}}');
      expect(files.get('main.tex')).toContain('\\bibliography{references}');
      expect(files.get('references.bib')).toBe(manuscript.bibtexSource);
      expect([...files.keys()]).toContain(`figures/${manuscript.id}_figure_1.png`);
      const word = await workbench.exportManuscriptBinary(session.id, 'docx');
      const parts = unpackZip(temp.directory, word.filename, word.buffer);
      expect(parts.has('[Content_Types].xml')).toBe(true);
      expect(parts.get('word/document.xml')).toContain('Figure &amp; Methods &lt;QC&gt;');
      expect(parts.get('word/document.xml')).toContain('PMID:15118073');
      expect(workbench.provenance.getSessionTree(session.id)?.artifacts.filter(({ type }) => type === 'manuscript')).toHaveLength(1);

      const { replay, artifact: copy } = await workbench.replayBundle(session.id, { manifest });
      expect(replay).toMatchObject({ codeSha256Matched: true, outputSha256Matched: true, exitCode: 0, replayedArtifactId: copy?.id });
      expect(copy?.filePath).not.toBe(figurePath);
      expect(copy?.sha256).toBe(figure.sha256);
      expect(workbench.provenance.getNode(copy!.nodeId)).toMatchObject({ role: 'specialist', agentName: 'Replay Verification' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      workbench.dispose();
      temp.clean();
    }
  }, 40_000);
});

describe('@scideveloper/agents end-to-end pipeline', () => {
  it('automatically compacts a large lineage and uses a deterministic summary when the compaction model fails', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => openAiReply('Continue from the summary.'));
    vi.stubGlobal('fetch', network);
    try {
      workbench.updateSettings({
        provider: 'openai', apiKey: 'fixture',
        routing: { compaction: { provider: 'openai', model: 'compact-model', baseUrl: 'https://compaction.example/v1' } },
      });
      const { id } = workbench.provenance.createSession({ title: 'Large context', workspacePath: temp.directory });
      let parentId: string | null = null;
      for (let index = 0; index < 6; index++) {
        parentId = workbench.provenance.appendNode({
          sessionId: id, parentId, role: index % 2 === 0 ? 'user' : 'coordinator',
          agentName: 'Contributor', content: 'Calibration note ' + index,
        }).id;
      }
      workbench.provenance.updateSessionTokenUsage(id, {
        inputTokens: 340_000, outputTokens: 100, estimatedContextTokens: 350_000,
        contextWindowLimit: 400_000, updatedAt: new Date().toISOString(),
      });
      await workbench.runPrompt({ sessionId: id, content: 'Keep analyzing.' });
      expect(network.mock.calls[0][0]).toBe('https://compaction.example/v1/chat/completions');
      const coordinator = JSON.parse(String(network.mock.calls[1][1]?.body));
      expect(coordinator.messages).toHaveLength(2);
      expect(coordinator.messages[0].content).toContain('## Research objectives');
      expect(coordinator.messages[0].content).toContain('Calibration note 0');
      expect(events).toContainEqual(expect.objectContaining({ type: 'session_compacted', compactedNodeCount: 6 }));
      expect(workbench.provenance.getSession(id)).toMatchObject({
        compactedUpToNodeId: parentId, tokenUsage: { inputTokens: 340_000, contextWindowLimit: 400_000 },
      });
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  });

  it('loads a requested skill, spills a connector result, and audits a model-directed tool run', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(openAiReply('', [
        { id: 'skill', name: 'load_skill', arguments: { name: 'statistical-validation' } },
        { id: 'query', name: 'query_connector', arguments: { connectorId: 'chembl', operation: 'bulk_assay', params: { limit: 240 } } },
        { id: 'plot', name: 'run_python', arguments: { code: 'from matplotlib import pyplot as plt\nplt.plot([1, 2, 3])\nprint("plotted")' } },
      ]))
      .mockResolvedValueOnce(openAiReply('The sandbox produced a figure.'))
      .mockImplementation(async () => openAiReply('[]'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      workbench.updateSettings({ provider: 'openai', apiKey: 'fixture', enableVisionAudit: false });
      const { id } = workbench.provenance.createSession({ title: 'Model-directed analysis', workspacePath: temp.directory });
      const result = await workbench.runPrompt({ sessionId: id, content: 'Analyze the inputs and document the methods.' });
      expect(result.artifacts.map(({ type }) => type)).toEqual(['figure']);
      expect(workbench.provenance.listArtifactSnapshots(id)).toHaveLength(1);
      expect(workbench.provenance.getSessionTree(id)?.loadedSkills).toContain('statistical-validation');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_finished', toolName: 'query_connector', spillHandle: expect.objectContaining({ spilled: true }),
      }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_output_delta', toolName: 'run_python', chunk: expect.stringContaining('plotted') }));
      const badAudit = await workbench.reviewer.audit({
        sessionId: id, nodeId: result.finalNode.id, proseText: 'PMID:99999999 reported p < 0.01.',
        artifacts: [], allowLiveCitations: false,
      });
      expect(badAudit.overallStatus).toBe('fail');
      expect(badAudit.autoFixPrompt).toContain('Apply Benjamini-Hochberg');
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 30_000);

  it('restores persisted settings, workspace permissions, specialists, MCP servers, targets, and Slurm jobs', async () => {
    const temp = createWorkbench();
    let workbench = new SciDeveloperOrchestrator(temp.options);
    const external: ExternalMcpServerConfig = {
      id: 'lab-mcp', name: 'Lab MCP', transport: 'http', url: 'http://localhost:4319/mcp',
      headers: { 'X-Test': 'fixture' }, enabled: true,
    };
    const target: ComputeTarget = {
      id: 'lab-secondary', name: 'Secondary cluster', kind: 'hpc-slurm', status: 'simulated', description: 'Test cluster',
    };
    const spec: SlurmJobSpec = {
      targetId: target.id, jobName: 'qc', partition: 'test', cpus: 2, memGb: 8, walltime: '00:15:00', command: 'echo qc',
    };
    try {
      const settings = workbench.updateSettings({
        provider: 'openai', model: 'test-model', apiKey: 'test-token', temperature: 0.1,
        maxAgentIterations: 3, pythonExecutable: 'custom-python', allowLiveConnectors: true,
      });
      expect(settings).not.toHaveProperty('apiKey');
      const policy = workbench.updatePermissionPolicy({
        allowedNetworkHosts: ['localhost'], rules: { remote_hpc_submit: 'allow', fs_write: 'deny' }, autoApproveReadOnly: false,
      });
      const specialist = workbench.saveCustomSpecialist({
        name: 'Lab statistician', domain: 'statistics', description: 'Audit QC metrics',
        systemPrompt: 'Report the units and sample size.', defaultSkills: ['statistical-validation'],
      });
      workbench.registerExternalMcp(external);
      workbench.registerComputeTarget(target);
      const session = workbench.provenance.createSession({ title: 'Persistence', workspacePath: temp.directory });
      const changedWorkspace = path.join(temp.directory, 'study');
      fs.mkdirSync(changedWorkspace);
      workbench.updateSessionWorkspace(session.id, changedWorkspace);
      const submitted = await workbench.slurm.submitJob('global', spec, workbench.permissions);
      const cancelled = await workbench.slurm.cancelJob(submitted.id);
      expect(cancelled.status).toBe('cancelled');
      const active = await workbench.slurm.submitJob('global', spec, workbench.permissions);

      workbench.dispose();
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.llm.getSafeSettings()).toEqual(settings);
      expect(workbench.llm.isLiveProviderConfigured()).toBe(true);
      expect(workbench.permissions.getPolicy()).toMatchObject({
        ...policy, allowedWorkspaceRoots: expect.arrayContaining([...policy.allowedWorkspaceRoots, changedWorkspace]),
      });
      expect(workbench.provenance.getSession(session.id)?.workspacePath).toBe(changedWorkspace);
      expect(workbench.listCustomSpecialists()).toEqual([specialist]);
      expect(workbench.connectors.listExternalServers()).toEqual([external]);
      expect(workbench.slurm.getTarget(target.id)).toEqual(target);
      expect(workbench.slurm.getJob(submitted.id)).toEqual(cancelled);
      expect(workbench.slurm.getJob(active.id)?.status).toBe('queued');
      await expect.poll(() => workbench.slurm.getJob(active.id)?.status, { timeout: 5000 }).toBe('completed');
      expect(workbench.provenance.listPersistedSlurmJobs().find(({ id }) => id === active.id)?.status).toBe('completed');
      expect(workbench.removeComputeTarget(target.id)).toBe(true);
      expect(workbench.removeComputeTarget('lab-hpc-slurm')).toBe(true);
      expect(workbench.removeExternalMcp(external.id)).toBe(true);
      expect(workbench.deleteCustomSpecialist(specialist.id)).toBe(true);

      workbench.dispose();
      workbench = new SciDeveloperOrchestrator(temp.options);
      expect(workbench.listCustomSpecialists()).toEqual([]);
      expect(workbench.connectors.listExternalServers()).toEqual([]);
      expect(workbench.slurm.listTargets().map(({ id }) => id)).toEqual(['local-sandbox', 'docker-sandbox']);
      expect(workbench.slurm.getJob(submitted.id)?.status).toBe('cancelled');
    } finally {
      workbench.dispose();
      temp.clean();
    }
  });

  it('repairs a failed Python tool call using its traceback and streams the synthesis and semantic audit', async () => {
    const temp = createWorkbench();
    const events: WorkbenchEvent[] = [];
    const workbench = new SciDeveloperOrchestrator({ ...temp.options, onEvent: (event) => events.push(event) });
    let turn = 0;
    function stream(frames: unknown[]) {
      const text = [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join('');
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = encoder.encode(text);
          for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    function toolCall(id: string, code: string) {
      const args = JSON.stringify({ code, title: 'Retry test', methods: 'Computed the exact value in Python.' });
      return stream([
        { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run_python', arguments: args.slice(0, 15) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(15) } }] } }] },
      ]);
    }
    const provider = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://provider.example/v1/chat/completions');
      const { messages, tools, stream: streaming } = JSON.parse(String(init.body));
      turn++;
      if (turn === 1) {
        expect(streaming).toBe(true);
        expect(tools).toContainEqual({ type: 'function', function: expect.objectContaining({ name: 'run_python' }) });
        return toolCall('call_error', 'raise ValueError("intentional first attempt")');
      }
      if (turn === 2) {
        expect(messages.at(-1)).toMatchObject({
          role: 'tool', tool_call_id: 'call_error', content: expect.stringContaining('ValueError: intentional first attempt'),
        });
        return toolCall('call_success', [
          'import os', 'SCIDEV_METRICS = {"value": 42}',
          'with open(os.path.join(SCIDEV_OUTPUT_DIR, "result.csv"), "w", newline="") as f:',
          '    f.write("value\\n42\\n")',
          'print(42)',
        ].join('\n'));
      }
      if (turn === 3) {
        expect(messages.at(-1)).toMatchObject({
          role: 'tool', tool_call_id: 'call_success', content: expect.stringContaining('"exitCode":0'),
        });
        return stream([
          { choices: [{ delta: { content: 'The corrected result is ' } }] },
          { choices: [{ delta: { content: '42.' } }] },
        ]);
      }
      expect(streaming).toBe(false);
      expect(messages.at(-1).content).toContain('SCIDEV_METRICS');
      return Response.json({
        choices: [{ message: { content: JSON.stringify([{
          severity: 'warn', title: 'Units absent', detail: 'The quantitative result has no units.',
          suggestedFix: 'State the units or identify the value as dimensionless.',
        }]) } }],
      });
    });
    vi.stubGlobal('fetch', provider);
    try {
      workbench.updateSettings({ provider: 'openai', baseUrl: 'https://provider.example/v1', apiKey: 'fixture', maxAgentIterations: 3 });
      const session = workbench.provenance.createSession({ title: 'Retry', workspacePath: temp.directory });
      const result = await workbench.runPrompt({ sessionId: session.id, content: 'Calculate and report the exact result with Python.' });
      expect(provider).toHaveBeenCalledTimes(4);
      expect(result.artifacts.map(({ type }) => type)).toEqual(['table']);
      expect(fs.readFileSync(result.artifacts[0].filePath, 'utf8')).toBe('value\n42\n');
      const starts = events.filter((event) => event.type === 'tool_started');
      const finishes = events.filter((event) => event.type === 'tool_finished');
      expect(starts.map(({ iteration }) => iteration)).toEqual([1, 2]);
      expect(finishes.map(({ exitCode }) => exitCode)).toEqual([1, 0]);
      expect(events.filter((event) => event.type === 'node_delta').map(({ delta }) => delta)).toEqual(['The corrected result is ', '42.']);
      const report = workbench.provenance.listReviews(session.id)[0];
      expect(report).toMatchObject({ semanticAuditUsed: true, overallStatus: 'warn' });
      expect(report.findings).toContainEqual(expect.objectContaining({ category: 'methodology_semantics', title: 'Units absent' }));
      expect(report.autoFixPrompt).toContain('State the units');
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 30_000);

  it('returns 502 when the provider fails and retains already recorded workspace artifacts', async () => {
    const temp = createWorkbench();
    const workbench = new SciDeveloperOrchestrator(temp.options);
    const fetchMock = vi.fn(async () => new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      workbench.updateSettings({ provider: 'openai', baseUrl: 'https://provider.example/v1', apiKey: 'fixture' });
      const session = workbench.provenance.createSession({ title: 'Dataset provenance', workspacePath: temp.directory });
      const datasets = {
        'dose.tsv': 'sample\tvalue\nx\t5\ny\t7\n',
        'assay.json': '[{"replicate":1,"value":3},{"replicate":2,"value":null}]',
        'coordinates.pdb': 'ATOM      1  N   MET A   1      20.154  34.221  17.809  1.00 45.94           N  \n',
      };
      for (const [filename, contents] of Object.entries(datasets)) fs.writeFileSync(path.join(temp.directory, filename), contents);
      await expect(workbench.runPrompt({
        sessionId: session.id, content: 'Profile the local data', attachedFiles: Object.keys(datasets),
      })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('HTTP 503') });
      expect(fetchMock).toHaveBeenCalledOnce();
      const result = workbench.provenance.getSessionTree(session.id)!;
      const figures = result.artifacts.filter(({ type }) => type === 'figure');
      expect(figures).toHaveLength(3);
      expect(result.artifacts.filter(({ type }) => type === 'table')).toHaveLength(3);
      expect(figures.find(({ title }) => title.startsWith('dose.tsv'))?.previewData).toMatchObject({ rows: 2, columns: 2 });
      expect(figures.find(({ title }) => title.startsWith('assay.json'))?.previewData).toMatchObject({ rows: 2, missing_values: 1 });
      expect(figures.find(({ title }) => title.startsWith('coordinates.pdb'))?.previewData).toMatchObject({ rows: 1, numeric_columns: 5 });
      expect(workbench.provenance.listReviews(session.id)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      workbench.dispose();
      temp.clean();
    }
  }, 30_000);

});
