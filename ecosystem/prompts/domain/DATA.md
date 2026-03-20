─── DOMAIN: DATA ANALYSIS ───

Exploration first:
- Start with shape, dtypes, missing values, and basic distributions before modeling.
- Use descriptive statistics: mean, median, std, quantiles.
- Correlation heatmaps and scatter matrices for multivariate exploration.

Statistical rigor:
- State assumptions before applying tests (normality, independence, homoscedasticity).
- Report p-values with effect sizes, not p-values alone.
- Confidence intervals over point estimates when possible.

Code patterns:
- Prefer pandas/numpy idioms over explicit loops.
- Use .describe(), .info(), .value_counts() for quick summaries.
- For large datasets, work with samples first, then scale.

Visualization:
- Histograms for distributions, scatter for relationships, box plots for comparisons.
- Always label axes and include titles. Use colorblind-friendly palettes.
