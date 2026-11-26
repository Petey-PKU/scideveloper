import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DistilledSkillDraft } from '@scideveloper/shared';
import { SkillRegistry } from './index.js';

const skillsRoot = fileURLToPath(new URL('../../../skills/', import.meta.url));
const draft: DistilledSkillDraft = {
  name: 'Lab checklist',
  title: 'Lab checklist',
  description: 'Review scientific metadata.',
  domain: 'custom',
  tags: ['review'],
  recommendedConnectors: ['pubmed'],
  instructions: '## Workflow\n\n1. Review the biological annotations.',
};

describe('SkillRegistry', () => {
  it('discovers all twenty curated skills and their domains in a stable order', () => {
    const registry = new SkillRegistry(skillsRoot);
    const catalog = registry.listCatalog();
    expect(catalog.map(({ name, domain }) => [name, domain])).toEqual([
      ['alphafold-structure-eval', 'structural-biology'],
      ['cheminformatics-rdkit', 'cheminformatics'],
      ['clinical-trial-evidence', 'clinical'],
      ['clinical-variant-interpretation', 'clinical'],
      ['crispr-screen-mageck', 'genomics'],
      ['genomics-rnaseq', 'genomics'],
      ['literature-review-pubmed', 'literature'],
      ['mendelian-randomization', 'genomics'],
      ['meta-analysis-prisma', 'statistics'],
      ['metabolomics-lcms', 'metabolomics'],
      ['molecular-docking-vina', 'structural-biology'],
      ['pathway-enrichment-gsea', 'genomics'],
      ['proteomics-ms', 'proteomics'],
      ['publication-figure-polish', 'manuscript'],
      ['single-cell-qc', 'single-cell'],
      ['spatial-transcriptomics', 'single-cell'],
      ['statistical-validation', 'statistics'],
      ['structural-biology-pdb', 'structural-biology'],
      ['survival-analysis-cox', 'statistics'],
      ['survival-kaplan-meier', 'statistics'],
    ]);
    expect(catalog).toHaveLength(20);
    expect(catalog.every(skill => skill.isCustom === false)).toBe(true);
    expect(registry.formatCatalogForPrompt().split('\n')).toHaveLength(20);
    expect(registry.formatCatalogForPrompt()).toContain('- genomics-rnaseq (genomics) —');
  });

  it('exposes metadata in the catalog and only returns instructions on demand', () => {
    const registry = new SkillRegistry(skillsRoot);
    for (const metadata of registry.listCatalog()) {
      expect(metadata).not.toHaveProperty('instructions');
      expect(metadata).not.toHaveProperty('scripts');
      const document = registry.loadSkill(metadata.name);
      expect(document).toMatchObject(metadata);
      expect(document?.instructions).toMatch(/^## Workflow Steps/);
      expect(document?.instructions).toContain('## Statistical/Validation Checklist');
      expect(document?.instructions).toContain('## Expected Artifacts');
      expect(document?.instructions).toContain('## Common Pitfalls');
      expect(document?.instructions).not.toContain('recommendedConnectors:');
    }
    expect(registry.formatCatalogForPrompt()).not.toContain('Workflow Steps');
    expect(registry.loadSkill('unknown')).toBeNull();
    expect(registry.loadSkill('../genomics-rnaseq')).toBeNull();
  });

  it('discovers Python helpers and reports empty scripts for skills without them', () => {
    const registry = new SkillRegistry(skillsRoot);
    for (const [skill, script] of [
      ['genomics-rnaseq', 'deg_template.py'],
      ['pathway-enrichment-gsea', 'ora_enrichment.py'],
      ['statistical-validation', 'stats_audit.py'],
      ['survival-analysis-cox', 'kaplan_meier_template.py'],
    ]) {
      expect(registry.loadSkill(skill)).toMatchObject({
        hasScripts: true,
        scripts: [{ name: script, path: join(skillsRoot, skill, 'scripts', script), language: 'python' }],
      });
    }
    expect(registry.loadSkill('single-cell-qc')).toMatchObject({ hasScripts: false, scripts: [] });
  });

  it('reports the recommended connectors for the new protocols in catalog metadata', () => {
    const registry = new SkillRegistry(skillsRoot);
    expect(Object.fromEntries(registry.listCatalog().map(skill => [skill.name, skill.recommendedConnectors])))
      .toMatchObject({
        'alphafold-structure-eval': ['alphafold-db', 'uniprot', 'rcsb-pdb'],
        'clinical-trial-evidence': ['clinicaltrials', 'pubmed', 'openalex'],
        'clinical-variant-interpretation': ['clinvar', 'cbioportal', 'opentargets', 'pubmed'],
        'crispr-screen-mageck': ['ensembl', 'opentargets', 'pubmed'],
        'mendelian-randomization': ['opentargets', 'ensembl', 'pubmed', 'clinvar'],
        'meta-analysis-prisma': ['pubmed', 'openalex', 'biorxiv', 'clinicaltrials'],
        'metabolomics-lcms': ['kegg', 'pubchem', 'chembl'],
        'molecular-docking-vina': ['rcsb-pdb', 'pubchem', 'chembl'],
        'pathway-enrichment-gsea': ['kegg', 'reactome', 'string-db', 'geo'],
        'proteomics-ms': ['uniprot', 'string-db', 'reactome'],
        'spatial-transcriptomics': ['geo', 'ensembl', 'string', 'reactome'],
        'survival-analysis-cox': ['cbioportal', 'pubmed'],
        'survival-kaplan-meier': ['cbioportal', 'clinicaltrials', 'pubmed'],
      });
  });

  it('ranks case-insensitive token matches and honors the result limit', () => {
    const registry = new SkillRegistry(skillsRoot);
    expect(registry.matchSkills('BULK RNA-seq differential expression', 1).map(skill => skill.name))
      .toEqual(['genomics-rnaseq']);
    expect(registry.matchSkills('RDKit Tanimoto', 1)[0]?.name).toBe('cheminformatics-rdkit');
    expect(registry.matchSkills('confidence intervals', 1)[0]?.name).toBe('statistical-validation');
    expect(registry.matchSkills('mitochondrial doublets', 1)[0]?.name).toBe('single-cell-qc');
    expect(registry.matchSkills('unmatchabletoken')).toEqual([]);
    expect(registry.matchSkills('genomics', 0)).toEqual([]);
  });

  it('supports quoted strings, inline and block arrays, and refreshed discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'scideveloper-skills-'));
    try {
      const registry = new SkillRegistry(root);
      const directory = join(root, 'demo-skill');
      const filePath = join(directory, 'SKILL.md');
      const scriptPath = join(directory, 'scripts', 'nested', 'run.R');
      mkdirSync(join(directory, 'scripts', 'nested'), { recursive: true });
      writeFileSync(scriptPath, '# sample helper');
      writeFileSync(filePath, '\uFEFF' + [
        '---',
        'name: demo-skill',
        'title: "Méthode: \\"audit\\""',
        "description: 'It''s an audit # example' # comment",
        'domain: custom',
        'tags: ["sample, paired", \'unit #1\', plain] # inline comment',
        'recommendedConnectors:',
        '  - pubmed # block comment',
        '  - "ensembl"',
        '---',
        '',
        'Initial instructions.',
      ].join('\r\n'));

      expect(registry.listCatalog()).toEqual([]);
      registry.reload();
      const [metadata] = registry.listCatalog();
      expect(metadata).toMatchObject({
        name: 'demo-skill',
        title: 'Méthode: "audit"',
        description: "It's an audit # example",
        tags: ['sample, paired', 'unit #1', 'plain'],
        recommendedConnectors: ['pubmed', 'ensembl'],
        filePath,
        hasScripts: true,
      });
      expect(registry.loadSkill('demo-skill')).toMatchObject({
        instructions: 'Initial instructions.',
        scripts: [{ name: 'nested/run.R', path: scriptPath, language: 'r' }],
      });
      metadata.tags.push('mutated');
      expect(registry.listCatalog()[0].tags).not.toContain('mutated');
      rmSync(filePath);
      expect(registry.loadSkill('demo-skill')).toBeNull();
      registry.reload();
      expect(registry.listCatalog()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Custom skills', () => {
  it('loads existing custom skills after curated skills and restores a built-in when its override is deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'scideveloper-skills-'));
    try {
      const builtIn = new SkillRegistry(skillsRoot).loadSkill('genomics-rnaseq')!;
      const override = join(root, builtIn.name);
      mkdirSync(override);
      writeFileSync(join(override, 'SKILL.md'), [
        '---', 'name: genomics-rnaseq', 'title: Lab RNA-seq', 'description: Use the lab RNA-seq protocol.',
        'domain: genomics', 'tags: [rnaseq]', 'recommendedConnectors: []', '---', '', 'Run the lab protocol.', '',
      ].join('\n'));
      const registry = new SkillRegistry(skillsRoot, root);
      expect(registry.listCatalog()).toHaveLength(20);
      expect(registry.loadSkill(builtIn.name)).toMatchObject({ title: 'Lab RNA-seq', isCustom: true, instructions: 'Run the lab protocol.' });
      expect(registry.deleteCustomSkill(builtIn.name)).toBe(true);
      expect(existsSync(override)).toBe(false);
      expect(registry.loadSkill(builtIn.name)).toEqual(builtIn);
      expect(registry.deleteCustomSkill(builtIn.name)).toBe(false);
      expect(registry.deleteCustomSkill('missing')).toBe(false);
      expect(existsSync(builtIn.filePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing custom catalog, safely persists YAML and Markdown, and reloads after an update or deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'scideveloper-skills-'));
    try {
      const customDir = join(root, 'custom');
      const registry = new SkillRegistry(skillsRoot, customDir);
      const customDraft: DistilledSkillDraft = {
        ...draft,
        name: '../Lab: Quality_Review',
        title: 'Lab: "Quality Review" 🧪',
        description: "Step #1\nReview YAML, commas and quotes: 'sample'.",
        tags: ['quality, paired', 'audit #1', 'line\u2028separator'],
        recommendedConnectors: [],
        instructions: '# Review\n\n---\n\nCheck controls.\n',
        sourceSessionId: 'session-123',
      };
      const saved = registry.saveCustomSkill(customDraft);
      const slug = 'lab-quality-review';
      const filePath = join(customDir, slug, 'SKILL.md');
      expect(saved).toMatchObject({
        name: slug, title: customDraft.title, description: customDraft.description, domain: 'custom',
        tags: customDraft.tags, recommendedConnectors: [], instructions: customDraft.instructions.trim(),
        filePath, isCustom: true, hasScripts: false, scripts: [],
      });
      expect(readFileSync(filePath, 'utf8')).toContain(customDraft.instructions);
      expect(existsSync(join(root, slug))).toBe(false);
      expect(registry.listCatalog()).toHaveLength(21);
      expect(new SkillRegistry(skillsRoot, customDir).loadSkill(slug)).toEqual(saved);
      expect(registry.saveCustomSkill({ ...customDraft, instructions: 'Updated.' }).instructions).toBe('Updated.');
      expect(() => registry.saveCustomSkill({ ...customDraft, title: ' ' })).toThrow('Expected a nonempty string for title');
      expect(registry.loadSkill(slug)?.instructions).toBe('Updated.');
      expect(registry.deleteCustomSkill('../' + slug)).toBe(false);
      expect(registry.deleteCustomSkill(slug)).toBe(true);
      expect(registry.loadSkill(slug)).toBeNull();
      expect(new SkillRegistry(skillsRoot, customDir).loadSkill(slug)).toBeNull();
      expect(existsSync(join(customDir, slug))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a configured custom root and rejects unsafe slugs and linked skill directories', () => {
    const registry = new SkillRegistry(skillsRoot);
    expect(() => registry.saveCustomSkill(draft)).toThrow('Custom skills directory is not configured');
    expect(registry.deleteCustomSkill('genomics-rnaseq')).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'scideveloper-skills-'));
    try {
      const target = join(root, 'outside');
      const customDir = join(root, 'custom');
      mkdirSync(target);
      mkdirSync(customDir);
      symlinkSync(target, join(customDir, 'lab-checklist'), process.platform === 'win32' ? 'junction' : 'dir');
      const custom = new SkillRegistry(skillsRoot, customDir);
      expect(() => custom.saveCustomSkill({ ...draft, name: '../../' })).toThrow('safe kebab-case slug');
      expect(() => custom.saveCustomSkill(draft)).toThrow('Expected a regular custom skill directory');
      expect(existsSync(join(target, 'SKILL.md'))).toBe(false);
      const overlapping = new SkillRegistry(skillsRoot, skillsRoot);
      expect(overlapping.deleteCustomSkill('genomics-rnaseq')).toBe(false);
      expect(() => overlapping.saveCustomSkill(draft)).toThrow('overlaps the built-in skills directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
