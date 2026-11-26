import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Maximize2, Search, Sparkles, ZoomIn, ZoomOut } from 'lucide-react';
import type { ScientificArtifact } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import GenomeTrackViewer, { type GenomeData } from './GenomeTrackViewer';
import InteractiveChartViewer, { type PlotlyChartPayload } from './InteractiveChartViewer';
import MoleculeViewer, { type MoleculeData } from './MoleculeViewer';
import PhyloTreeViewer, { type PhyloTreeData } from './PhyloTreeViewer';
import Protein3DViewer from './Protein3DViewer';
import { CodeBlock, ErrorNote, Loading, Markdown, Modal, Pill, fileName, useArtifactText } from './ui';

function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"' && value === '') quoted = true;
    else if (c === delimiter) { row.push(value); value = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += c;
  }
  if (value || row.length || (input.length > 0 && !/[\r\n]$/.test(input))) rows.push([...row, value]);
  return rows;
}

function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function DataTable({ text, delimiter, title }: { text: string; delimiter: string; title?: string }) {
  const { t, L } = useI18n();
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [query, setQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = Array.from({ length: width }, (_, index) => rows[0]?.[index] || L(`第 ${index + 1} 列`, `Column ${index + 1}`));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.slice(1).filter(row => !q || row.some(cell => cell.toLowerCase().includes(q)));
    if (sortCol === null) return filtered;
    const col = sortCol;
    const factor = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = (a[col] ?? '').trim();
      const bv = (b[col] ?? '').trim();
      const an = Number(av);
      const bn = Number(bv);
      if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) {
        return (an - bn) * factor;
      }
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
  }, [rows, query, sortCol, sortDir]);

  const size = 50;
  const pages = Math.max(1, Math.ceil(visible.length / size));
  const currentPage = Math.min(page, pages - 1);

  function toggleSort(col: number) {
    setPage(0);
    if (sortCol !== col) { setSortCol(col); setSortDir('asc'); }
    else if (sortDir === 'asc') setSortDir('desc');
    else setSortCol(null);
  }

  function exportFiltered() {
    const csv = [header, ...visible].map(r => r.map(csvEscape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (title || 'filtered_table').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="viewer">
    <div className="viewer-toolbar">
      <label className="table-search" style={{ flex: 1 }}>
        <Search size={15} />
        <input
          type="search"
          placeholder={L('筛选表格行…', 'Filter table rows…')}
          value={query}
          onChange={event => { setQuery(event.target.value); setPage(0); }}
          aria-label={L('筛选表格行', 'Filter table rows')}
        />
      </label>
      <button type="button" className="btn" onClick={exportFiltered}>
        <Download size={13} />{t('exportFilteredCsv')}
      </button>
    </div>
    <div className="data-scroll">
      <table>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i} scope="col">
                <button type="button" className="th-sort-btn" onClick={() => toggleSort(i)}>
                  <span>{cell}</span>
                  {sortCol === i
                    ? sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                    : <ArrowUpDown size={11} style={{ opacity: 0.45 }} />}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.slice(currentPage * size, (currentPage + 1) * size).map((row, i) => (
            <tr key={i}>{header.map((_, j) => <td key={j}>{row[j] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="viewer-toolbar">
      <span className="muted">
        {L(
          `显示 ${visible.length.toLocaleString()} / 共 ${Math.max(0, rows.length - 1).toLocaleString()} 行`,
          `${visible.length.toLocaleString()} of ${Math.max(0, rows.length - 1).toLocaleString()} rows`,
        )}
        {sortCol !== null ? L(` · 按 ${header[sortCol]} ${sortDir === 'asc' ? '升序' : '降序'}`, ` · Sorted by ${header[sortCol]} (${sortDir})`) : ''}
      </span>
      {pages > 1 && (
        <div className="actions">
          <button className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{L('上一页', 'Previous')}</button>
          <span className="muted">{currentPage + 1} / {pages}</span>
          <button className="btn" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{L('下一页', 'Next')}</button>
        </div>
      )}
    </div>
  </div>;
}

function StructuredArtifact({ text, artifact }: { text: string; artifact: ScientificArtifact }) {
  const { L } = useI18n();
  try {
    const data = JSON.parse(text) as Partial<GenomeData & MoleculeData & PhyloTreeData & PlotlyChartPayload> | null;
    if (artifact.type === 'interactive_chart' && data && Array.isArray(data.data)) {
      return <InteractiveChartViewer payload={data as PlotlyChartPayload} />;
    }
    if (artifact.type === 'genome_track' && data && typeof data.start === 'number' && typeof data.end === 'number' &&
      Array.isArray(data.transcripts) && Array.isArray(data.tracks)) return <GenomeTrackViewer data={data as GenomeData} />;
    if (artifact.type === 'molecule_2d' && Array.isArray(data?.compounds)) return <MoleculeViewer data={data as MoleculeData} />;
    if (artifact.type === 'phylo_tree' && data?.root) return <PhyloTreeViewer data={data as PhyloTreeData} />;
  } catch {
    return <ErrorNote>{L('该结果数据格式无效。', 'This result contains invalid data.')}</ErrorNote>;
  }
  return <ErrorNote>{L('暂不支持渲染该结果格式。', 'This result has an unrecognized format.')}</ErrorNote>;
}

function TextArtifact({ artifact, sessionId }: { artifact: ScientificArtifact; sessionId: string }) {
  const { L } = useI18n();
  const { text, error } = useArtifactText(sessionId, artifact.id);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (text === undefined) return <Loading label={L('正在加载结果…', 'Loading result…')} />;
  if (
    artifact.type === 'interactive_chart' ||
    artifact.type === 'genome_track' ||
    artifact.type === 'molecule_2d' ||
    artifact.type === 'phylo_tree'
  ) {
    return <StructuredArtifact text={text} artifact={artifact} />;
  }
  const mime = artifact.mimeType.toLowerCase();
  if (/\.tsv$/i.test(artifact.filePath) || mime.includes('tab-separated')) return <DataTable text={text} delimiter={'\t'} title={artifact.title} />;
  if (/\.csv$/i.test(artifact.filePath) || mime.includes('csv')) return <DataTable text={text} delimiter="," title={artifact.title} />;
  if (artifact.type === 'manuscript' || mime.includes('markdown') || /\.md$/i.test(artifact.filePath)) return <Markdown text={text} />;
  const extension = artifact.filePath.split('.').at(-1)?.toLowerCase();
  const language = extension === 'py' ? 'python' : extension === 'r' ? 'r' :
    artifact.type === 'code_report' || /\.(sh|slurm|sbatch)$/i.test(artifact.filePath) ? 'slurm' : undefined;
  return <CodeBlock text={text} language={language} />;
}

export function TextDownload({ name, content }: { name: string; content: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const link = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    setUrl(link);
    return () => URL.revokeObjectURL(link);
  }, [content]);
  return <a className="btn" href={url || undefined} download={name}><Download size={14} />{name}</a>;
}

export default function ArtifactViewer({
  artifact,
  sessionId,
  onRefined,
  compact = false,
}: {
  artifact: ScientificArtifact;
  sessionId: string;
  onRefined?: (newArtifactId: string) => void;
  compact?: boolean;
}) {
  const { t, L } = useI18n();
  const [zoom, setZoom] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState('');

  const url = api.artifactUrl(sessionId, artifact.id);
  const mime = artifact.mimeType.toLowerCase();
  const image = mime.startsWith('image/');
  const binary = artifact.type === 'raw_data' && !/^(?:text\/|application\/(?:json|x-sh))/.test(mime)
    && !/\.(csv|tsv|json|md|txt|py|r|sh|slurm|sbatch)$/i.test(artifact.filePath);

  async function submitRefine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instruction = refineText.trim();
    if (!instruction || refining) return;
    setRefining(true);
    setRefineError('');
    try {
      const res = await api.refineArtifact(sessionId, artifact.id, instruction);
      setRefineText('');
      onRefined?.(res.artifact.id);
    } catch (cause) {
      setRefineError(errorText(cause));
    } finally {
      setRefining(false);
    }
  }

  const body = (
    <>
      {artifact.type === 'protein_3d' ? <Protein3DViewer sessionId={sessionId} artifactId={artifact.id} /> :
        image ? imageError ? <ErrorNote>{L('图表加载失败。', 'Could not load the figure.')}</ErrorNote> :
          <>
            <div className={'image-stage' + (zoom ? ' zoomed' : '')}><img src={url} alt={artifact.title} onError={() => setImageError(true)} /></div>
            {!compact && (
              <>
                <form className="refine-bar" onSubmit={e => void submitRefine(e)}>
                  <input
                    value={refineText}
                    onChange={e => setRefineText(e.target.value)}
                    placeholder={L('输入修改要求优化此图… 例如「使用 Nature 配色、放大坐标轴字号」', 'Refine figure… e.g. "Nature palette, larger font, publication title"')}
                    disabled={refining}
                    aria-label={L('优化图表', 'Refine publication figure')}
                  />
                  <button type="submit" className="btn btn-primary" disabled={refining || !refineText.trim()}>
                    {refining ? <Loading label={L('优化中…', 'Refining…')} /> : <><Sparkles size={13} />{L('优化', 'Refine')}</>}
                  </button>
                </form>
                {refineError && <ErrorNote>{refineError}</ErrorNote>}
              </>
            )}
          </>
        : binary ? <p className="muted">{L('请下载此文件后使用相应软件打开。', 'Download this file to open it in a compatible application.')}</p>
        : <TextArtifact sessionId={sessionId} artifact={artifact} />}
    </>
  );

  return <div className="viewer">
    <div className="artifact-header">
      <div className="min-w-0">
        <h3>{artifact.title}</h3>
        {artifact.description && <p className="muted">{artifact.description}</p>}
        {artifact.refinedFromArtifactId && <Pill tone="blue">{L('优化版本', 'Refined version')}</Pill>}
      </div>
      <div className="artifact-actions">
        {!compact && (
          <button type="button" className="icon-btn" title={t('fullscreen')} aria-label={t('fullscreen')} onClick={() => setFullscreen(true)}>
            <Maximize2 size={14} />
          </button>
        )}
        {image && <button type="button" className="icon-btn" aria-pressed={zoom}
          title={zoom ? L('适应窗口', 'Fit figure') : L('放大查看', 'Zoom figure')}
          aria-label={zoom ? L('适应窗口', 'Fit figure') : L('放大查看', 'Zoom figure')}
          onClick={() => setZoom(value => !value)}>
          {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
        </button>}
        <a className="btn" href={url} download={fileName(artifact.filePath)}><Download size={14} />{image ? 'PNG' : L('下载', 'Download')}</a>
        {artifact.vectorExports?.svgPath && (
          <a className="btn" href={api.vectorArtifactUrl(sessionId, artifact.id, 'svg')} download={fileName(artifact.vectorExports.svgPath)} title={L('下载出版级 SVG 矢量图', 'Download publication SVG vector')}>
            <Download size={13} />SVG
          </a>
        )}
        {artifact.vectorExports?.pdfPath && (
          <a className="btn" href={api.vectorArtifactUrl(sessionId, artifact.id, 'pdf')} download={fileName(artifact.vectorExports.pdfPath)} title={L('下载出版级 PDF 矢量图', 'Download publication PDF vector')}>
            <Download size={13} />PDF
          </a>
        )}
      </div>
    </div>

    {body}

    {fullscreen && (
      <Modal title={artifact.title} subtitle={artifact.description} size="full" onClose={() => setFullscreen(false)}>
        {body}
      </Modal>
    )}
  </div>;
}
