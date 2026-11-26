import { useState, type FormEvent } from 'react';
import { BookOpen, ChevronDown, FolderOpen, Palette, Server, Sparkles } from 'lucide-react';
import type { ComputeTarget, ResearchProject } from '@scideveloper/shared';
import type { CatalogSkill } from '../api';
import { useI18n } from '../i18n';
import { ErrorNote, Modal } from './ui';

const projectColors = [
  { id: 'teal', hex: '#0f766e', zh: '青绿', en: 'Teal' },
  { id: 'blue', hex: '#0284c7', zh: '海蓝', en: 'Ocean' },
  { id: 'purple', hex: '#6d28d9', zh: '紫罗兰', en: 'Violet' },
  { id: 'amber', hex: '#d97706', zh: '琥珀', en: 'Amber' },
  { id: 'rose', hex: '#e11d48', zh: '玫红', en: 'Rose' },
  { id: 'emerald', hex: '#059669', zh: '翡翠', en: 'Emerald' },
];

export interface ProjectFormValues {
  name: string;
  description: string;
  instructions: string;
  workspacePath?: string;
  defaultComputeTargetId: string;
  defaultSkills: string[];
  color: string;
}

export default function ProjectModal({
  existing,
  targets,
  catalog,
  defaultWorkspace,
  onSubmit,
  onClose,
}: {
  existing?: ResearchProject;
  targets: ComputeTarget[];
  catalog: CatalogSkill[];
  defaultWorkspace?: string;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const { locale, t, L } = useI18n();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [workspacePath, setWorkspacePath] = useState(existing?.workspacePath ?? defaultWorkspace ?? '');
  const [computeTargetId, setComputeTargetId] = useState(existing?.defaultComputeTargetId ?? targets[0]?.id ?? 'local-sandbox');
  const [selectedSkills, setSelectedSkills] = useState<string[]>(existing?.defaultSkills ?? []);
  const [color, setColor] = useState(existing?.color ?? 'teal');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const desktopBridge = (window as unknown as { scideveloper?: { selectWorkspace?: () => Promise<string | null> } }).scideveloper;

  function toggleSkill(skillName: string) {
    setSelectedSkills((prev) =>
      prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName],
    );
  }

  async function pickFolder() {
    if (!desktopBridge?.selectWorkspace) return;
    const chosen = await desktopBridge.selectWorkspace();
    if (chosen) setWorkspacePath(chosen);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        workspacePath: workspacePath.trim() || undefined,
        defaultComputeTargetId: computeTargetId,
        defaultSkills: selectedSkills,
        color,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={existing ? t('editProject') : t('newProject')}
      subtitle={t('projectModalSubtitle')}
      size="lg"
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={(e) => void handleSubmit(e)}>
        {error && <ErrorNote>{error}</ErrorNote>}

        <label>
          {t('projectName')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={L('例如：EGFR 肺癌耐药机制研究', 'e.g. EGFR NSCLC Resistance Mechanisms')}
            required
            autoFocus
          />
        </label>

        <label>
          {t('projectDescription')}
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={L('简要描述研究目标、样本队列或课题背景（可选）', 'Brief research goal, cohort, or aim (optional)')}
          />
        </label>

        <div className="form-field">
          <span className="field-label"><Palette size={13} />{t('projectColor')}</span>
          <div className="color-swatches">
            {projectColors.map((c) => (
              <button
                key={c.id}
                type="button"
                className={'color-swatch' + (color === c.id ? ' selected' : '')}
                style={{ ['--swatch' as string]: c.hex }}
                onClick={() => setColor(c.id)}
                title={locale === 'zh' ? c.zh : c.en}
                aria-label={locale === 'zh' ? c.zh : c.en}
              />
            ))}
          </div>
        </div>

        <label>
          <span className="field-label"><Sparkles size={13} />{t('projectInstructions')}</span>
          <span className="field-help">
            {L('项目内所有对话都会自动遵循这里的设定（如参考基因组版本、统计显著性阈值或绘图风格）。', 'Injected automatically into every chat in this project (e.g., reference genome, FDR cutoffs, plotting style).')}
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            placeholder={L('例如：默认使用 GRCh38 参考基因组，显著性阈值 FDR < 0.05，绘图使用色盲友好配色…', 'e.g. Use GRCh38 reference genome, FDR < 0.05 threshold, colorblind-safe palettes…')}
          />
        </label>

        <details className="subtle-details">
          <summary><ChevronDown size={14} />{L('更多选项（数据目录、计算环境与默认协议）', 'More options (workspace folder, compute & protocols)')}</summary>
          <div className="stack mt-3">
            <div className="form-grid">
              <label>
                <span className="field-label"><FolderOpen size={13} />{t('projectWorkspace')}</span>
                <div className="input-action-row">
                  <input
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder={L('留空则使用默认工作区', 'Leave blank for default workspace')}
                  />
                  {desktopBridge?.selectWorkspace && (
                    <button type="button" className="btn" onClick={() => void pickFolder()}>
                      {L('浏览', 'Browse')}
                    </button>
                  )}
                </div>
              </label>

              <label>
                <span className="field-label"><Server size={13} />{t('projectCompute')}</span>
                <select value={computeTargetId} onChange={(e) => setComputeTargetId(e.target.value)}>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>{target.name}</option>
                  ))}
                </select>
              </label>
            </div>

            {catalog.length > 0 && (
              <div className="stack">
                <span className="field-label"><BookOpen size={13} />{t('projectDefaultSkills')} ({selectedSkills.length})</span>
                <div className="pill-strip" style={{ paddingBottom: 0 }}>
                  {catalog.map((sk) => {
                    const active = selectedSkills.includes(sk.name);
                    return (
                      <button
                        key={sk.name}
                        type="button"
                        className={'tab-pill' + (active ? ' selected' : '')}
                        onClick={() => toggleSkill(sk.name)}
                        title={sk.description}
                      >
                        <span className="truncate">{sk.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </details>

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>{L('取消', 'Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {saving ? L('保存中…', 'Saving…') : existing ? t('saveProject') : t('createProject')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
