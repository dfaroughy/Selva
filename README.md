# SELVA

An agentic YAML workbench for VS Code — visual config editing, AI agent with Python execution, and a self-extending tool ecosystem.

Built for ML practitioners and scientists who work with experiment configs and data files.

![Selva](https://raw.githubusercontent.com/dfaroughy/selva/main/Screenshot.png)

---

## What It Does

**Visual Dashboard** — Opens any folder of YAML files as an interactive form with sliders, toggles, type badges, pinning, locking, search, and 7 themes.

**AI Agent** — An embedded agent (Jane) that understands your configs and can edit values, classify files, plot data, run Python analysis, and answer questions — all through natural language.

**Self-Extending** — When the agent encounters a task no existing tool can handle, it creates a new tool on the fly, saves it to `~/.selva/ecosystem/tools/`, and uses it immediately. The tool persists across sessions and projects.

**Python Execution** — Jupyter-like code cells with syntax highlighting, `Shift+Enter` to run, and inline matplotlib plots.

---

## Quick Start

| Method | How |
|---|---|
| Command Palette | `Ctrl+Shift+P` → **Selva** |
| Keyboard shortcut | `Cmd+Shift+J` (Mac) / `Ctrl+Shift+J` |
| Explorer | Right-click any folder → **Selva** |

### Model Setup

Selva works with any VS Code language model extension (GitHub Copilot, etc.). For best results, add your own API key:

1. Open Settings (gear icon)
2. Add your **Anthropic** or **OpenAI** API key
3. Select a `direct:` model from the dropdown

Direct API gives you native tool calling — no JSON fallback needed.

---

## Features

### Agent Capabilities
- Natural language config editing ("reduce learning rate by half")
- File classification (config vs data) with auto-locking
- Data plotting via matplotlib (inline, editable, re-runnable)
- Field pinning, locking, unlocking via conversation
- Conversation memory within each session
- Self-extending: creates new dashboard tools at runtime

### Visual Editor
- Multi-file tabs with modification indicators
- Collapsible sections with preserved expansion state
- Numeric sliders (linear, log, log2, custom bounds)
- Type-aware controls (text, toggles, lists, objects)
- Search/filter across all keys and values
- Export as JSON
- 7 themes: Midnight, Slate, Nord, Forest, Light, Desert, Sunset

### Ecosystem
- Universal tool format (built-in = agent-created)
- Tools stored in `~/.selva/ecosystem/tools/`
- Hooks API for extending dashboard behavior
- Jungle-themed bigram IDs for audit trail
- `tools.lock` for tracking provenance

---

## Architecture

```
You ↔ Jane (session agent)
        ↓ creates tools
  ~/.selva/ecosystem/tools/
        ↓ audited by
    Tarzan (codebase agent — future)
        ↓ promotes to
  ecosystem/tools/ (built-in)
```

See [DOCS.md](DOCS.md) for full documentation and [AGENT_PLAN.md](AGENT_PLAN.md) for the technical roadmap.

---

## Requirements

- VS Code **1.95.0+**
- YAML files (`.yaml` or `.yml`)
- Python 3 + matplotlib (for plotting features)
- A language model: [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) or your own API key (Anthropic / OpenAI)

## Testing

```bash
npm test   # 34 tests covering JSON extraction, Python detection, tool loading, bigrams
```

## License

MIT
