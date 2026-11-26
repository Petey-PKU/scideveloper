import { defineConnector, InvalidParameter, json, requiredParam, result, type QueryParams } from './connectorSupport.js';
import { proteinFixtures } from './proteinFixtures.js';

const api = 'https://alphafold.ebi.ac.uk/api/prediction';
const fileServer = 'https://alphafold.ebi.ac.uk/files';

type Region = [
  name: string, start: number, end: number, qualitativeConfidence: string,
  meanPlddtApprox?: number, confidenceSource?: string,
];

// Version 6 model-level pLDDT from AlphaFold DB and the RCSB computed model records.
// Qualitative regional summaries describe the confidence coloring, using UniProt numbering.
const curated: Array<{
  accession: string; meanPlddt: number; fractions?: number[]; regions: Region[];
}> = [
  { accession: 'P00533', meanPlddt: 75.94, fractions: [0.228, 0.065, 0.233, 0.474], regions: [
    ['Extracellular region', 25, 645, 'Higher confidence in folded domains'],
    ['Protein kinase', 712, 979, 'Very high confidence across the folded core'],
    ['C-terminal tail', 980, 1210, 'Low confidence across much of the tail'],
  ] },
  { accession: 'P04637', meanPlddt: 75.06, fractions: [0.298, 0.104, 0.071, 0.527], regions: [
    ['N-terminal transactivation and proline-rich region', 1, 92, 'Low confidence across much of the region'],
    ['DNA-binding domain', 102, 292, 'Very high confidence across the folded core'],
    ['Tetramerization domain', 325, 356, 'Higher local confidence in the helix'],
    ['C-terminal regulatory tail', 357, 393, 'Low confidence across much of the tail'],
  ] },
  { accession: 'P38398', meanPlddt: 41.59, regions: [
    ['RING-type zinc finger', 24, 64, 'Confident', 86, 'https://foldcommons.org/tools/vanishpoint'],
    ['Central region', 66, 1641, 'Very low confidence across much of the region'],
    ['BRCT 1', 1642, 1736, 'Higher confidence across the folded domain'],
    ['BRCT 2', 1756, 1855, 'Higher confidence across the folded domain'],
  ] },
  { accession: 'P01116', meanPlddt: 91.52, regions: [
    ['GTPase domain', 1, 166, 'Very high confidence across the folded core'],
    ['Hypervariable region', 167, 189, 'Confidence decreases towards the C terminus'],
  ] },
];

interface Prediction {
  entryId?: string;
  modelEntityId?: string;
  uniprotAccession?: string;
  gene?: string;
  latestVersion: number;
  sequenceStart?: number;
  sequenceEnd?: number;
  uniprotStart?: number;
  uniprotEnd?: number;
  globalMetricValue?: number;
  fractionPlddtVeryLow?: number;
  fractionPlddtLow?: number;
  fractionPlddtConfident?: number;
  fractionPlddtVeryHigh?: number;
  pdbUrl?: string;
  cifUrl?: string;
  paeDocUrl?: string;
  plddtDocUrl?: string;
  isComplex?: boolean;
}

function bands([veryLow, low, confident, veryHigh]: number[]) {
  return { veryLow, low, confident, veryHigh };
}

function selectAccession(params: QueryParams): string {
  const query = requiredParam(params, 'uniprotId', 'uniprotAccession', 'accession', 'gene', 'id', 'query').toUpperCase();
  const accession = proteinFixtures.find(entry => entry.gene === query)?.accession ?? query;
  if (!/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?$/.test(accession)) {
    throw new InvalidParameter('Expected a UniProt accession or a supported human gene symbol');
  }
  return accession;
}

function curatedPrediction(accession: string) {
  const fixture = curated.find(row => row.accession === accession);
  const protein = proteinFixtures.find(row => row.accession === accession);
  if (!fixture || !protein) return null;
  const modelId = `AF-${accession}-F1`;
  const version = 6;
  return {
    accession, gene: protein.gene, modelId, version, sequenceStart: 1, sequenceEnd: protein.length,
    meanPlddt: fixture.meanPlddt, confidenceFractions: fixture.fractions ? bands(fixture.fractions) : null,
    confidenceUrl: `${fileServer}/${modelId}-confidence_v${version}.json`,
    pdbUrl: `${fileServer}/${modelId}-model_v${version}.pdb`, cifUrl: `${fileServer}/${modelId}-model_v${version}.cif`,
    paeUrl: `${fileServer}/${modelId}-predicted_aligned_error_v${version}.json`,
    sourceUrl: `https://alphafold.ebi.ac.uk/entry/${accession}`,
    domains: fixture.regions.map(([name, start, end, confidence, meanPlddtApprox, confidenceSource]) => ({
      name, start, end, confidence, meanPlddt: meanPlddtApprox ?? null,
      ...(meanPlddtApprox !== undefined && { rounded: true, confidenceSource }),
    })),
  };
}

// Accept only public model files on the upstream AlphaFold host.
function confidenceFile(value: string | undefined): string {
  const url = new URL(value ?? '');
  if (url.origin !== 'https://alphafold.ebi.ac.uk' || !/^\/files\/AF-[\w-]+-confidence_v\d+\.json$/.test(url.pathname)) {
    throw new Error('Invalid AlphaFold confidence URL');
  }
  return url.href;
}

function mean(values: number[]) {
  return Math.round(100 * values.reduce((sum, value) => sum + value, 0) / values.length) / 100;
}

function calculateDomain(name: string, start: number, end: number, scores: number[], modelStart: number) {
  const values = scores.slice(start - modelStart, end - modelStart + 1);
  const counts = [0, 0, 0, 0];
  for (const score of values) counts[score > 90 ? 3 : score > 70 ? 2 : score > 50 ? 1 : 0]++;
  return { name, start, end, meanPlddt: mean(values), residueCount: values.length, confidenceCounts: bands(counts) };
}

async function livePrediction(accession: string, signal: AbortSignal, includeDomains: boolean) {
  const rows = await json<Prediction[]>(`${api}/${accession}`, signal);
  const candidates = rows.filter(row => !row.isComplex && (!row.uniprotAccession || row.uniprotAccession === accession));
  const row = candidates.find(row => (row.modelEntityId ?? row.entryId) === `AF-${accession}-F1`) ?? candidates[0];
  const modelId = row?.modelEntityId ?? row?.entryId;
  const sequenceStart = row?.sequenceStart ?? row?.uniprotStart;
  const sequenceEnd = row?.sequenceEnd ?? row?.uniprotEnd;
  if (!row || !modelId || sequenceStart == null || sequenceEnd == null || sequenceEnd < sequenceStart || !row.pdbUrl || !row.cifUrl) {
    throw new Error('Missing AlphaFold monomer prediction');
  }
  const fractions = [row.fractionPlddtVeryLow, row.fractionPlddtLow, row.fractionPlddtConfident, row.fractionPlddtVeryHigh];
  const data = {
    accession, gene: row.gene ?? null, modelId, version: row.latestVersion, sequenceStart, sequenceEnd,
    meanPlddt: row.globalMetricValue ?? null,
    confidenceFractions: fractions.every((value): value is number => typeof value === 'number' && Number.isFinite(value))
      ? bands(fractions) : null,
    confidenceUrl: row.plddtDocUrl ?? null, pdbUrl: row.pdbUrl, cifUrl: row.cifUrl, paeUrl: row.paeDocUrl ?? null,
    sourceUrl: `https://alphafold.ebi.ac.uk/entry/${accession}`,
  };
  if (!includeDomains) return data;

  const { confidenceScore: scores } = await json<{ confidenceScore: number[] }>(confidenceFile(row.plddtDocUrl), signal);
  if (!Array.isArray(scores) || scores.length !== sequenceEnd - sequenceStart + 1 ||
      scores.some(score => !Number.isFinite(score) || score < 0 || score > 100)) {
    throw new Error('Incomplete AlphaFold residue confidence array');
  }
  const definitions = curated.find(model => model.accession === accession)?.regions ?? [];
  const domains = definitions.flatMap(([name, start, end]) => {
    const coveredStart = Math.max(start, sequenceStart);
    const coveredEnd = Math.min(end, sequenceEnd);
    return coveredStart <= coveredEnd ? [calculateDomain(name, coveredStart, coveredEnd, scores, sequenceStart)] : [];
  });
  const fullModel = calculateDomain('Model range', sequenceStart, sequenceEnd, scores, sequenceStart);
  return {
    ...data, meanPlddt: fullModel.meanPlddt,
    confidenceFractions: data.confidenceFractions ?? bands(Object.values(fullModel.confidenceCounts).map(count => count / scores.length)),
    domains, residueConfidence: 'AlphaFold DB confidence file',
  };
}

async function prediction(params: QueryParams, signal: AbortSignal | undefined, includeDomains: boolean) {
  const accession = selectAccession(params);
  const data = signal ? await livePrediction(accession, signal, includeDomains) : curatedPrediction(accession);
  return result(data, data ? `${data.modelId} v${data.version} AlphaFold prediction` : `No offline AlphaFold prediction for ${accession}`);
}

export const alphafoldDb = defineConnector({
  id: 'alphafold-db', name: 'AlphaFold Protein Structure Database', category: 'structural',
  description: 'Retrieve AlphaFold monomer model metadata, pLDDT summaries and PAE links.', endpoint: api,
}, {
  fetch_prediction: (params, signal) => prediction(params, signal, false),
  confidence_summary: (params, signal) => prediction(params, signal, true),
}, 4000);
