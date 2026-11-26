---
name: cheminformatics-rdkit
title: RDKit Compound Curation and Similarity
description: Standardize compound structures, compute molecular descriptors and compare chemical similarity with an auditable RDKit workflow.
domain: cheminformatics
tags: [rdkit, smiles, fingerprints, tanimoto, descriptors, compound curation]
recommendedConnectors: [chembl, pubmed]
---

## Workflow Steps

1. Import SMILES or SDF records with source IDs. Preserve the original representation and log every parse or sanitization failure.
2. Define the fragment, charge, tautomer and stereochemistry policies for the task. Apply those policies consistently and retain a mapping from input IDs to standardized structures.
3. Compute task-relevant descriptors and choose a documented fingerprint. Record Morgan radius, vector length, bit or count encoding, chirality settings and similarity metric as applicable.
4. Rank similarity, inspect representative structures and ties, and check whether salts or duplicates dominate the results.

## Statistical/Validation Checklist

- Reconcile input, valid, failed and deduplicated counts. Spot-check structures affected by each standardization operation.
- Keep fingerprint settings identical for queries and reference compounds. Test ranking sensitivity if a threshold drives decisions.
- For predictive evaluation, group duplicate structures and consider scaffold-aware splitting before model fitting.

## Expected Artifacts

- Standardized structures and ID mapping, rejected-record log, descriptor table and similarity results.
- Methods record with RDKit version, standardization settings and fingerprint parameters.

## Common Pitfalls

- Stripping fragments or stereochemistry without checking whether they define the chemical identity of interest.
- Inferring shared bioactivity from a similarity score alone.
