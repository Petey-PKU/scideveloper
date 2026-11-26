import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import type { DistilledSkillDraft, SkillDocument, SpecialistDomain } from '@scideveloper/shared';
import { api, errorText } from '../api';
import { useI18n } from '../i18n';
import { ErrorNote, Loading, Modal } from './ui';

const DOMAINS: SpecialistDomain[] = [
  'genomics', 'single-cell', 'structural-biology', 'cheminformatics',
  'statistics', 'literature', 'manuscript', 'proteomics', 'metabolomics', 'clinical', 'custom',
];

export default function DistillSkillModal({
  sessionId,
  activeProjectId,
  activeProjectName,
  onSaved,
  onClose,
}: {
  sessionId: string;
  activeProjectId?: string;
  activeProjectName?: string;
  onSaved: (skill: SkillDocument) => void;
  onClose: () => void;
}) {
  const { L } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState<SpecialistDomain>('custom');
  const [tagsText, setTagsText] = useState('');
  const [connectorsText, setConnectorsText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [attachToProject, setAttachToProject] = useState(Boolean(activeProjectId));

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void api.distillSkill(sessionId).then((draft: DistilledSkillDraft) => {
      if (!live) return;
      setName(draft.name);
      setTitle(draft.title);
      setDescription(draft.description);
      setDomain(draft.domain);
      setTagsText(draft.tags.join(', '));
      setConnectorsText(draft.recommendedConnectors.join(', '));
      setInstructions(draft.instructions);
    }).catch((cause) => {
      if (live) setError(errorText(cause));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [sessionId]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !title.trim() || !instructions.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveCustomSkill({
        name: name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
        title: title.trim(),
        description: description.trim() || title.trim(),
        domain,
        tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
        recommendedConnectors: connectorsText.split(',').map((s) => s.trim()).filter(Boolean),
        instructions: instructions.trim(),
        sourceSessionId: sessionId,
        attachToProjectId: attachToProject ? activeProjectId : undefined,
      });
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={L('从本次分析提炼可复用 Skill', 'Distill Session into Reusable Skill')}
      subtitle={L('将本次验证通过的代码骨架、统计学口径与工作流沉淀为标准化 SKILL.md 协议，供所有课题复用', 'Package verified methods, statistical checks, and code templates into a reusable SKILL.md protocol')}
      size="lg"
      onClose={onClose}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading ? (
        <Loading label={L('正在从对话与已验证代码提炼科研协议…', 'Distilling reproducible workflow protocol from this session…')} />
      ) : (
        <form className="form-stack" onSubmit={(e) => void handleSave(e)}>
          <div className="form-grid">
            <label>
              {L('Skill 标识名（英文短横线）', 'Skill Slug (kebab-case)')}
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="egfr-deg-volcano-sop" required />
            </label>
            <label>
              {L('学科领域', 'Scientific Domain')}
              <select value={domain} onChange={(e) => setDomain(e.target.value as SpecialistDomain)}>
                {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>

          <label>
            {L('协议标题', 'Protocol Title')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>

          <label>
            {L('一句话摘要', 'Short Description')}
            <input value={description} onChange={(e) => setDescription(e.target.value)} required />
          </label>

          <div className="form-grid">
            <label>
              {L('关键词标签（逗号分隔）', 'Tags (comma-separated)')}
              <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="rnaseq, bh-fdr, volcano" />
            </label>
            <label>
              {L('推荐连接器（逗号分隔）', 'Recommended Connectors')}
              <input value={connectorsText} onChange={(e) => setConnectorsText(e.target.value)} placeholder="pubmed, openalex, clinicaltrials" />
            </label>
          </div>

          <label>
            {L('标准协议正文（SKILL.md 指令与可复用代码规范）', 'Protocol Instructions (SKILL.md Markdown)')}
            <textarea
              rows={11}
              className="manuscript-editor"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              required
            />
          </label>

          {activeProjectId && (
            <label className="checkbox-row">
              <input type="checkbox" checked={attachToProject} onChange={(e) => setAttachToProject(e.target.checked)} />
              <span>
                <strong>{L(`同时绑定为项目「${activeProjectName ?? '当前项目'}」的默认协议`, `Also attach as default protocol for "${activeProjectName ?? 'Active Project'}"`)}</strong>
              </span>
            </label>
          )}

          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>{L('取消', 'Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <Loading label={L('保存中…', 'Saving…')} /> : <><CheckCircle2 size={14} /><Sparkles size={13} />{L('保存为可复用 Skill', 'Save Reusable Skill')}</>}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
