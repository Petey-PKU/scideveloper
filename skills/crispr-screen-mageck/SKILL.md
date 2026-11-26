---
name: crispr-screen-mageck
title: MAGeCK Analysis of Pooled CRISPR Screens
description: Analyze existing guide-count data from human cancer cell-line screens and assess the reliability of gene-level hits.
domain: genomics
tags: [CRISPR, MAGeCK, screen, guide counts, RRA, copy number]
recommendedConnectors: [ensembl, opentargets, pubmed]
---

## Workflow Steps

1. Import an existing guide-count matrix, reference library annotation and sample manifest from a human cancer cell-line screen. Verify guide IDs, Ensembl release, library version, biological replicate and paired-baseline assignments. Keep non-targeting and reference-essential controls labeled.
2. For each sample, report mapped reads, detected guides, zero counts and representation skew. Compare replicates with correlation and PCA. Use baseline samples to identify absent or severely underrepresented guides.
3. Verify that the matrix contains raw integer counts with sgRNA and gene columns followed by sample labels. For an independent two-group contrast, run MAGeCK RRA using the declared controls if they are stable and adequately represented.

   ~~~sh
   mageck test -k counts.tsv -t treatment_1,treatment_2 -c control_1,control_2 --norm-method control --control-sgrna nontargeting.txt -n treated_vs_control
   ~~~

   Use a design matrix with MAGeCK MLE for multifactor contrasts. Evaluate possible copy-number artifacts with copy-number information from the same cell line.
4. Review both enrichment and depletion output. Inspect guide-level effects and agreement per gene, compare against known control behavior, and annotate plausible hits using Open Targets and primary literature.

## Statistical/Validation Checklist

- Retain normalization factors, filtering rules, guide and gene-level effect estimates, and direction-specific FDR.
- Check control separation, replicate concordance and sensitivity to control-based versus median normalization.
- Flag genes driven by one guide, amplified loci, and contrasts with strong representation bottlenecks.

## Expected Artifacts

- Validated count matrix and guide mapping, sample QC report, guide and gene result tables, and a hit evidence table.
- Recorded inputs, version, exact command or design matrix, and filter and normalization settings.

## Common Pitfalls

- Treating guides within one sample as independent biological replicates.
- Confusing enrichment with depletion or reversing the treatment and control labels.
- Attributing depletion in amplified regions entirely to gene function.
