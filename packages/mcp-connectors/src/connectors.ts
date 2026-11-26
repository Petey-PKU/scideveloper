import { alphafoldDb } from './alphafoldDb.js';
import { cbioportal } from './cbioportal.js';
import { clinicaltrials } from './clinicalTrials.js';
import { compoundFixtures } from './compoundFixtures.js';
import { elnBenchling } from './elnBenchling.js';
import { openalex } from './openAlex.js';
import { openTargets } from './openTargets.js';
import { kegg, reactome } from './pathwayConnectors.js';
import { pubchem } from './pubchem.js';
import { stringDb } from './stringDb.js';
import {
  defineConnector, InvalidParameter, json, limit, matches, param, queryUrl, request, requiredParam, result,
  type QueryParams, type ScientificConnector,
} from './connectorSupport.js';
import { geneFixtures } from './geneFixtures.js';
import { literatureFixtures, type Article } from './literatureFixtures.js';
import { proteinFixtures } from './proteinFixtures.js';
import {
  clinvarFixtures, geoFixtures, preprintFixtures,
  type ClinicalVariant, type GeoSeries, type Preprint, type PreprintServer,
} from './scientificFixtures.js';
import { structureFixtures } from './structureFixtures.js';
import { zotero } from './zotero.js';

export type { ConnectorResponse, ScientificConnector } from './connectorSupport.js';

const europePmc = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const ncbi = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const ncbiCredential = { supportsCredential: true, credentialLabel: 'NCBI API Key (higher rate limits)' };
const rcsbSearch = 'https://search.rcsb.org/rcsbsearch/v2/query';
const rcsbData = 'https://data.rcsb.org/rest/v1/core/entry';
const rcsbFiles = 'https://files.rcsb.org/download';
const uniprotApi = 'https://rest.uniprot.org/uniprotkb';
const chemblApi = 'https://www.ebi.ac.uk/chembl/api/data';
const ensemblApi = 'https://rest.ensembl.org';

interface EuropePmcHit {
  pmid?: string;
  doi?: string;
  title: string;
  journalTitle?: string;
  journalInfo?: { journal?: { title?: string } };
  pubYear?: string;
  abstractText?: string;
}

function normalizeCitation(input: string): string {
  return input.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid\s*:?\s*)/i, '')
    .replace(/^([0-9]+)\/$/, '$1').toLowerCase();
}

async function searchEuropePmc(query: string, count: number, signal: AbortSignal): Promise<Article[]> {
  const url = queryUrl(europePmc, { query, format: 'json', resultType: 'core', pageSize: count });
  const payload = await json<{ resultList: { result: EuropePmcHit[] } }>(url, signal);
  return payload.resultList.result.flatMap(hit => hit.pmid && hit.title ? [{
    pmid: hit.pmid,
    doi: hit.doi ?? '',
    title: hit.title.replace(/<[^>]*>/g, ''),
    journal: hit.journalInfo?.journal?.title ?? hit.journalTitle ?? '',
    year: Number(hit.pubYear ?? 0),
    abstract: hit.abstractText ?? '',
    abstractKind: 'publisher' as const,
  }] : []);
}

function parseMedline(text: string): Article[] {
  const records = text.trimStart().split(/\r?\n(?=PMID\s*- )/);
  return records.flatMap(record => {
    const fields = new Map<string, string[]>();
    let values: string[] | undefined;
    for (const line of record.split(/\r?\n/)) {
      const field = /^([A-Z0-9]{2,4}) *- (.*)$/.exec(line);
      if (field) {
        values = fields.get(field[1]) ?? [];
        values.push(field[2].trimEnd());
        fields.set(field[1], values);
      } else if (values && /^ {6}\S/.test(line)) {
        values[values.length - 1] += ` ${line.trim()}`;
      }
    }
    const pmid = fields.get('PMID')?.[0];
    const title = fields.get('TI')?.[0];
    if (!pmid || !title) return [];
    const ids = [...fields.get('AID') ?? [], ...fields.get('LID') ?? []];
    return [{
      pmid, title, doi: ids.find(id => id.endsWith(' [doi]'))?.slice(0, -6) ?? '',
      journal: fields.get('JT')?.[0] ?? fields.get('TA')?.[0] ?? '',
      year: Number(fields.get('DP')?.[0]?.slice(0, 4) ?? 0),
      abstract: fields.get('AB')?.join('\n') ?? '', abstractKind: 'publisher' as const,
    }];
  });
}

async function searchNcbi(query: string, count: number, signal: AbortSignal, pmid?: string, credential?: string): Promise<Article[]> {
  const searchUrl = queryUrl(`${ncbi}/esearch.fcgi`, { db: 'pubmed', term: query, retmax: count, retmode: 'json', ...(credential && { api_key: credential }) });
  const ids = pmid ? [pmid]
    : (await json<{ esearchresult: { idlist: string[] } }>(searchUrl, signal)).esearchresult.idlist;
  if (!ids.length) return [];
  const url = queryUrl(`${ncbi}/efetch.fcgi`, { db: 'pubmed', id: ids.join(','), rettype: 'medline', retmode: 'text', ...(credential && { api_key: credential }) });
  return parseMedline(await (await request(url, signal)).text());
}

async function searchArticles(
  europePmcQuery: string, ncbiQuery: string, count: number, signal: AbortSignal, pmid?: string, credential?: string,
): Promise<Article[]> {
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  try {
    return await Promise.any([
      searchEuropePmc(europePmcQuery, count, requestSignal),
      searchNcbi(ncbiQuery, count, requestSignal, pmid, credential),
    ]);
  } finally {
    controller.abort();
  }
}

async function findArticle(params: QueryParams, signal?: AbortSignal, credential?: string): Promise<Article | undefined> {
  const identifier = normalizeCitation(requiredParam(params, 'pmid', 'identifier', 'id', 'doi'));
  const isPmid = /^\d{1,9}$/.test(identifier);
  if (!isPmid && !/^10\.\d{4,9}\/[^"\s]+$/.test(identifier)) return undefined;
  const records = signal
    ? await searchArticles(isPmid ? `SRC:MED AND EXT_ID:${identifier}` : `SRC:MED AND DOI:"${identifier}"`,
      `"${identifier}"[AID]`, 5, signal, isPmid ? identifier : undefined, credential)
    : literatureFixtures;
  const article = records.find(entry => entry.pmid === identifier || entry.doi.toLowerCase() === identifier);
  return article ? { ...article } : undefined;
}

export const pubmed = defineConnector({
  ...ncbiCredential,
  id: 'pubmed', name: 'PubMed / Europe PMC', category: 'literature',
  description: 'Search biomedical papers, verify citations and retrieve abstracts.', endpoint: europePmc,
}, {
  async search(params, signal, credential) {
    const query = param(params, 'query', 'q', 'term');
    const count = limit(params);
    const data = signal
      ? await searchArticles(query ? `SRC:MED AND (${query})` : 'SRC:MED', query || 'all[sb]', count, signal, undefined, credential)
      : literatureFixtures.filter(article =>
        matches(query, article.title, article.abstract, article.journal, article.pmid, article.doi)).slice(0, count)
        .map(article => ({ ...article }));
    return result(data, `${data.length} PubMed articles`);
  },
  async verify_pmid(params, signal, credential) {
    const identifier = requiredParam(params, 'pmid', 'identifier', 'id', 'doi');
    const article = await findArticle(params, signal, credential);
    return result({ identifier, verified: Boolean(article), ...(article && { pmid: article.pmid, doi: article.doi, title: article.title }) },
      article ? `Verified PMID ${article.pmid}` : `No PubMed record found for ${identifier}`);
  },
  async fetch_abstract(params, signal, credential) {
    const article = await findArticle(params, signal, credential);
    return result(article ?? null, article?.title ?? 'No abstract record found');
  },
}, 4000);

interface Structure {
  pdbId: string;
  title: string;
  resolution: number | null;
  method: string;
  doi: string;
}

const structures: Array<Structure & { keywords: string }> = [
  { pdbId: '1M17', title: 'Epidermal Growth Factor Receptor tyrosine kinase domain with 4-anilinoquinazoline inhibitor erlotinib',
    resolution: 2.6, method: 'X-RAY DIFFRACTION', doi: '10.2210/pdb1M17/pdb', keywords: 'EGFR kinase erlotinib AQ4' },
  { pdbId: '1TUP', title: 'Tumor suppressor p53 complexed with DNA',
    resolution: 2.2, method: 'X-RAY DIFFRACTION', doi: '10.2210/pdb1TUP/pdb', keywords: 'TP53 p53 DNA zinc' },
  { pdbId: '6LU7', title: 'The crystal structure of COVID-19 main protease in complex with an inhibitor N3',
    resolution: 2.16, method: 'X-RAY DIFFRACTION', doi: '10.2210/pdb6LU7/pdb', keywords: 'SARS-CoV-2 Mpro 3CLpro' },
];

async function structureMetadata(pdbId: string, signal: AbortSignal): Promise<Structure> {
  const data = await json<{
    struct: { title: string };
    rcsb_entry_info?: { resolution_combined?: number[] };
    exptl?: Array<{ method: string }>;
  }>(`${rcsbData}/${encodeURIComponent(pdbId)}`, signal);
  return { pdbId, title: data.struct.title, resolution: data.rcsb_entry_info?.resolution_combined?.[0] ?? null,
    method: data.exptl?.[0]?.method ?? '', doi: `10.2210/pdb${pdbId}/pdb` };
}

export const rcsbPdb = defineConnector({
  id: 'rcsb-pdb', name: 'RCSB Protein Data Bank', category: 'structural',
  description: 'Search experimental structures and download PDB coordinates.', endpoint: rcsbData,
}, {
  async search(params, signal) {
    const query = param(params, 'query', 'q', 'term', 'pdbId');
    const count = limit(params);
    if (!signal) {
      const entries = structures.filter(entry => matches(query, entry.pdbId, entry.title, entry.keywords))
        .slice(0, count).map(({ keywords: _keywords, ...entry }) => entry);
      return result(entries, `${entries.length} PDB entries`);
    }
    if (/^[0-9][a-z0-9]{3}$/i.test(query)) {
      return result([await structureMetadata(query.toUpperCase(), signal)], '1 PDB entry');
    }
    const response = await request(rcsbSearch, signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query ? { type: 'terminal', service: 'full_text', parameters: { value: query } }
          : { type: 'terminal', service: 'text' },
        return_type: 'entry',
        request_options: { paginate: { start: 0, rows: count }, results_verbosity: 'compact' },
      }),
    });
    const hits = response.status === 204 ? { result_set: [] } : await response.json() as { result_set: string[] };
    const entries = await Promise.all(hits.result_set.map(id => structureMetadata(id, signal)));
    return result(entries, `${entries.length} PDB entries`);
  },
  async fetch_structure(params, signal) {
    const id = requiredParam(params, 'pdbId', 'pdb_id', 'id', 'accession').toUpperCase();
    if (!/^[0-9][A-Z0-9]{3}$/.test(id)) throw new InvalidParameter('Expected a four-character PDB ID');
    const text = signal ? await (await request(`${rcsbFiles}/${id}.pdb`, signal)).text()
      : Object.hasOwn(structureFixtures, id) ? structureFixtures[id] : '';
    if (!/^ATOM  /m.test(text)) {
      if (signal) throw new Error(`No PDB coordinate records for ${id}`);
      return result(null, `No offline PDB structure for ${id}`);
    }
    return result(text, signal ? `PDB coordinates for ${id}` : `Deposited coordinate excerpt for ${id}`, 'pdb');
  },
});

interface UniProtRecord {
  primaryAccession: string;
  genes?: Array<{ geneName?: { value: string } }>;
  organism: { scientificName: string };
  proteinDescription: {
    recommendedName?: { fullName: { value: string } };
    submissionNames?: Array<{ fullName: { value: string } }>;
  };
  sequence: { value: string; length: number };
  features?: Array<{ type: string; description: string; location: { start: { value?: number }; end: { value?: number } } }>;
  comments?: Array<{ commentType: string; texts?: Array<{ value: string }> }>;
}

function protein(entry: UniProtRecord) {
  return {
    accession: entry.primaryAccession,
    gene: entry.genes?.[0]?.geneName?.value ?? '',
    name: entry.proteinDescription.recommendedName?.fullName.value
      ?? entry.proteinDescription.submissionNames?.[0]?.fullName.value ?? entry.primaryAccession,
    organism: entry.organism.scientificName,
    sequence: entry.sequence.value,
    length: entry.sequence.length,
    domains: (entry.features ?? []).flatMap(({ type, description, location }) => {
      const { start, end } = location;
      return ['Domain', 'DNA binding', 'Transmembrane', 'Zinc finger', 'Region'].includes(type)
        && start.value !== undefined && end.value !== undefined
        ? [{ type, name: description, start: start.value, end: end.value }] : [];
    }),
    function: entry.comments?.find(comment => comment.commentType === 'FUNCTION')?.texts?.map(text => text.value).join(' ') ?? '',
  };
}

export const uniprot = defineConnector({
  id: 'uniprot', name: 'UniProtKB', category: 'protein',
  description: 'Retrieve protein sequences, domains and functional annotations.', endpoint: uniprotApi,
}, {
  async search(params, signal) {
    const query = param(params, 'query', 'q', 'term', 'accession', 'gene');
    const count = limit(params);
    const entries = signal
      ? (await json<{ results: UniProtRecord[] }>(queryUrl(`${uniprotApi}/search`, {
        query: query || 'reviewed:true', size: count, format: 'json',
      }), signal)).results.map(protein)
      : structuredClone(proteinFixtures.filter(entry => matches(query, entry.accession, entry.gene,
        entry.name, entry.organism, entry.function ?? '')).slice(0, count));
    return result(entries, `${entries.length} UniProt entries`);
  },
  async fetch_entry(params, signal) {
    const accession = requiredParam(params, 'accession', 'uniprotId', 'id', 'gene').toUpperCase();
    const fixture = proteinFixtures.find(entry => entry.accession === accession || entry.gene === accession);
    const entry = signal
      ? protein(await json<UniProtRecord>(`${uniprotApi}/${encodeURIComponent(fixture?.accession ?? accession)}.json`, signal))
      : structuredClone(fixture);
    return result(entry ?? null, entry ? `${entry.name} (${entry.accession})` : `No offline UniProt entry for ${accession}`);
  },
});

interface Activity {
  activityId: number | string;
  assayId: string | null;
  compoundId: string;
  targetId: string | null;
  target: string | null;
  type: string | null;
  relation: string | null;
  value: number | null;
  units: string | null;
  description: string | null;
  documentId: string | null;
}

interface ChemblActivity {
  activity_id: number;
  assay_chembl_id: string | null;
  molecule_chembl_id: string;
  target_chembl_id: string | null;
  target_pref_name: string | null;
  standard_type: string | null;
  standard_relation: string | null;
  standard_value: string | null;
  standard_units: string | null;
  assay_description: string | null;
  document_chembl_id: string | null;
}

interface ChemblMolecule {
  molecule_chembl_id: string;
  pref_name: string | null;
  molecule_structures?: { canonical_smiles: string } | null;
  molecule_properties?: { full_mwt: string | null; alogp: string | null } | null;
}

function compound(entry: ChemblMolecule) {
  return {
    id: entry.molecule_chembl_id, name: entry.pref_name ?? entry.molecule_chembl_id,
    smiles: entry.molecule_structures?.canonical_smiles ?? null,
    molecularWeight: entry.molecule_properties?.full_mwt != null ? Number(entry.molecule_properties.full_mwt) : null,
    logP: entry.molecule_properties?.alogp != null ? Number(entry.molecule_properties.alogp) : null,
  };
}

async function activities(params: Record<string, string | number>, signal: AbortSignal): Promise<Activity[]> {
  const data = await json<{ activities: ChemblActivity[] }>(queryUrl(`${chemblApi}/activity.json`, params), signal);
  return data.activities.map(a => ({
    activityId: a.activity_id, assayId: a.assay_chembl_id, compoundId: a.molecule_chembl_id, targetId: a.target_chembl_id,
    target: a.target_pref_name, type: a.standard_type, relation: a.standard_relation,
    value: a.standard_value === null ? null : Number(a.standard_value), units: a.standard_units,
    description: a.assay_description, documentId: a.document_chembl_id,
  }));
}

const activityColumns = [
  'activityId', 'assayId', 'compoundId', 'targetId', 'target', 'type', 'relation', 'value', 'units', 'description', 'documentId',
] as const;

function activityCsv(rows: Activity[]): string {
  return [activityColumns.join(','), ...rows.map(row => activityColumns.map(column => {
    const text = String(row[column] ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(','))].join('\n');
}

export const chembl = defineConnector({
  id: 'chembl', name: 'ChEMBL', category: 'chemistry',
  description: 'Search compounds, retrieve bioactivity records and export bulk assay CSV.', endpoint: chemblApi,
}, {
  async search_compound(params, signal) {
    const query = param(params, 'query', 'q', 'name', 'compound', 'chemblId', 'compoundId', 'id');
    const count = limit(params);
    const entries = signal
      ? /^CHEMBL\d+$/i.test(query)
        ? [compound(await json<ChemblMolecule>(`${chemblApi}/molecule/${query.toUpperCase()}.json`, signal))]
        : (await json<{ molecules: ChemblMolecule[] }>(queryUrl(
          `${chemblApi}/${query ? 'molecule/search.json' : 'molecule.json'}`, { ...(query && { q: query }), limit: count }), signal))
          .molecules.map(compound)
      : compoundFixtures.filter(entry => matches(query, entry.id, entry.name,
        ...entry.activities.flatMap(a => [a.target, a.description])))
        .slice(0, count).map(({ activities: _activities, ...entry }) => entry);
    return result(entries, `${entries.length} ChEMBL compounds`);
  },
  async bioactivity(params, signal) {
    const query = requiredParam(params, 'chemblId', 'compoundId', 'molecule_chembl_id', 'id', 'compound', 'name', 'query');
    const fixture = compoundFixtures.find(entry => [entry.id, entry.name].some(value => value.toLowerCase() === query.toLowerCase()));
    const id = fixture?.id ?? query.toUpperCase();
    const count = limit(params);
    if (signal && !/^CHEMBL\d+$/.test(id)) throw new InvalidParameter('Expected a ChEMBL molecule ID or a curated compound name');
    const rows = signal
      ? await activities({ molecule_chembl_id: id, standard_type: 'IC50', limit: count }, signal)
      : structuredClone(fixture?.activities.slice(0, count) ?? []);
    return result(rows, `${rows.length} IC50 assay records for ${id}`);
  },
  async bulk_assay(params, signal) {
    const count = Math.max(201, limit(params, 250, 1000));
    if (signal) {
      const rows = await activities({ target_chembl_id: 'CHEMBL203', standard_type: 'IC50',
        standard_units: 'nM', limit: count }, signal);
      if (rows.length <= 200) throw new Error('Insufficient ChEMBL data for a bulk export');
      return result(activityCsv(rows), `${rows.length} ChEMBL EGFR IC50 assay records`, 'csv');
    }
    const templates = compoundFixtures.flatMap(entry => entry.activities);
    const rows = Array.from({ length: count }, (_, i): Activity => ({
      ...templates[i % templates.length], activityId: `DEMO-${i + 1}`, assayId: null, documentId: null,
      description: 'Synthetic demo row using a curated IC50 value',
    }));
    return result(activityCsv(rows), `${rows.length} synthetic demo rows using curated assay values`, 'csv');
  },
});

interface EnsemblGene {
  id: string;
  display_name: string;
  assembly_name: string;
  seq_region_name: string;
  start: number;
  end: number;
  strand: number;
  Transcript?: Array<{
    id: string; start: number; end: number; strand: number; biotype: string; is_canonical?: number;
    Exon?: Array<{ id: string; start: number; end: number }>;
  }>;
}

function normalizeGene(gene: EnsemblGene) {
  return {
    id: gene.id, symbol: gene.display_name, assembly: gene.assembly_name, chromosome: gene.seq_region_name,
    start: gene.start, end: gene.end, strand: gene.strand,
    transcripts: (gene.Transcript ?? []).map(t => ({
      id: t.id, start: t.start, end: t.end, strand: t.strand, biotype: t.biotype, canonical: Boolean(t.is_canonical),
      exons: (t.Exon ?? []).map(({ id, start, end }) => ({ id, start, end })),
    })),
  };
}

async function findGene(params: QueryParams, signal?: AbortSignal) {
  const input = requiredParam(params, 'gene', 'symbol', 'geneId', 'id', 'query');
  const lookup = input.toUpperCase();
  if (!signal) return structuredClone(geneFixtures.find(gene => gene.symbol === lookup || gene.id === lookup.split('.')[0]));
  const path = /^ENSG\d+(\.\d+)?$/.test(lookup) ? `id/${lookup.split('.')[0]}`
    : `symbol/homo_sapiens/${encodeURIComponent(lookup)}`;
  return normalizeGene(await json<EnsemblGene>(queryUrl(`${ensemblApi}/lookup/${path}`,
    { expand: 1, 'content-type': 'application/json' }), signal));
}

function coverageTracks(gene: ReturnType<typeof normalizeGene>) {
  const canonical = gene.transcripts.find(t => t.canonical) ?? gene.transcripts[0];
  const exons = canonical?.exons ?? [];
  const promoter = gene.strand === -1 ? canonical?.end ?? gene.end : canonical?.start ?? gene.start;
  const width = Math.max(1, Math.ceil((gene.end - gene.start + 1) / 64));
  const bins = Array.from({ length: Math.ceil((gene.end - gene.start + 1) / width) }, (_, i) => {
    const start = gene.start + width * i;
    return { start, end: Math.min(gene.end, start + width - 1) };
  });
  return [
    { id: 'chip-seq', label: 'Simulated ChIP-seq coverage', type: 'coverage', simulated: true,
      values: bins.map(({ start, end }, i) => ({ start, end,
        value: Math.round((i % 5) + 55 * Math.exp(-((((start + end) / 2 - promoter) / (2 * width)) ** 2))) })) },
    { id: 'rna-seq', label: 'Simulated RNA-seq coverage', type: 'coverage', simulated: true,
      values: bins.map(({ start, end }, i) => ({ start, end,
        value: i % 4 + (exons.some(e => e.start <= end && e.end >= start) ? 18 + (i * 11) % 44 : 0) })) },
  ];
}

export const ensembl = defineConnector({
  id: 'ensembl', name: 'Ensembl', category: 'genomics',
  description: 'Look up human genes, transcripts and genome track intervals.', endpoint: ensemblApi,
}, {
  async fetch_gene(params, signal) {
    const gene = await findGene(params, signal);
    return result(gene ?? null, gene ? `${gene.symbol} ${gene.assembly} gene and transcripts` : 'No offline Ensembl gene match');
  },
  async genome_track(params, signal) {
    const gene = await findGene(params, signal);
    if (!gene) return result(null, 'No offline Ensembl track match');
    const tracks = coverageTracks(gene);
    return result({ ...gene, coordinateSystem: '1-based-inclusive', tracks },
      `${gene.symbol} chr${gene.chromosome}:${gene.start}-${gene.end}; transcripts and simulated coverage tracks`);
  },
});

type NcbiSummaryDb = 'clinvar' | 'gds';

async function ncbiIds(db: NcbiSummaryDb, term: string, count: number, signal: AbortSignal, credential?: string): Promise<string[]> {
  const url = queryUrl(`${ncbi}/esearch.fcgi`, { db, term, retmax: count, retmode: 'json', ...(credential && { api_key: credential }) });
  const payload = await json<{ esearchresult: { idlist: string[] } }>(url, signal);
  if (!Array.isArray(payload.esearchresult?.idlist)) throw new Error(`Missing NCBI ${db} search results`);
  return payload.esearchresult.idlist;
}

async function ncbiSummaries<T extends { error?: string }>(
  db: NcbiSummaryDb, ids: string[], signal: AbortSignal, credential?: string,
): Promise<T[]> {
  if (!ids.length) return [];
  const url = queryUrl(`${ncbi}/esummary.fcgi`, { db, id: ids.join(','), retmode: 'json', ...(credential && { api_key: credential }) });
  const { result } = await json<{ result: Record<string, T> & { uids: string[] } }>(url, signal);
  if (!Array.isArray(result?.uids)) throw new Error(`Missing NCBI ${db} summaries`);
  return ids.flatMap(id => {
    const record = result[id];
    return record && !record.error ? [record] : [];
  });
}

interface ClinvarClassification {
  description?: string;
  review_status?: string;
  trait_set?: Array<{ trait_name?: string }>;
}

interface ClinvarSummary {
  error?: string;
  uid: string;
  accession: string;
  title: string;
  genes?: Array<{ symbol: string }>;
  germline_classification?: ClinvarClassification;
  clinical_impact_classification?: ClinvarClassification;
  oncogenicity_classification?: ClinvarClassification;
  clinical_significance?: ClinvarClassification;
}

function clinicalVariant(record: ClinvarSummary): ClinicalVariant {
  if (!record.uid || !record.accession || !record.title) throw new Error('Invalid ClinVar variant summary');
  const classifications = [
    ['germline', record.germline_classification],
    ['somatic-clinical-impact', record.clinical_impact_classification],
    ['somatic-oncogenicity', record.oncogenicity_classification],
    [null, record.clinical_significance],
  ] as const;
  const [classificationType, classification] = classifications.find(([, value]) => value?.description) ?? [null, undefined];
  const conditions = classification?.trait_set?.flatMap(trait => trait.trait_name ? [trait.trait_name] : []) ?? [];
  return {
    variationId: record.uid, accession: record.accession, variant: record.title,
    gene: record.genes?.map(gene => gene.symbol).filter(Boolean).join(', ') || /\(([^()]+)\):/.exec(record.title)?.[1] || '',
    clinicalSignificance: classification?.description ?? '', reviewStatus: classification?.review_status ?? '',
    condition: [...new Set(conditions)].join('; '), classificationType,
  };
}

function variantId(input: string): string | undefined {
  return /^(?:VCV0*([1-9]\d*)(?:\.\d+)?|(?:variation\s+id\s*:?\s*)?0*([1-9]\d*))$/i.exec(input)?.slice(1).find(Boolean);
}

function findClinvarFixture(input: string) {
  const id = variantId(input);
  if (id) return clinvarFixtures.find(entry => entry.variationId === id);
  const shorthand = (value: string) => value.toLowerCase().replace(/\bp\./g, '').replace(/\s+/g, '');
  const lookup = shorthand(input);
  return clinvarFixtures.find(entry => {
    const hgvs = /:(\S+) \(([^()]+)\)$/.exec(entry.variant)?.slice(1) ?? [];
    return [entry.alias, entry.variant, ...hgvs].some(candidate =>
      shorthand(candidate) === lookup || shorthand(`${entry.gene} ${candidate}`) === lookup);
  });
}

function curatedVariant({ alias: _alias, ...entry }: (typeof clinvarFixtures)[number]): ClinicalVariant {
  return entry;
}

async function clinvarRecords(ids: string[], signal: AbortSignal, credential?: string): Promise<ClinicalVariant[]> {
  return (await ncbiSummaries<ClinvarSummary>('clinvar', ids, signal, credential)).map(clinicalVariant);
}

export const clinvar = defineConnector({
  ...ncbiCredential,
  id: 'clinvar', name: 'NCBI ClinVar', category: 'clinical',
  description: 'Search human clinical variants and retrieve ClinVar classification summaries.', endpoint: 'https://www.ncbi.nlm.nih.gov/clinvar/',
}, {
  async search_variants(params, signal, credential) {
    const query = param(params, 'query', 'q', 'term', 'variant', 'variationId', 'id', 'gene');
    const count = limit(params);
    const id = variantId(query) ?? findClinvarFixture(query)?.variationId;
    const data = signal
      ? await clinvarRecords(id ? [id] : await ncbiIds('clinvar', query || 'all[filter]', count, signal, credential), signal, credential)
      : clinvarFixtures.filter(entry => id ? entry.variationId === id : matches(query,
        entry.gene, entry.variant, entry.alias, entry.clinicalSignificance, entry.condition, entry.accession, entry.variationId))
        .slice(0, count).map(curatedVariant);
    return result(data, `${data.length} ClinVar variants`);
  },
  async fetch_variant(params, signal, credential) {
    const input = requiredParam(params, 'variationId', 'variation_id', 'id', 'accession', 'variant', 'query');
    const fixture = findClinvarFixture(input);
    if (!signal) {
      return result(fixture ? curatedVariant(fixture) : null, fixture?.variant ?? `No ClinVar record found for ${input}`);
    }
    const id = variantId(input) ?? fixture?.variationId;
    const ids = id ? [id] : await ncbiIds('clinvar', `"${input.replaceAll('"', '')}"[varnam]`, 2, signal, credential);
    if (ids.length > 1) throw new InvalidParameter('Multiple ClinVar records matched; provide a Variation ID or VCV accession');
    const [data] = await clinvarRecords(ids, signal, credential);
    return result(data ?? null, data?.variant ?? `No ClinVar record found for ${input}`);
  },
});

interface GeoSummary {
  error?: string;
  accession: string;
  title: string;
  taxon?: string;
  gpl?: string | number;
  n_samples?: string | number;
  summary?: string;
}

function geoSeries(record: GeoSummary): GeoSeries {
  if (!record.title) throw new Error('Invalid GEO Series summary');
  const sampleCount = Number(record.n_samples ?? NaN);
  return {
    accession: record.accession, title: record.title, organism: record.taxon ?? '',
    platform: (String(record.gpl ?? '').match(/\d+/g) ?? []).map(id => `GPL${id}`).join(', '),
    sampleCount: Number.isSafeInteger(sampleCount) && sampleCount >= 0 ? sampleCount : null,
    summary: record.summary ?? '',
  };
}

async function searchGeo(query: string, count: number, signal: AbortSignal, credential?: string): Promise<GeoSeries[]> {
  const term = /^GSE\d+$/i.test(query) ? `${query.toUpperCase()}[ACCN]` : query;
  const ids = await ncbiIds('gds', term ? `(${term}) AND gse[ETYP]` : 'gse[ETYP]', count, signal, credential);
  const summaries = await ncbiSummaries<GeoSummary>('gds', ids, signal, credential);
  return summaries.filter(record => /^GSE\d+$/.test(record.accession)).map(geoSeries);
}

export const geo = defineConnector({
  ...ncbiCredential,
  id: 'geo', name: 'NCBI Gene Expression Omnibus', category: 'genomics',
  description: 'Search GEO expression studies and retrieve Series metadata.', endpoint: 'https://www.ncbi.nlm.nih.gov/geo/',
}, {
  async search_series(params, signal, credential) {
    const query = param(params, 'query', 'q', 'term', 'accession');
    const count = limit(params);
    const data = signal ? await searchGeo(query, count, signal, credential) : geoFixtures
      .filter(entry => matches(query, entry.accession, entry.title, entry.organism, entry.platform, entry.summary, entry.keywords))
      .slice(0, count).map(({ keywords: _keywords, ...entry }) => entry);
    return result(data, `${data.length} GEO series`);
  },
  async fetch_series(params, signal, credential) {
    const accession = requiredParam(params, 'accession', 'seriesId', 'series_id', 'id', 'query').toUpperCase();
    if (!/^GSE\d+$/.test(accession)) throw new InvalidParameter('Expected a GEO Series accession (GSE followed by digits)');
    const records = signal ? await searchGeo(accession, 5, signal, credential)
      : geoFixtures.map(({ keywords: _keywords, ...entry }) => entry);
    const data = records.find(record => record.accession === accession);
    return result(data ?? null, data?.title ?? `No GEO Series record found for ${accession}`);
  },
});

interface EuropePmcPreprint extends EuropePmcHit {
  bookOrReportDetails?: { publisher?: string };
  authorString?: string;
  authorList?: { author?: Array<{ fullName?: string; collectiveName?: string }> };
}

function preprintServer(value: string | undefined): PreprintServer | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'biorxiv') return 'bioRxiv';
  if (normalized === 'medrxiv') return 'medRxiv';
}

async function searchPreprints(
  query: string, count: number, server: PreprintServer | undefined, signal: AbortSignal,
): Promise<Preprint[]> {
  const provider = server ? `PUBLISHER:"${server}"` : '(PUBLISHER:"bioRxiv" OR PUBLISHER:"medRxiv")';
  const term = /^10\.\d{4,9}\/[^"\s]+$/.test(query) ? `DOI:"${query}"` : query;
  const url = queryUrl(europePmc, {
    query: `SRC:PPR AND ${provider}${term ? ` AND (${term})` : ''}`,
    format: 'json', resultType: 'core', pageSize: count,
  });
  const payload = await json<{ resultList: { result: EuropePmcPreprint[] } }>(url, signal);
  return payload.resultList.result.flatMap(hit => {
    const publisher = preprintServer(hit.bookOrReportDetails?.publisher) ?? preprintServer(hit.journalTitle) ?? server;
    if (!publisher || (server && publisher !== server) || !hit.doi || !hit.title) return [];
    const authors = hit.authorList?.author?.map(author => author.fullName || author.collectiveName || '').filter(Boolean) ?? [];
    return [{
      doi: hit.doi, title: hit.title.replace(/<[^>]*>/g, ''), server: publisher,
      authors: authors.length ? authors : (hit.authorString?.split(/,\s*/).filter(Boolean) ?? []),
      abstract: hit.abstractText ?? '', abstractKind: 'publisher' as const,
    }];
  });
}

export const arxivBiorxiv = defineConnector({
  id: 'arxiv-biorxiv', name: 'bioRxiv / medRxiv', category: 'literature',
  description: 'Search bioRxiv and medRxiv preprint metadata and abstracts via Europe PMC.', endpoint: europePmc,
}, {
  async search_preprints(params, signal) {
    const input = param(params, 'query', 'q', 'term', 'doi');
    const identifier = normalizeCitation(input);
    const query = identifier.startsWith('10.') ? identifier : input;
    const serverParam = param(params, 'server');
    const server = preprintServer(serverParam);
    if (serverParam && !server) throw new InvalidParameter('Expected bioRxiv or medRxiv');
    const count = limit(params);
    const data = signal ? await searchPreprints(query, count, server, signal) : structuredClone(preprintFixtures
      .filter(entry => (!server || server === entry.server)
        && matches(query, entry.doi, entry.title, entry.server, entry.abstract, ...entry.authors))
      .slice(0, count));
    return result(data, `${data.length} preprints`);
  },
});

export const builtInConnectors: readonly ScientificConnector[] = [
  pubmed, rcsbPdb, uniprot, chembl, ensembl, clinvar, geo, arxivBiorxiv,
  stringDb, kegg, reactome, alphafoldDb, cbioportal, openTargets, pubchem, elnBenchling,
  clinicaltrials, openalex, zotero,
];
