import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DistilledSkillDraft, SkillDocument, SkillMetadata, SpecialistDomain } from '@scideveloper/shared';

const domains = new Set<string>([
  'genomics', 'single-cell', 'structural-biology', 'cheminformatics',
  'statistics', 'literature', 'manuscript', 'proteomics', 'metabolomics', 'clinical', 'custom',
] satisfies SpecialistDomain[]);

const scriptLanguages = new Map([
  ['.py', 'python'], ['.r', 'r'], ['.sh', 'bash'], ['.bash', 'bash'],
  ['.slurm', 'slurm'], ['.js', 'javascript'], ['.mjs', 'javascript'],
  ['.ts', 'typescript'], ['.ps1', 'powershell'],
]);

const delimiter = /^---[ \t]*\r?$/;
const quotedString = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/;
const yamlEscapes = new Map([
  ['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['\t', '\t'],
  ['n', '\n'], ['v', '\v'], ['f', '\f'], ['r', '\r'], ['e', '\x1b'],
  [' ', ' '], ['"', '"'], ['/', '/'], ['\\', '\\'],
  ['N', '\x85'], ['_', '\u00a0'], ['L', '\u2028'], ['P', '\u2029'],
]);

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readFrontmatter(filePath: string, includeInstructions = false) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const decoder = new StringDecoder('utf8');
    const header: string[] = [];
    let pending = '';
    let opened = false;
    let closed = false;
    let size: number;

    do {
      size = readSync(fd, buffer);
      pending += size ? decoder.write(buffer.subarray(0, size)) : decoder.end();
      while (!closed) {
        const newline = pending.indexOf('\n');
        if (newline === -1 && (size || !pending)) break;
        const line = pending.slice(0, newline === -1 ? undefined : newline);
        pending = newline === -1 ? '' : pending.slice(newline + 1);

        if (!opened) {
          if (!delimiter.test(line.replace(/^\uFEFF/, ''))) {
            throw new Error('Expected opening frontmatter delimiter');
          }
          opened = true;
        } else if (delimiter.test(line)) {
          closed = true;
          if (!includeInstructions) return { header, instructions: '' };
        } else {
          header.push(line);
        }
      }
    } while (size);

    if (!closed) throw new Error('Expected closing frontmatter delimiter');
    return { header, instructions: pending.trim() };
  } finally {
    closeSync(fd);
  }
}

function parseScalar(source: string): string {
  const value = source.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quoted = value.match(quotedString)?.[0];
    if (!quoted || !/^(?:[ \t]+#.*)?$/.test(value.slice(quoted.length))) {
      throw new Error('Invalid quoted frontmatter string');
    }
    const content = quoted.slice(1, -1);
    if (quoted.startsWith("'")) return content.replace(/''/g, "'");
    return content.replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/g, (_, escape: string) => {
      if (escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      const decoded = yamlEscapes.get(escape);
      if (decoded === undefined) throw new Error('Unknown escape in double-quoted frontmatter string');
      return decoded;
    });
  }

  const plain = value.replace(/(^|[ \t]+)#.*$/, '').trimEnd();
  if (!plain || /^[\[\]{}|>&*!]/.test(plain) || /:(?:\s|$)/.test(plain)) {
    throw new Error('Expected a frontmatter string');
  }
  return plain;
}

function parseInlineArray(source: string): string[] {
  const values: string[] = [];
  let remaining = source.slice(1).trimStart();
  while (!remaining.startsWith(']')) {
    const item = remaining.startsWith('"') || remaining.startsWith("'")
      ? remaining.match(quotedString)?.[0]
      : remaining.match(/^[^,\]]+/)?.[0];
    if (!item) throw new Error('Expected a string in inline frontmatter array');
    values.push(parseScalar(item));
    remaining = remaining.slice(item.length).trimStart();
    if (remaining.startsWith(',')) {
      remaining = remaining.slice(1).trimStart();
    } else if (!remaining.startsWith(']')) {
      throw new Error('Expected comma or closing bracket in inline frontmatter array');
    }
  }
  if (!/^\][ \t]*(?:[ \t]#.*)?$/.test(remaining)) {
    throw new Error('Unexpected content after inline frontmatter array');
  }
  return values;
}

function parseHeader(header: string[]): Map<string, string | string[] | null> {
  const fields = new Map<string, string | string[] | null>();
  let block: { key: string; items: string[]; indent?: string } | undefined;
  for (const rawLine of header) {
    const line = rawLine.trimEnd();
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    const item = line.match(/^( *)-[ \t]+(.+)$/);
    if (item && block) {
      if (block.indent !== undefined && block.indent !== item[1]) {
        throw new Error('Inconsistent indentation in block frontmatter array');
      }
      block.indent = item[1];
      block.items.push(parseScalar(item[2]));
      fields.set(block.key, block.items);
      continue;
    }

    const field = line.match(/^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/);
    if (!field) throw new Error('Expected a frontmatter key and value');
    const [, key, value = ''] = field;
    if (fields.has(key)) throw new Error('Duplicate frontmatter key: ' + key);
    block = undefined;
    if (!value || value.startsWith('#')) {
      block = { key, items: [] };
      fields.set(key, null);
    } else {
      fields.set(key, value.startsWith('[') ? parseInlineArray(value) : parseScalar(value));
    }
  }
  return fields;
}

function* discoverScripts(directory: string, prefix = ''): IterableIterator<SkillDocument['scripts'][number]> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      yield* discoverScripts(path, name + '/');
    } else if (entry.isFile()) {
      const extension = extname(entry.name).toLowerCase();
      yield { name, path, language: scriptLanguages.get(extension) ?? (extension.slice(1) || 'text') };
    }
  }
}

function parseMetadata(filePath: string, header: string[]) {
  const fields = parseHeader(header);
  const requiredString = (key: string): string => {
    const value = fields.get(key);
    if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty string for ' + key);
    return value;
  };
  const requiredArray = (key: string): string[] => {
    const value = fields.get(key);
    if (!Array.isArray(value) || value.some(item => !item.trim())) {
      throw new Error('Expected a string array for ' + key);
    }
    return value;
  };

  const name = requiredString('name');
  const skillDir = dirname(filePath);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || basename(skillDir) !== name) {
    throw new Error('Skill name must be kebab-case and match its directory');
  }
  const domain = requiredString('domain');
  if (!domains.has(domain)) throw new Error('Unknown specialist domain: ' + domain);

  return {
    name,
    title: requiredString('title'),
    description: requiredString('description'),
    domain: domain as SpecialistDomain,
    tags: requiredArray('tags'),
    recommendedConnectors: requiredArray('recommendedConnectors'),
    filePath,
  };
}

function scanSkills(root: string, isCustom: boolean, catalog: Map<string, SkillMetadata>): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const filePath = join(root, entry.name, 'SKILL.md');
    try {
      if (isCustom && !lstatSync(filePath).isFile()) continue;
      const skill = parseMetadata(filePath, readFrontmatter(filePath).header);
      const hasScripts = !discoverScripts(join(dirname(filePath), 'scripts')).next().done;
      catalog.set(skill.name, { ...skill, hasScripts, isCustom });
    } catch (error) {
      if (isMissing(error)) continue;
      throw new Error('Could not load skill metadata from ' + filePath, { cause: error });
    }
  }
}

function realPathOrMissing(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
}

const customSlug = /^[a-z0-9][a-z0-9-]{1,62}$/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function sanitizeSkillName(name: string): string {
  const slug = name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 63).replace(/-$/, '');
  if (!customSlug.test(slug) || reservedWindowsName.test(slug)) {
    throw new Error('Custom skill name must produce a safe kebab-case slug of 2 to 63 characters');
  }
  return slug;
}

function customSkillHeader(name: string, draft: DistilledSkillDraft): string[] {
  // JSON strings and flow arrays are YAML-compatible. Escape YAML's Unicode line breaks.
  const serialize = (value: string | string[]) => JSON.stringify(value)
    .replace(/[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return [
    'name: ' + serialize(name),
    'title: ' + serialize(draft.title),
    'description: ' + serialize(draft.description),
    'domain: ' + serialize(draft.domain),
    'tags: ' + serialize(draft.tags),
    'recommendedConnectors: ' + serialize(draft.recommendedConnectors),
  ];
}

function copyMetadata(skill: SkillMetadata): SkillMetadata {
  return { ...skill, tags: [...skill.tags], recommendedConnectors: [...skill.recommendedConnectors] };
}

function tokenize(text: string): Set<string> {
  return new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export class SkillRegistry {
  private readonly root: string;
  private readonly customRoot?: string;
  private catalog = new Map<string, SkillMetadata>();

  constructor(skillsDir: string, customSkillsDir?: string) {
    this.root = resolve(skillsDir);
    this.customRoot = customSkillsDir === undefined ? undefined : resolve(customSkillsDir);
    this.reload();
  }

  reload(): void {
    const catalog = new Map<string, SkillMetadata>();
    scanSkills(this.root, false, catalog);
    if (this.customRoot && !this.sharesBuiltInRoot(this.customRoot)) {
      scanSkills(this.customRoot, true, catalog);
    }
    this.catalog = catalog;
  }

  private sharesBuiltInRoot(customRoot: string): boolean {
    return relative(realPathOrMissing(this.root), realPathOrMissing(customRoot)) === '';
  }

  private customSkillDirectory(name: string, customRoot: string): string {
    const root = realPathOrMissing(customRoot);
    const builtInRoot = realPathOrMissing(this.root);
    const directory = join(root, name);
    const builtIns = relative(directory, builtInRoot);
    if (relative(root, builtInRoot) === '' ||
        (builtIns !== '..' && !builtIns.startsWith('..' + sep) && !isAbsolute(builtIns))) {
      throw new Error('Custom skill directory overlaps the built-in skills directory');
    }

    try {
      if (!lstatSync(directory).isDirectory()) throw new Error('Expected a regular custom skill directory');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return directory;
  }

  saveCustomSkill(draft: DistilledSkillDraft): SkillDocument {
    if (!this.customRoot) throw new Error('Custom skills directory is not configured');
    const slug = sanitizeSkillName(draft.name);
    const directory = this.customSkillDirectory(slug, this.customRoot);
    const filePath = join(directory, 'SKILL.md');
    const header = customSkillHeader(slug, draft);
    parseMetadata(filePath, header);
    const content = ['---', ...header, '---', '', draft.instructions, ''].join('\n');

    mkdirSync(directory, { recursive: true });
    const temporaryFile = join(directory, `.SKILL-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryFile, content, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryFile, filePath);
    } finally {
      rmSync(temporaryFile, { force: true });
    }
    this.reload();
    const skill = this.loadSkill(slug);
    if (!skill?.isCustom) throw new Error('Could not load saved custom skill ' + slug);
    return skill;
  }

  deleteCustomSkill(name: string): boolean {
    if (!this.customRoot || !this.catalog.get(name)?.isCustom) return false;
    rmSync(this.customSkillDirectory(name, this.customRoot), { recursive: true, force: true });
    this.reload();
    return true;
  }

  listCatalog(): SkillMetadata[] {
    return [...this.catalog.values()].map(copyMetadata);
  }

  formatCatalogForPrompt(): string {
    return [...this.catalog.values()]
      .map(({ name, domain, description }) => '- ' + name + ' (' + domain + ') — ' + description.replace(/\s+/g, ' '))
      .join('\n');
  }

  loadSkill(name: string): SkillDocument | null {
    const skill = this.catalog.get(name);
    if (!skill) return null;

    try {
      const { instructions } = readFrontmatter(skill.filePath, true);
      const scripts = [...discoverScripts(join(dirname(skill.filePath), 'scripts'))];
      return { ...copyMetadata(skill), instructions, hasScripts: scripts.length > 0, scripts };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  matchSkills(query: string, limit = this.catalog.size): SkillMetadata[] {
    const tokens = tokenize(query);
    return [...this.catalog.values()]
      .map(skill => {
        const fields = [
          { tokens: tokenize(skill.name), weight: 5 },
          { tokens: tokenize(skill.title), weight: 4 },
          { tokens: tokenize(skill.tags.join(' ')), weight: 3 },
          { tokens: tokenize(skill.domain), weight: 2 },
          { tokens: tokenize(skill.description), weight: 1 },
        ];
        const score = [...tokens].reduce((total, token) => {
          return total + (fields.find(field => field.tokens.has(token))?.weight ?? 0);
        }, 0);
        return { skill, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, Math.max(0, limit))
      .map(({ skill }) => copyMetadata(skill));
  }
}
