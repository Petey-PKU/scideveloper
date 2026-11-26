---
name: molecular-docking-vina
title: AutoDock Vina Pose Evaluation
description: Benchmark noncovalent docking of small molecules against a human target using a reference crystal pose and reproducible Vina settings.
domain: structural-biology
tags: [docking, AutoDock Vina, PDBQT, ligand, redocking, RMSD]
recommendedConnectors: [rcsb-pdb, pubchem, chembl]
---

## Workflow Steps

1. Select a structure of the intended human target and binding state with a resolved noncovalent ligand. Map the construct, mutations, missing residues, metals and waters. For a reference workflow, use the human EGFR kinase–erlotinib structure (PDB 1M17).
2. Save the experimental ligand pose separately for redocking. Prepare receptor and ligands with consistent protonation, stereochemistry and atom typing. Save both source structures and prepared PDBQT files. Record retained cofactors and crystallographic waters.
3. Center the box on the reference ligand and size it to cover the pocket. Record coordinates and dimensions in Å. Run a fixed seed and predeclare a search sensitivity check.

   ~~~sh
   vina --receptor receptor.pdbqt --ligand ligand.pdbqt --config pocket.txt --exhaustiveness 16 --seed 12345 --out poses.pdbqt
   ~~~

4. Align receptors and compare heavy-atom poses with symmetry-aware RMSD. Report best-pose and top-ranked-pose RMSD separately. If the reference pose cannot be recovered, inspect protonation, torsions, box coverage and alternate receptor states before comparing candidates.
5. Inspect protein–ligand contacts and steric clashes. If making ranking claims, evaluate against comparable known actives and decoys before using scores to prioritize compounds.

## Statistical/Validation Checklist

- Record software versions, scoring function, seeds, pocket bounds and prepared ligand states. Treat a redocking threshold such as 2 Å as a protocol-specific criterion.
- Compare pose stability across seeds and keep all scored poses. Use comparable assays from ChEMBL for activity benchmarks.

## Expected Artifacts

- Reference structures, prepared inputs, box configuration, pose files, score and RMSD table, and binding-site overlays.

## Common Pitfalls

- Comparing raw scores across different targets or ligand preparation policies.
- Interpreting Vina scores as measured binding free energy.
- Using noncovalent scoring to model formation of a covalent bond.
