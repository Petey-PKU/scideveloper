import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, MessageSquarePlus, Search, X } from 'lucide-react';
import type { LiteraturePageView } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { ErrorNote, Loading, Pill } from './ui';

function renderHighlightedText(text: string, spans: Array<{ start: number; end: number; term: string }>): ReactNode {
  if (!spans.length) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const span = sorted[i];
    if (span.start < cursor || span.end <= span.start || span.start > text.length) continue;
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    parts.push(
      <mark key={`${span.start}-${i}`} className="paper-highlight" title={span.term}>
        {text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export default function PaperReaderViewer({
  paperId,
  initialPage = 1,
  initialQuery = '',
  onAskPassage,
  onClose,
}: {
  paperId: string;
  initialPage?: number;
  initialQuery?: string;
  onAskPassage?: (prompt: string) => void;
  onClose?: () => void;
}) {
  const { locale, L } = useI18n();
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState(initialQuery);
  const [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [view, setView] = useState<LiteraturePageView>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setPage(initialPage);
    setQuery(initialQuery);
    setAppliedQuery(initialQuery);
  }, [paperId, initialPage, initialQuery]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setView(await api.literaturePage(paperId, page, appliedQuery || undefined));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [paperId, page, appliedQuery]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const rendered = useMemo(
    () => (view ? renderHighlightedText(view.text, view.highlightSpans) : null),
    [view],
  );

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setAppliedQuery(query.trim());
  }

  return (
    <div className="paper-reader stack">
      <div className="soft-card stack">
        <div className="card-head">
          <BookOpen size={15} className="text-teal" />
          <strong className="truncate" style={{ flex: 1 }} title={view?.paper.title}>
            {view?.paper.title ?? L('文献原文阅读器', 'Paper Page Reader')}
          </strong>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label={L('关闭原文阅读', 'Close reader')}>
              <X size={15} />
            </button>
          )}
        </div>

        {view && (
          <div className="pills">
            <Pill tone="teal">{L(`第 ${view.page} / ${view.totalPages} 页`, `Page ${view.page} / ${view.totalPages}`)}</Pill>
            {view.paper.year && <Pill>{view.paper.year}</Pill>}
            {view.paper.journal && <Pill tone="blue">{view.paper.journal}</Pill>}
            {view.paper.pmid && <Pill>PMID:{view.paper.pmid}</Pill>}
            {view.paper.doi && <Pill>DOI:{view.paper.doi}</Pill>}
            {view.highlightSpans.length > 0 && (
              <Pill tone="amber">{L(`${view.highlightSpans.length} 处高亮命中`, `${view.highlightSpans.length} highlight(s)`)}</Pill>
            )}
          </div>
        )}

        <div className="viewer-toolbar">
          <form onSubmit={submitSearch} className="table-search" style={{ flex: 1 }}>
            <Search size={13} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={L('页内关键词高亮定位…', 'Highlight terms on this page…')}
            />
          </form>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={!view || page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={13} />{L('上一页', 'Prev')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!view || page >= view.totalPages}
              onClick={() => setPage((p) => Math.min(view?.totalPages ?? p, p + 1))}
            >
              {L('下一页', 'Next')}<ChevronRight size={13} />
            </button>
            {onAskPassage && view && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onAskPassage(
                  locale === 'zh'
                    ? `请结合文献「${view.paper.title}」第 ${view.page} 页原文进行分析：\n> ${view.text.slice(0, 600)}\n`
                    : `Analyze this passage from "${view.paper.title}" (page ${view.page}):\n> ${view.text.slice(0, 600)}\n`,
                )}
              >
                <MessageSquarePlus size={13} />{L('针对此页提问', 'Ask about page')}
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading label={L('正在加载文献页与高亮片段…', 'Loading paper page & highlights…')} />}
      {!loading && view && (
        <article className="manuscript-paper paper-page-body">
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.75 }}>
            {rendered}
          </div>
        </article>
      )}
    </div>
  );
}
