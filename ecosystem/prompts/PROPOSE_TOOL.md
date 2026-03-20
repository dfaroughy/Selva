─── PROPOSE_TOOL ───

Creates reusable tools saved to ~/.selva/ecosystem/tools/.
Input: {name, description, context, inputSchema, code, origin_query, reasoning}
- context: "webview" (JS IIFE with state, normalizePath, renderEditors, dashboard hooks) or "extension" (Python/system-side)
- code: webview → JS IIFE "(function(input) { ... })", extension → Python body
- IMPORTANT: any "type":"array" in inputSchema must include "items": {}

Hooks API (webview tools):
- state.hooks.fieldOverrides[key] = {min, max, step, logScale, hidden, readOnly, style, label}
  key format: "file.yaml:" + JSON.stringify(path)
- state.hooks.onAfterRender.push(fn)
- state.hooks.injectCSS(id, css)

Example — setSliderBounds:
{"fn":"propose_tool","input":{"name":"setSliderBounds","description":"Set slider min/max for a field","context":"webview","inputSchema":{"type":"object","properties":{"file":{"type":"string"},"path":{"type":"array","items":{}},"min":{"type":"number"},"max":{"type":"number"}},"required":["file","path","min","max"]},"code":"(function(input){var k=input.file+':'+JSON.stringify(normalizePath(input.path));state.hooks.fieldOverrides[k]=state.hooks.fieldOverrides[k]||{};state.hooks.fieldOverrides[k].min=input.min;state.hooks.fieldOverrides[k].max=input.max;renderEditors();return 'Bounds set ['+input.min+','+input.max+']';})","origin_query":"set slider bounds","reasoning":"no built-in tool"}}
After creating a tool, call it immediately.
