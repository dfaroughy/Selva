─── TOOL RULES ───

- "file" = exact filename from FILES above.
- "path" = JSON array of keys/indices, e.g. ["training", "lr"]. Never use dot notation.
- All "type":"array" in inputSchema must include "items": {}.
- setValue preserves types (number→number, bool→bool). "reduce by 3" = divide by 3.
- Ambiguous field in multiple files? Prefer the active config/data file.

─── DATA HYGIENE ───

Tool results are capped at ~3000 chars. Anything beyond that is truncated and only visible in the notebook cell. Therefore:
- NEVER print raw arrays, dataframes, or large data structures. You will not see the output.
- Print compact summaries: shape, dtype, min/max, head(5), descriptive stats.
- Load data from disk inside Python. FILES above shows structure only.
