import { defineConnector, InvalidParameter, limit, matches, param, queryUrl, request, result } from './connectorSupport.js';
import { identifiers } from './enrichment.js';

const api = 'https://www.cbioportal.org/api';
const genes = [
  { symbol: 'EGFR', entrezGeneId: 1956 }, { symbol: 'TP53', entrezGeneId: 7157 },
  { symbol: 'KRAS', entrezGeneId: 3845 }, { symbol: 'PIK3CA', entrezGeneId: 5290 }, { symbol: 'BRCA1', entrezGeneId: 672 },
] as const;

interface Study {
  studyId: string;
  name: string;
  description: string;
  cancerTypeId: string;
  allSampleCount?: number;
  citation?: string;
  pmid?: string;
}

const studies: Study[] = [
  {
    studyId: 'luad_tcga_pan_can_atlas_2018', name: 'Lung Adenocarcinoma (TCGA, PanCancer Atlas)',
    description: 'TCGA PanCancer Atlas lung adenocarcinoma cohort.', cancerTypeId: 'luad',
    allSampleCount: 566, citation: 'TCGA PanCancer Atlas',
  },
  {
    studyId: 'brca_tcga_pan_can_atlas_2018', name: 'Breast Invasive Carcinoma (TCGA, PanCancer Atlas)',
    description: 'TCGA PanCancer Atlas breast invasive carcinoma cohort.', cancerTypeId: 'brca',
    allSampleCount: 1084, citation: 'TCGA PanCancer Atlas',
  },
  {
    studyId: 'msk_impact_2017', name: 'MSK-IMPACT Clinical Sequencing Cohort (Zehir et al. 2017)',
    description: 'Clinical sequencing of advanced solid tumors with the MSK-IMPACT targeted panel.', cancerTypeId: 'mixed',
    allSampleCount: 10945, citation: 'Zehir et al., Nature Medicine, 2017', pmid: '28481359',
  },
];

// Patient-level SNV/small-indel counts derived from the TCGA cBioPortal data for these releases.
// See the linked summaries for denominators and filtering. Omitted gene/cohort pairs are unknown.
const snapshots = new Map([
  ['luad_tcga_pan_can_atlas_2018', {
    profiledCount: 566, counts: new Map([['EGFR', 69], ['TP53', 287], ['KRAS', 168]]),
    sourceUrl: 'https://usebiotransfer.org/disease/lung-cancer/mutations/',
  }],
  ['brca_tcga_pan_can_atlas_2018', {
    profiledCount: 1066, counts: new Map([['TP53', 346], ['PIK3CA', 346], ['BRCA1', 27]]),
    sourceUrl: 'https://usebiotransfer.org/disease/breast-cancer/mutations/',
  }],
]);

// Rounded patient percentages reported in Zehir et al. Figure 2c and the accompanying text.
const mskPublishedPercent = new Map([['TP53', 41], ['KRAS', 15]]);

function studyUrl(studyId: string) {
  return queryUrl('https://www.cbioportal.org/study/summary', { id: studyId }).href;
}

function pathId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/.test(value)) throw new InvalidParameter('Invalid cBioPortal study, profile or sample list ID');
  return value;
}

async function portalJson<T>(url: string | URL, signal: AbortSignal, credential?: string, data?: unknown): Promise<T> {
  const response = await request(url, signal, {
    headers: {
      Accept: 'application/json',
      ...(credential && { Authorization: `Bearer ${credential}` }),
      ...(data !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
  });
  return await response.json() as T;
}

interface Gene { symbol: string; entrezGeneId: number }
interface PanelAssignment { sampleId: string; profiled: boolean; genePanelId?: string }
interface Panel { genes: Array<{ entrezGeneId: number }> }
interface Mutation { sampleId: string; entrezGeneId: number }

async function liveGenes(symbols: string[], signal: AbortSignal, credential?: string): Promise<Gene[]> {
  const known = genes.filter(gene => symbols.includes(gene.symbol));
  const unknown = symbols.filter(symbol => !known.some(gene => gene.symbol === symbol));
  if (!unknown.length) return known;
  const rows = await portalJson<Array<{ hugoGeneSymbol: string; entrezGeneId: number }>>(
    queryUrl(`${api}/genes/fetch`, { geneIdType: 'HUGO_GENE_SYMBOL' }), signal, credential, unknown);
  return [...known, ...rows.map(row => ({ symbol: row.hugoGeneSymbol, entrezGeneId: row.entrezGeneId }))];
}

function frequency(alteredCount: number | null, profiledCount: number | null) {
  const proportion = alteredCount != null && profiledCount ? alteredCount / profiledCount : null;
  return { alteredCount, profiledCount, frequency: proportion, frequencyPercent: proportion === null ? null : proportion * 100 };
}

async function liveAlterations(profileId: string, sampleListId: string, symbols: string[], signal: AbortSignal, credential?: string) {
  const profile = `${api}/molecular-profiles/${profileId}`;
  const [geneRows, assignments, sampleIds] = await Promise.all([
    liveGenes(symbols, signal, credential),
    portalJson<PanelAssignment[]>(queryUrl(`${profile}/gene-panel-data`, { sampleListId }), signal, credential),
    portalJson<string[]>(`${api}/sample-lists/${sampleListId}/sample-ids`, signal, credential),
  ]);
  if (!Array.isArray(assignments) || !Array.isArray(sampleIds)) throw new Error('Invalid cBioPortal sample metadata');
  if (!geneRows.length) return [];
  const requestedSamples = new Set(sampleIds);
  const profiled = new Map(assignments.filter(row => row.profiled && requestedSamples.has(row.sampleId))
    .map(row => [row.sampleId, row.genePanelId]));
  if (sampleIds.length && !profiled.size) throw new Error('Missing cBioPortal gene panel coverage');
  const panelIds = [...new Set([...profiled.values()].filter((id): id is string => Boolean(id)))];
  const [mutations, panels] = await Promise.all([
    portalJson<Mutation[]>(queryUrl(`${profile}/mutations/fetch`, { projection: 'SUMMARY' }), signal, credential,
      { sampleListId, entrezGeneIds: geneRows.map(gene => gene.entrezGeneId) }),
    Promise.all(panelIds.map(async id => {
      const panel = await portalJson<Panel>(`${api}/gene-panels/${encodeURIComponent(id)}?projection=DETAILED`, signal, credential);
      if (!panel.genes?.length) throw new Error('Missing genes in cBioPortal panel');
      return [id, new Set(panel.genes.map(gene => gene.entrezGeneId))] as const;
    })),
  ]);
  const coverage = new Map(panels);
  return geneRows.map(({ symbol, entrezGeneId }) => {
    // A profiled sample without an assigned panel uses the profile-wide gene coverage.
    const callable = new Set([...profiled].flatMap(([sampleId, panel]) =>
      !panel || coverage.get(panel)?.has(entrezGeneId) ? [sampleId] : []));
    const altered = new Set(mutations.filter(row => row.entrezGeneId === entrezGeneId && callable.has(row.sampleId))
      .map(row => row.sampleId));
    return { gene: symbol, entrezGeneId, measure: 'mutation', unit: 'sample', ...frequency(altered.size, callable.size) };
  });
}

export const cbioportal = defineConnector({
  supportsCredential: true, credentialLabel: 'cBioPortal Auth Token',
  id: 'cbioportal', name: 'cBioPortal for Cancer Genomics', category: 'clinical',
  description: 'List oncology studies and estimate gene mutation frequencies with profiled denominators.', endpoint: api,
}, {
  async list_studies(params, signal, credential) {
    const query = param(params, 'query', 'q', 'name', 'studyId', 'cancerType');
    const count = limit(params);
    const rows = signal
      ? await portalJson<Study[]>(queryUrl(`${api}/studies`, { projection: 'DETAILED', pageSize: query ? 10000 : count }), signal, credential)
      : studies;
    const data = rows.filter(row => matches(query, row.studyId, row.name, row.cancerTypeId, row.description))
      .slice(0, count).map(row => ({ ...row, url: studyUrl(row.studyId) }));
    return result(data, `${data.length} cBioPortal oncology studies`);
  },
  async gene_alterations(params, signal, credential) {
    const studyId = pathId(param(params, 'studyId', 'study', 'id') || studies[0].studyId);
    const hasGeneQuery = ['genes', 'geneSymbols', 'gene', 'symbol', 'query'].some(key => params[key] !== undefined);
    const symbols = hasGeneQuery ? identifiers(params, 'genes', 'geneSymbols', 'gene', 'symbol', 'query') : genes.map(gene => gene.symbol);
    const profileId = pathId(param(params, 'molecularProfileId', 'profileId') || `${studyId}_mutations`);
    const sampleListId = pathId(param(params, 'sampleListId') || `${studyId}_sequenced`);
    const selected = symbols.slice(0, limit(params));
    if (signal) {
      const alterations = await liveAlterations(profileId, sampleListId, selected, signal, credential);
      const unmappedGenes = selected.filter(gene => !alterations.some(row => row.gene === gene));
      return result({ studyId, profileId, sampleListId, alterations, unmappedGenes, url: studyUrl(studyId) },
        `${alterations.length} cBioPortal mutation frequency rows`);
    }
    const isDefaultCohort = profileId === `${studyId}_mutations` && sampleListId === `${studyId}_sequenced`;
    const snapshot = isDefaultCohort ? snapshots.get(studyId) : undefined;
    const alterations = selected.flatMap(gene => {
      const count = snapshot?.counts.get(gene);
      const entrezGeneId = genes.find(entry => entry.symbol === gene)?.entrezGeneId;
      if (count !== undefined && snapshot) return [{
        gene, entrezGeneId, measure: 'SNV / small indel', unit: 'patient', ...frequency(count, snapshot.profiledCount),
        sourceUrl: snapshot.sourceUrl,
      }];
      const published = studyId === 'msk_impact_2017' && isDefaultCohort ? mskPublishedPercent.get(gene) : undefined;
      if (published !== undefined) return [{
        gene, entrezGeneId, measure: 'published aggregate alterations', unit: 'patient',
        ...frequency(null, null), frequency: published / 100, frequencyPercent: published, rounded: true,
        sourceUrl: 'https://doi.org/10.1038/nm.4333',
      }];
      return [];
    });
    const unavailableGenes = selected.filter(gene => !alterations.some(row => row.gene === gene));
    return result({ studyId, profileId, sampleListId, alterations, unavailableGenes, url: studyUrl(studyId) },
      `${alterations.length} curated cBioPortal frequency rows`);
  },
}, 4000);
