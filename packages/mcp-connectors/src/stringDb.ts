import { defineConnector, InvalidParameter, json, limit, param, queryUrl, result, type QueryParams } from './connectorSupport.js';
import { enrichOffline, identifiers } from './enrichment.js';
import { keggPathways } from './pathwayFixtures.js';
import { stringPartners } from './stringFixtures.js';

const api = 'https://string-db.org/api/json';
const aliases = new Map(Object.entries({
  'P00533': 'EGFR', 'P04637': 'TP53', 'P38398': 'BRCA1', 'P01116': 'KRAS',
  '9606.ENSP00000275493': 'EGFR', '9606.ENSP00000269305': 'TP53',
  '9606.ENSP00000418960': 'BRCA1', '9606.ENSP00000256078': 'KRAS',
}));

interface StringInteraction {
  stringId_A: string;
  stringId_B: string;
  preferredName_A: string;
  preferredName_B: string;
  ncbiTaxonId: number;
  score: number;
  escore: number;
  dscore: number;
  tscore: number;
}

interface StringTerm {
  term: string;
  category: string;
  description: string;
  preferredNames: string[];
  number_of_genes: number;
  number_of_genes_in_background: number;
  p_value: number;
  fdr: number;
}

function stringQuery(params: QueryParams) {
  const inputs = identifiers(params, 'identifiers', 'genes', 'proteins', 'gene', 'protein', 'symbol', 'query', 'id');
  const taxonId = Number(param(params, 'species', 'taxonId') || 9606);
  if (!Number.isSafeInteger(taxonId) || taxonId <= 0) throw new InvalidParameter('Expected a positive NCBI taxonomy ID');
  if (inputs.length > 2000) throw new InvalidParameter('STRING accepts up to 2000 identifiers per request');
  return { inputs, taxonId };
}

function humanSymbols(inputs: string[]) {
  return [...new Set(inputs.map(id => aliases.get(id) ?? id))];
}

const curatedSets = keggPathways.map(({ id, name, members }) => ({
  id, name, genes: members.split(' ').map(member => member.split(':')[1]),
}));

export const stringDb = defineConnector({
  id: 'string-db', name: 'STRING Protein Interaction Network', category: 'protein',
  description: 'Find functional protein associations with evidence channels and test network pathway enrichment.',
  endpoint: `${api}/interaction_partners`,
}, {
  async interaction_partners(params, signal) {
    const { inputs, taxonId } = stringQuery(params);
    const count = limit(params);
    const requiredScore = Number(param(params, 'requiredScore', 'required_score') || 400);
    if (!Number.isInteger(requiredScore) || requiredScore < 0 || requiredScore > 1000) {
      throw new InvalidParameter('Expected a STRING score threshold from 0 to 1000');
    }
    if (signal) {
      const rows = await json<StringInteraction[]>(queryUrl(`${api}/interaction_partners`, {
        identifiers: inputs.join('\r'), species: taxonId, limit: count, required_score: requiredScore,
      }), signal);
      const data = rows.map(row => {
        if (!row.preferredName_A || !row.preferredName_B || !Number.isFinite(row.score)) throw new Error('Invalid STRING edge');
        return {
          proteinA: row.preferredName_A, proteinB: row.preferredName_B,
          stringIdA: row.stringId_A, stringIdB: row.stringId_B, taxonId: row.ncbiTaxonId, score: row.score,
          evidence: { experimental: row.escore, database: row.dscore, textmining: row.tscore },
        };
      });
      return result(data, `${data.length} STRING functional associations`);
    }
    const data = taxonId === 9606 ? humanSymbols(inputs).flatMap(gene =>
      stringPartners.filter(edge => edge.proteinA === gene && edge.score * 1000 >= requiredScore).slice(0, count)) : [];
    return result(structuredClone(data), `${data.length} curated human STRING associations`);
  },
  async network_enrichment(params, signal) {
    const { inputs, taxonId } = stringQuery(params);
    const count = limit(params);
    if (signal) {
      const rows = await json<StringTerm[]>(queryUrl(`${api}/enrichment`, {
        identifiers: inputs.join('\r'), species: taxonId,
      }), signal);
      const pathways = rows.map(row => ({
        id: row.term, category: row.category, name: row.description, overlapGenes: row.preferredNames,
        overlapCount: row.number_of_genes, pathwaySize: row.number_of_genes_in_background, pValue: row.p_value, fdr: row.fdr,
      })).sort((a, b) => a.fdr - b.fdr || a.pValue - b.pValue || a.id.localeCompare(b.id)).slice(0, count);
      return result({ method: 'STRING functional enrichment', taxonId, inputs, pathways },
        `${pathways.length} STRING enrichment terms`);
    }
    const genes = humanSymbols(inputs);
    const neighbors = genes.length === 1
      ? stringPartners.filter(edge => edge.proteinA === genes[0]).slice(0, 10).map(edge => edge.proteinB) : [];
    const data = enrichOffline(taxonId === 9606 ? curatedSets : [], [...new Set([...genes, ...neighbors])]);
    const pathways = data.pathways.filter(row => row.overlapCount > 0).slice(0, count)
      .map(row => ({ ...row, category: 'KEGG' }));
    return result({ ...data, taxonId, inputs, expandedNeighbors: neighbors, pathways },
      `${pathways.length} STRING network overlaps against curated KEGG pathways`);
  },
}, 4000);
