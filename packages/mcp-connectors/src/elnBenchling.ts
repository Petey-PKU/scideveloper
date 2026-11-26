import { defineConnector, InvalidParameter, limit, LiveWriteError, matches, param, queryUrl, request, requiredParam, result } from './connectorSupport.js';

const protocols = [
  {
    id: 'SOP-VIA-001', title: 'Cell-line viability by ATP luminescence', version: '2.1',
    scope: 'Human A549 cell-line drug response research', materials: ['A549 cells', 'White 96-well plate', 'ATP luminescence reagent'],
    steps: [
      'Record cell passage, seeding density, plate layout and treatment exposure in the run manifest.',
      'Include medium blanks, vehicle wells and an assay-positive control on each plate.',
      'Add the ATP reagent and read luminescence using the timing and volume in the validated kit instructions.',
      'Subtract the medium background and normalize to matched vehicle wells. Fit concentration–response only across an informative concentration range.',
    ],
    qualityChecks: ['Confirm assay linearity at seeding density', 'Review edge effects and positive-control separation', 'Report biological replicates independently'],
  },
  {
    id: 'SOP-RNA-002', title: 'Total RNA extraction from cultured human cells', version: '1.3',
    scope: 'Research RNA isolation from established human cell lines', materials: ['RNA spin-column kit', 'RNase-free consumables', 'DNase as validated'],
    steps: [
      'Record sample ID, collection time, cell input and storage conditions.',
      'Lyse the cells, bind RNA to the column, wash and elute following the lot-specific kit instructions.',
      'Verify residual DNA where the downstream assay requires it.',
      'Measure RNA concentration and integrity. Assign an aliquot ID and archive the measurements with the sample.',
    ],
    qualityChecks: ['Track extraction blanks and yield per input', 'Record RIN or other downstream-specific integrity metric', 'Review no-RT controls where applicable'],
  },
];

const experiments = [
  { id: 'EXP-2026-001', title: 'A549 viability concentration–response pilot', protocolId: 'SOP-VIA-001', status: 'completed', date: '2026-02-10' },
  { id: 'EXP-2026-002', title: 'A549 total RNA extraction and integrity check', protocolId: 'SOP-RNA-002', status: 'in-progress', date: '2026-02-12' },
];

const demoSamples = [
  { id: 'SMP-2026-001', name: 'A549 vehicle replicate A', sampleType: 'cell line', experimentId: 'EXP-2026-001', registeredAt: '2026-02-10T10:00:00Z' },
  { id: 'SMP-2026-002', name: 'A549 treated replicate A', sampleType: 'cell line', experimentId: 'EXP-2026-001', registeredAt: '2026-02-10T10:05:00Z' },
  { id: 'SMP-2026-003', name: 'A549 RNA aliquot A', sampleType: 'total RNA', experimentId: 'EXP-2026-002', registeredAt: '2026-02-12T11:00:00Z' },
];

function endpoint() {
  const value = process.env.SCIDEV_ELN_URL?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SCIDEV_ELN_URL must be an HTTP(S) base URL without credentials, a query or a fragment');
  }
  return url.href.replace(/\/+$/, '');
}

// SCIDEV_ELN_URL points to a lab adapter exposing these normalized JSON routes.
// A private adapter can authenticate with the optional SCIDEV_ELN_TOKEN bearer token.
async function labRequest(url: string | URL, signal: AbortSignal, credential?: string, body?: object, requestId?: string): Promise<unknown> {
  const token = credential ?? process.env.SCIDEV_ELN_TOKEN;
  const response = await request(url, signal, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: {
      Accept: 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
      ...(requestId && { 'Idempotency-Key': requestId }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return await response.json();
}

function labRecord(data: unknown): data is { id: string } {
  return !!data && typeof data === 'object' && 'id' in data && typeof data.id === 'string' && !!data.id;
}

export function createElnBenchling() {
  const samples = [...demoSamples];
  const registrations = new Map<string, { input: string; sample: (typeof samples)[number] }>();
  return defineConnector({
    supportsCredential: true, credentialLabel: 'ELN / Benchling API Token',
    id: 'eln-benchling', name: 'Benchling / Lab ELN', category: 'eln',
    description: 'List lab experiments, retrieve versioned SOPs and register samples with a lab adapter.',
  }, {
    async list_experiments(params, signal, credential) {
      const query = param(params, 'query', 'q', 'name', 'experimentId', 'id');
      const count = limit(params);
      if (signal) {
        const base = endpoint();
        if (!base) throw new Error('SCIDEV_ELN_URL is not configured');
        const rows = await labRequest(queryUrl(`${base}/experiments`, { query, limit: count }), signal, credential);
        if (!Array.isArray(rows) || !rows.every(labRecord)) throw new Error('Invalid ELN experiment list');
        return result(rows.slice(0, count), `${Math.min(rows.length, count)} lab experiments`);
      }
      const rows = experiments.filter(row => matches(query, row.id, row.title, row.protocolId, row.status))
        .slice(0, count).map(row => ({ ...row, samples: structuredClone(samples.filter(sample => sample.experimentId === row.id)) }));
      return result(rows, `${rows.length} demo lab experiments`);
    },
    async fetch_protocol(params, signal, credential) {
      const id = requiredParam(params, 'protocolId', 'id', 'protocol', 'query');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) throw new InvalidParameter('Invalid protocol ID');
      if (signal) {
        const base = endpoint();
        if (!base) throw new Error('SCIDEV_ELN_URL is not configured');
        const data = await labRequest(`${base}/protocols/${encodeURIComponent(id)}`, signal, credential);
        if (!labRecord(data)) throw new Error('Invalid ELN protocol');
        return result(data, `Lab protocol ${data.id}`);
      }
      const data = structuredClone(protocols.find(row => row.id === id.toUpperCase()) ?? null);
      return result(data, data ? `${data.title} v${data.version}` : `No demo lab protocol for ${id}`);
    },
    async register_sample(params, signal, credential) {
      const name = requiredParam(params, 'name', 'sampleName');
      const sampleType = requiredParam(params, 'sampleType', 'type');
      const experimentId = requiredParam(params, 'experimentId', 'experiment');
      const requestId = param(params, 'requestId', 'idempotencyKey');
      if (requestId && !/^[A-Za-z0-9_.-]{1,128}$/.test(requestId)) throw new InvalidParameter('Invalid registration request ID');
      const input = { name, sampleType, experimentId };
      if (signal) {
        if (!process.env.SCIDEV_ELN_URL?.trim()) throw new Error('SCIDEV_ELN_URL is not configured');
        try {
          const base = endpoint();
          const data = await labRequest(`${base}/samples`, signal, credential, input, requestId);
          if (!labRecord(data)) throw new Error('Invalid ELN registration response');
          return result(data, `Lab sample ${data.id} registered`);
        } catch (cause) {
          throw new LiveWriteError('Could not confirm live ELN registration. Check the lab registry before retrying.', { cause });
        }
      }
      const demoExperimentId = experimentId.toUpperCase();
      if (!experiments.some(row => row.id === demoExperimentId)) throw new InvalidParameter('Unknown demo experiment ID');
      const demoInput = { ...input, experimentId: demoExperimentId };
      const previous = requestId ? registrations.get(requestId) : undefined;
      if (previous) {
        if (previous.input !== JSON.stringify(demoInput)) throw new InvalidParameter('Registration request ID already used for another sample');
        return result({ ...previous.sample }, `Demo sample ${previous.sample.id} already registered`);
      }
      const id = `SMP-2026-${String(samples.length + 1).padStart(3, '0')}`;
      const sample = { id, ...demoInput, registeredAt: new Date().toISOString() };
      samples.push(sample);
      if (requestId) registrations.set(requestId, { input: JSON.stringify(demoInput), sample });
      return result({ ...sample }, `Demo sample ${id} registered for this registry lifetime`);
    },
  }, 4000);
}

export const elnBenchling = createElnBenchling();
