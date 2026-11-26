---
name: survival-kaplan-meier
title: Kaplan-Meier and Cox Survival Analysis
description: Estimate and visualize survival, compare groups and validate adjusted Cox proportional hazards models.
domain: statistics
tags: [Kaplan-Meier, time to event, log-rank, Cox regression, Schoenfeld residuals, concordance]
recommendedConnectors: [cbioportal, clinicaltrials, pubmed]
---

## Workflow Steps

1. Define time origin, event, time units, follow-up, censoring and analysis groups. Verify event coding and reconcile duplicate subjects, delayed entry, time-dependent exposure and competing events before constructing risk sets.
2. Estimate Kaplan–Meier survival by group with step curves, censoring marks, pointwise 95% CI bands and at-risk counts at aligned time ticks. Use Greenwood standard errors with a log-log transformation, median survival with CI when estimable and survival probabilities at prespecified times. Use cumulative incidence for cause-specific absolute event risk in the presence of competing events.
3. Use a prespecified log-rank test to compare unadjusted group curves, with strata if dictated by design. Report test statistics, degrees of freedom, p-values and numbers of events. When hazards vary over time, examine prespecified time-specific contrasts or restricted mean survival differences over supported follow-up.
4. Fit a multivariable Cox proportional hazards model with prespecified covariates, reference categories, tie handling and missing-data strategy. Check functional forms and sparse levels. Report adjusted HRs, 95% CIs, analyzed participants and events, and any stratified or clustered analysis.
5. Inspect scaled Schoenfeld residual plots and test proportional hazards globally and by covariate. Investigate departures using stratification, time-varying coefficients or interpretable alternative estimands as appropriate. See the [weighted residual diagnostic method](https://doi.org/10.1093/biomet/81.3.515).
6. Report the concordance index with uncertainty, explicit censoring handling and assessment on held-out data or optimism-corrected resamples. Consider an inverse-probability-of-censoring weighted estimate at a supported horizon when censoring is substantial. Assess calibration separately for prediction.

## Statistical/Validation Checklist

- Reconcile events, censoring and at-risk counts with the input data. Examine whether censoring is informative and whether the tail has adequate support.
- Check covariate nonlinearity, influential observations, proportional hazards and model complexity relative to the event count. Report validation splits or resampling details.
- Apply time-dependent or landmark designs when exposure can start after time zero. Record the changed target population and time origin for any landmark analysis.

## Expected Artifacts

- Analysis-ready time and event data dictionary, cohort flow and censoring summary.
- Kaplan–Meier figure with risk table and CI bands, log-rank results, Cox estimates, residual diagnostics and concordance report.

## Common Pitfalls

- Treating subjects who become exposed later as exposed from baseline and introducing immortal time bias.
- Reading wide tail intervals or an unreached median as a precise survival difference.
- Interpreting the concordance index as calibration or a fitted Cox HR as a constant effect after a proportional hazards violation.
