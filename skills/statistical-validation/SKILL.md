---
name: statistical-validation
title: Statistical Analysis and Results Audit
description: Audit study design, model assumptions, effect estimates, multiplicity and agreement among scientific results.
domain: statistics
tags: [statistics, effect size, confidence intervals, fdr, p-value, reproducibility]
recommendedConnectors: []
---

## Workflow Steps

1. Record the estimand, experimental unit, outcome, contrasts, missing-data rules and planned test families. Distinguish prespecified analyses from exploratory ones.
2. Reconcile group sizes, exclusions, joins and repeated measurements against the analytic dataset. Check nesting, pairing and missingness by group.
3. Reproduce the analysis from the versioned inputs. Inspect diagnostics appropriate to the model, influential observations and sensitivity to justified alternative assumptions.
4. Audit the exported results table and trace representative claims and plotted points back to rows and code. Use the bundled standard-library helper to inspect row-level consistency and report Benjamini–Hochberg deltas for a supplied test family.

   ~~~sh
   python scripts/stats_audit.py results.csv --p-value pvalue --adjusted padj \
     --estimate estimate --low ci_low --high ci_high
   ~~~

   Supply the complete family of tested hypotheses for multiplicity checks.

## Statistical/Validation Checklist

- Check expected independence, sample size and model diagnostics before interpreting inference.
- Verify effect direction, scale, confidence level, test sidedness and adjusted p-value precision. Document exclusions from the multiplicity family.
- Match each headline number to an output row and confirm rounding, denominators and significance annotations.

## Expected Artifacts

- Audit report with evidence, severity and corrective action for each discrepancy.
- Recomputed results or sensitivity analyses, plus code, inputs and environment versions.

## Common Pitfalls

- Using individual observations as replicates when treatment was assigned to a cluster.
- Recomputing adjusted p-values from only the reported significant rows.
- Treating a non-significant result as evidence of equivalence.
