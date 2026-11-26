// Human STRING network snapshots. Null channel scores mean the fixture retained
// the combined score only. Some published channel values are rounded.
type Partner = [
  symbol: string, proteinId: string, score: number,
  experimental?: number, database?: number, textmining?: number,
];

const networks: Array<{ symbol: string; proteinId: string; partners: Partner[]; evidenceSource?: string }> = [
  {
    symbol: 'EGFR', proteinId: 'ENSP00000275493',
    evidenceSource: 'https://corpus-seven.vercel.app/gene/HGNC%3A3236',
    partners: [
      ['ERBB2', 'ENSP00000269571', 0.999, 1, 0.90, 0.98],
      ['ERBB3', 'ENSP00000267101', 0.999, 0.99, 0.80, 0.98],
      ['PIK3CA', 'ENSP00000263967', 0.999, 0.79, 0.90, 0.98],
      ['HBEGF', 'ENSP00000230990', 0.999, 0.81, 0.90, 1],
      ['GRB2', 'ENSP00000375985', 0.999],
      ['KRAS', 'ENSP00000256078', 0.999],
    ],
  },
  {
    symbol: 'TP53', proteinId: 'ENSP00000269305', evidenceSource: 'https://www.oanor.com/api/string-api',
    partners: [
      ['MDM2', 'ENSP00000258149', 0.999],
      ['MDM4', 'ENSP00000356150', 0.999, 0.999, 0.900, 0.998],
      ['ATM', 'ENSP00000278616', 0.999, 0.928, 0.900, 0.975],
      ['CHEK2', 'ENSP00000372023', 0.999, 0.833, 0.750, 0.992],
      ['BCL2', 'ENSP00000381185', 0.999, 0.869, 0.900, 0.999],
      ['HSP90AA1', 'ENSP00000335153', 0.999, 0.903, 0, 0.995],
    ],
  },
  {
    symbol: 'BRCA1', proteinId: 'ENSP00000418960',
    evidenceSource: 'https://mentorchains.github.io/BI-ML_Disease-Prediction_2024_Site/docs/tutorial/network-analysis/',
    partners: [
      ['BARD1', 'ENSP00000260947', 0.999, 0.998, 0.900, 0.992],
      ['PALB2', 'ENSP00000261584', 0.999],
      ['BRIP1', 'ENSP00000259008', 0.999],
      ['MLH1', 'ENSP00000231790', 0.999],
      ['RAD51D', 'ENSP00000466399', 0.825, 0.095, 0, 0.797],
    ],
  },
  {
    symbol: 'KRAS', proteinId: 'ENSP00000256078',
    partners: [
      ['RAF1', 'ENSP00000251849', 0.999],
      ['BRAF', 'ENSP00000288602', 0.999],
      ['EGFR', 'ENSP00000275493', 0.999],
      ['PIK3CA', 'ENSP00000263967', 0.999],
      ['HRAS', 'ENSP00000407586', 0.999],
      ['NRAS', 'ENSP00000358548', 0.999],
      ['NF1', 'ENSP00000356130', 0.998],
    ],
  },
];

export const stringPartners = networks.flatMap(({ symbol, proteinId, partners, evidenceSource }) =>
  partners.map(([proteinB, partnerId, score, experimental = null, database = null, textmining = null]) => ({
    proteinA: symbol, proteinB, stringIdA: `9606.${proteinId}`, stringIdB: `9606.${partnerId}`, taxonId: 9606,
    score, evidence: { experimental, database, textmining }, sourceUrl: `https://string-db.org/network/9606.${proteinId}`,
    ...(experimental !== null && evidenceSource && { evidenceSource }),
  })));
