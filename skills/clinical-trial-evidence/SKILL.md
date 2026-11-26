---
name: clinical-trial-evidence
title: Clinical Trial Evidence Appraisal
description: Appraise registered clinical trials, reconcile prespecified outcomes with publications and summarize comparable treatment effects.
domain: clinical
tags: [clinical trials, CONSORT, intention to treat, hazard ratio, risk ratio, number needed to treat, forest plot]
recommendedConnectors: [clinicaltrials, pubmed, openalex]
---

## Workflow Steps

1. Specify the population, intervention, comparator, outcome and follow-up. Retrieve the registration history, protocol, statistical analysis plan and publications by NCT ID. Link companion reports and extract the prespecified endpoint definitions, time points, analysis populations, multiplicity rules and protocol amendments.
2. Classify the trial phase and interpret the endpoints in context. Phase I commonly evaluates safety, dose-limiting toxicity and pharmacokinetics. Phase II explores activity and dose selection. Phase III tests confirmatory efficacy and safety. Phase IV can assess effectiveness, longer-term safety or uncommon harms after approval.
3. Use the [CONSORT 2025 checklist and flow diagram](https://www.bmj.com/content/389/bmj-2024-081123.full) to review randomization, allocation concealment, blinding, participant flow, exclusions, missing outcomes, effect estimates and harms. Record whether the protocol, registry and paper agree. Judge internal validity separately from reporting completeness.
4. For intention-to-treat (ITT), track all randomized participants by assigned arm and record how missing outcomes and intercurrent events were handled. Record the exact rules for modified ITT and per-protocol populations. Compare results across populations and examine how post-randomization exclusions could bias the estimate. Review both ITT and per-protocol estimates for non-inferiority alongside the prespecified margin.
5. Extract an adjusted or unadjusted hazard ratio (HR), 95% CI and model details from the report. With individual time-to-event data, fit the prespecified Cox model and estimate HR as `exp(beta)`. For a binary adverse outcome at a common horizon, calculate `RR = risk_treatment / risk_control` and `ARR = risk_control - risk_treatment`. Compute `NNT = ceil(1 / ARR)` for benefit and report the time horizon. Use `NNH = ceil(1 / abs(ARR))` for increased harm. Transform risk-difference uncertainty on the correct side of zero and show unbounded intervals when it crosses zero.
6. Build a forest plot of comparable HRs or RRs with study labels, analysis population, event counts, comparison direction and 95% CIs. Plot ratios on a log scale with a reference line at 1. Display separate panels for distinct outcome definitions or metrics and pool only when a synthesis model is justified.

## Statistical/Validation Checklist

- Reconcile randomized, analyzed, event and attrition counts by arm. Record missing data assumptions and the distinction between prespecified and exploratory endpoints.
- Check proportional hazards or use a prespecified time-varying effect or restricted mean survival time when appropriate. Estimate absolute risk at the same horizon by arm using methods that handle censoring and competing events.
- Verify denominators, CI methods and whether the direction of benefit agrees between tables and plots. Use a method suited to sparse cells when an arm has zero events.

## Expected Artifacts

- Trial evidence table with NCT IDs and publication links, CONSORT appraisal and endpoint discrepancy log.
- Effect-size table with CIs, analysis populations and time horizons, plus a reproducible forest plot.

## Common Pitfalls

- Interpreting a hazard ratio as a risk ratio or deriving it from a ratio of median survival times.
- Treating an exploratory subgroup or surrogate endpoint as confirmatory evidence.
- Converting an uncertain absolute risk difference into a single NNT without showing uncertainty.
