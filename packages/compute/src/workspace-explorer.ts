import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { WorkspaceFileEntry, WorkspaceFilePreview } from '@scideveloper/shared';
import type { PermissionGate } from './permission-gate.js';

const excludedDirectories = new Set(['node_modules', '.git', 'dist', '.scideveloper', '__pycache__']);
const previewLimit = 64 * 1024;
const inspectorScript = fileURLToPath(new URL('../python/file_inspector.py', import.meta.url));
const runFile = promisify(execFile);
const scientificFormats = new Map<string, WorkspaceFilePreview['format']>([
  ['xlsx', 'xlsx'], ['pdf', 'pdf'], ['vcf', 'vcf'], ['sdf', 'sdf'],
  ['mol2', 'sdf'], ['h5ad', 'h5ad'], ['parquet', 'parquet'],
]);

type ScientificPreview = Pick<WorkspaceFilePreview, 'previewText' | 'headers' | 'rows' | 'sheets' | 'pageCount' | 'structuredMetadata'>;

export interface PdfPages {
  pageCount: number;
  title?: string;
  pages: Array<{ page: number; text: string }>;
}

export async function extractPdfPages(absolutePdfPath: string): Promise<PdfPages> {
  if (!path.isAbsolute(absolutePdfPath)) throw new Error('Expected an absolute PDF path');
  if (!(await fs.stat(absolutePdfPath)).isFile()) throw new Error('Expected a regular PDF file');
  const { stdout } = await runFile(process.env.SCIDEV_PYTHON_BIN ?? 'python', ['-B', inspectorScript, 'pdf-pages', absolutePdfPath], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout) as PdfPages;
}

async function inspectScientificFile(kind: string, file: string, maxBytes: number): Promise<ScientificPreview> {
  try {
    const { stdout } = await runFile(process.env.SCIDEV_PYTHON_BIN ?? 'python', ['-B', inspectorScript, kind, file], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const preview = JSON.parse(stdout) as ScientificPreview;
    const bytes = Buffer.from(preview.previewText);
    if (bytes.length > maxBytes) {
      preview.previewText = new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
    }
    return preview;
  } catch {
    return { previewText: '', structuredMetadata: { detail: `The Python file inspector could not preview this ${kind} file.` } };
  }
}

function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path is outside the workspace: ' + target);
  }
}

function resolveWorkspacePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      (process.platform === 'win32' && relative.includes(':'))) {
    throw new Error('Expected a relative workspace path: ' + relative);
  }
  const target = path.resolve(root, relative);
  assertWithin(root, target);
  return target;
}

function toRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function toEntry(root: string, file: string, stat: Stats): WorkspaceFileEntry {
  return {
    name: path.basename(file),
    relativePath: toRelative(root, file),
    absolutePath: file,
    kind: stat.isDirectory() ? 'directory' : 'file',
    sizeBytes: stat.isDirectory() ? 0 : stat.size,
    extension: stat.isDirectory() ? '' : path.extname(file).slice(1).toLowerCase(),
    modifiedAt: stat.mtime.toISOString(),
  };
}

function parseDelimited(text: string, delimiter: string, truncated: boolean): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      records.push([...row, field]);
      if (records.length === 31) return records;
      if (char === '\r' && text[index + 1] === '\n') index++;
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (!truncated && !quoted && text.length && !/[\r\n]$/.test(text)) records.push([...row, field]);
  return records;
}

function detectFormat(file: string, text: string, truncated: boolean): WorkspaceFilePreview['format'] {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.tsv') return 'tsv';
  if (extension === '.json') return 'json';
  if (['.pdb', '.ent'].includes(extension) || /^(?:ATOM  |HETATM|HEADER {4})/m.test(text)) return 'pdb';
  if (['.fa', '.fas', '.fasta', '.fna', '.faa', '.ffn', '.frn'].includes(extension) ||
      /^>[^\r\n]+\r?\n[A-Z*.-]{4,}[\r\n]*$/m.test(text)) return 'fasta';
  if (['.md', '.markdown', '.mdown'].includes(extension)) return 'markdown';
  if (!truncated && /^\s*[\[{]/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // Free text can start with a bracket.
    }
  }
  return 'text';
}

function sanitizeFilename(filename: string): string {
  const name = path.win32.basename(filename)
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .trim()
    .replace(/\.+$/, '')
    .trimEnd();
  if (!name) throw new Error('The upload filename is empty or invalid');
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name) ? '_' + name : name;
}

export class WorkspaceExplorer {
  constructor(private readonly permissionGate: PermissionGate) {}

  async extractPdfPages(absolutePdfPath: string, sessionId = 'local'): Promise<PdfPages> {
    if (!path.isAbsolute(absolutePdfPath)) throw new Error('Expected an absolute PDF path');
    const reason = 'Extract text from all PDF pages';
    const target = path.resolve(absolutePdfPath);
    await this.permissionGate.assertAllowed(sessionId, 'fs_read', target, reason);
    const resolved = await fs.realpath(target);
    if (resolved !== target) await this.permissionGate.assertAllowed(sessionId, 'fs_read', resolved, reason);
    return extractPdfPages(resolved);
  }

  private async authorizeRead(sessionId: string, root: string, target: string, reason: string): Promise<string> {
    await this.permissionGate.assertAllowed(sessionId, 'fs_read', target, reason);
    const [canonicalRoot, resolved] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    assertWithin(canonicalRoot, resolved);
    if (resolved !== target) {
      await this.permissionGate.assertAllowed(sessionId, 'fs_read', resolved, reason);
    }
    return resolved;
  }

  async listFiles(sessionId: string, rootDir: string, subPath = '', maxDepth = 3): Promise<WorkspaceFileEntry[]> {
    const root = path.resolve(rootDir);
    const start = resolveWorkspacePath(root, subPath);
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new RangeError('maxDepth must be a non-negative integer');
    const reason = 'List workspace files';
    const realStart = await this.authorizeRead(sessionId, root, start, reason);
    const entries: WorkspaceFileEntry[] = [];
    const visit = async (directory: string, realDirectory: string, depth: number): Promise<void> => {
      if (depth === 0) return;
      const children = await fs.readdir(realDirectory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (!child.isFile() && !child.isDirectory()) continue;
        if (child.isDirectory() && excludedDirectories.has(child.name)) continue;
        const target = path.join(directory, child.name);
        const resolved = await this.authorizeRead(sessionId, root, target, reason);
        const stat = await fs.lstat(resolved);
        if (!stat.isDirectory() && !stat.isFile()) continue;
        entries.push(toEntry(root, target, stat));
        if (stat.isDirectory()) await visit(target, resolved, depth - 1);
      }
    };
    const canonicalRoot = await fs.realpath(root);
    const startComponents = [
      ...toRelative(root, start).split('/'),
      ...toRelative(canonicalRoot, realStart).split('/'),
    ];
    if (!startComponents.some((name) => excludedDirectories.has(name))) {
      await visit(start, realStart, maxDepth);
    }
    return entries;
  }

  async previewFile(sessionId: string, rootDir: string, relativePath: string, maxBytes = previewLimit): Promise<WorkspaceFilePreview> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
    const root = path.resolve(rootDir);
    const target = resolveWorkspacePath(root, relativePath);
    const resolved = await this.authorizeRead(sessionId, root, target, 'Preview workspace file');
    if (!(await fs.lstat(resolved)).isFile()) throw new Error('Expected a regular workspace file: ' + target);
    const extension = path.extname(target).slice(1).toLowerCase();
    const scientificFormat = scientificFormats.get(extension);
    const textScientific = scientificFormat === 'vcf' || scientificFormat === 'sdf';
    const limit = Math.min(maxBytes, previewLimit);
    const file = await fs.open(resolved, 'r');
    try {
      const preview = Buffer.alloc(scientificFormat ? 0 : limit);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      let totalLines = 0;
      let lastByte = -1;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        if (sizeBytes < preview.length) chunk.copy(preview, sizeBytes);
        sizeBytes += chunk.length;
        if (scientificFormat && !textScientific) continue;
        for (let i = 0; i < chunk.length; i++) {
          const byte = chunk[i];
          if (byte === 13 || (byte === 10 && lastByte !== 13)) totalLines++;
          lastByte = byte;
        }
      }
      if (lastByte !== -1 && lastByte !== 10 && lastByte !== 13) totalLines++;
      const base = { relativePath: toRelative(root, target), absolutePath: target, sizeBytes, sha256: hash.digest('hex') };
      if (scientificFormat) {
        return {
          ...base,
          format: scientificFormat,
          ...(textScientific ? { totalLines } : {}),
          ...await inspectScientificFile(extension, resolved, limit),
        };
      }

      const truncated = sizeBytes > preview.length;
      let previewText = '';
      let format: WorkspaceFilePreview['format'] = 'binary';
      try {
        const sample = preview.subarray(0, sizeBytes);
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: truncated });
        if (!/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(decoded)) {
          previewText = decoded;
          format = detectFormat(target, decoded, truncated);
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }

      const result: WorkspaceFilePreview = {
        ...base,
        format,
        previewText,
      };
      if (format !== 'binary') result.totalLines = totalLines;
      if (format === 'csv' || format === 'tsv') {
        const [headers = [], ...rows] = parseDelimited(previewText, format === 'csv' ? ',' : '\t', truncated);
        result.headers = headers;
        result.rows = rows;
      }
      return result;
    } finally {
      await file.close();
    }
  }

  async saveUploadedFile(sessionId: string, rootDir: string, filename: string, contentBase64OrText: string, isBase64 = false): Promise<WorkspaceFileEntry> {
    const root = path.resolve(rootDir);
    const name = sanitizeFilename(filename);
    const target = resolveWorkspacePath(root, path.join('datasets', name));
    const reason = 'Save uploaded workspace dataset';
    await this.permissionGate.assertAllowed(sessionId, 'fs_write', target, reason);
    const canonicalRoot = await fs.realpath(root);
    const directory = path.join(canonicalRoot, 'datasets');
    const destination = path.join(directory, name);
    if (destination !== target) {
      await this.permissionGate.assertAllowed(sessionId, 'fs_write', destination, reason);
    }
    await fs.mkdir(directory, { recursive: true });
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Expected a workspace datasets directory: ' + directory);
    const file = await fs.open(destination, 'wx');
    try {
      try {
        await file.writeFile(contentBase64OrText, isBase64 ? 'base64' : 'utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      await fs.unlink(destination);
      throw error;
    }
    return toEntry(root, target, await fs.lstat(destination));
  }
}
