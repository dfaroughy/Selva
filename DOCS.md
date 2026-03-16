# Selva Documentation

## What is Selva?

Selva is a VS Code extension that turns YAML configuration files into a visual, interactive dashboard — and gives you an AI agent that can edit configs, analyze data, plot results, and build its own tools.

It was designed for ML practitioners and scientists who work with experiment configs (hyperparameters, pipeline settings, data tables) and need a faster way to understand, edit, and explore them than reading raw YAML.

---

## Core Concepts

### The Dashboard

When you open Selva on a folder, it discovers all YAML files, classifies them as **config** (editable parameters) or **data** (read-only datasets), and renders them as interactive forms with sliders, toggles, type badges, and search.

You can:
- Edit values directly (text fields, sliders, toggles)
- Pin important fields for quick access
- Lock fields to prevent accidental changes
- Export to JSON
- Save changes back to YAML
- Switch between themes (Midnight, Slate, Nord, Forest, Light, Desert, Sunset)

### The Agent (Jane)

Every dashboard session has an embedded AI agent — internally called **Jane**. Jane can:

- **Answer questions** about your config and data ("what does this field do?", "which channel has the highest efficiency?")
- **Edit configs** via natural language ("reduce learning rate by a factor of 3", "set batch size to 64")
- **Plot data** using matplotlib ("plot the efficiency curves with error bars")
- **Lock, pin, classify** files and fields
- **Create new tools** when no existing tool can do what you need

Jane communicates through the prompt bar at the top of the dashboard. Type a request, press play (or Enter), and Jane responds in the chat area below.

### The Ecosystem

Selva has a unified tool system where every capability — from basic "set a value" to complex "run a Python analysis" — is a tool. Tools live in two places:

**Built-in tools** ship with the extension:
```
ecosystem/tools/
  setValue/          — edit a YAML field value
  setFileType/       — classify a file as config or data
  lockField/         — make a field read-only
  unlockField/       — make a field editable
  lockAllInFile/     — lock every field in a file
  unlockAllInFile/   — unlock every field in a file
  pinField/          — pin a field to the quick-access panel
  unpinField/        — remove a field from pinned
  execute_python/    — run a Python code snippet
  propose_tool/      — create a new tool (self-extending)
```

**User/agent-created tools** live in your home directory:
```
~/.selva/ecosystem/tools/
  setSliderBounds/   — created by Jane to set slider min/max
  setSliderLogScale/ — created by Jane to enable log-scale sliders
  ...
```

Both types follow the exact same format. The agent discovers and uses all tools equally — it doesn't distinguish between built-in and user-created.

---

## How the Agent Works

### Model Selection

Selva supports three ways to connect to an AI model:

**1. VS Code Language Model API (via Copilot)**
If you have GitHub Copilot installed, Selva automatically discovers all available models (GPT-4o, GPT-4.1, Claude, etc.) through VS Code's `vscode.lm` API. Select a model from the dropdown next to the prompt bar.

**2. Direct API (Anthropic / OpenAI)**
If you have your own API keys, add them in Settings (gear icon). Direct API models appear in the dropdown with a `direct:` prefix. This bypasses Copilot entirely and gives you native tool-calling support.

**3. JSON Fallback**
When a model doesn't support structured tool calling (common with Copilot-proxied models), the agent falls back to a text-based protocol: the model outputs JSON ops in its response, which Selva extracts, repairs if malformed (using `jsonrepair`), and executes.

### Tool Calling

When you ask the agent to do something, it decides which tools to call:

```
You: "lock all data files and pin the learning rate"

Agent calls:
  1. lockAllInFile("figure_5a.yaml")
  2. lockAllInFile("submission.yaml")
  3. pinField("trainer.yaml", ["learning_rate"])

Agent responds: "Done — 2 data files locked, learning rate pinned."
```

The agent can call multiple tools in sequence, see the results of each, and decide what to do next. This is a multi-turn tool loop — the agent keeps calling tools until the task is complete.

### Python Execution

When you ask the agent to plot data or run analysis, it uses the `execute_python` tool. Python code runs as a subprocess on your machine with access to matplotlib, numpy, and any packages you have installed.

Plots are captured as base64 PNG images and rendered inline in the dashboard. The agent automatically handles the matplotlib backend (`Agg` for headless rendering) and base64 encoding.

Python code blocks in the agent's answers are rendered as **editable Jupyter-like cells**:
- Syntax-highlighted with GitHub-dark colors
- Editable — click to modify the code
- Runnable — click the play button or press `Shift+Enter`
- Output appears below the code cell (text + images)
- Re-running replaces the previous output

### Conversation Memory

Each dashboard session maintains a conversation history. The agent remembers what you asked before and can reference previous answers:

```
You: "plot the 1b channel"
Agent: [shows plot]

You: "now do the same for 2b"
Agent: [understands "same" = same plot type, different channel]
```

History is managed with a sliding window — older turns are dropped when the context gets too long, but the most recent conversation is always preserved.

---

## Self-Extending Agent

### The Problem

Traditional tools are fixed at development time. If the dashboard doesn't have a "set slider bounds" feature, you're stuck — you have to wait for a developer to add it.

### The Solution

Selva's agent can create new tools at runtime. When Jane encounters a request that no existing tool can handle, she:

1. Recognizes the gap
2. Writes a new tool (JavaScript for dashboard features, Python for analysis)
3. Saves it to `~/.selva/ecosystem/tools/`
4. Registers it immediately in the current session
5. Uses it to complete your request
6. The tool is available in all future sessions

### How It Works

The agent calls `propose_tool` with:
- **name**: tool name (e.g., `setSliderBounds`)
- **description**: what the tool does
- **context**: `webview` (dashboard manipulation) or `extension` (Python/system)
- **code**: the tool implementation
- **inputSchema**: what parameters the tool accepts

Each tool gets a **jungle-themed bigram ID** (e.g., `OrchidDrift_938f0485`) generated from a SHA-256 hash of the code. This ID is deterministic — same code always produces the same bigram.

### Hooks API

Webview tools extend the dashboard through a generic hooks system, without modifying source code:

```javascript
// Per-field overrides (slider bounds, visibility, styling)
state.hooks.fieldOverrides[key] = {
  min: 1e-5,        // slider minimum
  max: 1e-2,        // slider maximum
  step: 0.0001,     // slider step size
  logScale: true,    // use logarithmic scale
  hidden: true,      // hide the field
  readOnly: true,    // disable editing
  style: { ... },    // custom CSS
  label: "LR",       // override display name
};

// Post-render callbacks
state.hooks.onAfterRender.push(() => {
  // manipulate DOM after editors render
});

// Custom CSS injection
state.hooks.injectCSS('my-theme', '.field { border: 1px solid red; }');
```

The renderer automatically checks `fieldOverrides` for every field and applies overrides. Tools don't need to know how the renderer works — they just set state and call `renderEditors()`.

### Tool Audit Trail

Every tool created by the agent is tracked in `~/.selva/ecosystem/tools.lock`:

```json
{
  "setSliderBounds": {
    "id": "OrchidDrift_938f0485",
    "hash": "938f0485...",
    "created_by": "gpt-4.1",
    "created_at": "2026-03-15T...",
    "tested": false,
    "approved": false
  }
}
```

This enables future auditing — a codebase agent (internally called **Tarzan**) can review tools, run tests, and promote good ones to built-in status.

---

## Architecture

### File Structure

```
extension.js              — VS Code extension host, model routing, tool execution
lib/
  json-extract.js          — JSON extraction + Python detection (tested)
ecosystem/
  prompts/
    system.md              — agent system prompt (template)
    init.md                — bootstrap prompt (first-run setup)
  tools/
    setValue/               — each tool: metadata.json + tool.js
    setFileType/
    lockField/ unlockField/
    lockAllInFile/ unlockAllInFile/
    pinField/ unpinField/
    execute_python/
    propose_tool/
      tool.js              — creates new tools in ~/.selva/
      bigrams.js           — jungle-themed ID generator
media/
  state.js                 — state, settings, themes, hooks API
  renderer.js              — field/section rendering, expansion state
  agent.js                 — chat UI, Python cells, model picker
  events.js                — event handling, message routing
  sliders.js               — slider rendering with fieldOverride support
  utils.js                 — markdown/LaTeX rendering, syntax highlighting
vendor/
  js-yaml.min.js           — YAML parser
  marked.min.js            — Markdown renderer
  katex.min.js + fonts/    — LaTeX math renderer
  mermaid.min.js           — diagram renderer
  jsonrepair.js            — malformed JSON repair
webview.html               — dashboard HTML
test/
  json-extract.test.js     — 34 tests for core logic
  fixtures/
    model-outputs.js       — real-world LLM output patterns
```

### Tool Format

Every tool (built-in or agent-created) has the same structure:

**metadata.json:**
```json
{
  "name": "setSliderBounds",
  "id": "OrchidDrift_938f0485",
  "hash": "938f0485...",
  "description": "Set slider min/max for a field",
  "context": "webview",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file": { "type": "string" },
      "path": { "type": "array" },
      "min": { "type": "number" },
      "max": { "type": "number" }
    },
    "required": ["file", "path", "min", "max"]
  },
  "created": "2026-03-15",
  "origin_query": "change slider boundaries for learning rate",
  "reasoning": "No built-in tool for slider bounds",
  "model": "gpt-4.1",
  "tested": false,
  "approved": false,
  "version": 1
}
```

**tool.js (webview context):**
```javascript
(function(input) {
  var key = input.file + ':' + JSON.stringify(normalizePath(input.path));
  state.hooks.fieldOverrides[key] = state.hooks.fieldOverrides[key] || {};
  state.hooks.fieldOverrides[key].min = input.min;
  state.hooks.fieldOverrides[key].max = input.max;
  renderEditors();
  return 'Slider bounds set to [' + input.min + ', ' + input.max + ']';
})
```

**tool.js (extension context):**
```javascript
module.exports = async function(input, context) {
  const { execFileAsync, configDir } = context;
  // ... Node.js code with access to filesystem, child processes, etc.
};
```

### Message Flow

```
User types prompt
  → agent.js: runAgentPrompt()
  → extension.js: receives 'agentPrompt' message
  → Selects model (VS Code LM / Direct API)
  → Builds system prompt from ecosystem/prompts/system.md
  → Loads tools from ecosystem/tools/ + ~/.selva/ecosystem/tools/

  If tool-use supported:
    → Multi-turn tool loop (model calls tools, sees results, continues)
    → Webview ops accumulated, extension ops executed immediately

  If JSON fallback:
    → Model outputs text with JSON
    → extractOpsFromText() parses it (with jsonrepair)
    → Extension ops executed, webview ops forwarded

  → agentResult sent to webview
  → events.js: applies webview ops, renders answer
  → agent.js: displays in chat (markdown + LaTeX + images)
```

---

## Settings

Open settings with the gear icon (top right).

### Theme
Seven built-in themes. The accent color is used throughout — title glow, tab underlines, play button, agent highlights.

### Fonts
Configurable fonts for labels, field names, and values. Font size adjustable via slider.

### API Keys
Add your own Anthropic or OpenAI API key for direct model access without Copilot. Keys are stored locally via VS Code's `globalState`. Direct models appear in the agent's model dropdown.

### Layout
- **Density**: Compact / Comfortable / Spacious
- **Type badges**: Show/hide INT, FLOAT, STR, BOOL badges
- **Section counts**: Show/hide field counts in section headers
- **Auto-expand**: Expand all sections on load
- **Sort keys**: Alphabetical ordering
- **Sliders**: Show/hide numeric sliders

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Y` (Mac) / `Ctrl+Shift+Y` | Open Selva |
| `Enter` | Submit agent prompt |
| `Shift+Enter` (in Python cell) | Run Python code |
| `Cmd+S` / `Ctrl+S` | Save changes to YAML |

---

## The Tarzan & Jane Model

Selva uses a two-tier agent architecture:

**Jane** is the session agent — she runs inside each dashboard, interacts with the user, creates tools, runs analysis. Every Selva session has its own Jane. Multiple Janes can run concurrently across different projects, and they all share the same `~/.selva/ecosystem/`.

**Tarzan** is the codebase agent — he manages the Selva source code, audits Jane-created tools, fixes bugs, and promotes good tools to built-in status. Tarzan is currently a manual role (performed by the developer), but the architecture is designed for future automation.

The flow:
```
Jane creates tool → saved to ~/.selva/ecosystem/tools/
  → Tarzan audits (checks bugs, security, hook compatibility)
  → Tarzan promotes to ecosystem/tools/ (built-in)
  → Ships with next Selva release
```

This creates a feedback loop: users encounter gaps → Jane fills them with tools → Tarzan curates the best ones → Selva gets better over time.

---

## Troubleshooting

### Agent doesn't execute actions
The model might not support tool calling. Try:
1. Switch to a different model in the dropdown
2. Add a direct API key (Settings → API Keys) for native tool support
3. Check that the JSON fallback is working — the agent should output JSON ops

### Plots don't render
- Ensure Python 3 is installed and `python3` is on your PATH
- Ensure matplotlib is installed: `pip install matplotlib`
- Check the Python cell output for error messages

### Tools not loading
- Check `~/.selva/ecosystem/tools/` exists
- Each tool needs both `metadata.json` and `tool.js`
- Run `npm test` to verify tool loading works

### Bootstrap doesn't classify files
The init prompt runs on first load. If classification fails:
- Try a different model (some models handle classification better)
- Manually classify by asking the agent: "classify figure_5a as data"

---

## Running Tests

```bash
npm test
```

Runs 34 tests covering:
- JSON extraction (16 edge cases including malformed JSON, bare ops, fenced blocks)
- Python detection (fenced, unfenced, non-Python)
- Python headless fixes (Agg backend, plt.show removal, base64 output)
- Tool loading (filesystem scanning, schema building)
- Bigram generator (determinism, uniqueness)

---

## Version History

| Version | Highlights |
|---|---|
| 0.1.0 | Initial dashboard: YAML viewer, field editing, sliders |
| 0.1.1 | Agent CLI: natural language config editing |
| 0.1.2 | Three-panel layout, classification, pinning, locking |
| 0.1.3 | Streaming chat, markdown/LaTeX/Mermaid, dynamic model discovery |
| 0.2.0 | Ecosystem architecture, tool-use API, Python execution, self-extending agent, direct API, Jupyter cells, hooks API, propose_tool, bigram IDs, test suite |
