import type { EvidenceGrade, EvidenceStance, HypothesisEvidence, HypothesisStatus, ResearchMemoryCategory, SlurmJobSpec, SpecialistDomain } from '@scideveloper/shared';
import type { ToolDefinition } from './llm-client.js';

const text = { type: 'string' };
const number = { type: 'number' };
const strings = { type: 'array', items: text };
const object = { type: 'object' };
export const specialistDomains = [
  'genomics', 'single-cell', 'structural-biology', 'cheminformatics', 'statistics',
  'literature', 'manuscript', 'proteomics', 'metabolomics', 'clinical', 'custom',
] as const satisfies readonly SpecialistDomain[];

export const memoryCategories = ['convention', 'hypothesis', 'dataset', 'finding', 'preference'] as const satisfies readonly ResearchMemoryCategory[];
export const hypothesisStatuses = ['proposed', 'testing', 'supported', 'refuted', 'inconclusive'] as const satisfies readonly HypothesisStatus[];
export const evidenceStances = ['supporting', 'contradicting', 'neutral'] as const satisfies readonly EvidenceStance[];
export const evidenceGrades = ['rct', 'meta-analysis', 'cohort', 'preclinical', 'computational', 'preprint', 'other'] as const satisfies readonly EvidenceGrade[];
export const evidenceSources = ['paper', 'artifact', 'connector', 'session', 'manual'] as const satisfies readonly HypothesisEvidence['sourceType'][];

function tool(
  name: string, description: string, properties: Record<string, unknown>, required: string[] = [],
): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

export const researchTools = [
  tool('spawn_specialist', 'Delegate a focused research task to an isolated specialist. Delegate independent tasks together so they can run concurrently.', {
    domain: { ...text, enum: specialistDomains }, task: text, specialistName: text, customSpecialistId: text,
  }, ['domain', 'task']),
  tool('load_skill', 'Load the full instructions for a skill by catalog name.', { name: text }, ['name']),
  tool('list_workspace_files', 'List files within this session workspace. Omit path to start at the root.', { path: text }),
  tool('read_workspace_file', 'Read a bounded preview and obtain the SHA-256 for a relative workspace file.', { path: text }, ['path']),
  tool('run_python', 'Execute standalone scientific Python. Use SCIDEV_WORKSPACE_DIR for inputs and SCIDEV_OUTPUT_DIR for outputs. Leave Matplotlib figures open for PNG, SVG, and PDF export. Assign a dict to SCIDEV_METRICS for quantitative results and assign Plotly 2D figures to SCIDEV_PLOTLY_CHARTS to save interactive_chart artifacts. On failure, inspect stderr and retry with corrected code.', {
    code: text, title: text, methods: text,
  }, ['code']),
  tool('run_r', 'Execute standalone R when Rscript is installed. SCIDEV_WORKSPACE_DIR and SCIDEV_OUTPUT_DIR are available as R variables.', {
    code: text, title: text, methods: text,
  }, ['code']),
  tool('query_connector', 'Query a built-in scientific connector or a discovered tool on an enabled external MCP server.', {
    connectorId: text, operation: text, params: object,
  }, ['connectorId', 'operation']),
  tool('save_memory', 'Save a durable research convention, hypothesis, dataset detail, finding, or preference. Scope defaults to the active project when assigned, otherwise to the current workspace.', {
    category: { ...text, enum: memoryCategories }, title: text, content: text,
    scope: { ...text, enum: ['project', 'global', 'workspace'] }, tags: strings,
  }, ['category', 'title', 'content']),
  tool('search_memory', 'Search active-project, global, and current-workspace research memories.', { query: text }, ['query']),
  tool('search_local_papers', 'Search active-project and shared papers in the indexed local literature library. Use returned paper IDs and page numbers for traceable references.', {
    query: text, limit: { type: 'integer', minimum: 1, maximum: 25 },
  }, ['query']),
  tool('read_paper_passage', 'Read indexed passages for a local paper, optionally restricted to a one-based page number.', {
    paperId: text, page: { type: 'integer', minimum: 1 },
  }, ['paperId']),
  tool('generate_slurm_script', 'Generate an sbatch script for review without submitting it.', {
    targetId: text, jobName: text, partition: text, cpus: number, memGb: number, gpus: number,
    walltime: text, condaEnv: text, modules: strings, command: text, workingDir: text,
  }, ['targetId', 'jobName', 'partition', 'cpus', 'memGb', 'walltime', 'command']),
];

export const specialistResearchTools = researchTools.filter(({ name }) => name !== 'spawn_specialist');

export const hypothesisTools = [
  tool('record_hypothesis', 'Record a testable hypothesis on the active project board. Use an existing hypothesis ID from project context when attaching evidence to an existing hypothesis.', {
    title: text, statement: text, status: { ...text, enum: hypothesisStatuses },
    confidence: { ...number, minimum: 0, maximum: 100 }, nextExperiment: text,
  }, ['title', 'statement']),
  tool('add_hypothesis_evidence', 'Attach a traceable piece of evidence to a hypothesis on the active project board.', {
    hypothesisId: text, kind: { ...text, enum: evidenceStances }, summary: text, citation: text,
    grade: { ...text, enum: evidenceGrades }, sourceType: { ...text, enum: evidenceSources }, sourceId: text,
  }, ['hypothesisId', 'kind', 'summary']),
];

export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected a non-empty string for "${key}"`);
  return value;
}

export function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  return requiredText(args, key);
}

export function readSlurmSpec(args: Record<string, unknown>): SlurmJobSpec {
  function count(key: string, min: number, integer = true) {
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid Slurm resource "${key}"`);
    }
    return value;
  }
  const modules = args.modules;
  if (modules !== undefined && (!Array.isArray(modules) || modules.some((entry) => typeof entry !== 'string'))) {
    throw new Error('Expected an array of Slurm module names');
  }
  return {
    targetId: requiredText(args, 'targetId'), jobName: requiredText(args, 'jobName'),
    partition: requiredText(args, 'partition'), walltime: requiredText(args, 'walltime'),
    command: requiredText(args, 'command'), cpus: count('cpus', 1), memGb: count('memGb', 1, false),
    gpus: args.gpus === undefined ? undefined : count('gpus', 0),
    condaEnv: optionalText(args, 'condaEnv'), workingDir: optionalText(args, 'workingDir'), modules,
  };
}
