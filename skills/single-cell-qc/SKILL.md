---
name: single-cell-qc
title: Single-Cell RNA-seq Quality Control
description: Diagnose low-quality cells, doublets and sample-specific biases before downstream single-cell RNA-seq analysis.
domain: single-cell
tags:
  - scRNA-seq
  - scanpy
  - doublets
  - ambient RNA
  - mitochondrial fraction
  - pseudobulk
recommendedConnectors: [ensembl, pubmed]
---

## Workflow Steps

1. Preserve the raw count layer, cell-to-library mapping and donor IDs. Record assay chemistry and feature annotation. Establish whether each input contains raw droplets or called cells.
2. Compute counts, detected genes and mitochondrial fraction by library using annotation-verified mitochondrial features. Inspect joint distributions and expected tissue or assay differences.
3. Estimate ambient contamination where the required background is available. Estimate doublets per capture library and compare calls with expected loading and marker patterns.
4. Choose data-informed thresholds, record the rationale, and apply named QC flags. Summarize sequential losses and retained cells by library and donor. Inspect retained and flagged populations for plausible biological signals.

## Statistical/Validation Checklist

- Review sensitivity to thresholds across donors and flag condition-dependent attrition.
- Track cell and donor counts separately. Use donors or independent samples as replicates for condition-level inference.
- Verify barcode uniqueness across libraries, raw count preservation and consistent metric denominators.

## Expected Artifacts

- Per-cell QC table, per-library retention summary and pre/post-filter distribution plots.
- Filtered matrix with raw counts and QC flags, plus thresholds, method versions and configuration.

## Common Pitfalls

- Applying one mitochondrial cutoff across chemically or biologically distinct samples.
- Removing rare cell types on the basis of one threshold or treating individual cells as independent biological replicates.
