import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle, ArrowRight, ArrowUp, BarChart3, Box, Brain, CheckCircle2, ChevronDown,
  Compass, Cpu, Dna, FileSpreadsheet, FileText, FlaskConical, GitBranch, Microscope,
  Paperclip, Settings, ShieldAlert, Sparkles, Square, Telescope, Terminal, Upload, X,
} from 'lucide-react';
import type {
  ArtifactType, CustomSpecialist, DeepResearchProgress, PermissionRequest, ReviewReport, ScientificArtifact,
  SessionNode, SpecialistDomain, SpillHandle, SubAgentRunSummary,
} from '@scideveloper/shared';
import type { WorkflowDemo } from '../api';
import { useI18n, type Locale } from '../i18n';
import { Loading, Markdown, Pill, roleLabel, SpillCard, time } from './ui';

export interface ToolActivity {
  id: string;
  nodeId: string;
  toolName: string;
  summary: string;
  running: boolean;
  liveOutput?: string;
  spill?: SpillHandle;
}

const demoIcons = [Dna, BarChart3, FlaskConical, Microscope, GitBranch];

export function artifactTypeLabel(type: ArtifactType, locale: Locale = 'en'): string {
  if (locale === 'zh') {
    switch (type) {
      case 'figure': return '科研图表';
      case 'interactive_chart': return '交互图表';
      case 'table': return '数据表';
      case 'protein_3d': return '3D 结构';
      case 'genome_track': return '基因组轨道';
      case 'molecule_2d': return '化合物结构';
      case 'phylo_tree': return '系统发育树';
      case 'manuscript': return '论文手稿';
      case 'code_report': return '分析脚本';
      case 'raw_data': return '数据文件';
      default: return '分析结果';
    }
  }
  switch (type) {
    case 'figure': return 'Figure';
    case 'interactive_chart': return 'Interactive Chart';
    case 'table': return 'Data Table';
    case 'protein_3d': return '3D Structure';
    case 'genome_track': return 'Genome Track';
    case 'molecule_2d': return 'Compounds';
    case 'phylo_tree': return 'Phylogenetic Tree';
    case 'manuscript': return 'Manuscript';
    case 'code_report': return 'Script';
    case 'raw_data': return 'Data File';
    default: return 'Result';
  }
}

export function ArtifactTypeIcon({ type, size = 15 }: { type: ArtifactType; size?: number }) {
  switch (type) {
    case 'figure':
    case 'interactive_chart': return <BarChart3 size={size} />;
    case 'table': return <FileSpreadsheet size={size} />;
    case 'protein_3d': return <Box size={size} />;
    case 'genome_track': return <Dna size={size} />;
    case 'molecule_2d': return <FlaskConical size={size} />;
    case 'phylo_tree': return <GitBranch size={size} />;
    default: return <FileText size={size} />;
  }
}

export function PermissionGate({ request, busy, decide }: {
  request: PermissionRequest; busy: boolean; decide: (id: string, approve: boolean) => void;
}) {
  const { L } = useI18n();
  return <article className="permission-card">
    <div className="flex items-start gap-3">
      <ShieldAlert size={20} className="shrink-0" />
      <div className="min-w-0">
        <h3>{L('需要您的确认', 'Approval needed')}</h3>
        <p>{request.reason}</p>
        <code className="break-all">{request.action} · {request.target}</code>
      </div>
    </div>
    <div className="actions">
      <button className="btn" disabled={busy} onClick={() => decide(request.id, false)}>{L('拒绝', 'Decline')}</button>
      <button className="btn btn-amber" disabled={busy} onClick={() => decide(request.id, true)}>{L('允许执行', 'Allow')}</button>
    </div>
  </article>;
}

interface ResearchTurn {
  id: string;
  userNode?: SessionNode;
  stepNodes: SessionNode[];
  answerNode?: SessionNode;
  reviewNodes: SessionNode[];
  artifactIds: string[];
  allNodeIds: string[];
}

function isInternalPlanningNode(node: SessionNode): boolean {
  return node.role === 'coordinator' && /^Decomposed research objective/i.test(node.content.trim());
}

function groupTurns(nodes: SessionNode[], artifacts: ScientificArtifact[]): ResearchTurn[] {
  const turns: ResearchTurn[] = [];
  let current: { userNode?: SessionNode; responses: SessionNode[] } | null = null;

  for (const node of nodes) {
    if (node.role === 'user') {
      if (current) turns.push(finalizeTurn(current, artifacts));
      current = { userNode: node, responses: [] };
    } else if (node.role !== 'tool' && node.role !== 'system') {
      if (!current) current = { responses: [] };
      current.responses.push(node);
    }
  }
  if (current) turns.push(finalizeTurn(current, artifacts));
  return turns;
}

function finalizeTurn(
  raw: { userNode?: SessionNode; responses: SessionNode[] },
  artifacts: ScientificArtifact[],
): ResearchTurn {
  const reviewNodes = raw.responses.filter(node => node.role === 'reviewer');
  const contentNodes = raw.responses.filter(node => node.role !== 'reviewer');

  let answerNode: SessionNode | undefined;
  let stepNodes: SessionNode[] = [];

  if (contentNodes.length >= 2) {
    answerNode = contentNodes[contentNodes.length - 1];
    stepNodes = contentNodes.slice(0, -1);
  } else if (contentNodes.length === 1) {
    if (isInternalPlanningNode(contentNodes[0])) {
      stepNodes = [contentNodes[0]];
    } else {
      answerNode = contentNodes[0];
    }
  }

  const allNodes = [raw.userNode, ...raw.responses].filter((n): n is SessionNode => !!n);
  const allNodeIds = allNodes.map(n => n.id);
  const nodeIdSet = new Set(allNodeIds);
  const artifactIds = [
    ...new Set([
      ...allNodes.flatMap(n => n.artifactIds),
      ...artifacts.filter(a => nodeIdSet.has(a.nodeId)).map(a => a.id),
    ]),
  ];

  return {
    id: raw.userNode?.id ?? raw.responses[0]?.id ?? 'turn',
    userNode: raw.userNode,
    stepNodes,
    answerNode,
    reviewNodes,
    artifactIds,
    allNodeIds,
  };
}

export default function ResearchStream({
  nodes, artifacts, reviews, demos, activities, subagents, deepResearchProgress, steeringNote, pending, deciding, running, ready,
  modelConfigured, selectedArtifactId, parentNode, attachedFiles, customSpecialists, externalDraft,
  onConsumeExternalDraft, onClearParent, onDetachFile, onDropFiles, onOpenFiles, onOpenModels,
  onSend, onCancel, onSteer, onArtifact, onOpenReview, onEditAndBranch, onDecide,
}: {
  sessionId?: string;
  nodes: SessionNode[];
  artifacts: ScientificArtifact[];
  reviews: ReviewReport[];
  demos: WorkflowDemo[];
  activities: ToolActivity[];
  subagents: SubAgentRunSummary[];
  deepResearchProgress?: DeepResearchProgress;
  steeringNote?: string;
  pending: PermissionRequest[];
  deciding: string[];
  running: boolean;
  ready: boolean;
  modelConfigured: boolean;
  selectedArtifactId?: string;
  parentNode?: SessionNode;
  attachedFiles: string[];
  customSpecialists: CustomSpecialist[];
  externalDraft?: string;
  onConsumeExternalDraft?: () => void;
  onClearParent: () => void;
  onDetachFile: (path: string) => void;
  onDropFiles?: (files: FileList) => Promise<void>;
  onOpenFiles: () => void;
  onOpenModels: () => void;
  onSend: (
    content: string,
    specialist?: SpecialistDomain,
    sessionTitle?: string,
    attachedFiles?: string[],
    customSpecialistId?: string,
    mode?: 'standard' | 'deep_research',
  ) => Promise<boolean>;
  onCancel: () => void;
  onSteer: (message: string) => void;
  onArtifact: (id: string) => void;
  onOpenReview: () => void;
  onEditAndBranch?: (node: SessionNode) => void;
  onDecide: (id: string, approve: boolean) => void;
}) {
  const { locale, t, L } = useI18n();
  const [draft, setDraft] = useState('');
  const [deepResearch, setDeepResearch] = useState(false);
  const [steerDraft, setSteerDraft] = useState('');
  const [customSpecChoice, setCustomSpecChoice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploadingDrop, setUploadingDrop] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const last = nodes.at(-1);
  const byId = useMemo(() => new Map(artifacts.map(artifact => [artifact.id, artifact])), [artifacts]);
  const turns = useMemo(() => groupTurns(nodes, artifacts), [nodes, artifacts]);
  const hasResearchMessages = turns.length > 0;

  useEffect(() => {
    if (externalDraft) {
      setDraft(externalDraft);
      onConsumeExternalDraft?.();
    }
  }, [externalDraft, onConsumeExternalDraft]);

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [last?.id, last?.content, last?.thinking, activities, pending.length, artifacts.length]);

  function sendDraft() {
    const value = draft.trim();
    if (!value || !ready || running) return;
    if (!modelConfigured) {
      onOpenModels();
      return;
    }
    follow.current = true;
    void onSend(
      value,
      undefined,
      undefined,
      attachedFiles,
      customSpecChoice || undefined,
      deepResearch ? 'deep_research' : 'standard',
    ).then(sent => {
      if (sent) setDraft(current => (current === draft ? '' : current));
    });
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    if (e.currentTarget === e.target) setDragging(false);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!e.dataTransfer.files?.length || !onDropFiles) return;
    setUploadingDrop(true);
    try {
      await onDropFiles(e.dataTransfer.files);
    } finally {
      setUploadingDrop(false);
    }
  }

  return <>
    <div ref={scroll} className="research-scroll" onScroll={event => {
      const el = event.currentTarget;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      <div className="research-column">
        {!hasResearchMessages && <div className="starter">
          <div className="starter-icon"><Sparkles size={24} strokeWidth={1.7} /></div>
          <h1>{t('starterHeadline')}</h1>
          <p>{t('starterSubtitle')}</p>

          {!modelConfigured && (
            <div className="onboarding-banner">
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

          {demos.length > 0 && <div className="demo-grid">{demos.slice(0, 4).map((demo, index) => {
            const Icon = demoIcons[index % demoIcons.length];
            return <button key={demo.id} className="demo-card" disabled={running || !ready}
              onClick={() => {
                if (!modelConfigured) {
                  setDraft(demo.prompt);
                  onOpenModels();
                  return;
                }
                void onSend(demo.prompt, demo.domain, demo.title);
              }}>
              <span className={'demo-icon demo-' + (index % 4)}><Icon size={17} /></span>
              <ArrowRight size={14} className="demo-arrow" />
              <strong>{demo.title}</strong>
              <span>{demo.description}</span>
            </button>;
          })}</div>}
        </div>}

        {turns.map((turn, turnIndex) => {
          const isLastTurn = turnIndex === turns.length - 1;
          const turnArtifacts = turn.artifactIds
            .map(id => byId.get(id))
            .filter((item): item is ScientificArtifact => !!item);
          const turnActivities = isLastTurn ? activities : [];
          const turnNodeSet = new Set(turn.allNodeIds);
          const matchedReview = reviews
            .filter(r => turnNodeSet.has(r.nodeId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
            ?? (isLastTurn && turn.reviewNodes.length > 0
              ? reviews.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
              : undefined);
          const hasReviewInfo = !!matchedReview || turn.reviewNodes.length > 0;
          const stepCount = turn.stepNodes.length + turnActivities.length;
          const showWorking = isLastTurn && running && !turn.answerNode;
          const thinkingText = turn.answerNode?.thinking || turn.stepNodes.map(s => s.thinking).filter(Boolean).join('\n\n');

          return <div key={turn.id} className="turn">
            {turn.userNode && <article id={'node-' + turn.userNode.id} className="turn-user">
              <div className="turn-user-bubble">
                <p>{turn.userNode.content}</p>
              </div>
              <div className="turn-user-meta">
                <time dateTime={turn.userNode.createdAt}>{time(turn.userNode.createdAt)}</time>
                {onEditAndBranch && !running && (
                  <button
                    type="button"
                    className="link-btn turn-hover-action"
                    onClick={() => {
                      setDraft(turn.userNode!.content);
                      onEditAndBranch(turn.userNode!);
                    }}
                  >
                    <GitBranch size={11} />{t('editAndBranch')}
                  </button>
                )}
              </div>
            </article>}

            {(turn.answerNode || stepCount > 0 || showWorking || turnArtifacts.length > 0 || hasReviewInfo) && (
              <article id={turn.answerNode ? 'node-' + turn.answerNode.id : undefined} className="turn-assistant">
                {thinkingText && (
                  <details className="thinking-disclosure" open={isLastTurn && running && !turn.answerNode?.content}>
                    <summary>
                      <Brain size={14} className="text-teal" />
                      <span>{t('thinking')}</span>
                      <ChevronDown size={13} className="steps-chevron" />
                    </summary>
                    <div className="thinking-body">{thinkingText}</div>
                  </details>
                )}

                {stepCount > 0 && <details className="steps-disclosure" open={isLastTurn && running}>
                  <summary>
                    <ChevronDown size={15} className="steps-chevron" />
                    <span>
                      {isLastTurn && running
                        ? L('正在执行分析步骤…', 'Running analysis steps…')
                        : L(`分析过程（${turn.stepNodes.length} 步）`, `Analysis process (${turn.stepNodes.length} ${turn.stepNodes.length === 1 ? 'step' : 'steps'})`)}
                    </span>
                    {isLastTurn && running && <Loading label="" />}
                  </summary>
                  <div className="steps-body">
                    {turn.stepNodes.map(step => <div key={step.id} id={'node-' + step.id} className="step-item">
                      <div className="step-head">
                        <Pill tone={step.role}>{roleLabel(step.role, locale)}</Pill>
                        <span className="muted">{step.agentName}</span>
                      </div>
                      <Markdown text={step.content} citations={matchedReview?.verifiedCitations} onCitationClick={onOpenReview} />
                    </div>)}
                    {isLastTurn && subagents.length > 0 && <div className="step-tools">
                      <div className="section-label"><Cpu size={13} />{L(`并行子任务（${subagents.length}）`, `Parallel sub-agents (${subagents.length})`)}</div>
                      {subagents.map(sub => <div className="tool-row" key={sub.runId}>
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{sub.specialistName}</strong>
                          <Pill tone="blue">{sub.domain}</Pill>
                          <Pill tone={sub.status === 'completed' ? 'teal' : sub.status === 'failed' || sub.status === 'cancelled' ? 'red' : 'amber'}>{sub.status}</Pill>
                          {sub.durationMs > 0 && <span className="muted text-xs">{sub.durationMs} ms</span>}
                        </div>
                        <p className="muted">{sub.summary || sub.task}</p>
                      </div>)}
                    </div>}
                    {turnActivities.length > 0 && <div className="step-tools">
                      <div className="section-label"><Terminal size={13} />{L(`数据与工具调用（${turnActivities.length}）`, `Data & tool calls (${turnActivities.length})`)}</div>
                      {turnActivities.map(activity => <div className="tool-row" key={activity.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <code>{activity.toolName}</code>
                          <Pill tone={activity.running ? 'blue' : 'neutral'}>{activity.running ? L('运行中', 'Running') : L('完成', 'Done')}</Pill>
                        </div>
                        <p className="muted">{activity.summary}</p>
                        {activity.liveOutput && (
                          <pre className="live-terminal">{activity.liveOutput}</pre>
                        )}
                        {activity.spill && <SpillCard handle={activity.spill} />}
                      </div>)}
                    </div>}
                  </div>
                </details>}

                {showWorking && <div className="working-indicator stack" style={{ gap: 8 }}>
                  {deepResearchProgress ? (
                    <div className="deep-research-banner">
                      <div className="pills">
                        <Pill tone="reviewer"><Telescope size={11} />{L('深度文献调研模式', 'Deep Research')}</Pill>
                        <Pill tone="blue">{deepResearchProgress.stage}</Pill>
                        {deepResearchProgress.sourcesReviewed > 0 && <Pill tone="teal">{deepResearchProgress.sourcesReviewed} {L('来源已核查', 'sources')}</Pill>}
                        {deepResearchProgress.hypothesesEvaluated > 0 && <Pill>{deepResearchProgress.hypothesesEvaluated} {L('假设已评估', 'hypotheses')}</Pill>}
                      </div>
                      <p style={{ fontSize: 13 }}>{deepResearchProgress.message}</p>
                    </div>
                  ) : (
                    <Loading label={L('正在分析数据并准备科研图表…', 'Analyzing data and preparing scientific outputs…')} />
                  )}
                  {steeringNote && <Pill tone="blue">{steeringNote}</Pill>}
                </div>}

                {turn.answerNode && (
                  turn.answerNode.content
                    ? <Markdown text={turn.answerNode.content} citations={matchedReview?.verifiedCitations} onCitationClick={onOpenReview} />
                    : <Loading label={L('正在整理分析结论…', 'Writing summary…')} />
                )}

                {turnArtifacts.length > 0 && <div className="result-shelf">
                  <div className="result-shelf-label">{L('生成结果', 'Generated results')}</div>
                  <div className="result-cards">
                    {turnArtifacts.map(item => (
                      <button key={item.id}
                        className={'result-card' + (selectedArtifactId === item.id ? ' active' : '')}
                        onClick={() => onArtifact(item.id)}>
                        <span className="result-card-icon"><ArtifactTypeIcon type={item.type} size={16} /></span>
                        <span className="result-card-text">
                          <strong>{item.title}</strong>
                          <span>{artifactTypeLabel(item.type, locale)}</span>
                        </span>
                        <ArrowRight size={14} className="result-card-arrow" />
                      </button>
                    ))}
                  </div>
                </div>}

                {hasReviewInfo && <button type="button"
                  className={'quality-bar ' + (matchedReview?.overallStatus === 'fail' ? 'quality-fail' : matchedReview?.overallStatus === 'warn' ? 'quality-warn' : 'quality-pass')}
                  onClick={onOpenReview}>
                  {matchedReview?.overallStatus === 'fail' || matchedReview?.overallStatus === 'warn'
                    ? <AlertTriangle size={15} />
                    : <CheckCircle2 size={15} />}
                  <span className="quality-bar-text">
                    {matchedReview
                      ? matchedReview.overallStatus === 'pass'
                        ? <>{L('质量审查已通过', 'Quality check passed')} · <strong>{matchedReview.score}/100</strong></>
                        : matchedReview.overallStatus === 'warn'
                          ? <>{L('质量审查存在提示', 'Quality check warnings')} · <strong>{matchedReview.score}/100</strong></>
                          : <>{L('质量审查发现问题', 'Quality check issues')} · <strong>{matchedReview.score}/100</strong></>
                      : <>{L('质量审查已完成', 'Quality check completed')}</>}
                  </span>
                  <span className="quality-bar-link">{L('查看报告', 'View report')} <ArrowRight size={13} /></span>
                </button>}
              </article>
            )}
          </div>;
        })}

        {pending.map(request => <PermissionGate key={request.id} request={request} busy={deciding.includes(request.id)} decide={onDecide} />)}
      </div>
    </div>

    <form
      className="prompt-wrap"
      onSubmit={event => { event.preventDefault(); sendDraft(); }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={e => void handleDrop(e)}
    >
      <div className="prompt-column">
        <div className={'prompt-box' + (dragging ? ' drop-active' : '') + (deepResearch ? ' deep-research-active' : '')}>
          {dragging && (
            <div className="drop-overlay">
              <Upload size={18} />
              <span>{L('松开鼠标即可上传并挂载 CSV / XLSX / PDF / VCF / H5AD / PDB 文件', 'Drop CSV, XLSX, PDF, VCF, SDF, H5AD, or PDB files to attach')}</span>
            </div>
          )}
          {uploadingDrop && <div className="prompt-context"><Loading label={L('正在上传文件…', 'Uploading file(s)…')} /></div>}
          {parentNode && <div className="prompt-context">
            <span className="truncate" title={parentNode.content}>
              {L('从此步骤分叉继续：', 'Branching from: ')}{parentNode.content.split('\n')[0] || parentNode.agentName}
            </span>
            <button type="button" className="icon-btn" aria-label={L('取消分叉选择', 'Clear selected step')} onClick={onClearParent}><X size={14} /></button>
          </div>}
          {attachedFiles.length > 0 && <div className="attached-files-bar">
            {attachedFiles.map(path => (
              <span key={path} className="attached-chip">
                <Paperclip size={12} />
                <span className="truncate">{path}</span>
                <button type="button" aria-label={L(`移除 ${path}`, `Detach ${path}`)} onClick={() => onDetachFile(path)}><X size={11} /></button>
              </span>
            ))}
          </div>}
          {running && <div className="steering-bar">
            <Compass size={14} className="text-teal shrink-0" />
            <input
              value={steerDraft}
              onChange={e => setSteerDraft(e.target.value)}
              placeholder={t('steerPlaceholder')}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (steerDraft.trim()) { onSteer(steerDraft); setSteerDraft(''); }
                }
              }}
            />
            <button type="button" className="btn" disabled={!steerDraft.trim()} onClick={() => { onSteer(steerDraft); setSteerDraft(''); }}>{t('sendSteer')}</button>
            <button type="button" className="btn btn-danger" onClick={onCancel} title={t('stopRun')}>
              <Square size={12} fill="currentColor" />{t('stopRun')}
            </button>
          </div>}
          <div className="prompt-row">
            <button type="button" className="icon-btn" title={L('从文件栏添加本地数据', 'Attach local file')} aria-label={L('添加本地数据', 'Attach local file')} onClick={onOpenFiles}>
              <Paperclip size={16} />
            </button>
            <textarea
              aria-label={L('科研问题输入框', 'Research question')}
              placeholder={attachedFiles.length
                ? L(`针对 ${attachedFiles.join('、')} 提问…`, `Ask about ${attachedFiles.join(', ')}…`)
                : t('askPlaceholder')}
              rows={2}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
            />
            {running ? (
              <button type="button" className="send-btn send-stop" onClick={onCancel} aria-label={t('stopRun')} title={t('stopRun')}>
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className={'send-btn' + (deepResearch ? ' send-deep' : '')} disabled={!ready || !draft.trim()} aria-label={L('发送问题', 'Send question')}>
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <div className="prompt-footer">
            <div className="actions justify-start" style={{ gap: 6 }}>
              <button
                type="button"
                className={'deep-research-toggle' + (deepResearch ? ' active' : '')}
                aria-pressed={deepResearch}
                onClick={() => setDeepResearch(v => !v)}
              >
                <Telescope size={13} />
                <span>{L('深度调研', 'Deep Research')}</span>
              </button>
              {customSpecialists.length > 0 && (
                <label className="specialist-picker">
                  <span>{L('专家', 'Specialist')}</span>
                  <select value={customSpecChoice} onChange={e => setCustomSpecChoice(e.target.value)}>
                    <option value="">{t('autoRoute')}</option>
                    {customSpecialists.map(sp => (
                      <option key={sp.id} value={sp.id}>{sp.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <span className="prompt-hint">
              {deepResearch ? L('多库文献综述 · 证据分级 · 竞争假设评估', 'Multi-source synthesis · evidence grades · hypotheses') : t('sendHint')}
            </span>
          </div>
        </div>
      </div>
    </form>
  </>;
}
