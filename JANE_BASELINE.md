# Jane Baseline Architecture

## Goal

Turn Jane into a first-class Selva runtime that can be driven from:

- the Selva webview UI
- MCP clients
- future CLI or automation clients

without reimplementing the agent loop, notebook behavior, or tool execution in each surface.

## Why Refactor

Today Selva is split across three partially overlapping runtimes:

- `extension.js` owns the real webview-driven agent flow
- `mcp-server.js` owns a separate MCP-facing workspace/tool runtime
- `media/agent.js` owns part of prompt/session state in the browser

That split is the main scaling problem. New features have to be duplicated or awkwardly bridged, which makes Jane harder to extend and harder to trust as the product surface grows.

## Target Architecture

### 1. Backend-Owned Jane Runtime

Jane should become a backend runtime, not a webview behavior.

Responsibilities:

- build the system prompt
- manage conversation turns
- execute the model/tool loop
- return structured artifacts
- own cancellation and token accounting

The extension host remains the best first home for this runtime because it can access `vscode.lm` directly.

### 2. Shared Tool Runtime

All workspace and tool behavior should live in one shared backend module:

- YAML discovery, parsing, and saving
- built-in tool definitions
- ecosystem tool loading
- user tool overrides
- Python execution
- dynamic tool registration

This runtime must be shared by both the extension host and the MCP server.

### 3. Session Store

Jane sessions should be backend-owned and addressable by workspace/config directory.

Session state should include:

- loaded files and schemata
- dashboard state
- conversation history
- notebook cells and artifacts
- model selection
- additional instructions
- cancellation state

### 4. Thin Clients

The webview and MCP should become adapters around the same runtime.

They should translate transport-specific messages, but not own business logic.

## Data Contract

Jane responses should move toward a structured result shape:

- `answer`
- `ops`
- `cells`
- `images`
- `usage`
- `error`

That gives Selva a stable contract for editable markdown and Python cells in the UI and makes MCP parity possible.

## Recommended Refactor Order

### Slice 1. Shared backend/runtime layer

Extract common workspace and tool logic out of `extension.js` and `mcp-server.js`.

This slice should provide:

- shared tool loading helpers
- shared workspace file helpers
- shared MCP-facing built-in tool behavior

### Slice 2. Agent-core extraction

Move the `agentPrompt` execution path from `extension.js` into a dedicated backend module.

That module should accept prompt/session/tool context and return typed artifacts rather than webview-specific side effects.

### Slice 3. Backend-owned sessions

Move conversation history, notebook state, and artifact history out of the webview and into a session store keyed by workspace.

### Slice 4. MCP Jane surface

Expose Jane itself, not just low-level tools, through MCP.

Likely MCP tools:

- `jane_session_run`
- `jane_session_bootstrap`
- `jane_session_get`
- `jane_session_set_model`
- `jane_session_set_instructions`
- `jane_update_cell`
- `jane_delete_cell`

## Design Constraints

### Keep `vscode.lm` First-Class

If Jane moves entirely out of the extension host too early, Selva loses direct access to VS Code language models.

The better near-term baseline is:

- Jane runtime inside the extension host
- MCP bridge into that runtime
- direct API adapters as fallback

### Keep Python Isolated

Python analysis should continue to run in a subprocess boundary. That keeps the extension host responsive and makes the behavior easier to port later.

### Make Contracts Portable

Even if the first baseline is extension-host-centric, runtime modules and result contracts should stay portable enough to move into a standalone service later.

## What This Refactor Implements

This initial refactor focuses on Slice 1:

- introduce a shared Selva backend/runtime module in `lib/`
- remove duplicated tool-loading/runtime behavior from `extension.js` and `mcp-server.js`
- make the MCP server consume the shared runtime rather than maintaining its own parallel copy

That does not yet make MCP a full Jane client, but it creates the backend seam needed for the next slices.
