import { defineConnector, json, limit, matches, param, queryUrl, requiredParam, result } from './connectorSupport.js';

const api = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const viewApi = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view';
const properties = 'Title,IUPACName,MolecularFormula,ConnectivitySMILES,SMILES,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount';

const records = [
  {
    cid: 123631, name: 'Gefitinib', aliases: ['Iressa', 'ZD1839'],
    iupacName: 'N-(3-chloro-4-fluorophenyl)-7-methoxy-6-(3-morpholin-4-ylpropoxy)quinazolin-4-amine',
    molecularFormula: 'C22H24ClFN4O3', canonicalSmiles: 'COC1=C(C=C2C(=C1)N=CN=C2NC3=CC(=C(C=C3)F)Cl)OCCCN4CCOCC4',
    tpsa: 68.7, hbd: 1, hba: 8, rotatableBonds: 8,
    hazards: ['H302: Harmful if swallowed', 'H361: Suspected of damaging fertility or the unborn child'],
  },
  {
    cid: 71496458, name: 'Osimertinib', aliases: ['Tagrisso', 'AZD9291', 'Mereletinib'],
    iupacName: 'N-[2-[2-(dimethylamino)ethyl-methylamino]-4-methoxy-5-[[4-(1-methylindol-3-yl)pyrimidin-2-yl]amino]phenyl]prop-2-enamide',
    molecularFormula: 'C28H33N7O2', canonicalSmiles: 'CN1C=C(C2=CC=CC=C21)C3=NC(=NC=C3)NC4=C(C=C(C(=C4)NC(=O)C=C)N(C)CCN(C)C)OC',
    tpsa: 87.6, hbd: 2, hba: 7, rotatableBonds: 10,
    hazards: ['H302: Harmful if swallowed', 'H361fd: Suspected of damaging fertility and the unborn child'],
  },
  {
    cid: 176870, name: 'Erlotinib', aliases: ['Tarceva', 'OSI-774'],
    iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine',
    molecularFormula: 'C22H23N3O4', canonicalSmiles: 'COCCOC1=C(C=C2C(=C1)C(=NC=N2)NC3=CC=CC(=C3)C#C)OCCOC',
    tpsa: 74.7, hbd: 1, hba: 7, rotatableBonds: 11,
    hazards: ['H302: Harmful if swallowed'],
  },
  {
    cid: 137278711, name: 'Sotorasib', aliases: ['Lumakras', 'Lumykras', 'AMG 510'],
    iupacName: '6-fluoro-7-(2-fluoro-6-hydroxyphenyl)-1-(4-methyl-2-propan-2-yl-3-pyridinyl)-4-[(2S)-2-methyl-4-prop-2-enoylpiperazin-1-yl]pyrido[2,3-d]pyrimidin-2-one',
    molecularFormula: 'C30H30F2N6O3',
    canonicalSmiles: 'CC1CN(CCN1C2=NC(=O)N(C3=NC(=C(C=C32)F)C4=C(C=CC=C4F)O)C5=C(C=CN=C5C(C)C)C)C(=O)C=C',
    isomericSmiles: 'C[C@H]1CN(CCN1C2=NC(=O)N(C3=NC(=C(C=C32)F)C4=C(C=CC=C4F)O)C5=C(C=CN=C5C(C)C)C)C(=O)C=C',
    tpsa: 102, hbd: 1, hba: 7, rotatableBonds: 5,
    hazards: ['PubChem includes a submitted notification without a GHS hazard classification for this entry.'],
  },
  {
    cid: 2244, name: 'Aspirin', aliases: ['Acetylsalicylic acid', 'ASA'],
    iupacName: '2-acetyloxybenzoic acid', molecularFormula: 'C9H8O4', canonicalSmiles: 'CC(=O)OC1=CC=CC=C1C(=O)O',
    tpsa: 63.6, hbd: 1, hba: 4, rotatableBonds: 3,
    hazards: ['H302: Harmful if swallowed'],
  },
];

interface PubChemProperties {
  CID: number;
  Title?: string;
  IUPACName: string;
  MolecularFormula: string;
  ConnectivitySMILES?: string;
  CanonicalSMILES?: string;
  SMILES?: string;
  IsomericSMILES?: string;
  TPSA: number;
  HBondDonorCount: number;
  HBondAcceptorCount: number;
  RotatableBondCount: number;
}

function compoundUrl(cid: number) {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

function lookupPath(query: string) {
  const id = /^(?:CID[\s:]*)?(\d+)$/i.exec(query)?.[1];
  return id ? `cid/${id}` : `name/${encodeURIComponent(query)}`;
}

function fixtureMatches(query: string) {
  const id = /^(?:CID[\s:]*)?(\d+)$/i.exec(query)?.[1];
  return records.filter(row => id ? row.cid === Number(id) : matches(query, row.name, row.iupacName, ...row.aliases));
}

async function liveProperties(query: string, fields: string, signal: AbortSignal) {
  const data = await json<{ PropertyTable: { Properties: PubChemProperties[] } }>(
    `${api}/compound/${lookupPath(query)}/property/${fields}/JSON`, signal);
  if (!data.PropertyTable.Properties.every(row => Number.isSafeInteger(row.CID) && row.CID > 0)) {
    throw new Error('Invalid PubChem compound record');
  }
  return data.PropertyTable.Properties;
}

interface SafetySection {
  Section?: SafetySection[];
  Information?: Array<{ Name?: string; Value?: { StringWithMarkup?: Array<{ String: string }> } }>;
}

function hazardStatements(section: SafetySection): string[] {
  const local = (section.Information ?? []).filter(info => info.Name === 'GHS Hazard Statements')
    .flatMap(info => info.Value?.StringWithMarkup?.map(row => row.String) ?? []);
  return [...local, ...(section.Section ?? []).flatMap(hazardStatements)];
}

function hazardSummary(cid: number, statements: string[] | null) {
  return {
    statements, sourceUrl: `${compoundUrl(cid)}#section=GHS-Classification`,
    scope: 'Selected PubChem depositor notifications. Classification can vary by supplier and material.',
  };
}

function conformerMetadata(cid: number, ids: string[] | null) {
  return {
    ids, endpoint: `${api}/compound/cid/${cid}/conformers/JSON`,
    sdfUrl: queryUrl(`${api}/compound/cid/${cid}/record/SDF`, { record_type: '3d' }).href,
  };
}

export const pubchem = defineConnector({
  id: 'pubchem', name: 'NCBI PubChem', category: 'chemistry',
  description: 'Look up compound identity, computed descriptors, GHS notifications and conformer metadata.', endpoint: api,
}, {
  async search_compound(params, signal) {
    const query = requiredParam(params, 'query', 'name', 'compound', 'cid', 'id', 'q');
    const rows = signal
      ? (await liveProperties(query, 'Title,MolecularFormula', signal)).map(row => ({
        cid: row.CID, name: row.Title ?? `CID ${row.CID}`, molecularFormula: row.MolecularFormula, url: compoundUrl(row.CID),
      }))
      : fixtureMatches(query).map(({ cid, name, molecularFormula }) => ({ cid, name, molecularFormula, url: compoundUrl(cid) }));
    const data = rows.slice(0, limit(params));
    return result(data, `${data.length} PubChem compounds`);
  },
  async compound_properties(params, signal) {
    const query = requiredParam(params, 'cid', 'id', 'name', 'compound', 'query');
    if (signal) {
      const [row, ...others] = await liveProperties(query, properties, signal);
      const canonicalSmiles = row?.ConnectivitySMILES ?? row?.CanonicalSMILES;
      if (!row || others.length || !row.IUPACName || !row.MolecularFormula || !canonicalSmiles ||
          ![row.TPSA, row.HBondDonorCount, row.HBondAcceptorCount, row.RotatableBondCount].every(Number.isFinite)) {
        throw new Error('Missing, ambiguous or incomplete PubChem properties');
      }
      const cid = row.CID;
      const [safety, conformers] = await Promise.allSettled([
        json<{ Record: SafetySection }>(queryUrl(`${viewApi}/data/compound/${cid}/JSON`, { heading: 'GHS Classification' }), signal),
        json<{ IdentifierList: { ConformerID: string[] } }>(`${api}/compound/cid/${cid}/conformers/JSON`, signal),
      ]);
      const statements = safety.status === 'fulfilled' && safety.value.Record
        ? [...new Set(hazardStatements(safety.value.Record))] : null;
      const ids = conformers.status === 'fulfilled' && Array.isArray(conformers.value.IdentifierList?.ConformerID)
        ? conformers.value.IdentifierList.ConformerID : null;
      return result({
        cid, name: row.Title ?? row.IUPACName, iupacName: row.IUPACName, molecularFormula: row.MolecularFormula,
        canonicalSmiles, isomericSmiles: row.SMILES ?? row.IsomericSMILES ?? canonicalSmiles,
        tpsa: row.TPSA, hbd: row.HBondDonorCount, hba: row.HBondAcceptorCount, rotatableBonds: row.RotatableBondCount,
        ghsSafety: hazardSummary(cid, statements), conformers: conformerMetadata(cid, ids), url: compoundUrl(cid),
      }, `PubChem properties for CID ${cid}`);
    }
    const fixtures = fixtureMatches(query);
    if (fixtures.length !== 1) return result(null, `No unique offline PubChem record for ${query}`);
    const { aliases: _aliases, hazards, ...row } = fixtures[0];
    return result({
      ...row, isomericSmiles: row.isomericSmiles ?? row.canonicalSmiles,
      ghsSafety: hazardSummary(row.cid, [...hazards]), conformers: conformerMetadata(row.cid, null), url: compoundUrl(row.cid),
    }, `Curated PubChem properties for ${row.name}`);
  },
}, 4000);
