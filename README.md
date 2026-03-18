# Selva

Selva is a VS Code extension and MCP-backed workspace for working with YAML
projects through a notebook-style agent interface.

It combines:

- a visual YAML/dashboard editor
- a persisted notebook UI
- a Trail-based session model
- a stateful Python kernel per Trail
- an MCP server that exposes the workspace to external coding agents

Selva is built for config-heavy, data-heavy workflows where you want the
interface of a notebook, the structure of a dashboard, and the control surface
of deterministic tools.

## What Selva Is

At a high level, Selva turns a folder of YAML files into an interactive working
environment.

Inside the panel you can:

- browse config and data YAML files
- inspect and edit structured fields
- pin or lock values in the dashboard
- ask Jane, Selva's runtime agent, to explain, plot, or modify the workspace
- write markdown and Python cells into a persistent notebook
- switch between Trails, which are long-lived notebook/session lineages for the
  same workspace

Selva is not a generic chat app glued onto files. The notebook, dashboard,
tooling, and persisted session state are first-class parts of the product.

## Core Concepts

### Jane

Jane is Selva's persisted runtime for the active workspace. It keeps track of:

- notebook entries and cells
- conversation history
- dashboard state
- model configuration
- bootstrap state
- pending external drafts

Jane can be driven from inside the Selva panel or through MCP tools by external
coding agents such as Claude Code or Codex-style clients.

### Trails

A Trail is a persisted notebook lineage for a workspace.

Each Trail stores:

- notebook entries and cells
- Jane session state
- dashboard state
- conversation continuity

Trails live under:

```text
.selva/trails/
```

Each Trail is stored as a `.svnb` file. New Trails are named with jungle-style
bigrams such as `Okapia Callidryas`, and their ids/files derive from that name.

### Notebook Cells

Selva notebooks support:

- markdown cells
- Python cells
- diff and image-like persisted cell payloads used internally by the runtime

Python cells are part of the persisted notebook, not transient console output.
This means Jane and external agents can record work directly into the notebook
instead of only replying in chat.

### Stateful Python Kernel

Python execution is stateful within the active Trail.

That means:

- variables persist across Python cells in the same Trail
- notebook execution behaves more like Jupyter than one-shot `python -c`
- Trails isolate Python state from one another
- the notebook UI exposes kernel status, interrupt, and restart controls

Selva still prefers file-backed data to live on disk. Large datasets should be
loaded from files in code, not pushed into model context.

## Main Features

- Visual YAML workbench for config and data files
- Notebook-first workflow with persistent markdown and Python cells
- Trail management for multiple long-lived notebook lineages per workspace
- Stateful Python kernel with per-Trail isolation
- Kernel lifecycle controls: status, interrupt, restart
- Inline Python cell editing/debugging through connected coding agents
- MCP server for external agents
- Deterministic workspace tools for reading schema, setting values, locking,
  pinning, and executing Python
- Self-extending tool ecosystem through `propose_tool`

## Current Tooling Model

Selva exposes three layers of capability:

### 1. Workspace Tools

These are deterministic tools that operate directly on the workspace, including:

- `execute_python`
- `get_file_schema`
- `setValue`
- `setFileType`
- `pinField` / `unpinField`
- `lockField` / `unlockField`
- `lockAllInFile` / `unlockAllInFile`
- `propose_tool`

### 2. Jane Session Tools

These manage the persisted notebook/session runtime:

- `jane_init`
- `jane_get_instruction_pack`
- `jane_trail_list`
- `jane_trail_new`
- `jane_trail_fork`
- `jane_trail_switch`
- `jane_trail_rename`
- `jane_apply_ops`
- `jane_add_cells`
- `jane_update_cell`
- `jane_session_get`
- `jane_session_set_model`
- `jane_session_set_instructions`
- `jane_session_clear`
- `jane_session_bootstrap`
- `jane_session_run`
- `jane_session_record_entry`

### 3. Notebook UI Controls

Inside the panel, Selva also provides:

- add markdown/Python cell
- insert above / insert below on Python cells
- run cell
- copy cell
- inline edit/debug prompt
- Trail selection and management
- kernel toolbar

## Architecture

Important pieces of the codebase:

- `extension.js`
  - VS Code activation, panel lifecycle, message bridge, command registration
- `mcp-server.js`
  - stdio MCP server that exposes workspace and Jane tools
- `lib/jane-runtime.js`
  - Jane session runtime, Trail-aware notebook/session tools
- `lib/session-store.js`
  - persisted session and Trail storage
- `lib/notebook-execution.js`
  - notebook execution dispatch layer
- `lib/kernel-manager.js`
  - stateful notebook kernel manager
- `lib/python-kernel-worker.py`
  - Python worker process used by the kernel
- `lib/selva-runtime.js`
  - workspace runtime and deterministic tool loading
- `ecosystem/tools/`
  - built-in tool implementations
- `media/` and `webview.html`
  - notebook/dashboard UI

## What Gets Persisted

Selva persists notebook and session state to disk, but it does not blindly dump
all of that into model context on the next run.

The full Trail stays on disk as the source of truth. Selva selectively loads and
summarizes the relevant parts for Jane and connected agents.

This is especially important for large data files:

- Selva's schema tools return structure, not raw YAML payload dumps
- large numeric data should be loaded from disk in Python code
- notebook/kernel state persists independently from the model context window

## Requirements

- VS Code `^1.95.0`
- Node.js for extension development
- Python 3 available as `python3`

If you want direct API access from inside Selva, provide:

- `ANTHROPIC_API_KEY`
- and/or `OPENAI_API_KEY`

Selva can also use VS Code language model integrations when available.

## Development Setup

Clone the repository and install dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Start the MCP server manually:

```bash
npm run mcp -- /path/to/workspace
```

For extension development:

1. Open this repository in VS Code.
2. Run the extension in a VS Code Extension Development Host.
3. Open a YAML workspace folder in that host.
4. Run the `Selva` command.

Selva also contributes a keyboard shortcut:

- `Ctrl+Shift+J`
- `Cmd+Shift+J` on macOS

## Using Selva

### Open a Workspace

Selva is designed around a workspace directory containing YAML files. Open the
folder in VS Code, then launch Selva from:

- the command palette via `Selva`
- the Explorer context menu on a folder
- the keyboard shortcut

### Work in the Panel

Inside the panel you can:

- browse config and data files
- inspect file structure
- edit structured values
- write notebook cells
- run Python
- manage Trails

### Use Jane or External Agents

External coding agents should initialize with:

1. `jane_init`
2. `jane_get_instruction_pack` only when needed
3. Trail/session tools and deterministic workspace tools

The recommended pattern is:

- keep Selva as the source of truth
- use workspace tools for deterministic operations
- write notebook-visible results with `jane_add_cells` or
  `jane_session_record_entry`

## Storage Model

Workspace-local state lives under:

```text
.selva/
```

This includes Trail files and supporting metadata. Legacy session resurrection
has been disabled once a workspace has initialized its Trail store, so deleting
Trails does not pull old session history back in from the pre-Trail storage
model.

## Design Principles

- Notebook first, not chat first
- Persist state explicitly
- Keep large raw data on disk, not in prompt context
- Prefer deterministic tools over free-form agent behavior
- Treat Selva as the source of truth for notebook, dashboard, and staged edits
- Keep Python execution stateful inside a Trail, but isolated between Trails

## Project Status

Selva currently supports a kernel-backed Python notebook workflow and a
Trail-based persisted Jane runtime. The architecture is intentionally moving
toward stronger notebook semantics and cleaner agent/tool boundaries rather than
a generic file editor with chat on top.

## License

MIT
