---
name: metabolomics-lcms
title: LC–MS Metabolomics
description: Process LC–MS feature tables, quantify batch and blank effects, and document metabolite identification confidence.
domain: metabolomics
tags: [metabolomics, LC-MS, pooled QC, MS/MS, feature alignment, adducts]
recommendedConnectors: [kegg, pubchem, chembl]
---

## Workflow Steps

1. Lock a manifest with run order, batch, polarity, blanks, pooled QCs, internal standards, dilution and biological sample IDs. Process ionization modes separately and retain the original files.
2. Detect peaks and align retention times with versioned parameters. Examine standards, total ion current and pooled QC traces. Flag carryover and record exclusions with the corresponding chromatograms.
3. Set blank-ratio, detection and pooled-QC variability filters before testing. Fit any run-order correction from pooled QC injections within batch, then compare drift and QC dispersion on held-out or interleaved QCs.
4. Group isotopes, in-source fragments and adducts. Record accurate mass, retention time, polarity and MS/MS matches, including competing candidates. Use PubChem for structures and KEGG for pathway mapping. Assign identification confidence based on spectral evidence and authentic standards where available.
5. Fit the sample-level contrast on normalized features with relevant batch or pairing terms. For targeted absolute quantification, retain calibrator curves, LLOQ/ULOQ, dilution factors and QC acceptance results.

## Statistical/Validation Checklist

- Record mass error in ppm, RT tolerance, peak integration failures and the filter denominator. Report adjusted p-values and effect sizes for tested features.
- Inspect internal-standard drift and biological separation before and after normalization. Check whether batch and biological group are confounded.
- For pathway analysis, propagate ambiguous identities and compare results after collapsing redundant features and restricting to higher-confidence identities.

## Expected Artifacts

- Versioned peak and feature tables, blank and pooled-QC plots, annotation evidence with confidence levels, and full statistical results.
- Processing manifest, compound identifier mapping and a pathway table with mapping uncertainty.

## Common Pitfalls

- Calling a mass-only database match a confirmed identity.
- Counting positive and negative mode adducts as independent metabolites.
- Applying drift fits outside their QC-supported run range.
