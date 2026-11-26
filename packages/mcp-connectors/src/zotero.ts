import {
  defineConnector, InvalidParameter, limit, matches, param, queryUrl, request, requiredParam, result,
  type QueryParams,
} from './connectorSupport.js';

const cloudUrl = 'https://api.zotero.org';
const localLibraryUrl = 'http://127.0.0.1:23119/api/users/0';
const localTimeoutMs = 1500;

interface ZoteroItem {
  key: string;
  itemType: string;
  title: string;
  authors: string[];
  doi: string | null;
  tags: string[];
  collections: string[];
  notes: string[];
  parentItem?: string;
}

interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string | null;
}

interface ApiItem {
  key: string;
  data: {
    itemType: string;
    title?: string;
    creators?: Array<{ creatorType?: string; name?: string; firstName?: string; lastName?: string }>;
    DOI?: string;
    tags?: Array<{ tag: string }>;
    collections?: string[];
    note?: string;
    parentItem?: string;
  };
}

interface ApiCollection {
  key: string;
  data: { name: string; parentCollection?: string | false };
}

// Demonstration library with synthetic keys, collections and notes about real papers.
const collections: ZoteroCollection[] = [
  { key: 'THRXTRLS', name: 'Thoracic oncology', parentCollection: null },
  { key: 'EGFRTRLS', name: 'EGFR first-line trials', parentCollection: 'THRXTRLS' },
  { key: 'MTHDS234', name: 'Research methods', parentCollection: null },
];

const items: ZoteroItem[] = [
  {
    key: 'FLAURA22', itemType: 'journalArticle',
    title: 'Osimertinib with or without Chemotherapy in EGFR-Mutated Advanced NSCLC',
    authors: ['David Planchard', 'Pasi A. Jänne'], doi: '10.1056/NEJMoa2306434',
    tags: ['EGFR', 'NSCLC', 'randomized trial'], collections: ['EGFRTRLS'],
    notes: ['FLAURA2 primary analysis. Extract investigator-assessed progression-free survival.'],
  },
  {
    key: 'MARPSA23', itemType: 'journalArticle',
    title: 'Amivantamab plus Lazertinib in Previously Untreated EGFR-Mutated Advanced NSCLC',
    authors: ['Byoung Chul Cho', 'Shun Lu'], doi: '10.1056/NEJMoa2403614',
    tags: ['EGFR', 'NSCLC', 'randomized trial'], collections: ['EGFRTRLS'],
    notes: ['MARIPOSA compares amivantamab plus lazertinib with osimertinib for its primary endpoint.'],
  },
  {
    key: 'PRSMA224', itemType: 'journalArticle', title: 'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews',
    authors: ['Matthew J. Page', 'Joanne E. McKenzie'], doi: '10.1136/bmj.n71',
    tags: ['PRISMA', 'systematic review', 'reporting'], collections: ['MTHDS234'],
    notes: ['Use the flow diagram and checklist to reconcile records, reports and studies.'],
  },
];

function normalizeItem({ key, data }: ApiItem): ZoteroItem {
  if (!key || !data.itemType) throw new Error('Invalid Zotero item');
  return {
    key, itemType: data.itemType, title: data.title ?? '',
    authors: data.creators?.filter(creator => !creator.creatorType || creator.creatorType === 'author')
      .map(({ name, firstName, lastName }) => name || [firstName, lastName].filter(Boolean).join(' ')).filter(Boolean) ?? [],
    doi: data.DOI ?? null, tags: data.tags?.map(({ tag }) => tag) ?? [],
    collections: data.collections ?? [], notes: data.note ? [data.note] : [],
    ...(data.parentItem && { parentItem: data.parentItem }),
  };
}

function normalizeCollection({ key, data }: ApiCollection): ZoteroCollection {
  if (!key || !data.name) throw new Error('Invalid Zotero collection');
  return { key, name: data.name, parentCollection: data.parentCollection || null };
}

function itemOrCollectionKey(value: string): string {
  if (!/^[a-z0-9]{8}$/i.test(value)) throw new InvalidParameter('Expected an eight-character Zotero key');
  return value.toUpperCase();
}

function zoteroRequest(
  params: QueryParams, path: string, query: Record<string, string | number>, signal: AbortSignal, credential?: string,
): Promise<Response> {
  const token = credential?.trim();
  const compound = token?.match(/^(\d+):(.+)$/);
  const local = params.local === true || param(params, 'local').toLowerCase() === 'true' || !token;
  const groupId = param(params, 'groupId');
  if (groupId && !/^\d+$/.test(groupId)) throw new InvalidParameter('Expected a numeric Zotero group ID');
  const headers = new Headers({ Accept: 'application/json', 'Zotero-API-Version': '3' });
  let libraryUrl = localLibraryUrl;
  let requestSignal = signal;
  if (local) {
    if (groupId) libraryUrl = `http://127.0.0.1:23119/api/groups/${groupId}`;
    requestSignal = AbortSignal.any([signal, AbortSignal.timeout(localTimeoutMs)]);
  } else {
    const userId = param(params, 'userId') || compound?.[1];
    if (groupId) {
      libraryUrl = `${cloudUrl}/groups/${groupId}`;
    } else {
      if (!userId) throw new Error('Zotero cloud access requires a user ID');
      if (!/^\d+$/.test(userId)) throw new InvalidParameter('Expected a numeric Zotero user ID');
      libraryUrl = `${cloudUrl}/users/${userId}`;
    }
    headers.set('Zotero-API-Key', compound?.[2].trim() ?? token);
  }
  const url = queryUrl(libraryUrl + path, query);
  return request(url, requestSignal, { headers, redirect: 'error' });
}

export const zotero = defineConnector({
  id: 'zotero', name: 'Zotero Personal & Group Library', category: 'literature',
  description: 'Search Zotero items and collections in a personal library or by group ID.', endpoint: cloudUrl,
  supportsCredential: true, credentialLabel: 'Zotero API Key (or leave blank for local Desktop API :23119)',
}, {
  async search_items(params, signal, credential) {
    const query = param(params, 'query');
    const collection = param(params, 'collectionKey');
    const key = collection ? itemOrCollectionKey(collection) : '';
    const count = limit(params, 10, 100, ['maxResults', 'limit', 'count']);
    const path = key ? `/collections/${key}/items` : '/items';
    let data: ZoteroItem[];
    if (signal) {
      const response = await zoteroRequest(params, path, {
        limit: count, ...(query && { q: query, qmode: 'everything' }),
      }, signal, credential);
      data = (await response.json() as ApiItem[]).slice(0, count).map(normalizeItem);
    } else {
      data = structuredClone(items.filter(item => (!key || item.collections.includes(key)) &&
        matches(query, item.title, item.doi ?? '', ...item.authors, ...item.tags, ...item.notes)).slice(0, count));
    }
    return result(data, `${data.length} Zotero items`);
  },
  async get_item(params, signal, credential) {
    const key = itemOrCollectionKey(requiredParam(params, 'itemKey'));
    let data: ZoteroItem | null;
    if (signal) {
      const response = await zoteroRequest(params, `/items/${key}`, {}, signal, credential);
      data = normalizeItem(await response.json() as ApiItem);
    } else {
      data = structuredClone(items.find(item => item.key === key) ?? null);
    }
    return result(data, data ? `Zotero item ${key}` : `No cached Zotero item found for ${key}`);
  },
  async list_collections(params, signal, credential) {
    if (!signal) return result(structuredClone(collections), `${collections.length} Zotero collections`);
    const data: ZoteroCollection[] = [];
    let total: number;
    do {
      const response = await zoteroRequest(params, '/collections', { limit: 100, start: data.length }, signal, credential);
      const page = (await response.json() as ApiCollection[]).map(normalizeCollection);
      if (!page.length) break;
      data.push(...page);
      total = Number(response.headers.get('Total-Results') ?? data.length);
    } while (data.length < total);
    return result(data, `${data.length} Zotero collections`);
  },
});
