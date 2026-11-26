import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NotebookCell, NotebookCellOutput, NotebookDocument, ScientificArtifact } from '@scideveloper/shared';
import { OrchestratorError } from './orchestrator-error.js';

export type NotebookWriteInput = { title?: string; cells: NotebookCell[] };
export type NotebookImportInput = { filename: string; content: string; isBase64?: boolean };
export type NotebookCellOverride = { source?: string; language?: 'python' | 'r' };

const cellIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number => isNumber(value) && Number.isSafeInteger(value);
const isCount = (value: unknown): value is number => isInteger(value) && value >= 0;

function uniqueCellId(value: unknown, used: Set<string>): string {
  let id = isString(value) && cellIdPattern.test(value) ? value : randomUUID();
  while (used.has(id)) id = randomUUID();
  used.add(id);
  return id;
}

function sanitizeOutput(value: unknown): NotebookCellOutput | undefined {
  if (!isObject(value)) return undefined;
  const { stdout, stderr, exitCode, durationMs, artifactIds, imagesBase64, executedAt } = value;
  return {
    stdout: isString(stdout) ? stdout : undefined,
    stderr: isString(stderr) ? stderr : undefined,
    exitCode: isInteger(exitCode) ? exitCode : undefined,
    durationMs: isNumber(durationMs) && durationMs >= 0 ? durationMs : undefined,
    artifactIds: Array.isArray(artifactIds) ? [...new Set(artifactIds.filter(isString))] : undefined,
    imagesBase64: Array.isArray(imagesBase64) ? imagesBase64.flatMap((image: unknown) => {
      if (!isObject(image) || !isString(image.mimeType) || !isString(image.data)) return [];
      return [{ mimeType: image.mimeType, data: image.data, title: isString(image.title) ? image.title : undefined }];
    }) : undefined,
    executedAt: isString(executedAt) ? executedAt : undefined,
  };
}

export function sanitizeNotebookCells(cells: unknown): NotebookCell[] {
  if (!Array.isArray(cells)) throw new OrchestratorError(400, 'Notebook cells must be an array');
  const used = new Set<string>();
  return cells.map((cell: unknown, index) => {
    if (!isObject(cell) || (cell.kind !== 'markdown' && cell.kind !== 'code') || !isString(cell.source) ||
        (cell.kind === 'code' && cell.language !== 'python' && cell.language !== 'r')) {
      throw new OrchestratorError(400, `Invalid notebook cell at index ${index}`);
    }
    const code = cell.kind === 'code';
    return {
      id: uniqueCellId(cell.id, used),
      kind: cell.kind,
      language: code ? cell.language as 'python' | 'r' : 'markdown',
      source: cell.source,
      title: isString(cell.title) ? cell.title.trim() || undefined : undefined,
      sourceNodeId: isString(cell.sourceNodeId) ? cell.sourceNodeId : undefined,
      sourceArtifactId: code && isString(cell.sourceArtifactId) ? cell.sourceArtifactId : undefined,
      editedByResearcher: typeof cell.editedByResearcher === 'boolean' ? cell.editedByResearcher : undefined,
      executionCount: code ? isCount(cell.executionCount) ? cell.executionCount : null : undefined,
      output: code ? sanitizeOutput(cell.output) : undefined,
    };
  });
}

function invalidNotebook(detail: string): never {
  throw new OrchestratorError(400, 'Invalid Jupyter notebook: ' + detail);
}

function multiline(value: unknown, field: string): string {
  if (isString(value)) return value;
  if (Array.isArray(value) && value.every(isString)) return value.join('');
  return invalidNotebook(field + ' must be a string or array of strings');
}

function jupyterLanguage(...values: unknown[]): 'python' | 'r' | undefined {
  for (const value of values) {
    if (!isString(value)) continue;
    const name = value.trim().toLowerCase();
    if (['r', 'ir', 'irkernel'].includes(name)) return 'r';
    if (name.startsWith('python') || name === 'ipython') return 'python';
  }
}

function ipynbOutputs(value: unknown): NotebookCellOutput | undefined {
  if (!Array.isArray(value)) return invalidNotebook('code outputs must be an array');
  const output: NotebookCellOutput = {};
  for (const record of value) {
    if (!isObject(record)) return invalidNotebook('output must be an object');
    switch (record.output_type) {
      case 'stream': {
        const { name } = record;
        if (name !== 'stdout' && name !== 'stderr') return invalidNotebook('invalid stream name');
        output[name] = (output[name] ?? '') + multiline(record.text, 'stream text');
        break;
      }
      case 'execute_result':
      case 'display_data': {
        if (!isObject(record.data) || !isObject(record.metadata)) return invalidNotebook('invalid display output');
        const png = record.data['image/png'];
        if (png !== undefined) {
          const title = record.metadata.title;
          (output.imagesBase64 ??= []).push({
            mimeType: 'image/png', data: multiline(png, 'image/png').replace(/\s+/g, ''),
            title: isString(title) ? title : undefined,
          });
        }
        break;
      }
      case 'error': {
        if (!isString(record.ename) || !isString(record.evalue) ||
            !Array.isArray(record.traceback) || !record.traceback.every(isString)) {
          return invalidNotebook('invalid error output');
        }
        const detail = record.traceback.join('\n') || `${record.ename}: ${record.evalue}`;
        output.stderr = [output.stderr, detail].filter(Boolean).join('\n');
        output.exitCode = 1;
        break;
      }
      default:
        return invalidNotebook('unknown output type');
    }
  }
  return Object.keys(output).length ? output : undefined;
}

export function parseNotebookIpynb(input: NotebookImportInput): NotebookWriteInput {
  let doc: unknown;
  try {
    const content = input.isBase64 ? Buffer.from(input.content, 'base64').toString('utf8') : input.content;
    doc = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return invalidNotebook('malformed JSON');
  }
  if (!isObject(doc) || doc.nbformat !== 4 || !isCount(doc.nbformat_minor) ||
      !Array.isArray(doc.cells) || !isObject(doc.metadata)) {
    return invalidNotebook('expected nbformat 4, notebook metadata, and a cells array');
  }
  const { kernelspec, language_info: languageInfo, title } = doc.metadata;
  const kernel = isObject(kernelspec) ? kernelspec : {};
  const notebookLanguage = jupyterLanguage(kernel.language, kernel.name, isObject(languageInfo) ? languageInfo.name : undefined);
  const used = new Set<string>();
  const cells = doc.cells.flatMap((record: unknown): NotebookCell[] => {
    if (!isObject(record) || !isObject(record.metadata)) return invalidNotebook('invalid cell metadata');
    const source = multiline(record.source, 'cell source');
    if (record.cell_type === 'raw') return [];
    if (record.cell_type !== 'code' && record.cell_type !== 'markdown') return invalidNotebook('unknown cell type');
    const id = uniqueCellId(record.id, used);
    const cellTitle = isString(record.metadata.title) ? record.metadata.title : undefined;
    if (record.cell_type === 'markdown') return [{ id, kind: 'markdown', language: 'markdown', title: cellTitle, source }];
    const count = record.execution_count;
    if (count !== undefined && count !== null && !isCount(count)) return invalidNotebook('invalid execution count');
    const vscode = isObject(record.metadata.vscode) ? record.metadata.vscode : {};
    const cellLanguage = isObject(record.metadata.language_info) ? record.metadata.language_info.name : undefined;
    const language = jupyterLanguage(record.metadata.language, cellLanguage, vscode.languageId) ?? notebookLanguage ?? 'python';
    const output = ipynbOutputs(record.outputs);
    return [{ id, kind: 'code', language, title: cellTitle, source, executionCount: count ?? null, output }];
  });
  const basename = path.win32.basename(input.filename).replace(/\.ipynb$/i, '');
  return { title: (isString(title) && title.trim()) || basename, cells };
}

export function readNotebookPngs(artifacts: ScientificArtifact[]): NonNullable<NotebookCellOutput['imagesBase64']> {
  return artifacts.flatMap(({ type, mimeType, filePath, title }) => {
    if (type !== 'figure' || mimeType !== 'image/png') return [];
    try {
      return [{ mimeType, data: readFileSync(filePath).toString('base64'), title }];
    } catch {
      return [];
    }
  });
}

export function exportNotebookIpynb(doc: NotebookDocument, artifacts: ScientificArtifact[]): { filename: string; content: string } {
  const r = doc.cells.find((cell) => cell.kind === 'code')?.language === 'r';
  const kernel = r ? { name: 'ir', display_name: 'R', language: 'r' }
    : { name: 'python3', display_name: 'Python 3', language: 'python' };
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const used = new Set<string>();
  const cells = doc.cells.map((cell) => {
    const title = cell.title ? { title: cell.title } : {};
    const base = { id: uniqueCellId(cell.id, used), source: cell.source };
    if (cell.kind === 'markdown') return { ...base, cell_type: 'markdown', metadata: title };
    const { stdout, stderr, imagesBase64 = [], artifactIds } = cell.output ?? {};
    const outputs: Record<string, unknown>[] = [];
    if (stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: stdout });
    if (stderr) outputs.push({ output_type: 'stream', name: 'stderr', text: stderr });
    const pngs = imagesBase64.filter(({ mimeType }) => mimeType === 'image/png');
    const embedded = new Set(pngs.map(({ data }) => data));
    const linked = [...new Set(artifactIds ?? [cell.sourceArtifactId])].flatMap((id) => {
      const artifact = id && byId.get(id);
      return artifact ? [artifact] : [];
    });
    for (const { data, title } of [...pngs, ...readNotebookPngs(linked).filter(({ data }) => !embedded.has(data))]) {
      outputs.push({ output_type: 'display_data', data: { 'image/png': data }, metadata: title ? { title } : {} });
    }
    return {
      ...base, cell_type: 'code', metadata: { ...title, language: cell.language },
      execution_count: isCount(cell.executionCount) ? cell.executionCount : null, outputs,
    };
  });
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
  return {
    filename: (slug || 'notebook') + '.ipynb',
    content: JSON.stringify({
      nbformat: 4, nbformat_minor: 5,
      metadata: { title: doc.title, kernelspec: kernel, language_info: { name: kernel.language } }, cells,
    }, null, 2) + '\n',
  };
}
