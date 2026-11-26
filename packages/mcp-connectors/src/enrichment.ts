import { InvalidParameter, type QueryParams } from './connectorSupport.js';

export function identifiers(params: QueryParams, ...keys: string[]): string[] {
  const raw = keys.map(key => params[key]).find(value => value !== undefined);
  const fields = typeof raw === 'string' ? raw.split(/[\s,;]+/).filter(Boolean) : raw;
  if (!Array.isArray(fields) || fields.length === 0 ||
      fields.some(field => typeof field !== 'string' && !Number.isSafeInteger(field))) {
    throw new InvalidParameter(`Expected ${keys[0]} as a list of identifiers`);
  }
  const normalized = fields.map(field => String(field).trim().toUpperCase());
  if (normalized.some(field => !/^[A-Z0-9][A-Z0-9_.:-]{0,79}$/.test(field))) {
    throw new InvalidParameter(`Invalid identifier in ${keys[0]}`);
  }
  return [...new Set(normalized)];
}

export interface GeneSet {
  id: string;
  name: string;
  genes: readonly string[];
}

function logChoose(n: number, k: number): number {
  let value = 0;
  for (let i = 1; i <= Math.min(k, n - k); i++) {
    value += Math.log((n - i + 1) / i);
  }
  return value;
}

function hypergeometricTail(size: number, members: number, draws: number, overlap: number): number {
  const lower = Math.max(0, draws - (size - members));
  if (overlap <= lower) return 1;
  let logTerm = logChoose(members, overlap) + logChoose(size - members, draws - overlap) - logChoose(size, draws);
  let probability = Math.exp(logTerm);
  for (let k = overlap; k < Math.min(members, draws); k++) {
    logTerm += Math.log(((members - k) * (draws - k)) / ((k + 1) * (size - members - draws + k + 1)));
    probability += Math.exp(logTerm);
  }
  return Math.min(1, probability);
}

export function enrichOffline(sets: readonly GeneSet[], genes: string[], background?: string[]) {
  const universe = new Set(background ?? sets.flatMap(set => set.genes));
  const query = new Set(genes.filter(gene => universe.has(gene)));
  const pathways = sets.flatMap(set => {
    const members = set.genes.filter(gene => universe.has(gene));
    if (!members.length) return [];
    const overlapGenes = members.filter(gene => query.has(gene)).sort();
    return [{
      id: set.id, name: set.name, overlapGenes, overlapCount: overlapGenes.length,
      pathwaySize: members.length, pValue: hypergeometricTail(universe.size, members.length, query.size, overlapGenes.length),
      fdr: 1,
    }];
  }).sort((a, b) => a.pValue - b.pValue || a.id.localeCompare(b.id));

  let fdr = 1;
  for (let i = pathways.length - 1; i >= 0; i--) {
    fdr = Math.min(fdr, pathways[i].pValue * pathways.length / (i + 1));
    pathways[i].fdr = fdr;
  }
  return {
    method: 'hypergeometric', library: 'curated subset', background: background ? 'provided' : 'curated union',
    universeSize: universe.size, testedPathways: pathways.length, querySize: query.size,
    unmappedGenes: genes.filter(gene => !query.has(gene)), pathways,
  };
}
