import { useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react';
import { ErrorNote, Pill } from './ui';

interface Interval { start: number; end: number }
interface Transcript extends Interval { id: string; canonical: boolean; strand: number; exons: Array<Interval & { id: string }> }
interface Signal { id: string; label: string; simulated?: boolean; values: Array<Interval & { value: number }> }
export interface GenomeData extends Interval {
  id: string; symbol: string; assembly: string; chromosome: string | number; strand: number;
  coordinateSystem?: string; transcripts: Transcript[]; tracks: Signal[];
}

const number = new Intl.NumberFormat('en-US');
const left = 18, width = 440, right = left + width;

export default function GenomeTrackViewer({ data }: { data: GenomeData }) {
  const [region, setRegion] = useState<Interval>();
  const [hover, setHover] = useState<number>();
  if (!Number.isFinite(data.start) || !Number.isFinite(data.end) || data.end < data.start) return <ErrorNote>Invalid genomic coordinate range.</ErrorNote>;
  const { start, end } = region ?? data;
  const span = end - start + 1;
  const fullWidth = data.end - data.start + 1;
  const transcript = data.transcripts?.find(item => item.canonical) ?? data.transcripts?.[0];
  const tracks = data.tracks ?? [];
  const height = 100 + tracks.length * 78;
  const px = (position: number) => left + (position - start) / span * width;
  const clamp = (x: number) => Math.min(right, Math.max(left, x));
  const chromosome = String(data.chromosome).replace(/^chr/i, '');
  const ticks = [...new Set(Array.from({ length: 3 }, (_, index) => start + Math.round((span - 1) * index / 2)))];

  function move(size: number, middle: number) {
    const nextWidth = Math.max(Math.min(10, fullWidth), Math.min(fullWidth, Math.round(size)));
    const first = Math.max(data.start, Math.min(data.end - nextWidth + 1, Math.round(middle - (nextWidth - 1) / 2)));
    setHover(undefined);
    setRegion({ start: first, end: first + nextWidth - 1 });
  }

  return <div className="viewer genome">
    <div className="viewer-toolbar">
      <div className="pills"><Pill tone="blue">{data.assembly}</Pill><Pill>{data.symbol}</Pill></div>
      <div className="actions">
        <button className="icon-btn" aria-label="Pan left" disabled={start === data.start} onClick={() => move(span, (start + end) / 2 - span / 2)}><ChevronLeft size={15} /></button>
        <button className="icon-btn" aria-label="Zoom out" disabled={span === fullWidth} onClick={() => move(span * 2, (start + end) / 2)}><Minus size={15} /></button>
        <button className="icon-btn" aria-label="Zoom in" disabled={span <= 10} onClick={() => move(span / 2, hover ?? (start + end) / 2)}><Plus size={15} /></button>
        <button className="icon-btn" aria-label="Pan right" disabled={end === data.end} onClick={() => move(span, (start + end) / 2 + span / 2)}><ChevronRight size={15} /></button>
        <button className="icon-btn" aria-label="Reset genomic range" onClick={() => { setRegion(undefined); setHover(undefined); }}><RotateCcw size={15} /></button>
      </div>
    </div>
    <p className="genome-coords">chr{chromosome}:{number.format(start)}–{number.format(end)} · {number.format(span)} bp</p>
    <svg viewBox={'0 0 476 ' + height} role="img" aria-label={data.symbol + ' transcript and coverage tracks'}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width * 476;
        setHover(x >= left && x <= right ? Math.min(end, start + Math.floor((x - left) / width * span)) : undefined);
      }} onPointerLeave={() => setHover(undefined)}>
      <line x1={left} x2={right} y1="29" y2="29" className="track-rule" />
      {ticks.map((position, index) => <g key={position}>
        <text x={px(position)} y="18" textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>{number.format(position)}</text>
        <line x1={px(position)} x2={px(position)} y1="27" y2={height - 8} className="track-rule" strokeDasharray="3 4" />
      </g>)}
      <text x={left} y="52">{transcript ? (transcript.canonical ? 'Canonical · ' : 'Transcript · ') + transcript.id : 'No transcript annotations'}</text>
      {transcript && transcript.start <= end && transcript.end >= start && <g className="transcript">
        <line x1={clamp(px(transcript.start))} x2={clamp(px(transcript.end + 1))} y1="73" y2="73" />
        {Array.from({ length: 25 }, (_, i) => left + 8 + i * 17).filter(x => x > px(transcript.start) + 5 && x < px(transcript.end + 1) - 5)
          .map(x => {
            const offset = (transcript.strand ?? data.strand) < 0 ? 3 : -3;
            return <path key={x} d={'M' + (x + offset) + ',69 L' + x + ',73 L' + (x + offset) + ',77'} fill="none" />;
          })}
        {transcript.exons.filter(exon => exon.start <= end && exon.end >= start).map(exon =>
          <rect key={exon.id} x={clamp(px(exon.start))} y="66" width={Math.max(1, clamp(px(exon.end + 1)) - clamp(px(exon.start)))} height="14" />)}
      </g>}
      {tracks.map((track, index) => {
        const top = 99 + index * 78;
        const bottom = top + 58;
        const max = track.values.reduce((current, bin) => Math.max(current, bin.value), 1);
        return <g key={track.id}>
          <text x={left} y={top}>{track.label}{track.simulated && !/simulated/i.test(track.label) ? ' (simulated)' : ''}</text>
          <text x={right} y={top} textAnchor="end">max {max}</text>
          <line x1={left} x2={right} y1={bottom} y2={bottom} className="track-rule" />
          {track.values.filter(bin => bin.start <= end && bin.end >= start && bin.value > 0).map(bin => {
            const bar = bin.value / max * 46;
            return <rect key={bin.start} x={clamp(px(bin.start))} y={bottom - bar}
              width={Math.max(0.5, clamp(px(bin.end + 1)) - clamp(px(bin.start)))} height={bar} className={index % 2 ? 'track-rna' : 'track-chip'} />;
          })}
        </g>;
      })}
      {hover !== undefined && <line x1={px(hover + 0.5)} x2={px(hover + 0.5)} y1="29" y2={height - 8} className="track-cursor" />}
    </svg>
    <div className="genome-tooltip">{hover !== undefined ? <>
      <strong>chr{chromosome}:{number.format(hover)}</strong>{tracks.map(track => {
        const interval = track.values.find(bin => bin.start <= hover && bin.end >= hover);
        return interval && <Pill key={track.id}>{track.id} {interval.value}</Pill>;
      })}
    </> : <span className="muted">{data.coordinateSystem ?? 'Genomic coordinates'} · Hover over a track to inspect coverage</span>}</div>
  </div>;
}
