---
name: survival-analysis-cox
title: Kaplan–Meier and Cox Survival Analysis
description: Estimate right-censored survival, compare predefined groups and assess the assumptions of an adjusted Cox model.
domain: statistics
tags: [survival, Kaplan-Meier, Cox, censoring, log-rank, hazard ratio]
recommendedConnectors: [cbioportal, pubmed]
---

## Workflow Steps

1. Define the endpoint, time origin, follow-up units, event indicator and censoring rules. Build one row per eligible participant from a frozen cohort snapshot. Log exclusions and join genomic status at the proper index time.
2. Predefine groups and covariates. Tabulate sample counts, events, follow-up and missingness by group. Inspect the timing of measurements, sampling and treatment relative to the time origin.
3. For simple baseline groups with right censoring, create a CSV with unique `patient_id`, nonnegative `time`, binary `event` (1 event, 0 censored) and `group`. With matplotlib installed, run the helper from this skill directory.

   ~~~sh
   python scripts/kaplan_meier_template.py cohort.csv results --time-unit months
   ~~~

   Compare two prespecified groups with a log-rank test. Report the curves with confidence bands, censor marks and a risk table. Report an unreached median as missing.
4. Fit the adjusted Cox model with predeclared covariates, explicitly coded reference levels and event count appropriate for model complexity. Inspect scaled Schoenfeld residuals, nonlinear covariate effects and influence. Use a time-varying or stratified model if justified. Consider restricted mean survival at a prespecified horizon when proportional hazards is implausible.
5. For delayed entry, recurrent events or competing risks, choose an estimator aligned with the endpoint and risk sets. For example, report cumulative incidence for event probability in the presence of competing events.

## Statistical/Validation Checklist

- Reconcile counts and ensure each person contributes only once to the baseline analysis. Report missing-data handling and censoring rationale.
- Report hazard ratios with 95% confidence intervals, covariate coding and proportional-hazards diagnostics. Document multiplicity for secondary contrasts.
- Inspect risk sets at clinically meaningful times and avoid overinterpreting sparse late follow-up.

## Expected Artifacts

- Cohort-flow and baseline tables, Kaplan–Meier plot and curve data, and group counts and medians.
- Adjusted Cox estimates, model diagnostics and a reproducible endpoint and censoring specification.

## Common Pitfalls

- Assigning baseline exposure using information accrued after the index date, which can introduce immortal-time bias.
- Splitting a continuous biomarker at the most significant cut point.
- Reading a hazard ratio as a relative event probability.
