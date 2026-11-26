---
name: meta-analysis-prisma
title: PRISMA Systematic Review and Meta-Analysis
description: Screen evidence using PRISMA 2020 and synthesize compatible effect estimates with heterogeneity and small-study effect diagnostics.
domain: statistics
tags: [systematic review, PRISMA 2020, meta-analysis, heterogeneity, random effects, funnel plot]
recommendedConnectors: [pubmed, openalex, biorxiv, clinicaltrials]
---

## Workflow Steps

1. Record the question, eligibility criteria, outcome hierarchy, effect measures and synthesis plan in a dated protocol. Search PubMed, OpenAlex, bioRxiv and trial registries using translated search strings. Record dates, filters and returned counts. Use the `biorxiv` or `arxiv-biorxiv` connector ID for preprints.
2. Follow the [PRISMA 2020 checklist and flow diagram](https://www.prisma-statement.org/prisma-2020). Deduplicate records, independently screen titles and abstracts, retrieve eligible full texts, resolve reviewer disagreements and record one exclusion reason per excluded full text. Link preprints, registrations and follow-up reports to unique studies. Reconcile identified, deduplicated, screened, sought, unretrieved, excluded and included counts.
3. Independently verify extracted events, denominators, means and variances or model estimates against source tables. Convert compatible ratios to the log scale and derive standard errors from compatible CIs when needed. Orient effects consistently and account for shared controls, repeated outcomes and multiple reports.
4. Fit a fixed-effect model with inverse-variance weights `1 / v_i` for a common effect. For DerSimonian–Laird random effects, calculate Cochran's `Q = sum(w_i * (y_i - y_FE)^2)` and `tau^2 = max(0, (Q - (k - 1)) / (sum(w_i) - sum(w_i^2) / sum(w_i)))`. Refit with weights `1 / (v_i + tau^2)` for an average effect. Prespecify the model based on the studies and estimand. Compare DL with REML and an appropriate Hartung–Knapp interval when studies are few or heterogeneous. See the [Cochrane synthesis methods](https://training.cochrane.org/handbook/current/chapter-10).
5. For at least two independent effects, report `Q`, its `k - 1` degrees of freedom, `I² = max(0, (Q - (k - 1)) / Q) * 100%` for positive Q, and `tau²`. Use zero for I² when Q is zero. Report uncertainty and a prediction interval when support is adequate. Show study and pooled effects in a forest plot and test the influence of high-risk studies and individual studies.
6. With at least 10 comparable studies and adequate spread of standard errors, inspect a funnel plot and test for small-study effects. Where appropriate, regress standardized effects `y_i / SE_i` on precision `1 / SE_i` and report the Egger intercept with its uncertainty. Consider effect-specific alternatives for binary outcomes and plausible sources of asymmetry. See the [Cochrane guidance on missing evidence](https://training.cochrane.org/handbook/current/chapter-13).

## Statistical/Validation Checklist

- Check that study, report and record counts reconcile and identify how overlapping participants were handled.
- Assess risk of bias by outcome. Explain pooling decisions and report effect scale, variance estimators, interval methods and sensitivity analyses.
- Check coding of zero events, conversions from CIs, comparability of follow-up and subgroup interaction tests. Record outcomes for which a narrative synthesis is more appropriate.

## Expected Artifacts

- Protocol, reproducible search log, screening decisions, PRISMA flow diagram and risk-of-bias table.
- Study-level effect data, analysis code, forest and funnel plots, and model and sensitivity results.

## Common Pitfalls

- Screening multiple publications as independent studies or entering the same control group twice.
- Selecting fixed or random effects solely from a heterogeneity p-value.
- Reading funnel asymmetry as proof of publication bias or a nonsignificant test as evidence of symmetry.
