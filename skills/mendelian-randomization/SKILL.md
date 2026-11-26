---
name: mendelian-randomization
title: Two-Sample Mendelian Randomization
description: Harmonize exposure and outcome GWAS summary data and assess causal estimates under explicit instrument assumptions.
domain: genomics
tags: [Mendelian randomization, GWAS, instrumental variables, IVW, MR-Egger, weighted median, Steiger]
recommendedConnectors: [opentargets, ensembl, pubmed, clinvar]
---

## Workflow Steps

1. Prespecify the exposure, outcome, populations and causal direction. Record GWAS release, ancestry, phenotype definitions, sample sizes, covariates and participant overlap. Establish compatible genome builds and use an ancestry-matched reference for linkage disequilibrium (LD).
2. Assess the instrument assumptions. For relevance, select independent exposure-associated variants and record per-SNP `F ≈ (beta_X / SE_X)^2`, flagging instruments with `F ≤ 10`. For independence, examine ancestry structure, relatedness and plausible confounder associations. For exclusion restriction, examine alternate pathways and potential horizontal pleiotropy using Open Targets, Ensembl and literature evidence.
3. Harmonize effect alleles and effect units across GWAS. Resolve strand and allele-frequency discrepancies, remove ambiguous palindromic variants, document proxies with LD and allele orientation, and retain a variant-level audit of exclusions. For cis instruments, investigate whether exposure and outcome signals colocalize.
4. Fit inverse-variance-weighted (IVW) MR as the primary analysis. Compare the MR-Egger slope and intercept and weighted median estimates with IVW. Report Cochran's Q and estimator uncertainty. Discuss MR-Egger's InSIDE assumption and weak-instrument sensitivity and whether at least half of the weighted information plausibly comes from valid instruments for the weighted median.
5. Run Steiger directionality checks comparing explained variance in exposure and outcome on compatible scales. For case-control traits, document the prevalence assumptions used in liability-scale variance estimates. Examine sensitivity to measurement error and reverse direction. Refit IVW leaving out one variant at a time and investigate influential variants using defensible criteria.

## Statistical/Validation Checklist

- Document instrument selection criteria, LD thresholds, allele harmonization, per-variant strengths, sample overlap and multiple-testing control.
- Report effect units and scale, including odds ratios per specified exposure increment when appropriate. Compare estimator direction, magnitude and uncertainty across sensitivity analyses.
- Treat F above 10 as a heuristic and evaluate winner's curse, population stratification and sample overlap. Follow the [STROBE-MR reporting checklist](https://doi.org/10.1001/jama.2021.18236).

## Expected Artifacts

- Harmonized summary statistics, instrument-selection and exclusion log, and assumption assessment.
- IVW and sensitivity estimates, scatter and leave-one-out plots, Steiger results and reproducible code.

## Common Pitfalls

- Interpreting a nonsignificant Egger intercept as evidence that all instruments are valid.
- Using allele letters without checking strand, build and effect allele frequency.
- Treating Steiger direction or a single shared locus as sufficient evidence of causation.
