import { AlertTriangle, CheckCircle2, ChevronDown, Eye, ExternalLink, RefreshCw, ShieldCheck, Wand2 } from 'lucide-react';
import type { ReviewCheckCategory, ReviewReport } from '@scideveloper/shared';
import { useI18n } from '../i18n';
import { Loading, Markdown, Pill } from './ui';

const categoriesEn: Record<ReviewCheckCategory, string> = {
  citation_verification: 'Literature citations',
  code_figure_alignment: 'Figure & file integrity',
  visual_inspection: 'Visual figure inspection',
  numeric_parity: 'Reported numbers match data',
  statistical_rigor: 'Statistical rigor',
  methodology_semantics: 'Methodology & semantic audit',
  reproducibility: 'Reproducibility record',
};

const categoriesZh: Record<ReviewCheckCategory, string> = {
  citation_verification: '文献引用核验',
  code_figure_alignment: '图表与文件一致性',
  visual_inspection: '图表视觉排版检查',
  numeric_parity: '报告数值与计算一致',
  statistical_rigor: '统计学严谨性',
  methodology_semantics: '方法学与逻辑审查',
  reproducibility: '可复现记录完整性',
};

const tone = { pass: 'teal', warn: 'amber', fail: 'red' } as const;

export default function ReviewerPanel({
  report,
  busy,
  fixing,
  canReview,
  onReview,
  onAutoFix,
}: {
  report?: ReviewReport;
  busy: boolean;
  fixing?: boolean;
  canReview: boolean;
  onReview: () => void;
  onAutoFix?: (reviewId: string) => void;
}) {
  const { locale, L } = useI18n();
  const categories = locale === 'zh' ? categoriesZh : categoriesEn;
  const statusText = {
    pass: L('通过', 'Passed'),
    warn: L('提示', 'Warnings'),
    fail: L('发现问题', 'Issues found'),
  } as const;

  if (!report) {
    return <section className="stack">
      <div className="studio-empty">
        <div className="empty-icon"><ShieldCheck size={22} /></div>
        <h3>{L('暂无质量审查报告', 'No quality check yet')}</h3>
        <p>{L('运行审查可自动核验文献引用、数值一致性、图表排版、统计学规范及可复现记录。', 'Run a check to verify citations, numbers, visual figure layout, statistical rigor, and reproducibility.')}</p>
        <div className="actions justify-center mt-3">
          <button type="button" className="btn btn-primary" disabled={busy || !canReview} onClick={onReview}>
            {busy ? <Loading label={L('审查中…', 'Checking…')} /> : <><ShieldCheck size={15} />{L('立即运行审查', 'Run quality check')}</>}
          </button>
        </div>
      </div>
    </section>;
  }

  const populatedCategories = (Object.entries(categories) as [ReviewCheckCategory, string][])
    .map(([category, label]) => ({
      category,
      label,
      findings: report.findings.filter(finding => finding.category === category),
    }))
    .filter(group => group.findings.length > 0);

  return <section className="stack">
    <div className="review-summary soft-card stack">
      <div className="card-head">
        <div className="flex flex-wrap items-center gap-2">
          {report.overallStatus === 'pass'
            ? <CheckCircle2 size={20} className="text-teal" />
            : <AlertTriangle size={20} className="text-amber" />}
          <span className="review-score">{report.score}<small>/100</small></span>
          <Pill tone={tone[report.overallStatus]}>{statusText[report.overallStatus]}</Pill>
          {report.semanticAuditUsed && <Pill tone="blue">{L('语义审查', 'Semantic Audit')}</Pill>}
          {report.visionAuditUsed && <Pill tone="teal"><Eye size={11} />{L('视觉检查', 'Vision Audit')}</Pill>}
        </div>
        <button type="button" className="btn" disabled={busy || fixing || !canReview} onClick={onReview} title={L('重新运行质量审查', 'Run quality check again')}>
          {busy ? <Loading label={L('审查中…', 'Checking…')} /> : <><RefreshCw size={13} />{L('重新审查', 'Re-check')}</>}
        </button>
      </div>
      <Markdown text={report.summary} />

      {report.overallStatus !== 'pass' && report.autoFixPrompt && onAutoFix && (
        <div className="actions justify-start">
          <button type="button" className="btn btn-amber" disabled={busy || fixing || !canReview} onClick={() => onAutoFix(report.id)}>
            {fixing ? <Loading label={L('正在自动修复并复检…', 'Auto-fixing & re-verifying…')} /> : <><Wand2 size={14} />{L('一键修复并复检', 'Auto-Fix & Re-Verify')}</>}
          </button>
        </div>
      )}
    </div>

    {populatedCategories.map(({ category, label, findings }) => (
      <section key={category} className="review-category">
        <h3 className="section-label">{label}</h3>
        {findings.map(finding => <article key={finding.id} className="soft-card stack">
          <div className="card-head">
            <strong>{finding.title}</strong>
            <Pill tone={tone[finding.severity]}>{statusText[finding.severity]}</Pill>
          </div>
          <Markdown text={finding.detail} />
          {finding.evidence && <details className="subtle-details">
            <summary><ChevronDown size={14} />{L('查看支撑证据', 'Supporting evidence')}</summary>
            <div className="mt-2"><Markdown text={finding.evidence} /></div>
          </details>}
          {finding.suggestedFix && <p className="muted">{L('修改建议：', 'Suggestion: ')}{finding.suggestedFix}</p>}
        </article>)}
      </section>
    ))}

    {!!report.verifiedCitations.length && <section className="stack">
      <h3 className="section-label">{L(`已核验文献（${report.verifiedCitations.length}）`, `Verified literature (${report.verifiedCitations.length})`)}</h3>
      {report.verifiedCitations.map((citation, index) => {
        const pmid = citation.identifier.match(/^(?:PMID\s*:?\s*)?(\d+)$/i)?.[1];
        return <div key={citation.identifier + ':' + index} className="soft-card stack">
          <div className="pills">
            <Pill tone={citation.verified ? 'teal' : 'amber'}>{citation.verified ? L('已核验', 'Verified') : L('未核验', 'Unverified')}</Pill>
            {pmid
              ? <a className="citation" href={'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/'} target="_blank" rel="noreferrer">
                  PMID {pmid} <ExternalLink size={12} />
                </a>
              : <Pill>{citation.identifier}</Pill>}
          </div>
          {citation.title && <span className="citation-title">{citation.title}</span>}
          {citation.source && <small className="muted">{citation.source}</small>}
        </div>;
      })}
    </section>}
  </section>;
}
