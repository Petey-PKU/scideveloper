import { useMemo, useState } from 'react';
import { GitBranch, ShieldCheck } from 'lucide-react';
import type { ReviewReport, SessionNode } from '@scideveloper/shared';
import { useI18n } from '../i18n';
import { Modal, Pill, roleLabel, time } from './ui';

interface LayoutNode {
  node: SessionNode;
  x: number;
  y: number;
  depth: number;
  lane: number;
  parentPos?: { x: number; y: number };
}

export default function SessionDagModal({
  nodes,
  reviews,
  activeNodeId,
  onClose,
  onSelectNode,
  onForkFrom,
}: {
  nodes: SessionNode[];
  reviews: ReviewReport[];
  activeNodeId?: string | null;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onForkFrom: (nodeId: string) => void;
}) {
  const { locale, L } = useI18n();
  const visibleNodes = useMemo(
    () => nodes.filter((n) => n.role !== 'tool' && n.role !== 'system'),
    [nodes],
  );
  const [focusedId, setFocusedId] = useState<string | undefined>(activeNodeId ?? visibleNodes.at(-1)?.id);

  const reviewByNode = useMemo(() => {
    const map = new Map<string, ReviewReport>();
    for (const r of reviews) map.set(r.nodeId, r);
    return map;
  }, [reviews]);

  const layout = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    const parentOf = new Map<string, string | null>();
    const childrenOf = new Map<string, string[]>();
    for (const n of visibleNodes) {
      let p = n.parentId;
      while (p && !visibleIds.has(p)) {
        p = byId.get(p)?.parentId ?? null;
      }
      parentOf.set(n.id, p ?? null);
      if (p) {
        const arr = childrenOf.get(p) ?? [];
        arr.push(n.id);
        childrenOf.set(p, arr);
      }
    }

    const roots = visibleNodes.filter((n) => !parentOf.get(n.id));
    const placed: LayoutNode[] = [];
    const posMap = new Map<string, { x: number; y: number }>();
    let nextLane = 0;

    function visit(nodeId: string, depth: number, lane: number) {
      const node = byId.get(nodeId);
      if (!node || posMap.has(nodeId)) return;
      const x = 44 + depth * 170;
      const y = 44 + lane * 82;
      const pId = parentOf.get(nodeId);
      posMap.set(nodeId, { x, y });
      placed.push({ node, x, y, depth, lane, parentPos: pId ? posMap.get(pId) : undefined });

      const kids = childrenOf.get(nodeId) ?? [];
      kids.forEach((childId, idx) => {
        const childLane = idx === 0 ? lane : ++nextLane;
        visit(childId, depth + 1, childLane);
      });
    }

    roots.forEach((root, idx) => {
      const lane = idx === 0 ? 0 : ++nextLane;
      visit(root.id, 0, lane);
    });

    const width = Math.max(560, ...placed.map((p) => p.x + 170));
    const height = Math.max(240, ...placed.map((p) => p.y + 72));
    return { placed, width, height };
  }, [nodes, visibleNodes]);

  const focusedNode = visibleNodes.find((n) => n.id === focusedId) ?? visibleNodes.at(-1);
  const focusedReview = focusedNode ? reviewByNode.get(focusedNode.id) : undefined;

  function roleColor(role: SessionNode['role']) {
    if (role === 'user') return '#0f766e';
    if (role === 'reviewer') return '#16a34a';
    if (role === 'specialist') return '#2563eb';
    return '#475569';
  }

  return (
    <Modal
      title={L('对话分支图谱', 'Conversation Branch Graph')}
      subtitle={L('可视化查看对话探索路径，点击任意节点即可定位或分叉', 'Click any node to inspect its details, jump to it, or fork a new branch')}
      size="lg"
      onClose={onClose}
    >
      <div className="stack">
        <div className="dag-canvas-wrap">
          <svg width={layout.width} height={layout.height} role="img" aria-label={L('对话分支图谱', 'Session branch graph')}>
            {layout.placed.map((item) =>
              item.parentPos ? (
                <path
                  key={'edge-' + item.node.id}
                  d={`M ${item.parentPos.x + 128} ${item.parentPos.y + 22} C ${item.parentPos.x + 150} ${item.parentPos.y + 22}, ${item.x - 22} ${item.y + 22}, ${item.x} ${item.y + 22}`}
                  fill="none"
                  stroke="var(--line-strong)"
                  strokeWidth={2}
                />
              ) : null,
            )}
            {layout.placed.map((item) => {
              const selected = item.node.id === focusedNode?.id;
              const review = reviewByNode.get(item.node.id);
              const color = roleColor(item.node.role);
              return (
                <g
                  key={item.node.id}
                  transform={`translate(${item.x}, ${item.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setFocusedId(item.node.id)}
                >
                  <rect
                    width={132}
                    height={46}
                    rx={10}
                    fill={selected ? 'var(--teal-bg)' : 'var(--surface)'}
                    stroke={selected ? 'var(--teal)' : color}
                    strokeWidth={selected ? 2.2 : 1.3}
                  />
                  <circle cx={14} cy={16} r={4.5} fill={color} />
                  <text x={24} y={19} fontSize={11} fontWeight={600} fill="var(--text)">
                    {roleLabel(item.node.role, locale).slice(0, 14)}
                  </text>
                  <text x={12} y={35} fontSize={10} fill="var(--muted)">
                    {item.node.content.replace(/\s+/g, ' ').slice(0, 18) || L('节点', 'Node')}…
                  </text>
                  {review && (
                    <text x={124} y={16} fontSize={10} fontWeight={700} textAnchor="end" fill={review.overallStatus === 'pass' ? '#16a34a' : '#d97706'}>
                      {review.score}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {focusedNode && (
          <div className="soft-card stack">
            <div className="card-head">
              <strong>{focusedNode.agentName}</strong>
              <Pill tone="blue">{roleLabel(focusedNode.role, locale)}</Pill>
              {focusedNode.artifactIds.length > 0 && <Pill tone="teal">{L(`${focusedNode.artifactIds.length} 项结果`, `${focusedNode.artifactIds.length} result(s)`)}</Pill>}
              {focusedReview && <Pill tone={focusedReview.overallStatus === 'pass' ? 'teal' : 'amber'}><ShieldCheck size={12} />{focusedReview.score}/100</Pill>}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{time(focusedNode.createdAt)}</span>
            </div>
            <p className="muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
              {focusedNode.content.slice(0, 600)}
            </p>
            <div className="actions justify-start">
              <button type="button" className="btn btn-primary" onClick={() => { onSelectNode(focusedNode.id); onClose(); }}>
                {L('定位到该步骤', 'Jump to Step')}
              </button>
              <button type="button" className="btn" onClick={() => { onForkFrom(focusedNode.id); onClose(); }}>
                <GitBranch size={14} />{L('从此处分叉新对话', 'Fork New Branch Here')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
