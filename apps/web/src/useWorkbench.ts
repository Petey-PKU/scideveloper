import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComputeTarget, ConnectorInfo, CustomSpecialist, DeepResearchProgress, PermissionRequest,
  ProjectOverview, ResearchProject, Session, SessionTree, SlurmJobRecord, SpecialistDomain,
  SubAgentRunSummary, WorkbenchEvent,
} from '@scideveloper/shared';
import { api, errorText, type Health, type NewProject, type UpdateProject, type WorkflowDemo, type CatalogSkill } from './api';
import type { ToolActivity } from './components/ResearchStream';

function upsert<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some(item => item.id === value.id)
    ? items.map(item => item.id === value.id ? value : item) : [...items, value];
}

function sortByPinnedAndUpdated<T extends { pinned?: boolean; updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinDiff !== 0) return pinDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function sessionEvent(tree: SessionTree, event: WorkbenchEvent): SessionTree {
  switch (event.type) {
    case 'session_updated': return { ...tree, session: event.session };
    case 'node_created': return { ...tree, nodes: upsert(tree.nodes, event.node) };
    case 'node_delta': return {
      ...tree,
      nodes: tree.nodes.map(node => node.id === event.nodeId ? { ...node, content: node.content + event.delta } : node),
    };
    case 'thinking_delta': return {
      ...tree,
      nodes: tree.nodes.map(node => node.id === event.nodeId ? { ...node, thinking: (node.thinking ?? '') + event.delta } : node),
    };
    case 'skill_loaded': return { ...tree, loadedSkills: [...new Set([...tree.loadedSkills, event.skillName])] };
    case 'artifact_created': return {
      ...tree,
      artifacts: upsert(tree.artifacts, event.artifact),
      nodes: tree.nodes.map(node => node.id === event.artifact.nodeId && !node.artifactIds.includes(event.artifact.id)
        ? { ...node, artifactIds: [...node.artifactIds, event.artifact.id] } : node),
    };
    case 'review_completed': return { ...tree, reviews: upsert(tree.reviews, event.report) };
    case 'token_usage_updated': return { ...tree, session: { ...tree.session, tokenUsage: event.tokenUsage } };
    case 'session_compacted': return {
      ...tree,
      session: { ...tree.session, compactionSummary: event.summary, tokenUsage: event.tokenUsage },
    };
    case 'run_completed': return { ...tree, session: { ...tree.session, activeNodeId: event.activeNodeId } };
    default: return tree;
  }
}

type Stream = { id: string; connected: boolean; close: () => void };
const emptyTree = (session: Session): SessionTree => ({ session, nodes: [], artifacts: [], reviews: [], loadedSkills: [] });

export function useWorkbench() {
  const [health, setHealth] = useState<Health>();
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [projectOverview, setProjectOverview] = useState<ProjectOverview>();
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [specialists, setSpecialists] = useState<CustomSpecialist[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [targets, setTargets] = useState<ComputeTarget[]>([]);
  const [demos, setDemos] = useState<WorkflowDemo[]>([]);
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [jobs, setJobs] = useState<SlurmJobRecord[]>([]);
  const [tree, setTree] = useState<SessionTree>();
  const [sessionId, setSessionId] = useState<string>();
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [subagents, setSubagents] = useState<SubAgentRunSummary[]>([]);
  const [deepResearchProgress, setDeepResearchProgress] = useState<DeepResearchProgress>();
  const [steeringNote, setSteeringNote] = useState('');
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [reviewingIds, setReviewingIds] = useState<string[]>([]);
  const [fixingIds, setFixingIds] = useState<string[]>([]);
  const [deciding, setDeciding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [computeOverride, setComputeOverride] = useState<string>();

  const active = useRef<string | undefined>(undefined);
  const activeProjectRef = useRef<string | undefined>(undefined);
  const stream = useRef<Stream | undefined>(undefined);
  const initialLoad = useRef(0);
  const permissionRevision = useRef(0);
  const currentLoad = useRef<AbortController | undefined>(undefined);
  const eventRevision = useRef(0);
  const activityCounter = useRef(0);
  const creating = useRef(false);
  const topologyChanging = useRef(false);
  const runLocks = useRef(new Set<string>());
  const auditLocks = useRef(new Set<string>());
  const decisionLocks = useRef(new Set<string>());
  const readyWaiters = useRef(new Set<(id: string) => void>());

  const reportError = useCallback((cause: unknown) => setError(errorText(cause)), []);
  const refreshHealth = useCallback(async () => {
    try { setHealth(await api.health()); } catch { setHealth(undefined); }
  }, []);
  const refreshPending = useCallback(async () => {
    const revision = ++permissionRevision.current;
    const { pending: values } = await api.pending();
    if (revision === permissionRevision.current) setPending(values.filter(item => item.status === 'pending'));
  }, []);
  const updateJob = useCallback((job: SlurmJobRecord) => {
    setJobs(items => {
      const current = items.find(item => item.id === job.id);
      return current && current.updatedAt > job.updatedAt ? items : upsert(items, job);
    });
  }, []);
  const refreshJobs = useCallback(async () => {
    const values = await api.jobs();
    setJobs(items => values.reduce((result, job) => {
      const current = result.find(item => item.id === job.id);
      return current && current.updatedAt > job.updatedAt ? result : upsert(result, job);
    }, items));
  }, []);
  const refreshProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(sortByPinnedAndUpdated(list));
    } catch { /* ignore */ }
  }, []);
  const refreshProjectOverview = useCallback(async (projId?: string) => {
    const targetId = projId ?? activeProjectRef.current;
    if (!targetId) {
      setProjectOverview(undefined);
      return;
    }
    setLoadingOverview(true);
    try {
      const ov = await api.projectOverview(targetId);
      if (activeProjectRef.current === targetId) setProjectOverview(ov);
    } catch { /* ignore */ }
    finally { setLoadingOverview(false); }
  }, []);
  const refreshConnectors = useCallback(async () => { setConnectors((await api.connectors()).connectors); }, []);
  const refreshSkills = useCallback(async () => {
    try {
      const next = await api.skills();
      setCatalog(items => next.map(skill => ({ ...skill, loaded: skill.loaded || items.some(item => item.name === skill.name && item.loaded) })));
    } catch { /* ignore */ }
  }, []);
  const refreshSpecialists = useCallback(async () => {
    try { setSpecialists(await api.specialists()); } catch { /* ignore */ }
  }, []);
  const refreshTargets = useCallback(async () => {
    try { setTargets(await api.targets()); } catch { /* ignore */ }
  }, []);

  const finishRun = useCallback((id: string) => {
    runLocks.current.delete(id);
    setRunningIds(ids => ids.filter(value => value !== id));
  }, []);
  const finishAudit = useCallback((id: string) => {
    auditLocks.current.delete(id);
    setReviewingIds(ids => ids.filter(value => value !== id));
  }, []);

  const fetchTree = useCallback(async (id: string) => {
    currentLoad.current?.abort();
    const controller = new AbortController();
    currentLoad.current = controller;
    const revision = eventRevision.current;
    try {
      const value = await api.session(id, controller.signal);
      if (controller.signal.aborted || active.current !== id) return;
      setTree(current => {
        if (!current || current.session.id !== id || revision === eventRevision.current) return value;
        return {
          session: current.session.updatedAt > value.session.updatedAt ? current.session : value.session,
          nodes: [...value.nodes.map(node => {
            const live = current.nodes.find(item => item.id === node.id);
            if (!live) return node;
            return {
              ...node,
              content: live.content.length > node.content.length ? live.content : node.content,
              thinking: (live.thinking?.length ?? 0) > (node.thinking?.length ?? 0) ? live.thinking : node.thinking,
              artifactIds: [...new Set([...node.artifactIds, ...live.artifactIds])],
            };
          }), ...current.nodes.filter(node => !value.nodes.some(item => item.id === node.id))],
          artifacts: current.artifacts.reduce(upsert, value.artifacts),
          reviews: current.reviews.reduce(upsert, value.reviews),
          loadedSkills: [...new Set([...value.loadedSkills, ...current.loadedSkills])],
        };
      });
      setLoadingSession(false);
    } catch (cause) {
      if (!controller.signal.aborted && active.current === id) {
        setLoadingSession(false);
        reportError(cause);
      }
    }
  }, [reportError]);

  const clearActiveSession = useCallback(() => {
    stream.current?.close();
    stream.current = undefined;
    currentLoad.current?.abort();
    active.current = undefined;
    setSessionId(undefined);
    setComputeOverride(undefined);
    setTree(undefined);
    setActivities([]);
    setSubagents([]);
    setDeepResearchProgress(undefined);
    setSteeringNote('');
    setConnected(false);
    setLoadingSession(false);
    setError('');
  }, []);

  const startNewSession = useCallback((keepProject = true) => {
    clearActiveSession();
    if (!keepProject) {
      activeProjectRef.current = undefined;
      setActiveProjectId(undefined);
      setProjectOverview(undefined);
    }
  }, [clearActiveSession]);

  const selectProject = useCallback((projectId: string | undefined) => {
    activeProjectRef.current = projectId;
    setActiveProjectId(projectId);
    clearActiveSession();
    if (projectId) {
      setProjectOverview(undefined);
      void refreshProjectOverview(projectId);
    } else {
      setProjectOverview(undefined);
    }
  }, [clearActiveSession, refreshProjectOverview]);

  const switchSession = useCallback((session: Session, seed?: SessionTree) => {
    const { id } = session;
    if (session.projectId && activeProjectRef.current !== session.projectId) {
      activeProjectRef.current = session.projectId;
      setActiveProjectId(session.projectId);
      void refreshProjectOverview(session.projectId);
    }
    if (active.current === id) return;
    stream.current?.close();
    stream.current = undefined;
    currentLoad.current?.abort();
    active.current = id;
    setSessionId(id);
    setComputeOverride(undefined);
    setActivities([]);
    setSubagents([]);
    setDeepResearchProgress(undefined);
    setSteeringNote('');
    setConnected(false);
    setTree(seed ?? emptyTree(session));
    setLoadingSession(!seed);
    setError('');
    void fetchTree(id);
  }, [fetchTree, refreshProjectOverview]);

  useEffect(() => {
    if (!sessionId) return;
    const id = sessionId;
    let alive = true;
    let wasDisconnected = false;
    const current: Stream = { id, connected: false, close: () => {} };
    stream.current = current;

    function onEvent(event: WorkbenchEvent) {
      if (!alive || active.current !== id) return;
      if (event.type === 'slurm_job_updated') { updateJob(event.job); return; }
      if (event.type === 'project_updated') {
        setProjects(items => sortByPinnedAndUpdated(upsert(items, event.project)));
        if (activeProjectRef.current === event.project.id) void refreshProjectOverview(event.project.id);
        return;
      }
      if (event.type === 'project_deleted') {
        setProjects(items => items.filter(p => p.id !== event.projectId));
        if (activeProjectRef.current === event.projectId) {
          activeProjectRef.current = undefined;
          setActiveProjectId(undefined);
          setProjectOverview(undefined);
        }
        return;
      }
      if (event.type === 'memory_updated') {
        if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
        return;
      }
      if (event.type === 'hypothesis_updated' || event.type === 'hypothesis_deleted') {
        void refreshProjects();
        if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
        return;
      }
      if (event.type === 'skill_saved') {
        void refreshSkills();
        return;
      }
      if (event.type === 'deep_research_progress') {
        if (event.progress.sessionId === id) {
          setDeepResearchProgress(event.progress.stage === 'completed' ? undefined : event.progress);
        }
        return;
      }
      if (event.type === 'notebook_updated') {
        return;
      }
      if (event.type === 'permission_requested' || event.type === 'permission_decided') {
        permissionRevision.current++;
        setPending(items => event.type === 'permission_requested' && event.request.status === 'pending'
          ? upsert(items, event.request) : items.filter(item => item.id !== event.request.id));
        return;
      }
      const eventSession = 'sessionId' in event ? event.sessionId : event.type === 'node_created' ? event.node.sessionId : event.session.id;
      if (eventSession !== id) return;
      eventRevision.current++;
      if (event.type === 'session_updated') setSessions(items => sortByPinnedAndUpdated(upsert(items, event.session)));
      if (event.type === 'subagent_started') {
        const started: SubAgentRunSummary = {
          runId: event.runId,
          specialistName: event.specialistName,
          domain: event.domain,
          task: event.task,
          status: 'running',
          summary: 'Running isolated specialist investigation…',
          artifactIds: [],
          durationMs: 0,
        };
        setSubagents(items => [...items.filter(s => s.runId !== event.runId), started]);
      }
      if (event.type === 'subagent_finished') {
        setSubagents(items => [...items.filter(s => s.runId !== event.summary.runId), event.summary]);
      }
      if (event.type === 'steering_applied') {
        setSteeringNote('Steering applied: ' + event.message);
      }
      if (event.type === 'run_error' || event.type === 'run_completed' || event.type === 'run_cancelled') {
        if (event.type === 'run_error') setError(event.error);
        if (event.type === 'run_cancelled') setSteeringNote('Run stopped: ' + event.reason);
        setDeepResearchProgress(undefined);
        setActivities(items => items.map(item => item.running ? { ...item, running: false } : item));
        void fetchTree(id);
        if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
      }
      if (event.type === 'tool_output_delta') {
        setActivities(items => {
          const index = items.findLastIndex(item => item.running && item.nodeId === event.nodeId && item.toolName === event.toolName);
          if (index < 0) return items;
          return items.map((item, i) => i === index
            ? { ...item, liveOutput: ((item.liveOutput ?? '') + event.chunk).slice(-12_000) }
            : item);
        });
      }
      if (event.type === 'tool_started' || event.type === 'tool_finished') {
        const entry: ToolActivity = {
          id: String(++activityCounter.current),
          nodeId: event.nodeId,
          toolName: event.toolName,
          summary: event.summary,
          running: event.type === 'tool_started',
          spill: event.type === 'tool_finished' ? event.spillHandle : undefined,
        };
        setActivities(items => {
          const index = entry.running ? -1 : items.findLastIndex(item => item.running && item.nodeId === entry.nodeId && item.toolName === entry.toolName);
          return index < 0 ? [...items, entry] : items.map((item, i) => i === index ? { ...entry, id: item.id, liveOutput: item.liveOutput } : item);
        });
      }
      setTree(value => value?.session.id === id ? sessionEvent(value, event) : value);
    }

    const unsubscribe = api.subscribe(id, onEvent, online => {
      if (!alive || active.current !== id) return;
      current.connected = online;
      setConnected(online);
      if (online) {
        readyWaiters.current.forEach(waiter => waiter(id));
        if (wasDisconnected) {
          void fetchTree(id);
          void refreshPending().catch(() => {});
          wasDisconnected = false;
        }
      } else wasDisconnected = true;
    });
    current.close = () => { alive = false; unsubscribe(); };
    return () => {
      current.close();
      if (stream.current === current) stream.current = undefined;
    };
  }, [sessionId, fetchTree, refreshPending, refreshProjects, refreshProjectOverview, refreshSkills, updateJob]);

  const reload = useCallback(async () => {
    const revision = ++initialLoad.current;
    setError('');
    const [projectResult, sessionResult, skillsResult, connectorResult, targetResult, demoResult, pendingResult, jobResult] = await Promise.allSettled([
      api.projects(), api.sessions(), api.skills(), api.connectors(), api.targets(), api.demos(), refreshPending(), refreshJobs(), refreshHealth(), refreshSpecialists(),
    ]);
    if (revision !== initialLoad.current) return;
    if (projectResult.status === 'fulfilled') {
      setProjects(sortByPinnedAndUpdated(projectResult.value));
    }
    if (sessionResult.status === 'fulfilled') {
      setSessions(items => sortByPinnedAndUpdated(items.reduce(upsert, sessionResult.value)));
      if (!active.current && !activeProjectRef.current && sessionResult.value[0]) switchSession(sessionResult.value[0]);
    }
    if (skillsResult.status === 'fulfilled') setCatalog(items => skillsResult.value.map(skill => ({ ...skill, loaded: skill.loaded || items.some(item => item.name === skill.name && item.loaded) })));
    if (connectorResult.status === 'fulfilled') setConnectors(connectorResult.value.connectors);
    if (targetResult.status === 'fulfilled') setTargets(targetResult.value);
    if (demoResult.status === 'fulfilled') setDemos(demoResult.value);
    const failure = [projectResult, sessionResult, skillsResult, connectorResult, targetResult, demoResult, pendingResult, jobResult].find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') reportError(failure.reason);
  }, [refreshHealth, refreshJobs, refreshPending, refreshSpecialists, reportError, switchSession]);

  useEffect(() => {
    void reload();
    const periodic = window.setInterval(() => {
      void refreshPending().catch(() => {});
      void refreshJobs().catch(() => {});
    }, 2500);
    const healthCheck = window.setInterval(() => void refreshHealth(), 12000);
    return () => { initialLoad.current++; window.clearInterval(periodic); window.clearInterval(healthCheck); currentLoad.current?.abort(); };
  }, [reload, refreshHealth, refreshJobs, refreshPending]);

  const activeProject = projects.find(p => p.id === activeProjectId);
  const computeId = computeOverride ?? tree?.session.computeTargetId ?? activeProject?.defaultComputeTargetId ?? health?.activeComputeTargetId ?? targets[0]?.id;

  async function createProject(input: NewProject) {
    const created = await api.createProject(input);
    setProjects(items => sortByPinnedAndUpdated(upsert(items, created)));
    selectProject(created.id);
    return created;
  }

  async function updateProject(id: string, patch: UpdateProject) {
    const updated = await api.updateProject(id, patch);
    setProjects(items => sortByPinnedAndUpdated(upsert(items, updated)));
    if (activeProjectRef.current === id) await refreshProjectOverview(id);
    return updated;
  }

  async function deleteProject(id: string, deleteSessions = false) {
    await api.deleteProject(id, deleteSessions);
    setProjects(items => items.filter(p => p.id !== id));
    if (deleteSessions) {
      setSessions(items => items.filter(s => s.projectId !== id));
      if (tree?.session.projectId === id) clearActiveSession();
    } else {
      setSessions(items => items.map(s => s.projectId === id ? { ...s, projectId: null } : s));
      if (tree?.session.projectId === id) setTree(cur => cur ? { ...cur, session: { ...cur.session, projectId: null } } : cur);
    }
    if (activeProjectRef.current === id) {
      activeProjectRef.current = undefined;
      setActiveProjectId(undefined);
      setProjectOverview(undefined);
    }
  }

  async function createSession(title: string, projectIdOverride?: string | null) {
    if (creating.current || topologyChanging.current) return;
    creating.current = true;
    setBusy(true); setError('');
    try {
      const targetProjectId = projectIdOverride !== undefined ? projectIdOverride : activeProjectRef.current;
      const session = await api.createSession({
        title,
        computeTargetId: computeId,
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
      });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, session)));
      switchSession(session, emptyTree(session));
      if (targetProjectId) {
        void refreshProjects();
        void refreshProjectOverview(targetProjectId);
      }
      return session;
    } catch (cause) { reportError(cause); }
    finally { creating.current = false; setBusy(false); }
  }

  async function renameSession(id: string, title: string) {
    try {
      const updated = await api.updateSession(id, { title });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, updated)));
      if (active.current === id) setTree(cur => cur ? { ...cur, session: updated } : cur);
      if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
    } catch (cause) { reportError(cause); }
  }

  async function pinSession(id: string, pinned: boolean) {
    try {
      const updated = await api.updateSession(id, { pinned });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, updated)));
      if (active.current === id) setTree(cur => cur ? { ...cur, session: updated } : cur);
      if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
    } catch (cause) { reportError(cause); }
  }

  async function moveSessionToProject(id: string, projectId: string | null) {
    try {
      const updated = await api.updateSession(id, { projectId });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, updated)));
      if (active.current === id) setTree(cur => cur ? { ...cur, session: updated } : cur);
      void refreshProjects();
      if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
    } catch (cause) { reportError(cause); }
  }

  async function deleteSession(id: string) {
    try {
      await api.deleteSession(id);
      setSessions(items => items.filter(s => s.id !== id));
      if (active.current === id) clearActiveSession();
      void refreshProjects();
      if (activeProjectRef.current) void refreshProjectOverview(activeProjectRef.current);
    } catch (cause) { reportError(cause); }
  }

  async function compactSession() {
    const id = active.current;
    if (!id || compacting) return;
    setCompacting(true);
    setError('');
    try {
      const res = await api.compactSession(id);
      setSessions(items => sortByPinnedAndUpdated(upsert(items, res.session)));
      if (active.current === id) setTree(res.tree);
    } catch (cause) { reportError(cause); }
    finally { setCompacting(false); }
  }

  async function updateWorkspace(workspacePath: string) {
    const id = active.current;
    if (!id) return;
    const updated = await api.updateWorkspace(id, workspacePath);
    setSessions(items => sortByPinnedAndUpdated(upsert(items, updated)));
    setTree(current => current && current.session.id === id ? { ...current, session: updated } : current);
  }

  async function fork(nodeId: string) {
    const source = active.current;
    if (!source || creating.current || topologyChanging.current) return;
    topologyChanging.current = true;
    setBusy(true); setError('');
    try {
      const branch = await api.fork(source, { fromNodeId: nodeId });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, branch.session)));
      switchSession(branch.session, branch);
      if (branch.session.projectId) {
        void refreshProjects();
        void refreshProjectOverview(branch.session.projectId);
      }
      return branch.session;
    } catch (cause) { reportError(cause); }
    finally { topologyChanging.current = false; setBusy(false); }
  }

  function waitForStream(id: string) {
    if (stream.current?.id === id && stream.current.connected) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = window.setTimeout(() => {
        readyWaiters.current.delete(connected);
        resolve();
      }, 1500);
      function connected(openId: string) {
        if (openId !== id) return;
        window.clearTimeout(timer);
        readyWaiters.current.delete(connected);
        resolve();
      }
      readyWaiters.current.add(connected);
    });
  }

  async function send(
    content: string,
    specialist?: SpecialistDomain,
    parentNodeId?: string,
    sessionTitle?: string,
    attachedFiles?: string[],
    customSpecialistId?: string,
    forceNewInProjectId?: string,
    mode?: 'standard' | 'deep_research',
  ) {
    if (!forceNewInProjectId && active.current && (runLocks.current.has(active.current) || auditLocks.current.has(active.current))) return false;
    const autoTitle = (sessionTitle || content).replace(/\s+/g, ' ').trim().slice(0, 72);
    const id = forceNewInProjectId
      ? (await createSession(autoTitle, forceNewInProjectId))?.id
      : active.current ?? (await createSession(autoTitle))?.id;
    if (!id || runLocks.current.has(id)) return false;
    runLocks.current.add(id);
    setRunningIds(ids => [...ids, id]); setError('');
    if (mode === 'deep_research') {
      setDeepResearchProgress({
        sessionId: id,
        stage: 'planning',
        message: 'Decomposing research question into competing hypotheses & literature queries…',
        sourcesReviewed: 0,
        hypothesesEvaluated: 0,
      });
    }
    try {
      await waitForStream(id);
      if (active.current !== id) return false;
      const result = await api.message(id, {
        content,
        parentNodeId,
        specialist,
        customSpecialistId,
        attachedFiles: attachedFiles?.length ? attachedFiles : undefined,
        computeTargetId: computeId,
        mode,
      });
      setSessions(items => sortByPinnedAndUpdated(upsert(items, result.tree.session)));
      if (active.current === id) {
        currentLoad.current?.abort();
        setTree(result.tree);
        setLoadingSession(false);
      }
      if (result.tree.session.projectId) {
        void refreshProjects();
        void refreshProjectOverview(result.tree.session.projectId);
      }
      return true;
    } catch (cause) {
      if (active.current === id) { setError(current => current || errorText(cause)); void fetchTree(id); }
      return false;
    } finally { setDeepResearchProgress(undefined); finishRun(id); }
  }

  async function decide(id: string, approved: boolean) {
    if (decisionLocks.current.has(id)) return;
    decisionLocks.current.add(id);
    setDeciding(ids => [...ids, id]); setError('');
    try {
      await api.decide(id, approved);
      permissionRevision.current++;
      setPending(items => items.filter(item => item.id !== id));
    } catch (cause) {
      reportError(cause);
      void refreshPending().catch(() => {});
    } finally {
      decisionLocks.current.delete(id);
      setDeciding(ids => ids.filter(value => value !== id));
    }
  }

  async function review(nodeId?: string) {
    const id = active.current;
    if (!id || auditLocks.current.has(id) || runLocks.current.has(id)) return;
    auditLocks.current.add(id);
    setReviewingIds(ids => [...ids, id]); setError('');
    try {
      const report = await api.review(id, { nodeId });
      setTree(value => value?.session.id === id ? { ...value, reviews: upsert(value.reviews, report) } : value);
    } catch (cause) { if (active.current === id) reportError(cause); }
    finally { finishAudit(id); }
  }

  async function autoFix(reviewId?: string) {
    const id = active.current;
    if (!id || runLocks.current.has(id) || auditLocks.current.has(id)) return;
    runLocks.current.add(id);
    setRunningIds(ids => [...ids, id]);
    setFixingIds(ids => [...ids, id]);
    setError('');
    try {
      const result = await api.autoFixReview(id, reviewId);
      setSessions(items => sortByPinnedAndUpdated(upsert(items, result.tree.session)));
      if (active.current === id) setTree(result.tree);
    } catch (cause) {
      if (active.current === id) reportError(cause);
    } finally {
      finishRun(id);
      setFixingIds(ids => ids.filter(v => v !== id));
    }
  }

  function loadSkill(name: string) {
    setCatalog(items => items.map(item => item.name === name ? { ...item, loaded: true } : item));
  }

  async function cancelRun() {
    const id = active.current;
    if (!id) return;
    try {
      await api.cancelRun(id);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function steerRun(message: string) {
    const id = active.current;
    if (!id || !message.trim()) return;
    try {
      await api.steerRun(id, message.trim());
      setSteeringNote('Queued steering guidance: ' + message.trim());
    } catch (cause) {
      reportError(cause);
    }
  }

  async function refreshSession() {
    if (active.current) await fetchTree(active.current);
  }

  return {
    health, projects, activeProjectId, activeProject, projectOverview, loadingOverview,
    sessions, catalog, specialists, connectors, targets, demos, pending, jobs, tree, sessionId,
    activities, subagents, deepResearchProgress, steeringNote, compacting,
    running: !!sessionId && runningIds.includes(sessionId),
    reviewing: !!sessionId && reviewingIds.includes(sessionId),
    fixing: !!sessionId && fixingIds.includes(sessionId),
    deciding, busy, loadingSession, connected, error, computeId,
    changeCompute: setComputeOverride,
    clearError: () => setError(''),
    reload, selectProject, createProject, updateProject, deleteProject, refreshProjects, refreshProjectOverview, refreshSkills,
    startNewSession, createSession, renameSession, pinSession, moveSessionToProject, deleteSession, compactSession,
    switchSession, updateWorkspace, fork, send, cancelRun, steerRun, decide, review, autoFix,
    loadSkill, refreshSession, refreshHealth, refreshPending, refreshConnectors, refreshSpecialists, refreshTargets, updateJob,
  };
}
