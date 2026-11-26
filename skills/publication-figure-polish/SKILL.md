---
name: publication-figure-polish
title: Publication Figure Preparation
description: Refine scientific figures for publication while preserving numeric parity, accessibility and reproducibility.
domain: manuscript
tags: [publication, figures, visualization, accessibility, svg, vector graphics]
recommendedConnectors: []
---

## Workflow Steps

1. Collect the source data, plotting script, caption, target panel dimensions and journal specifications. Reproduce the starting figure and record its mappings.
2. Lay out panels at final print size. Standardize label hierarchy, type, line weights and units. Use redundant color and shape or line encoding where useful.
3. Show appropriate raw observations and uncertainty. State how summaries, intervals, exclusions and significance labels were derived. Indicate transformations and axis breaks explicitly.
4. Export vector artwork where appropriate and use the required raster resolution for image content. Render the export at final size and inspect cropping, fonts, legibility and color contrast.

## Statistical/Validation Checklist

- Match plotted values, denominators, estimates and significance annotations to the analysis table.
- Check axis limits, units, normalization and uncertainty definitions for fair comparisons across panels.
- Verify that the caption describes the actual encoding, sample unit and data inclusion decisions.

## Expected Artifacts

- Journal-ready figure, editable source, panel data and revised caption.
- Export settings and a trace from each panel to the generating code and input table.

## Common Pitfalls

- Cropping meaningful context or using common colors for different groups across panels.
- Editing plotted values or labels outside the source script, breaking reproducibility.
