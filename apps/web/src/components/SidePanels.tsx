import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowUpRight, BookOpen, Braces, Cable, Check, CheckCircle2, Download, FolderInput, FolderKanban,
  GitFork, KeyRound, LayoutGrid, MessageSquare, Package, Pencil, Pin, Plus, RefreshCw, Search, Server,
  ShieldCheck, Sparkles, Stethoscope, Terminal, Trash2, Wifi, X, XCircle,
} from 'lucide-react';
import type {
  ComputeTarget, ConnectorInfo, ConnectorQueryResult, CustomSpecialist, EnvironmentDoctorReport,
  ExternalMcpServerConfig, ResearchProject, Session, SessionSearchResult, SkillDocument,
  SlurmJobRecord, SlurmJobSpec, SpecialistDomain, SshConnectionTestResult,
} from '@scideveloper/shared';
import { api, errorText, type CatalogSkill } from '../api';
import { useI18n } from '../i18n';
import { projectAccentHex } from './ProjectHomeView';
import { CodeBlock, ErrorNote, Loading, Markdown, Modal, Pill, SpillCard, shortDate } from './ui';

export function SessionsPanel({
  projects,
  activeProjectId,
  sessions,
  sessionId,
  busy,
  onNew,
  onNewProject,
  onSelectProject,
  onEditProject,
  select,
  onRename,
  onPin,
  onMoveToProject,
  onDelete,
}: {
  projects: ResearchProject[];
  activeProjectId?: string;
  sessions: Session[];
  sessionId?: string;
  busy: boolean;
  onNew: () => void;
  onNewProject: () => void;
  onSelectProject: (projectId: string | undefined) => void;
  onEditProject?: (project: ResearchProject) => void;
  select: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
  onDelete?: (id: string) => void;
}) {
  const { locale, t, L } = useI18n();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [movingId, setMovingId] = useState<string | null>(null);

  const activeProject = projects.find(p => p.id === activeProjectId);
  const projectMap = new Map(projects.map(p => [p.id, p]));
  const visibleSessions = activeProjectId
    ? sessions.filter(s => s.projectId === activeProjectId)
    : sessions;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api.searchSessions(q, activeProjectId).then(setSearchResults).catch(() => setSearchResults(null));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, activeProjectId]);

  function startEdit(s: Session) {
    setEditingId(s.id);
    setEditTitle(s.title);
    setMovingId(null);
  }

  function commitEdit(id: string) {
    if (editTitle.trim() && onRename) onRename(id, editTitle.trim());
    setEditingId(null);
  }

  return <div className="sidebar-sessions">
    {/* Primary CTA at very top for effortless start */}
    <button type="button" className="btn btn-primary new-research-btn" disabled={busy} onClick={onNew}>
      <Plus size={16} />{activeProject ? t('newChatInProject') : t('newResearch')}
    </button>

    {/* Projects Section */}
    <div className="project-nav-section">
      <div className="project-nav-head">
        <span className="sidebar-group-label" style={{ padding: 0 }}>{t('projects')}</span>
        <button type="button" className="icon-btn" style={{ width: 24, minHeight: 24 }} onClick={onNewProject} title={t('newProject')} aria-label={t('newProject')}>
          <Plus size={14} />
        </button>
      </div>

      <div className="project-list">
        <button
          type="button"
          className={'project-nav-item' + (!activeProjectId ? ' selected' : '')}
          onClick={() => onSelectProject(undefined)}
        >
          <LayoutGrid size={13} />
          <span className="truncate">{t('allChats')}</span>
          <span className="project-count-badge">{sessions.length}</span>
        </button>

        {projects.map(proj => {
          const isSelected = proj.id === activeProjectId;
          const accent = projectAccentHex(proj.color);
          const count = sessions.filter(s => s.projectId === proj.id).length;
          return (
            <div key={proj.id} className={'project-nav-row' + (isSelected ? ' selected' : '')}>
              <button
                type="button"
                className="project-nav-item-btn"
                onClick={() => onSelectProject(proj.id)}
                title={proj.description || proj.name}
              >
                <span className="project-dot" style={{ background: accent }} />
                <span className="truncate">{proj.name}</span>
                {proj.pinned && <Pin size={10} className="muted shrink-0" />}
                <span className="project-count-badge">{count}</span>
              </button>
              {onEditProject && (
                <button
                  type="button"
                  className="icon-btn project-edit-icon"
                  title={t('editProject')}
                  onClick={() => onEditProject(proj)}
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>

    <label className="sidebar-search">
      <Search size={13} />
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={activeProject
          ? (locale === 'zh' ? `在「${activeProject.name}」中搜索…` : `Search in ${activeProject.name}…`)
          : t('searchSessions')}
        aria-label={t('searchSessions')}
      />
    </label>

    {searchResults ? (
      <>
        <div className="sidebar-group-label">{L(`匹配结果 (${searchResults.length})`, `Search matches (${searchResults.length})`)}</div>
        <div className="session-list">
          {searchResults.map(hit => (
            <button key={hit.sessionId + ':' + (hit.nodeId ?? hit.artifactId ?? 'title')}
              onClick={() => { select(hit.sessionId); setQuery(''); }}
              className={'session-item' + (hit.sessionId === sessionId ? ' selected' : '')}>
              <MessageSquare size={14} className="session-icon" />
              <span className="session-meta">
                <span className="truncate session-title">{hit.title}</span>
                <span className="session-date truncate">{hit.snippet}</span>
              </span>
            </button>
          ))}
          {searchResults.length === 0 && <p className="muted sidebar-empty">{t('noSessionsFound')}</p>}
        </div>
      </>
    ) : (
      <>
        <div className="sidebar-group-label">
          {activeProject ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <FolderKanban size={12} style={{ color: projectAccentHex(activeProject.color) }} />
              {activeProject.name} ({visibleSessions.length})
            </span>
          ) : t('recentResearch')}
        </div>
        <div className="session-list">
          {visibleSessions.map(session => {
            const ownerProject = !activeProjectId && session.projectId ? projectMap.get(session.projectId) : undefined;
            return (
              <div key={session.id}
                className={'session-row' + (session.id === sessionId ? ' selected' : '')}>
                {editingId === session.id ? (
                  <form className="session-edit-form" onSubmit={e => { e.preventDefault(); commitEdit(session.id); }}>
                    <input
                      value={editTitle}
                      autoFocus
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') setEditingId(null); }}
                    />
                    <button type="submit" className="icon-btn" aria-label={L('保存名称', 'Save name')}><Check size={13} /></button>
                    <button type="button" className="icon-btn" onClick={() => setEditingId(null)} aria-label={L('取消', 'Cancel')}><X size={13} /></button>
                  </form>
                ) : movingId === session.id && onMoveToProject ? (
                  <div className="session-edit-form">
                    <select
                      value={session.projectId ?? ''}
                      aria-label={t('moveToProject')}
                      onChange={e => {
                        onMoveToProject(session.id, e.target.value || null);
                        setMovingId(null);
                      }}
                      style={{ flex: 1, fontSize: 12, padding: '3px 6px' }}
                    >
                      <option value="">{t('noProjectAssigned')}</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button type="button" className="icon-btn" onClick={() => setMovingId(null)} aria-label={L('取消', 'Cancel')}><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <button type="button" onClick={() => select(session.id)}
                      className="session-item-btn"
                      aria-current={session.id === sessionId ? 'true' : undefined}>
                      {session.pinned
                        ? <Pin size={13} className="session-icon text-teal" />
                        : <MessageSquare size={14} className="session-icon" />}
                      <span className="session-meta">
                        <span className="truncate session-title" title={session.title}>{session.title}</span>
                        <span className="session-date">
                          {shortDate(session.updatedAt)}
                          {ownerProject && (
                            <> · <span className="project-mini-dot" style={{ background: projectAccentHex(ownerProject.color) }} /><span className="truncate" style={{ maxWidth: 86 }}>{ownerProject.name}</span></>
                          )}
                          {session.forkedFromSessionId && <> · <GitFork size={11} /> {L('分支', 'Branch')}</>}
                        </span>
                      </span>
                    </button>
                    <div className="session-row-actions">
                      {onPin && (
                        <button type="button" className="icon-btn" title={session.pinned ? t('unpin') : t('pin')}
                          onClick={() => onPin(session.id, !session.pinned)}>
                          <Pin size={12} />
                        </button>
                      )}
                      {onMoveToProject && projects.length > 0 && (
                        <button type="button" className="icon-btn" title={t('moveToProject')}
                          onClick={() => { setMovingId(session.id); setEditingId(null); }}>
                          <FolderInput size={12} />
                        </button>
                      )}
                      {onRename && (
                        <button type="button" className="icon-btn" title={t('rename')}
                          onClick={() => startEdit(session)}>
                          <Pencil size={12} />
                        </button>
                      )}
                      {onDelete && (
                        <button type="button" className="icon-btn" title={t('deleteSession')}
                          onClick={() => { if (window.confirm(t('confirmDelete'))) onDelete(session.id); }}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {!visibleSessions.length && (
          <p className="muted sidebar-empty">
            {activeProject ? t('noProjectChatsYet') : L('您的科研对话记录会显示在这里。', 'Your research conversations will appear here.')}
          </p>
        )}
      </>
    )}
  </div>;
}

export function SkillsPanel({ catalog, loadedSkills, onLoad, onDeleted }: {
  catalog: CatalogSkill[]; loadedSkills: string[]; onLoad: (name: string) => void; onDeleted?: () => void;
}) {
  const { L } = useI18n();
  const [skill, setSkill] = useState<SkillDocument>();
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');

  async function open(name: string) {
    setLoading(name);
    setError('');
    try {
      const document = await api.skill(name);
      onLoad(name);
      setSkill(document);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(''); }
  }

  return <div className="stack">
    <p className="field-help" style={{ margin: 0 }}>
      {L('科研协议（SOP）会在相关分析任务中自动按需加载，无需手动开启。点击可查看详细规范，也可在任意对话顶部将已验证流程一键「提炼为 Skill」。', 'Scientific protocols load automatically when relevant. Click any protocol to read its instructions, or distill any verified chat into a custom Skill.')}
    </p>
    {error && <ErrorNote>{error}</ErrorNote>}
    {!catalog.length && <p className="muted">{L('暂无可用协议。', 'No protocols available.')}</p>}
    <div className="stack">{catalog.map(entry => {
      const loaded = entry.loaded || loadedSkills.includes(entry.name);
      return <button type="button" className="catalog-card" key={entry.name} disabled={!!loading} onClick={() => void open(entry.name)}>
        <span className="catalog-title"><BookOpen size={15} /><strong>{entry.title}</strong><ArrowUpRight size={14} /></span>
        <span>{entry.description}</span>
        <div className="pills">
          <Pill tone="blue">{entry.domain}</Pill>
          {entry.isCustom && <Pill tone="reviewer">{L('自定义提炼', 'Custom Skill')}</Pill>}
          <Pill tone={loaded ? 'teal' : 'neutral'}>
            {loading === entry.name ? L('加载中…', 'Loading…') : loaded ? L('当前会话已启用', 'Active in session') : L('按需自动加载', 'Auto-loaded when needed')}
          </Pill>
        </div>
      </button>;
    })}</div>
    {skill && <Modal title={skill.title} onClose={() => setSkill(undefined)}>
      <div className="pills">
        <Pill tone="teal">{L('科研协议', 'Protocol')}</Pill>
        {skill.isCustom && <Pill tone="reviewer">{L('自定义提炼', 'Custom')}</Pill>}
        <Pill>{skill.domain}</Pill>
        {skill.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}
      </div>
      <Markdown text={skill.instructions} />
      {skill.scripts.length > 0 && <section className="stack">
        <h3>{L('配套辅助脚本', 'Helper scripts')}</h3>
        {skill.scripts.map(script => <div className="kv" key={script.path}>
          <Braces size={15} /><strong>{script.name}</strong><Pill>{script.language}</Pill><code className="break-all">{script.path}</code>
        </div>)}
      </section>}
      {skill.isCustom && (
        <div className="actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void api.deleteCustomSkill(skill.name).then(() => { setSkill(undefined); onDeleted?.(); }).catch(c => setError(errorText(c)))}
          >
            <Trash2 size={13} />{L('删除自定义 Skill', 'Delete Custom Skill')}
          </button>
        </div>
      )}
    </Modal>}
  </div>;
}

const examples: Record<string, { operation: string; params: Record<string, unknown> }> = {
  pubmed: { operation: 'search', params: { query: 'EGFR lung cancer', limit: 3 } },
  'rcsb-pdb': { operation: 'search', params: { query: 'EGFR', limit: 3 } },
  uniprot: { operation: 'fetch_entry', params: { accession: 'P00533' } },
  chembl: { operation: 'search_compound', params: { query: 'EGFR', limit: 3 } },
  ensembl: { operation: 'fetch_gene', params: { gene: 'EGFR' } },
  clinvar: { operation: 'search_variants', params: { query: 'EGFR', limit: 4 } },
  geo: { operation: 'search_series', params: { query: 'EGFR', limit: 3 } },
  'arxiv-biorxiv': { operation: 'search_preprints', params: { query: 'single-cell', limit: 3 } },
  'string-db': { operation: 'interaction_partners', params: { gene: 'EGFR', limit: 5 } },
  kegg: { operation: 'search_pathway', params: { query: 'EGFR' } },
  reactome: { operation: 'enrich_genes', params: { genes: ['EGFR', 'TP53', 'KRAS', 'ERBB2'] } },
  'alphafold-db': { operation: 'fetch_prediction', params: { uniprotId: 'P00533' } },
  cbioportal: { operation: 'gene_alterations', params: { gene: 'EGFR', studyId: 'luad_tcga_pan_can_atlas_2018' } },
  opentargets: { operation: 'target_diseases', params: { gene: 'EGFR' } },
  pubchem: { operation: 'search_compound', params: { query: 'Gefitinib' } },
  'eln-benchling': { operation: 'list_experiments', params: {} },
  clinicaltrials: { operation: 'search_trials', params: { query: 'EGFR NSCLC', maxResults: 3 } },
  openalex: { operation: 'search_works', params: { query: 'EGFR osimertinib resistance', maxResults: 3 } },
  zotero: { operation: 'search_items', params: { query: 'EGFR', maxResults: 3 } },
};

export function ConnectorsPanel({ connectors, refresh }: {
  connectors: ConnectorInfo[]; refresh: () => Promise<unknown>;
}) {
  const { L } = useI18n();
  const [transport, setTransport] = useState<ExternalMcpServerConfig['transport']>('stdio');
  const [result, setResult] = useState<{ id: string; res: ConnectorQueryResult }>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [registered, setRegistered] = useState('');

  async function query(id: string, operation: string, params: Record<string, unknown>) {
    setBusy(id); setError(''); setResult(undefined);
    try { setResult({ id, res: await api.query(id, { operation, params }) }); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function discover(id: string) {
    setBusy('discover:' + id); setError('');
    try {
      const res = await api.discoverMcpTools(id);
      setRegistered(L(`已在 ${id} 发现 ${res.tools.length} 个工具。`, `Discovered ${res.tools.length} tool(s) on ${id}.`));
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function removeExternal(id: string) {
    setBusy('remove:' + id); setError('');
    try {
      await api.removeExternalMcp(id);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const read = (name: string) => String(fields.get(name) ?? '').trim();
    const config: ExternalMcpServerConfig = { id: read('id'), name: read('name'), transport, enabled: true };
    if (transport === 'stdio') {
      config.command = read('command');
      config.args = read('args').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } else config.url = read('url');
    setBusy('register'); setError(''); setRegistered('');
    try {
      await api.registerMcp(config);
      setRegistered(L(`${config.name} 已注册并保存。`, `${config.name} registered & persisted.`));
      form.reset();
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  const [credDrafts, setCredDrafts] = useState<Record<string, string>>({});

  async function saveCredential(id: string) {
    setBusy('cred:' + id); setError('');
    try {
      await api.saveConnectorCredential(id, (credDrafts[id] ?? '').trim());
      setCredDrafts(prev => ({ ...prev, [id]: '' }));
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  return <div className="stack">
    <p className="field-help" style={{ margin: 0 }}>
      {L('内置权威科研数据库连接器，支持测试连通性、填写访问密钥或接入外部 MCP 服务。', 'Built-in scientific database connectors. Test connections, add optional API tokens, or attach external MCP servers.')}
    </p>
    {error && <ErrorNote>{error}</ErrorNote>}
    {busy && busy !== 'register' && <Loading label={L('正在请求数据源…', 'Communicating with connector…')} />}
    <div className="stack">{connectors.map(connector => {
      const isExternal = connector.category === 'external-mcp';
      const example = examples[connector.id] ?? { operation: connector.operations[0], params: {} };
      const inlineResult = result?.id === connector.id ? result.res : undefined;
      return <article className="soft-card stack" key={connector.id}>
        <div className="card-head">
          <Cable size={15} /><strong>{connector.name}</strong>
          <Pill>{connector.category}</Pill>
          <Pill tone={connector.status === 'ready' || connector.status === 'connected' ? 'teal' : connector.status === 'error' ? 'red' : 'neutral'}>{connector.status}</Pill>
          {connector.hasCredential && <Pill tone="blue"><KeyRound size={11} />{L('已存密钥', 'Token Saved')}</Pill>}
        </div>
        <p className="muted">{connector.description}</p>
        {connector.supportsCredential && (
          <div className="actions justify-start" style={{ gap: 6 }}>
            <input
              type="password"
              value={credDrafts[connector.id] ?? ''}
              onChange={e => setCredDrafts(prev => ({ ...prev, [connector.id]: e.target.value }))}
              placeholder={connector.hasCredential
                ? L('已保存密钥（留空点击保存可清除）', 'Token saved (leave blank + Save to clear)')
                : (connector.credentialLabel ?? L('输入 API Token / Key', 'API Token / Key'))}
              style={{ flex: 1, minWidth: 160, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--line-strong)', background: 'var(--surface)' }}
            />
            <button type="button" className="btn" disabled={!!busy} onClick={() => void saveCredential(connector.id)}>
              <KeyRound size={12} />{L('保存密钥', 'Save Token')}
            </button>
          </div>
        )}
        <div className="actions justify-start">
          {!isExternal && (
            <button type="button" className="btn" disabled={!!busy || !example.operation} onClick={() => void query(connector.id, example.operation, example.params)}>
              {L('测试连通性', 'Test connection')}
            </button>
          )}
          {isExternal && <>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void discover(connector.id)}>
              <RefreshCw size={13} />{L('发现工具', 'Discover tools')}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void removeExternal(connector.id)}>
              <Trash2 size={13} />{L('移除', 'Remove')}
            </button>
          </>}
        </div>
        {inlineResult && (
          <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div className="pills">
              <strong>{inlineResult.summary}</strong>
              <Pill tone="blue">{inlineResult.source}</Pill>
            </div>
            {inlineResult.spillHandle ? <SpillCard handle={inlineResult.spillHandle} /> : inlineResult.data !== undefined && (
              <details className="subtle-details"><summary>{L('查看返回结果', 'Query result')}</summary>
                <CodeBlock text={typeof inlineResult.data === 'string' ? inlineResult.data : JSON.stringify(inlineResult.data, null, 2)} />
              </details>
            )}
          </div>
        )}
        {isExternal && !!connector.discoveredTools?.length && (
          <div className="pills">
            {connector.discoveredTools.map(tool => (
              <button key={tool.name} type="button" className="tab-pill" disabled={!!busy}
                title={tool.description ?? tool.name}
                onClick={() => void query(connector.id, tool.name, {})}>
                {L('运行 ', 'Run ')}{tool.name}
              </button>
            ))}
          </div>
        )}
      </article>;
    })}</div>
    <details className="disclosure-card">
      <summary><Terminal size={15} /><span>{L('注册外部 MCP 服务器与调试工具', 'External MCP server & diagnostics')}</span></summary>
      <div className="stack disclosure-body">
        <button type="button" className="btn spill-test" disabled={!!busy || !connectors.some(connector => connector.id === 'chembl')}
          onClick={() => void query('chembl', 'bulk_assay', { limit: 240 })}>
          <Terminal size={14} />{L('测试大数据自动落盘保护（240 条 ChEMBL 记录）', 'Test large dataset spill-to-disk (240 ChEMBL rows)')}
        </button>
        <form className="form-stack divider" onSubmit={event => void register(event)}>
          <h4>{L('注册外部 MCP 服务（stdio / HTTP JSON-RPC）', 'Register external MCP server (stdio / HTTP JSON-RPC)')}</h4>
          <label>{L('服务名称', 'Name')}<input name="name" required placeholder="Lab ELN MCP" /></label>
          <label>{L('服务 ID', 'Server ID')}<input name="id" required pattern="[A-Za-z0-9_-]+" placeholder="lab-eln" /></label>
          <label>{L('传输方式', 'Transport')}
            <select value={transport} onChange={event => setTransport(event.target.value as typeof transport)}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </label>
          {transport === 'stdio' ? <>
            <label>{L('启动命令', 'Command')}<input name="command" required placeholder="node" /></label>
            <label>{L('命令参数（每行一个）', 'Arguments (one per line)')}<textarea name="args" rows={2} placeholder="path/to/mcp-server.js" /></label>
          </> : <label>{L('服务地址 URL', 'Server URL')}<input name="url" type="url" required placeholder="http://127.0.0.1:8787/mcp" /></label>}
          <button className="btn btn-primary w-fit" disabled={!!busy}>{busy === 'register' ? L('注册中…', 'Registering…') : L('注册服务', 'Register server')}</button>
          {registered && <p role="status">{registered}</p>}
        </form>
      </div>
    </details>
  </div>;
}

export function SpecialistsPanel({ specialists, refresh }: {
  specialists: CustomSpecialist[]; refresh: () => Promise<unknown>;
}) {
  const { L } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const read = (k: string) => String(data.get(k) ?? '').trim();
    setBusy(true); setError('');
    try {
      await api.createSpecialist({
        name: read('name'),
        domain: (read('domain') || 'custom') as SpecialistDomain,
        description: read('description'),
        systemPrompt: read('systemPrompt'),
        defaultSkills: read('defaultSkills').split(',').map(s => s.trim()).filter(Boolean),
      });
      form.reset();
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError('');
    try {
      await api.deleteSpecialist(id);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  return <div className="stack">
    <p className="field-help" style={{ margin: 0 }}>
      {L('可创建针对您课题组方向的专属分析专家；创建后即可在对话输入框中按需选用。', 'Create reusable domain specialists tailored to your lab. Once added, they become selectable in the chat composer.')}
    </p>
    {error && <ErrorNote>{error}</ErrorNote>}
    {specialists.map(sp => (
      <article key={sp.id} className="soft-card stack">
        <div className="card-head">
          <Sparkles size={15} /><strong>{sp.name}</strong><Pill tone="blue">{sp.domain}</Pill>
          <button type="button" className="icon-btn" title={L('删除专家', 'Delete specialist')} onClick={() => void remove(sp.id)} disabled={busy}>
            <Trash2 size={13} />
          </button>
        </div>
        <p className="muted">{sp.description}</p>
        <code className="text-xs muted">{sp.systemPrompt.slice(0, 140)}</code>
      </article>
    ))}
    <form className="form-stack divider" onSubmit={e => void create(e)}>
      <h4>{L('新建自定义领域专家', 'Create custom domain specialist')}</h4>
      <label>{L('专家名称', 'Specialist name')}<input name="name" required placeholder={L('例如：肿瘤生物统计专家', 'Clinical Oncology Biostatistician')} /></label>
      <label>{L('所属领域', 'Domain')}
        <select name="domain" defaultValue="statistics">
          <option value="genomics">{L('基因组学 (Genomics)', 'Genomics')}</option>
          <option value="single-cell">{L('单细胞组学 (Single-Cell)', 'Single-Cell')}</option>
          <option value="structural-biology">{L('结构生物学 (Structural Biology)', 'Structural Biology')}</option>
          <option value="cheminformatics">{L('化学信息学 (Cheminformatics)', 'Cheminformatics')}</option>
          <option value="proteomics">{L('蛋白质组学 (Proteomics)', 'Proteomics')}</option>
          <option value="metabolomics">{L('代谢组学 (Metabolomics)', 'Metabolomics')}</option>
          <option value="clinical">{L('临床变异 (Clinical Variants)', 'Clinical Variants')}</option>
          <option value="statistics">{L('生物统计学 (Statistics)', 'Statistics')}</option>
          <option value="literature">{L('文献综述 (Literature)', 'Literature')}</option>
          <option value="custom">{L('自定义 (Custom)', 'Custom')}</option>
        </select>
      </label>
      <label>{L('简介', 'Description')}<input name="description" required placeholder={L('擅长生存分析与生物标志物分层', 'Focuses on survival analysis and biomarker stratification')} /></label>
      <label>{L('系统分析指令', 'System instructions')}<textarea name="systemPrompt" required rows={3} placeholder={L('例如：每次生存分析均需检验等比例风险假设并报告 95% 置信区间。', 'Always verify proportional hazards assumptions and report 95% CIs.')} /></label>
      <label>{L('默认科研协议（逗号分隔，可选）', 'Default protocols (comma-separated, optional)')}<input name="defaultSkills" placeholder="survival-analysis-cox, statistical-validation" /></label>
      <button className="btn btn-primary w-fit" disabled={busy}>{busy ? L('保存中…', 'Saving…') : L('保存专家', 'Save specialist')}</button>
    </form>
  </div>;
}

export function DoctorPanel({ sessionId, refreshPending }: {
  sessionId?: string;
  refreshPending: () => Promise<unknown>;
}) {
  const { L } = useI18n();
  const [report, setReport] = useState<EnvironmentDoctorReport>();
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [error, setError] = useState('');

  async function runCheck() {
    setLoading(true); setError('');
    try { setReport(await api.doctor()); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void runCheck(); }, []);

  async function installMissing() {
    if (!report || installing) return;
    const missing = report.packages.filter(p => p.recommended && !p.installed).map(p => p.name);
    if (!missing.length) return;
    setInstalling(true); setError(''); setInstallLog('');
    const pendingCheck = window.setTimeout(() => void refreshPending().catch(() => {}), 250);
    try {
      const res = await api.installPackages(sessionId, missing);
      setInstallLog(res.stdout || res.stderr || `Exited with code ${res.exitCode}`);
      await runCheck();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      window.clearTimeout(pendingCheck);
      setInstalling(false);
    }
  }

  if (loading && !report) return <Loading label={L('正在检测 Python、R、Conda 及常用科研依赖包…', 'Diagnosing Python, R, Conda, and scientific packages…')} />;

  const missingRecommended = report?.packages.filter(p => p.recommended && !p.installed) ?? [];

  return <div className="stack">
    {error && <ErrorNote>{error}</ErrorNote>}
    {report && <>
      <div className="soft-card stack">
        <div className="card-head">
          <div className="flex items-center gap-2"><Stethoscope size={16} /><strong>{L('科研环境自动体检', 'Scientific Environment Doctor')}</strong></div>
          <button type="button" className="btn" disabled={loading} onClick={() => void runCheck()}>
            <RefreshCw size={13} />{L('重新检测', 'Re-scan')}
          </button>
        </div>
        <div className="pills">
          <Pill tone={report.python.available ? 'teal' : 'red'}>Python {report.python.version ?? L('缺失', 'Missing')}</Pill>
          <Pill tone={report.r.available ? 'teal' : 'neutral'}>
            R {report.r.available ? `${report.r.version ?? L('就绪', 'Ready')}${report.r.persistentReady ? L('（持久内核）', ' (Persistent)') : ''}` : L('未安装', 'Not installed')}
          </Pill>
          <Pill tone={report.docker?.available ? 'teal' : 'neutral'}>
            Docker {report.docker?.available ? (report.docker.version ?? L('就绪', 'Ready')) : L('未运行', 'Not running')}
          </Pill>
          <Pill tone={report.sandboxGuardSupported ? 'teal' : 'amber'}>
            <ShieldCheck size={11} />{L('沙箱防护 ', 'Sandbox Guard ')}{report.sandboxGuardSupported ? L('已启用', 'Active') : L('不可用', 'Unavailable')}
          </Pill>
          <Pill tone={report.condaAvailable ? 'blue' : 'neutral'}>Conda {report.condaAvailable ? L('可用', 'Yes') : L('未检测到', 'No')}</Pill>
          <Pill tone={report.uvAvailable ? 'blue' : 'neutral'}>uv {report.uvAvailable ? L('可用', 'Yes') : L('未检测到', 'No')}</Pill>
        </div>
        <code className="text-xs muted break-all">{report.python.executable}</code>
      </div>

      <div className="data-scroll">
        <table>
          <thead><tr><th>{L('包名', 'Package')}</th><th>{L('用途', 'Purpose')}</th><th>{L('状态', 'Status')}</th><th>{L('版本', 'Version')}</th></tr></thead>
          <tbody>
            {report.packages.map(pkg => (
              <tr key={pkg.name}>
                <td><code>{pkg.name}</code></td>
                <td>{pkg.purpose}</td>
                <td>
                  <Pill tone={pkg.installed ? 'teal' : pkg.recommended ? 'amber' : 'neutral'}>
                    {pkg.installed ? L('已安装', 'Installed') : pkg.recommended ? L('推荐安装', 'Recommended') : L('可选', 'Optional')}
                  </Pill>
                </td>
                <td><code>{pkg.version ?? '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.suggestedInstallCommand && (
        <div className="soft-card stack">
          <strong>{L('安装缺失的推荐依赖包', 'Install missing recommended packages')}</strong>
          <CodeBlock text={report.suggestedInstallCommand} language="bash" />
          {missingRecommended.length > 0 && (
            <button type="button" className="btn btn-primary w-fit" disabled={installing} onClick={() => void installMissing()}>
              {installing ? <Loading label={L('安装中…', 'Installing…')} /> : <><Package size={14} />{L(`一键安装 ${missingRecommended.length} 个推荐包`, `Install ${missingRecommended.length} Missing Package(s)`)}</>}
            </button>
          )}
        </div>
      )}

      {installLog && <CodeBlock text={installLog} />}
    </>}
  </div>;
}

export function ComputePanel({ targets, jobs, computeId, sessionId, onJob, refreshPending, refreshTargets }: {
  targets: ComputeTarget[]; jobs: SlurmJobRecord[]; computeId?: string; sessionId?: string;
  onJob: (job: SlurmJobRecord) => void; refreshPending: () => Promise<unknown>; refreshTargets?: () => Promise<unknown>;
}) {
  const { L } = useI18n();
  const [jobBusy, setJobBusy] = useState('');
  const [testResults, setTestResults] = useState<Record<string, SshConnectionTestResult>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const hpc = targets.find(target => target.id === computeId && target.kind === 'hpc-slurm') ?? targets.find(target => target.kind === 'hpc-slurm');

  async function poll(jobId: string) {
    setJobBusy('poll:' + jobId); setError('');
    try { onJob(await api.pollSlurmJob(jobId)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  async function cancel(jobId: string) {
    setJobBusy('cancel:' + jobId); setError('');
    try { onJob(await api.cancelSlurmJob(jobId)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  async function syncArtifacts(jobId: string) {
    setJobBusy('sync:' + jobId); setError(''); setNotice('');
    try {
      const res = await api.syncSlurmArtifacts(jobId, sessionId);
      onJob(res.job);
      setNotice(L(`已将 ${res.syncedFiles.length} 个远程结果同步到本地。`, `Synced ${res.syncedFiles.length} remote file(s) locally.`));
    } catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  async function testTarget(targetId: string) {
    setJobBusy('test:' + targetId); setError('');
    try {
      const res = await api.testTarget(targetId);
      setTestResults(prev => ({ ...prev, [targetId]: res }));
    } catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  async function removeTarget(targetId: string) {
    setJobBusy('del:' + targetId); setError('');
    try {
      await api.removeTarget(targetId);
      await refreshTargets?.();
    } catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  async function addSshTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    const read = (k: string) => String(f.get(k) ?? '').trim();
    setJobBusy('add-target'); setError(''); setNotice('');
    try {
      const target: ComputeTarget = {
        id: read('id'),
        name: read('name'),
        kind: (read('kind') || 'hpc-slurm') as ComputeTarget['kind'],
        status: 'configured',
        host: read('host'),
        port: Number(read('port')) || 22,
        username: read('username'),
        identityFile: read('identityFile') || undefined,
        jumpHost: read('jumpHost') || undefined,
        remoteWorkDir: read('remoteWorkDir') || undefined,
        partition: read('partition') || 'compute',
        gpuType: read('gpuType') || undefined,
        defaultCpus: Number(read('defaultCpus')) || 8,
        defaultMemGb: Number(read('defaultMemGb')) || 32,
        condaEnv: read('condaEnv') || undefined,
        description: `SSH cluster target (${read('username')}@${read('host')})`,
      };
      await api.saveTarget(target);
      form.reset();
      setNotice(L(`已保存远程集群「${target.name}」。`, `Saved SSH cluster "${target.name}".`));
      await refreshTargets?.();
    } catch (cause) { setError(errorText(cause)); }
    finally { setJobBusy(''); }
  }

  return <div className="stack">
    {error && <ErrorNote>{error}</ErrorNote>}
    {notice && <p role="status" className="muted"><CheckCircle2 size={13} style={{ display: 'inline', marginRight: 4 }} />{notice}</p>}
    <div className="stack">{targets.map(target => {
      const probe = testResults[target.id];
      return <div className="soft-card stack" key={target.id}>
        <div className="card-head">
          <Server size={15} /><strong>{target.name}</strong>
          <Pill tone={target.status === 'offline' ? 'amber' : 'teal'}>{target.status}</Pill>
        </div>
        <p className="muted">{target.description}</p>
        <div className="pills">
          {computeId === target.id && <Pill tone="blue">{L('当前使用', 'Active')}</Pill>}
          {target.host && <Pill>{target.username ? `${target.username}@${target.host}` : target.host}</Pill>}
          {target.partition && <Pill>{L('分区：', 'partition: ')}{target.partition}</Pill>}
        </div>
        <div className="actions justify-start">
          <button type="button" className="btn" disabled={!!jobBusy} onClick={() => void testTarget(target.id)}>
            <Wifi size={12} />{L('测试连接', 'Test connection')}
          </button>
          {target.id !== 'local-sandbox' && (
            <button type="button" className="btn" disabled={!!jobBusy} onClick={() => void removeTarget(target.id)}>
              <Trash2 size={12} />{L('移除', 'Remove')}
            </button>
          )}
        </div>
        {probe && (
          <div className="pills">
            <Pill tone={probe.ok ? 'teal' : 'red'}>{probe.ok ? L('连接成功', 'Connected') : L('连接失败', 'Failed')} ({probe.latencyMs}ms)</Pill>
            <span className="muted text-xs">{probe.message}</span>
          </div>
        )}
      </div>;
    })}</div>

    <details className="disclosure-card">
      <summary><Plus size={15} /><span>{L('添加 SSH 工作站 / Slurm 高性能集群', 'Add SSH Workstation / Slurm HPC Cluster')}</span></summary>
      <div className="disclosure-body">
        <form className="form-stack" onSubmit={e => void addSshTarget(e)}>
          <div className="form-grid">
            <label>{L('目标 ID', 'Target ID')}<input name="id" required pattern="[A-Za-z0-9_-]+" placeholder="uni-hpc-gpu" /></label>
            <label>{L('显示名称', 'Display Name')}<input name="name" required placeholder={L('例如：实验室 A100 集群', 'University A100 Cluster')} /></label>
            <label>{L('类型', 'Kind')}
              <select name="kind" defaultValue="hpc-slurm">
                <option value="hpc-slurm">{L('Slurm 高性能集群', 'Slurm HPC Cluster')}</option>
                <option value="ssh-workstation">{L('SSH 工作站', 'SSH Workstation')}</option>
                <option value="cloud-gpu">{L('云端 GPU 节点', 'Cloud GPU Node')}</option>
              </select>
            </label>
            <label>{L('分区 (Partition)', 'Partition')}<input name="partition" defaultValue="gpu" /></label>
            <label>{L('主机地址 (Host)', 'SSH Host')}<input name="host" required placeholder="login.hpc.edu" /></label>
            <label>{L('端口', 'Port')}<input name="port" type="number" defaultValue={22} /></label>
            <label>{L('用户名', 'Username')}<input name="username" required placeholder="researcher" /></label>
            <label>{L('Conda 环境名', 'Conda Env')}<input name="condaEnv" placeholder="bioinfo-py312" /></label>
          </div>
          <label>{L('SSH 私钥路径（可选）', 'SSH Key / Identity File (optional)')}<input name="identityFile" placeholder="C:\Users\you\.ssh\id_ed25519" /></label>
          <label>{L('跳板机地址（可选）', 'Jump Host / Bastion (optional)')}<input name="jumpHost" placeholder="bastion.hpc.edu" /></label>
          <label>{L('远程工作目录（可选）', 'Remote Working Directory (optional)')}<input name="remoteWorkDir" placeholder="/scratch/researcher/scideveloper" /></label>
          <button type="submit" className="btn btn-primary w-fit" disabled={!!jobBusy}>{L('保存远程目标', 'Save SSH Target')}</button>
        </form>
      </div>
    </details>

    {hpc && <details className="disclosure-card">
      <summary><Server size={15} /><span>{L('Slurm 集群作业提交', 'Slurm cluster job submission')}</span></summary>
      <div className="disclosure-body">
        <SlurmForm key={hpc.id} target={hpc} sessionId={sessionId} onJob={onJob} refreshPending={refreshPending} />
      </div>
    </details>}

    {jobs.length > 0 && <section className="divider stack">
      <h4>{L('集群作业队列', 'Cluster job queue')}</h4>
      {jobs.map(job => <article key={job.id} className="soft-card stack">
        <div className="card-head">
          <strong>{job.spec.jobName}</strong>
          <Pill tone={job.status === 'completed' ? 'teal' : job.status === 'failed' || job.status === 'cancelled' ? 'red' : 'blue'}>{job.status}</Pill>
        </div>
        <div className="pills">
          <Pill>#{job.slurmJobId}</Pill>
          <Pill>{job.mode}</Pill>
          <button type="button" className="btn" disabled={!!jobBusy} onClick={() => void poll(job.id)}>
            <RefreshCw size={12} />{L('刷新状态', 'Poll')}
          </button>
          {job.status === 'completed' && (
            <button type="button" className="btn" disabled={!!jobBusy} onClick={() => void syncArtifacts(job.id)}>
              <Download size={12} />{L('同步结果', 'Sync Artifacts')}
            </button>
          )}
          {(job.status === 'queued' || job.status === 'running') && (
            <button type="button" className="btn" disabled={!!jobBusy} onClick={() => void cancel(job.id)}>
              <XCircle size={12} />{L('取消作业', 'Cancel')}
            </button>
          )}
        </div>
        {!!job.syncedFiles?.length && (
          <div className="pills">
            {job.syncedFiles.map(f => <Pill key={f} tone="teal">{L('已同步：', 'Synced: ')}{f.split(/[\\/]/).pop()}</Pill>)}
          </div>
        )}
        <details className="subtle-details"><summary>{L('查看作业日志', 'Job logs')}</summary><CodeBlock text={job.stdout || L('等待输出…', 'Waiting for output…')} />{job.stderr && <CodeBlock text={job.stderr} />}</details>
      </article>)}
    </section>}
  </div>;
}

function SlurmForm({ target, sessionId, onJob, refreshPending }: {
  target: ComputeTarget; sessionId?: string; onJob: (job: SlurmJobRecord) => void; refreshPending: () => Promise<unknown>;
}) {
  const { L } = useI18n();
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function dispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const submit = button instanceof HTMLButtonElement && button.value === 'submit';
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const spec: SlurmJobSpec = {
      targetId: target.id, jobName: value('jobName'), partition: value('partition'), cpus: Number(value('cpus')),
      memGb: Number(value('memGb')), gpus: Number(value('gpus')), walltime: value('walltime'), command: value('command'),
      condaEnv: target.condaEnv,
    };
    if (!spec.command || !spec.jobName || !spec.partition) {
      setError(L('请填写作业名、分区和执行命令。', 'Enter a job name, partition, and command.'));
      return;
    }
    setBusy(submit ? L('提交中…', 'Submitting…') : L('生成中…', 'Generating…')); setError(''); setNotice('');
    try {
      if (submit) {
        const submission = api.slurmSubmit({ spec, sessionId, liveSsh: target.status === 'online' && !!target.host && !!target.username });
        const pendingCheck = window.setTimeout(() => void refreshPending().catch(() => {}), 250);
        try {
          const job = await submission;
          onJob(job);
          setNotice(L(`作业 #${job.slurmJobId} 已提交。`, `Job #${job.slurmJobId} submitted.`));
        } finally { window.clearTimeout(pendingCheck); }
      } else {
        const result = await api.slurmPreview(spec);
        setScript(result.script);
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  return <form className="form-stack" onSubmit={event => void dispatch(event)} onChange={() => { setScript(''); setNotice(''); }}>
    <label>{L('作业名称', 'Job name')}<input required name="jobName" defaultValue="science-job" /></label>
    <div className="form-grid">
      <label>{L('分区', 'Partition')}<input required name="partition" defaultValue={target.partition ?? 'compute'} /></label>
      <label>CPUs<input name="cpus" type="number" min={1} step={1} required defaultValue={target.defaultCpus ?? 4} /></label>
      <label>{L('内存 (GB)', 'RAM (GB)')}<input name="memGb" type="number" min={1} step={1} required defaultValue={target.defaultMemGb ?? 8} /></label>
      <label>GPUs<input name="gpus" type="number" min={0} step={1} required defaultValue={0} /></label>
    </div>
    <label>{L('最长运行时间 (HH:MM:SS)', 'Walltime (HH:MM:SS)')}<input required name="walltime" pattern="[0-9]+:[0-5][0-9]:[0-5][0-9]" defaultValue="01:00:00" /></label>
    <label>{L('执行命令', 'Command')}<textarea required name="command" rows={3} placeholder="python analysis.py" className="font-mono" /></label>
    <div className="pills"><Pill>{target.status === 'online' && target.host && target.username ? L('实时 SSH 提交', 'Live SSH') : L('本地模拟提交', 'Simulated submission')}</Pill></div>
    <div className="actions justify-start">
      <button className="btn" value="preview" disabled={!!busy}>{L('预览脚本', 'Preview script')}</button>
      <button className="btn btn-primary" value="submit" disabled={!!busy}>{L('提交作业', 'Submit job')}</button>
    </div>
    {busy && <Loading label={busy} />}
    {notice && <p role="status">{notice}</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {script && <CodeBlock text={script} language="slurm" />}
  </form>;
}
