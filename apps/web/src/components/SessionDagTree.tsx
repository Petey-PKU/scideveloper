import { GitFork } from 'lucide-react';
import type { SessionNode } from '@scideveloper/shared';
import { useI18n } from '../i18n';
import { Pill, roleLabel } from './ui';

export default function SessionDagTree({ nodes, activeId, disabled, onFork, onSelect }: {
  nodes: SessionNode[]; activeId?: string | null; disabled: boolean;
  onFork: (id: string) => void; onSelect: (id: string) => void;
}) {
  const { locale, L } = useI18n();
  const ids = new Set(nodes.map(node => node.id));
  const children = new Map<string | null, SessionNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const group = children.get(parent) ?? [];
    group.push(node);
    children.set(parent, group);
  }

  function branch(parent: string | null, ancestors: ReadonlySet<string>) {
    const group = children.get(parent)?.filter(node => !ancestors.has(node.id));
    if (!group?.length) return null;
    return <ul className="dag-branch">{group.map(node => <li key={node.id}>
      <div className={'dag-node' + (activeId === node.id ? ' selected' : '')}>
        <button type="button" className="dag-label" onClick={() => onSelect(node.id)} title={node.content || node.agentName}>
          <Pill tone={node.role}>{roleLabel(node.role, locale)}</Pill>
          <span className="truncate">{node.content.trim().split('\n')[0] || node.agentName}</span>
        </button>
        {node.artifactIds.length > 0 && <span className="dag-count" title={L(`${node.artifactIds.length} 项结果`, `${node.artifactIds.length} results`)}>{node.artifactIds.length}</span>}
        <button type="button" className="icon-btn fork-btn" title={L('从此步骤创建分支', 'Branch from this step')} aria-label={L(`从 ${node.agentName} 分叉`, `Branch from ${node.agentName}`)}
          disabled={disabled} onClick={() => onFork(node.id)}><GitFork size={14} /></button>
      </div>
      {branch(node.id, new Set([...ancestors, node.id]))}
    </li>)}</ul>;
  }

  return <section className="dag-panel stack">
    <p className="muted">{L('点击任意步骤可定位回溯，点击右侧分支图标可从该步骤分叉为新对话。', 'Select a step to continue from it, or click the branch icon to fork a new session.')}</p>
    {nodes.length ? branch(null, new Set()) : <p className="muted">{L('当前会话尚无对话记录。', 'Steps appear here once the session has messages.')}</p>}
  </section>;
}
