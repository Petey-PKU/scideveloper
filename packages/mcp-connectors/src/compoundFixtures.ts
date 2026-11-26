// Molecules and measured IC50 activity records from the ChEMBL API.
export const compoundFixtures = [
  {
    "id": "CHEMBL939",
    "name": "Gefitinib",
    "smiles": "COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1",
    "molecularWeight": 446.91,
    "logP": 4.28,
    "activities": [
      {
        "activityId": 108863,
        "assayId": "CHEMBL683041",
        "compoundId": "CHEMBL939",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 515,
        "units": "nM",
        "description": "Inhibition of Epidermal Growth Factor Receptor (EGFR) autophosphorylation",
        "documentId": "CHEMBL1135208"
      },
      {
        "activityId": 186630,
        "assayId": "CHEMBL674106",
        "compoundId": "CHEMBL939",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 1,
        "units": "nM",
        "description": "Inhibitory activity against epidermal growth factor receptor",
        "documentId": "CHEMBL1146682"
      },
      {
        "activityId": 571790,
        "assayId": "CHEMBL677210",
        "compoundId": "CHEMBL939",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 23,
        "units": "nM",
        "description": "In vitro inhibitory activity against Epidermal growth factor receptor (EGFR-TK) from A431 vulval squamous carcinoma cells using TKI assay",
        "documentId": "CHEMBL1134804"
      },
      {
        "activityId": 1682077,
        "assayId": "CHEMBL862515",
        "compoundId": "CHEMBL939",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 14.4,
        "units": "nM",
        "description": "Inhibition of EGF stimulated human erbB1 autophosphorylation in NIH3T3 cells",
        "documentId": "CHEMBL1138126"
      }
    ]
  },
  {
    "id": "CHEMBL3353410",
    "name": "Osimertinib",
    "smiles": "C=CC(=O)Nc1cc(Nc2nccc(-c3cn(C)c4ccccc34)n2)c(OC)cc1N(C)CCN(C)C",
    "molecularWeight": 499.62,
    "logP": 4.51,
    "activities": [
      {
        "activityId": 15073016,
        "assayId": "CHEMBL3389020",
        "compoundId": "CHEMBL3353410",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 15000,
        "units": "nM",
        "description": "Inhibition of EGFR L858R/T790M double mutant phosphorylation in human NCI-H1975 cells after 2 hrs by fluorescence assay",
        "documentId": "CHEMBL3351341"
      },
      {
        "activityId": 15073017,
        "assayId": "CHEMBL3389021",
        "compoundId": "CHEMBL3353410",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 17000,
        "units": "nM",
        "description": "Inhibition of EGFR exon 19 deletion activating mutant phosphorylation in human PC9 cells after 2 hrs by fluorescence assay",
        "documentId": "CHEMBL3351341"
      },
      {
        "activityId": 15073018,
        "assayId": "CHEMBL3389022",
        "compoundId": "CHEMBL3353410",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 480000,
        "units": "nM",
        "description": "Inhibition of wild type EGFR phosphorylation in human LoVo cells after 2 hrs by fluorescence assay",
        "documentId": "CHEMBL3351341"
      },
      {
        "activityId": 16444026,
        "assayId": "CHEMBL3755797",
        "compoundId": "CHEMBL3353410",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 7,
        "units": "nM",
        "description": "Inhibition of EGFR L858R/T790M mutant (unknown origin) using Poly(Glu,Tyr)4:1 as substrate incubated for 1 hr by ELISA",
        "documentId": "CHEMBL3751728"
      }
    ]
  },
  {
    "id": "CHEMBL553",
    "name": "Erlotinib",
    "smiles": "C#Cc1cccc(Nc2ncnc3cc(OCCOC)c(OCCOC)cc23)c1",
    "molecularWeight": 393.44,
    "logP": 3.41,
    "activities": [
      {
        "activityId": 129395,
        "assayId": "CHEMBL683041",
        "compoundId": "CHEMBL553",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 1450,
        "units": "nM",
        "description": "Inhibition of Epidermal Growth Factor Receptor (EGFR) autophosphorylation",
        "documentId": "CHEMBL1135208"
      },
      {
        "activityId": 186628,
        "assayId": "CHEMBL674106",
        "compoundId": "CHEMBL553",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 1,
        "units": "nM",
        "description": "Inhibitory activity against epidermal growth factor receptor",
        "documentId": "CHEMBL1146682"
      },
      {
        "activityId": 1682076,
        "assayId": "CHEMBL862515",
        "compoundId": "CHEMBL553",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 19.3,
        "units": "nM",
        "description": "Inhibition of EGF stimulated human erbB1 autophosphorylation in NIH3T3 cells",
        "documentId": "CHEMBL1138126"
      },
      {
        "activityId": 1682080,
        "assayId": "CHEMBL862512",
        "compoundId": "CHEMBL553",
        "targetId": "CHEMBL203",
        "target": "Epidermal growth factor receptor",
        "type": "IC50",
        "relation": "=",
        "value": 0.6,
        "units": "nM",
        "description": "Inhibition of erbB1 fusion protein expressed in baculovirus by ELISA",
        "documentId": "CHEMBL1138126"
      }
    ]
  },
  {
    "id": "CHEMBL25",
    "name": "Aspirin",
    "smiles": "CC(=O)Oc1ccccc1C(=O)O",
    "molecularWeight": 180.16,
    "logP": 1.31,
    "activities": [
      {
        "activityId": 91852,
        "assayId": "CHEMBL760085",
        "compoundId": "CHEMBL25",
        "targetId": "CHEMBL230",
        "target": "Prostaglandin G/H synthase 2",
        "type": "IC50",
        "relation": "=",
        "value": 62500,
        "units": "nM",
        "description": "Inhibitory concentration in DMSO with purified human Prostaglandin G/H synthase 2 (COX-2)",
        "documentId": "CHEMBL1131194"
      },
      {
        "activityId": 579273,
        "assayId": "CHEMBL769654",
        "compoundId": "CHEMBL25",
        "targetId": "CHEMBL230",
        "target": "Prostaglandin G/H synthase 2",
        "type": "IC50",
        "relation": "=",
        "value": 18000000,
        "units": "nM",
        "description": "Tested for inhibitory activity against Prostaglandin G/H synthase 2 from human",
        "documentId": "CHEMBL1128445"
      },
      {
        "activityId": 1864552,
        "assayId": "CHEMBL914259",
        "compoundId": "CHEMBL25",
        "targetId": "CHEMBL230",
        "target": "Prostaglandin G/H synthase 2",
        "type": "IC50",
        "relation": "=",
        "value": 19800,
        "units": "nM",
        "description": "Inhibition of COX2 by radioimmunoassay method",
        "documentId": "CHEMBL1139892"
      },
      {
        "activityId": 1864554,
        "assayId": "CHEMBL914258",
        "compoundId": "CHEMBL25",
        "targetId": "CHEMBL221",
        "target": "Prostaglandin G/H synthase 1",
        "type": "IC50",
        "relation": "=",
        "value": 11400,
        "units": "nM",
        "description": "Inhibition of COX1 by radioimmunoassay method",
        "documentId": "CHEMBL1139892"
      }
    ]
  }
];
