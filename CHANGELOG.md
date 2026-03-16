# Changelog

## [0.2.0] — 2026-03-15

### Renamed
- Project renamed from **YAML Config Dashboard** to **Selva**
- Package name: `yaml-config-dashboard` → `selva`
- Command: `configDashboard.open` → `selva.open`
- Keyboard shortcut: `Cmd+Shift+Y` → `Cmd+Shift+J`

### Added
- **Ecosystem architecture**: all tools (built-in + agent-created) use the same format — `metadata.json` + `tool.js` per tool folder
- **Self-extending agent**: `propose_tool` lets the agent create new dashboard tools at runtime, saved to `~/.selva/ecosystem/tools/`
- **Hooks API**: `state.hooks.fieldOverrides`, `onBeforeRender`, `onAfterRender`, `injectCSS` — agent-created tools extend the dashboard without source changes
- **VS Code tool-use API**: multi-turn tool loop via `LanguageModelChatTool` for models that support function calling
- **Direct API support**: add your own Anthropic or OpenAI API key in Settings for native tool calling without Copilot
- **Python execution**: `execute_python` tool runs matplotlib/numpy code with inline base64 plot rendering
- **Jupyter-like code cells**: Python blocks are editable, syntax-highlighted (GitHub-dark), runnable via Shift+Enter
- **Auto-execute Python**: detects matplotlib code in agent answers (fenced or unfenced) and runs it automatically
- **JSON fallback with `jsonrepair`**: robust extraction of ops from malformed model output (missing commas, single quotes, bare ops, fenced blocks)
- **Conversation memory**: sliding-window session history, agent can reference prior answers
- **Markdown + LaTeX rendering**: agent answers rendered with `marked.js` + `KaTeX`
- **Mermaid diagrams**: structural diagrams (flowcharts, sequences) rendered inline
- **Jungle-themed bigram IDs**: tools get deterministic IDs like `OrchidDrift_938f0485`
- **`tools.lock`**: audit trail tracking tool provenance (hash, creator model, timestamps)
- **Abort button**: play button becomes a stop square with breathing glow while agent is thinking; click to cancel
- **Collapsible Q&A**: each agent answer is collapsible; previous answers auto-collapse when new one arrives
- **Neon title glow**: Selva title uses accent-colored text-shadow
- **Python syntax highlighting**: GitHub-dark color scheme for code cells
- **Test suite**: 34 tests covering JSON extraction, Python detection, tool loading, bigrams
- **`lib/json-extract.js`**: extracted and tested core logic (JSON parsing, Python detection, headless fixes)

### Changed
- **System prompt rewritten**: imperative, agent-optimized — 40% shorter, works better across models
- **Prompts moved**: `system-prompt.txt` → `ecosystem/prompts/system.md`, `bootstrap.md` → `ecosystem/prompts/init.md`
- **Tools externalized**: hardcoded `DASHBOARD_TOOLS` array replaced with dynamic loader scanning `ecosystem/tools/`
- **Panels start collapsed**: pinned, config, and data panels start collapsed; click a tab to expand + select
- **Chronological chat**: answers append bottom-to-top (newest at bottom, scroll to see)
- **No answer limit**: removed 5-answer cap and opacity gradient; all answers persist until dismissed
- **Tab underline**: confined to text width, half thickness
- **Lock fix for arrays**: `lockAllFieldsInFile` now recurses into arrays; `isFieldLocked` checks parent paths
- **Slider overrides**: `buildSliderHtml` checks `state.hooks.fieldOverrides` for custom bounds and log scale

### Removed
- Spinner element (replaced by stop-button animation)
- Chat resize handle
- Old `toolkit.md` project-local tool storage (replaced by `~/.selva/ecosystem/`)

---

## [0.1.3] — 2026-03-14

### Added
- **Streaming chat UI**: agent answers now type out letter-by-letter with a blinking cursor, displayed in a chat log with newest answers on top.
- **Chat history**: up to 5 previous agent Q&A entries shown with an opacity gradient (newest = full opacity, oldest fades out). Each entry has a dismiss button.
- **Auto-classification**: YAML files are automatically classified as "config" or "data" using the LM on startup; data files are locked by default.
- **Three-panel layout**: separate collapsible panels for Pinned, Configs, and Data files.
- **Dynamic model discovery**: supports any VS Code LM extension (GitHub Copilot, OpenAI Codex, etc.) via `vscode.lm.selectChatModels`. Model picker dropdown with vendor/family labels.
- **Auto-scaling context budget**: YAML data sent to the agent scales proportionally based on the selected model's `maxInputTokens`.
- **Additive system prompt**: built-in system prompt is hidden; user additions via the "Additional Instructions" panel are appended on top.
- **Lock/unlock fields**: per-field lock buttons; data files auto-locked on load. Agent can lock/unlock via ops.
- **Pin/unpin via agent**: agent can pin and unpin fields using `pinField`/`unpinField` ops.
- **Search bar icon**: magnifying glass icon in the search input.
- **Section expansion preservation**: expanding/collapsing sections is preserved across re-renders (e.g. after lock/agent ops).

### Fixed
- **Init race condition**: config panel no longer shows empty on startup when classification completes before config data loads.
- **Lock button in deep hierarchies**: clicking lock on nested fields no longer collapses the section.
- **Agent locking array fields**: paths with numeric indices (e.g. `values[0].low`) now correctly match between agent ops and the internal field map.
- **Broken hyperlinks**: URLs with `&` in agent answers no longer break due to double-escaping.
- **Chat opacity**: first answer now shows at full opacity instead of 1/5.

### Changed
- **Codebase refactored**: monolithic `webview.js` (2,343 lines) split into 6 focused modules: `utils.js`, `state.js`, `sliders.js`, `renderer.js`, `agent.js`, `events.js`.
- **extension.js cleanup**: extracted `sendModelList()` helper, eliminating duplicated model-listing code.
- Prompt bar restyled: wider play button, system prompt and model selector as icon buttons.
- Section names and array item labels rendered in lowercase.
- Type badge font weight changed from bold to regular.
- Removed resize handle between pinned panel and chat log.

---

## [0.1.2] — 2026-03-13

### Added
- **Agentic CLI bar**: natural-language prompt bar powered by GitHub Copilot (VS Code LM API). Type an instruction like "reduce *value* by a factor of 3" and the agent patches all matching fields across every loaded config file in-memory. Changes appear immediately as orange diff highlights; save or reset as usual.
- **Multi-file agent scope**: the agent pre-loads all YAML files in the folder before sending the request, so it can reason across and patch multiple files in a single prompt.
- **Agent response strip**: Copilot's one-sentence summary of what it changed is shown below the prompt bar after each run, along with a per-field diff list (old → new values).
- **Repo context in agent prompt**: the agent reads `README.md` from the config folder (or its parent) and includes it as context so Copilot understands the project.
- **Raw YAML context**: the full raw YAML of each config file is sent to Copilot alongside the flat field schema, improving accuracy on deeply nested hierarchical configs.
- **Inline pin buttons**: hovering over any field now reveals a minimalist pin icon and "pin"/"unpin" label on the right side of the row — replacing the previous right-click context menu.


### Changed
- Removed right-click context menu in favour of hover-reveal inline pin buttons.

---

## [0.1.1] — 2026-03-11

### Added
- Initial release
- Visual YAML editor with tabbed multi-file support
- Collapsible sections for nested configuration objects
- Type-aware controls: text inputs, boolean toggles, null badges, scalar lists, object arrays
- Per-field reset and full-file reset
- Real-time modification indicators on fields and tabs
- Search/filter across all parameter keys and values
- 5 built-in themes: Midnight, Slate, Nord, Forest, Light
- Customizable fonts, font size, label color, and accent color
- Layout density control: Compact / Comfortable / Spacious
- Export active config as CLI arguments, flat JSON, or environment variables
- Settings panel with all preferences persisted between sessions
- Keyboard shortcut `Ctrl/Cmd+S` to save the active file
- Right-click a folder in Explorer to open it directly in Selva
