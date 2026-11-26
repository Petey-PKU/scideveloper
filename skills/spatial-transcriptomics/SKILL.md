---
name: spatial-transcriptomics
title: Spatial Transcriptomics QC and Tissue Mapping
description: Assess spatial expression quality, detect spatially variable genes and test spatial co-localization across tissue sections.
domain: single-cell
tags: [Visium, Xenium, MERFISH, Moran I, spatially variable genes, ligand receptor, tissue domains]
recommendedConnectors: [geo, ensembl, string, reactome]
---

## Workflow Steps

1. Import counts, transcripts, coordinates, section metadata, image scale factors and tissue masks. Verify coordinate registration and gene IDs. For Visium, examine on-tissue spot coverage, UMIs, detected genes, mitochondrial fractions and tissue-edge or ambient RNA artifacts. Use spot deconvolution when mixed cell types affect interpretation.
2. For Xenium or MERFISH, review per-cell transcript and feature counts, negative-control signal, segmentation boundaries, cell area, local cell density and the fraction of molecules assigned to cells. Check edge tiles, background and poorly segmented regions. Use spatial QC overlays to set platform- and section-specific filters and retain rejected locations in an audit mask.
3. Build a spot or cell-neighborhood graph within each section using the array grid or calibrated physical distances. Record radius or neighbor count, weight normalization and treatment of isolated nodes. Detect spatially variable genes with Moran's I on suitable normalized expression or model residuals. Use exchangeable permutations within sections or strata, correct for multiple testing and check sensitivity to graph construction. See the [Squidpy methods](https://doi.org/10.1038/s41592-021-01358-2).
4. Define candidate ligand–receptor pairs from curated evidence and use `string` or `string-db` and Reactome for protein and pathway context. Test whether ligand-expressing sender populations neighbor receptor-expressing receivers more than expected under a null that preserves tissue structure and cell-type composition. Report co-localization effect sizes and adjusted p-values, then compare across donors or sections.
5. Visualize candidate genes, tissue domains and cell-type proportions in registered coordinates alongside histology or segmentation. Annotate domains using independent markers and check stability across clustering resolutions and held-out sections.

## Statistical/Validation Checklist

- Compare retained and excluded regions and check that spatial signal persists after accounting for library depth, cell density, batch and tissue composition.
- Treat donors or independently sampled specimens as the units of replication. Summarize within-section tests before making population-level inferences.
- Report graph settings, tested genes or pairs, permutation scheme, false discovery rate and replication criteria.

## Expected Artifacts

- Per-section QC table, registration overlay and exclusion mask, with graph parameters and filtering code.
- Spatially variable gene table, ligand–receptor co-localization results and tissue-domain maps with spatial scale.

## Common Pitfalls

- Applying spot-based QC thresholds to segmented cells or comparing raw counts across technologies.
- Connecting neighbors across tissue gaps or separate sections.
- Inferring active signaling from proximity and expression alone.
