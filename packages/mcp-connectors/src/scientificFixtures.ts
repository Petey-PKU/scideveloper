export interface ClinicalVariant {
  variationId: string;
  accession: string;
  gene: string;
  variant: string;
  clinicalSignificance: string;
  condition: string;
  reviewStatus: string;
  classificationType: 'germline' | 'somatic-clinical-impact' | 'somatic-oncogenicity' | null;
}

// Each entry reflects one ClinVar classification context. Variation IDs link to the source records.
export const clinvarFixtures: Array<ClinicalVariant & { alias: string }> = [
  { variationId: '16609', accession: 'VCV000016609', gene: 'EGFR', alias: 'p.L858R',
    variant: 'NM_005228.5(EGFR):c.2573T>G (p.Leu858Arg)', clinicalSignificance: 'Tier I (Strong)',
    condition: 'Non-small cell lung carcinoma', reviewStatus: 'criteria provided, single submitter',
    classificationType: 'somatic-clinical-impact' },
  { variationId: '16613', accession: 'VCV000016613', gene: 'EGFR', alias: 'p.T790M',
    variant: 'NM_005228.5(EGFR):c.2369C>T (p.Thr790Met)', clinicalSignificance: 'Tier I (Strong)',
    condition: 'Non-small cell lung carcinoma', reviewStatus: 'criteria provided, single submitter',
    classificationType: 'somatic-clinical-impact' },
  { variationId: '12374', accession: 'VCV000012374', gene: 'TP53', alias: 'p.R175H',
    variant: 'NM_000546.6(TP53):c.524G>A (p.Arg175His)', clinicalSignificance: 'Pathogenic',
    condition: 'Li-Fraumeni syndrome', reviewStatus: 'reviewed by expert panel', classificationType: 'germline' },
  { variationId: '12347', accession: 'VCV000012347', gene: 'TP53', alias: 'p.R248W',
    variant: 'NM_000546.6(TP53):c.742C>T (p.Arg248Trp)', clinicalSignificance: 'Pathogenic',
    condition: 'Li-Fraumeni syndrome', reviewStatus: 'reviewed by expert panel', classificationType: 'germline' },
  { variationId: '17677', accession: 'VCV000017677', gene: 'BRCA1', alias: 'c.5266dupC',
    variant: 'NM_007294.4(BRCA1):c.5266dup (p.Gln1756fs)', clinicalSignificance: 'Pathogenic',
    condition: 'Hereditary breast and ovarian cancer syndrome', reviewStatus: 'reviewed by expert panel', classificationType: 'germline' },
  { variationId: '12578', accession: 'VCV000012578', gene: 'KRAS', alias: 'p.G12C',
    variant: 'NM_004985.5(KRAS):c.34G>T (p.Gly12Cys)', clinicalSignificance: 'Oncogenic',
    condition: 'Neoplasm', reviewStatus: 'criteria provided, single submitter', classificationType: 'somatic-oncogenicity' },
];

export interface GeoSeries {
  accession: string;
  title: string;
  organism: string;
  platform: string;
  sampleCount: number | null;
  summary: string;
}

// Metadata from the GEO Series records. Summaries are paraphrased from their study designs.
export const geoFixtures: Array<GeoSeries & { keywords: string }> = [
  { accession: 'GSE131907', title: 'Single cell RNA sequencing of lung adenocarcinoma', organism: 'Homo sapiens',
    platform: 'GPL16791', sampleCount: 58, keywords: 'scRNA-seq NSCLC EGFR TP53',
    summary: 'A single-cell RNA-seq atlas of 208,506 cells from samples collected from 44 patients, spanning lung adenocarcinoma, metastases, pleural effusions and non-tumor tissues.' },
  { accession: 'GSE117570', title: 'Reprogramming of Tumor-infiltrating Immune Cells in Early Stage of NSCLC', organism: 'Homo sapiens',
    platform: 'GPL18573', sampleCount: 8, keywords: 'scRNA-seq lung cancer',
    summary: 'Single-cell RNA-seq profiles from early-stage non-small cell lung cancer and matched adjacent lung tissue characterize changes in the tumor immune microenvironment.' },
  { accession: 'GSE32863', title: 'Gene expression analysis of lung adenocarcinoma and matched adjacent non-tumor lung tissue',
    organism: 'Homo sapiens', platform: 'GPL6884', sampleCount: 116, keywords: 'NSCLC lung cancer',
    summary: 'Microarray gene-expression profiles compare 58 lung adenocarcinomas with 58 matched adjacent non-tumor lung samples.' },
  { accession: 'GSE148071', title: 'Comprehensive Profiling of Cancer Cells and Their Microenvironment in Advanced NSCLC',
    organism: 'Homo sapiens', platform: 'GPL20795', sampleCount: 42, keywords: 'scRNA-seq lung cancer',
    summary: 'Single-cell RNA-seq profiles advanced non-small cell lung cancers to characterize malignant cells and the surrounding tumor microenvironment.' },
];

export type PreprintServer = 'bioRxiv' | 'medRxiv';

export interface Preprint {
  doi: string;
  title: string;
  authors: string[];
  server: PreprintServer;
  abstract: string;
  abstractKind: 'publisher' | 'curated-summary';
}

// DOIs refer to the posted preprints. Abstracts are original summaries.
export const preprintFixtures: Preprint[] = [
  {
    doi: '10.1101/2019.12.08.868828', server: 'bioRxiv', abstractKind: 'curated-summary',
    title: 'Heterogeneity and targeted therapy-induced adaptations in lung cancer revealed by longitudinal single-cell RNA sequencing',
    authors: ['Ashley Maynard', 'Caroline E. McCoach', 'Julia K. Rotow', 'Lincoln Harris', 'Franziska Haderk', 'Lucas Kerr',
      'Elizabeth A. Yu', 'Erin L. Schenk', 'Weilun Tan', 'Alexander Zee', 'Michelle Tan', 'Philippe Gui', 'Tasha Lea', 'Wei Wu',
      'Anatoly Urisman', 'Kirk Jones', 'Rene Sit', 'Pallav K. Kolli', 'Eric Seeley', 'Yaron Gesthalter', 'Daniel D. Le',
      'Kevin A. Yamauchi', 'David Naeger', 'Nicholas J. Thomas', 'Anshal Gupta', 'Mayra Gonzalez', 'Hien Do', 'Lisa Tan',
      'Rafael Gomez-Sjoberg', 'Matthew Gubens', 'Thierry Jahan', 'Johannes R. Kratz', 'David Jablons', 'Norma Neff',
      'Robert C. Doebele', 'Jonathan Weissman', 'Collin M. Blakely', 'Spyros Darmanis', 'Trever G. Bivona'],
    abstract: 'The authors used single-cell RNA-seq to follow metastatic lung cancers before and during targeted therapy. Tumor biopsies revealed changes in cancer-cell states and immune populations across treatment stages.',
  },
  {
    doi: '10.1101/460147', server: 'bioRxiv', abstractKind: 'curated-summary',
    title: 'Comprehensive integration of single cell data',
    authors: ['Tim Stuart', 'Andrew Butler', 'Paul Hoffman', 'Christoph Hafemeister', 'Efthymia Papalexi', 'William M. Mauck III',
      'Marlon Stoeckius', 'Peter Smibert', 'Rahul Satija'],
    abstract: 'The authors identify shared cellular states as anchors for combining single-cell datasets and transferring annotations. They demonstrate the method across experiments and distinct molecular measurements.',
  },
  {
    doi: '10.1101/2020.05.06.20092999', server: 'medRxiv', abstractKind: 'curated-summary',
    title: 'OpenSAFELY: factors associated with COVID-19-related hospital death in the linked electronic health records of 17 million adult NHS patients',
    authors: ['The OpenSAFELY Collaborative', 'Elizabeth Williamson', 'Alex J Walker', 'Krishnan Bhaskaran', 'Seb Bacon',
      'Chris Bates', 'Caroline E Morton', 'Helen J Curtis', 'Amir Mehrkar', 'David Evans', 'Peter Inglesby', 'Jonathan Cockburn',
      'Helen I McDonald', 'Brian MacKenna', 'Laurie Tomlinson', 'Ian J Douglas', 'Christopher T Rentsch', 'Rohini Mathur',
      'Angel Wong', 'Richard Grieve', 'David Harrison', 'Harriet Forbes', 'Anna Schultze', 'Richard Croker', 'John Parry',
      'Frank Hester', 'Sam Harper', 'Raf Perera', 'Stephen Evans', 'Liam Smeeth', 'Ben Goldacre'],
    abstract: 'An observational cohort study linked primary care records to hospital death records in England. The analysis examined associations between demographic characteristics, underlying conditions and COVID-19-related hospital mortality.',
  },
];
