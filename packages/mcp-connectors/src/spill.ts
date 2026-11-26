import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpillHandle } from '@scideveloper/shared';

export interface SpillOptions {
  spillDir: string;
  maxBytes?: number;
  maxLines?: number;
}

const formats = new Set<SpillHandle['format']>(['json', 'tsv', 'csv', 'pdb', 'fasta', 'txt']);

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

function summarizeTable(content: string, delimiter: string): string {
  // Inside quoted fields, an escaped quote leaves the quote state unchanged.
  let quoted = false;
  let records = 0;
  let headerEnd = content.length;
  let endedAtBreak = false;
  for (const match of content.matchAll(/"|\r\n|\r|\n/g)) {
    if (match[0] === '"') quoted = !quoted;
    else if (!quoted) {
      if (records === 0) headerEnd = match.index;
      records++;
      endedAtBreak = match.index + match[0].length === content.length;
    }
  }
  if (content.length && !endedAtBreak) records++;
  const headers = clip(content.slice(0, headerEnd), 320);
  return `${delimiter === ',' ? 'CSV' : 'TSV'} headers: ${headers}; ${Math.max(0, records - 1)} data rows`;
}

function summarize(format: SpillHandle['format'], content: string, lines: string[]): string {
  switch (format) {
    case 'json': {
      const value: unknown = JSON.parse(content);
      const row = Array.isArray(value) ? value[0] : value;
      const keys = row && typeof row === 'object' && !Array.isArray(row)
        ? `keys: ${clip(Object.keys(row).join(', '), 320) || '(none)'}` : '';
      if (Array.isArray(value)) return `JSON array length: ${value.length}${keys ? `; first item ${keys}` : ''}`;
      return `JSON ${keys ? `object ${keys}` : value === null ? 'null' : typeof value}`;
    }
    case 'csv': return summarizeTable(content, ',');
    case 'tsv': return summarizeTable(content, '\t');
    case 'pdb': return `PDB: ${lines.filter(line => line.startsWith('ATOM  ')).length} ATOM records, ${lines.filter(line => line.startsWith('HETATM')).length} HETATM records`;
    case 'fasta': return `FASTA: ${lines.filter(line => line.startsWith('>')).length} sequences`;
    case 'txt': return `Text: ${lines.length} lines`;
  }
}

export class SpillManager {
  private readonly spillDir: string;
  private readonly maxBytes: number;
  private readonly maxLines: number;

  constructor({ spillDir, maxBytes = 8192, maxLines = 120 }: SpillOptions) {
    this.spillDir = resolve(spillDir);
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }

  maybeSpill<T>(payload: T, format: SpillHandle['format'], label?: string): {
    spilled: boolean; data?: T; spillHandle?: SpillHandle;
  } {
    if (!formats.has(format)) throw new TypeError(`Unsupported spill format: ${format}`);
    if (format !== 'json' && typeof payload !== 'string') {
      throw new TypeError(`The ${format} spill format requires a string payload`);
    }
    const serialized = format === 'json' ? JSON.stringify(payload, null, 2) : String(payload);
    if (serialized === undefined) throw new TypeError('Payload is not JSON serializable');
    const bytes = Buffer.from(serialized, 'utf8');
    const lines = serialized ? serialized.split(/\r\n|\r|\n/) : [];
    if (lines.at(-1) === '') lines.pop();
    if (bytes.length <= this.maxBytes && lines.length <= this.maxLines) {
      return { spilled: false, data: payload };
    }

    const spillId = randomUUID();
    const filePath = resolve(this.spillDir, `${spillId}.${format}`);
    const schema = summarize(format, serialized, lines);
    const spillHandle: SpillHandle = {
      spilled: true, spillId, filePath, format,
      byteSize: bytes.length,
      lineCount: lines.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      schemaSummary: label ? `${clip(label, 100)} — ${schema}` : schema,
      previewLines: lines.slice(0, 12).map(line => clip(line, 512)),
    };
    mkdirSync(this.spillDir, { recursive: true });
    const temporaryPath = resolve(this.spillDir, `.${spillId}.tmp`);
    try {
      writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { spilled: true, spillHandle };
  }
}
