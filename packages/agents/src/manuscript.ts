import type { ManuscriptDraft, SessionTree } from '@scideveloper/shared';

interface ManuscriptFigure {
  id: string;
  title: string;
  description: string;
  filename: string;
  latexFilename: string;
}

export function plainManuscriptText(text: string): string {
  return text.replace(/!?(?:\[([^\]]+)\])\([^)]+\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*]|>)\s+/gm, '')
    .replace(/\*\*|__|`/g, '').trim();
}

function latex(text: string): string {
  const escapes: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '%': '\\%',
    '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
    '−': '\\ensuremath{-}', '≤': '\\ensuremath{\\leq}', '≥': '\\ensuremath{\\geq}',
    '×': '\\ensuremath{\\times}', '→': '\\ensuremath{\\to}', '±': '\\ensuremath{\\pm}',
    'α': '\\ensuremath{\\alpha}', 'β': '\\ensuremath{\\beta}', 'μ': '\\ensuremath{\\mu}',
  };
  return text.replace(/[\\{}$&#%_^~−≤≥×→±αβμ]/g, (symbol) => escapes[symbol]);
}

const identifierLabel = (identifier: string) => /^\d+$/.test(identifier) ? `PMID:${identifier}` : identifier;
const markdownLabel = (text: string) => text.replace(/([\\\[\]*_`])/g, '\\$1').replace(/\r?\n/g, ' ');

export function buildBibtex(citations: ManuscriptDraft['citations']): string {
  const entries = citations.filter(({ verified }) => verified).map(({ identifier, title, journal, year, doi }, index) => {
    const field = (name: string, value: string) => `  ${name} = {${latex(value.replace(/\s+/g, ' ').trim())}}`;
    const articleDoi = doi ?? (/^10\.\d+\//.test(identifier) ? identifier : undefined);
    const fields = [
      field('title', title),
      ...(journal ? [field('journal', journal)] : []),
      ...(year ? [field('year', String(year))] : []),
      ...(articleDoi ? [field('doi', articleDoi)] : [field('note', identifierLabel(identifier))]),
    ];
    return `@article{ref${index + 1},\n${fields.join(',\n')}\n}`;
  });
  return entries.length ? entries.join('\n\n') + '\n' : '% No verified references are recorded for this session.\n';
}

function recordedMetrics(value: unknown): Array<[string, unknown]> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
}

export function buildManuscriptDraft(
  tree: SessionTree,
  id: string,
  title: string,
  methods: string[],
  figures: ManuscriptFigure[],
): ManuscriptDraft {
  const findings = tree.nodes.filter((node) => node.role === 'coordinator' && !node.metadata?.cancelled &&
    (node.metadata?.artifactCount !== undefined || node.metadata?.metrics !== undefined));
  const objectives = tree.nodes.filter((node) => node.role === 'user' && !node.metadata?.autoFixReviewId);
  const citationsById = new Map<string, ManuscriptDraft['citations'][number]>();
  for (const review of tree.reviews) {
    for (const citation of review.verifiedCitations) {
      if (citation.verified && !citationsById.has(citation.identifier)) {
        citationsById.set(citation.identifier, {
          identifier: citation.identifier, title: citation.title ?? citation.identifier, verified: true,
        });
      }
    }
  }
  const citations = [...citationsById.values()];
  const latest = findings.at(-1);
  const results = findings.flatMap((node) => {
    const metrics = recordedMetrics(node.metadata?.metrics);
    const body = plainManuscriptText(node.content)
      .replace(/\bPMID\s*[:#]?\s*(\d{6,9})\b/gi, (_id, pmid: string) =>
        citationsById.has(pmid) ? `PMID:${pmid}` : '[unverified citation omitted]')
      .replace(/\b10\.\d{4,9}\/[A-Za-z0-9._;()\/:-]+\b/g, (doi) =>
        citationsById.has(doi) ? doi : '[unverified citation omitted]');
    return [body, ...(metrics.length
      ? [`Recorded metrics: ${metrics.map(([key, value]) => `${key} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(', ')}.`]
      : [])].filter(Boolean);
  });
  const review = latest && tree.reviews.find((item) => item.nodeId === latest.id);
  const unresolved = review?.findings.filter(({ severity }) => severity !== 'pass') ?? [];
  const abstractMetrics = recordedMetrics(latest?.metadata?.metrics).filter(([, value]) => typeof value === 'number').slice(0, 4);
  const sections = [
    {
      id: 'abstract', heading: 'Abstract',
      content: findings.length
        ? [
          `This draft summarizes ${findings.length} analysis run(s), ${figures.length} figure(s), and ${citations.length} verified reference(s).`,
          ...(abstractMetrics.length ? [`The most recent analysis recorded ${abstractMetrics.map(([name, value]) => `${name.replaceAll('_', ' ')} = ${value}`).join(', ')}.`] : []),
          review?.summary ?? 'Review results are pending.',
        ].join(' ')
        : 'The session contains no completed analysis runs. This draft records the research objective and available evidence.',
    },
    {
      id: 'introduction', heading: 'Introduction',
      content: objectives.length
        ? objectives.map(({ content }) => plainManuscriptText(content)).join('\n\n')
        : 'The session has no recorded research objective.',
    },
    { id: 'methods', heading: 'Methods', content: methods.join('\n\n') || 'No artifact methods are recorded for this session.' },
    { id: 'results', heading: 'Results', content: results.join('\n\n') || 'No coordinator findings are recorded for this session.' },
    {
      id: 'discussion', heading: 'Discussion',
      content: unresolved.length
        ? unresolved.map(({ title, detail, suggestedFix }) => [title, detail, suggestedFix].filter(Boolean).join('. ')).join('\n\n')
        : 'Interpret the results in the context of the datasets and analysis assumptions documented in the Methods. The session does not establish independent replication.',
    },
    {
      id: 'references', heading: 'References',
      content: citations.map(({ identifier, title }) => `- ${title} (${identifierLabel(identifier)})`).join('\n') ||
        'No verified references are recorded for this session.',
    },
  ];
  const markdownSource = [
    `# ${title.replace(/\r?\n/g, ' ')}`,
    ...sections.flatMap(({ id, heading, content }) => [
      `## ${heading}`, content,
      ...(id === 'results' ? figures.map((figure) => `![${markdownLabel(figure.title)}](${figure.filename})\n\n*${markdownLabel(figure.description || figure.title)}*`) : []),
    ]),
  ].join('\n\n') + '\n';

  const latexSource = [
    '\\documentclass{article}',
    '\\usepackage{iftex}',
    '\\ifPDFTeX\\usepackage[T1]{fontenc}\\usepackage[utf8]{inputenc}\\fi',
    '\\usepackage{graphicx}',
    `\\title{${latex(title)}}`,
    '\\author{}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    ...sections.filter(({ id }) => id !== 'references').flatMap(({ id, heading, content }) => [
      `\\section{${heading}}`, latex(content),
      ...(id === 'results' ? figures.flatMap((figure) => [
        '\\begin{figure}[htbp]', '\\centering',
        `\\includegraphics[width=0.95\\linewidth]{${figure.latexFilename}}`,
        `\\caption{${latex(figure.description || figure.title)}}`, '\\end{figure}',
      ]) : []),
    ]),
    '\\begin{thebibliography}{99}',
    ...(citations.length
      ? citations.map(({ identifier, title }, index) => `\\bibitem{ref${index + 1}} ${latex(title)} (${latex(identifierLabel(identifier))}).`)
      : ['\\item[] No verified references are recorded for this session.']),
    '\\end{thebibliography}',
    '\\end{document}',
    '',
  ].join('\n\n');

  return {
    id, sessionId: tree.session.id, title, authors: [], sections, citations,
    figureArtifactIds: figures.map((figure) => figure.id),
    markdownSource, latexSource, bibtexSource: buildBibtex(citations), updatedAt: new Date().toISOString(),
  };
}
