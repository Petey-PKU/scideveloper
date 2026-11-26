---
name: clinical-variant-interpretation
title: Clinical Variant Evidence Review
description: Build a research evidence record for human germline or somatic variants with transcript-specific identifiers and condition-specific assertions.
domain: clinical
tags: [ClinVar, HGVS, ACMG, somatic, oncogenicity, variant curation]
recommendedConnectors: [clinvar, cbioportal, opentargets, pubmed]
---

## Workflow Steps

1. Record assembly, normalized genomic alleles, transcript accession and version, and genomic, coding and protein HGVS where applicable. Reconcile transcript differences and confirm allele identity before joining evidence.
2. Retrieve ClinVar by Variation ID or VCV and inspect relevant RCV and SCV assertions. Record classification type, condition, review status, submission date, submitter and cited evidence. Inspect conflicts at the assertion level and mark evidence that requires primary-source review.
3. For germline evidence, identify inheritance, phenotype and mechanism. Apply the documented ACMG/AMP framework with any applicable ClinGen expert-panel specifications. Track candidate criteria, strength, rationale and dependent evidence. For somatic evidence, record tumor type, alteration class and disease context. Evaluate oncogenicity and clinical impact using the relevant ClinGen and AMP/ASCO/CAP frameworks.
4. Use cBioPortal for cohort context with the assay and denominator documented. Use Open Targets for gene-level and drug evidence. Verify allele-level claims and therapeutic context against primary literature and current regulator labeling.
5. Compile a dated research evidence summary, unresolved conflicts and the scope of any tentative classification. Route patient-facing interpretation through the responsible clinical laboratory or specialist.

## Statistical/Validation Checklist

- Check population frequency against ancestry coverage, inheritance and penetrance where applicable. Review functional assay validity and use of appropriate controls.
- Reconcile cohort sample versus patient counts, matched-normal availability and assay coverage. Check for repeated cohorts or publications before combining evidence.
- Document evidence versions, classification framework and independent review. Cite sources supporting each applied criterion. [ClinGen sequence variant interpretation](https://clinicalgenome.org/working-groups/sequence-variant-interpretation/) · [AMP/ASCO/CAP somatic guidelines](https://pubmed.ncbi.nlm.nih.gov/27993330/)

## Expected Artifacts

- Normalized variant record, assertion and evidence table, classification worksheet, and a dated limitations and review log.

## Common Pitfalls

- Pooling conflicting assertions that apply to different phenotypes or interpreting gene-level evidence as allele-level evidence.
- Treating tumor recurrence as proof of actionability or transferring a drug interpretation across tumor types or alleles.
- Counting the same patient, functional study or cohort as independent evidence through multiple databases.
