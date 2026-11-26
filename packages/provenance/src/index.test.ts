import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HypothesisEvidence, NotebookDocument } from '@scideveloper/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvenanceStore } from './index.js';

describe('ProvenanceStore (DAG + 4-Layer Provenance + Forking + Bundle Export)', () => {
  it('records DAG nodes, 4-layer provenance, forks cleanly, and exports a reproducibility bundle', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-prov-'));
    const store = new ProvenanceStore(path.join(tmpDir, 'scideveloper.sqlite'));

    const session = store.createSession({
      title: 'RNA-seq Differential Expression',
      workspacePath: tmpDir,
    });

    const n1 = store.appendNode({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      agentName: 'Researcher',
      content: 'Analyze DEGs between treated and control samples.',
    });

    const n2 = store.appendNode({
      sessionId: session.id,
      parentId: n1.id,
      role: 'specialist',
      agentName: 'Genomics Specialist',
      specialistDomain: 'genomics',
      content: 'Computed log2FC and Benjamini-Hochberg FDR across 500 genes.',
      thinking: 'Compare the result across FDR thresholds.',
    });

    const figFile = path.join(tmpDir, 'volcano.svg');
    fs.writeFileSync(figFile, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>', 'utf8');

    const { artifact, provenance } = store.recordArtifactWithProvenance({
      sessionId: session.id,
      nodeId: n2.id,
      type: 'figure',
      title: 'Volcano Plot (Treated vs Control)',
      description: 'Log2 fold change vs -log10 adjusted p-value',
      mimeType: 'image/svg+xml',
      filePath: figFile,
      executionCode: {
        language: 'python',
        code: 'print("volcano generated")',
        stdout: 'volcano generated\n',
        exitCode: 0,
        durationMs: 42,
        editedByResearcher: true,
        executedAt: new Date().toISOString(),
      },
      environmentSnapshot: {
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        computeTargetId: 'local-sandbox',
        computeTargetKind: 'local-sandbox',
        pythonVersion: '3.12.4',
        packages: { numpy: '1.26.4', pandas: '2.2.2' },
        workingDirectory: tmpDir,
      },
      plainLanguageSummary: 'Differential expression was evaluated with Welch t-test and BH-FDR.',
    });

    expect(provenance.conversationalLineage).toHaveLength(2);
    expect(provenance.executionCode.codeSha256).toHaveLength(64);
    expect(store.getProvenanceByArtifact(artifact.id)?.executionCode.editedByResearcher).toBe(true);
    expect(artifact.sha256).toHaveLength(64);

    // Fork from n2 and verify isolation
    const forked = store.forkSession(session.id, n2.id, 'Alternative FDR Threshold');
    expect(forked.session.forkedFromSessionId).toBe(session.id);
    expect(forked.session.forkedFromNodeId).toBe(n2.id);
    expect(forked.nodes).toHaveLength(2);
    expect(forked.nodes[1].thinking).toBe(n2.thinking);
    expect(forked.artifacts).toHaveLength(1);
    expect(store.getProvenanceByArtifact(forked.artifacts[0].id)?.executionCode.editedByResearcher).toBe(true);

    // Export reproducibility bundle
    const bundle = store.exportReproducibilityBundle(artifact.id, path.join(tmpDir, 'exports'));
    expect(bundle.files.map((f) => f.name)).toContain('METHODS.md');
    expect(bundle.files.map((f) => f.name)).toContain('reproduce.py');
    expect(fs.existsSync(path.join(bundle.exportDir, 'provenance_manifest.json'))).toBe(true);

    // Verify SQLite app_config & custom specialist persistence
    store.setConfig('llm_settings', { provider: 'openai', model: 'gpt-4o' });
    expect(store.getConfig<{ provider: string; model: string }>('llm_settings')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
    store.saveCustomSpecialist({
      id: 'spec_onco',
      name: 'Oncology Statistician',
      domain: 'statistics',
      description: 'Survival & Cox modeling specialist',
      systemPrompt: 'Focus on Kaplan-Meier and Cox proportional hazards.',
      defaultSkills: ['statistical-validation'],
      createdAt: new Date().toISOString(),
    });
    expect(store.listCustomSpecialists()).toHaveLength(1);
    expect(store.deleteCustomSpecialist('spec_onco')).toBe(true);

    // Verify encrypted SecretVault NEVER writes plaintext API keys to SQLite
    const secretVal = 'sk-super-secret-test-key-987654321';
    store.setSecret('llm_api_key', secretVal);
    expect(store.getSecret('llm_api_key')).toBe(secretVal);
    const rawDbBuf = fs.readFileSync(store.dbPath);
    expect(rawDbBuf.includes(Buffer.from(secretVal, 'utf8'))).toBe(false);

    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('ProvenanceStore SQLite storage', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: ProvenanceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scidev-prov-'));
    dbPath = path.join(tmpDir, 'scideveloper.sqlite');
    store = new ProvenanceStore(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSession(title: string, projectId?: string | null) {
    return store.createSession({ title, workspacePath: tmpDir, projectId });
  }

  function appendNode(sessionId: string, content: string) {
    return store.appendNode({
      sessionId, content, parentId: null, role: 'coordinator', agentName: 'Coordinator',
    });
  }

  function recordArtifact(sessionId: string, nodeId: string, title: string, description: string) {
    const filePath = path.join(tmpDir, 'result.txt');
    fs.writeFileSync(filePath, 'Result');
    const now = new Date().toISOString();
    return store.recordArtifactWithProvenance({
      sessionId, nodeId, title, description, filePath, mimeType: 'text/plain', type: 'raw_data',
      executionCode: { language: 'python', code: 'print("Result")', executedAt: now },
      environmentSnapshot: {
        capturedAt: now,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        computeTargetId: 'local-sandbox',
        computeTargetKind: 'local-sandbox',
        packages: {},
        workingDirectory: tmpDir,
      },
      plainLanguageSummary: description,
    }).artifact;
  }

  describe('Research projects', () => {
    function saveMemory(title: string, projectId?: string, workspacePath?: string) {
      const scope = projectId !== undefined ? 'project' : workspacePath !== undefined ? 'workspace' : 'global';
      return store.saveMemoryItem({ scope, projectId, workspacePath, category: 'finding', title, content: '', tags: [] });
    }

    function addPaper(title: string, projectId?: string) {
      return store.addLiteraturePaper({ title, projectId, pages: [{ page: 1, text: 'Calibration protocol.' }] });
    }

    it('creates and updates projects with defaults, validates names, and lists pinned and archived projects', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01'));
      expect(() => store.createProject({ name: ' \t ', workspacePath: tmpDir })).toThrow('Project name cannot be empty');
      const first = store.createProject({ name: '  Calibration  ', workspacePath: tmpDir });
      expect(first).toMatchObject({
        id: expect.stringMatching(/^proj_[\da-f]{8}-[\da-f]{3}$/), name: 'Calibration', workspacePath: tmpDir,
        description: '', instructions: '', defaultComputeTargetId: 'local-sandbox', defaultSkills: [],
        pinned: false, archived: false, sessionCount: 0, memoryCount: 0, paperCount: 0, artifactCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(store.getProject(first.id)).toEqual(first);
      const second = store.createProject({ name: 'Validation', workspacePath: tmpDir, description: 'Initial study' });
      expect(store.listProjects()).toEqual([second, first]);

      vi.setSystemTime(new Date('2026-01-02'));
      const revised = store.updateProject(first.id, {
        name: '  Recalibration  ', description: 'Repeat runs', instructions: 'Use reference samples',
        workspacePath: '/next', defaultComputeTargetId: 'hpc', defaultSkills: ['statistics'], color: '#1c67c5', pinned: true,
      });
      expect(revised).toEqual({
        ...first, name: 'Recalibration', description: 'Repeat runs', instructions: 'Use reference samples',
        workspacePath: '/next', defaultComputeTargetId: 'hpc', defaultSkills: ['statistics'], color: '#1c67c5', pinned: true,
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      vi.setSystemTime(new Date('2026-01-03'));
      const newer = store.updateProject(second.id, { instructions: 'Check baseline' });
      expect(store.listProjects()).toEqual([revised, newer]);
      const archived = store.updateProject(first.id, { archived: true, instructions: '', defaultSkills: [] });
      expect(archived).toMatchObject({ archived: true, pinned: true, instructions: '', defaultSkills: [] });
      expect(store.listProjects()).toEqual([newer]);
      expect(store.listProjects({ includeArchived: true })).toEqual([archived, newer]);
      const reopened = store.updateProject(first.id, { archived: false, pinned: false });
      expect(store.listProjects()).toEqual([newer, reopened]);
      expect(() => store.updateProject(first.id, { name: '\n' })).toThrow('Project name cannot be empty');
      expect(() => store.updateProject('missing', {})).toThrow('Project not found');
      expect(store.getProject('missing')).toBeNull();
      expect(store.getProjectOverview('missing')).toBeNull();
    });

    it('scopes sessions and search, preserves project membership on fork, and moves artifacts with their session', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01'));
      const a = store.createProject({ name: 'A', workspacePath: tmpDir });
      const b = store.createProject({ name: 'B', workspacePath: tmpDir });
      vi.setSystemTime(new Date('2026-01-02'));
      const sessionA = createSession('Calibration A', a.id);
      expect(store.getProject(a.id)?.updatedAt).toBe(sessionA.createdAt);
      expect(store.getProject(b.id)?.updatedAt).toBe(b.updatedAt);
      const nodeA = appendNode(sessionA.id, 'Measure baseline');
      const artifactA = recordArtifact(sessionA.id, nodeA.id, 'Figure A', 'Current readout');
      vi.setSystemTime(new Date('2026-01-03'));
      expect(store.renameSession(sessionA.id, 'Calibration sample A').updatedAt).toBe(store.getProject(a.id)?.updatedAt);
      const fork = store.forkSession(sessionA.id, nodeA.id, 'Calibration fork');
      expect(fork.session).toMatchObject({ projectId: a.id, forkedFromSessionId: sessionA.id });
      expect(fork.artifacts).toHaveLength(1);
      vi.setSystemTime(new Date('2026-01-04'));
      const sessionB = createSession('Sample B', b.id);
      const nodeB = appendNode(sessionB.id, 'Calibration B');
      const artifactB = recordArtifact(sessionB.id, nodeB.id, 'Figure B', 'Current readout');
      const unassigned = createSession('Unassigned');
      const unassignedNode = appendNode(unassigned.id, 'Follow-up');
      recordArtifact(unassigned.id, unassignedNode.id, 'Calibration control', 'Current readout');
      expect(store.listSessions().map(({ id }) => id)).toEqual([unassigned.id, sessionB.id, fork.session.id, sessionA.id]);
      expect(store.listSessions({ projectId: a.id }).map(({ id }) => id)).toEqual([fork.session.id, sessionA.id]);
      expect(store.listSessions({ projectId: b.id }).map(({ id }) => id)).toEqual([sessionB.id]);
      expect(store.listSessions({ unassignedOnly: true })).toMatchObject([{ id: unassigned.id, projectId: null }]);
      expect(store.searchSessions('calibration')).toHaveLength(4);
      expect(store.searchSessions('calibration', 25, a.id).map(({ sessionId }) => sessionId)).toEqual([fork.session.id, sessionA.id]);
      expect(store.searchSessions('calibration', 1, b.id)).toMatchObject([{ sessionId: sessionB.id, matchKind: 'node' }]);
      expect(store.searchSessions('current readout', 25, b.id)).toMatchObject([
        { sessionId: sessionB.id, matchKind: 'artifact', artifactId: artifactB.id },
      ]);
      expect(store.searchSessions('calibration control', 25, b.id)).toEqual([]);
      expect(store.getProject(a.id)).toMatchObject({ sessionCount: 2, artifactCount: 2 });
      expect(store.listProjectArtifacts(a.id)).toEqual([fork.artifacts[0], artifactA]);

      vi.setSystemTime(new Date('2026-01-05'));
      store.updateNodeContent(nodeB.id, 'Calibration B updated');
      expect(store.getProject(b.id)?.updatedAt).toBe('2026-01-05T00:00:00.000Z');
      expect(() => store.moveSessionToProject(sessionA.id, 'missing')).toThrow('Project not found');
      expect(() => store.moveSessionToProject('missing', b.id)).toThrow('Session not found');
      vi.setSystemTime(new Date('2026-01-06'));
      const moved = store.moveSessionToProject(sessionA.id, b.id);
      expect(moved).toMatchObject({ projectId: b.id, updatedAt: '2026-01-06T00:00:00.000Z' });
      expect(store.getProject(b.id)).toMatchObject({ sessionCount: 2, artifactCount: 2, updatedAt: moved.updatedAt });
      expect(store.getProject(a.id)).toMatchObject({ sessionCount: 1, artifactCount: 1, updatedAt: moved.updatedAt });
      expect(store.listProjectArtifacts(b.id, 1)).toEqual([artifactB]);
      expect(store.searchSessions('calibration', 25, a.id).map(({ sessionId }) => sessionId)).toEqual([fork.session.id]);
      expect(store.moveSessionToProject(sessionA.id, null).projectId).toBeNull();
      expect(store.listProjectArtifacts(b.id)).toEqual([artifactB]);
      expect(store.listSessions({ unassignedOnly: true }).map(({ id }) => id)).toEqual([sessionA.id, unassigned.id]);
    });

    it('isolates project memories and papers while sharing global content and aggregating the overview', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01'));
      const a = store.createProject({ name: 'A', workspacePath: '/lab/shared' });
      const b = store.createProject({ name: 'B', workspacePath: '/lab/shared' });
      const sessionA = createSession('A session', a.id);
      const node = appendNode(sessionA.id, 'Calibration');
      const artifact = recordArtifact(sessionA.id, node.id, 'A figure', 'A result');
      createSession('B session', b.id);
      const global = saveMemory('Calibration global');
      const workspace = saveMemory('Calibration workspace', undefined, a.workspacePath);
      saveMemory('Calibration other workspace', undefined, '/lab/other');
      const draft = saveMemory('Calibration draft', b.id, a.workspacePath);
      const memoryA = store.saveMemoryItem({ ...draft, projectId: a.id, title: 'Calibration A' });
      const memoryB = saveMemory('Calibration B', b.id, a.workspacePath);
      const globalPaper = addPaper('Global paper');
      const paperA = addPaper('A paper', a.id);
      const paperB = addPaper('B paper', b.id);

      expect(store.listMemoryItems({ projectId: a.id })).toEqual([memoryA, global]);
      expect(store.listMemoryItems({ projectId: a.id, scope: 'project', workspacePath: '/other' })).toEqual([memoryA]);
      expect(store.listMemoryItems({ projectId: b.id, scope: 'project' })).toEqual([memoryB]);
      expect(store.listMemoryItems({ projectId: a.id, category: 'hypothesis' })).toEqual([]);
      expect(store.searchMemoryItems('calibration', a.workspacePath, 10, a.id)).toEqual([memoryA, workspace, global]);
      expect(store.searchMemoryItems('calibration', b.workspacePath, 10, b.id)).toEqual([memoryB, workspace, global]);
      expect(store.searchMemoryItems('calibration', a.workspacePath, 10, null)).toEqual([workspace, global]);
      expect(store.listLiteraturePapers()).toEqual([paperB, paperA, globalPaper]);
      expect(store.listLiteraturePapers({ projectId: a.id })).toEqual([paperA, globalPaper]);
      expect(store.listLiteraturePapers({ projectId: b.id, includeGlobal: false })).toEqual([paperB]);
      expect(store.searchLiteraturePassages('calibration', 8, a.id).map(({ paperId }) => paperId).sort())
        .toEqual([paperA.id, globalPaper.id].sort());
      expect(store.searchLiteraturePassages('calibration', 8, b.id).map(({ paperId }) => paperId).sort())
        .toEqual([paperB.id, globalPaper.id].sort());
      expect(store.searchLiteraturePassages('calibration', 8, null)).toMatchObject([{ paperId: globalPaper.id }]);

      const hydratedA = store.getProject(a.id);
      expect(hydratedA).toMatchObject({ sessionCount: 1, memoryCount: 1, paperCount: 1, artifactCount: 1 });
      expect(store.listProjects()).toMatchObject([
        { id: b.id, sessionCount: 1, memoryCount: 1, paperCount: 1, artifactCount: 0 }, hydratedA,
      ]);
      expect(store.getProjectOverview(a.id)).toEqual({
        project: hydratedA, sessions: [store.getSession(sessionA.id)], memories: [memoryA, workspace, global],
        papers: [paperA, globalPaper], recentArtifacts: [artifact], hypotheses: [],
      });
    });

    it('detaches project contents on deletion and keeps their provenance and indexed passages', () => {
      const project = store.createProject({ name: 'Detach', workspacePath: tmpDir });
      const session = createSession('Detach session', project.id);
      const node = appendNode(session.id, 'Keep');
      const artifact = recordArtifact(session.id, node.id, 'Keep figure', 'Keep description');
      const memory = saveMemory('Keep memory', project.id);
      const paper = addPaper('Keep paper', project.id);

      expect(store.deleteProject(project.id)).toBe(true);
      expect(store.deleteProject(project.id)).toBe(false);
      expect(store.getProject(project.id)).toBeNull();
      expect(store.getSessionTree(session.id)).toMatchObject({
        session: { projectId: null }, nodes: [{ id: node.id, artifactIds: [artifact.id] }], artifacts: [artifact],
      });
      expect(store.getProvenanceByArtifact(artifact.id)?.id).toBe(artifact.provenanceId);
      expect(store.listMemoryItems({ scope: 'global' })).toEqual([{ ...memory, scope: 'global', projectId: null }]);
      expect(store.getLiteraturePaper(paper.id)).toEqual({ ...paper, projectId: null });
      expect(store.searchLiteraturePassages('calibration', 8, null)).toMatchObject([{ paperId: paper.id }]);
    });

    it('rolls back a failed project deletion and cascades a retry through only its records', () => {
      const project = store.createProject({ name: 'Remove', workspacePath: tmpDir });
      const other = store.createProject({ name: 'Keep', workspacePath: tmpDir });
      const session = createSession('Remove session', project.id);
      const survivor = createSession('Keep session', other.id);
      const node = appendNode(session.id, 'Remove');
      const artifact = recordArtifact(session.id, node.id, 'Remove figure', 'Remove description');
      store.recordReviewReport({
        id: 'project-review', sessionId: session.id, nodeId: node.id, artifactIds: [artifact.id], overallStatus: 'pass',
        score: 100, summary: 'Confirmed', findings: [], verifiedCitations: [], createdAt: artifact.createdAt,
      });
      store.markSkillLoaded(session.id, 'statistics');
      const snapshot = store.createArtifactSnapshot({
        sessionId: session.id, artifactId: artifact.id, label: 'Initial', filePath: artifact.filePath, sha256: artifact.sha256,
      });
      const memory = saveMemory('Remove memory', project.id);
      const hypothesis = store.createHypothesis({ projectId: project.id, title: 'Remove', statement: 'A claim.' });
      const notebook = store.saveSessionNotebook({ sessionId: session.id, title: 'Remove', cells: [], updatedAt: '' });
      const sharedMemory = saveMemory('Keep global memory');
      const otherMemory = saveMemory('Keep private memory', other.id);
      const paper = addPaper('Remove paper', project.id);
      const sharedPaper = addPaper('Keep global paper');
      const otherPaper = addPaper('Keep private paper', other.id);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects
                 BEGIN SELECT RAISE(ABORT, 'project deletion rejected'); END;`);
        expect(() => store.deleteProject(project.id, { deleteSessions: true })).toThrow('project deletion rejected');
        expect(store.getProject(project.id)).toMatchObject({ sessionCount: 1, artifactCount: 1, memoryCount: 1, paperCount: 1 });
        expect(store.getArtifactSnapshot(snapshot.id)).toEqual(snapshot);
        expect(store.readLiteraturePassages(paper.id)).toHaveLength(1);
        expect(store.getHypothesis(hypothesis.id)).toEqual(hypothesis);
        expect(store.getSessionNotebook(session.id)).toEqual(notebook);
        expect(store.getLiteraturePage(paper.id, 1)?.text).toBe('Calibration protocol.');
        db.exec('DROP TRIGGER reject_project_delete');
      } finally {
        db.close();
      }

      expect(store.deleteProject(project.id, { deleteSessions: true })).toBe(true);
      expect(store.getSession(session.id)).toBeNull();
      expect(store.getNode(node.id)).toBeNull();
      expect(store.getArtifact(artifact.id)).toBeNull();
      expect(store.getProvenanceByArtifact(artifact.id)).toBeNull();
      expect(store.listReviews(session.id)).toEqual([]);
      expect(store.listLoadedSkills(session.id)).toEqual([]);
      expect(store.getArtifactSnapshot(snapshot.id)).toBeNull();
      expect(store.deleteMemoryItem(memory.id)).toBe(false);
      expect(store.getLiteraturePaper(paper.id)).toBeNull();
      expect(store.readLiteraturePassages(paper.id)).toEqual([]);
      expect(store.getLiteraturePage(paper.id, 1)).toBeUndefined();
      expect(store.getHypothesis(hypothesis.id)).toBeUndefined();
      expect(store.getSessionNotebook(session.id)).toBeUndefined();
      expect(store.getSession(survivor.id)).toEqual(survivor);
      expect(store.listMemoryItems({ projectId: other.id })).toEqual([otherMemory, sharedMemory]);
      expect(store.listLiteraturePapers({ projectId: other.id })).toEqual([otherPaper, sharedPaper]);
    });

    it('migrates a v0.4 database with existing sessions, memory, and literature and reopens cleanly', () => {
      const legacyPath = path.join(tmpDir, 'v04.sqlite');
      const legacy = new DatabaseSync(legacyPath);
      try {
        legacy.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
            root_node_id TEXT, active_node_id TEXT, forked_from_session_id TEXT, forked_from_node_id TEXT,
            compute_target_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0, compacted_up_to_node_id TEXT, compaction_summary TEXT, token_usage_json TEXT
          );
          CREATE TABLE research_memory (
            id TEXT PRIMARY KEY, scope TEXT NOT NULL, workspace_path TEXT, category TEXT NOT NULL, title TEXT NOT NULL,
            content TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', source_session_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE literature_papers (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, authors_json TEXT NOT NULL DEFAULT '[]',
            year INTEGER, journal TEXT, doi TEXT, pmid TEXT, file_path TEXT, page_count INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 0, sha256 TEXT, added_at TEXT NOT NULL
          );
          CREATE TABLE literature_chunks (
            id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, page INTEGER NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
            FOREIGN KEY (paper_id) REFERENCES literature_papers(id) ON DELETE CASCADE
          );
          INSERT INTO sessions (id, title, workspace_path, compute_target_id, created_at, updated_at, pinned)
          VALUES ('legacy-session', 'Legacy calibration', '/lab', 'local-sandbox', '2026-01-01', '2026-01-02', 1);
          INSERT INTO research_memory (id, scope, category, title, content, source_session_id, created_at, updated_at)
          VALUES ('legacy-memory', 'global', 'finding', 'Legacy memory', 'Calibration', 'legacy-session', '2026-01-01', '2026-01-02');
          INSERT INTO literature_papers (id, title, authors_json, page_count, chunk_count, added_at)
          VALUES ('legacy-paper', 'Legacy paper', '["A. Author"]', 1, 1, '2026-01-02');
          INSERT INTO literature_chunks VALUES ('legacy-chunk', 'legacy-paper', 7, 0, 'Legacy calibration protocol.');
        `);
      } finally {
        legacy.close();
      }

      const migrated = new ProvenanceStore(legacyPath);
      let projectId: string;
      try {
        expect(migrated.listProjects()).toEqual([]);
        expect(migrated.listSessions({ unassignedOnly: true })).toMatchObject([
          { id: 'legacy-session', title: 'Legacy calibration', projectId: null, pinned: true },
        ]);
        expect(migrated.listMemoryItems()).toMatchObject([
          { id: 'legacy-memory', scope: 'global', projectId: null, sourceSessionId: 'legacy-session' },
        ]);
        expect(migrated.getLiteraturePaper('legacy-paper')).toMatchObject({
          projectId: null, authors: ['A. Author'], pageCount: 1, chunkCount: 1,
        });
        projectId = migrated.createProject({ name: 'Migrated project', workspacePath: '/lab' }).id;
        migrated.moveSessionToProject('legacy-session', projectId);
        migrated.saveMemoryItem({
          scope: 'project', projectId, category: 'finding', title: 'Project memory', content: 'Calibration', tags: [],
        });
        migrated.addLiteraturePaper({ title: 'Project paper', projectId, pages: [{ page: 1, text: 'Calibration' }] });
      } finally {
        migrated.close();
      }

      const reopened = new ProvenanceStore(legacyPath);
      const schema = new DatabaseSync(legacyPath, { readOnly: true });
      try {
        expect(reopened.getProjectOverview(projectId)).toMatchObject({
          project: { sessionCount: 1, memoryCount: 1, paperCount: 1, artifactCount: 0 },
          sessions: [{ id: 'legacy-session', projectId }],
          memories: [{ title: 'Project memory', projectId }, { id: 'legacy-memory', projectId: null }],
          papers: [{ title: 'Project paper', projectId }, { id: 'legacy-paper', projectId: null }],
        });
        expect(reopened.readLiteraturePassages('legacy-paper')).toMatchObject([{ page: 7, text: 'Legacy calibration protocol.' }]);
        expect(schema.prepare('PRAGMA index_info(idx_sessions_project)').all().map(({ name }) => name))
          .toEqual(['project_id', 'updated_at']);
        expect(schema.prepare('PRAGMA index_info(idx_memory_project)').all().map(({ name }) => name))
          .toEqual(['project_id', 'updated_at']);
        expect(schema.prepare('PRAGMA index_info(idx_papers_project)').all().map(({ name }) => name))
          .toEqual(['project_id', 'added_at']);
      } finally {
        schema.close();
        reopened.close();
      }
    });
  });

  it('creates, orders, updates, and deletes hypotheses with project counts and evidence', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const project = store.createProject({ name: 'Calibration', workspacePath: tmpDir });
    const other = store.createProject({ name: 'Separate project', workspacePath: tmpDir });
    const session = createSession('Calibration notes', project.id);
    const supporting = {
      kind: 'supporting', summary: 'Matches calibration data.', sourceType: 'paper',
      sourceId: 'paper-reference', citation: 'Example et al.', grade: 'rct',
    } satisfies Omit<HypothesisEvidence, 'id' | 'createdAt'>;
    const first = store.createHypothesis({
      projectId: project.id, title: 'Instrument drift', statement: 'Drift depends on temperature.',
      evidence: [supporting], nextExperiment: 'Repeat under controlled temperature.', sourceSessionId: session.id,
    });
    expect(first).toMatchObject({
      projectId: project.id, title: 'Instrument drift', statement: 'Drift depends on temperature.',
      status: 'proposed', confidence: 50, nextExperiment: 'Repeat under controlled temperature.',
      sourceSessionId: session.id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      evidence: [{ ...supporting, id: expect.any(String), createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(store.getHypothesis(first.id)).toEqual(first);

    vi.setSystemTime(new Date('2026-01-02'));
    const second = store.createHypothesis({
      projectId: project.id, title: 'Alternative', statement: 'No temperature dependence.', status: 'testing', confidence: 0,
    });
    const separate = store.createHypothesis({ projectId: other.id, title: 'Separate', statement: 'Separate claim.' });
    expect(second).toMatchObject({ confidence: 0, status: 'testing', evidence: [] });
    expect(store.listHypotheses(project.id)).toEqual([second, first]);
    expect(store.listHypotheses(other.id)).toEqual([separate]);
    expect(store.getProject(project.id)?.hypothesisCount).toBe(2);
    expect(Object.fromEntries(store.listProjects().map(({ id, hypothesisCount }) => [id, hypothesisCount])))
      .toEqual({ [project.id]: 2, [other.id]: 1 });

    vi.setSystemTime(new Date('2026-01-03'));
    const updated = store.updateHypothesis(first.id, {
      title: 'Revised model', statement: 'Drift increases with temperature.', confidence: 80.4, status: 'supported',
    });
    expect(updated).toEqual({
      ...first, title: 'Revised model', statement: 'Drift increases with temperature.',
      confidence: 80, status: 'supported', updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(store.updateHypothesis(first.id, { nextExperiment: null })).toEqual({ ...updated, nextExperiment: undefined });
    expect(store.updateHypothesis(first.id, { nextExperiment: 'Use a reference.' })?.nextExperiment).toBe('Use a reference.');

    vi.setSystemTime(new Date('2026-01-04'));
    const contradicting = {
      id: 'recorded-evidence', createdAt: '2025-12-31T00:00:00.000Z', kind: 'contradicting',
      summary: 'Reference run showed no drift.', sourceType: 'artifact',
    } satisfies HypothesisEvidence;
    const withEvidence = store.addHypothesisEvidence(first.id, contradicting);
    expect(withEvidence).toMatchObject({
      evidence: [...first.evidence, contradicting], updatedAt: '2026-01-04T00:00:00.000Z',
    });
    const neutral = { kind: 'neutral', summary: 'Pending analysis.', sourceType: 'manual' } as const;
    const final = store.addHypothesisEvidence(first.id, neutral);
    expect(final?.evidence).toEqual([
      ...first.evidence, contradicting, { ...neutral, id: expect.any(String), createdAt: '2026-01-04T00:00:00.000Z' },
    ]);
    expect(store.getHypothesis(first.id)).toEqual(final);
    expect(store.getProjectOverview(project.id)).toMatchObject({
      project: { hypothesisCount: 2 }, hypotheses: [final, second],
    });
    expect(store.getHypothesis('missing')).toBeUndefined();
    expect(store.updateHypothesis('missing', { status: 'refuted' })).toBeUndefined();
    expect(store.addHypothesisEvidence('missing', neutral)).toBeUndefined();
    expect(store.deleteHypothesis(second.id)).toBe(true);
    expect(store.deleteHypothesis(second.id)).toBe(false);
    expect(store.getProject(project.id)?.hypothesisCount).toBe(1);

    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.listHypotheses(project.id)).toEqual([]);
    expect(store.getHypothesis(first.id)).toBeUndefined();
    expect(store.getSession(session.id)?.projectId).toBeNull();
    expect(store.getHypothesis(separate.id)).toEqual(separate);
  });

  it('upserts complete session notebooks across reopen and deletes them with their sessions', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const session = createSession('Notebook session');
    const other = createSession('Separate session');
    const notebook: NotebookDocument = {
      sessionId: session.id, title: 'Calibration', updatedAt: '2025-01-01T00:00:00.000Z',
      cells: [
        { id: 'intro', kind: 'markdown', language: 'markdown', source: '# Calibration', executionCount: null },
        {
          id: 'plot', kind: 'code', language: 'python', source: 'print(42)', executionCount: 1,
          sourceArtifactId: 'figure', sourceNodeId: 'node', editedByResearcher: true,
          output: {
            stdout: '42\n', stderr: '', exitCode: 0, durationMs: 15, artifactIds: ['figure'],
            imagesBase64: [{ mimeType: 'image/png', data: 'AA==', title: 'Calibration plot' }],
            executedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    };
    expect(store.getSessionNotebook(session.id)).toBeUndefined();
    expect(store.saveSessionNotebook(notebook)).toEqual({ ...notebook, updatedAt: '2026-01-01T00:00:00.000Z' });
    const survivor = store.saveSessionNotebook({ ...notebook, sessionId: other.id, cells: [] });
    vi.setSystemTime(new Date('2026-01-02'));
    const updated = store.saveSessionNotebook({ ...notebook, title: 'Updated', cells: notebook.cells.toReversed() });
    expect(updated).toEqual({
      ...notebook, title: 'Updated', cells: notebook.cells.toReversed(), updatedAt: '2026-01-02T00:00:00.000Z',
    });
    store.close();
    store = new ProvenanceStore(dbPath);
    expect(store.getSessionNotebook(session.id)).toEqual(updated);
    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSessionNotebook(session.id)).toBeUndefined();
    expect(store.getSessionNotebook(other.id)).toEqual(survivor);
  });

  it('renames and pins sessions, sorts each pin group by update time, and rejects missing sessions', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const first = createSession('First');
    expect(store.renameSession(first.id, '  Revised title  ').title).toBe('Revised title');
    expect(store.pinSession(first.id, true).pinned).toBe(true);
    vi.setSystemTime(new Date('2026-01-02'));
    const second = createSession('Second');
    store.pinSession(second.id, true);
    vi.setSystemTime(new Date('2026-01-03'));
    const third = createSession('Third');

    expect(store.listSessions().map(({ id }) => id)).toEqual([second.id, first.id, third.id]);
    expect(store.pinSession(second.id, false).pinned).toBe(false);
    expect(store.listSessions()[0].id).toBe(first.id);
    expect(() => store.renameSession(first.id, '  ')).toThrow('Session title cannot be empty');
    expect(() => store.renameSession('missing', 'Valid title')).toThrow('Session not found');
    expect(() => store.pinSession('missing', true)).toThrow('Session not found');
  });

  it('migrates a v0.3 session and node and persists thinking, compaction, and token usage across reopen', () => {
    const legacyPath = path.join(tmpDir, 'v03.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
          root_node_id TEXT, active_node_id TEXT, forked_from_session_id TEXT, forked_from_node_id TEXT,
          compute_target_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE session_nodes (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
          agent_name TEXT NOT NULL, specialist_domain TEXT, content TEXT NOT NULL, metadata_json TEXT,
          artifact_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        INSERT INTO sessions VALUES (
          'legacy', 'Legacy session', '/workspace', 'root', 'root', NULL, NULL, 'local-sandbox',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        );
        INSERT INTO session_nodes (id, session_id, role, agent_name, content, metadata_json, created_at)
        VALUES ('root', 'legacy', 'user', 'Researcher', 'Legacy message', '{"existing":true}', '2026-01-01T00:00:00Z');
      `);
    } finally {
      legacy.close();
    }

    const usage = {
      inputTokens: 120, outputTokens: 20, cachedTokens: 50, estimatedContextTokens: 300,
      contextWindowLimit: 10_000, updatedAt: '2026-01-02T00:00:00Z',
    };
    let migrated = new ProvenanceStore(legacyPath);
    try {
      expect(migrated.getSession('legacy')).toMatchObject({
        title: 'Legacy session', rootNodeId: 'root', pinned: false, compactedUpToNodeId: null, compactionSummary: null,
      });
      expect(migrated.getSession('legacy')?.tokenUsage).toBeUndefined();
      expect(migrated.getNode('root')).toMatchObject({ content: 'Legacy message', metadata: { existing: true } });
      expect(migrated.getNode('root')?.thinking).toBeUndefined();

      const node = migrated.appendNode({
        sessionId: 'legacy', parentId: 'root', role: 'coordinator', agentName: 'Coordinator',
        content: 'Draft', thinking: 'Initial reasoning.',
      });
      expect(migrated.getNode(node.id)?.thinking).toBe('Initial reasoning.');
      migrated.updateNodeContent(node.id, 'Revised draft', { streamed: true }, 'Final reasoning.\nSecond line.');
      migrated.updateNodeContent(node.id, 'Final answer', { finished: true });
      migrated.updateNodeContent('root', 'Legacy message', { reviewed: true }, '');
      migrated.pinSession('legacy', true);
      migrated.updateSessionCompaction('legacy', 'root', 'Summary of the earlier messages');
      migrated.updateSessionTokenUsage('legacy', usage);
      expect(() => migrated.updateSessionCompaction('missing', null, null)).toThrow('Session not found');
      expect(() => migrated.updateSessionTokenUsage('missing', usage)).toThrow('Session not found');

      migrated.close();
      migrated = new ProvenanceStore(legacyPath);
      expect(migrated.getSession('legacy')).toMatchObject({
        activeNodeId: node.id,
        pinned: true,
        compactedUpToNodeId: 'root',
        compactionSummary: 'Summary of the earlier messages',
        tokenUsage: usage,
      });
      expect(migrated.getNode(node.id)).toMatchObject({
        content: 'Final answer', thinking: 'Final reasoning.\nSecond line.', metadata: { streamed: true, finished: true },
      });
      expect(migrated.getNode('root')).toMatchObject({ thinking: '', metadata: { existing: true, reviewed: true } });
      migrated.updateNodeContent(node.id, 'Final answer', undefined, null);
      expect(migrated.getNode(node.id)?.thinking).toBeUndefined();
      expect(migrated.updateSessionCompaction('legacy', null, null)).toMatchObject({
        compactedUpToNodeId: null, compactionSummary: null, tokenUsage: usage,
      });
    } finally {
      migrated.close();
    }
  });

  it('searches titles, node content, and artifact titles and descriptions with one result per session', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const titleMatch = createSession('Über calibration protocol');
    appendNode(titleMatch.id, 'Über calibration also appears here.');
    vi.setSystemTime(new Date('2026-01-02'));
    const nodeMatch = createSession('Instrument notes');
    appendNode(nodeMatch.id, 'Older mention of Über Calibration.');
    const node = appendNode(nodeMatch.id, `${'Background '.repeat(25)}Observed Über\n calibration at baseline.`);
    vi.setSystemTime(new Date('2026-01-03'));
    const artifactTitleMatch = createSession('Artifacts with matching title');
    const titleNode = appendNode(artifactTitleMatch.id, '');
    const titleArtifact = recordArtifact(artifactTitleMatch.id, titleNode.id, 'Über calibration figure', 'A result.');
    vi.setSystemTime(new Date('2026-01-04'));
    const artifactDescriptionMatch = createSession('Artifacts with matching description');
    const descriptionNode = appendNode(artifactDescriptionMatch.id, '');
    const descriptionArtifact = recordArtifact(
      artifactDescriptionMatch.id, descriptionNode.id, 'Instrument figure', 'Result of Über calibration.',
    );
    appendNode(createSession('Unrelated').id, 'Contains a literal 10% adjustment.');

    const results = store.searchSessions('  ÜBER Calibration  ');
    expect(results.map(({ sessionId, matchKind }) => [sessionId, matchKind])).toEqual([
      [titleMatch.id, 'title'],
      [artifactDescriptionMatch.id, 'artifact'],
      [artifactTitleMatch.id, 'artifact'],
      [nodeMatch.id, 'node'],
    ]);
    expect(results[1]).toMatchObject({ artifactId: descriptionArtifact.id, snippet: 'Result of Über calibration.' });
    expect(results[2]).toMatchObject({ artifactId: titleArtifact.id, snippet: 'Über calibration figure' });
    expect(results[3]).toMatchObject({ nodeId: node.id, snippet: expect.stringMatching(/^….*Observed Über calibration at baseline\./) });
    expect(store.searchSessions('über calibration', 2)).toEqual(results.slice(0, 2));
    expect(store.searchSessions('10%')).toHaveLength(1);
    expect(store.searchSessions('%')).toHaveLength(1);
    expect(store.searchSessions(' ')).toEqual([]);
    expect(store.searchSessions('calibration', 0)).toEqual([]);
  });

  it('creates and retrieves artifact snapshots and cascades session deletion through its records', () => {
    const session = createSession('Delete this session');
    const node = appendNode(session.id, 'Findings');
    const artifact = recordArtifact(session.id, node.id, 'Results', 'Findings');
    const otherArtifact = recordArtifact(session.id, node.id, 'Details', 'Other findings');
    store.recordReviewReport({
      id: 'review', sessionId: session.id, nodeId: node.id, artifactIds: [artifact.id], overallStatus: 'pass',
      score: 100, summary: 'Confirmed', findings: [], verifiedCitations: [], createdAt: new Date().toISOString(),
    });
    store.markSkillLoaded(session.id, 'statistics');

    const snapshotFields = {
      sessionId: session.id, artifactId: artifact.id, filePath: artifact.filePath, sha256: artifact.sha256,
    };
    const first = store.createArtifactSnapshot({ ...snapshotFields, label: 'Version 1', code: 'print(1)' });
    const second = store.createArtifactSnapshot({ ...snapshotFields, label: 'Version 2', code: '' });
    const other = store.createArtifactSnapshot({ ...snapshotFields, artifactId: otherArtifact.id, label: 'Other' });
    expect(store.getArtifactSnapshot(first.id)).toEqual(first);
    expect(store.getArtifactSnapshot('missing')).toBeNull();
    expect(store.listArtifactSnapshots(session.id)).toEqual([other, second, first]);
    expect(store.listArtifactSnapshots(session.id, artifact.id)).toEqual([second, first]);
    const survivor = createSession('Keep this session');
    expect(store.listArtifactSnapshots(survivor.id)).toEqual([]);

    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.deleteSession(session.id)).toBe(false);
    expect(store.getSessionTree(session.id)).toBeNull();
    expect(store.getNode(node.id)).toBeNull();
    expect(store.getArtifact(artifact.id)).toBeNull();
    expect(store.getProvenanceByArtifact(artifact.id)).toBeNull();
    expect(store.listReviews(session.id)).toEqual([]);
    expect(store.listLoadedSkills(session.id)).toEqual([]);
    expect(store.listArtifactSnapshots(session.id)).toEqual([]);
    expect(store.getArtifactSnapshot(first.id)).toBeNull();
    expect(store.getSession(survivor.id)).toEqual(survivor);
  });

  it('upserts research memory, filters by workspace and scope, and ranks keyword matches', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const source = createSession('Source');
    const global = store.saveMemoryItem({
      scope: 'global', category: 'convention', title: 'House style', content: 'Plot using a logarithmic scale.',
      tags: ['figures'], sourceSessionId: source.id,
    });
    const local = store.saveMemoryItem({
      scope: 'workspace', workspacePath: '/lab/a', category: 'finding', title: 'Scale',
      content: 'Use a log transform.', tags: ['draft'],
    });
    const elsewhere = store.saveMemoryItem({
      scope: 'workspace', workspacePath: '/lab/b', category: 'finding', title: 'Calibration',
      content: 'Another workspace', tags: ['logarithmic'],
    });
    vi.setSystemTime(new Date('2026-01-02'));
    const revised = store.saveMemoryItem({
      id: local.id, scope: 'workspace', workspacePath: '/lab/a', category: 'finding', title: 'Logarithmic',
      content: 'Updated finding', tags: ['normalization', 'plotting'],
    });
    expect(revised).toMatchObject({ id: local.id, createdAt: local.createdAt, updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(store.listMemoryItems()).toHaveLength(3);
    expect(store.listMemoryItems({ workspacePath: '/lab/a' })).toEqual([revised, global]);
    expect(store.listMemoryItems({ workspacePath: '/lab/a', category: 'finding' })).toEqual([revised]);
    expect(store.listMemoryItems({ workspacePath: '/lab/a', scope: 'workspace' })).toEqual([revised]);
    expect(store.listMemoryItems({ workspacePath: '/lab/a', scope: 'global' })).toEqual([global]);
    expect(store.listMemoryItems({ scope: 'workspace' })).toEqual([revised, elsewhere]);
    expect(store.searchMemoryItems('LoGARITHMIC', '/lab/a')).toEqual([revised, global]);
    expect(store.searchMemoryItems('logarithmic')).toEqual([revised, elsewhere, global]);
    expect(store.searchMemoryItems('normalization', '/lab/a', 1)).toEqual([revised]);
    expect(store.searchMemoryItems('draft', '/lab/a')).toEqual([]);
    expect(store.deleteMemoryItem(revised.id)).toBe(true);
    expect(store.deleteMemoryItem(revised.id)).toBe(false);
    expect(store.searchMemoryItems('logarithmic', '/lab/a')).toEqual([global]);
  });

  it('indexes normalized PDF page text into overlapping chunks and ranks passages with exact source pages', () => {
    const longPage = Array.from({ length: 70 }, (_, i) => `Sample ${i} contains several observations.\n`).join(' ');
    const paper = store.addLiteraturePaper({
      title: 'Instrument Methods',
      authors: ['A. Researcher', 'B. Researcher'],
      journal: 'Example Journal',
      year: 2025,
      doi: '10.1234/example',
      pmid: '12345678',
      filePath: path.join(tmpDir, 'example.pdf'),
      sha256: 'paper-hash',
      pages: [
        { page: 7, text: ' \n\t Optical   calibration was repeated on all instruments.  ' },
        { page: 5, text: longPage },
        { page: 3, text: 'Calibration of the optical instrument was repeated.' },
        { page: 1, text: '\t\n ' },
      ],
    });
    const other = store.addLiteraturePaper({
      title: 'Technical Appendix',
      pages: [{ page: 12, text: 'Calibration calibration calibration results.' }],
    });

    const chunks = store.readLiteraturePassages(paper.id, 5);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.page).toBe(5);
      expect(chunk.text.length).toBeLessThanOrEqual(900);
      expect(chunk.text).not.toMatch(/\s{2,}|\n/);
      expect(chunk.score).toBe(0);
    }
    expect(chunks[1].text).toContain(chunks[0].text.split(' ').slice(-5).join(' '));
    expect(store.readLiteraturePassages(paper.id, 1)).toEqual([]);
    expect(store.readLiteraturePassages(paper.id).map(({ page }) => page)).toEqual([3, ...chunks.map(() => 5), 7]);
    expect(paper).toMatchObject({ pageCount: 4, chunkCount: chunks.length + 2 });
    expect(store.listLiteraturePapers()).toEqual([other, paper]);
    expect(store.getLiteraturePaper(paper.id)).toEqual(paper);
    expect(store.getLiteraturePaper('missing')).toBeNull();

    const results = store.searchLiteraturePassages('OPTICAL calibration');
    expect(results.map(({ page }) => page)).toEqual([7, 3, 12]);
    expect(results[0]).toMatchObject({
      paperId: paper.id, paperTitle: paper.title, doi: paper.doi, pmid: paper.pmid, chunkIndex: 0,
      text: expect.stringContaining('Optical calibration was repeated on all instruments.'),
    });
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
    expect(store.searchLiteraturePassages('optical calibration', 1)).toEqual(results.slice(0, 1));
    expect(store.searchLiteraturePassages('a !')).toEqual([]);
    expect(store.searchLiteraturePassages('absentterm')).toEqual([]);

    expect(store.deleteLiteraturePaper(paper.id)).toBe(true);
    expect(store.deleteLiteraturePaper(paper.id)).toBe(false);
    expect(store.getLiteraturePaper(paper.id)).toBeNull();
    expect(store.readLiteraturePassages(paper.id)).toEqual([]);
    expect(store.searchLiteraturePassages('optical')).toEqual([]);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS total FROM literature_chunks WHERE paper_id = ?').get(paper.id)?.total).toBe(0);
      expect(db.prepare('SELECT count(*) AS total FROM literature_pages WHERE paper_id = ?').get(paper.id)?.total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('combines exact, expanded, and trigram matches within the requested project scope', () => {
    const a = store.createProject({ name: 'A', workspacePath: tmpDir });
    const b = store.createProject({ name: 'B', workspacePath: tmpDir });
    const addPaper = (title: string, text: string, projectId?: string) =>
      store.addLiteraturePaper({ title, projectId, pages: [{ page: 1, text }] });
    const global = addPaper('Global', 'A REFRACTORY response.');
    const exact = addPaper('Exact', 'Resistance was observed.', a.id);
    const hybrid = addPaper('Hybrid', 'Resistance coincided with ESCAPE.', a.id);
    const other = addPaper('Private', 'Resistance or refractory features.', b.id);
    const morphology = addPaper('Morphology', 'Electrophoresis resolved several bands.');
    const combined = addPaper('Combined', 'Electrophoretic or electrophoresis measurements.', b.id);
    const cjk = addPaper('CJK', '通过研究发现肿瘤耐药机制可被描述');

    const scoped = store.searchLiteraturePassages('resistance', 6, a.id);
    expect(scoped).toHaveLength(3);
    expect(scoped[0]).toMatchObject({ paperId: hybrid.id, matchMode: 'hybrid', matchedTerms: ['resistance', 'escape'] });
    expect(scoped[1]).toMatchObject({ paperId: exact.id, matchMode: 'lexical', matchedTerms: ['resistance'] });
    expect(scoped[2]).toMatchObject({ paperId: global.id, matchMode: 'semantic', matchedTerms: ['refractory'] });
    expect(store.searchLiteraturePassages('resistance', 1, a.id)).toEqual(scoped.slice(0, 1));
    expect(store.searchLiteraturePassages('resistance', 6, 'unknown')).toMatchObject([{ paperId: global.id }]);
    expect(store.searchLiteraturePassages('resistance', 6, null)).toMatchObject([{ paperId: global.id }]);
    expect(store.searchLiteraturePassages('resistance', 6, b.id).map(({ paperId }) => paperId))
      .toEqual([other.id, global.id]);
    expect(store.searchLiteraturePassages('resistance').map(({ paperId }) => paperId))
      .toEqual(expect.arrayContaining([exact.id, hybrid.id, other.id, global.id]));
    expect(store.searchLiteraturePassages('electrophoretic', 6, null)).toMatchObject([
      { paperId: morphology.id, matchMode: 'semantic', matchedTerms: [] },
    ]);
    expect(store.searchLiteraturePassages('electrophoretic', 6, b.id)).toMatchObject([
      { paperId: combined.id, matchMode: 'hybrid', matchedTerms: ['electrophoretic'] },
      { paperId: morphology.id, matchMode: 'semantic', matchedTerms: [] },
    ]);
    expect(store.searchLiteraturePassages('耐药机制')).toMatchObject([
      { paperId: cjk.id, matchMode: 'semantic', matchedTerms: [] },
    ]);
    expect(store.searchLiteraturePassages('肿瘤')).toMatchObject([{ paperId: cjk.id, matchMode: 'semantic' }]);
    expect(store.searchLiteraturePassages('resistance', 0)).toEqual([]);

    for (let index = 0; index < 7; index++) addPaper('Reference', 'Refraction angles were recorded.');
    expect(store.searchLiteraturePassages('refraction')).toHaveLength(6);
  });

  it('returns original page text and case-insensitive, sorted, non-overlapping highlights', () => {
    const text = '🧪  ApopTosis\nPROGRAMMED Cell DEATH and SINGLE CELL assays; cellular signal.';
    const paper = store.addLiteraturePaper({
      title: 'Methods', pages: [
        { page: 1, text },
        { page: 2, text: ' \t\n ' },
        { page: 3, text: `${'PD‑1 '.repeat(64)}Checkpoint` },
      ],
    });
    const view = store.getLiteraturePage(paper.id, 1, 'APOPTOSIS cell');
    expect(view).toMatchObject({
      paper, page: 1, totalPages: 3, text, matchedTerms: ['apoptosis', 'programmed cell death', 'cell', 'single cell'],
    });
    expect(view?.highlightSpans).toEqual([
      { start: 4, end: 13, term: 'apoptosis' },
      { start: 14, end: 35, term: 'programmed cell death' },
      { start: 40, end: 51, term: 'single cell' },
    ]);
    expect(view?.highlightSpans.map(({ start, end }) => text.slice(start, end)))
      .toEqual(['ApopTosis', 'PROGRAMMED Cell DEATH', 'SINGLE CELL']);
    expect(store.getLiteraturePage(paper.id, 2)).toEqual({
      paper, page: 2, totalPages: 3, text: ' \t\n ', matchedTerms: [], highlightSpans: [],
    });
    const capped = store.getLiteraturePage(paper.id, 3, 'PD-1');
    expect(capped?.matchedTerms).toEqual(['pd-1', 'checkpoint']);
    expect(capped?.highlightSpans).toHaveLength(60);
    expect(capped?.highlightSpans[0]).toEqual({ start: 0, end: 4, term: 'pd-1' });
    expect(store.getLiteraturePage(paper.id, 4)).toBeUndefined();
    expect(store.getLiteraturePage('missing', 1)).toBeUndefined();
  });

  it('reopens a v0.4.1 schema and reconstructs legacy pages from ordered overlapping chunks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01'));
    const project = store.createProject({ name: 'Legacy project', workspacePath: tmpDir });
    const session = createSession('Legacy session', project.id);
    const text = Array.from({ length: 80 }, (_, i) => `Sample ${i} was measured.\n`).join(' ');
    const unbrokenText = '仪'.repeat(2400);
    const paper = store.addLiteraturePaper({
      title: 'Legacy paper', projectId: project.id, pages: [{ page: 2, text }, { page: 4, text: unbrokenText }],
    });
    expect(store.readLiteraturePassages(paper.id, 2).length).toBeGreaterThan(2);
    store.close();
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec('DROP TABLE project_hypotheses; DROP TABLE session_notebooks; DROP TABLE literature_pages;');
    } finally {
      legacy.close();
    }

    store = new ProvenanceStore(dbPath);
    expect(store.getProject(project.id)).toEqual({ ...project, sessionCount: 1, paperCount: 1 });
    expect(store.getSession(session.id)).toEqual(session);
    const legacyPage = store.getLiteraturePage(paper.id, 2, 'SAMPLE');
    expect(legacyPage).toMatchObject({
      paper, page: 2, totalPages: 2, text: text.replace(/\s+/g, ' ').trim(), matchedTerms: ['sample'],
    });
    expect(legacyPage?.highlightSpans[0]).toEqual({ start: 0, end: 6, term: 'sample' });
    expect(store.getLiteraturePage(paper.id, 4)?.text).toBe(unbrokenText);
    expect(store.getLiteraturePage(paper.id, 1)).toBeUndefined();
    expect(store.searchLiteraturePassages('sample', 1, project.id)).toMatchObject([{ paperId: paper.id, page: 2 }]);

    const hypothesis = store.createHypothesis({ projectId: project.id, title: 'New hypothesis', statement: 'A claim.' });
    const notebook = store.saveSessionNotebook({ sessionId: session.id, title: 'Migrated session', cells: [], updatedAt: '' });
    const newPaper = store.addLiteraturePaper({ title: 'New paper', projectId: project.id, pages: [{ page: 1, text }] });
    store.close();
    store = new ProvenanceStore(dbPath);
    expect(store.getProjectOverview(project.id)).toMatchObject({ project: { hypothesisCount: 1 }, hypotheses: [hypothesis] });
    expect(store.getSessionNotebook(session.id)).toEqual(notebook);
    expect(store.getLiteraturePage(newPaper.id, 1)?.text).toBe(text);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA index_xinfo(idx_hypotheses_project)').all().filter(({ key }) => key === 1))
        .toMatchObject([{ name: 'project_id', desc: 0 }, { name: 'updated_at', desc: 1 }]);
    } finally {
      db.close();
    }
  });

  it('rolls back a paper and its chunks if indexing fails partway through', () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_page BEFORE INSERT ON literature_chunks
        WHEN NEW.page = 2
        BEGIN SELECT RAISE(ABORT, 'page rejected'); END;
      `);
      expect(() => store.addLiteraturePaper({
        title: 'Test document', pages: [{ page: 1, text: 'first page' }, { page: 2, text: 'second page' }],
      })).toThrow('page rejected');
      expect(store.listLiteraturePapers()).toEqual([]);
      expect(db.prepare('SELECT count(*) AS total FROM literature_chunks').get()?.total).toBe(0);
      expect(db.prepare('SELECT count(*) AS total FROM literature_pages').get()?.total).toBe(0);
      db.exec('DROP TRIGGER reject_page');
      expect(store.addLiteraturePaper({ title: 'Retry', pages: [{ page: 1, text: 'first page' }] }).chunkCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('lists encrypted secret key names by literal prefix and keeps plaintext out of SQLite and its WAL', () => {
    const providerSecret = 'plaintext-provider-58e8d7b1-59a0-4b95';
    const connectorSecret = 'plaintext-connector-1d100d47-63a5-43ad';
    store.setSecret('llm_key:openai', providerSecret);
    store.setSecret('llm_key:research%_', providerSecret);
    store.setSecret('connector_key:pubmed', connectorSecret);
    store.setConfig('secret:llm_key:not_encrypted', { ciphertext: 'missing-encryption-metadata' });
    store.setConfig('llm_key:unrelated', true);

    expect(store.listSecretKeys()).toEqual(['connector_key:pubmed', 'llm_key:openai', 'llm_key:research%_']);
    expect(store.listSecretKeys('llm_key:')).toEqual(['llm_key:openai', 'llm_key:research%_']);
    expect(store.listSecretKeys('llm_key:research%_')).toEqual(['llm_key:research%_']);
    expect(store.listSecretKeys('llm_key:%')).toEqual([]);
    expect(store.getSecret('llm_key:openai')).toBe(providerSecret);
    expect(store.getSecret('connector_key:pubmed')).toBe(connectorSecret);
    expect(store.getSecret('llm_key:not_encrypted')).toBeNull();
    store.setSecret('llm_key:research%_', undefined);
    expect(store.listSecretKeys('llm_key:')).toEqual(['llm_key:openai']);

    const wal = fs.readFileSync(`${dbPath}-wal`);
    expect(wal.includes(Buffer.from('secret:llm_key:openai'))).toBe(true);
    for (const secret of [providerSecret, connectorSecret]) {
      expect(wal.includes(Buffer.from(secret))).toBe(false);
      expect(fs.readFileSync(dbPath).includes(Buffer.from(secret))).toBe(false);
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const checkpointedDb = fs.readFileSync(dbPath);
      expect(checkpointedDb.includes(Buffer.from('secret:llm_key:openai'))).toBe(true);
      for (const secret of [providerSecret, connectorSecret]) {
        expect(checkpointedDb.includes(Buffer.from(secret))).toBe(false);
      }
    } finally {
      db.close();
    }
    store.close();
    store = new ProvenanceStore(dbPath);
    expect(store.getSecret('llm_key:openai')).toBe(providerSecret);
  });
});
