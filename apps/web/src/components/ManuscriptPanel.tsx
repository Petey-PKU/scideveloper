import { useState } from 'react';
import { BookMarked, BookOpenCheck, Check, Copy, Download, FileArchive, FileCode2, FileText, Sparkles } from 'lucide-react';
import type { ManuscriptDraft } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { TextDownload } from './ArtifactViewer';
import { CodeBlock, ErrorNote, Loading, Markdown, Pill } from './ui';

export default function ManuscriptPanel({
  sessionId,
  hasContent,
  onCompiled,
}: {
  sessionId?: string;
  hasContent: boolean;
  onCompiled: () => Promise<void>;
}) {
  const { L } = useI18n();
  const [draft, setDraft] = useState<ManuscriptDraft>();
  const [markdown, setMarkdown] = useState('');
  const [mode, setMode] = useState<'preview' | 'markdown' | 'latex' | 'bibtex'>('preview');
  const [titleInput, setTitleInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function compile() {
    if (!sessionId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.compileManuscript(sessionId, { title: titleInput.trim() || undefined });
      setDraft(res.manuscript);
      setMarkdown(res.manuscript.markdownSource);
      await onCompiled();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function downloadBinary(format: 'overleaf-zip' | 'docx') {
    if (!sessionId || exporting) return;
    setExporting(format);
    setError('');
    try {
      const blob = await api.exportManuscriptBinary(sessionId, format, draft?.title || titleInput.trim() || undefined);
      const slug = (draft?.title || 'scideveloper_manuscript').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const ext = format === 'overleaf-zip' ? '_overleaf.zip' : '.docx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = slug + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setExporting('');
    }
  }

  async function copySource(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  }

  if (!draft) {
    return <section className="stack">
      <div className="studio-empty">
        <div className="empty-icon"><BookOpenCheck size={22} strokeWidth={1.6} /></div>
        <h3>{L('论文手稿生成', 'Publication Manuscript Studio')}</h3>
        <p>{L('自动整合本次分析结论、方法学描述、生成图表及已核验文献，一键导出 Markdown、LaTeX、BibTeX、Overleaf 压缩包或 Word (.docx)。', 'Compile findings, methods, figures, and verified citations into Markdown, LaTeX, BibTeX, Overleaf ZIP, or Word (.docx).')}</p>
        <div className="stack mt-3" style={{ width: '100%', maxWidth: 360, marginInline: 'auto' }}>
          <input
            value={titleInput}
            onChange={e => setTitleInput(e.target.value)}
            placeholder={L('输入论文标题（可选）…', 'Optional manuscript title…')}
          />
          <button type="button" className="btn btn-primary" disabled={!sessionId || !hasContent || busy} onClick={() => void compile()}>
            {busy ? <Loading label={L('正在生成手稿…', 'Compiling manuscript…')} /> : <><Sparkles size={15} />{L('一键生成论文手稿', 'Compile Manuscript')}</>}
          </button>
        </div>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      </div>
    </section>;
  }

  const slug = draft.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'scideveloper_manuscript';
  const activeText = mode === 'latex' ? draft.latexSource : mode === 'bibtex' ? (draft.bibtexSource || '') : markdown;

  return <section className="stack">
    <div className="soft-card stack">
      <div className="card-head">
        <strong>{draft.title}</strong>
        <button type="button" className="btn" disabled={busy} onClick={() => void compile()}>
          {busy ? <Loading label={L('更新中…', 'Updating…')} /> : <><Sparkles size={13} />{L('重新生成', 'Re-compile')}</>}
        </button>
      </div>
      <div className="pills">
        <Pill tone="teal">{L(`${draft.sections.length} 个章节`, `${draft.sections.length} sections`)}</Pill>
        <Pill tone="blue">{L(`${draft.citations.filter(c => c.verified).length} 条已核验引用`, `${draft.citations.filter(c => c.verified).length} verified refs`)}</Pill>
        <Pill>{L(`${draft.figureArtifactIds.length} 张图表`, `${draft.figureArtifactIds.length} figures`)}</Pill>
      </div>
      <div className="actions justify-start">
        <button type="button" className={'btn' + (mode === 'preview' ? ' btn-soft-active' : '')} onClick={() => setMode('preview')}><BookOpenCheck size={13} />{L('预览', 'Preview')}</button>
        <button type="button" className={'btn' + (mode === 'markdown' ? ' btn-soft-active' : '')} onClick={() => setMode('markdown')}><FileText size={13} />{L('编辑 MD', 'Edit MD')}</button>
        <button type="button" className={'btn' + (mode === 'latex' ? ' btn-soft-active' : '')} onClick={() => setMode('latex')}><FileCode2 size={13} />LaTeX</button>
        <button type="button" className={'btn' + (mode === 'bibtex' ? ' btn-soft-active' : '')} onClick={() => setMode('bibtex')}><BookMarked size={13} />BibTeX</button>
        <button type="button" className="btn" onClick={() => void copySource(activeText)}>
          {copied ? <><Check size={13} />{L('已复制', 'Copied')}</> : <><Copy size={13} />{L('复制', 'Copy')}</>}
        </button>
      </div>
      <div className="actions justify-start">
        <TextDownload name={slug + '.md'} content={markdown} />
        <TextDownload name={slug + '.tex'} content={draft.latexSource} />
        {draft.bibtexSource && <TextDownload name={slug + '.bib'} content={draft.bibtexSource} />}
        <button type="button" className="btn btn-primary" disabled={!!exporting} onClick={() => void downloadBinary('overleaf-zip')}>
          {exporting === 'overleaf-zip' ? <Loading label={L('打包中…', 'Packing…')} /> : <><FileArchive size={13} />Overleaf ZIP</>}
        </button>
        <button type="button" className="btn" disabled={!!exporting} onClick={() => void downloadBinary('docx')}>
          {exporting === 'docx' ? <Loading label={L('生成中…', 'Building…')} /> : <><Download size={13} />Word (.docx)</>}
        </button>
      </div>
    </div>

    {error && <ErrorNote>{error}</ErrorNote>}

    {mode === 'preview' && <article className="manuscript-paper"><Markdown text={markdown} /></article>}
    {mode === 'markdown' && (
      <textarea
        className="manuscript-editor"
        rows={22}
        value={markdown}
        onChange={e => setMarkdown(e.target.value)}
        aria-label={L('编辑论文 Markdown', 'Editable manuscript markdown')}
      />
    )}
    {mode === 'latex' && <CodeBlock text={draft.latexSource} language="latex" />}
    {mode === 'bibtex' && <CodeBlock text={draft.bibtexSource || L('% 当前会话尚未记录 BibTeX 文献引用。', '% No BibTeX references recorded in this session.')} />}
  </section>;
}
