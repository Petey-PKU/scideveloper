import { useState, type FormEvent } from 'react';
import {
  ArrowRight, ArrowUp, BarChart3, BookOpen, Brain, FolderKanban, FolderOpen,
  GitFork, LayoutDashboard, MessageSquare, Paperclip, Pencil, Pin, Plus, Scale, Settings,
  Sparkles, Telescope, Trash2,
} from 'lucide-react';
import type {
  CustomSpecialist, ProjectOverview, ResearchProject, SpecialistDomain,
} from '@scideveloper/shared';
import { useI18n } from '../i18n';
import HypothesisBoardPanel from './HypothesisBoardPanel';
import { ArtifactTypeIcon, artifactTypeLabel } from './ResearchStream';
import { Loading, Pill, shortDate } from './ui';

export function projectAccentHex(color?: string): string {
  switch (color) {
    case 'blue': return '#0284c7';
    case 'purple': return '#6d28d9';
    case 'amber': return '#d97706';
    case 'rose': return '#e11d48';
    case 'emerald': return '#059669';
    default: return '#0f766e';
  }
}

export default function ProjectHomeView({
  project,
  overview,
  loading,
  modelConfigured,
  customSpecialists,
  onStartChat,
  onOpenSession,
  onOpenArtifact,
  onEditProject,
  onPinProject,
  onDeleteProject,
  onOpenModels,
  onOpenSidebarTab,
  onRefreshOverview,
}: {
  project: ResearchProject;
  overview?: ProjectOverview;
  loading: boolean;
  modelConfigured: boolean;
  customSpecialists: CustomSpecialist[];
  onStartChat: (
    content: string,
    specialist?: SpecialistDomain,
    customSpecialistId?: string,
    mode?: 'standard' | 'deep_research',
  ) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onOpenArtifact: (sessionId: string, artifactId: string) => void;
  onEditProject: () => void;
  onPinProject: (pinned: boolean) => void;
  onDeleteProject: () => void;
  onOpenModels: () => void;
  onOpenSidebarTab: (tab: 'files' | 'memory' | 'papers') => void;
  onRefreshOverview?: () => void;
}) {
  const { locale, t, L } = useI18n();
  const [hubTab, setHubTab] = useState<'overview' | 'hypotheses'>('overview');
  const [prompt, setPrompt] = useState('');
  const [deepResearch, setDeepResearch] = useState(false);
  const [customSpecChoice, setCustomSpecChoice] = useState('');
  const [sending, setSending] = useState(false);

  const accent = projectAccentHex(project.color);
  const sessions = overview?.sessions ?? [];
  const memories = overview?.memories ?? [];
  const papers = overview?.papers ?? [];
  const hypotheses = overview?.hypotheses ?? [];
  const recentArtifacts = overview?.recentArtifacts ?? [];

  async function submitPrompt(e: FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    if (!modelConfigured) {
      onOpenModels();
      return;
    }
    setSending(true);
    try {
      await onStartChat(text, undefined, customSpecChoice || undefined, deepResearch ? 'deep_research' : 'standard');
      setPrompt('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="research-scroll">
      <div className="project-hub">
        <header className="project-hero" style={{ ['--proj-accent' as string]: accent }}>
          <div className="project-hero-top">
            <div className="project-hero-title-row">
              <span className="project-badge-icon" style={{ background: accent }}>
                <FolderKanban size={20} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="pills" style={{ marginBottom: 4 }}>
                  <Pill tone="teal">{t('researchProject')}</Pill>
                  {project.pinned && <Pill tone="blue"><Pin size={10} />{L('已置顶', 'Pinned')}</Pill>}
                  <Pill>{project.defaultComputeTargetId}</Pill>
                </div>
                <h1>{project.name}</h1>
                {project.description && <p className="muted project-hero-desc">{project.description}</p>}
              </div>
            </div>
            <div className="actions">
              <button type="button" className="btn" onClick={() => onPinProject(!project.pinned)}>
                <Pin size={13} />{project.pinned ? t('unpin') : t('pin')}
              </button>
              <button type="button" className="btn" onClick={onEditProject}>
                <Pencil size={13} />{t('editProject')}
              </button>
              <button type="button" className="icon-btn" onClick={onDeleteProject} title={t('deleteProject')} aria-label={t('deleteProject')}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>

          <div className="project-stats-row">
            <button type="button" className="project-stat-btn" onClick={() => setHubTab('overview')}>
              <MessageSquare size={14} /><strong>{sessions.length}</strong> {L('个对话', sessions.length === 1 ? 'chat' : 'chats')}
            </button>
            <button type="button" className="project-stat-btn" onClick={() => setHubTab('hypotheses')}>
              <Scale size={14} /><strong>{hypotheses.length}</strong> {L('条假设', hypotheses.length === 1 ? 'hypothesis' : 'hypotheses')}
            </button>
            <button type="button" className="project-stat-btn" onClick={() => onOpenSidebarTab('memory')}>
              <Brain size={14} /><strong>{memories.length}</strong> {L('条记忆', memories.length === 1 ? 'note' : 'notes')}
            </button>
            <button type="button" className="project-stat-btn" onClick={() => onOpenSidebarTab('papers')}>
              <BookOpen size={14} /><strong>{papers.length}</strong> {L('篇文献', papers.length === 1 ? 'paper' : 'papers')}
            </button>
            <span className="project-stat"><BarChart3 size={14} /><strong>{recentArtifacts.length}</strong> {L('项结果', recentArtifacts.length === 1 ? 'result' : 'results')}</span>
            {project.workspacePath && (
              <button type="button" className="project-stat-btn" onClick={() => onOpenSidebarTab('files')} title={project.workspacePath}>
                <FolderOpen size={14} /><code className="truncate" style={{ maxWidth: 210 }}>{project.workspacePath}</code>
              </button>
            )}
          </div>
        </header>

        {!modelConfigured && (
          <div className="onboarding-banner" style={{ maxWidth: 'none', margin: 0 }}>
            <div className="onboarding-head">
              <Settings size={17} className="text-teal" />
              <strong>{t('modelNotConfiguredTitle')}</strong>
            </div>
            <p className="muted">{t('modelNotConfiguredDesc')}</p>
            <button type="button" className="btn btn-primary w-fit" onClick={onOpenModels}>
              <Settings size={14} />{t('openModelSettings')}
            </button>
          </div>
        )}

        <form className={'prompt-box project-composer' + (deepResearch ? ' deep-research-active' : '')} onSubmit={(e) => void submitPrompt(e)}>
          <div className="prompt-row">
            <button type="button" className="icon-btn" title={L('打开项目文件', 'Open project files')} onClick={() => onOpenSidebarTab('files')}>
              <Paperclip size={16} />
            </button>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={deepResearch
                ? L(`深度文献调研模式：自动检索多库文献、评估竞争假设并沉淀证据链…`, `Deep Research: Multi-source literature synthesis, evidence grading & competing hypotheses…`)
                : `${t('startChatInProject')} "${project.name}"…`}
              aria-label={L('在项目中发起新对话', 'New conversation in project')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitPrompt(e);
                }
              }}
            />
            <button type="submit" className={'send-btn' + (deepResearch ? ' send-deep' : '')} disabled={sending || !prompt.trim()} aria-label={L('开始对话', 'Start conversation')}>
              {sending ? <Loading label="" /> : <ArrowUp size={18} />}
            </button>
          </div>
          <div className="prompt-footer">
            <div className="actions justify-start" style={{ gap: 6 }}>
              <button
                type="button"
                className={'deep-research-toggle' + (deepResearch ? ' active' : '')}
                aria-pressed={deepResearch}
                onClick={() => setDeepResearch((v) => !v)}
              >
                <Telescope size={13} />
                <span>{L('深度调研 Deep Research', 'Deep Research')}</span>
              </button>
              {customSpecialists.length > 0 && (
                <label className="specialist-picker">
                  <span>{L('专家', 'Specialist')}</span>
                  <select value={customSpecChoice} onChange={(e) => setCustomSpecChoice(e.target.value)}>
                    <option value="">{t('autoRoute')}</option>
                    {customSpecialists.map((sp) => (
                      <option key={sp.id} value={sp.id}>{sp.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <span className="prompt-hint">{t('projectInheritsHint')}</span>
          </div>
        </form>

        {/* Segmented Hub Tabs: Overview vs Hypothesis Board */}
        <nav className="project-subtabs" aria-label={L('项目视图切换', 'Project hub views')}>
          <button
            type="button"
            className={hubTab === 'overview' ? 'selected' : ''}
            onClick={() => setHubTab('overview')}
          >
            <LayoutDashboard size={14} />{L('课题概览与对话', 'Overview & Chats')} ({sessions.length})
          </button>
          <button
            type="button"
            className={hubTab === 'hypotheses' ? 'selected' : ''}
            onClick={() => setHubTab('hypotheses')}
          >
            <Scale size={14} />{L('假设与证据看板', 'Hypothesis Board')} ({hypotheses.length})
          </button>
        </nav>

        {loading && !overview && <Loading label={L('正在加载项目空间…', 'Loading project workspace…')} />}

        {hubTab === 'hypotheses' ? (
          <HypothesisBoardPanel
            projectId={project.id}
            hypotheses={hypotheses}
            onChanged={() => onRefreshOverview?.()}
            onTestHypothesis={(h) => {
              if (!modelConfigured) { onOpenModels(); return; }
              void onStartChat(
                locale === 'zh'
                  ? `请针对假设「${h.title}」开展深度调研与证据检验：\n${h.statement}\n请综合 PubMed、OpenAlex、ClinicalTrials.gov 与项目本地文献，对比支持与反驳证据，标注证据等级并更新假设看板。`
                  : `Conduct a Deep Research synthesis to evaluate hypothesis "${h.title}":\n${h.statement}\nCross-check PubMed, OpenAlex, ClinicalTrials.gov, and local project papers, weigh supporting vs. contradicting evidence with grades, and update the Hypothesis Board.`,
                undefined,
                undefined,
                'deep_research',
              );
            }}
          />
        ) : (
          <div className="project-hub-grid">
            <section className="soft-card stack">
              <div className="card-head">
                <MessageSquare size={15} />
                <strong>{t('projectConversations')} ({sessions.length})</strong>
              </div>
              {sessions.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>{t('noProjectChatsYet')}</p>
              ) : (
                <div className="project-chat-list">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="project-chat-card"
                      onClick={() => onOpenSession(s.id)}
                    >
                      <div className="min-w-0" style={{ flex: 1 }}>
                        <strong className="truncate" style={{ display: 'block' }}>{s.title}</strong>
                        <span className="session-date">
                          {shortDate(s.updatedAt)}
                          {s.pinned && <> · <Pin size={10} /> {L('置顶', 'Pinned')}</>}
                          {s.forkedFromSessionId && <> · <GitFork size={10} /> {L('分支', 'Branch')}</>}
                        </span>
                      </div>
                      <ArrowRight size={14} className="muted" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            <div className="stack">
              <section className="soft-card stack">
                <div className="card-head">
                  <Sparkles size={15} className="text-teal" />
                  <strong>{t('projectInstructions')}</strong>
                  <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onEditProject}>
                    <Pencil size={12} />{L('编辑', 'Edit')}
                  </button>
                </div>
                {project.instructions ? (
                  <p className="project-instructions-body">{project.instructions}</p>
                ) : (
                  <p className="muted" style={{ fontSize: 12.5 }}>{t('noProjectInstructions')}</p>
                )}
                {project.defaultSkills.length > 0 && (
                  <div className="pills">
                    {project.defaultSkills.map((sk) => <Pill key={sk} tone="blue">{sk}</Pill>)}
                  </div>
                )}
              </section>

              <section className="soft-card stack">
                <div className="card-head">
                  <BarChart3 size={15} />
                  <strong>{t('projectRecentResults')} ({recentArtifacts.length})</strong>
                </div>
                {recentArtifacts.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12.5 }}>
                    {L('该项目各次对话生成的图表、3D 结构、数据表与手稿都会自动汇总于此。', 'Figures, charts, 3D structures, tables, and manuscripts produced in this project will appear here.')}
                  </p>
                ) : (
                  <div className="stack" style={{ gap: 6 }}>
                    {recentArtifacts.slice(0, 6).map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        className="result-card"
                        onClick={() => onOpenArtifact(art.sessionId, art.id)}
                      >
                        <span className="result-card-icon"><ArtifactTypeIcon type={art.type} size={15} /></span>
                        <span className="result-card-text">
                          <strong>{art.title}</strong>
                          <span>{artifactTypeLabel(art.type, locale)} · {shortDate(art.createdAt)}</span>
                        </span>
                        <ArrowRight size={13} className="result-card-arrow" />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="soft-card stack">
                <div className="card-head">
                  <Brain size={15} />
                  <strong>{t('projectSharedKnowledge')}</strong>
                  <div className="actions" style={{ marginLeft: 'auto' }}>
                    <button type="button" className="btn" onClick={() => onOpenSidebarTab('memory')}>
                      <Plus size={12} />{t('memory')}
                    </button>
                    <button type="button" className="btn" onClick={() => onOpenSidebarTab('papers')}>
                      <Plus size={12} />{t('papers')}
                    </button>
                  </div>
                </div>
                <div className="pills">
                  <Pill tone="teal">{memories.length} {t('memory')}</Pill>
                  <Pill tone="blue">{papers.length} {t('papers')}</Pill>
                  <Pill tone="reviewer">{hypotheses.length} {L('假设', 'Hypotheses')}</Pill>
                </div>
                {memories.slice(0, 3).map((m) => (
                  <div key={m.id} className="muted" style={{ fontSize: 12 }}>
                    <strong>{m.title}:</strong> {m.content.slice(0, 110)}
                  </div>
                ))}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
