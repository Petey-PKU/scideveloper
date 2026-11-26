import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Brain, Plus, Search, Trash2, Upload } from 'lucide-react';
import type { LiteraturePaper, LiteraturePassage, ResearchMemoryCategory, ResearchMemoryItem } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { ErrorNote, Loading, Pill } from './ui';

export function ResearchMemoryPanel({
  workspacePath,
  projectId,
  projectName,
  onChanged,
}: {
  workspacePath?: string;
  projectId?: string;
  projectName?: string;
  onChanged?: () => void;
}) {
  const { t, L } = useI18n();
  const [items, setItems] = useState<ResearchMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<ResearchMemoryCategory>('convention');
  const [scope, setScope] = useState<'global' | 'workspace' | 'project'>(projectId ? 'project' : 'global');
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    setScope(projectId ? 'project' : 'global');
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await api.memoryList({ workspacePath, projectId }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [workspacePath, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setError('');
    try {
      await api.saveMemory({
        scope,
        projectId: scope === 'project' ? projectId : undefined,
        workspacePath: scope === 'workspace' ? workspacePath : undefined,
        category,
        title: title.trim(),
        content: content.trim(),
        tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setTitle('');
      setContent('');
      setTagsText('');
      setAdding(false);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteMemory(id);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const categoryLabels: Record<ResearchMemoryCategory, string> = {
    convention: L('实验规范', 'Convention'),
    hypothesis: L('研究假设', 'Hypothesis'),
    dataset: L('数据说明', 'Dataset Note'),
    finding: L('已验证结论', 'Verified Finding'),
    preference: L('个人偏好', 'Preference'),
  };

  const scopeLabels = {
    project: L('当前项目', 'Project'),
    global: L('全局', 'Global'),
    workspace: L('当前目录', 'Workspace'),
  };

  return (
    <div className="sidebar-scroll stack" style={{ padding: '4px 2px' }}>
      <div className="card-head">
        <Brain size={15} />
        <strong>{projectName ? L(`${projectName} · 记忆`, `${projectName} · Memory`) : L('科研记忆', 'Research Memory')}</strong>
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setAdding((v) => !v)}>
          <Plus size={13} />{t('saveMemory')}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
        {projectName
          ? L(`在「${projectName}」下所有对话中自动共享的实验约定与结论。`, `Notes shared across all chats in "${projectName}" (plus global notes).`)
          : L('记录常用参考基因组、统计口径或已确认结论，后续所有对话会自动沿用。', 'Save lab conventions, reference genomes, and verified findings to reuse automatically across chats.')}
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <form className="soft-card form-stack" onSubmit={(e) => void submit(e)}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L('标题（例如：参考基因组 GRCh38）', 'Title (e.g. Reference Genome GRCh38)')} required />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder={L('具体内容，将在每次分析时自动参考…', 'Details injected into analysis automatically…')} required />
          <div className="grid-2">
            <select value={category} onChange={(e) => setCategory(e.target.value as ResearchMemoryCategory)}>
              <option value="convention">{categoryLabels.convention}</option>
              <option value="hypothesis">{categoryLabels.hypothesis}</option>
              <option value="dataset">{categoryLabels.dataset}</option>
              <option value="finding">{categoryLabels.finding}</option>
              <option value="preference">{categoryLabels.preference}</option>
            </select>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'workspace' | 'project')}>
              {projectId && <option value="project">{L('仅当前项目', 'This Project')}</option>}
              <option value="global">{L('全局生效', 'Global')}</option>
              <option value="workspace" disabled={!workspacePath}>{L('当前数据目录', 'Current Workspace')}</option>
            </select>
          </div>
          <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={L('标签（逗号分隔，可选）', 'Tags (comma separated, optional)')} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>{L('取消', 'Cancel')}</button>
            <button type="submit" className="btn btn-primary">{L('保存', 'Save')}</button>
          </div>
        </form>
      )}

      {loading && <Loading label={L('正在加载记忆…', 'Loading memory…')} />}
      {!loading && items.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>{L('暂无已保存的科研记忆。', 'No saved research notes yet.')}</p>}
      {items.map((item) => (
        <article key={item.id} className="soft-card stack" style={{ padding: 10 }}>
          <div className="card-head">
            <strong style={{ fontSize: 13 }}>{item.title}</strong>
            <button type="button" className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => void remove(item.id)} aria-label={L('删除记忆', 'Delete memory')}>
              <Trash2 size={13} />
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{item.content}</p>
          <div className="pills">
            <Pill tone="blue">{categoryLabels[item.category] ?? item.category}</Pill>
            <Pill>{scopeLabels[item.scope as keyof typeof scopeLabels] ?? item.scope}</Pill>
            {item.tags.slice(0, 3).map((tag) => <Pill key={tag}>{tag}</Pill>)}
          </div>
        </article>
      ))}
    </div>
  );
}

export function LiteratureLibraryPanel({
  projectId,
  projectName,
  onCitePassage,
  onOpenPaperPage,
  onChanged,
}: {
  projectId?: string;
  projectName?: string;
  onCitePassage?: (text: string) => void;
  onOpenPaperPage?: (paperId: string, page: number, query?: string) => void;
  onChanged?: () => void;
}) {
  const { locale, t, L } = useI18n();
  const [papers, setPapers] = useState<LiteraturePaper[]>([]);
  const [passages, setPassages] = useState<LiteraturePassage[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPapers(await api.literatureList(projectId));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(file: File) {
    setUploading(true);
    setError('');
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      await api.importLiterature({
        filename: file.name,
        content: btoa(binary),
        isBase64: true,
        projectId: projectId ?? null,
        title: file.name.replace(/\.(pdf|txt|md)$/i, ''),
      });
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploading(false);
    }
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) { setPassages([]); return; }
    setError('');
    try {
      setPassages(await api.searchLiterature(q, projectId));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <div className="sidebar-scroll stack" style={{ padding: '4px 2px' }}>
      <div className="card-head">
        <BookOpen size={15} />
        <strong>{projectName ? L(`${projectName} · 文献`, `${projectName} · Papers`) : L('本地文献库', 'Local Papers')} ({papers.length})</strong>
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} disabled={uploading} onClick={() => fileRef.current?.click()}>
          <Upload size={13} />{uploading ? L('索引中…', 'Indexing…') : t('uploadPaper')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,.md"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUpload(f);
            e.target.value = '';
          }}
        />
      </div>

      <form onSubmit={(e) => void runSearch(e)} className="sidebar-search">
        <Search size={13} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPapers')}
        />
      </form>

      {error && <ErrorNote>{error}</ErrorNote>}

      {passages.length > 0 && (
        <div className="stack">
          <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>{L(`匹配段落（${passages.length}）`, `Matching Passages (${passages.length})`)}</span>
          {passages.map((p, idx) => (
            <article key={`${p.paperId}-${p.page}-${idx}`} className="soft-card stack" style={{ padding: 9 }}>
              <div className="pills">
                <strong style={{ fontSize: 12 }}>{p.paperTitle}</strong>
                <Pill tone="teal">{L(`第 ${p.page} 页`, `p. ${p.page}`)}</Pill>
                {p.matchMode && (
                  <Pill tone={p.matchMode === 'hybrid' ? 'teal' : p.matchMode === 'semantic' ? 'blue' : 'neutral'}>
                    {p.matchMode === 'hybrid' ? L('混合检索', 'Hybrid') : p.matchMode === 'semantic' ? L('语义拓展', 'Semantic') : L('关键词', 'Exact')}
                  </Pill>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12 }}>{p.text.slice(0, 260)}…</p>
              <div className="actions justify-start">
                {onOpenPaperPage && (
                  <button
                    type="button"
                    className="btn btn-soft-active"
                    onClick={() => onOpenPaperPage(p.paperId, p.page, query.trim() || undefined)}
                  >
                    <BookOpen size={12} />{L('原文高亮定位', 'Highlight Page')}
                  </button>
                )}
                {onCitePassage && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onCitePassage(
                      locale === 'zh'
                        ? `请结合文献「${p.paperTitle}」（第 ${p.page} 页）分析以下段落：\n> ${p.text.slice(0, 400)}\n`
                        : `Analyze this passage from "${p.paperTitle}" (p. ${p.page}):\n> ${p.text.slice(0, 400)}\n`,
                    )}
                  >
                    {L('向 AI 提问', 'Ask AI')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {loading && <Loading label={L('正在加载文献库…', 'Loading papers…')} />}
      {!loading && papers.length === 0 && (
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
          {L('导入本地 PDF 文献后，即可进行全文段落检索并在分析中精准引用。', 'Import local PDF papers for full-text passage search and direct citation during analysis.')}
        </p>
      )}
      {papers.map((paper) => (
        <article key={paper.id} className="soft-card stack" style={{ padding: 10 }}>
          <div className="card-head" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
            <button
              type="button"
              style={{ flex: 1, minWidth: 0, textAlign: 'left', fontWeight: 620, fontSize: 13 }}
              className="truncate"
              title={paper.title}
              onClick={() => onOpenPaperPage?.(paper.id, 1, query.trim() || undefined)}
            >
              {paper.title}
            </button>
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => void api.deleteLiterature(paper.id).then(() => { void load(); onChanged?.(); })}
              aria-label={L('删除文献', 'Delete paper')}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="pills">
            <Pill tone="blue">{L(`${paper.pageCount} 页`, `${paper.pageCount} page(s)`)}</Pill>
            <Pill>{L(`${paper.chunkCount} 片段`, `${paper.chunkCount} chunk(s)`)}</Pill>
            {paper.year && <Pill>{paper.year}</Pill>}
            {paper.doi && <Pill>{paper.doi}</Pill>}
          </div>
        </article>
      ))}
    </div>
  );
}
