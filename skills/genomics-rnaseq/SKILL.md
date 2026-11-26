---
name: genomics-rnaseq
title: Bulk RNA-seq Differential Expression
description: Analyze raw bulk RNA-seq counts with replicate-aware models and report gene-level differential expression for a specified contrast.
domain: genomics
tags: [rna-seq, rnaseq, bulk, differential expression, deseq2, pydeseq2]
recommendedConnectors: [ensembl, pubmed]
---

## Workflow Steps

1. Record the organism, reference assembly, annotation release, quantification method and count units. Join counts to sample metadata by unique sample ID and reconcile every mismatch.
2. Identify independent biological replicates, batch, pairing and relevant covariates. Define the numerator, reference and minimum effect of interest before fitting.
3. Inspect library size, sample-level QC and PCA on transformed counts. Flag suspect samples with evidence and record inclusion decisions. Set and log any low-count prefilter.
4. Fit a negative binomial count model on raw counts. Include estimable covariates or subject blocks as warranted. Run the declared contrast and retain all modeled genes, including rows without a valid test.
5. For a simple independent two-group design, run the bundled template with pandas and PyDESeq2 0.5.x. Counts CSV rows are samples and columns are genes. The first column of each input CSV is the sample ID. Metadata needs a condition column.

   ~~~sh
   python scripts/deg_template.py counts.csv samples.csv deg.csv \
     --condition condition --tested treated --reference control
   ~~~

   Adapt the model for paired, blocked or multifactor designs. See the [PyDESeq2 workflow](https://pydeseq2.readthedocs.io/en/stable/auto_examples/plot_step_by_step.html).

## Statistical/Validation Checklist

- Verify count integrity, model rank, independent replication and contrast direction.
- Report log2 fold change, standard error, raw p-value and Benjamini–Hochberg adjusted p-value. Record versioned defaults for outlier handling and independent filtering.
- Check size factors, dispersion and outlier diagnostics. Reconcile tested and significant gene counts across the results table, plots and manuscript.

## Expected Artifacts

- Sample QC and exclusion table, PCA plot, and full contrast results with stable gene IDs.
- Methods record with annotation release, formula, contrast, thresholds, script and software versions.

## Common Pitfalls

- Fitting the count model to TPM, CPM or log-transformed values.
- Treating technical replicates as independent or fitting condition and batch when they are fully confounded.
- Treating missing adjusted p-values as evidence of no effect.
