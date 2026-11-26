import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Activity, AlertTriangle, BarChart3, BookOpen, BookOpenCheck, Brain, CheckCircle2, Columns2,
  Command, FileText, FlaskConical, FolderKanban, FolderOpen, GitBranch, Languages, MessageSquare,
  Minimize2, Moon, PanelLeft, PanelRight, Settings, ShieldAlert, ShieldCheck, Sparkles, Sun,
  Wand2, X,
} from 'lucide-react';
import type { ResearchProject, ReviewReport } from '@scideveloper/shared';
import { api } from './api';
import ArtifactViewer from './components/ArtifactViewer';
import CommandPalette from './components/CommandPalette';
import DistillSkillModal from './components/DistillSkillModal';
import ManuscriptPanel from './components/ManuscriptPanel';
import { LiteratureLibraryPanel, ResearchMemoryPanel } from './components/MemoryLiteraturePanels';
import NotebookStudioPanel from './components/NotebookStudioPanel';
import PaperReaderViewer from './components/PaperReaderViewer';
import ProjectHomeView, { projectAccentHex } from './components/ProjectHomeView';
import ProjectModal from './components/ProjectModal';
import ProvenanceInspector from './components/ProvenanceInspector';
import ResearchStream, { PermissionGate } from './components/ResearchStream';
import ReviewerPanel from './components/ReviewerPanel';
import SessionDagModal from './components/SessionDagModal';
import SettingsDialog from './components/SettingsDialog';
import { SessionsPanel } from './components/SidePanels';
import WorkspaceFilesPanel from './components/WorkspaceFilesPanel';
import { ErrorNote, Loading, Modal, Pill } from './components/ui';
import { useI18n } from './i18n';
import { useWorkbench } from './useWorkbench';

type SidebarTab = 'sessions' | 'files' | 'memory' | 'papers';
type StudioTab = 'Results' | 'Methods' | 'Quality' | 'Manuscript' | 'Notebook' | 'Reader';

export default function App() {
  const workbench = useWorkbench();
  const { locale, setLocale, t, L } = useI18n();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const [studio, setStudio] = useState<StudioTab>('Results');
  const [mobile, setMobile] = useState<'sessions' | 'research' | 'results'>('research');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [studioState, setStudioState] = useState<{ sessionId?: string; open: boolean }>({ open: false });
  const [artifactSelection, setArtifactSelection] = useState<{ sessionId?: string; id: string }>();
  const [compareArtifactId, setCompareArtifactId] = useState<string>();
  const [compareMode, setCompareMode] = useState(false);
  const [nodeSelection, setNodeSelection] = useState<{ sessionId?: string; id: string }>();
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [externalDraft, setExternalDraft] = useState<string>();
  const [kernelSeed, setKernelSeed] = useState<{ code: string; language: 'python' | 'r'; artifactId?: string }>();
  const [paperReader, setPaperReader] = useState<{ paperId: string; page: number; query?: string }>();
  const [distillOpen, setDistillOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dagOpen, setDagOpen] = useState(false);
  const [projectModal, setProjectModal] = useState<{ open: boolean; editing?: ResearchProject }>({ open: false });
  const [recordedPython, setRecordedPython] = useState<string>();
  const [dark, setDark] = useState(() => localStorage.getItem('scideveloper.theme') === 'dark');

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('scideveloper.sidebarWidth'));
    return Number.isFinite(saved) && saved >= 220 && saved <= 440 ? saved : 272;
  });
  const [studioWidth, setStudioWidth] = useState(() => {
    const saved = Number(localStorage.getItem('scideveloper.studioWidth'));
    return Number.isFinite(saved) && saved >= 360 && saved <= 860 ? saved : 520;
  });

  const studioRef = useRef<HTMLElement>(null);
  const focusArtifact = useRef(false);
  const { tree, sessionId, health, pending, computeId, activeProject, activeProjectId } = workbench;
  const artifacts = tree?.artifacts ?? [];
  const nodes = tree?.nodes ?? [];
  const reviews = tree?.reviews ?? [];
  const artifact = (artifactSelection?.sessionId === sessionId ? artifacts.find(item => item.id === artifactSelection?.id) : undefined) ?? artifacts[0];
  const compareArtifact = artifacts.find(a => a.id === compareArtifactId && a.id !== artifact?.id) ?? artifacts.find(a => a.id !== artifact?.id);
  const selectedNode = nodeSelection?.sessionId === sessionId ? nodeSelection?.id : undefined;
  const inlinePending = sessionId ? pending.filter(request => request.sessionId === sessionId || request.sessionId === 'global') : pending;
  const online = health?.ok === true;
  const sandboxOnline = online && health?.pythonAvailable !== false;
  const modelConfigured = Boolean(health?.llm?.isConfigured);
  const activeModelShort = health?.llm?.isConfigured ? health.llm.model : undefined;
  const activeModelLabel = health?.llm?.isConfigured ? `${health.llm.provider} · ${health.llm.model}` : undefined;
  const python = health?.pythonVersion ?? (typeof health?.python === 'string' ? health.python : health?.python?.version) ?? recordedPython;
  const environmentArtifactId = artifacts.find(item => item.type === 'figure' || item.type === 'table')?.id;
  const latestReview = reviews.reduce<ReviewReport | undefined>((latest, report) =>
    !latest || report.createdAt >= latest.createdAt ? report : latest, undefined);

  const sessionProject = tree?.session.projectId
    ? workbench.projects.find(p => p.id === tree.session.projectId)
    : activeProject;
  const showProjectHome = Boolean(activeProject && !sessionId);

  const hasStudioContent = artifacts.length > 0 || !!latestReview;
  const showStudio = Boolean(paperReader && studio === 'Reader') || (!!sessionId && (studioState.sessionId === sessionId ? studioState.open : hasStudioContent));
  const tokenUsage = tree?.session.tokenUsage;
  const contextPct = tokenUsage && tokenUsage.contextWindowLimit > 0
    ? Math.min(100, Math.round((tokenUsage.estimatedContextTokens / tokenUsage.contextWindowLimit) * 100))
    : undefined;
  const showContextControls = contextPct !== undefined && (contextPct >= 60 || (nodes.length >= 8 && contextPct >= 40));

  const studioTabs = [
    ...(sessionId ? [
      { id: 'Results' as const, label: t('results'), icon: BarChart3 },
      { id: 'Methods' as const, label: t('methods'), icon: FileText },
      { id: 'Quality' as const, label: t('quality'), icon: ShieldCheck },
      { id: 'Manuscript' as const, label: t('manuscript'), icon: BookOpenCheck },
      { id: 'Notebook' as const, label: L('笔记本', 'Notebook'), icon: BookOpen },
    ] : []),
    ...(paperReader ? [{ id: 'Reader' as const, label: L('原文高亮', 'Paper'), icon: BookOpen }] : []),
  ];

  // Global Ctrl+K / Cmd+K Command Palette shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    setAttachedFiles([]);
    setCompareMode(false);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !environmentArtifactId) return;
    const abort = new AbortController();
    void api.provenance(sessionId, environmentArtifactId, abort.signal).then(manifest => {
      if (!abort.signal.aborted && manifest.environmentSnapshot.pythonVersion) setRecordedPython(manifest.environmentSnapshot.pythonVersion);
    }).catch(() => {});
    return () => abort.abort();
  }, [sessionId, environmentArtifactId]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('scideveloper.theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    if (focusArtifact.current && artifact && showStudio) {
      studioRef.current?.focus();
      focusArtifact.current = false;
    }
  }, [artifact, studio, mobile, showStudio]);

  const startResize = useCallback((which: 'sidebar' | 'studio', e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const initial = which === 'sidebar' ? sidebarWidth : studioWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      if (which === 'sidebar') {
        const next = Math.max(220, Math.min(440, initial + dx));
        setSidebarWidth(next);
        localStorage.setItem('scideveloper.sidebarWidth', String(next));
      } else {
        const next = Math.max(360, Math.min(Math.min(860, window.innerWidth - 460), initial - dx));
        setStudioWidth(next);
        localStorage.setItem('scideveloper.studioWidth', String(next));
      }
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth, studioWidth]);

  function openStudio(tab: StudioTab) {
    setStudio(tab);
    setStudioState({ sessionId, open: true });
    setMobile('results');
  }

  function showArtifact(id: string) {
    focusArtifact.current = true;
    setArtifactSelection({ id, sessionId });
    openStudio('Results');
    if (studioRef.current?.getClientRects().length) {
      studioRef.current.focus();
      focusArtifact.current = false;
    }
  }

  function selectNode(id: string) {
    setNodeSelection({ id, sessionId });
    setMobile('research');
    window.requestAnimationFrame(() => document.getElementById('node-' + id)?.scrollIntoView({ block: 'nearest' }));
  }

  function handleStartNew() {
    workbench.startNewSession(true);
    setArtifactSelection(undefined);
    setNodeSelection(undefined);
    setAttachedFiles([]);
    setCompareMode(false);
    setStudioState({ sessionId: undefined, open: false });
    setSidebarTab('sessions');
    setMobile('research');
  }

  function toggleAttachFile(relativePath: string) {
    setAttachedFiles(prev => prev.includes(relativePath) ? prev.filter(p => p !== relativePath) : [...prev, relativePath]);
  }

  async function handleDropFiles(fileList: FileList) {
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      const created = await workbench.createSession(
        L(`数据集分析：${fileList[0]?.name ?? '上传文件'}`, `Dataset: ${fileList[0]?.name ?? 'Upload'}`),
      );
      targetSessionId = created?.id;
    }
    if (!targetSessionId) return;
    const newlyAttached: string[] = [];
    for (const file of Array.from(fileList)) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const saved = await api.uploadWorkspaceFile(targetSessionId, {
        filename: file.name,
        content: btoa(binary),
        isBase64: true,
      });
      newlyAttached.push(saved.relativePath);
    }
    if (newlyAttached.length) {
      setAttachedFiles(prev => [...new Set([...prev, ...newlyAttached])]);
    }
  }

  function toggleLanguage() {
    const next = locale === 'zh' ? 'en' : 'zh';
    setLocale(next);
    void api.saveSettings({ language: next }).catch(() => {});
  }

  const effectiveMobile = mobile === 'results' && !showStudio ? 'research' : mobile;
  const workbenchClasses = [
    'workbench',
    'mobile-' + effectiveMobile,
    sidebarOpen ? 'with-sidebar' : 'no-sidebar',
    showStudio ? 'with-studio' : 'no-studio',
  ].join(' ');

  return <div className="app-shell">
    <header className="topbar">
      <div className="top-left">
        <button type="button" className="icon-btn desktop-only"
          aria-label={sidebarOpen ? L('收起侧边栏', 'Hide sidebar') : L('展开侧边栏', 'Show sidebar')}
          title={sidebarOpen ? L('收起侧边栏', 'Hide sidebar') : L('展开侧边栏', 'Show sidebar')}
          onClick={() => setSidebarOpen(open => !open)}>
          <PanelLeft size={17} />
        </button>
        <div className="brand">
          <span className="brand-icon"><FlaskConical size={17} strokeWidth={2} /></span>
          <strong>{t('brand')}</strong>
          <Pill tone="teal">v0.5</Pill>
        </div>
        <button type="button" className="btn desktop-only palette-trigger" onClick={() => setPaletteOpen(true)} title={L('打开命令面板 (Ctrl+K)', 'Open Command Palette (Ctrl+K)')}>
          <Command size={13} /><span>{t('commandPaletteHint')}</span>
        </button>
      </div>

      <div className="top-actions">
        {health !== undefined && !sandboxOnline && (
          <Pill tone="amber" title={online ? L('本地 Python 环境不可用', 'Python environment unavailable') : L('本地服务未连接', 'Local server offline')}>
            <AlertTriangle size={12} />{online ? L('Python 不可用', 'Python unavailable') : L('引擎离线', 'Engine offline')}
          </Pill>
        )}

        {health?.ok && (
          <button
            type="button"
            className={'model-pill desktop-only' + (modelConfigured ? '' : ' unconfigured')}
            onClick={() => setSettingsOpen(true)}
            title={activeModelLabel ? L(`当前模型：${activeModelLabel}（点击切换）`, `Current model: ${activeModelLabel} (click to change)`) : t('configureModel')}
          >
            <Sparkles size={13} />
            <span className="truncate" style={{ maxWidth: 190 }}>{activeModelShort ?? t('configureModel')}</span>
          </button>
        )}

        {pending.length > 0 && (
          <button type="button" className="btn btn-amber permission-count" onClick={() => setPermissionsOpen(true)}
            aria-label={L(`${pending.length} 项待确认授权`, `${pending.length} pending approvals`)}>
            <ShieldAlert size={15} /><span>{t('approvalNeeded')}</span><span className="count">{pending.length}</span>
          </button>
        )}

        {sessionId && (
          <button type="button" className={'btn desktop-only' + (showStudio ? ' btn-soft-active' : '')}
            onClick={() => setStudioState({ sessionId, open: !showStudio })}>
            <PanelRight size={15} />
            <span>{showStudio ? t('hideResults') : `${t('showResults')}${artifacts.length ? ` (${artifacts.length})` : ''}`}</span>
          </button>
        )}

        <button type="button" className="icon-btn top-icon"
          aria-label={t('switchLang')}
          title={t('switchLang')}
          onClick={toggleLanguage}>
          <Languages size={17} />
        </button>

        <button type="button" className="icon-btn top-icon"
          aria-label={dark ? L('切换为浅色模式', 'Switch to light mode') : L('切换为深色模式', 'Switch to dark mode')}
          title={dark ? L('浅色模式', 'Light mode') : L('深色模式', 'Dark mode')}
          onClick={() => setDark(value => !value)}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        <button type="button" className="icon-btn top-icon" aria-label={t('settingsAndAdvanced')} title={t('settingsAndAdvanced')}
          onClick={() => setSettingsOpen(true)}>
          <Settings size={17} />
        </button>
      </div>
    </header>

    <nav className="mobile-nav" aria-label={L('界面视图', 'Workspace views')}>
      <button type="button" className={mobile === 'sessions' ? 'selected' : ''} onClick={() => setMobile('sessions')}>
        <PanelLeft size={15} />{L('侧边栏', 'Workspace')}
      </button>
      <button type="button" className={mobile === 'research' ? 'selected' : ''} onClick={() => setMobile('research')}>
        <Activity size={15} />{L('对话', 'Research')}
      </button>
      {sessionId && <button type="button" className={mobile === 'results' ? 'selected' : ''} onClick={() => setMobile('results')}>
        <BarChart3 size={15} />{t('results')}{artifacts.length > 0 ? ` (${artifacts.length})` : ''}
      </button>}
    </nav>

    {workbench.error && <div className="app-error">
      <ErrorNote>{workbench.error}</ErrorNote>
      <button type="button" className="btn" onClick={() => void workbench.reload()}>{L('重试', 'Retry')}</button>
      <button type="button" className="icon-btn" onClick={workbench.clearError} aria-label={L('关闭提示', 'Dismiss error')}><X size={16} /></button>
    </div>}

    <main
      className={workbenchClasses}
      style={{
        ['--sidebar-w' as string]: `${sidebarWidth}px`,
        ['--studio-w' as string]: `${studioWidth}px`,
      }}
    >
      <aside className="side-pane" aria-label={L('工作区侧边栏', 'Workspace sidebar')}>
        <div className="sidebar-tabs sidebar-tabs-4" role="tablist">
          <button type="button" role="tab" aria-selected={sidebarTab === 'sessions'}
            className={sidebarTab === 'sessions' ? 'selected' : ''} onClick={() => setSidebarTab('sessions')}>
            <MessageSquare size={13} />{t('sessions')}
          </button>
          <button type="button" role="tab" aria-selected={sidebarTab === 'files'}
            className={sidebarTab === 'files' ? 'selected' : ''} onClick={() => setSidebarTab('files')}>
            <FolderOpen size={13} />{t('files')}{attachedFiles.length ? ` (${attachedFiles.length})` : ''}
          </button>
          <button type="button" role="tab" aria-selected={sidebarTab === 'memory'}
            className={sidebarTab === 'memory' ? 'selected' : ''} onClick={() => setSidebarTab('memory')}>
            <Brain size={13} />{t('memory')}
          </button>
          <button type="button" role="tab" aria-selected={sidebarTab === 'papers'}
            className={sidebarTab === 'papers' ? 'selected' : ''} onClick={() => setSidebarTab('papers')}>
            <BookOpen size={13} />{t('papers')}
          </button>
        </div>

        <div className="pane-scroll side-content">
          {sidebarTab === 'sessions' ? (
            <SessionsPanel
              projects={workbench.projects}
              activeProjectId={activeProjectId}
              sessions={workbench.sessions}
              sessionId={sessionId}
              busy={workbench.busy}
              onNew={handleStartNew}
              onNewProject={() => setProjectModal({ open: true })}
              onSelectProject={pid => {
                workbench.selectProject(pid);
                setMobile('research');
              }}
              onEditProject={proj => setProjectModal({ open: true, editing: proj })}
              onRename={(id, title) => void workbench.renameSession(id, title)}
              onPin={(id, pinned) => void workbench.pinSession(id, pinned)}
              onMoveToProject={(id, pid) => void workbench.moveSessionToProject(id, pid)}
              onDelete={id => void workbench.deleteSession(id)}
              select={id => {
                const session = workbench.sessions.find(item => item.id === id);
                if (session) { workbench.switchSession(session); setMobile('research'); }
              }}
            />
          ) : sidebarTab === 'files' ? (
            <WorkspaceFilesPanel
              sessionId={sessionId}
              workspacePath={tree?.session.workspacePath ?? activeProject?.workspacePath}
              attachedFiles={attachedFiles}
              onToggleAttach={toggleAttachFile}
              onWorkspaceChanged={workbench.updateWorkspace}
              onAnalyzeFile={relPath => {
                setMobile('research');
                void workbench.send(
                  locale === 'zh'
                    ? `请分析本地数据文件 "${relPath}"：检查数据结构与缺失值、计算核心统计量，并生成交互式图表与可复现分析报告。`
                    : `Analyze the local dataset "${relPath}": profile its schema, missing values, summary statistics, and generate interactive Plotly & publication-grade visualizations with 4-layer provenance.`,
                  undefined,
                  selectedNode,
                  L(`数据分析：${relPath}`, `Dataset analysis: ${relPath}`),
                  [relPath],
                );
              }}
            />
          ) : sidebarTab === 'memory' ? (
            <ResearchMemoryPanel
              workspacePath={tree?.session.workspacePath ?? activeProject?.workspacePath}
              projectId={activeProjectId}
              projectName={activeProject?.name}
              onChanged={() => { if (activeProjectId) void workbench.refreshProjectOverview(activeProjectId); }}
            />
          ) : (
            <LiteratureLibraryPanel
              projectId={activeProjectId}
              projectName={activeProject?.name}
              onChanged={() => { if (activeProjectId) void workbench.refreshProjectOverview(activeProjectId); }}
              onOpenPaperPage={(paperId, page, query) => {
                setPaperReader({ paperId, page, query });
                setStudio('Reader');
                setStudioState({ sessionId, open: true });
                setMobile('results');
              }}
              onCitePassage={promptText => {
                setExternalDraft(promptText);
                setMobile('research');
              }}
            />
          )}
        </div>
        <div className="sidebar-footer">
          <button type="button" className="sidebar-footer-btn" onClick={() => setSettingsOpen(true)}>
            <Settings size={15} /><span>{t('settingsAndAdvanced')}</span>
          </button>
        </div>
      </aside>

      {sidebarOpen && <div className="split-handle desktop-only" role="separator" aria-orientation="vertical"
        onMouseDown={e => startResize('sidebar', e)} title={L('拖动调整侧边栏宽度', 'Drag to resize sidebar')} />}

      <section className="research-pane" aria-label={L('科研对话', 'Research conversation')}>
        {sessionId && <div className="research-head">
          <div className="research-head-title-group">
            {sessionProject && (
              <button
                type="button"
                className="project-breadcrumb-pill"
                style={{ ['--proj-accent' as string]: projectAccentHex(sessionProject.color) }}
                onClick={() => workbench.selectProject(sessionProject.id)}
                title={L(`返回项目主页：${sessionProject.name}`, `Return to project hub: ${sessionProject.name}`)}
              >
                <FolderKanban size={12} />
                <span className="truncate" style={{ maxWidth: 140 }}>{sessionProject.name}</span>
              </button>
            )}
            <h1 className="truncate" title={tree?.session.title}>{tree?.session.title ?? L('科研对话', 'Research session')}</h1>
          </div>
          <div className="research-head-meta">
            {showContextControls && contextPct !== undefined && (
              <>
                <Pill tone={contextPct >= 75 ? 'amber' : 'neutral'}
                  title={L(`上下文占用约 ${tokenUsage!.estimatedContextTokens.toLocaleString()} / ${tokenUsage!.contextWindowLimit.toLocaleString()} tokens`, `Estimated context: ${tokenUsage!.estimatedContextTokens.toLocaleString()} / ${tokenUsage!.contextWindowLimit.toLocaleString()} tokens`)}>
                  {L(`上下文 ${contextPct}%`, `Ctx ${contextPct}%`)}
                </Pill>
                <button type="button" className="btn" disabled={workbench.compacting || workbench.running}
                  onClick={() => void workbench.compactSession()} title={L('摘要较早的对话内容以释放上下文空间', 'Summarize older turns to free context')}>
                  <Minimize2 size={13} />{workbench.compacting ? t('compacting') : t('compactContext')}
                </button>
              </>
            )}
            {nodes.length >= 2 && (
              <>
                <button type="button" className="btn" onClick={() => setDistillOpen(true)} title={L('将本次验证通过的分析提炼为可复用 Skill', 'Distill this verified workflow into a reusable Skill')}>
                  <Wand2 size={13} />{L('提炼 Skill', 'Save as Skill')}
                </button>
                <button type="button" className="icon-btn" onClick={() => setDagOpen(true)} title={t('dagGraph')} aria-label={t('dagGraph')}>
                  <GitBranch size={15} />
                </button>
              </>
            )}
            {workbench.running && <Pill tone="teal"><Loading label={L('分析中…', 'Analyzing…')} /></Pill>}
            {!workbench.running && latestReview && (
              <button type="button"
                className={'verified-chip ' + (latestReview.overallStatus === 'pass' ? 'pass' : 'warn')}
                onClick={() => openStudio('Quality')}
                title={L('查看完整质量审查报告', 'Open quality check report')}>
                {latestReview.overallStatus === 'pass' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                <span>{L(`质检 ${latestReview.score}/100`, `Verified · ${latestReview.score}/100`)}</span>
              </button>
            )}
          </div>
        </div>}

        {showProjectHome && activeProject ? (
          <ProjectHomeView
            project={activeProject}
            overview={workbench.projectOverview}
            loading={workbench.loadingOverview}
            modelConfigured={modelConfigured}
            customSpecialists={workbench.specialists}
            onStartChat={async (content, specialist, customSpecId, mode) => {
              await workbench.send(content, specialist, undefined, undefined, attachedFiles, customSpecId, activeProject.id, mode);
              setAttachedFiles([]);
            }}
            onRefreshOverview={() => void workbench.refreshProjectOverview(activeProject.id)}
            onOpenSession={id => {
              const s = workbench.sessions.find(item => item.id === id);
              if (s) workbench.switchSession(s);
            }}
            onOpenArtifact={(sid, aid) => {
              const s = workbench.sessions.find(item => item.id === sid);
              if (s) {
                workbench.switchSession(s);
                setArtifactSelection({ sessionId: sid, id: aid });
                setStudio('Results');
                setStudioState({ sessionId: sid, open: true });
              }
            }}
            onEditProject={() => setProjectModal({ open: true, editing: activeProject })}
            onPinProject={pinned => void workbench.updateProject(activeProject.id, { pinned })}
            onDeleteProject={() => {
              if (window.confirm(t('confirmDeleteProject'))) {
                void workbench.deleteProject(activeProject.id, false);
              }
            }}
            onOpenModels={() => setSettingsOpen(true)}
            onOpenSidebarTab={tab => { setSidebarOpen(true); setSidebarTab(tab); setMobile('sessions'); }}
          />
        ) : workbench.loadingSession
          ? <div className="research-scroll"><div className="research-column"><Loading label={L('正在加载对话…', 'Loading research session…')} /></div></div>
          : <ResearchStream
              sessionId={sessionId}
              nodes={nodes}
              artifacts={artifacts}
              reviews={reviews}
              demos={workbench.demos}
              running={workbench.running}
              ready={online && health?.pythonAvailable !== false && !workbench.busy && !workbench.reviewing}
              modelConfigured={modelConfigured}
              selectedArtifactId={showStudio ? artifact?.id : undefined}
              activities={workbench.activities}
              subagents={workbench.subagents}
              deepResearchProgress={workbench.deepResearchProgress}
              steeringNote={workbench.steeringNote}
              pending={inlinePending}
              deciding={workbench.deciding}
              parentNode={nodes.find(node => node.id === selectedNode)}
              attachedFiles={attachedFiles}
              customSpecialists={workbench.specialists}
              externalDraft={externalDraft}
              onConsumeExternalDraft={() => setExternalDraft(undefined)}
              onClearParent={() => setNodeSelection(undefined)}
              onDetachFile={toggleAttachFile}
              onDropFiles={handleDropFiles}
              onOpenFiles={() => { setSidebarOpen(true); setSidebarTab('files'); setMobile('sessions'); }}
              onOpenModels={() => setSettingsOpen(true)}
              onEditAndBranch={userNode => {
                setNodeSelection(userNode.parentId ? { sessionId, id: userNode.parentId } : undefined);
              }}
              onCancel={() => void workbench.cancelRun()}
              onSteer={msg => void workbench.steerRun(msg)}
              onSend={async (content, specialist, title, files, customSpecId, mode) => {
                const sent = await workbench.send(content, specialist, selectedNode, title, files, customSpecId, undefined, mode);
                if (sent) {
                  setAttachedFiles([]);
                  if (selectedNode) {
                    setNodeSelection(current => (current?.id === selectedNode && current.sessionId === sessionId ? undefined : current));
                  }
                }
                return sent;
              }}
              onArtifact={showArtifact}
              onOpenReview={() => openStudio('Quality')}
              onDecide={(id, approve) => void workbench.decide(id, approve)}
            />}
      </section>

      {showStudio && <div className="split-handle desktop-only" role="separator" aria-orientation="vertical"
        onMouseDown={e => startResize('studio', e)} title={L('拖动调整结果栏宽度', 'Drag to resize results panel')} />}

      {showStudio && <aside className="studio-pane" aria-label={L('结果面板', 'Results panel')} ref={studioRef} tabIndex={-1}>
        <div className="studio-head">
          <nav className="pane-tabs studio-tabs" aria-label={L('结果分类', 'Result sections')}>
            {studioTabs.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={studio === id ? 'selected' : ''} aria-pressed={studio === id}
                onClick={() => setStudio(id)}>
                <Icon size={14} />{label}
              </button>
            ))}
          </nav>
          <button type="button" className="icon-btn studio-close desktop-only" aria-label={L('收起结果栏', 'Close results panel')}
            title={L('收起结果栏', 'Close panel')} onClick={() => {
              if (studio === 'Reader') setPaperReader(undefined);
              setStudioState({ sessionId, open: false });
            }}>
            <X size={16} />
          </button>
        </div>

        <div className="pane-scroll studio-content">
          {(studio === 'Results' || studio === 'Methods') && sessionId && artifact ? <>
            {artifacts.length > 1 && <div className="studio-selector-row">
              <nav className="pill-strip" aria-label={L('生成结果列表', 'Generated results')}>
                {artifacts.map(item => (
                  <button key={item.id} type="button" title={item.title} aria-pressed={item.id === artifact.id}
                    className={'tab-pill' + (item.id === artifact.id ? ' selected' : '')}
                    onClick={() => setArtifactSelection({ id: item.id, sessionId })}>
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
              </nav>
              {studio === 'Results' && (
                <button type="button" className={'btn' + (compareMode ? ' btn-soft-active' : '')}
                  onClick={() => setCompareMode(v => !v)}>
                  <Columns2 size={13} />{compareMode ? t('exitCompare') : t('compareMode')}
                </button>
              )}
            </div>}
            {studio === 'Results'
              ? compareMode && compareArtifact ? (
                  <div className="compare-grid">
                    <div className="compare-slot">
                      <ArtifactViewer key={'cmpA:' + artifact.id} sessionId={sessionId} artifact={artifact} compact />
                    </div>
                    <div className="compare-slot">
                      <select
                        value={compareArtifact.id}
                        onChange={e => setCompareArtifactId(e.target.value)}
                        aria-label={L('选择对比结果', 'Second artifact to compare')}
                        className="compare-picker"
                      >
                        {artifacts.filter(a => a.id !== artifact.id).map(a => (
                          <option key={a.id} value={a.id}>{a.title}</option>
                        ))}
                      </select>
                      <ArtifactViewer key={'cmpB:' + compareArtifact.id} sessionId={sessionId} artifact={compareArtifact} compact />
                    </div>
                  </div>
                ) : (
                  <ArtifactViewer
                    key={sessionId + ':' + artifact.id}
                    sessionId={sessionId}
                    artifact={artifact}
                    onRefined={newId => {
                      void workbench.refreshSession().then(() => setArtifactSelection({ id: newId, sessionId }));
                    }}
                  />
                )
              : <ProvenanceInspector key={sessionId + ':' + artifact.id} sessionId={sessionId} artifact={artifact}
                  forkBusy={workbench.busy}
                  onFork={id => void workbench.fork(id)}
                  onEditInKernel={(code, lang, artId) => {
                    setKernelSeed({ code, language: lang, artifactId: artId });
                    setStudio('Notebook');
                  }}
                  onReplayed={newId => {
                    void workbench.refreshSession().then(() => { if (newId) setArtifactSelection({ id: newId, sessionId }); });
                  }} />}
          </> : studio === 'Quality' ? (
            <ReviewerPanel
              report={latestReview}
              busy={workbench.reviewing}
              fixing={workbench.fixing}
              canReview={!!sessionId && !workbench.running && nodes.length > 0}
              onReview={() => void workbench.review(selectedNode ?? (artifactSelection?.sessionId === sessionId ? artifact?.nodeId : latestReview?.nodeId))}
              onAutoFix={revId => void workbench.autoFix(revId)}
            />
          ) : studio === 'Manuscript' ? (
            <ManuscriptPanel
              sessionId={sessionId}
              hasContent={nodes.length > 0}
              onCompiled={() => workbench.refreshSession()}
            />
          ) : studio === 'Notebook' && sessionId ? (
            <NotebookStudioPanel
              sessionId={sessionId}
              initialCode={kernelSeed?.code}
              initialLanguage={kernelSeed?.language}
              sourceArtifactId={kernelSeed?.artifactId}
              artifacts={artifacts}
              onOpenArtifact={aid => { setArtifactSelection({ id: aid, sessionId }); setStudio('Results'); }}
              onExecuted={newArts => {
                void workbench.refreshSession().then(() => {
                  if (newArts[0]) setArtifactSelection({ id: newArts[0].id, sessionId });
                });
              }}
            />
          ) : studio === 'Reader' && paperReader ? (
            <PaperReaderViewer
              paperId={paperReader.paperId}
              initialPage={paperReader.page}
              initialQuery={paperReader.query}
              onAskPassage={promptText => {
                setExternalDraft(promptText);
                setMobile('research');
              }}
              onClose={() => {
                setPaperReader(undefined);
                if (sessionId) setStudio('Results');
                else setStudioState({ sessionId: undefined, open: false });
              }}
            />
          ) : (
            <div className="studio-empty">
              <div className="empty-icon"><BarChart3 size={22} strokeWidth={1.6} /></div>
              <h3>{L('暂无结果产物', 'No results yet')}</h3>
              <p>{L('分析过程中生成的图表、3D 结构、数据表、基因组轨道和论文手稿都会自动展示在这里。', 'Interactive charts, 3D structures, sortable tables, genome tracks, and manuscripts appear here automatically.')}</p>
            </div>
          )}
        </div>
      </aside>}
    </main>

    {projectModal.open && (
      <ProjectModal
        existing={projectModal.editing}
        targets={workbench.targets}
        catalog={workbench.catalog}
        defaultWorkspace={tree?.session.workspacePath ?? activeProject?.workspacePath}
        onClose={() => setProjectModal({ open: false })}
        onSubmit={async (values) => {
          if (projectModal.editing) {
            await workbench.updateProject(projectModal.editing.id, values);
          } else {
            await workbench.createProject(values);
          }
        }}
      />
    )}

    {distillOpen && sessionId && (
      <DistillSkillModal
        sessionId={sessionId}
        activeProjectId={sessionProject?.id}
        activeProjectName={sessionProject?.name}
        onSaved={() => {
          void workbench.refreshSkills();
          void workbench.refreshProjects();
          if (sessionProject?.id) void workbench.refreshProjectOverview(sessionProject.id);
        }}
        onClose={() => setDistillOpen(false)}
      />
    )}

    {dagOpen && sessionId && (
      <SessionDagModal
        nodes={nodes}
        reviews={reviews}
        activeNodeId={selectedNode ?? tree?.session.activeNodeId}
        onClose={() => setDagOpen(false)}
        onSelectNode={selectNode}
        onForkFrom={id => void workbench.fork(id)}
      />
    )}

    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      projects={workbench.projects}
      sessions={workbench.sessions}
      skills={workbench.catalog}
      connectors={workbench.connectors}
      onSelectProject={id => workbench.selectProject(id)}
      onNewProject={() => setProjectModal({ open: true })}
      onSelectSession={id => {
        const s = workbench.sessions.find(item => item.id === id);
        if (s) workbench.switchSession(s);
      }}
      onNewSession={handleStartNew}
      onOpenSettings={() => setSettingsOpen(true)}
      onCompact={sessionId && nodes.length >= 2 ? () => void workbench.compactSession() : undefined}
      onToggleTheme={() => setDark(v => !v)}
      onToggleLanguage={toggleLanguage}
      onOpenDag={sessionId && nodes.length > 0 ? () => setDagOpen(true) : undefined}
      onInsertPrompt={text => setExternalDraft(text)}
    />

    {settingsOpen && <SettingsDialog
      health={health}
      pythonVersion={python}
      targets={workbench.targets}
      computeId={computeId}
      onChangeCompute={workbench.changeCompute}
      jobs={workbench.jobs}
      sessionId={sessionId}
      nodes={nodes}
      selectedNodeId={selectedNode ?? tree?.session.activeNodeId}
      loadedSkills={tree?.loadedSkills ?? []}
      catalog={workbench.catalog}
      specialists={workbench.specialists}
      connectors={workbench.connectors}
      busy={workbench.busy}
      onLoadSkill={workbench.loadSkill}
      onRefreshConnectors={workbench.refreshConnectors}
      onRefreshSpecialists={workbench.refreshSpecialists}
      onRefreshTargets={workbench.refreshTargets}
      onUpdateJob={workbench.updateJob}
      onRefreshPending={workbench.refreshPending}
      onFork={id => void workbench.fork(id).then(result => { if (result) setMobile('research'); })}
      onSelectNode={selectNode}
      onClose={() => setSettingsOpen(false)}
      onSave={() => void workbench.refreshHealth()}
    />}

    {permissionsOpen && <Modal title={L('待确认授权', 'Pending approvals')} onClose={() => setPermissionsOpen(false)}>
      <div className="stack">
        {pending.length
          ? pending.map(request => (
              <PermissionGate key={request.id} request={request} busy={workbench.deciding.includes(request.id)}
                decide={(id, approve) => void workbench.decide(id, approve)} />
            ))
          : <p className="muted">{L('当前没有待确认的请求。', 'No approvals waiting.')}</p>}
      </div>
    </Modal>}
  </div>;
}
