import type { DistilledSkillDraft, ProvenanceManifest, SessionTree, SkillMetadata, SpecialistDomain } from '@scideveloper/shared';
import { specialistDomains } from './live-tools.js';

export type DistillSkillOptions = { name?: string; title?: string; domain?: SpecialistDomain };
export type CustomSkillInput = DistilledSkillDraft & { attachToProjectId?: string };

function slug(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63).replace(/-$/, '');
}

export function buildWorkflowSkill(
  tree: SessionTree, manifests: ProvenanceManifest[], skills: SkillMetadata[], connectors: string[], options: DistillSkillOptions,
): DistilledSkillDraft {
  const { session, nodes, reviews, loadedSkills } = tree;
  const goals = nodes.filter(({ role, content }) => role === 'user' && content.trim()).map(({ content }) => content.trim());
  const title = options.title?.trim() || session.title.trim() || 'Session workflow';
  const requestedName = slug(options.name?.trim() || title);
  const name = requestedName.length >= 2 && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(requestedName)
    ? requestedName : `workflow-${session.id}`;
  const domain = options.domain ?? nodes.find(({ specialistDomain }) => specialistDomain)?.specialistDomain ?? skills[0]?.domain ?? 'custom';
  const checks = [...new Set(reviews.flatMap(({ findings }) => findings.filter(({ category }) => category === 'statistical_rigor')
    .map(({ severity, title, detail }) => `- [${severity}] ${title}: ${detail}`)))];
  const verified = new Map<string, ProvenanceManifest>();
  for (const manifest of manifests) {
    const { language, exitCode, codeSha256 } = manifest.executionCode;
    if ((language === 'python' || language === 'r') && exitCode === 0) {
      verified.set(`${language}:${codeSha256}`, manifest);
    }
  }
  const methods = [...verified.values()].map(({ executionCode, plainLanguageSummary, artifactId }, index) => {
    let fenceLength = 3;
    for (const [run] of executionCode.code.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run.length + 1);
    const fence = '`'.repeat(fenceLength);
    return [`### Step ${index + 1}`, plainLanguageSummary, `Source artifact: ${artifactId}`, '',
      fence + executionCode.language, executionCode.code, fence].join('\n');
  });
  return {
    name, title, domain, sourceSessionId: session.id,
    description: goals[0]?.replace(/\s+/g, ' ').slice(0, 300) || `Reproduce the workflow from ${session.title}.`,
    tags: [...new Set([domain, ...skills.flatMap(({ tags }) => tags)])],
    recommendedConnectors: connectors,
    instructions: [
      '## Research goals', ...(goals.length ? goals.map((goal) => '- ' + goal) : [`- Revisit the goals for ${session.title}.`]),
      '', '## Workflow', 'Resolve workspace paths and inputs for the new study before reusing recorded steps.',
      ...(methods.length ? methods.map((method) => '\n' + method) : ['No successful Python or R artifact execution was recorded.']),
      '', '## Statistical checks',
      ...(checks.length ? checks : ['- Verify sample sizes, assumptions, uncertainty, and the match between computed results and reported claims.']),
      '', '## Loaded skills', ...(loadedSkills.length ? loadedSkills.map((skill) => '- ' + skill) : ['- None recorded.']),
      '', '## Connectors used', ...(connectors.length ? connectors.map((connector) => '- ' + connector) : ['- None recorded.']),
    ].join('\n'),
  };
}

export function refineWorkflowSkill(draft: DistilledSkillDraft, json: string): DistilledSkillDraft {
  const value = JSON.parse(json);
  if (typeof value?.description !== 'string' || !value.description.trim() ||
      !Array.isArray(value.tags) || !value.tags.every((tag: unknown) => typeof tag === 'string' && tag.trim()) ||
      typeof value.guidance !== 'string' || !value.guidance.trim()) return draft;
  return {
    ...draft, description: value.description.trim(), tags: [...new Set([...draft.tags, ...value.tags.map((tag: string) => tag.trim())])],
    instructions: draft.instructions + '\n\n## Reuse guidance\n' + value.guidance.trim(),
  };
}

export function isSkillDraft(draft: DistilledSkillDraft): boolean {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  return draft && text(draft.name) && text(draft.title) && text(draft.description) && text(draft.instructions) &&
    specialistDomains.includes(draft.domain) && Array.isArray(draft.tags) && draft.tags.every(text) &&
    Array.isArray(draft.recommendedConnectors) && draft.recommendedConnectors.every(text);
}
