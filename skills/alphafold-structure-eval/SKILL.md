---
name: alphafold-structure-eval
title: AlphaFold Structure Confidence Evaluation
description: Evaluate local residue confidence and domain placement for human AlphaFold DB models against UniProt annotations and PDB evidence.
domain: structural-biology
tags: [alphafold, pLDDT, PAE, structure, uniprot, domain alignment]
recommendedConnectors: [alphafold-db, uniprot, rcsb-pdb]
---

## Workflow Steps

1. Resolve the UniProt accession and isoform and map the residue numbering to the model. Record the AlphaFold model ID, version, model range and download URLs. Check for fragments or gaps before assigning domain boundaries.
2. Use `confidence_summary` to obtain mean and region-level pLDDT. Map scores onto coordinates and review the residues needed for the question. Use the usual 90, 70 and 50 thresholds to describe confidence and report coverage for every region.
3. Read the PAE matrix. Compare within-domain and inter-domain blocks to assess relative placement. Inspect both directions for region pairs because PAE can be asymmetric.
4. Select comparable PDB entries and align corresponding residues within a domain and across domains separately. Report construct, coverage, RMSD or TM-score, experimental method, and relevant differences in bound ligands, oligomeric state or conformation.
5. Record which claims each model supports, including uncertainties around loops, interfaces and regions missing from benchmarks.

## Statistical/Validation Checklist

- Check that the confidence array, sequence and coordinate numbering refer to the same model version. Use an explicit alignment when numbering differs.
- Report regional residue counts and confidence summaries alongside the global mean. Review local confidence at any proposed contact residues.
- Inspect template or experimental overlap and document when model-to-PDB comparisons cannot establish independent validation.

## Expected Artifacts

- Versioned structures and PAE, residue mapping and domain confidence table, colored model or plot, and experimental alignment report.

## Common Pitfalls

- Interpreting pLDDT as experimental B-factor or ligand-binding evidence.
- Assuming individually confident domains have a confident relative orientation.
- Treating low confidence alone as proof of intrinsic disorder.
