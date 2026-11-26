import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createLiteratureQuery, highlightLiteratureText, rankLiteraturePassages } from './literature-search.js';
import { chunkPage, createKeywordScorer, joinPageChunks, normalizeSearchText, searchSnippet } from './search-text.js';
import { SecretVault, type EncryptedBlob } from './secret-vault.js';

export { SecretVault, type EncryptedBlob } from './secret-vault.js';
import type {
  AgentRole,
  ArtifactSnapshotRecord,
  ArtifactType,
  CustomSpecialist,
  EnvironmentSnapshot,
  ExecutionCodeRecord,
  HypothesisEvidence,
  HypothesisStatus,
  LineageStep,
  LiteraturePageView,
  LiteraturePaper,
  LiteraturePassage,
  NotebookCell,
  NotebookDocument,
  ProjectOverview,
  ProvenanceManifest,
  ReproducibilityBundle,
  ResearchHypothesis,
  ResearchMemoryCategory,
  ResearchMemoryItem,
  ResearchProject,
  ReviewReport,
  ReviewSeverity,
  ScientificArtifact,
  Session,
  SessionNode,
  SessionSearchResult,
  SessionTokenUsage,
  SessionTree,
  SlurmJobRecord,
  SpecialistDomain,
  VectorExportFiles,
} from '@scideveloper/shared';

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  instructions?: string;
  workspacePath: string;
  defaultComputeTargetId?: string;
  defaultSkills?: string[];
  color?: string;
  pinned?: boolean;
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, 'workspacePath'>> & {
  workspacePath?: string;
  archived?: boolean;
};

type NewHypothesisEvidence = Omit<HypothesisEvidence, 'id' | 'createdAt'>;

interface CreateHypothesisInput {
  projectId: string;
  title: string;
  statement: string;
  status?: HypothesisStatus;
  confidence?: number;
  evidence?: NewHypothesisEvidence[];
  nextExperiment?: string;
  sourceSessionId?: string;
}

type UpdateHypothesisInput = Partial<Pick<ResearchHypothesis, 'title' | 'statement' | 'status' | 'confidence'>> & {
  nextExperiment?: string | null;
};

function hypothesisConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) throw new RangeError('Hypothesis confidence must be finite');
  return Math.min(100, Math.max(0, Math.round(confidence)));
}

export interface CreateSessionInput {
  title: string;
  workspacePath: string;
  computeTargetId?: string;
  projectId?: string | null;
}

export interface AppendNodeInput {
  sessionId: string;
  parentId: string | null;
  role: AgentRole;
  agentName: string;
  specialistDomain?: SpecialistDomain;
  content: string;
  thinking?: string;
  metadata?: Record<string, unknown>;
}

interface AddLiteraturePaperInput {
  title: string;
  projectId?: string | null;
  authors?: string[];
  year?: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  filePath?: string;
  sha256?: string;
  pages: Array<{ page: number; text: string }>;
}

interface MemoryListOptions {
  workspacePath?: string;
  projectId?: string | null;
  scope?: ResearchMemoryItem['scope'];
  category?: ResearchMemoryCategory;
}

const projectsWithCountsSql = `
  SELECT p.*,
    (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
    (SELECT COUNT(*) FROM research_memory m WHERE m.project_id = p.id) AS memory_count,
    (SELECT COUNT(*) FROM literature_papers l WHERE l.project_id = p.id) AS paper_count,
    (SELECT COUNT(*) FROM project_hypotheses h WHERE h.project_id = p.id) AS hypothesis_count,
    (SELECT COUNT(*) FROM sessions s JOIN artifacts a ON a.session_id = s.id WHERE s.project_id = p.id) AS artifact_count
  FROM projects p
`;

const literaturePassagesSql = `
  SELECT c.paper_id, p.title AS paper_title, p.doi, p.pmid, c.page, c.chunk_index, c.content
  FROM literature_chunks c JOIN literature_papers p ON p.id = c.paper_id
`;

export interface RecordArtifactInput {
  sessionId: string;
  nodeId: string;
  type: ArtifactType;
  title: string;
  description: string;
  mimeType: string;
  filePath: string;
  previewData?: Record<string, unknown>;
  vectorExports?: VectorExportFiles;
  refinedFromArtifactId?: string;
  executionCode: Omit<ExecutionCodeRecord, 'codeSha256'>;
  environmentSnapshot: EnvironmentSnapshot;
  plainLanguageSummary: string;
  inputHashes?: Record<string, string>;
}

export class ProvenanceStore {
  private readonly db: DatabaseSync;
  public readonly dbPath: string;
  public readonly vault: SecretVault;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.vault = new SecretVault(dbPath === ':memory:' ? ':memory:' : path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      this.db.function('normalize_search_text', { deterministic: true }, (value) => normalizeSearchText(String(value)));
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL,
        default_compute_target_id TEXT NOT NULL DEFAULT 'local-sandbox',
        default_skills_json TEXT NOT NULL DEFAULT '[]',
        color TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        root_node_id TEXT,
        active_node_id TEXT,
        forked_from_session_id TEXT,
        forked_from_node_id TEXT,
        compute_target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_hypotheses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        confidence INTEGER NOT NULL DEFAULT 50,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        next_experiment TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_hypotheses_project ON project_hypotheses(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_notebooks (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cells_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_nodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        specialist_domain TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_session ON session_nodes(session_id, created_at);

      CREATE TABLE IF NOT EXISTS provenance_manifests (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        preview_json TEXT,
        provenance_id TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

      CREATE TABLE IF NOT EXISTS review_reports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_loaded_skills (
        session_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        loaded_at TEXT NOT NULL,
        PRIMARY KEY (session_id, skill_name),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slurm_jobs (
        id TEXT PRIMARY KEY,
        job_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_specialists (
        id TEXT PRIMARY KEY,
        specialist_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_memory (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_path TEXT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS literature_papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]',
        year INTEGER,
        journal TEXT,
        doi TEXT,
        pmid TEXT,
        file_path TEXT,
        page_count INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS literature_chunks (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (paper_id) REFERENCES literature_papers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_lit_chunks_paper ON literature_chunks(paper_id, page, chunk_index);

      CREATE TABLE IF NOT EXISTS literature_pages (
        paper_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (paper_id, page),
        FOREIGN KEY (paper_id) REFERENCES literature_papers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifact_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        label TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        code TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_snapshots_session ON artifact_snapshots(session_id, artifact_id);
    `);
    this.addColumn('artifacts', 'vector_exports_json', 'TEXT');
    this.addColumn('artifacts', 'refined_from_artifact_id', 'TEXT');
    this.addColumn('sessions', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('sessions', 'compacted_up_to_node_id', 'TEXT');
    this.addColumn('sessions', 'compaction_summary', 'TEXT');
    this.addColumn('sessions', 'token_usage_json', 'TEXT');
    this.addColumn('session_nodes', 'thinking', 'TEXT');
    this.addColumn('sessions', 'project_id', 'TEXT');
    this.addColumn('research_memory', 'project_id', 'TEXT');
    this.addColumn('literature_papers', 'project_id', 'TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_project ON research_memory(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_papers_project ON literature_papers(project_id, added_at);

      CREATE TRIGGER IF NOT EXISTS touch_project_on_session_insert
      AFTER INSERT ON sessions WHEN NEW.project_id IS NOT NULL
      BEGIN
        UPDATE projects SET updated_at = NEW.updated_at
        WHERE id = NEW.project_id AND updated_at < NEW.updated_at;
      END;

      CREATE TRIGGER IF NOT EXISTS touch_project_on_session_update
      AFTER UPDATE OF updated_at ON sessions
      WHEN NEW.project_id IS NOT NULL OR OLD.project_id IS NOT NULL
      BEGIN
        UPDATE projects SET updated_at = NEW.updated_at
        WHERE id IN (OLD.project_id, NEW.project_id) AND updated_at < NEW.updated_at;
      END;
    `);
  }

  private addColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((existing) => existing.name === column)) throw error;
    }
  }

  private transaction<T>(operation: () => T, begin: 'BEGIN' | 'BEGIN IMMEDIATE' = 'BEGIN IMMEDIATE'): T {
    this.db.exec(begin);
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction !== false) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createProject(input: CreateProjectInput): ResearchProject {
    const name = input.name.trim();
    if (!name) throw new Error('Project name cannot be empty');
    const now = new Date().toISOString();
    const project: ResearchProject = {
      id: `proj_${crypto.randomUUID().slice(0, 12)}`,
      name,
      description: input.description ?? '',
      instructions: input.instructions ?? '',
      workspacePath: input.workspacePath,
      defaultComputeTargetId: input.defaultComputeTargetId ?? 'local-sandbox',
      defaultSkills: input.defaultSkills ?? [],
      color: input.color,
      pinned: input.pinned ?? false,
      archived: false,
      sessionCount: 0,
      memoryCount: 0,
      paperCount: 0,
      artifactCount: 0,
      hypothesisCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO projects (id, name, description, instructions, workspace_path, default_compute_target_id,
                            default_skills_json, color, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, project.name, project.description, project.instructions, project.workspacePath,
      project.defaultComputeTargetId, JSON.stringify(project.defaultSkills), project.color ?? null,
      Number(project.pinned), now, now,
    );
    return project;
  }

  getProject(projectId: string): ResearchProject | null {
    const row = this.db.prepare(`${projectsWithCountsSql} WHERE p.id = ?`).get(projectId);
    return row ? this.rowToProject(row) : null;
  }

  listProjects(options?: { includeArchived?: boolean }): ResearchProject[] {
    const filter = options?.includeArchived ? '' : 'WHERE p.archived = 0';
    return this.db.prepare(`${projectsWithCountsSql} ${filter} ORDER BY p.pinned DESC, p.updated_at DESC, p.rowid DESC`)
      .all().map((row) => this.rowToProject(row));
  }

  updateProject(projectId: string, patch: UpdateProjectInput): ResearchProject {
    const name = patch.name?.trim();
    if (name === '') throw new Error('Project name cannot be empty');
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE projects SET
          name = COALESCE(?, name), description = COALESCE(?, description), instructions = COALESCE(?, instructions),
          workspace_path = COALESCE(?, workspace_path), default_compute_target_id = COALESCE(?, default_compute_target_id),
          default_skills_json = COALESCE(?, default_skills_json), color = COALESCE(?, color),
          pinned = COALESCE(?, pinned), archived = COALESCE(?, archived), updated_at = ?
        WHERE id = ?
      `).run(
        name ?? null, patch.description ?? null, patch.instructions ?? null, patch.workspacePath ?? null,
        patch.defaultComputeTargetId ?? null, patch.defaultSkills === undefined ? null : JSON.stringify(patch.defaultSkills),
        patch.color ?? null, patch.pinned === undefined ? null : Number(patch.pinned),
        patch.archived === undefined ? null : Number(patch.archived), new Date().toISOString(), projectId,
      );
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      return project;
    });
  }

  deleteProject(projectId: string, options?: { deleteSessions?: boolean }): boolean {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false;
      if (options?.deleteSessions === true) {
        this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId);
        this.db.prepare("DELETE FROM research_memory WHERE scope = 'project' AND project_id = ?").run(projectId);
        this.db.prepare('UPDATE research_memory SET project_id = NULL WHERE project_id = ?').run(projectId);
        this.db.prepare('DELETE FROM literature_papers WHERE project_id = ?').run(projectId);
      } else {
        this.db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(projectId);
        this.db.prepare('UPDATE literature_papers SET project_id = NULL WHERE project_id = ?').run(projectId);
        this.db.prepare("UPDATE research_memory SET scope = 'global', project_id = NULL WHERE project_id = ?").run(projectId);
      }
      return Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes) > 0;
    });
  }

  getProjectOverview(projectId: string): ProjectOverview | null {
    return this.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) return null;
      return {
        project,
        sessions: this.listSessions({ projectId }),
        memories: this.listMemoryItems({ projectId, workspacePath: project.workspacePath }),
        papers: this.listLiteraturePapers({ projectId }),
        recentArtifacts: this.listProjectArtifacts(projectId),
        hypotheses: this.listHypotheses(projectId),
      };
    }, 'BEGIN');
  }

  listHypotheses(projectId: string): ResearchHypothesis[] {
    return this.db.prepare('SELECT * FROM project_hypotheses WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC')
      .all(projectId).map((row) => this.rowToHypothesis(row));
  }

  getHypothesis(id: string): ResearchHypothesis | undefined {
    const row = this.db.prepare('SELECT * FROM project_hypotheses WHERE id = ?').get(id);
    return row ? this.rowToHypothesis(row) : undefined;
  }

  createHypothesis(input: CreateHypothesisInput): ResearchHypothesis {
    const now = new Date().toISOString();
    const evidence = (input.evidence ?? []).map((item) => ({
      ...item, id: `evid_${crypto.randomUUID()}`, createdAt: now,
    }));
    const row = this.db.prepare(`
      INSERT INTO project_hypotheses
        (id, project_id, title, statement, status, confidence, evidence_json, next_experiment,
         source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      `hyp_${crypto.randomUUID()}`, input.projectId, input.title, input.statement, input.status ?? 'proposed',
      hypothesisConfidence(input.confidence ?? 50), JSON.stringify(evidence), input.nextExperiment ?? null,
      input.sourceSessionId ?? null, now, now,
    );
    return this.rowToHypothesis(row!);
  }

  updateHypothesis(id: string, patch: UpdateHypothesisInput): ResearchHypothesis | undefined {
    const row = this.db.prepare(`
      UPDATE project_hypotheses
      SET title = COALESCE(?, title), statement = COALESCE(?, statement), status = COALESCE(?, status),
          confidence = COALESCE(?, confidence),
          next_experiment = CASE WHEN ? THEN ? ELSE next_experiment END,
          updated_at = ?
      WHERE id = ?
      RETURNING *
    `).get(
      patch.title ?? null, patch.statement ?? null, patch.status ?? null,
      patch.confidence === undefined ? null : hypothesisConfidence(patch.confidence),
      Number(patch.nextExperiment !== undefined), patch.nextExperiment ?? null, new Date().toISOString(), id,
    );
    return row ? this.rowToHypothesis(row) : undefined;
  }

  addHypothesisEvidence(
    hypothesisId: string,
    evidence: NewHypothesisEvidence & Partial<Pick<HypothesisEvidence, 'id' | 'createdAt'>>,
  ): ResearchHypothesis | undefined {
    return this.transaction(() => {
      const hypothesis = this.getHypothesis(hypothesisId);
      if (!hypothesis) return undefined;
      const now = new Date().toISOString();
      hypothesis.evidence.push({
        ...evidence, id: evidence.id ?? `evid_${crypto.randomUUID()}`, createdAt: evidence.createdAt ?? now,
      });
      this.db.prepare('UPDATE project_hypotheses SET evidence_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(hypothesis.evidence), now, hypothesisId);
      return { ...hypothesis, updatedAt: now };
    });
  }

  deleteHypothesis(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM project_hypotheses WHERE id = ?').run(id).changes) > 0;
  }

  createSession(input: CreateSessionInput): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: `sess_${crypto.randomUUID().slice(0, 12)}`,
      projectId: input.projectId ?? null,
      title: input.title,
      workspacePath: input.workspacePath,
      rootNodeId: null,
      activeNodeId: null,
      forkedFromSessionId: null,
      forkedFromNodeId: null,
      computeTargetId: input.computeTargetId ?? 'local-sandbox',
      pinned: false,
      compactedUpToNodeId: null,
      compactionSummary: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions
        (id, title, workspace_path, root_node_id, active_node_id, forked_from_session_id, forked_from_node_id, compute_target_id, created_at, updated_at, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.title,
        session.workspacePath,
        session.rootNodeId,
        session.activeNodeId,
        session.forkedFromSessionId ?? null,
        session.forkedFromNodeId ?? null,
        session.computeTargetId,
        session.createdAt,
        session.updatedAt,
        session.projectId ?? null
      );

    return session;
  }

  listSessions(options?: { projectId?: string | null; unassignedOnly?: boolean }): Session[] {
    let filter = '';
    const params: SQLInputValue[] = [];
    if (options?.unassignedOnly === true) {
      filter = 'WHERE project_id IS NULL';
    } else if (typeof options?.projectId === 'string') {
      filter = 'WHERE project_id = ?';
      params.push(options.projectId);
    }
    return this.db.prepare(`SELECT * FROM sessions ${filter} ORDER BY pinned DESC, updated_at DESC, rowid DESC`)
      .all(...params).map((row) => this.rowToSession(row));
  }

  getSession(sessionId: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  updateSessionComputeTarget(sessionId: string, computeTargetId: string): Session {
    return this.updateSession(sessionId, 'compute_target_id = ?', computeTargetId);
  }

  moveSessionToProject(sessionId: string, projectId: string | null): Session {
    return this.transaction(() => {
      if (projectId !== null && !this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        throw new Error(`Project not found: ${projectId}`);
      }
      return this.updateSession(sessionId, 'project_id = ?', projectId);
    });
  }

  renameSession(sessionId: string, title: string): Session {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) throw new Error('Session title cannot be empty');
    return this.updateSession(sessionId, 'title = ?', trimmedTitle);
  }

  deleteSession(sessionId: string): boolean {
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes) > 0;
  }

  getSessionNotebook(sessionId: string): NotebookDocument | undefined {
    const row = this.db.prepare('SELECT title, cells_json, updated_at FROM session_notebooks WHERE session_id = ?')
      .get(sessionId);
    if (!row) return undefined;
    return {
      sessionId,
      title: String(row.title),
      cells: JSON.parse(String(row.cells_json)) as NotebookCell[],
      updatedAt: String(row.updated_at),
    };
  }

  saveSessionNotebook(doc: NotebookDocument): NotebookDocument {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_notebooks (session_id, title, cells_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        title = excluded.title,
        cells_json = excluded.cells_json,
        updated_at = excluded.updated_at
    `).run(doc.sessionId, doc.title, JSON.stringify(doc.cells), updatedAt);
    return { ...doc, updatedAt };
  }

  pinSession(sessionId: string, pinned: boolean): Session {
    return this.updateSession(sessionId, 'pinned = ?', Number(pinned));
  }

  updateSessionCompaction(sessionId: string, compactedUpToNodeId: string | null, summary: string | null): Session {
    return this.updateSession(sessionId, 'compacted_up_to_node_id = ?, compaction_summary = ?', compactedUpToNodeId, summary);
  }

  updateSessionTokenUsage(sessionId: string, usage: SessionTokenUsage): Session {
    return this.updateSession(sessionId, 'token_usage_json = ?', JSON.stringify(usage));
  }

  private updateSession(sessionId: string, assignments: string, ...values: SQLInputValue[]): Session {
    const row = this.db
      .prepare(`UPDATE sessions SET ${assignments}, updated_at = ? WHERE id = ? RETURNING *`)
      .get(...values, new Date().toISOString(), sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return this.rowToSession(row);
  }

  searchSessions(query: string, limit = 25, projectId?: string | null): SessionSearchResult[] {
    const needle = normalizeSearchText(query);
    if (!needle || !Number.isSafeInteger(Math.trunc(limit)) || limit < 1) return [];
    const params: Record<string, SQLInputValue> = { ':needle': needle, ':limit': Math.trunc(limit) };
    const projectFilter = typeof projectId === 'string' ? 'AND s.project_id = :projectId' : '';
    if (typeof projectId === 'string') params[':projectId'] = projectId;

    // Prefer one title match per session, then its latest matching node or artifact.
    const rows = this.db.prepare(`
      WITH matches(session_id, kind, node_id, artifact_id, priority, matched_at, matched_rowid) AS (
        SELECT id, 'title', NULL, NULL, 0, updated_at, rowid
        FROM sessions WHERE instr(normalize_search_text(title), :needle) > 0
        UNION ALL
        SELECT session_id, 'node', id, NULL, 1, created_at, rowid
        FROM session_nodes WHERE instr(normalize_search_text(content), :needle) > 0
        UNION ALL
        SELECT session_id, 'artifact', node_id, id, 1, created_at, rowid
        FROM artifacts
        WHERE instr(normalize_search_text(title), :needle) > 0
           OR instr(normalize_search_text(description), :needle) > 0
      ), ranked_matches AS (
        SELECT *, row_number() OVER (
          PARTITION BY session_id ORDER BY priority, matched_at DESC, matched_rowid DESC, kind, node_id, artifact_id
        ) AS match_rank
        FROM matches
      )
      SELECT s.id, s.title, s.updated_at, m.kind, m.node_id, m.artifact_id,
        CASE
          WHEN m.kind = 'title' THEN s.title
          WHEN m.kind = 'node' THEN n.content
          WHEN instr(normalize_search_text(a.title), :needle) > 0 THEN a.title
          ELSE a.description
        END AS text
      FROM ranked_matches m JOIN sessions s ON s.id = m.session_id
      LEFT JOIN session_nodes n ON m.kind = 'node' AND n.id = m.node_id
      LEFT JOIN artifacts a ON a.id = m.artifact_id
      WHERE m.match_rank = 1 ${projectFilter}
      ORDER BY m.priority, s.updated_at DESC, s.rowid DESC
      LIMIT :limit
    `).all(params);

    return rows.map((row) => ({
      sessionId: String(row.id),
      title: String(row.title),
      updatedAt: String(row.updated_at),
      snippet: searchSnippet(String(row.text), needle),
      matchKind: row.kind as SessionSearchResult['matchKind'],
      nodeId: row.node_id == null ? undefined : String(row.node_id),
      artifactId: row.artifact_id == null ? undefined : String(row.artifact_id),
    }));
  }

  appendNode(input: AppendNodeInput): SessionNode {
    const now = new Date().toISOString();
    const node: SessionNode = {
      id: `node_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: input.sessionId,
      parentId: input.parentId,
      role: input.role,
      agentName: input.agentName,
      specialistDomain: input.specialistDomain,
      content: input.content,
      thinking: input.thinking,
      metadata: input.metadata,
      artifactIds: [],
      createdAt: now,
    };

    return this.transaction(() => {
      const result = this.db
        .prepare(`UPDATE sessions SET root_node_id = COALESCE(root_node_id, ?), active_node_id = ?, updated_at = ? WHERE id = ?`)
        .run(node.id, node.id, now, input.sessionId);
      if (!result.changes) throw new Error(`Session not found: ${input.sessionId}`);
      this.insertNode(node);
      return node;
    });
  }

  private insertNode(node: SessionNode): void {
    this.db
      .prepare(
        `INSERT INTO session_nodes
        (id, session_id, parent_id, role, agent_name, specialist_domain, content, thinking, metadata_json, artifact_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.sessionId,
        node.parentId,
        node.role,
        node.agentName,
        node.specialistDomain ?? null,
        node.content,
        node.thinking ?? null,
        node.metadata ? JSON.stringify(node.metadata) : null,
        JSON.stringify(node.artifactIds),
        node.createdAt
      );
  }

  updateNodeContent(nodeId: string, content: string, metadata?: Record<string, unknown>, thinking?: string | null): SessionNode {
    return this.transaction(() => {
      const existing = this.getNode(nodeId);
      if (!existing) throw new Error(`Node not found: ${nodeId}`);
      const mergedMeta = metadata ? { ...existing.metadata, ...metadata } : existing.metadata;
      const updatedThinking = thinking === undefined ? existing.thinking : thinking ?? undefined;
      this.db
        .prepare(`UPDATE session_nodes SET content = ?, metadata_json = ?, thinking = ? WHERE id = ?`)
        .run(content, mergedMeta ? JSON.stringify(mergedMeta) : null, updatedThinking ?? null, nodeId);
      this.db
        .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), existing.sessionId);
      return { ...existing, content, metadata: mergedMeta, thinking: updatedThinking };
    });
  }

  getNode(nodeId: string): SessionNode | null {
    const row = this.db
      .prepare(`SELECT * FROM session_nodes WHERE id = ?`)
      .get(nodeId) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  listNodes(sessionId: string): SessionNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM session_nodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToNode(r));
  }

  /**
   * Walks the DAG from the target node back to root and returns ordered lineage steps.
   */
  getLineagePath(nodeId: string): SessionNode[] {
    const pathNodes: SessionNode[] = [];
    const seen = new Set<string>();
    let current = this.getNode(nodeId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      pathNodes.push(current);
      current = current.parentId ? this.getNode(current.parentId) : null;
    }
    return pathNodes.reverse();
  }

  /**
   * Forks a new independent session from any node in an existing session,
   * preserving the exact ancestor path and referenced artifacts without mutating the source audit trail.
   */
  forkSession(sourceSessionId: string, fromNodeId: string, newTitle?: string): SessionTree {
    return this.transaction(() => this.cloneSessionBranch(sourceSessionId, fromNodeId, newTitle));
  }

  private cloneSessionBranch(sourceSessionId: string, fromNodeId: string, newTitle?: string): SessionTree {
    const source = this.getSession(sourceSessionId);
    if (!source) throw new Error(`Source session not found: ${sourceSessionId}`);

    const lineage = this.getLineagePath(fromNodeId);
    if (lineage.length === 0 || lineage[lineage.length - 1].sessionId !== sourceSessionId) {
      throw new Error(`Node ${fromNodeId} does not belong to session ${sourceSessionId}`);
    }

    const now = new Date().toISOString();
    const forkedId = `sess_${crypto.randomUUID().slice(0, 12)}`;
    const title = newTitle ?? `${source.title} (Fork @ ${fromNodeId.slice(-6)})`;

    this.db
      .prepare(
        `INSERT INTO sessions
        (id, title, workspace_path, root_node_id, active_node_id, forked_from_session_id, forked_from_node_id, compute_target_id, created_at, updated_at, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        forkedId,
        title,
        source.workspacePath,
        null,
        null,
        sourceSessionId,
        fromNodeId,
        source.computeTargetId,
        now,
        now,
        source.projectId ?? null
      );

    const nodeIdMap = new Map<string, string>();
    let firstNewId: string | null = null;
    let lastNewId: string | null = null;

    for (const orig of lineage) {
      const clonedId = `node_${crypto.randomUUID().slice(0, 12)}`;
      nodeIdMap.set(orig.id, clonedId);
      if (!firstNewId) firstNewId = clonedId;
      lastNewId = clonedId;

      const mappedParent = orig.parentId ? nodeIdMap.get(orig.parentId) ?? null : null;
      this.insertNode({
        ...orig,
        id: clonedId,
        sessionId: forkedId,
        parentId: mappedParent,
        metadata: { ...orig.metadata, forkedFromNodeId: orig.id },
        artifactIds: [],
      });

      // Clone artifacts and provenance manifests bound to this lineage node
      for (const origArtId of orig.artifactIds) {
        const origArt = this.getArtifact(origArtId);
        const origProv = origArt ? this.getProvenanceByArtifact(origArtId) : null;
        if (origArt && origProv) {
          const newArtId = `art_${crypto.randomUUID().slice(0, 12)}`;
          const newProvId = `prov_${crypto.randomUUID().slice(0, 12)}`;
          const clonedManifest: ProvenanceManifest = {
            ...origProv,
            id: newProvId,
            artifactId: newArtId,
            sessionId: forkedId,
            nodeId: clonedId,
          };
          this.db
            .prepare(
              `INSERT INTO provenance_manifests (id, artifact_id, session_id, node_id, manifest_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(newProvId, newArtId, forkedId, clonedId, JSON.stringify(clonedManifest), origProv.createdAt);

          this.db
            .prepare(
              `INSERT INTO artifacts
              (id, session_id, node_id, type, title, description, mime_type, file_path, file_size_bytes, sha256, preview_json, provenance_id, review_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              newArtId,
              forkedId,
              clonedId,
              origArt.type,
              origArt.title,
              origArt.description,
              origArt.mimeType,
              origArt.filePath,
              origArt.fileSizeBytes,
              origArt.sha256,
              origArt.previewData ? JSON.stringify(origArt.previewData) : null,
              newProvId,
              origArt.reviewStatus,
              origArt.createdAt
            );

          this.attachArtifactIdToNode(clonedId, newArtId);
        }
      }
    }

    // Copy loaded skills
    const skills = this.listLoadedSkills(sourceSessionId);
    for (const s of skills) {
      this.markSkillLoaded(forkedId, s);
    }

    this.db
      .prepare(`UPDATE sessions SET root_node_id = ?, active_node_id = ?, updated_at = ? WHERE id = ?`)
      .run(firstNewId, lastNewId, now, forkedId);

    const tree = this.getSessionTree(forkedId);
    if (!tree) throw new Error('Failed to load forked session tree');
    return tree;
  }

  recordArtifactWithProvenance(input: RecordArtifactInput): {
    artifact: ScientificArtifact;
    provenance: ProvenanceManifest;
  } {
    const stat = fs.statSync(input.filePath);
    const outputSha256 = sha256File(input.filePath);
    const codeSha256 = sha256Text(input.executionCode.code);

    const lineageNodes = this.getLineagePath(input.nodeId);
    const conversationalLineage: LineageStep[] = lineageNodes.map((n) => ({
      nodeId: n.id,
      role: n.role,
      agentName: n.agentName,
      summary: n.content.slice(0, 280),
      createdAt: n.createdAt,
    }));

    const now = new Date().toISOString();
    const artifactId = `art_${crypto.randomUUID().slice(0, 12)}`;
    const provenanceId = `prov_${crypto.randomUUID().slice(0, 12)}`;

    const provenance: ProvenanceManifest = {
      id: provenanceId,
      artifactId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      executionCode: {
        ...input.executionCode,
        codeSha256,
      },
      environmentSnapshot: input.environmentSnapshot,
      conversationalLineage,
      plainLanguageSummary: input.plainLanguageSummary,
      inputHashes: input.inputHashes ?? {},
      outputSha256,
      createdAt: now,
    };

    const artifact: ScientificArtifact = {
      id: artifactId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      type: input.type,
      title: input.title,
      description: input.description,
      mimeType: input.mimeType,
      filePath: input.filePath,
      fileSizeBytes: stat.size,
      sha256: outputSha256,
      previewData: input.previewData,
      vectorExports: input.vectorExports,
      refinedFromArtifactId: input.refinedFromArtifactId,
      provenanceId,
      reviewStatus: 'pending',
      createdAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO provenance_manifests (id, artifact_id, session_id, node_id, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(provenanceId, artifactId, input.sessionId, input.nodeId, JSON.stringify(provenance), now);

    this.db
      .prepare(
        `INSERT INTO artifacts
        (id, session_id, node_id, type, title, description, mime_type, file_path, file_size_bytes, sha256, preview_json, vector_exports_json, refined_from_artifact_id, provenance_id, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.id,
        artifact.sessionId,
        artifact.nodeId,
        artifact.type,
        artifact.title,
        artifact.description,
        artifact.mimeType,
        artifact.filePath,
        artifact.fileSizeBytes,
        artifact.sha256,
        artifact.previewData ? JSON.stringify(artifact.previewData) : null,
        artifact.vectorExports ? JSON.stringify(artifact.vectorExports) : null,
        artifact.refinedFromArtifactId ?? null,
        artifact.provenanceId,
        artifact.reviewStatus,
        artifact.createdAt
      );

    this.attachArtifactIdToNode(input.nodeId, artifactId);
    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(now, input.sessionId);

    return { artifact, provenance };
  }

  private attachArtifactIdToNode(nodeId: string, artifactId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (!node.artifactIds.includes(artifactId)) {
      const updated = [...node.artifactIds, artifactId];
      this.db
        .prepare(`UPDATE session_nodes SET artifact_ids_json = ? WHERE id = ?`)
        .run(JSON.stringify(updated), nodeId);
    }
  }

  getArtifact(artifactId: string): ScientificArtifact | null {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(artifactId) as Record<string, unknown> | undefined;
    return row ? this.rowToArtifact(row) : null;
  }

  listArtifacts(sessionId: string): ScientificArtifact[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToArtifact(r));
  }

  listProjectArtifacts(projectId: string, limit = 40): ScientificArtifact[] {
    if (!Number.isSafeInteger(Math.trunc(limit)) || limit < 1) return [];
    return this.db.prepare(`
      SELECT a.* FROM artifacts a JOIN sessions s ON s.id = a.session_id
      WHERE s.project_id = ?
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT ?
    `).all(projectId, Math.trunc(limit)).map((row) => this.rowToArtifact(row));
  }

  getProvenanceByArtifact(artifactId: string): ProvenanceManifest | null {
    const row = this.db
      .prepare(`SELECT manifest_json FROM provenance_manifests WHERE artifact_id = ?`)
      .get(artifactId) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as ProvenanceManifest) : null;
  }

  updateArtifactReviewStatus(artifactId: string, status: ReviewSeverity): void {
    this.db
      .prepare(`UPDATE artifacts SET review_status = ? WHERE id = ?`)
      .run(status, artifactId);
  }

  recordReviewReport(report: ReviewReport): ReviewReport {
    this.db
      .prepare(
        `INSERT INTO review_reports (id, session_id, node_id, report_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(report.id, report.sessionId, report.nodeId, JSON.stringify(report), report.createdAt);

    for (const artId of report.artifactIds) {
      this.updateArtifactReviewStatus(artId, report.overallStatus);
    }
    return report;
  }

  listReviews(sessionId: string): ReviewReport[] {
    const rows = this.db
      .prepare(`SELECT report_json FROM review_reports WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(sessionId) as Array<{ report_json: string }>;
    return rows.map((r) => JSON.parse(r.report_json) as ReviewReport);
  }

  markSkillLoaded(sessionId: string, skillName: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_loaded_skills (session_id, skill_name, loaded_at)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, skillName, new Date().toISOString());
  }

  listLoadedSkills(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT skill_name FROM session_loaded_skills WHERE session_id = ? ORDER BY loaded_at ASC`)
      .all(sessionId) as Array<{ skill_name: string }>;
    return rows.map((r) => r.skill_name);
  }

  getSessionTree(sessionId: string): SessionTree | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return {
      session,
      nodes: this.listNodes(sessionId),
      artifacts: this.listArtifacts(sessionId),
      reviews: this.listReviews(sessionId),
      loadedSkills: this.listLoadedSkills(sessionId),
    };
  }

  saveMemoryItem(input: Omit<ResearchMemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ResearchMemoryItem {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      INSERT INTO research_memory
        (id, scope, project_id, workspace_path, category, title, content, tags_json, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        project_id = excluded.project_id,
        workspace_path = excluded.workspace_path,
        category = excluded.category,
        title = excluded.title,
        content = excluded.content,
        tags_json = excluded.tags_json,
        source_session_id = excluded.source_session_id,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      input.id ?? `mem_${crypto.randomUUID()}`,
      input.scope,
      input.projectId ?? null,
      input.workspacePath ?? null,
      input.category,
      input.title,
      input.content,
      JSON.stringify(input.tags),
      input.sourceSessionId ?? null,
      now,
      now
    );
    return this.rowToMemoryItem(row!);
  }

  listMemoryItems(options?: MemoryListOptions): ResearchMemoryItem[] {
    const { scope, workspacePath, projectId, category } = options ?? {};
    const rows = this.db.prepare(`
      SELECT * FROM research_memory
      WHERE (:scope IS NULL OR scope = :scope)
        AND CASE WHEN :hasProjectContext THEN
          scope = 'global'
          OR (scope = 'project' AND project_id = :projectId)
          OR (scope = 'workspace' AND workspace_path = :workspace)
        ELSE
          :workspace IS NULL OR scope = 'global' OR workspace_path = :workspace
        END
        AND (:category IS NULL OR category = :category)
      ORDER BY updated_at DESC, rowid DESC
    `).all({
      ':scope': scope ?? null,
      ':workspace': workspacePath ?? null,
      ':projectId': projectId ?? null,
      ':hasProjectContext': Number(projectId !== undefined),
      ':category': category ?? null,
    });
    return rows.map((row) => this.rowToMemoryItem(row));
  }

  searchMemoryItems(query: string, workspacePath?: string, limit = 10, projectId?: string | null): ResearchMemoryItem[] {
    const scoreText = createKeywordScorer(query, 1);
    if (!scoreText || !(limit >= 1)) return [];
    return this.listMemoryItems({ workspacePath, projectId })
      .map((item) => ({
        item,
        score: 3 * scoreText(item.title) + scoreText(item.content) + 2 * scoreText(item.tags.join(' ')),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  deleteMemoryItem(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM research_memory WHERE id = ?').run(id).changes) > 0;
  }

  addLiteraturePaper(input: AddLiteraturePaperInput): LiteraturePaper {
    const pages = input.pages.map(({ page, text }) => ({ page, text, chunks: chunkPage(text) }));
    const paper: LiteraturePaper = {
      id: `paper_${crypto.randomUUID()}`,
      projectId: input.projectId ?? null,
      title: input.title,
      authors: input.authors ?? [],
      year: input.year,
      journal: input.journal,
      doi: input.doi,
      pmid: input.pmid,
      filePath: input.filePath,
      pageCount: pages.length,
      chunkCount: pages.reduce((total, page) => total + page.chunks.length, 0),
      sha256: input.sha256,
      addedAt: new Date().toISOString(),
    };

    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO literature_papers
          (id, project_id, title, authors_json, year, journal, doi, pmid, file_path, page_count, chunk_count, sha256, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        paper.id,
        paper.projectId ?? null,
        paper.title,
        JSON.stringify(paper.authors),
        paper.year ?? null,
        paper.journal ?? null,
        paper.doi ?? null,
        paper.pmid ?? null,
        paper.filePath ?? null,
        paper.pageCount,
        paper.chunkCount,
        paper.sha256 ?? null,
        paper.addedAt
      );
      const insertChunk = this.db.prepare(`
        INSERT INTO literature_chunks (id, paper_id, page, chunk_index, content) VALUES (?, ?, ?, ?, ?)
      `);
      const insertPage = this.db.prepare(`
        INSERT INTO literature_pages (paper_id, page, text) VALUES (?, ?, ?)
        ON CONFLICT (paper_id, page) DO UPDATE SET text = literature_pages.text || char(10) || excluded.text
      `);
      const nextIndexByPage = new Map<number, number>();
      for (const { page, text, chunks } of pages) {
        insertPage.run(paper.id, page, text);
        let chunkIndex = nextIndexByPage.get(page) ?? 0;
        for (const chunk of chunks) {
          insertChunk.run(`${paper.id}:${page}:${chunkIndex}`, paper.id, page, chunkIndex, chunk);
          chunkIndex++;
        }
        nextIndexByPage.set(page, chunkIndex);
      }
      return paper;
    });
  }

  listLiteraturePapers(options?: { projectId?: string; includeGlobal?: boolean }): LiteraturePaper[] {
    const { projectId, includeGlobal = true } = options ?? {};
    const filter = projectId === undefined ? '' : `WHERE project_id = ?${includeGlobal ? ' OR project_id IS NULL' : ''}`;
    const rows = this.db.prepare(`SELECT * FROM literature_papers ${filter} ORDER BY added_at DESC, rowid DESC`)
      .all(...(projectId === undefined ? [] : [projectId]));
    return rows.map((row) => this.rowToLiteraturePaper(row));
  }

  getLiteraturePaper(id: string): LiteraturePaper | null {
    const row = this.db.prepare('SELECT * FROM literature_papers WHERE id = ?').get(id);
    return row ? this.rowToLiteraturePaper(row) : null;
  }

  deleteLiteraturePaper(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM literature_papers WHERE id = ?').run(id).changes) > 0;
  }

  searchLiteraturePassages(query: string, limit = 6, projectId?: string | null): LiteraturePassage[] {
    const search = createLiteratureQuery(query);
    if (!search || !(limit >= 1)) return [];
    const filter = projectId === undefined ? '' : 'WHERE p.project_id = ? OR p.project_id IS NULL';
    const rows = this.db.prepare(`${literaturePassagesSql} ${filter}`)
      .iterate(...(projectId === undefined ? [] : [projectId]));
    return rankLiteraturePassages(rows, (row) => this.rowToLiteraturePassage(row), search, limit);
  }

  getLiteraturePage(paperId: string, page: number, query?: string): LiteraturePageView | undefined {
    return this.transaction(() => {
      const paper = this.getLiteraturePaper(paperId);
      if (!paper) return undefined;
      const row = this.db.prepare('SELECT text FROM literature_pages WHERE paper_id = ? AND page = ?').get(paperId, page);
      const text = row
        ? String(row.text)
        : joinPageChunks(this.readLiteraturePassages(paperId, page).map((passage) => passage.text));
      if (text === undefined) return undefined;
      const search = query === undefined ? undefined : createLiteratureQuery(query);
      return { paper, page, totalPages: paper.pageCount, text, ...highlightLiteratureText(text, search) };
    }, 'BEGIN');
  }

  readLiteraturePassages(paperId: string, page?: number): LiteraturePassage[] {
    const paperPassages = `${literaturePassagesSql} WHERE c.paper_id = ?`;
    const orderByPage = 'ORDER BY c.page, c.chunk_index';
    const rows = page === undefined
      ? this.db.prepare(`${paperPassages} ${orderByPage}`).all(paperId)
      : this.db.prepare(`${paperPassages} AND c.page = ? ${orderByPage}`).all(paperId, page);
    return rows.map((row) => this.rowToLiteraturePassage(row));
  }

  createArtifactSnapshot(input: Omit<ArtifactSnapshotRecord, 'id' | 'createdAt'>): ArtifactSnapshotRecord {
    const snapshot: ArtifactSnapshotRecord = {
      ...input,
      id: `snap_${crypto.randomUUID()}`,
      code: input.code,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO artifact_snapshots (id, session_id, artifact_id, label, file_path, sha256, code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.sessionId,
      snapshot.artifactId,
      snapshot.label,
      snapshot.filePath,
      snapshot.sha256,
      snapshot.code ?? null,
      snapshot.createdAt
    );
    return snapshot;
  }

  listArtifactSnapshots(sessionId: string, artifactId?: string): ArtifactSnapshotRecord[] {
    const sessionSnapshots = 'SELECT * FROM artifact_snapshots WHERE session_id = ?';
    const newestFirst = 'ORDER BY created_at DESC, rowid DESC';
    const rows = artifactId === undefined
      ? this.db.prepare(`${sessionSnapshots} ${newestFirst}`).all(sessionId)
      : this.db.prepare(`${sessionSnapshots} AND artifact_id = ? ${newestFirst}`).all(sessionId, artifactId);
    return rows.map((row) => this.rowToArtifactSnapshot(row));
  }

  getArtifactSnapshot(snapshotId: string): ArtifactSnapshotRecord | null {
    const row = this.db.prepare('SELECT * FROM artifact_snapshots WHERE id = ?').get(snapshotId);
    return row ? this.rowToArtifactSnapshot(row) : null;
  }

  /**
   * Exports a self-contained Reproducibility Bundle directory containing:
   * - provenance_manifest.json (full 4-layer metadata)
   * - environment.json
   * - reproduce.<py|R|sh|txt>
   * - METHODS.md (publication-ready methods section)
   * - artifact/<filename> (copied output with SHA-256 verification)
   */
  exportReproducibilityBundle(artifactId: string, exportBaseDir: string): ReproducibilityBundle {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    const provenance = this.getProvenanceByArtifact(artifactId);
    if (!provenance) throw new Error(`Provenance manifest not found for artifact: ${artifactId}`);

    const bundleId = `bundle_${artifact.id}_${Date.now()}`;
    const exportDir = path.join(exportBaseDir, bundleId);
    const artifactSubdir = path.join(exportDir, 'artifact');
    fs.mkdirSync(artifactSubdir, { recursive: true });

    const extMap: Record<ExecutionCodeRecord['language'], string> = {
      python: 'py',
      r: 'R',
      bash: 'sh',
      slurm: 'sbatch',
      'mcp-query': 'json',
    };
    const scriptName = `reproduce.${extMap[provenance.executionCode.language] ?? 'txt'}`;
    const artifactFilename = path.basename(artifact.filePath);

    const methodsMarkdown = [
      `# Reproducibility & Methods Summary: ${artifact.title}`,
      '',
      `- **Artifact ID**: \`${artifact.id}\``,
      `- **Artifact SHA-256**: \`${artifact.sha256}\``,
      `- **Code SHA-256**: \`${provenance.executionCode.codeSha256}\``,
      `- **Generated At**: ${provenance.createdAt}`,
      `- **Compute Target**: \`${provenance.environmentSnapshot.computeTargetId}\` (${provenance.environmentSnapshot.computeTargetKind})`,
      '',
      '## Plain-Language Methods Summary',
      '',
      provenance.plainLanguageSummary,
      '',
      '## Runtime Environment',
      '',
      `- Platform: ${provenance.environmentSnapshot.platform} (${provenance.environmentSnapshot.arch})`,
      `- Node.js: ${provenance.environmentSnapshot.nodeVersion}`,
      provenance.environmentSnapshot.pythonVersion
        ? `- Python: ${provenance.environmentSnapshot.pythonVersion}`
        : null,
      provenance.environmentSnapshot.rVersion
        ? `- R: ${provenance.environmentSnapshot.rVersion}`
        : null,
      '',
      '### Key Packages',
      ...Object.entries(provenance.environmentSnapshot.packages).map(
        ([k, v]) => `- \`${k}\`: ${v}`
      ),
      '',
      '## Conversational & Agent Lineage',
      '',
      ...provenance.conversationalLineage.map(
        (step, idx) => `${idx + 1}. **[${step.agentName} / ${step.role}]** (${step.createdAt}): ${step.summary.replace(/\r?\n/g, ' ')}`
      ),
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const filesToWrite: Array<{ name: string; rel: string; content?: string; copyFrom?: string }> = [
      {
        name: 'provenance_manifest.json',
        rel: 'provenance_manifest.json',
        content: JSON.stringify(provenance, null, 2),
      },
      {
        name: 'environment.json',
        rel: 'environment.json',
        content: JSON.stringify(provenance.environmentSnapshot, null, 2),
      },
      {
        name: scriptName,
        rel: scriptName,
        content: provenance.executionCode.code,
      },
      {
        name: 'METHODS.md',
        rel: 'METHODS.md',
        content: methodsMarkdown,
      },
      {
        name: artifactFilename,
        rel: path.posix.join('artifact', artifactFilename),
        copyFrom: artifact.filePath,
      },
    ];

    const files: Array<{ name: string; relativePath: string; sha256: string }> = [];
    for (const f of filesToWrite) {
      const dest = path.join(exportDir, f.rel);
      if (f.copyFrom) {
        fs.copyFileSync(f.copyFrom, dest);
      } else {
        fs.writeFileSync(dest, f.content ?? '', 'utf8');
      }
      files.push({
        name: f.name,
        relativePath: f.rel,
        sha256: sha256File(dest),
      });
    }

    return {
      bundleId,
      artifactId: artifact.id,
      exportDir,
      files,
      methodsMarkdown,
      reproScript: provenance.executionCode.code,
      createdAt: new Date().toISOString(),
    };
  }

  updateSessionWorkspace(sessionId: string, workspacePath: string): Session {
    return this.updateSession(sessionId, 'workspace_path = ?', workspacePath);
  }

  getConfig<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json FROM app_config WHERE key = ?`)
      .get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  setConfig<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  setSecret(key: string, plaintext: string | undefined): void {
    const storageKey = `secret:${key}`;
    if (!plaintext) {
      this.db.prepare(`DELETE FROM app_config WHERE key = ?`).run(storageKey);
      return;
    }
    const encrypted = this.vault.encrypt(plaintext);
    // Only ciphertext reaches SQLite, including any write-ahead log frames.
    this.setConfig<EncryptedBlob>(storageKey, encrypted);
  }

  getSecret(key: string): string | null {
    const raw = this.getConfig<unknown>(`secret:${key}`);
    if (!raw) return null;
    if (SecretVault.isEncryptedBlob(raw)) {
      return this.vault.decrypt(raw);
    }
    return null;
  }

  listSecretKeys(prefix = ''): string[] {
    const storagePrefix = `secret:${prefix}`;
    const rows = this.db.prepare(`
      SELECT key, value_json FROM app_config
      WHERE key GLOB 'secret:*' AND substr(key, 1, length(?)) = ? AND json_valid(value_json)
      ORDER BY key
    `).all(storagePrefix, storagePrefix);
    return rows
      .filter((row) => SecretVault.isEncryptedBlob(JSON.parse(String(row.value_json))))
      .map((row) => String(row.key).slice('secret:'.length));
  }

  upsertSlurmJob(job: SlurmJobRecord): SlurmJobRecord {
    this.db
      .prepare(
        `INSERT INTO slurm_jobs (id, job_json, submitted_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET job_json = excluded.job_json, updated_at = excluded.updated_at`
      )
      .run(job.id, JSON.stringify(job), job.submittedAt, job.updatedAt);
    return job;
  }

  listPersistedSlurmJobs(): SlurmJobRecord[] {
    const rows = this.db
      .prepare(`SELECT job_json FROM slurm_jobs ORDER BY submitted_at DESC`)
      .all() as Array<{ job_json: string }>;
    return rows.map((r) => JSON.parse(r.job_json) as SlurmJobRecord);
  }

  saveCustomSpecialist(specialist: CustomSpecialist): CustomSpecialist {
    this.db
      .prepare(
        `INSERT INTO custom_specialists (id, specialist_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET specialist_json = excluded.specialist_json`
      )
      .run(specialist.id, JSON.stringify(specialist), specialist.createdAt);
    return specialist;
  }

  listCustomSpecialists(): CustomSpecialist[] {
    const rows = this.db
      .prepare(`SELECT specialist_json FROM custom_specialists ORDER BY created_at ASC`)
      .all() as Array<{ specialist_json: string }>;
    return rows.map((r) => JSON.parse(r.specialist_json) as CustomSpecialist);
  }

  deleteCustomSpecialist(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM custom_specialists WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  private rowToProject(row: Record<string, unknown>): ResearchProject {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      instructions: String(row.instructions),
      workspacePath: String(row.workspace_path),
      defaultComputeTargetId: String(row.default_compute_target_id),
      defaultSkills: JSON.parse(String(row.default_skills_json)) as string[],
      color: row.color == null ? undefined : String(row.color),
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      sessionCount: Number(row.session_count),
      memoryCount: Number(row.memory_count),
      paperCount: Number(row.paper_count),
      artifactCount: Number(row.artifact_count),
      hypothesisCount: Number(row.hypothesis_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToHypothesis(row: Record<string, unknown>): ResearchHypothesis {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      statement: String(row.statement),
      status: row.status as HypothesisStatus,
      confidence: Number(row.confidence),
      evidence: JSON.parse(String(row.evidence_json)) as HypothesisEvidence[],
      nextExperiment: row.next_experiment == null ? undefined : String(row.next_experiment),
      sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      projectId: row.project_id == null ? null : String(row.project_id),
      title: String(row.title),
      workspacePath: String(row.workspace_path),
      rootNodeId: row.root_node_id ? String(row.root_node_id) : null,
      activeNodeId: row.active_node_id ? String(row.active_node_id) : null,
      forkedFromSessionId: row.forked_from_session_id ? String(row.forked_from_session_id) : null,
      forkedFromNodeId: row.forked_from_node_id ? String(row.forked_from_node_id) : null,
      computeTargetId: String(row.compute_target_id),
      pinned: row.pinned === 1,
      compactedUpToNodeId: row.compacted_up_to_node_id == null ? null : String(row.compacted_up_to_node_id),
      compactionSummary: row.compaction_summary == null ? null : String(row.compaction_summary),
      tokenUsage: row.token_usage_json == null ? undefined : JSON.parse(String(row.token_usage_json)) as SessionTokenUsage,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToNode(row: Record<string, unknown>): SessionNode {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      role: String(row.role) as AgentRole,
      agentName: String(row.agent_name),
      specialistDomain: row.specialist_domain
        ? (String(row.specialist_domain) as SpecialistDomain)
        : undefined,
      content: String(row.content),
      thinking: row.thinking == null ? undefined : String(row.thinking),
      metadata: row.metadata_json ? (JSON.parse(String(row.metadata_json)) as Record<string, unknown>) : undefined,
      artifactIds: row.artifact_ids_json ? (JSON.parse(String(row.artifact_ids_json)) as string[]) : [],
      createdAt: String(row.created_at),
    };
  }

  private rowToMemoryItem(row: Record<string, unknown>): ResearchMemoryItem {
    return {
      id: String(row.id),
      scope: row.scope as ResearchMemoryItem['scope'],
      projectId: row.project_id == null ? null : String(row.project_id),
      workspacePath: row.workspace_path == null ? undefined : String(row.workspace_path),
      category: row.category as ResearchMemoryCategory,
      title: String(row.title),
      content: String(row.content),
      tags: JSON.parse(String(row.tags_json)) as string[],
      sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private rowToLiteraturePaper(row: Record<string, unknown>): LiteraturePaper {
    return {
      id: String(row.id),
      projectId: row.project_id == null ? null : String(row.project_id),
      title: String(row.title),
      authors: JSON.parse(String(row.authors_json)) as string[],
      year: row.year == null ? undefined : Number(row.year),
      journal: row.journal == null ? undefined : String(row.journal),
      doi: row.doi == null ? undefined : String(row.doi),
      pmid: row.pmid == null ? undefined : String(row.pmid),
      filePath: row.file_path == null ? undefined : String(row.file_path),
      pageCount: Number(row.page_count),
      chunkCount: Number(row.chunk_count),
      sha256: row.sha256 == null ? undefined : String(row.sha256),
      addedAt: String(row.added_at),
    };
  }

  private rowToLiteraturePassage(row: Record<string, unknown>, score = 0): LiteraturePassage {
    return {
      paperId: String(row.paper_id),
      paperTitle: String(row.paper_title),
      page: Number(row.page),
      chunkIndex: Number(row.chunk_index),
      text: String(row.content),
      score,
      doi: row.doi == null ? undefined : String(row.doi),
      pmid: row.pmid == null ? undefined : String(row.pmid),
    };
  }

  private rowToArtifactSnapshot(row: Record<string, unknown>): ArtifactSnapshotRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      artifactId: String(row.artifact_id),
      label: String(row.label),
      filePath: String(row.file_path),
      sha256: String(row.sha256),
      code: row.code == null ? undefined : String(row.code),
      createdAt: String(row.created_at),
    };
  }

  private rowToArtifact(row: Record<string, unknown>): ScientificArtifact {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      nodeId: String(row.node_id),
      type: String(row.type) as ArtifactType,
      title: String(row.title),
      description: String(row.description),
      mimeType: String(row.mime_type),
      filePath: String(row.file_path),
      fileSizeBytes: Number(row.file_size_bytes),
      sha256: String(row.sha256),
      previewData: row.preview_json ? (JSON.parse(String(row.preview_json)) as Record<string, unknown>) : undefined,
      vectorExports: row.vector_exports_json
        ? (JSON.parse(String(row.vector_exports_json)) as VectorExportFiles)
        : undefined,
      refinedFromArtifactId: row.refined_from_artifact_id ? String(row.refined_from_artifact_id) : undefined,
      provenanceId: String(row.provenance_id),
      reviewStatus: String(row.review_status) as ScientificArtifact['reviewStatus'],
      createdAt: String(row.created_at),
    };
  }
}
