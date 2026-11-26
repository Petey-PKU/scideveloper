import { defineConnector, limit, request, requiredParam, result, type QueryParams } from './connectorSupport.js';

const api = 'https://api.platform.opentargets.org/api/v4/graphql';
const nsclc = { id: 'EFO_0003060', name: 'Non-small cell lung carcinoma' };
const luad = { id: 'EFO_0000571', name: 'Lung adenocarcinoma' };
const colorectal = { id: 'EFO_1001951', name: 'Colorectal carcinoma' };
const breast = { id: 'EFO_0000305', name: 'Breast carcinoma' };
const liFraumeni = { id: 'MONDO_0018875', name: 'Li-Fraumeni syndrome' };
const hereditaryBrca = { id: 'MONDO_0012933', name: 'Hereditary breast–ovarian cancer syndrome' };

type Disease = { id: string; name: string };
type Channel = 'genetic' | 'somatic' | 'drug';

function association(disease: Disease, channels: Channel[], sourceUrl: string) {
  // Presence flags describe curated evidence coverage. Platform aggregate scores are release-specific.
  return {
    disease, score: null, evidenceScores: {
      genetic: channels.includes('genetic') ? 1 : null,
      somatic: channels.includes('somatic') ? 1 : null,
      drug: channels.includes('drug') ? 1 : null,
    },
    sourceUrl,
  };
}

function approvedDrug(id: string, name: string, disease: Disease, mechanismOfAction: string, role: string, sourceUrl: string) {
  return { drug: { id, name }, disease, mechanismOfAction, role, phase: 4, status: 'Approved (US)', sourceUrl };
}

const lungEgf = 'https://www.fda.gov/drugs/cancer-approvals/fda-approves-osimertinib-chemotherapy-egfr-mutated-non-small-cell-lung-cancer';
const lumakras = 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2025/214665Orig1s009correctedlbl.pdf';

const targets = [
  {
    id: 'ENSG00000146648', symbol: 'EGFR',
    associations: [
      association(nsclc, ['somatic', 'drug'], lungEgf),
      association(luad, ['somatic'], 'https://pubmed.ncbi.nlm.nih.gov/15118073/'),
    ],
    drugs: [
      approvedDrug('CHEMBL3353410', 'Osimertinib', nsclc, 'EGFR kinase inhibitor', 'Direct target', lungEgf),
      approvedDrug('CHEMBL553', 'Erlotinib', nsclc, 'EGFR kinase inhibitor', 'Direct target',
        'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=021743'),
      approvedDrug('CHEMBL939', 'Gefitinib', nsclc, 'EGFR kinase inhibitor', 'Direct target',
        'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=206995'),
    ],
  },
  {
    id: 'ENSG00000141510', symbol: 'TP53',
    associations: [
      association(liFraumeni, ['genetic'], 'https://search.clinicalgenome.org/kb/genes/HGNC:11998'),
      association(breast, ['somatic'], 'https://www.cbioportal.org/study/summary?id=brca_tcga_pan_can_atlas_2018'),
    ],
    drugs: [],
  },
  {
    id: 'ENSG00000133703', symbol: 'KRAS',
    associations: [
      association(nsclc, ['somatic', 'drug'], lumakras),
      association(colorectal, ['somatic', 'drug'], 'https://www.fda.gov/drugs/cancer-approvals/fda-approves-sotorasib-panitumumab-kras-g12c-mutated-colorectal-cancer'),
    ],
    drugs: [
      approvedDrug('CHEMBL4535757', 'Sotorasib', nsclc, 'KRAS G12C inhibitor', 'Direct target, allele-specific', lumakras),
      approvedDrug('CHEMBL4535757', 'Sotorasib', colorectal, 'KRAS G12C inhibitor used with panitumumab',
        'Direct target, allele-specific', 'https://www.fda.gov/drugs/cancer-approvals/fda-approves-sotorasib-panitumumab-kras-g12c-mutated-colorectal-cancer'),
    ],
  },
  {
    id: 'ENSG00000012048', symbol: 'BRCA1',
    associations: [
      association(hereditaryBrca, ['genetic'], 'https://search.clinicalgenome.org/kb/genes/HGNC:1100'),
      association(breast, ['genetic', 'somatic', 'drug'], 'https://www.cbioportal.org/study/summary?id=brca_tcga_pan_can_atlas_2018'),
    ],
    drugs: [
      approvedDrug('CHEMBL521686', 'Olaparib', breast, 'PARP inhibitor', 'BRCA1 is a biomarker',
        'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=208558'),
      approvedDrug('CHEMBL3137320', 'Talazoparib', breast, 'PARP inhibitor', 'BRCA1 is a biomarker',
        'https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=211651'),
    ],
  },
];

interface Target { id: string; approvedSymbol: string }
interface Association {
  disease: Disease;
  score: number;
  datatypeScores: Array<{ id: string; score: number }>;
}
interface KnownDrug {
  drug: { id: string; name: string };
  disease: Disease;
  phase: number;
  status?: string;
  mechanismOfAction?: string;
}

async function graph<T>(query: string, variables: Record<string, string | number>, signal: AbortSignal): Promise<T> {
  const response = await request(api, signal, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as { data?: T; errors?: unknown[] };
  if (!payload.data || payload.errors?.length) throw new Error('Invalid Open Targets GraphQL response');
  return payload.data;
}

function targetInput(params: QueryParams) {
  return requiredParam(params, 'targetId', 'ensemblId', 'gene', 'symbol', 'target', 'id', 'query').toUpperCase().replace(/^(ENSG\d+)\.\d+$/, '$1');
}

function fixtureTarget(input: string) {
  return targets.find(target => target.id === input || target.symbol === input);
}

async function targetId(input: string, signal: AbortSignal) {
  if (/^ENSG\d{11}$/.test(input)) return input;
  const fixture = fixtureTarget(input);
  if (fixture) return fixture.id;
  const data = await graph<{ search: { hits: Array<{ id: string; name: string }> } }>(`
    query TargetSearch($input: String!) {
      search(queryString: $input, entityNames: ["target"], page: {index: 0, size: 10}) { hits { id name } }
    }`, { input }, signal);
  return data.search.hits.find(row => row.name.toUpperCase() === input && /^ENSG\d{11}$/.test(row.id))?.id ?? null;
}

function targetInfo(id: string, symbol: string) {
  return { targetId: id, symbol, url: `https://platform.opentargets.org/target/${id}` };
}

export const openTargets = defineConnector({
  id: 'opentargets', name: 'Open Targets Platform', category: 'clinical',
  description: 'Review target–disease evidence and drug relationships with clinical phases.', endpoint: api,
}, {
  async target_diseases(params, signal) {
    const input = targetInput(params);
    const count = limit(params);
    if (signal) {
      const id = await targetId(input, signal);
      const data = id ? await graph<{ target: (Target & { associatedDiseases: { rows: Association[] } }) | null }>(`
        query TargetDiseases($id: String!, $size: Int!) {
          target(ensemblId: $id) {
            id approvedSymbol
            associatedDiseases(page: {index: 0, size: $size}) {
              rows { disease { id name } score datatypeScores { id score } }
            }
          }
        }`, { id, size: count }, signal) : null;
      const target = data?.target;
      if (!target) return result(null, `No Open Targets target for ${input}`);
      const associations = target.associatedDiseases.rows.slice(0, count).map(row => {
        const scores = new Map(row.datatypeScores.map(type => [type.id, type.score]));
        return {
          disease: row.disease, score: row.score, evidenceScores: {
            genetic: scores.get('genetic_association') ?? null,
            somatic: scores.get('somatic_mutation') ?? null,
            drug: scores.get('known_drug') ?? null,
          },
        };
      });
      return result({
        ...targetInfo(target.id, target.approvedSymbol), scoreMethod: 'Open Targets association scores', associations,
      }, `${associations.length} Open Targets disease associations`);
    }
    const target = fixtureTarget(input);
    const data = target ? {
      ...targetInfo(target.id, target.symbol), scoreMethod: 'Curated evidence presence (1 = documented, null = uncurated)',
      associations: structuredClone(target.associations.slice(0, count)),
    } : null;
    return result(data, data ? `${data.associations.length} curated disease associations for ${data.symbol}` : `No offline target for ${input}`);
  },
  async known_drugs(params, signal) {
    const input = targetInput(params);
    const count = limit(params);
    if (signal) {
      const id = await targetId(input, signal);
      const data = id ? await graph<{ target: (Target & { knownDrugs?: { rows: KnownDrug[] } | null }) | null }>(`
        query TargetDrugs($id: String!, $size: Int!) {
          target(ensemblId: $id) {
            id approvedSymbol
            knownDrugs(size: $size) { rows { drug { id name } disease { id name } phase status mechanismOfAction } }
          }
        }`, { id, size: count }, signal) : null;
      const target = data?.target;
      if (!target) return result(null, `No Open Targets target for ${input}`);
      const drugs = target.knownDrugs?.rows.slice(0, count) ?? [];
      return result({ ...targetInfo(target.id, target.approvedSymbol), drugs },
        `${drugs.length} Open Targets drug–indication records`);
    }
    const target = fixtureTarget(input);
    const data = target ? { ...targetInfo(target.id, target.symbol), drugs: structuredClone(target.drugs.slice(0, count)) } : null;
    return result(data, data ? `${data.drugs.length} curated drug–indication records for ${data.symbol}` : `No offline target for ${input}`);
  },
}, 4000);
