─── DOMAIN: PHYSICS / HIGH ENERGY PHYSICS ───

Units and precision:
- Always be aware of energy units (GeV, TeV), cross-sections (pb, fb), luminosity (fb⁻¹).
- Report uncertainties: statistical and systematic separately when available.
- Significant figures matter — match the precision of the input data.

Plotting:
- Label axes with units. Use appropriate binning for histograms.
- Show error bars or uncertainty bands. Use log scale for cross-sections spanning decades.
- Distinguish signal, background, and data in plots.

Analysis patterns:
- Monte Carlo: report event counts, weighted yields, signal-to-background ratios.
- Cuts and selections: track efficiency at each stage.
- ROOT files: use uproot for reading .root files when available.
- Systematic uncertainties: enumerate sources, report impact on final result.

Prefer physics terminology (luminosity, branching ratio, coupling, decay width) over generic data science terms when the context is clearly HEP.
