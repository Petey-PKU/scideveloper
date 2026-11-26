import type { LiteraturePageView, LiteraturePassage } from '@scideveloper/shared';

// Related search terms include common abbreviations and spelling variants.
const synonymGroups = [
  ['resistance', 'resistant', 'refractory', 'escape'],
  ['mutation', 'mutations', 'variant', 'variants', 'alteration', 'snv', 'substitution'],
  ['expression', 'transcript', 'rna-seq', 'rnaseq', 'mrna', 'upregulated', 'downregulated'],
  ['inhibitor', 'inhibitors', 'tki', 'antagonist', 'blockade', 'drug'],
  ['survival', 'kaplan', 'kaplan-meier', 'hazard', 'prognosis', 'mortality', 'os', 'pfs'],
  ['immunotherapy', 'checkpoint', 'pd-1', 'pd1', 'pd-l1', 'pdl1', 'ctla-4', 'ctla4'],
  ['clinical', 'trial', 'phase', 'cohort', 'patient', 'rct', 'randomized controlled trial'],
  ['pathway', 'signaling', 'signalling', 'cascade', 'network'],
  ['protein', 'structure', 'binding', 'pocket', 'docking'],
  ['cell', 'single-cell', 'single cell', 'scrna', 'scrna-seq', 'cluster', 'trajectory'],
  ['gene', 'locus', 'genome', 'genomic'],
  ['cancer', 'tumor', 'tumour', 'carcinoma', 'nsclc', 'oncology', 'malignant', 'neoplasm'],
  ['biomarker', 'signature', 'diagnostic', 'predictive'],
  ['statistical', 'significance', 'fdr', 'p-value', 'p value', 'anova', 'regression'],
  ['apoptosis', 'apoptotic', 'programmed cell death', 'caspase'],
  ['proliferation', 'proliferative', 'cell growth', 'cell division', 'mitosis'],
  ['metastasis', 'metastatic', 'dissemination', 'secondary tumor', 'secondary tumour'],
  ['angiogenesis', 'neovascularization', 'neovascularisation', 'vascularization'],
  ['hypoxia', 'hypoxic', 'oxygen deprivation'],
  ['inflammation', 'inflammatory', 'cytokine', 'chemokine'],
  ['fibrosis', 'fibrotic', 'scarring', 'extracellular matrix', 'ecm'],
  ['glycolysis', 'glycolytic', 'glucose metabolism', 'lactate production'],
  ['sequencing', 'ngs', 'next-generation sequencing', 'high-throughput sequencing'],
  ['replication', 'replicability', 'reproducibility', 'reproducible'],
  ['microscopy', 'micrograph', 'confocal', 'fluorescence imaging'],
  ['chromatography', 'hplc', 'uhplc', 'liquid chromatography'],
  ['mass spectrometry', 'lc-ms', 'lc-ms/ms', 'proteomics', 'proteomic'],
  ['immunoblot', 'western blot', 'western blotting'],
  ['qpcr', 'rt-qpcr', 'quantitative pcr', 'real-time pcr', 'real time pcr'],
  ['epigenetic', 'epigenetics', 'methylation', 'chromatin', 'histone modification'],
  ['knockout', 'knockdown', 'loss-of-function', 'gene silencing'],
  ['control group', 'placebo', 'sham', 'vehicle control'],
  ['meta-analysis', 'systematic review', 'pooled analysis'],
  ['pharmacokinetics', 'pk', 'clearance', 'half-life', 'bioavailability'],
];

interface Token {
  value: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const word = /[\p{L}\p{N}][\p{L}\p{M}\p{N}\u00ad]*(?:[-‐‑–−][\p{L}\p{N}][\p{L}\p{M}\p{N}\u00ad]*)*/gu;
  return Array.from(text.matchAll(word), ({ 0: original, index }) => ({
    value: original.normalize('NFC').toLowerCase().replace(/[‐‑–−]/g, '-').replace(/\u00ad/g, ''),
    start: index,
    end: index + original.length,
  }));
}

interface Term {
  text: string;
  words: string[];
}

const synonyms = synonymGroups.map((group) => group.map((alias): Term => {
  const words = tokenize(alias).map(({ value }) => value);
  return { text: words.join(' '), words };
}));

interface TrigramVector {
  counts: Map<number, number>;
  norm: number;
}

function trigramVector(word: string): TrigramVector {
  const characters = Array.from(word, (character) => character.codePointAt(0)!);
  const counts = new Map<number, number>();
  let squares = 0;
  for (let index = 2; index < characters.length; index++) {
    const first = Math.imul(0x811c9dc5 ^ characters[index - 2], 0x01000193);
    const second = Math.imul(first ^ characters[index - 1], 0x01000193);
    const hash = Math.imul(second ^ characters[index], 0x01000193);
    const count = counts.get(hash) ?? 0;
    counts.set(hash, count + 1);
    squares += 2 * count + 1;
  }
  return { counts, norm: Math.sqrt(squares) };
}

interface LiteratureQuery {
  exact: Set<string>;
  termsByFirstWord: Map<string, Term[]>;
  phrase: string[];
  trigramTerms: Array<{ text: string; vector: TrigramVector }>;
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function matchesAt(tokens: Token[], index: number, words: string[]): boolean {
  return words.every((word, offset) => tokens[index + offset]?.value === word);
}

export function createLiteratureQuery(query: string): LiteratureQuery | undefined {
  const tokens = tokenize(query);
  const exact = new Set(tokens.map(({ value }) => value).filter((word) => word.length >= 2 || cjk.test(word)));
  if (!exact.size) return undefined;

  const terms = new Map<string, Term>();
  for (const text of exact) terms.set(text, { text, words: [text] });
  for (const group of synonyms) {
    const present = group.filter(({ words }) => tokens.some((_, index) => matchesAt(tokens, index, words)));
    if (!present.length) continue;
    for (const term of group) {
      if (!present.includes(term)) terms.set(term.text, term);
    }
  }

  const termsByFirstWord = new Map<string, Term[]>();
  for (const term of terms.values()) {
    const first = term.words[0];
    const options = termsByFirstWord.get(first);
    if (options) options.push(term);
    else termsByFirstWord.set(first, [term]);
  }
  const trigramTerms = [...exact].map((text) => ({ text, vector: trigramVector(text) }))
    .filter(({ text, vector }) => vector.norm > 0 || cjk.test(text));
  const phrase = tokens.length > 1 ? tokens.map(({ value }) => value) : [];
  return { exact, termsByFirstWord, phrase, trigramTerms };
}

type TermMatch = LiteraturePageView['highlightSpans'][number];

function* termMatches(tokens: Token[], query: LiteratureQuery): Iterable<TermMatch> {
  for (const [index, token] of tokens.entries()) {
    const terms = query.termsByFirstWord.get(token.value);
    if (!terms) continue;
    for (const { text, words } of terms) {
      if (matchesAt(tokens, index, words)) {
        yield { start: token.start, end: tokens[index + words.length - 1].end, term: text };
      }
    }
  }
}

function cosineSimilarity(left: TrigramVector, right: TrigramVector): number {
  let dot = 0;
  let shared = 0;
  for (const [hash, count] of left.counts) {
    const rightCount = right.counts.get(hash);
    if (rightCount === undefined) continue;
    dot += count * rightCount;
    shared++;
  }
  // Reject incidental shared suffixes before scoring morphology.
  if (shared < 2 || shared < 0.6 * Math.min(left.counts.size, right.counts.size)) return 0;
  const cosine = dot / (left.norm * right.norm);
  return cosine >= 0.3 ? cosine : 0;
}

function trigramSimilarity(tokens: Token[], query: LiteratureQuery, matched: Map<string, number>): number {
  if (!query.trigramTerms.length) return 0;
  let best = 0;
  for (const word of new Set(tokens.map(({ value }) => value))) {
    if (matched.has(word)) continue;
    // A literal substring has a perfect local match, including short unsegmented CJK terms.
    if (query.trigramTerms.some(({ text }) => word.includes(text))) return 1;
    const vector = trigramVector(word);
    if (!vector.norm) continue;
    for (const term of query.trigramTerms) {
      best = Math.max(best, cosineSimilarity(term.vector, vector));
    }
  }
  return best;
}

const phraseKey = '';

export function rankLiteraturePassages<Row>(
  rows: Iterable<Row>,
  toPassage: (row: Row) => LiteraturePassage,
  query: LiteratureQuery,
  limit: number,
): LiteraturePassage[] {
  let documentCount = 0;
  let corpusLength = 0;
  const documentFrequencies = new Map<string, number>();
  const matches = [];

  for (const row of rows) {
    const passage = toPassage(row);
    const tokens = tokenize(passage.text);
    const termFrequencies = new Map<string, number>();
    for (const { term } of termMatches(tokens, query)) {
      termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
    }
    const matchedTerms = [...termFrequencies.keys()];
    const similarity = trigramSimilarity(tokens, query, termFrequencies);
    const exact = matchedTerms.some((term) => query.exact.has(term));
    const semantic = similarity > 0 || matchedTerms.some((term) => !query.exact.has(term));

    documentCount++;
    corpusLength += tokens.length;
    if (!exact && !semantic) continue;
    if (query.phrase.length) {
      const occurrences = tokens.filter((_, index) => matchesAt(tokens, index, query.phrase)).length;
      if (occurrences) termFrequencies.set(phraseKey, occurrences);
    }
    for (const term of termFrequencies.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
    const matchMode: LiteraturePassage['matchMode'] = exact ? (semantic ? 'hybrid' : 'lexical') : 'semantic';
    matches.push({ passage, length: tokens.length, termFrequencies, matchedTerms, similarity, matchMode });
  }

  const averageLength = corpusLength / Math.max(1, documentCount);
  const weights = new Map<string, number>();
  for (const [term, frequency] of documentFrequencies) {
    const idf = Math.log1p((documentCount - frequency + 0.5) / (frequency + 0.5));
    const boost = term === phraseKey ? 5 : query.exact.has(term) ? 3 : 0.6;
    weights.set(term, boost * idf);
  }
  const ranked = matches.map(({ passage, length, termFrequencies, matchedTerms, similarity, matchMode }): LiteraturePassage => {
    const k1 = 1.2;
    const b = 0.75;
    const lengthNormalization = k1 * (1 - b + b * length / averageLength);
    let score = 0.75 * similarity;
    for (const [term, frequency] of termFrequencies) {
      score += weights.get(term)! * frequency * (k1 + 1) / (frequency + lengthNormalization);
    }
    return { ...passage, score, matchedTerms, matchMode };
  });
  return ranked.sort((a, b) => b.score - a.score || a.paperId.localeCompare(b.paperId)
    || a.page - b.page || a.chunkIndex - b.chunkIndex).slice(0, limit);
}

export function highlightLiteratureText(
  text: string,
  query: LiteratureQuery | undefined,
): Pick<LiteraturePageView, 'matchedTerms' | 'highlightSpans'> {
  if (!query) return { matchedTerms: [], highlightSpans: [] };
  const matches = [...termMatches(tokenize(text), query)];
  const matchedTerms = [...new Set(matches.map(({ term }) => term))];
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const highlightSpans: TermMatch[] = [];
  for (const match of matches) {
    if (highlightSpans.length >= 60) break;
    if (match.start >= (highlightSpans.at(-1)?.end ?? 0)) highlightSpans.push(match);
  }
  return { matchedTerms, highlightSpans };
}
