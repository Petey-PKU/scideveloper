import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Cable, Compass, FlaskConical, FolderKanban, Globe, Minimize2, Moon, Plus, Search, Settings, Sparkles, X,
} from 'lucide-react';
import type { ConnectorInfo, ResearchProject, Session, SkillMetadata } from '@scideveloper/shared';
import { useI18n } from '../i18n';

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: 'project' | 'session' | 'skill' | 'connector' | 'action';
  run: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  projects,
  sessions,
  skills,
  connectors,
  onSelectProject,
  onNewProject,
  onSelectSession,
  onNewSession,
  onOpenSettings,
  onCompact,
  onToggleTheme,
  onToggleLanguage,
  onOpenDag,
  onInsertPrompt,
}: {
  open: boolean;
  onClose: () => void;
  projects: ResearchProject[];
  sessions: Session[];
  skills: SkillMetadata[];
  connectors: ConnectorInfo[];
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onOpenSettings: (section?: string) => void;
  onCompact?: () => void;
  onToggleTheme: () => void;
  onToggleLanguage: () => void;
  onOpenDag?: () => void;
  onInsertPrompt: (text: string) => void;
}) {
  const { locale, t, L } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { id: 'act:newproj', group: t('quickActions'), label: t('newProject'), hint: L('按课题创建独立工作空间', 'Create a research project workspace'), icon: 'project', run: onNewProject },
      { id: 'act:new', group: t('quickActions'), label: t('newResearch'), hint: L('开启一段新对话', 'Start a fresh conversation'), icon: 'action', run: onNewSession },
      { id: 'act:models', group: t('quickActions'), label: t('openModelSettings'), hint: 'Anthropic, OpenAI, Gemini, DeepSeek, Ollama…', icon: 'action', run: () => onOpenSettings('general') },
      { id: 'act:theme', group: t('quickActions'), label: t('toggleTheme'), icon: 'action', run: onToggleTheme },
      { id: 'act:lang', group: t('quickActions'), label: t('switchLang'), icon: 'action', run: onToggleLanguage },
    ];
    if (onCompact) {
      list.push({ id: 'act:compact', group: t('quickActions'), label: t('compactContext'), hint: L('压缩较早对话以释放上下文', 'Summarize older turns to free context window'), icon: 'action', run: onCompact });
    }
    if (onOpenDag) {
      list.push({ id: 'act:dag', group: t('quickActions'), label: t('dagGraph'), hint: L('查看对话步骤与分支', 'Inspect conversation tree & branches'), icon: 'action', run: onOpenDag });
    }
    for (const proj of projects) {
      list.push({
        id: 'proj:' + proj.id,
        group: t('projects'),
        label: proj.name,
        hint: `${proj.sessionCount ?? 0} ${t('projectChatsUnit')}`,
        icon: 'project',
        run: () => onSelectProject(proj.id),
      });
    }
    for (const s of sessions.slice(0, 15)) {
      list.push({
        id: 'sess:' + s.id,
        group: t('sessions'),
        label: s.title,
        hint: s.pinned ? L('已置顶', 'Pinned') : new Date(s.updatedAt).toLocaleDateString(),
        icon: 'session',
        run: () => onSelectSession(s.id),
      });
    }
    for (const sk of skills) {
      list.push({
        id: 'skill:' + sk.name,
        group: L('科研协议', 'Research Protocols'),
        label: sk.title,
        hint: sk.domain,
        icon: 'skill',
        run: () => onInsertPrompt(locale === 'zh' ? `请使用「${sk.name}」科研协议分析：` : `Load the "${sk.name}" protocol and apply it to: `),
      });
    }
    for (const c of connectors) {
      list.push({
        id: 'conn:' + c.id,
        group: L('科学数据库', 'Scientific Databases'),
        label: c.name,
        hint: c.category,
        icon: 'connector',
        run: () => onInsertPrompt(locale === 'zh' ? `请检索 ${c.name}（${c.id}）：` : `Query ${c.name} (${c.id}) for: `),
      });
    }
    return list;
  }, [projects, sessions, skills, connectors, onSelectProject, onNewProject, onSelectSession, onNewSession, onOpenSettings, onCompact, onToggleTheme, onToggleLanguage, onOpenDag, onInsertPrompt, locale, t, L]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 18);
    return commands
      .filter((cmd) => cmd.label.toLowerCase().includes(q) || (cmd.hint?.toLowerCase().includes(q) ?? false) || cmd.group.toLowerCase().includes(q))
      .slice(0, 24);
  }, [commands, query]);

  if (!open) return null;

  function renderIcon(kind: PaletteCommand['icon'], id: string) {
    if (id === 'act:new') return <Plus size={15} />;
    if (id === 'act:models') return <Settings size={15} />;
    if (id === 'act:theme') return <Moon size={15} />;
    if (id === 'act:lang') return <Globe size={15} />;
    if (id === 'act:compact') return <Minimize2 size={15} />;
    if (kind === 'project') return <FolderKanban size={15} />;
    if (kind === 'session') return <FlaskConical size={15} />;
    if (kind === 'skill') return <BookOpen size={15} />;
    if (kind === 'connector') return <Cable size={15} />;
    return <Sparkles size={15} />;
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={t('quickActions')}>
        <div className="palette-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={L('搜索命令、项目、对话、协议或数据库…', 'Type a command, project, chat, protocol, or database…')}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(filtered.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter' && filtered[activeIndex]) {
                e.preventDefault();
                filtered[activeIndex].run();
                onClose();
              }
            }}
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label={L('关闭', 'Close')}><X size={15} /></button>
        </div>

        <div className="palette-list">
          {filtered.length === 0 && <p className="muted" style={{ padding: '16px 14px' }}>{L('未找到匹配项。', 'No matching commands.')}</p>}
          {filtered.map((cmd, idx) => (
            <button
              key={cmd.id}
              type="button"
              className={'palette-item' + (idx === activeIndex ? ' active' : '')}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => { cmd.run(); onClose(); }}
            >
              <span className="palette-icon">{renderIcon(cmd.icon, cmd.id)}</span>
              <span className="palette-main">
                <strong>{cmd.label}</strong>
                {cmd.hint && <span className="muted">{cmd.hint}</span>}
              </span>
              <span className="palette-group">{cmd.group}</span>
            </button>
          ))}
        </div>

        <div className="palette-footer">
          <span><Compass size={12} /> {L('↑↓ 选择 · Enter 执行 · Esc 关闭', '↑↓ navigate · Enter execute · Esc close')}</span>
        </div>
      </div>
    </div>
  );
}
