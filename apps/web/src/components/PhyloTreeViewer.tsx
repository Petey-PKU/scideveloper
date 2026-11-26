import { useMemo, useState, type ReactNode } from 'react';
import type { PhyloTreeNode } from '@scideveloper/shared';
import { Pill } from './ui';

export interface PhyloTreeData {
  title?: string;
  method?: string;
  outgroup?: string;
  root: PhyloTreeNode;
}

interface LayoutNode {
  node: PhyloTreeNode;
  x: number;
  y: number;
  children: LayoutNode[];
  isLeaf: boolean;
}

const cladeColors: Record<string, string> = {
  EGFR: '#0f766e',
  ERBB: '#0284c7',
  RTK: '#7c3aed',
  Kinase: '#d97706',
  Outgroup: '#64748b',
};

function layoutTree(root: PhyloTreeNode, useBranchLengths: boolean) {
  let leafIndex = 0;
  let maxDepth = 0;

  function build(node: PhyloTreeNode, depth: number, isRoot: boolean): LayoutNode {
    const step = useBranchLengths ? Math.max(0.05, node.branchLength ?? 0.14) : 1;
    const x = isRoot ? 0 : depth + step;
    maxDepth = Math.max(maxDepth, x);
    if (!node.children?.length) {
      const y = leafIndex++;
      return { node, x, y, children: [], isLeaf: true };
    }
    const children = node.children.map(child => build(child, x, false));
    const y = (children[0].y + children[children.length - 1].y) / 2;
    return { node, x, y, children, isLeaf: false };
  }

  const laid = build(root, 0, true);
  return { root: laid, leaves: Math.max(1, leafIndex), maxDepth: Math.max(0.1, maxDepth) };
}

export default function PhyloTreeViewer({ data }: { data: PhyloTreeData }) {
  const [mode, setMode] = useState<'phylogram' | 'cladogram'>('phylogram');
  const [selected, setSelected] = useState<PhyloTreeNode>();

  const layout = useMemo(() => layoutTree(data.root, mode === 'phylogram'), [data.root, mode]);
  const width = 560;
  const rowHeight = 38;
  const padLeft = 42;
  const padRight = 175;
  const padY = 28;
  const height = Math.max(210, layout.leaves * rowHeight + padY * 2);
  const scaleX = (width - padLeft - padRight) / layout.maxDepth;

  const px = (x: number) => padLeft + x * scaleX;
  const py = (y: number) => padY + y * rowHeight;

  function renderSubtree(item: LayoutNode): ReactNode {
    const x = px(item.x);
    const y = py(item.y);
    const color = (item.node.clade && cladeColors[item.node.clade]) || '#0f766e';

    return <g key={`${item.node.name}-${item.x}-${item.y}`}>
      {item.children.length > 0 && <>
        <line
          x1={x}
          y1={py(item.children[0].y)}
          x2={x}
          y2={py(item.children[item.children.length - 1].y)}
          stroke="var(--line-strong)"
          strokeWidth={1.8}
        />
        {item.children.map(child => (
          <line
            key={`edge-${child.node.name}-${child.y}`}
            x1={x}
            y1={py(child.y)}
            x2={px(child.x)}
            y2={py(child.y)}
            stroke={child.isLeaf && child.node.clade ? cladeColors[child.node.clade] ?? 'var(--teal)' : 'var(--line-strong)'}
            strokeWidth={1.8}
          />
        ))}
        {item.children.map(renderSubtree)}
      </>}

      <circle
        cx={x}
        cy={y}
        r={item.isLeaf ? 4.5 : 3.2}
        fill={item.isLeaf ? color : 'var(--surface)'}
        stroke={color}
        strokeWidth={1.8}
        style={{ cursor: 'pointer' }}
        onClick={() => setSelected(item.node)}
      />

      {!item.isLeaf && item.node.bootstrap !== undefined && (
        <text x={x - 5} y={y - 6} textAnchor="end" fontSize={9.5} fill={item.node.bootstrap >= 90 ? '#0f766e' : '#b45309'} fontFamily="IBM Plex Mono, Consolas, monospace">
          {item.node.bootstrap}%
        </text>
      )}

      {item.isLeaf && (
        <text
          x={x + 10}
          y={y + 4}
          fontSize={12}
          fontWeight={selected === item.node ? 700 : 500}
          fill="var(--text)"
          style={{ cursor: 'pointer' }}
          onClick={() => setSelected(item.node)}
        >
          {item.node.name}
          {item.node.branchLength !== undefined && mode === 'phylogram' ? ` (${item.node.branchLength.toFixed(3)})` : ''}
        </text>
      )}
    </g>;
  }

  return <div className="viewer">
    <div className="viewer-toolbar">
      <div className="pills">
        {data.method && <Pill tone="blue">{data.method}</Pill>}
        {data.outgroup && <Pill>Outgroup: {data.outgroup}</Pill>}
        <Pill>{layout.leaves} taxa</Pill>
      </div>
      <div className="actions">
        <button type="button" className={'btn' + (mode === 'phylogram' ? ' btn-soft-active' : '')} onClick={() => setMode('phylogram')}>Phylogram</button>
        <button type="button" className={'btn' + (mode === 'cladogram' ? ' btn-soft-active' : '')} onClick={() => setMode('cladogram')}>Cladogram</button>
      </div>
    </div>

    <div className="phylo-stage">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={data.title ?? 'Phylogenetic tree'} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {renderSubtree(layout.root)}
        {mode === 'phylogram' && (
          <g transform={`translate(${padLeft}, ${height - 10})`}>
            <line x1={0} y1={0} x2={Math.min(90, scaleX * 0.2)} y2={0} stroke="var(--muted)" strokeWidth={1.6} />
            <text x={Math.min(90, scaleX * 0.2) + 6} y={3} fontSize={10} fill="var(--muted)" fontFamily="IBM Plex Mono, Consolas, monospace">
              0.20 substitutions/site
            </text>
          </g>
        )}
      </svg>
    </div>

    {selected && (
      <div className="soft-card pills">
        <strong>{selected.name || 'Internal node'}</strong>
        {selected.clade && <Pill tone="teal">{selected.clade}</Pill>}
        {selected.branchLength !== undefined && <Pill>Branch {selected.branchLength.toFixed(4)}</Pill>}
        {selected.bootstrap !== undefined && <Pill tone={selected.bootstrap >= 90 ? 'teal' : 'amber'}>Bootstrap {selected.bootstrap}%</Pill>}
      </div>
    )}
  </div>;
}
