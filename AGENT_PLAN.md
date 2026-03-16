# Selva — Architecture & Roadmap

## Overview

Selva is a VS Code extension for visual YAML config/data management with an embedded AI agent. The agent can edit configs, analyze data, plot results, and **extend its own capabilities** by creating new tools at runtime.

---

## Architecture: Tarzan & Jane

Two-tier agent system with a quality gate.

### Jane (session agent)
- Runs inside each Selva dashboard session
- User-facing, fast, experimental
- Can: edit YAML, plot data, run Python, create new tools
- Access: `~/.selva/ecosystem/tools/` (read + write)
- Tools created by Jane are immediately available in the current session and all future sessions
- Multiple Janes can run concurrently across different projects

### Tarzan (codebase agent — future)
- Manages the Selva source code repository
- Slow, careful, codebase-aware
- Audits Jane-created tools: checks for bugs, security, compatibility
- Promotes good tools from `~/.selva/` to built-in `ecosystem/tools/`
- Currently: this role is performed manually by the developer via Claude Code
- Future: CLI command (`selva audit`), CI bot, or local watcher

### Flow
```
User ↔ Jane (session agent)
         ↓ creates tools
   ~/.selva/ecosystem/tools/  (staging area)
         ↓ audited by
     Tarzan (codebase agent)
         ↓ promotes to
   ecosystem/tools/  (built-in, shipped with extension)
         ↓ published
     VS Code Marketplace
```

---

## Ecosystem Structure

### Built-in tools (ship with extension)
```
ecosystem/
  prompts/
    system.md           — agent system prompt (template with {{placeholders}})
    init.md             — bootstrap prompt (first-run classification + setup)
  tools/
    setValue/            — each tool has metadata.json + tool.js
    setFileType/
    lockField/
    unlockField/
    lockAllInFile/
    unlockAllInFile/
    pinField/
    unpinField/
    execute_python/     — extension-context (runs Python subprocess)
    propose_tool/       — meta-tool: creates new tools in ~/.selva/
```

### User/agent-created tools
```
~/.selva/
  ecosystem/
    tools.md            — auto-generated index of user tools
    tools/
      setSliderBounds/
        metadata.json   — name, description, schema, provenance
        tool.js         — the executable code
      setSliderLogScale/
        metadata.json
        tool.js
```

### Tool format (universal — same for built-in and agent-created)
```
metadata.json:
  name, description, context ("webview"|"extension"), inputSchema,
  created, origin_query, reasoning, model, tested, version

tool.js:
  webview context  → JS IIFE: (function(input) { ... })
  extension context → Node.js module: module.exports = async function(input, context) { ... }
```

---

## Hooks API

Generic extension points that agent-created tools use to modify dashboard behavior without source changes.

```js
state.hooks = {
  fieldOverrides: {},      // key → {min, max, step, hidden, readOnly, style, label, logScale}
  onBeforeRender: [],      // callback array, fired before renderEditors()
  onAfterRender: [],       // callback array, fired after renderEditors()
  injectCSS(id, css),      // inject/update custom stylesheet by id
  removeCSS(id),           // remove injected stylesheet
};
```

Key format: `"filename.yaml:" + JSON.stringify(["path", "to", "field"])`

The renderer checks `fieldOverrides` automatically for:
- Slider bounds (min/max/step) — in `buildSliderHtml()`
- Log scale (logScale) — renders log10-mode slider
- Visibility (hidden) — hides field
- Read-only (readOnly) — disables input
- Custom styling (style) — inline CSS on field element
- Label override (label) — replaces displayed field name

---

## Agent Capabilities

### Tool use (VS Code LM API)
- Tools defined as `LanguageModelChatTool` schemas, loaded from ecosystem
- Multi-turn tool loop: model calls tool → extension executes → result sent back → model continues
- Works with Copilot-proxied models that support function calling

### JSON fallback (models without tool support)
- Model outputs JSON: `{"answer":"...", "ops":[{"fn":"toolName", "args":[...]}]}`
- `jsonrepair` package fixes malformed JSON (missing commas, quotes, etc.)
- Handles: standard wrapper, bare array, bare single op, fenced code blocks

### Direct API (bypass Copilot)
- User provides API keys in settings (Anthropic, OpenAI)
- Extension calls APIs directly with native tool support
- Models: Claude Sonnet/Opus/Haiku, GPT-4o/4.1, o3-mini

### Python execution
- `execute_python` tool runs code via `python3 -c` subprocess
- Base64 image capture for matplotlib plots
- Auto-detection of unfenced Python code blocks in answers
- Auto-injection of `matplotlib.use('Agg')` and base64 output wrapper
- Editable Jupyter-like cells in the UI (syntax highlighting, Shift+Enter to run)

### Self-extending (propose_tool)
- Agent creates new tools when no existing tool fits
- Writes to `~/.selva/ecosystem/tools/<name>/`
- Tool is immediately registered in current session via eval
- Available in all future sessions (loaded on init)
- System prompt includes hooks API documentation so agent writes compatible code

---

## Known Issues & Future Work

### Tool quality
- Agent-created tools vary in quality depending on the model
- Need: test cases in metadata.json (`"tests": [{"input":{...}, "expected":"..."}]`)
- Need: version compatibility field (`"selva_version": ">=0.2.0"`)

### Tool conflicts
- Two Janes could create same-named tool with different implementations
- Need: namespacing (`project-name/toolName`) or merge strategy
- Currently: last write wins

### Security
- Webview tools run via `eval()` — CSP allows `unsafe-eval`
- Extension tools can execute arbitrary shell commands
- Need: approval flow (`"approved": false` → user/Tarzan must approve)
- Need: sandbox for webview tools (restricted state proxy)
- Need: code signing for built-in vs user tools

### Audit trail
- Need: `tools.lock` file recording hash, creator model, test results
- Tarzan runs `selva audit` to validate all tools against lock

### Tarzan implementation (future)
- CLI: `selva audit` — LLM pass over ~/.selva/tools, check bugs/security
- CI: GitHub Action for tool PRs
- Local: file watcher on ~/.selva/ for real-time validation
- Promotion: `selva promote <tool>` — copies to ecosystem/tools/ with tests

---

## File Map

```
extension.js              — VS Code extension host, tool loader, API handlers, Python execution
webview.html              — Dashboard HTML structure
media/
  state.js                — State object, settings, themes, hooks API
  renderer.js             — Field/section rendering, editor management, expansion state
  agent.js                — Agent UI, chat entries, rich blocks, Python cells, model picker
  events.js               — Event delegation, message handlers, settings listeners
  sliders.js              — Slider rendering, log/linear/pow2 modes, fieldOverrides
  utils.js                — Helpers: escapeHtml, normalizePath, renderMarkdownLatex, highlightPython
ecosystem/
  prompts/system.md       — Agent system prompt template
  prompts/init.md         — Bootstrap/init prompt
  tools/*/                — Built-in tools (metadata.json + tool.js each)
vendor/
  js-yaml.min.js          — YAML parser
  marked.min.js           — Markdown renderer
  katex.min.js + fonts/   — LaTeX renderer
  mermaid.min.js          — Diagram renderer
  jsonrepair.js           — JSON repair for malformed LLM output
```

---

## Version History

- **0.1.0** — Initial dashboard: YAML viewer, field editing, sliders
- **0.1.1** — Agent CLI: natural language config editing via Copilot
- **0.1.2** — Three-panel layout, file classification, pinning, locking
- **0.1.3** — Streaming chat, markdown/LaTeX/Mermaid rendering, dynamic model discovery
- **0.2.0** (current) — Ecosystem architecture, tool-use API, Python execution, self-extending agent, direct API support, Jupyter-like code cells, hooks API

---

## Project

- **Name**: Selva
- **Publisher**: dfaroughy
- **Repo**: github.com/dfaroughy/selva
- **Target users**: ML practitioners, physicists, data scientists working with YAML configs and experimental data
