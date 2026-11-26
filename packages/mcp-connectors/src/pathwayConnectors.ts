import { defineConnector, InvalidParameter, json, limit, matches, param, queryUrl, request, requiredParam, result } from './connectorSupport.js';
import { enrichOffline, identifiers } from './enrichment.js';
import { keggPathways, reactomePathways } from './pathwayFixtures.js';

const keggApi = 'https://rest.kegg.jp';
const reactomeApi = 'https://reactome.org/ContentService';
const reactomeAnalysis = 'https://reactome.org/AnalysisService';

function keggInfo(id: string, title: string) {
  return {
    id, name: title.replace(/ - Homo sapiens \(human\)$/, ''),
    organism: 'Homo sapiens', url: `https://www.kegg.jp/entry/${id}`,
  };
}

function parseKeggPathway(text: string, id: string) {
  const fields = new Map<string, string[]>();
  let field = '';
  for (const line of text.split(/\r?\n/)) {
    if (line === '///') break;
    const key = line.slice(0, 12).trim();
    if (key) field = key;
    if (!field) continue;
    const values = fields.get(field) ?? [];
    values.push(line.slice(12).trim());
    fields.set(field, values);
  }
  const name = fields.get('NAME')?.[0];
  if (fields.get('ENTRY')?.[0]?.split(/\s+/)[0] !== id || !name) throw new Error('Invalid KEGG pathway record');
  const genes = (fields.get('GENE') ?? []).flatMap(line => {
    const match = /^(\d+)\s+([^;\s]+);\s*(.*)$/.exec(line);
    return match ? [{ entrezGeneId: Number(match[1]), symbol: match[2], name: match[3].split(' [')[0] }] : [];
  });
  return {
    ...keggInfo(id, name), description: fields.get('DESCRIPTION')?.join(' ') ?? '',
    classification: fields.get('CLASS')?.join(' ') ?? '', geneCoverage: 'KEGG record', genes,
  };
}

const curatedKegg = keggPathways.map(({ id, name, description, classification, members }) => ({
  ...keggInfo(id, name), description, classification, geneCoverage: 'curated subset',
  genes: members.split(' ').map(member => {
    const [entrezGeneId, symbol] = member.split(':');
    return { entrezGeneId: Number(entrezGeneId), symbol };
  }),
}));

export const kegg = defineConnector({
  id: 'kegg', name: 'KEGG', category: 'pathways',
  description: 'Search human pathways and retrieve KEGG gene membership.', endpoint: keggApi,
}, {
  async search_pathway(params, signal) {
    const query = param(params, 'query', 'q', 'name', 'pathway', 'pathwayId', 'id').replace(/^path:/i, '');
    const pathways = signal
      ? (await (await request(`${keggApi}/list/pathway/hsa`, signal)).text()).trim().split(/\r?\n/).flatMap(line => {
        const [id, name] = line.replace(/^path:/, '').split('\t');
        return /^hsa\d{5}$/.test(id) && name ? [keggInfo(id, name)] : [];
      })
      : curatedKegg.map(({ id, name, organism, url }) => ({ id, name, organism, url }));
    if (signal && !pathways.length) throw new Error('Invalid KEGG pathway list');
    const rows = pathways.filter(row => matches(query, row.id, row.name)).slice(0, limit(params));
    return result(rows, `${rows.length} human KEGG pathways`);
  },
  async get_pathway(params, signal) {
    const id = requiredParam(params, 'pathwayId', 'id', 'pathway', 'query').toLowerCase().replace(/^path:/, '');
    if (!/^hsa\d{5}$/.test(id)) throw new InvalidParameter('Expected a human KEGG pathway ID (hsa followed by five digits)');
    const data = signal ? parseKeggPathway(await (await request(`${keggApi}/get/${id}`, signal)).text(), id)
      : structuredClone(curatedKegg.find(row => row.id === id) ?? null);
    return result(data, data ? `${data.name} (${data.genes.length} genes)` : `No offline KEGG pathway for ${id}`);
  },
}, 4000);

function reactomeInfo(id: string, name: string, description = '') {
  return { id, name: name.replace(/<[^>]+>/g, ''), description, organism: 'Homo sapiens',
    url: `https://reactome.org/content/detail/${id}` };
}

interface ReactomeHit {
  stId?: string;
  id?: string;
  name: string;
  summation?: string;
}

interface ReactomeAnalysis {
  pathways: Array<{
    stId: string;
    name: string;
    entities: { found: number; total: number; pValue: number; fdr: number };
  }>;
  identifiersNotFound: number;
  summary?: { token?: string };
}

export const reactome = defineConnector({
  id: 'reactome', name: 'Reactome', category: 'pathways',
  description: 'Search human Reactome pathways and run gene over-representation analysis.', endpoint: reactomeApi,
}, {
  async search_pathways(params, signal) {
    const query = param(params, 'query', 'q', 'name', 'pathwayId', 'id');
    const count = limit(params);
    let rows;
    if (signal && !query) {
      const hits = await json<Array<{ stId: string; displayName: string }>>(`${reactomeApi}/data/pathways/top/9606`, signal);
      rows = hits.map(hit => reactomeInfo(hit.stId, hit.displayName));
    } else if (signal) {
      const data = await json<{ results: Array<{ entries: ReactomeHit[] }> }>(queryUrl(`${reactomeApi}/search/query`, {
        query, species: 'Homo sapiens', types: 'Pathway', cluster: 'true', rows: count,
      }), signal);
      rows = data.results.flatMap(group => group.entries.flatMap(entry => {
        const id = entry.stId ?? entry.id ?? '';
        return /^R-HSA-\d+$/.test(id) ? [reactomeInfo(id, entry.name, entry.summation?.replace(/<[^>]+>/g, ''))] : [];
      }));
    } else {
      rows = reactomePathways.filter(row => matches(query, row.id, row.name, row.description))
        .map(row => ({ ...reactomeInfo(row.id, row.name, row.description), genes: [...row.genes], geneCoverage: 'curated subset' }));
    }
    return result(rows.slice(0, count), `${Math.min(rows.length, count)} human Reactome pathways`);
  },
  async enrich_genes(params, signal) {
    const genes = identifiers(params, 'genes', 'geneSymbols', 'identifiers', 'query');
    const background = params.background === undefined ? undefined : identifiers(params, 'background');
    const count = limit(params);
    if (signal && background) throw new Error('Custom backgrounds use the offline curated library');
    if (signal) {
      const response = await request(queryUrl(`${reactomeAnalysis}/identifiers/projection/`, {
        species: 'Homo sapiens', pageSize: count, sortBy: 'ENTITIES_PVALUE', order: 'ASC', resource: 'TOTAL',
      }), signal, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'text/plain' }, body: genes.join('\n'),
      });
      const data = await response.json() as ReactomeAnalysis;
      const pathways = data.pathways.filter(row => /^R-HSA-\d+$/.test(row.stId)).slice(0, count).map(row => ({
        id: row.stId, name: row.name, overlapCount: row.entities.found, pathwaySize: row.entities.total,
        pValue: row.entities.pValue, fdr: row.entities.fdr,
      }));
      return result({
        method: 'Reactome Analysis Service', querySize: genes.length, pathways,
        identifiersNotFound: data.identifiersNotFound, analysisToken: data.summary?.token,
      }, `${pathways.length} Reactome enrichment results`);
    }
    const data = enrichOffline(reactomePathways, genes, background);
    const pathways = data.pathways.filter(row => row.overlapCount > 0).slice(0, count);
    return result({ ...data, pathways }, `${pathways.length} Reactome overlaps against the curated library`);
  },
}, 4000);
