---
name: pathway-enrichment-gsea
title: Pathway Enrichment with GSEA and ORA
description: Compare rank-based GSEA with over-representation analysis using versioned human gene sets and assay-aware backgrounds.
domain: genomics
tags: [pathway, GSEA, ORA, enrichment, GMT, hypergeometric, leading edge]
recommendedConnectors: [kegg, reactome, string-db, geo]
---

## Workflow Steps

1. Freeze the contrast direction, organism, gene ID namespace and gene set release. Save tested genes, a versioned GMT and the mapping for aliases, one-to-many mappings and duplicates.
2. For preranked GSEA, use a signed gene-level statistic such as the Wald statistic for all eligible genes. Resolve duplicate gene IDs and ties with documented rules. Specify minimum and maximum mapped set size, permutation method, permutation count and seed. Report normalized enrichment scores, adjusted significance and leading-edge genes.
3. For ORA, freeze hit selection before inspecting pathways. Use all genes eligible to be called hits as background. Provide one gene ID per line in each list and a GMT with unique set names, descriptions and tab-separated members. Run the standard-library helper from this skill directory.

   ~~~sh
   python scripts/ora_enrichment.py hits.txt tested.txt pathways.gmt ora.tsv --min-size 10 --max-size 500
   ~~~

   The helper intersects each set with the background, includes zero-overlap sets in BH correction and writes overlap genes, expected counts, fold enrichment, raw p-values and adjusted p-values.
4. Reconcile pathway hits with the direction of the underlying contrast and inspect shared genes across related terms. Use STRING evidence for protein-network context and GEO datasets for independent replication where the design matches.

## Statistical/Validation Checklist

- Record mapping rates, tested set sizes and all tested terms. Check background composition against platform coverage and filtering.
- Distinguish the permutation null for preranked gene-set tests from phenotype permutations that preserve the experimental design. Account for gene correlation when choosing the method.
- Repeat with plausible set-size and ranking choices if leading conclusions depend on them. Label results from small curated library subsets as exploratory.

## Expected Artifacts

- Input ranks, tested universe, hits, GMT and mapping log. Full ORA and GSEA results with overlap or leading-edge genes.
- Enrichment plots and a methods record with releases, thresholds and permutation settings.

## Common Pitfalls

- Running preranked GSEA on significant genes only.
- Using the entire genome when the assay could only detect a subset.
- Adjusting only pathways with nonzero overlap.
