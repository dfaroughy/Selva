# Skill Framework Plan

## Vision

A skill is a reusable research recipe that Jane can discover, execute, and evolve. Unlike atomic tools (which do one thing — read a file, set a value), a skill encodes a *multi-step research pattern* — the kind of thing a researcher does repeatedly but with different parameters.

Examples:
- "EDA on a dataset" — load → shape/dtypes → missing values → distributions → correlations → summary plot
- "Hyperparameter sweep" — read config → define grid → loop: set value → train → collect metric → plot comparison
- "Plot with uncertainties" — load data → compute mean/std → matplotlib with error bars → label axes with units
- "Cross-validation report" — split data → train N folds → collect metrics → compute mean ± std → confusion matrix

## Architecture

### Skill = Markdown recipe + Python implementation

```
.selva/skills/                          # workspace-local skills
  eda/
    SKILL.md                            # natural language: when to use, what it does, parameters
    skill.py                            # the implementation (a Python function or script)
  hyperparameter_sweep/
    SKILL.md
    skill.py

~/.selva/skills/                        # global skills (shared across workspaces)
  plot_with_uncertainties/
    SKILL.md
    skill.py
```

### SKILL.md format

```markdown
---
name: eda
description: Exploratory data analysis on a dataset
domain: data, ml                        # when to surface this skill
triggers:
  - "do an EDA"
  - "explore the data"
  - "what does the dataset look like"
parameters:
  - name: file_path
    description: Path to the data file (CSV, NPZ, parquet, ROOT)
  - name: target_column
    description: Optional target variable for correlation analysis
    optional: true
version: 1
author: jane                            # or "human" — who created it
created: 2026-03-20
last_used: 2026-03-20
use_count: 3
---

## What this skill does

1. Loads the dataset and reports shape, dtypes, memory usage
2. Checks for missing values and duplicates
3. Computes descriptive statistics (mean, std, min, max, quartiles)
4. Plots distributions of all numeric columns (histograms)
5. Computes and plots a correlation matrix
6. If a target column is specified, shows target vs feature correlations

## When to use

When the researcher asks to explore, inspect, or understand a dataset for the first time. Not for targeted analysis — use specific tools for that.

## Notes

- For large datasets (>100k rows), sample before plotting
- For ROOT files, use uproot
- Always report the number of rows/columns prominently
```

### skill.py format

```python
"""
Selva Skill: eda
Exploratory data analysis on a dataset.
"""

def run(file_path, target_column=None):
    """
    Parameters are injected from the skill call.
    This function runs in the Trail's Python kernel (stateful).
    """
    import numpy as np
    import pandas as pd
    import matplotlib.pyplot as plt

    # Step 1: Load
    if file_path.endswith('.csv'):
        df = pd.read_csv(file_path)
    elif file_path.endswith('.npz'):
        data = np.load(file_path)
        df = pd.DataFrame({k: data[k].flatten() for k in data.files})
    else:
        raise ValueError(f"Unsupported format: {file_path}")

    print(f"Shape: {df.shape}")
    print(f"Dtypes:\n{df.dtypes}")
    print(f"Memory: {df.memory_usage(deep=True).sum() / 1e6:.1f} MB")

    # Step 2: Missing values
    missing = df.isnull().sum()
    if missing.any():
        print(f"\nMissing values:\n{missing[missing > 0]}")
    else:
        print("\nNo missing values.")

    # Step 3: Descriptive stats
    print(f"\nDescriptive statistics:\n{df.describe()}")

    # Step 4: Distributions
    numeric = df.select_dtypes(include=[np.number])
    n_cols = min(len(numeric.columns), 12)
    if n_cols > 0:
        fig, axes = plt.subplots(2, (n_cols + 1) // 2, figsize=(12, 6))
        for ax, col in zip(axes.flat, numeric.columns[:n_cols]):
            ax.hist(numeric[col].dropna(), bins=50, alpha=0.7)
            ax.set_title(col, fontsize=9)
        plt.tight_layout()

    # Step 5: Correlation matrix
    if len(numeric.columns) > 1:
        fig, ax = plt.subplots(figsize=(8, 6))
        corr = numeric.corr()
        im = ax.imshow(corr, cmap='coolwarm', vmin=-1, vmax=1)
        ax.set_xticks(range(len(corr.columns)))
        ax.set_yticks(range(len(corr.columns)))
        ax.set_xticklabels(corr.columns, rotation=45, ha='right', fontsize=8)
        ax.set_yticklabels(corr.columns, fontsize=8)
        plt.colorbar(im)
        plt.title("Correlation Matrix")
        plt.tight_layout()

    # Step 6: Target correlations
    if target_column and target_column in numeric.columns:
        target_corr = numeric.corr()[target_column].drop(target_column).sort_values()
        print(f"\nCorrelations with '{target_column}':\n{target_corr}")
```

## How skills work at runtime

### Discovery

When Claude connects via MCP, the connect prompt includes a **skill catalog** — a compact list of available skills with their triggers:

```
─── AVAILABLE SKILLS ───
- eda: Exploratory data analysis on a dataset [triggers: "do an EDA", "explore the data"]
- hyperparameter_sweep: Systematic parameter search [triggers: "sweep", "grid search"]
- plot_with_uncertainties: Publication-quality plots with error bars [triggers: "plot with errors"]
```

This is assembled at connect time by scanning `.selva/skills/` and `~/.selva/skills/`, reading each `SKILL.md` frontmatter.

### Execution

When Jane recognizes a skill trigger, she:

1. Reads the full `SKILL.md` for context
2. Reads `skill.py` for the implementation
3. Adapts the parameters to the current workspace (fills in file paths, column names, etc.)
4. Executes the adapted code via `execute_python` in the Trail kernel
5. Records the results in the notebook via `jane_add_cells`

Jane doesn't blindly run `skill.py` — she *uses it as a template*. She might modify it, skip steps, or add steps based on the researcher's specific request. The skill is a starting point, not a rigid script.

### Creation

Skills are created in three ways:

1. **Jane proposes a skill** — after doing something multi-step for the first time, Jane can call `jane_create_skill` to save the pattern:
   ```
   jane_create_skill({
     name: "eda",
     description: "Exploratory data analysis",
     triggers: ["do an EDA", "explore the data"],
     domain: ["data", "ml"],
     code: "..."  # the Python implementation
   })
   ```

2. **Human creates a skill** — the researcher writes `SKILL.md` + `skill.py` manually in `.selva/skills/` or `~/.selva/skills/`

3. **Promotion from notebook** — a successful sequence of notebook cells can be "promoted" to a skill. Jane extracts the pattern, generalizes the parameters, and saves it.

### Evolution

Skills evolve through use:

- `use_count` and `last_used` track usage frequency
- Jane can update a skill's implementation after the researcher gives feedback
- The bitácora can reference skills: "Used the EDA skill on the training data — added a step for class balance because the dataset is imbalanced"
- Skills can be versioned (v1, v2, ...) with the old version kept for reference

## MCP tools for skills

### `jane_list_skills`
List all available skills (workspace + global). Returns name, description, triggers, domain, use_count.

### `jane_read_skill`
Read the full SKILL.md and skill.py for a specific skill. Jane calls this before adapting/executing a skill.

### `jane_create_skill`
Create a new skill from a recipe. Writes SKILL.md + skill.py to `.selva/skills/` (workspace) or `~/.selva/skills/` (global).

Input: `{ name, description, triggers, domain, parameters, code, global? }`

### `jane_update_skill`
Update an existing skill's code or metadata.

Input: `{ name, code?, description?, triggers?, parameters? }`

## Relationship to propose_tool

`propose_tool` creates **atomic tools** — single functions exposed as MCP tools with a JSON schema. These are the building blocks.

Skills are **composed recipes** — multi-step patterns that call multiple tools (including `execute_python`) in sequence. Skills are not MCP tools themselves — they're templates that Jane executes through existing tools.

The distinction:
- **Tool**: "execute this Python code" (atomic, schematized, callable via MCP)
- **Skill**: "do an EDA" (multi-step, parameterized, executed by Jane as a sequence of tool calls)

`propose_tool` stays for creating new atomic tools. The skill framework is a layer above.

## What to fix in propose_tool

Before building the skill framework, fix these issues in the existing tool system:

1. **Remove approval gate** — auto-approve tools created via MCP (Claude is trusted)
2. **Remove webview context** — only "extension" context tools work with MCP. Webview tools are dead.
3. **Surface user tools in connect prompt** — Claude should know what custom tools exist
4. **Fix model attribution** — tools show `model: 'json-fallback'` which is from the dead agent

## Implementation phases

### Phase 1: Fix propose_tool (prerequisite)
- Remove approval gate (auto-approve on creation)
- Remove webview context support
- Surface custom tools in jane_init response

### Phase 2: Skill infrastructure
- Create `.selva/skills/` directory convention
- `jane_list_skills` MCP tool — scan and return skill catalog
- `jane_read_skill` MCP tool — return full SKILL.md + skill.py
- `jane_create_skill` MCP tool — write SKILL.md + skill.py
- `jane_update_skill` MCP tool — modify existing skill

### Phase 3: Skill discovery in connect prompt
- Scan skills at connect time
- Include skill catalog summary in the connect prompt
- Domain-filtered: only show ML skills for ML workspaces

### Phase 4: Skill creation from notebook
- "Promote to skill" button on notebook entries
- Jane can suggest skill creation after multi-step work
- Parameter extraction and generalization

### Phase 5: Skill sharing
- Export skills as standalone packages
- Import skills from other workspaces
- Community skill library (future)

## Directory structure after implementation

```
Selva/
  ecosystem/
    tools/                  # built-in atomic tools (execute_python, set_value, etc.)
    prompts/                # prompt files (SYSTEM.md, TOOLS.md, etc.)
    skills/                 # built-in skills shipped with Selva (optional)
  lib/
    skill-manager.js        # skill discovery, loading, CRUD

~/.selva/
  ecosystem/
    tools/                  # user-created atomic tools (via propose_tool)
  skills/                   # global user skills

{workspace}/
  .selva/
    trails/                 # trail data
    skills/                 # workspace-local skills
```
