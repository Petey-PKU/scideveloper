import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ManuscriptDraft } from '@scideveloper/shared';
import { buildBibtex, plainManuscriptText } from './manuscript.js';

type ZipEntry = [name: string, data: string | Buffer];

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename, 'utf8');
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // Deflate
    header.writeUInt16LE(33, 12); // 1980-01-01 in DOS format
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4); // Same version, flags, sizes and name length
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
    centralSize += directory.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function figureEntry(filename: string, filePath: string): ZipEntry {
  if (!filename || filename === '.' || filename === '..' || /[\\/:\x00-\x1f]/.test(filename)) {
    throw new Error('Invalid figure filename');
  }
  return [`figures/${filename}`, fs.readFileSync(filePath)];
}

export function exportOverleafZip(
  manuscript: ManuscriptDraft,
  figures: Array<{ filename: string; filePath: string; latexFilename?: string; pdfPath?: string }>,
): Buffer {
  let source = manuscript.latexSource.replace('\\usepackage{graphicx}', '\\usepackage{graphicx}\n\\graphicspath{{figures/}}');
  if (manuscript.citations.some(({ verified }) => verified)) {
    source = source.replace(/\\begin\{thebibliography\}\{[^}]*\}[\s\S]*?\\end\{thebibliography\}/,
      () => '\\nocite{*}\n\\bibliographystyle{plain}\n\\bibliography{references}');
  }
  const files = figures.flatMap(({ filename, filePath, latexFilename, pdfPath }) => [
    figureEntry(filename, filePath),
    ...(pdfPath ? [figureEntry(latexFilename && /\.pdf$/i.test(latexFilename)
      ? latexFilename : path.parse(filename).name + '.pdf', pdfPath)] : []),
  ]);
  return buildZip([
    ['main.tex', source],
    ['references.bib', manuscript.bibtexSource ?? buildBibtex(manuscript.citations)],
    ['README_OVERLEAF.txt', 'Upload this ZIP as a new Overleaf project. Select main.tex as the main document and compile with pdfLaTeX. The figures directory contains the exported images and available vector PDFs.\n'],
    ...files,
  ]);
}

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escapeXml = (value: string) => value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function paragraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  const runs = text.split(/\r?\n/).map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('<w:br/>');
  return `<w:p>${properties}<w:r>${runs}</w:r></w:p>`;
}

export function exportManuscriptDocx(manuscript: ManuscriptDraft): Buffer {
  const body = [
    paragraph(manuscript.title, 'Title'),
    ...(manuscript.authors.length ? [paragraph(manuscript.authors.join(', '))] : []),
    ...manuscript.sections.flatMap(({ id, heading, content }) => [
      paragraph(heading, 'Heading1'),
      ...content.split(id === 'references' ? /\r?\n/ : /(?:\r?\n){2,}/)
        .map(plainManuscriptText).filter(Boolean).map((text) => paragraph(text)),
    ]),
  ].join('');
  return buildZip([
    ['[Content_Types].xml', `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    </Types>`],
    ['_rels/.rels', `${xmlHeader}<Relationships xmlns="${packageRels}">
      <Relationship Id="rId1" Type="${officeRels}/officeDocument" Target="word/document.xml"/>
    </Relationships>`],
    ['word/_rels/document.xml.rels', `${xmlHeader}<Relationships xmlns="${packageRels}">
      <Relationship Id="rId1" Type="${officeRels}/styles" Target="styles.xml"/>
    </Relationships>`],
    ['word/styles.xml', `${xmlHeader}<w:styles xmlns:w="${wordNamespace}">
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
        <w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
      </w:style>
    </w:styles>`],
    ['word/document.xml', `${xmlHeader}<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`],
  ]);
}
