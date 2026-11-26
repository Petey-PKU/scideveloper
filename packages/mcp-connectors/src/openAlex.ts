import {
  defineConnector, InvalidParameter, limit, matches, param, queryUrl, request, requiredParam, result,
  type QueryParams,
} from './connectorSupport.js';

const worksUrl = 'https://api.openalex.org/works';
const idPrefix = 'https://openalex.org/';

interface Work {
  id: string;
  doi: string | null;
  pmid: string | null;
  title: string;
  citedByCount: number;
  publicationYear: number | null;
  openAccessUrl: string | null;
  authors: string[];
  journal: string | null;
}

interface ApiWork {
  id: string;
  doi?: string | null;
  title?: string;
  display_name?: string;
  ids?: { doi?: string; pmid?: string | number | null };
  cited_by_count?: number;
  publication_year?: number | null;
  open_access?: { oa_url?: string | null };
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } | null } | null;
}

// Curated bibliographic snapshots with selected author names and citation links.
const fixtures: Work[] = [
  {
    id: idPrefix + 'W3177828909', doi: '10.1038/s41586-021-03819-2', pmid: '34265844',
    title: 'Highly accurate protein structure prediction with AlphaFold', citedByCount: 43500, publicationYear: 2021,
    openAccessUrl: 'https://www.nature.com/articles/s41586-021-03819-2',
    authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel'], journal: 'Nature',
  },
  {
    id: idPrefix + 'W3211795435', doi: '10.1093/nar/gkab1061', pmid: '34791371',
    title: 'AlphaFold Protein Structure Database: massively expanding the structural coverage of protein-sequence space with high-accuracy models',
    citedByCount: 8041, publicationYear: 2022, openAccessUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8728224/',
    authors: ['Mihály Varadi', 'Stephen Anyango', 'Mandar Deshpande'], journal: 'Nucleic Acids Research',
  },
  {
    id: idPrefix + 'W4327550249', doi: '10.1126/science.ade2574', pmid: '36927031',
    title: 'Evolutionary-scale prediction of atomic-level protein structure with a language model',
    citedByCount: 3600, publicationYear: 2023, openAccessUrl: 'https://www.science.org/doi/10.1126/science.ade2574',
    authors: ['Zeming Lin', 'Halil Akin', 'Roshan Rao'], journal: 'Science',
  },
];
const fixtureCitations = new Map([
  ['W3177828909', ['W3211795435', 'W4327550249']],
]);

function workKey(value: string): string | undefined {
  return /^(?:https?:\/\/(?:www\.)?openalex\.org\/)?(W\d+)\/?$/i.exec(value)?.[1].toUpperCase();
}

function bareDoi(value: string): string {
  return value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
}

function workIdentifier(params: QueryParams): string {
  const value = requiredParam(params, 'workId', 'doi');
  const key = workKey(value);
  if (key) return key;
  const doi = bareDoi(value);
  if (!/^10\.\d{4,9}\/\S+$/.test(doi) || doi.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new InvalidParameter('Expected an OpenAlex work ID or DOI');
  }
  return 'doi:' + doi;
}

function normalizeWork(work: ApiWork): Work {
  const key = workKey(work.id);
  const title = work.title || work.display_name;
  if (!key || !title) throw new Error('Invalid OpenAlex work');
  return {
    id: idPrefix + key, title,
    doi: bareDoi(work.doi ?? work.ids?.doi ?? '') || null,
    pmid: String(work.ids?.pmid ?? '').match(/(?:^|\/)(\d+)\/?$/)?.[1] ?? null,
    citedByCount: work.cited_by_count ?? 0,
    publicationYear: work.publication_year ?? null,
    openAccessUrl: work.open_access?.oa_url ?? null,
    authors: work.authorships?.flatMap(({ author }) => author?.display_name ? [author.display_name] : []) ?? [],
    journal: work.primary_location?.source?.display_name ?? null,
  };
}

async function openAlexJson<T>(url: URL | string, signal: AbortSignal): Promise<T> {
  const response = await request(url, signal, { headers: { Accept: 'application/json', 'User-Agent': 'SciDeveloper/0.5' } });
  return await response.json() as T;
}

async function listWorks(query: Record<string, string | number>, count: number, signal: AbortSignal): Promise<Work[]> {
  const payload = await openAlexJson<{ results: ApiWork[] }>(queryUrl(worksUrl, { ...query, 'per-page': count }), signal);
  return payload.results.slice(0, count).map(normalizeWork);
}

async function lookupWork(identifier: string, signal?: AbortSignal): Promise<Work | null> {
  if (signal) {
    const path = identifier.split('/').map(encodeURIComponent).join('/').replace(/^doi%3A/, 'doi:');
    return normalizeWork(await openAlexJson<ApiWork>(`${worksUrl}/${path}`, signal));
  }
  const fixture = fixtures.find(work => workKey(work.id) === identifier || 'doi:' + work.doi === identifier);
  return fixture ? structuredClone(fixture) : null;
}

const sortFields = new Map<string, (work: Work) => string | number>([
  ['cited_by_count', work => work.citedByCount],
  ['publication_year', work => work.publicationYear ?? 0],
  ['publication_date', work => work.publicationYear ?? 0],
  ['display_name', work => work.title],
]);

function sortFixtures(works: Work[], sort: string): Work[] {
  const comparators = sort.split(',').map(value => {
    const [field, direction] = value.split(':');
    const get = sortFields.get(field);
    return get ? (a: Work, b: Work) => {
      const left = get(a);
      const right = get(b);
      const order = typeof left === 'number' && typeof right === 'number'
        ? left - right : String(left).localeCompare(String(right));
      return direction === 'desc' ? -order : order;
    } : () => 0;
  });
  return works.sort((a, b) => comparators.reduce((order, compare) => order || compare(a, b), 0));
}

export const openalex = defineConnector({
  id: 'openalex', name: 'OpenAlex Scholarly Graph', category: 'literature',
  description: 'Search scholarly works, resolve DOIs and trace forward citations.', endpoint: worksUrl,
}, {
  async search_works(params, signal) {
    const query = param(params, 'query');
    const count = limit(params, 10, 100, ['maxResults', 'limit', 'count']);
    const sort = param(params, 'sort');
    const data = signal
      ? await listWorks({ ...(query && { search: query }), ...(sort && { sort }) }, count, signal)
      : structuredClone(sortFixtures(fixtures.filter(work => matches(query, work.title,
        work.doi ?? '', work.pmid ?? '', work.journal ?? '', ...work.authors)), sort).slice(0, count));
    return result(data, `${data.length} OpenAlex works`);
  },
  async get_work(params, signal) {
    const identifier = workIdentifier(params);
    const data = await lookupWork(identifier, signal);
    return result(data, data ? `OpenAlex work ${data.id}` : `No cached OpenAlex work found for ${identifier}`);
  },
  async cited_by(params, signal) {
    const identifier = workIdentifier(params);
    const count = limit(params, 10, 100, ['maxResults', 'limit', 'count']);
    const key = workKey(identifier) ?? workKey((await lookupWork(identifier, signal))?.id ?? '');
    const citedBy = key ? fixtureCitations.get(key) ?? [] : [];
    const data = signal && key
      ? await listWorks({ filter: `cites:${key}` }, count, signal)
      : structuredClone(fixtures.filter(work => citedBy.includes(work.id.slice(idPrefix.length))).slice(0, count));
    return result(data, `${data.length} OpenAlex works citing ${key ?? identifier}`);
  },
});
