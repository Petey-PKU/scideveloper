---
name: structural-biology-pdb
title: PDB Structure Selection and Validation
description: Retrieve and validate public PDB structures for chain mapping, assembly inspection and comparative structural analysis.
domain: structural-biology
tags: [pdb, rcsb, mmcif, protein structure, chain mapping, alignment]
recommendedConnectors: [rcsb-pdb, uniprot, pubmed]
---

## Workflow Steps

1. Identify the target accession, isoform, organism and region of interest. Use RCSB PDB and UniProt to shortlist entries by construct coverage and experimental method.
2. Retrieve mmCIF coordinates and validation reports. Record the entry and assembly IDs, construct variants, ligand state and retrieval date.
3. Map residues to the reference sequence. Preserve author and archive chain identifiers, insertion codes, unresolved residues and alternate conformations.
4. Inspect the relevant assembly and region. For comparisons, align equivalent residues and report the alignment method, paired residue count and RMSD together.

## Statistical/Validation Checklist

- Check method-specific evidence, such as crystallographic resolution and R-free, or local map support for cryo-EM.
- Inspect local completeness, occupancy, alternate conformers and geometry before interpreting individual contacts.
- Verify the structure-derived observations against the coordinate file and report the limitations of the construct and experimental state.

## Expected Artifacts

- Source mmCIF, validation reference, chain and residue mapping table, and annotated structural view.
- Selection and alignment summary with entry revisions, identifiers and parameters.

## Common Pitfalls

- Confusing the asymmetric unit with the biological assembly or author numbering with reference numbering.
- Comparing RMSDs calculated across different residue sets without documenting coverage.
