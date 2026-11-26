import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, FileDown, LoaderCircle, X } from 'lucide-react';
import type { AgentRole, ReviewReport, SpillHandle } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n, type Locale } from '../i18n';

export const roleNames: Record<AgentRole, string> = {
  user: 'You',
  coordinator: 'Analysis',
  specialist: 'Data & Compute',
  reviewer: 'Quality Check',
  tool: 'Tool',
  system: 'System',
};

const roleNamesZh: Record<AgentRole, string> = {
  user: '我',
  coordinator: '分析综合',
  specialist: '数据与计算',
  reviewer: '质量审查',
  tool: '工具',
  system: '系统',
};

export function roleLabel(role: AgentRole, locale: Locale): string {
  return (locale === 'zh' ? roleNamesZh[role] : roleNames[role]) ?? role;
}

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
export const time = (stamp: string) => new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const shortDate = (stamp: string) => {
  const date = new Date(stamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time(stamp);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
export const bytes = (size: number) => (size < 1024 ? size + ' B' : (size / 1024).toFixed(1) + ' KB');
export const digest = (hash: string) => hash.slice(0, 12);

export function Pill({ children, tone = 'neutral', title }: { children: ReactNode; tone?: string; title?: string }) {
  return <span className={'pill pill-' + tone} title={title}>{children}</span>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="error-note" role="alert"><AlertCircle size={15} /><span>{children}</span></div>;
}

export function Loading({ label }: { label?: string }) {
  const { L } = useI18n();
  const text = label === undefined ? L('加载中…', 'Loading…') : label;
  return <span className="loading" role="status"><LoaderCircle size={15} className="animate-spin" />{text}</span>;
}

export function Modal({ title, subtitle, size = 'md', onClose, children }: {
  title: string; subtitle?: string; size?: 'md' | 'lg' | 'full'; onClose: () => void; children: ReactNode;
}) {
  const { L } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className={'modal modal-' + size} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="modal-head">
      <div className="min-w-0">
        <h2>{title}</h2>
        {subtitle && <p className="muted modal-sub">{subtitle}</p>}
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label={L('关闭弹窗', 'Close dialog')}><X size={18} /></button>
    </div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

type CitationEntry = ReviewReport['verifiedCitations'][number];

function CitationChip({
  rawId,
  index,
  record,
  onInspect,
}: {
  rawId: string;
  index: number;
  record?: CitationEntry;
  onInspect?: () => void;
}) {
  const { L } = useI18n();
  const isPmid = /^\d+$/.test(rawId);
  const url = record?.url ?? (isPmid ? `https://pubmed.ncbi.nlm.nih.gov/${rawId}/` : `https://doi.org/${rawId}`);
  const verified = record?.verified;
  return (
    <span className="citation-chip-wrap">
      <button
        type="button"
        className={'citation-chip' + (verified === true ? ' verified' : verified === false ? ' unverified' : '')}
        onClick={() => onInspect ? onInspect() : window.open(url, '_blank', 'noopener,noreferrer')}
        title={record?.title ?? (isPmid ? `PMID:${rawId}` : rawId)}
      >
        [{index}]
      </button>
      <span className="citation-popover" role="tooltip">
        <span className="citation-pop-head">
          {verified === true
            ? <span className="text-teal"><CheckCircle2 size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />{L('已核验', 'Verified')}</span>
            : verified === false
              ? <span className="text-amber">{L('未核验', 'Unverified')}</span>
              : <span>{L('参考文献', 'Reference')}</span>}
          <code>{isPmid ? `PMID:${rawId}` : rawId}</code>
        </span>
        {record?.title && <strong className="citation-pop-title">{record.title}</strong>}
        {(record?.journal || record?.year) && (
          <span className="muted">{[record.journal, record.year].filter(Boolean).join(' · ')}</span>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer" className="citation-pop-link">
          {L('打开原文链接', 'Open source')} <ExternalLink size={11} />
        </a>
      </span>
    </span>
  );
}

function renderWithCitations(
  text: string,
  citationMap: Map<string, { idx: number; record?: CitationEntry }>,
  onInspect?: () => void,
): ReactNode {
  const pattern = /(\bPMID\s*[:#]?\s*\d{6,9}\b|\b10\.\d{4,9}\/[A-Za-z0-9._;()\/:-]+\b)/gi;
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((segment, i) => {
    const pmidMatch = segment.match(/^PMID\s*[:#]?\s*(\d{6,9})$/i);
    const doiMatch = !pmidMatch ? segment.match(/^(10\.\d{4,9}\/[A-Za-z0-9._;()\/:-]+)$/) : null;
    if (!pmidMatch && !doiMatch) return <Fragment key={i}>{segment}</Fragment>;
    const cleanId = (pmidMatch ? pmidMatch[1] : doiMatch![1]).replace(/[.,;)\]]+$/, '');
    let entry = citationMap.get(cleanId);
    if (!entry) {
      entry = { idx: citationMap.size + 1 };
      citationMap.set(cleanId, entry);
    }
    return (
      <Fragment key={i}>
        <span className="citation-inline-text">{segment}</span>
        <CitationChip rawId={cleanId} index={entry.idx} record={entry.record} onInspect={onInspect} />
      </Fragment>
    );
  });
}

function inline(
  text: string,
  citationMap: Map<string, { idx: number; record?: CitationEntry }>,
  onInspect?: () => void,
) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{renderWithCitations(part.slice(2, -2), citationMap, onInspect)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{renderWithCitations(part, citationMap, onInspect)}</Fragment>;
  });
}

export function CodeBlock({ text, language }: { text: string; language?: string }) {
  const shell = /^(?:bash|sh|shell|slurm|sbatch)$/i.test(language ?? '');
  const scientific = /^(?:python|py|r)$/i.test(language ?? '');
  const lines = shell || scientific ? text.split('\n') : [];
  return <pre className="code-block" tabIndex={0}><code>{lines.length ? lines.map((line, index) => {
    const kind = /^\s*#SBATCH\b/.test(line) ? 'directive' : /^\s*#/.test(line) ? 'comment' : '';
    const fragments = scientific && !kind ? line.split(/\b(import|from|as|def|class|return|if|elif|else|for|in|while|with|try|except|function|library|TRUE|FALSE|NULL|NA|True|False|None)\b/) : [line];
    return <span key={index} className={kind}>{fragments.map((fragment, part) => part % 2 ? <span className="directive" key={part}>{fragment}</span> : fragment)}{index < lines.length - 1 ? '\n' : ''}</span>;
  }) : text}</code></pre>;
}

export function Markdown({
  text,
  citations,
  onCitationClick,
}: {
  text: string;
  citations?: CitationEntry[];
  onCitationClick?: () => void;
}) {
  const { L } = useI18n();
  const citationMap = new Map<string, { idx: number; record?: CitationEntry }>();
  if (citations) {
    citations.forEach((c, i) => citationMap.set(c.identifier, { idx: i + 1, record: c }));
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const listPattern = /^\s*[-*+]\s+(.+)/;
  const headingPattern = /^(#{1,6})\s+(.+)/;
  const fence = /^```([\w-]*)/;
  const tableSep = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;
  const parseTableRow = (row: string) =>
    row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

  for (let i = 0; i < lines.length;) {
    const start = i;
    const line = lines[i++];
    const code = line.match(fence);
    const heading = line.match(headingPattern);
    const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (code) {
      const body = [];
      while (i < lines.length && !fence.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<CodeBlock key={start} text={body.join('\n')} language={code[1]} />);
    } else if (line.includes('|') && i < lines.length && tableSep.test(lines[i])) {
      const headers = parseTableRow(line);
      i++; // consume separator row
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseTableRow(lines[i++]));
      }
      blocks.push(
        <div key={start} className="data-scroll md-table-wrap">
          <table>
            <thead>
              <tr>{headers.map((cell, ci) => <th key={ci}>{inline(cell, citationMap, onCitationClick)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => <td key={ci}>{inline(row[ci] ?? '', citationMap, onCitationClick)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (imgMatch) {
      blocks.push(
        <div key={start} className="soft-card pills" style={{ margin: '6px 0' }}>
          <Pill tone="teal">{L('图表', 'Figure')}</Pill>
          <strong>{imgMatch[1] || L('图表', 'Figure')}</strong>
          <code className="muted">{fileName(imgMatch[2])}</code>
        </div>,
      );
    } else if (heading) {
      const Heading = heading[1].length < 3 ? 'h3' : 'h4';
      blocks.push(<Heading key={start}>{inline(heading[2], citationMap, onCitationClick)}</Heading>);
    } else if (listPattern.test(line)) {
      const items = [line.match(listPattern)![1]];
      while (i < lines.length && listPattern.test(lines[i])) items.push(lines[i++].match(listPattern)![1]);
      blocks.push(<ul key={start}>{items.map((item, index) => <li key={index}>{inline(item, citationMap, onCitationClick)}</li>)}</ul>);
    } else if (line.trim()) {
      const paragraph = [line];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !fence.test(lines[i]) &&
        !listPattern.test(lines[i]) &&
        !headingPattern.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && tableSep.test(lines[i + 1]))
      ) {
        paragraph.push(lines[i++]);
      }
      blocks.push(<p key={start}>{inline(paragraph.join('\n'), citationMap, onCitationClick)}</p>);
    }
  }
  return <div className="markdown">{blocks}</div>;
}

export function SpillCard({ handle }: { handle: SpillHandle }) {
  const { L } = useI18n();
  return <details className="spill">
    <summary title={handle.filePath}><FileDown size={15} /><strong>{fileName(handle.filePath)}</strong><Pill tone="blue">{L('已存数据集', 'Saved dataset')}</Pill></summary>
    <div className="pills"><Pill>{bytes(handle.byteSize)}</Pill><Pill>{handle.lineCount.toLocaleString()} {L('行', 'rows')}</Pill><Pill title={handle.sha256}>ID {digest(handle.sha256)}</Pill></div>
    <p className="muted">{handle.schemaSummary}</p>
    {handle.previewLines.length > 0 && <CodeBlock text={handle.previewLines.join('\n')} />}
  </details>;
}

export function useArtifactText(sessionId: string, artifactId: string) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    api.artifactText(sessionId, artifactId, controller.signal)
      .then(text => { if (!controller.signal.aborted) setState({ text }); })
      .catch(error => { if (!controller.signal.aborted) setState({ error: errorText(error) }); });
    return () => controller.abort();
  }, [sessionId, artifactId]);
  return state;
}
