import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, BookOpen, Code2, Download, FileText, Play, PlayCircle, Plus,
  RefreshCw, RotateCcw, Save, Trash2, Upload, Variable,
} from 'lucide-react';
import type {
  KernelVariableInfo, NotebookCell, NotebookDocument, ScientificArtifact,
} from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { CodeBlock, ErrorNote, Loading, Markdown, Pill } from './ui';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function NotebookStudioPanel({
  sessionId,
  initialCode,
  initialLanguage = 'python',
  sourceArtifactId,
  artifacts,
  onExecuted,
  onOpenArtifact,
}: {
  sessionId: string;
  initialCode?: string;
  initialLanguage?: 'python' | 'r';
  sourceArtifactId?: string;
  artifacts: ScientificArtifact[];
  onExecuted?: (artifacts: ScientificArtifact[]) => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { t, L } = useI18n();
  const [notebook, setNotebook] = useState<NotebookDocument>();
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingMdIds, setEditingMdIds] = useState<Record<string, boolean>>({});
  const [vars, setVars] = useState<{ python: KernelVariableInfo[]; r: KernelVariableInfo[] }>({ python: [], r: [] });
  const [loadingVars, setLoadingVars] = useState(false);
  const [showVars, setShowVars] = useState(true);
  const [varLang, setVarLang] = useState<'python' | 'r'>(initialLanguage);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadNotebook = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const doc = await api.notebook(sessionId);
      setNotebook(doc);
      setCells(doc.cells);
      setDirty(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const refreshVars = useCallback(async () => {
    setLoadingVars(true);
    try {
      setVars(await api.kernelVariables(sessionId));
    } catch {
      // ignore idle kernel
    } finally {
      setLoadingVars(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadNotebook();
    void refreshVars();
  }, [loadNotebook, refreshVars]);

  // If user clicked "Edit & Run" from Methods/Code inspector, append or focus a seeded cell cleanly
  useEffect(() => {
    if (!initialCode) return;
    setCells((prev) => {
      const existing = sourceArtifactId ? prev.find((c) => c.sourceArtifactId === sourceArtifactId) : undefined;
      if (existing) {
        return prev.map((c) => (c.id === existing.id ? { ...c, source: initialCode, editedByResearcher: true } : c));
      }
      const seeded: NotebookCell = {
        id: 'cell_' + Math.random().toString(36).slice(2, 10),
        kind: 'code',
        language: initialLanguage,
        title: `Edited ${initialLanguage.toUpperCase()} Cell`,
        source: initialCode,
        sourceArtifactId,
        editedByResearcher: true,
      };
      return [...prev, seeded];
    });
    setDirty(true);
  }, [initialCode, initialLanguage, sourceArtifactId]);

  async function persistCells(nextCells: NotebookCell[], silent = false): Promise<NotebookDocument | undefined> {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveNotebook(sessionId, { title: notebook?.title, cells: nextCells });
      setNotebook(saved);
      setCells(saved.cells);
      setDirty(false);
      if (!silent) setNotice(L('笔记本已保存', 'Notebook saved'));
      return saved;
    } catch (cause) {
      setError(errorText(cause));
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  function addCell(kind: 'code' | 'markdown', language: 'python' | 'r' | 'markdown') {
    const id = 'cell_' + Math.random().toString(36).slice(2, 10);
    const next: NotebookCell = {
      id,
      kind,
      language,
      title: kind === 'markdown' ? L('分析笔记', 'Notes') : `${language.toUpperCase()} Cell`,
      source: kind === 'markdown'
        ? '### Analysis Note\nDocument methodology, assumptions, or observations here.'
        : language === 'python'
          ? '# Variables persist across cells in this session\nimport pandas as pd\nprint("Cell ready")'
          : '# Persistent R cell\nprint("R cell ready")',
      editedByResearcher: true,
    };
    const updated = [...cells, next];
    setCells(updated);
    setDirty(true);
    if (kind === 'markdown') setEditingMdIds((m) => ({ ...m, [id]: true }));
  }

  function updateCell(id: string, patch: Partial<NotebookCell>) {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch, editedByResearcher: true } : c)));
    setDirty(true);
  }

  function moveCell(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= cells.length) return;
    const copy = [...cells];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    setCells(copy);
    setDirty(true);
  }

  function deleteCell(id: string) {
    const next = cells.filter((c) => c.id !== id);
    setCells(next);
    setDirty(true);
  }

  async function runSingleCell(cell: NotebookCell) {
    if (cell.kind !== 'code' || runningCellId || runningAll) return;
    setRunningCellId(cell.id);
    setError('');
    setNotice('');
    try {
      if (dirty) await persistCells(cells, true);
      const lang: 'python' | 'r' = cell.language === 'r' ? 'r' : 'python';
      const res = await api.runNotebookCell(sessionId, cell.id, { source: cell.source, language: lang });
      setNotebook(res.notebook);
      setCells(res.notebook.cells);
      setDirty(false);
      onExecuted?.(res.artifacts);
      await refreshVars();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunningCellId(null);
    }
  }

  async function runAllCells() {
    if (runningAll || runningCellId) return;
    setRunningAll(true);
    setError('');
    setNotice('');
    try {
      if (dirty) await persistCells(cells, true);
      const res = await api.runAllNotebookCells(sessionId);
      setNotebook(res.notebook);
      setCells(res.notebook.cells);
      setDirty(false);
      onExecuted?.(res.artifacts);
      await refreshVars();
      setNotice(
        res.failedCellId
          ? L('部分代码格执行出错，已在出错格停止。', 'Stopped on failed cell.')
          : L('全部代码格已顺序执行完成。', 'All code cells executed cleanly.'),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunningAll(false);
    }
  }

  async function handleImportIpynb(file: File) {
    setImporting(true);
    setError('');
    setNotice('');
    try {
      const content = await file.text();
      const res = await api.importNotebook(sessionId, { filename: file.name, content, isBase64: false });
      setNotebook(res.notebook);
      setCells(res.notebook.cells);
      setDirty(false);
      setNotice(L(`已成功导入 ${res.importedCells} 个 Notebook 单元格`, `Imported ${res.importedCells} cell(s) from ${file.name}`));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
    }
  }

  async function restartKernel() {
    setResetting(true);
    setError('');
    try {
      await api.resetKernel(sessionId, 'all');
      await refreshVars();
      setNotice(L('Python / R 内核已重启', 'Python / R kernel restarted'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setResetting(false);
    }
  }

  const activeVars = varLang === 'python' ? vars.python : vars.r;
  const artifactMap = new Map(artifacts.map((a) => [a.id, a]));

  return (
    <div className="stack">
      {/* Notebook Studio Top Toolbar */}
      <div className="soft-card stack" style={{ gap: 8 }}>
        <div className="card-head">
          <BookOpen size={15} className="text-teal" />
          <strong>{L('Jupyter 多格笔记本工作台', 'Jupyter Notebook Studio')}</strong>
          <Pill tone="teal">{cells.length} {L('单元格', 'cells')}</Pill>
          {dirty && <Pill tone="amber">{L('未保存更改', 'Unsaved')}</Pill>}
        </div>

        <div className="viewer-toolbar">
          <div className="actions justify-start">
            <button type="button" className="btn btn-primary" disabled={runningAll || Boolean(runningCellId) || cells.every((c) => c.kind !== 'code')} onClick={() => void runAllCells()}>
              <PlayCircle size={13} />{runningAll ? L('顺序执行中…', 'Running All…') : L('运行全部', 'Run All')}
            </button>
            <button type="button" className="btn" onClick={() => addCell('code', 'python')}>
              <Plus size={12} /><Code2 size={12} />Python
            </button>
            <button type="button" className="btn" onClick={() => addCell('code', 'r')}>
              <Plus size={12} />R
            </button>
            <button type="button" className="btn" onClick={() => addCell('markdown', 'markdown')}>
              <Plus size={12} /><FileText size={12} />Markdown
            </button>
          </div>
          <div className="actions">
            {dirty && (
              <button type="button" className="btn btn-soft-active" disabled={saving} onClick={() => void persistCells(cells)}>
                <Save size={12} />{saving ? L('保存中…', 'Saving…') : L('保存', 'Save')}
              </button>
            )}
            <button type="button" className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
              <Upload size={12} />{importing ? L('导入中…', 'Importing…') : L('导入 .ipynb', 'Import .ipynb')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".ipynb,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportIpynb(f);
                e.target.value = '';
              }}
            />
            <a className="btn" href={api.exportNotebookUrl(sessionId)} download>
              <Download size={12} />{L('导出 .ipynb', 'Export .ipynb')}
            </a>
            <button type="button" className="btn" disabled={resetting || runningAll} onClick={() => void restartKernel()}>
              <RotateCcw size={12} />{t('restartKernel')}
            </button>
          </div>
        </div>

        {notice && <p className="text-teal" style={{ fontSize: 12, fontWeight: 560 }}>{notice}</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>

      {/* Multi-Cell List */}
      {loading ? (
        <Loading label={L('正在构建会话多格 Notebook…', 'Building multi-cell session notebook…')} />
      ) : cells.length === 0 ? (
        <div className="soft-card studio-empty" style={{ marginTop: 0 }}>
          <p>{L('当前会话尚无 Notebook 单元格。点击上方「+ Python」新建代码格或导入已有 .ipynb 文件。', 'No cells yet. Click "+ Python" to add a cell or import an existing .ipynb notebook.')}</p>
        </div>
      ) : (
        <div className="notebook-cells">
          {cells.map((cell, idx) => {
            const isRunning = runningCellId === cell.id;
            const isEditingMd = cell.kind === 'markdown' && Boolean(editingMdIds[cell.id]);
            const cellArtifacts = (cell.output?.artifactIds ?? [])
              .map((aid) => artifactMap.get(aid))
              .filter((a): a is ScientificArtifact => Boolean(a));

            return (
              <article key={cell.id} className={'nb-cell ' + (cell.kind === 'code' ? 'nb-cell-code' : 'nb-cell-md') + (isRunning ? ' running' : '')}>
                <div className="nb-cell-head">
                  <span className="nb-gutter">
                    {cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]` : 'MD'}
                  </span>
                  {cell.kind === 'code' ? (
                    <select
                      value={cell.language === 'r' ? 'r' : 'python'}
                      aria-label={L('代码语言', 'Cell language')}
                      onChange={(e) => updateCell(cell.id, { language: e.target.value as 'python' | 'r' })}
                      style={{ padding: '1px 6px', fontSize: 11.5, borderRadius: 6 }}
                    >
                      <option value="python">Python 3</option>
                      <option value="r">R</option>
                    </select>
                  ) : (
                    <Pill tone="neutral">Markdown</Pill>
                  )}
                  {cell.title && <span className="muted truncate" style={{ fontSize: 12, flex: 1 }}>{cell.title}</span>}
                  {cell.editedByResearcher && <Pill tone="blue">{L('人工编辑', 'Edited')}</Pill>}
                  <div className="nb-cell-actions">
                    {cell.kind === 'code' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ minHeight: 24, padding: '2px 8px', fontSize: 11.5 }}
                        disabled={isRunning || runningAll}
                        onClick={() => void runSingleCell(cell)}
                      >
                        <Play size={11} />{isRunning ? L('运行中…', 'Running…') : L('运行', 'Run')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        style={{ minHeight: 24, padding: '2px 8px', fontSize: 11.5 }}
                        onClick={() => setEditingMdIds((m) => ({ ...m, [cell.id]: !m[cell.id] }))}
                      >
                        {isEditingMd ? L('预览', 'Preview') : L('编辑', 'Edit')}
                      </button>
                    )}
                    <button type="button" className="icon-btn" style={{ width: 24, minHeight: 24 }} disabled={idx === 0} onClick={() => moveCell(idx, -1)} aria-label={L('上移', 'Move up')}>
                      <ArrowUp size={12} />
                    </button>
                    <button type="button" className="icon-btn" style={{ width: 24, minHeight: 24 }} disabled={idx === cells.length - 1} onClick={() => moveCell(idx, 1)} aria-label={L('下移', 'Move down')}>
                      <ArrowDown size={12} />
                    </button>
                    <button type="button" className="icon-btn" style={{ width: 24, minHeight: 24 }} onClick={() => deleteCell(cell.id)} aria-label={L('删除单元格', 'Delete cell')}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {cell.kind === 'code' ? (
                  <textarea
                    className="code-editor-area nb-code-input"
                    rows={Math.max(3, Math.min(18, cell.source.split('\n').length + 1))}
                    value={cell.source}
                    spellCheck={false}
                    onChange={(e) => updateCell(cell.id, { source: e.target.value })}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void runSingleCell(cell);
                      }
                    }}
                  />
                ) : isEditingMd ? (
                  <textarea
                    rows={Math.max(3, Math.min(12, cell.source.split('\n').length + 1))}
                    value={cell.source}
                    onChange={(e) => updateCell(cell.id, { source: e.target.value })}
                    style={{ width: '100%', fontSize: 13 }}
                  />
                ) : (
                  <div className="nb-md-preview" onDoubleClick={() => setEditingMdIds((m) => ({ ...m, [cell.id]: true }))}>
                    <Markdown text={cell.source} />
                  </div>
                )}

                {cell.output && (cell.output.stdout || cell.output.stderr || cell.output.exitCode !== undefined || cell.output.imagesBase64?.length || cellArtifacts.length > 0) && (
                  <div className="nb-cell-output stack" style={{ gap: 6 }}>
                    <div className="pills">
                      {cell.output.exitCode !== undefined && (
                        <Pill tone={cell.output.exitCode === 0 ? 'teal' : 'red'}>
                          {cell.output.exitCode === 0 ? L('执行成功', 'Exit 0') : `Exit ${cell.output.exitCode}`}
                        </Pill>
                      )}
                      {cell.output.durationMs !== undefined && <Pill>{cell.output.durationMs} ms</Pill>}
                      {cellArtifacts.map((art) => (
                        <button
                          key={art.id}
                          type="button"
                          className="tab-pill selected"
                          onClick={() => onOpenArtifact?.(art.id)}
                        >
                          {art.title}
                        </button>
                      ))}
                    </div>
                    {cell.output.stdout && <CodeBlock text={cell.output.stdout} />}
                    {cell.output.stderr && <ErrorNote>{cell.output.stderr}</ErrorNote>}
                    {cell.output.imagesBase64?.map((img, i) => (
                      <div key={i} className="image-stage">
                        <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.title || `Output ${i + 1}`} />
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Collapsible Live Kernel Variable Explorer */}
      <details className="disclosure-card" open={showVars} onToggle={(e) => setShowVars((e.target as HTMLDetailsElement).open)}>
        <summary>
          <Variable size={15} />
          <span>{t('variables')} ({activeVars.length})</span>
          <div className="actions" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <select
              value={varLang}
              onChange={(e) => setVarLang(e.target.value as 'python' | 'r')}
              style={{ padding: '2px 6px', fontSize: 12, borderRadius: 6 }}
            >
              <option value="python">Python ({vars.python.length})</option>
              <option value="r">R ({vars.r.length})</option>
            </select>
            <button type="button" className="btn" style={{ minHeight: 26, padding: '2px 8px', fontSize: 12 }} disabled={loadingVars} onClick={() => void refreshVars()}>
              <RefreshCw size={12} />{L('刷新', 'Refresh')}
            </button>
          </div>
        </summary>
        <div className="disclosure-body stack">
          {loadingVars && <Loading label={L('正在读取内核变量…', 'Inspecting kernel memory…')} />}
          {!loadingVars && activeVars.length === 0 && <p className="muted">{t('noVariables')}</p>}
          {activeVars.length > 0 && (
            <div className="stack">
              {activeVars.map((v) => (
                <div key={v.name} className="kv-card">
                  <div className="pills">
                    <code><strong>{v.name}</strong></code>
                    <Pill tone="blue">{v.typeName}</Pill>
                    {v.shape && <Pill tone="teal">{v.shape}</Pill>}
                    {v.sizeBytes ? <Pill>{formatBytes(v.sizeBytes)}</Pill> : null}
                  </div>
                  {v.columns && v.columns.length > 0 && (
                    <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                      {L('列名：', 'Columns: ')}{v.columns.slice(0, 10).join(', ')}{v.columns.length > 10 ? ` (+${v.columns.length - 10})` : ''}
                    </p>
                  )}
                  {v.preview && <pre className="var-preview">{v.preview}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
