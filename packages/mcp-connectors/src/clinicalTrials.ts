import {
  defineConnector, InvalidParameter, json, limit, matches, param, queryUrl, requiredParam, result,
} from './connectorSupport.js';

const studiesUrl = 'https://clinicaltrials.gov/api/v2/studies';

interface Outcome {
  measure: string;
  description?: string;
  timeFrame?: string;
}

interface Enrollment {
  count: number;
  type?: string;
}

interface Study {
  nctId: string;
  title: string;
  acronym?: string;
  phase: string[];
  status: string;
  enrollment: Enrollment | null;
  primaryOutcomes: Outcome[];
  sponsor: string | null;
  conditions: string[];
  interventions: string[];
  url: string;
}

interface ApiStudy {
  protocolSection: {
    identificationModule: { nctId: string; briefTitle: string; acronym?: string };
    statusModule?: { overallStatus?: string };
    designModule?: { phases?: string[]; enrollmentInfo?: Enrollment };
    outcomesModule?: { primaryOutcomes?: Outcome[] };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    conditionsModule?: { conditions?: string[] };
    armsInterventionsModule?: { interventions?: Array<{ name: string }> };
  };
}

function studyUrl(nctId: string): string {
  return `https://clinicaltrials.gov/study/${nctId}`;
}

function normalizeStudy({ protocolSection: study }: ApiStudy): Study {
  const { nctId, briefTitle: title, acronym } = study.identificationModule;
  if (!/^NCT\d{8}$/.test(nctId) || !title) throw new Error('Invalid ClinicalTrials.gov study');
  return {
    nctId, title, acronym, url: studyUrl(nctId),
    phase: study.designModule?.phases ?? [],
    status: study.statusModule?.overallStatus ?? 'UNKNOWN',
    enrollment: study.designModule?.enrollmentInfo ?? null,
    primaryOutcomes: study.outcomesModule?.primaryOutcomes ?? [],
    sponsor: study.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
    conditions: study.conditionsModule?.conditions ?? [],
    interventions: study.armsInterventionsModule?.interventions?.map(({ name }) => name) ?? [],
  };
}

// Curated snapshots of the linked trial registrations and primary publications.
const fixtures: Omit<Study, 'url'>[] = [
  {
    nctId: 'NCT04035486', acronym: 'FLAURA2', title: 'Osimertinib with or without Chemotherapy in EGFR-Mutated Advanced NSCLC',
    phase: ['PHASE3'], status: 'ACTIVE_NOT_RECRUITING', enrollment: { count: 587, type: 'ACTUAL' },
    primaryOutcomes: [
      { measure: 'Progression-free survival', description: 'Investigator assessment per RECIST 1.1 in the randomized cohort' },
      { measure: 'Dose-limiting toxicities', description: 'Safety run-in cohort' },
    ],
    sponsor: 'AstraZeneca', conditions: ['EGFR-mutated non-small cell lung cancer (NSCLC)'],
    interventions: ['Osimertinib', 'Pemetrexed', 'Cisplatin', 'Carboplatin'],
  },
  {
    nctId: 'NCT04487080', acronym: 'MARIPOSA', title: 'Amivantamab plus Lazertinib in Previously Untreated EGFR-Mutated Advanced NSCLC',
    phase: ['PHASE3'], status: 'ACTIVE_NOT_RECRUITING', enrollment: { count: 1074, type: 'ACTUAL' },
    primaryOutcomes: [{ measure: 'Progression-free survival', description: 'Blinded independent central review per RECIST 1.1' }],
    sponsor: 'Janssen Research & Development, LLC', conditions: ['EGFR-mutated non-small cell lung cancer (NSCLC)'],
    interventions: ['Amivantamab', 'Lazertinib', 'Osimertinib'],
  },
  {
    nctId: 'NCT02578680', acronym: 'KEYNOTE-189', title: 'Pembrolizumab plus Chemotherapy in Metastatic Nonsquamous NSCLC',
    phase: ['PHASE3'], status: 'COMPLETED', enrollment: { count: 616, type: 'ACTUAL' },
    primaryOutcomes: [{ measure: 'Overall survival' }, { measure: 'Progression-free survival', description: 'Blinded independent central review per RECIST 1.1' }],
    sponsor: 'Merck Sharp & Dohme LLC', conditions: ['Metastatic non-small cell lung cancer (NSCLC)'],
    interventions: ['Pembrolizumab', 'Placebo', 'Pemetrexed', 'Cisplatin', 'Carboplatin'],
  },
];

const phaseCodes: Record<string, string> = {
  I: '1', II: '2', III: '3', IV: '4', '1': '1', '2': '2', '3': '3', '4': '4',
};

function phaseFilter(value: string): string[] {
  if (!value) return [];
  const compact = value.toUpperCase().replace(/[\s_-]+/g, '');
  if (/^(?:EARLYPHASE1|EARLYPHASEI|PHASE0)$/.test(compact)) return ['EARLY_PHASE1'];
  if (/^(?:N\/?A|NOTAPPLICABLE)$/.test(compact)) return ['NA'];
  return compact.split(/[\/,]/).map(phase => {
    const code = phaseCodes[phase.replace(/^PHASE/, '')];
    if (!code) throw new InvalidParameter('Expected a clinical trial phase from I to IV, early phase 1, or N/A');
    return `PHASE${code}`;
  });
}

function fixtureStudy(study: Omit<Study, 'url'>): Study {
  return { ...structuredClone(study), url: studyUrl(study.nctId) };
}

export const clinicaltrials = defineConnector({
  id: 'clinicaltrials', name: 'ClinicalTrials.gov API v2', category: 'clinical',
  description: 'Search registered studies and retrieve trial designs, enrollment and primary outcomes.',
  endpoint: studiesUrl,
}, {
  async search_trials(params, signal) {
    const query = param(params, 'query');
    const condition = param(params, 'condition');
    const intervention = param(params, 'intervention');
    const phases = phaseFilter(param(params, 'phase'));
    const status = param(params, 'status').toUpperCase().replace(/[\s,-]+/g, '_');
    const count = limit(params, 10, 1000, ['maxResults', 'limit', 'count']);
    let data: Study[];
    if (signal) {
      const url = queryUrl(studiesUrl, {
        pageSize: count,
        ...(query && { 'query.term': query }),
        ...(condition && { 'query.cond': condition }),
        ...(intervention && { 'query.intr': intervention }),
        ...(phases.length && { 'filter.advanced': phases.map(phase => `AREA[Phase]${phase}`).join(' AND ') }),
        ...(status && { 'filter.overallStatus': status }),
      });
      const payload = await json<{ studies: ApiStudy[] }>(url, signal);
      data = payload.studies.slice(0, count).map(normalizeStudy);
    } else {
      data = fixtures.filter(trial => matches(query, trial.title, trial.nctId, trial.acronym ?? '',
        trial.sponsor ?? '', ...trial.conditions, ...trial.interventions)
        && matches(condition, ...trial.conditions) && matches(intervention, ...trial.interventions)
        && phases.every(phase => trial.phase.includes(phase)) && (!status || trial.status === status))
        .slice(0, count).map(fixtureStudy);
    }
    return result(data, `${data.length} clinical trials`);
  },
  async get_trial(params, signal) {
    const nctId = requiredParam(params, 'nctId').toUpperCase();
    if (!/^NCT\d{8}$/.test(nctId)) throw new InvalidParameter('Expected an NCT ID with eight digits');
    const fixture = fixtures.find(trial => trial.nctId === nctId);
    const data = signal ? normalizeStudy(await json<ApiStudy>(`${studiesUrl}/${nctId}`, signal))
      : fixture ? fixtureStudy(fixture) : null;
    return result(data, data ? `Clinical trial ${nctId}` : `No cached clinical trial found for ${nctId}`);
  },
});
