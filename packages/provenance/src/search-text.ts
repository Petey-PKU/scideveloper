function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchText(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

export function searchSnippet(text: string, query: string): string {
  const normalized = normalizeWhitespace(text);
  const matchStart = normalized.toLowerCase().indexOf(query);
  const start = Math.max(0, matchStart - 60);
  const end = Math.min(normalized.length, matchStart + query.length + 100);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end).trim()}${end < normalized.length ? '…' : ''}`;
}

export function createKeywordScorer(query: string, minimumWordLength = 2): ((text: string) => number) | null {
  const phrase = normalizeSearchText(query);
  const terms = new Set((phrase.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= minimumWordLength));
  if (!terms.size) return null;

  return (text) => {
    const normalized = normalizeSearchText(text);
    const frequencies = new Map<string, number>();
    for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = match[0];
      if (terms.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
    if (!frequencies.size) return 0;
    let termFrequency = 0;
    for (const frequency of frequencies.values()) termFrequency += Math.log2(1 + frequency);
    const coverage = frequencies.size / terms.size;
    const phraseBonus = normalized.includes(phrase) ? 3 : 0;
    return termFrequency + 4 * coverage + phraseBonus;
  };
}

const chunkOverlap = 150;

function nextChunkStart(text: string, end: number): number {
  const overlapStart = end - chunkOverlap;
  const nextSpace = text.indexOf(' ', overlapStart);
  if (nextSpace >= 0 && nextSpace - overlapStart < chunkOverlap / 2) return nextSpace + 1;

  const previousSpace = text.lastIndexOf(' ', overlapStart);
  if (previousSpace >= 0 && overlapStart - previousSpace < chunkOverlap / 2) return previousSpace + 1;

  return /[\uDC00-\uDFFF]/.test(text.charAt(overlapStart)) ? overlapStart - 1 : overlapStart;
}

export function joinPageChunks(chunks: string[]): string | undefined {
  if (!chunks.length) return undefined;
  let text = chunks[0];
  for (let index = 1; index < chunks.length; index++) {
    const previous = chunks[index - 1];
    const chunk = chunks[index];
    // Legacy chunks used the same overlap and word-boundary rules when they were written.
    const overlap = previous.length >= chunkOverlap ? previous.slice(nextChunkStart(previous, previous.length)) : '';
    text += overlap && chunk.startsWith(overlap) ? chunk.slice(overlap.length) : ` ${chunk}`;
  }
  return text;
}

export function chunkPage(pageText: string): string[] {
  const text = normalizeWhitespace(pageText.replace(/\u00ad/g, ''));
  const chunkSize = 900;
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;
    if (end >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    const boundaryWindow = text.slice(end - chunkOverlap, end + 1);
    const sentenceBreak = [...boundaryWindow.matchAll(/[.!?。！？](?= )/gu)].at(-1);
    const wordBreak = boundaryWindow.lastIndexOf(' ');
    if (sentenceBreak) {
      end = end - chunkOverlap + sentenceBreak.index + sentenceBreak[0].length;
    } else if (wordBreak !== -1) {
      end = end - chunkOverlap + wordBreak;
    } else if (/[\uDC00-\uDFFF]/.test(text.charAt(end))) {
      // A page can contain an unbroken run of text. Keep surrogate pairs intact.
      end--;
    }
    chunks.push(text.slice(start, end).trim());

    start = nextChunkStart(text, end);
  }

  return chunks;
}
