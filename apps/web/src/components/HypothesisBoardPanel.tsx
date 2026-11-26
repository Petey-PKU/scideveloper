import { useState, type FormEvent } from 'react';
import {
  CheckCircle2, FlaskConical, HelpCircle, Plus, Scale, ShieldAlert, Sparkles, Trash2, XCircle,
} from 'lucide-react';
import type {
  EvidenceGrade, EvidenceStance, HypothesisStatus, ResearchHypothesis,
} from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { ErrorNote, Pill } from './ui';

const STATUS_OPTIONS: HypothesisStatus[] = ['proposed', 'testing', 'supported', 'inconclusive', 'refuted'];

function statusTone(status: HypothesisStatus): 'teal' | 'blue' | 'amber' | 'red' | 'neutral' {
  switch (status) {
    case 'supported': return 'teal';
    case 'testing': return 'blue';
    case 'inconclusive': return 'amber';
    case 'refuted': return 'red';
    default: return 'neutral';
  }
}

function stanceTone(stance: EvidenceStance): 'teal' | 'red' | 'neutral' {
  if (stance === 'supporting') return 'teal';
  if (stance === 'contradicting') return 'red';
  return 'neutral';
}

export default function HypothesisBoardPanel({
  projectId,
  hypotheses,
  onChanged,
  onTestHypothesis,
}: {
  projectId: string;
  hypotheses: ResearchHypothesis[];
  onChanged: () => void;
  onTestHypothesis?: (hypothesis: ResearchHypothesis) => void;
}) {
  const { L } = useI18n();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [nextExperiment, setNextExperiment] = useState('');
  const [confidence, setConfidence] = useState(50);
  const [filterStatus, setFilterStatus] = useState<HypothesisStatus | 'all'>('all');
  const [addingEvId, setAddingEvId] = useState<string | null>(null);
  const [evKind, setEvKind] = useState<EvidenceStance>('supporting');
  const [evSummary, setEvSummary] = useState('');
  const [evCitation, setEvCitation] = useState('');
  const [evGrade, setEvGrade] = useState<EvidenceGrade>('cohort');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const statusLabels: Record<HypothesisStatus, string> = {
    proposed: L('待检验', 'Proposed'),
    testing: L('验证中', 'Testing'),
    supported: L('已支持', 'Supported'),
    inconclusive: L('存疑/待定', 'Inconclusive'),
    refuted: L('已证伪', 'Refuted'),
  };

  const stanceLabels: Record<EvidenceStance, string> = {
    supporting: L('支持证据', 'Supporting'),
    contradicting: L('反驳证据', 'Contradicting'),
    neutral: L('中性观察', 'Neutral'),
  };

  const gradeLabels: Record<EvidenceGrade, string> = {
    rct: L('随机对照试验 (RCT)', 'RCT'),
    'meta-analysis': L('荟萃分析', 'Meta-analysis'),
    cohort: L('队列研究', 'Cohort'),
    preclinical: L('临床前实验', 'Preclinical'),
    computational: L('计算分析', 'Computational'),
    preprint: L('预印本', 'Preprint'),
    other: L('其他', 'Other'),
  };

  const visible = filterStatus === 'all'
    ? hypotheses
    : hypotheses.filter((h) => h.status === filterStatus);

  async function submitNew(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !statement.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.createHypothesis(projectId, {
        title: title.trim(),
        statement: statement.trim(),
        confidence,
        nextExperiment: nextExperiment.trim() || undefined,
      });
      setTitle('');
      setStatement('');
      setNextExperiment('');
      setConfidence(50);
      setCreating(false);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(h: ResearchHypothesis, status: HypothesisStatus) {
    setError('');
    try {
      await api.updateHypothesis(projectId, h.id, { status });
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function updateConfidence(h: ResearchHypothesis, nextConf: number) {
    try {
      await api.updateHypothesis(projectId, h.id, { confidence: nextConf });
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function submitEvidence(e: FormEvent, hypothesisId: string) {
    e.preventDefault();
    if (!evSummary.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.addHypothesisEvidence(projectId, hypothesisId, {
        kind: evKind,
        summary: evSummary.trim(),
        citation: evCitation.trim() || undefined,
        grade: evGrade,
        sourceType: 'manual',
      });
      setEvSummary('');
      setEvCitation('');
      setAddingEvId(null);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteHypothesis(projectId, id);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <div className="stack">
      <div className="hypothesis-toolbar">
        <div className="pills">
          <button
            type="button"
            className={'tab-pill' + (filterStatus === 'all' ? ' selected' : '')}
            onClick={() => setFilterStatus('all')}
          >
            {L('全部假设', 'All')} ({hypotheses.length})
          </button>
          {STATUS_OPTIONS.map((st) => {
            const count = hypotheses.filter((h) => h.status === st).length;
            return (
              <button
                key={st}
                type="button"
                className={'tab-pill' + (filterStatus === st ? ' selected' : '')}
                onClick={() => setFilterStatus(st)}
              >
                {statusLabels[st]} ({count})
              </button>
            );
          })}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating((v) => !v)}>
          <Plus size={14} />{L('新增研究假设', 'New Hypothesis')}
        </button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {creating && (
        <form className="soft-card form-stack" onSubmit={(e) => void submitNew(e)}>
          <div className="card-head">
            <Scale size={15} className="text-teal" />
            <strong>{L('登记新的竞争假设', 'Register Research Hypothesis')}</strong>
          </div>
          <label>
            {L('假设标题', 'Hypothesis Title')}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={L('例如：EGFR C797S 顺式突变介导奥希替尼三代耐药', 'e.g. EGFR C797S cis-mutation drives tertiary osimertinib resistance')}
              required
            />
          </label>
          <label>
            {L('假设陈述与机制逻辑', 'Testable Statement & Rationale')}
            <textarea
              rows={3}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              placeholder={L('清晰写明可被数据或文献证实/证伪的科学命题…', 'Write a falsifiable scientific claim that can be tested via data or literature…')}
              required
            />
          </label>
          <div className="form-grid">
            <label>
              {L(`初始置信度 (${confidence}%)`, `Initial Confidence (${confidence}%)`)}
              <input type="range" min={0} max={100} step={5} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
            </label>
            <label>
              {L('下一步验证方案（可选）', 'Next Validation Experiment (optional)')}
              <input
                value={nextExperiment}
                onChange={(e) => setNextExperiment(e.target.value)}
                placeholder={L('例如：对比耐药株差异表达与 IC50', 'e.g. Compare resistant clone DEG + IC50 curve')}
              />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setCreating(false)}>{L('取消', 'Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !statement.trim()}>
              {L('保存到假设看板', 'Save Hypothesis')}
            </button>
          </div>
        </form>
      )}

      {visible.length === 0 ? (
        <div className="soft-card studio-empty" style={{ marginTop: 0 }}>
          <div className="empty-icon"><Scale size={22} /></div>
          <h3>{L('课题假设看板为空', 'No Hypotheses Tracked Yet')}</h3>
          <p>
            {L(
              '在此登记核心研究假设，或在上方开启「深度文献调研（Deep Research）」让 AI 自动拆解竞争假设并沉淀支持/反驳证据链。',
              'Register key hypotheses here, or enable Deep Research above so the agent evaluates competing hypotheses and attaches graded evidence automatically.',
            )}
          </p>
        </div>
      ) : (
        <div className="hypothesis-grid">
          {visible.map((h) => {
            const supportCount = h.evidence.filter((e) => e.kind === 'supporting').length;
            const contraCount = h.evidence.filter((e) => e.kind === 'contradicting').length;
            return (
              <article key={h.id} className="soft-card hypothesis-card stack">
                <div className="card-head">
                  <Pill tone={statusTone(h.status)}>
                    {h.status === 'supported' && <CheckCircle2 size={11} />}
                    {h.status === 'refuted' && <XCircle size={11} />}
                    {h.status === 'inconclusive' && <HelpCircle size={11} />}
                    {h.status === 'testing' && <FlaskConical size={11} />}
                    {statusLabels[h.status]}
                  </Pill>
                  <strong className="truncate" style={{ flex: 1 }} title={h.title}>{h.title}</strong>
                  <select
                    aria-label={L('更新假设状态', 'Update hypothesis status')}
                    value={h.status}
                    onChange={(e) => void updateStatus(h, e.target.value as HypothesisStatus)}
                    style={{ padding: '2px 7px', fontSize: 12, borderRadius: 7 }}
                  >
                    {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{statusLabels[st]}</option>)}
                  </select>
                  <button type="button" className="icon-btn" onClick={() => void remove(h.id)} aria-label={L('删除假设', 'Delete hypothesis')}>
                    <Trash2 size={13} />
                  </button>
                </div>

                <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>{h.statement}</p>

                <div className="confidence-row">
                  <span className="muted" style={{ fontSize: 11.5 }}>{L('证据置信度', 'Confidence')}</span>
                  <div className="confidence-bar" role="progressbar" aria-valuenow={h.confidence} aria-valuemin={0} aria-valuemax={100}>
                    <div className="confidence-fill" style={{ width: `${Math.max(0, Math.min(100, h.confidence))}%` }} />
                  </div>
                  <strong style={{ fontSize: 12 }}>{h.confidence}%</strong>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={h.confidence}
                    aria-label={L('调整置信度', 'Adjust confidence')}
                    onChange={(e) => void updateConfidence(h, Number(e.target.value))}
                    style={{ width: 68 }}
                  />
                </div>

                <div className="pills">
                  <Pill tone="teal">+{supportCount} {L('支持', 'supporting')}</Pill>
                  {contraCount > 0 && <Pill tone="red">-{contraCount} {L('反驳', 'contradicting')}</Pill>}
                  <Pill>{h.evidence.length} {L('条证据', 'evidence')}</Pill>
                </div>

                {h.evidence.length > 0 && (
                  <div className="evidence-list">
                    {h.evidence.map((ev) => (
                      <div key={ev.id} className="evidence-item">
                        <div className="pills" style={{ marginBottom: 3 }}>
                          <Pill tone={stanceTone(ev.kind)}>{stanceLabels[ev.kind]}</Pill>
                          {ev.grade && <Pill tone="blue">{gradeLabels[ev.grade] ?? ev.grade}</Pill>}
                          {ev.citation && <code>{ev.citation}</code>}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.45 }}>{ev.summary}</p>
                      </div>
                    ))}
                  </div>
                )}

                {h.nextExperiment && (
                  <div className="next-experiment-note">
                    <ShieldAlert size={13} className="text-teal" />
                    <span><strong>{L('建议验证：', 'Next Test: ')}</strong>{h.nextExperiment}</span>
                  </div>
                )}

                <div className="actions justify-start">
                  <button type="button" className="btn" onClick={() => setAddingEvId(addingEvId === h.id ? null : h.id)}>
                    <Plus size={12} />{L('补充证据', 'Add Evidence')}
                  </button>
                  {onTestHypothesis && (
                    <button type="button" className="btn btn-soft-active" onClick={() => onTestHypothesis(h)}>
                      <Sparkles size={12} />{L('深度调研验证此假设', 'Deep-Research This')}
                    </button>
                  )}
                </div>

                {addingEvId === h.id && (
                  <form className="form-stack" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }} onSubmit={(e) => void submitEvidence(e, h.id)}>
                    <div className="grid-2">
                      <select value={evKind} onChange={(e) => setEvKind(e.target.value as EvidenceStance)}>
                        <option value="supporting">{stanceLabels.supporting}</option>
                        <option value="contradicting">{stanceLabels.contradicting}</option>
                        <option value="neutral">{stanceLabels.neutral}</option>
                      </select>
                      <select value={evGrade} onChange={(e) => setEvGrade(e.target.value as EvidenceGrade)}>
                        {Object.entries(gradeLabels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                    </div>
                    <textarea
                      rows={2}
                      value={evSummary}
                      onChange={(e) => setEvSummary(e.target.value)}
                      placeholder={L('证据摘要（例如：FLAURA2 III期试验 PFS HR=0.62）…', 'Evidence summary (e.g. FLAURA2 Phase III PFS HR=0.62)…')}
                      required
                    />
                    <input
                      value={evCitation}
                      onChange={(e) => setEvCitation(e.target.value)}
                      placeholder={L('引文编号（可选，如 PMID:37937763 / NCT04035486）', 'Citation (optional, e.g. PMID:37937763 / NCT04035486)')}
                    />
                    <div className="actions">
                      <button type="button" className="btn" onClick={() => setAddingEvId(null)}>{L('取消', 'Cancel')}</button>
                      <button type="submit" className="btn btn-primary" disabled={busy || !evSummary.trim()}>
                        {L('保存证据', 'Attach Evidence')}
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
