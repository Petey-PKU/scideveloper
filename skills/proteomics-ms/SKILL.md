---
name: proteomics-ms
title: Mass Spectrometry Proteomics
description: Quantify protein abundance from DDA or DIA results with peptide-level quality checks and replicate-aware differential analysis.
domain: proteomics
tags: [proteomics, mass spectrometry, DIA, DDA, LFQ, TMT, peptide FDR]
recommendedConnectors: [uniprot, string-db, reactome]
---

## Workflow Steps

1. Join the run manifest to the biological sample table. Record the acquisition mode, FASTA release, search engine, quantification units, batches and repeated injections. For TMT, retain plex and reference-channel mappings.
2. Inspect the search results at PSM, peptide and protein-group levels. Apply declared target-decoy filters, preserve contaminants and decoys in the QC log, and retain protein-group and shared-peptide mappings. Use UniProt to resolve accession changes and document ambiguous groups.
3. Plot identifications per run, retention-time drift, intensity distributions, missingness and replicate agreement. Collapse technical repeats with a documented rule. For TMT, check reporter interference and normalize within plex before aligning shared references.
4. Normalize log-scale input using a method consistent with expected global shifts. Model the predeclared protein contrast with biological replication and blocking as needed. Compare available-case and missingness-sensitive results if detection varies by group.
5. Use detectable or tested proteins as the enrichment universe. Record which STRING evidence channels were used and use Reactome memberships to annotate the results.

## Statistical/Validation Checklist

- Report identification FDR at each relevant level and differential-abundance FDR across all tested groups. Include effect estimates, uncertainty, missingness and peptide support.
- Check design rank and inspect batch effects and technical variation before modeling. Verify that protein-group mapping preserves a traceable unit of inference.
- Compare results under plausible normalization and missingness assumptions. Audit any imputed values by group and intensity range.

## Expected Artifacts

- Run QC, peptide-to-protein mapping, normalization and missingness logs, and a complete contrast table.
- Abundance matrix, QC plots, enrichment output and a versioned methods record.

## Common Pitfalls

- Collapsing shared peptides to a unique protein without evidence.
- Imputing every missing value at the detection limit or treating repeated injections as independent biological samples.
- Interpreting STRING functional associations as direct binding measurements.
