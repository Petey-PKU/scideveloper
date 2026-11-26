export interface Article {
  pmid: string;
  doi: string;
  title: string;
  journal: string;
  year: number;
  abstract: string;
  abstractKind: 'publisher' | 'curated-summary';
}

const records: Array<[string, string, string, string, number, string]> = [
  ['15118073', '10.1056/NEJMoa040938',
    'Activating mutations in the epidermal growth factor receptor underlying responsiveness of non-small-cell lung cancer to gefitinib.',
    'The New England Journal of Medicine', 2004,
    'The authors sequenced EGFR in tumors from patients with non-small-cell lung cancer who did or did not respond to gefitinib. Eight of nine responders carried somatic mutations in the kinase domain, while none of seven patients without a response carried those mutations. Cell experiments linked the mutations to increased signaling and drug sensitivity.'],
  ['15118125', '10.1126/science.1099314',
    'EGFR mutations in lung cancer: correlation with clinical response to gefitinib therapy.',
    'Science', 2004,
    'Sequence analysis identified somatic EGFR mutations in lung cancers, especially adenocarcinomas and tumors from Japanese patients in the studied cohorts. Tumors responding to gefitinib frequently carried mutations in the EGFR kinase domain, supporting genotyping as a predictor of drug response.'],
  ['12196540', '10.1074/jbc.M207135200',
    'Structure of the epidermal growth factor receptor kinase domain alone and in complex with a 4-anilinoquinazoline inhibitor.',
    'The Journal of Biological Chemistry', 2002,
    'X-ray crystallography resolved the EGFR kinase domain with and without erlotinib. The activation loop adopted an active-like conformation despite a lack of activation-loop phosphorylation, and the structures also revealed contacts involving the receptor tail.'],
  ['8023157', '10.1126/science.8023157',
    'Crystal structure of a p53 tumor suppressor-DNA complex: understanding tumorigenic mutations.',
    'Science', 1994,
    'The 2.2 Å crystal structure of the human TP53 core domain bound to DNA shows how a beta-sandwich supports zinc-stabilized loops and a DNA-binding surface. Many tumor-associated substitutions map to this surface or to the scaffold that positions it, providing a structural explanation for impaired sequence-specific DNA binding.'],
  ['19349980', '10.1038/nmeth.1315',
    'mRNA-Seq whole-transcriptome analysis of a single cell.',
    'Nature Methods', 2009,
    'The authors combined cDNA amplification with high-throughput sequencing to profile individual mouse blastomeres. Their single-cell RNA-seq method detected substantially more expressed genes than microarray profiling and resolved transcript isoforms, illustrating the information recovered by whole-transcriptome sequencing of individual cells.'],
  ['34265844', '10.1038/s41586-021-03819-2',
    'Highly accurate protein structure prediction with AlphaFold.',
    'Nature', 2021,
    'AlphaFold used a neural network to integrate evolutionary information and structural constraints for protein structure prediction. In CASP14 it achieved accuracy competitive with experimental models for many targets, including targets without a closely related known structure.'],
  ['22745249', '10.1126/science.1225829',
    'A programmable dual-RNA-guided DNA endonuclease in adaptive bacterial immunity.',
    'Science', 2012,
    'Biochemical experiments established that Cas9 from a bacterial CRISPR immune system uses RNA to recognize and cleave matching DNA. The study showed that a single guide could support sequence-specific cleavage, establishing a basis for later genome-editing applications.'],
  ['34096690', '10.1056/NEJMoa2103695',
    'Sotorasib for Lung Cancers with KRAS p.G12C Mutation.',
    'The New England Journal of Medicine', 2021,
    'A phase 2 study evaluated sotorasib in previously treated advanced non-small-cell lung cancer carrying KRAS p.G12C. Among the 124 patients evaluable for response, 37.1% had an objective response. Median progression-free survival was 6.8 months.'],
  ['36449413', '10.1056/NEJMoa2212948',
    "Lecanemab in Early Alzheimer's Disease.",
    'The New England Journal of Medicine', 2023,
    'A randomized 18-month trial in early Alzheimer’s disease compared lecanemab with placebo. The antibody reduced amyloid burden and produced a modest difference on the primary clinical decline scale. Infusion reactions and amyloid-related imaging abnormalities were observed.'],
];

// Identifiers link back to PubMed. Abstracts are original summaries of the papers.
export const literatureFixtures: Article[] = records.map(([pmid, doi, title, journal, year, abstract]) =>
  ({ pmid, doi, title, journal, year, abstract, abstractKind: 'curated-summary' }));
