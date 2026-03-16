const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yaml = require('./vendor/js-yaml.min.js');
const { extractOpsFromText, detectUnfencedPython, fixPythonForHeadless } = require('./lib/json-extract');

const execFileAsync = promisify(execFile);

const panels = new Map(); // configDir -> WebviewPanel
const activeTokenSources = new Map(); // configDir -> CancellationTokenSource

const os = require('os');

// ── Unified tool loader ────────────────────────────────────
// Loads tools from a directory of tool folders (each with metadata.json + tool.js)
function loadToolsFromDir(dir) {
  const tools = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const metaPath = path.join(dir, entry.name, 'metadata.json');
        const codePath = path.join(dir, entry.name, 'tool.js');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const code = fs.readFileSync(codePath, 'utf8');
        tools.push({
          name: meta.name,
          description: meta.description,
          inputSchema: meta.inputSchema || {},
          context: meta.context || 'webview',  // 'webview' or 'extension'
          code,
          source: dir,
        });
      } catch { /* skip invalid tool folders */ }
    }
  } catch { /* directory doesn't exist yet */ }
  return tools;
}

// Load all tools from both built-in and user ecosystem
function loadAllTools(extensionPath) {
  const builtinDir = path.join(extensionPath, 'ecosystem', 'tools');
  const userDir = path.join(os.homedir(), '.selva', 'ecosystem', 'tools');
  const builtin = loadToolsFromDir(builtinDir);
  const user = loadToolsFromDir(userDir);
  // User tools override built-in tools with same name
  const byName = new Map();
  for (const t of builtin) byName.set(t.name, t);
  for (const t of user) byName.set(t.name, t);
  return [...byName.values()];
}

// Build LM API tool schemas from loaded tools
function buildToolSchemas(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// Execute an extension-context tool by require'ing its tool.js
function loadExtensionTool(tool) {
  // tool.js is a CommonJS module that exports an async function
  const modPath = path.join(tool.source, tool.name, 'tool.js');
  // Clear require cache to pick up changes
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// ── API key storage (in-memory per session) ────────────────
const apiKeys = { anthropic: '', openai: '' };

// Direct API model definitions
const DIRECT_MODELS = {
  anthropic: [
    { id: 'direct:claude-sonnet-4-20250514', vendor: 'anthropic', family: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    { id: 'direct:claude-opus-4-20250514', vendor: 'anthropic', family: 'claude-opus-4', name: 'Claude Opus 4' },
    { id: 'direct:claude-haiku-4-5-20251001', vendor: 'anthropic', family: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'direct:gpt-4o', vendor: 'openai', family: 'gpt-4o', name: 'GPT-4o' },
    { id: 'direct:gpt-4o-mini', vendor: 'openai', family: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'direct:o3-mini', vendor: 'openai', family: 'o3-mini', name: 'o3-mini' },
  ],
};

async function sendModelList(panel) {
  const modelList = [];
  // VS Code LM models
  if (vscode.lm) {
    try {
      const allModels = await vscode.lm.selectChatModels({});
      for (const m of (allModels || [])) {
        modelList.push({ id: m.id, vendor: m.vendor, family: m.family, name: m.name || m.family });
      }
    } catch { /* ignore */ }
  }
  // Direct API models (only if key is set)
  if (apiKeys.anthropic) {
    for (const m of DIRECT_MODELS.anthropic) modelList.push(m);
  }
  if (apiKeys.openai) {
    for (const m of DIRECT_MODELS.openai) modelList.push(m);
  }
  panel.webview.postMessage({ type: 'availableModels', models: modelList });
}

// ── Direct API calls ───────────────────────────────────────
async function callAnthropicAPI(apiKey, modelId, systemPrompt, messages, tools, cancellationToken) {
  const https = require('https');
  const anthropicModel = modelId.replace('direct:', '');

  // Convert messages to Anthropic format
  const anthropicMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // Convert tool schemas to Anthropic format
  const anthropicTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const body = {
    model: anthropicModel,
    max_tokens: 4096,
    system: systemPrompt,
    messages: anthropicMessages,
  };
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  return new Promise((resolve, reject) => {
    if (cancellationToken && cancellationToken.isCancellationRequested) {
      reject(new Error('cancelled'));
      return;
    }

    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    if (cancellationToken) {
      cancellationToken.onCancellationRequested(() => { req.destroy(); reject(new Error('cancelled')); });
    }
    req.write(postData);
    req.end();
  });
}

async function callOpenAIAPI(apiKey, modelId, systemPrompt, messages, tools, cancellationToken) {
  const https = require('https');
  const openaiModel = modelId.replace('direct:', '');

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const body = { model: openaiModel, messages: openaiMessages };
  if (openaiTools.length > 0) body.tools = openaiTools;

  return new Promise((resolve, reject) => {
    if (cancellationToken && cancellationToken.isCancellationRequested) {
      reject(new Error('cancelled'));
      return;
    }

    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    if (cancellationToken) {
      cancellationToken.onCancellationRequested(() => { req.destroy(); reject(new Error('cancelled')); });
    }
    req.write(postData);
    req.end();
  });
}

// Run a full tool-use loop via direct API (Anthropic or OpenAI)
async function runDirectAPILoop(modelId, systemPrompt, messages, toolSchemas, allToolsByName, accumulatedOps, capturedImages, executedCells, configDir, panel, cancellationToken, schemata) {
  const isAnthropic = modelId.startsWith('direct:claude');
  const apiKey = isAnthropic ? apiKeys.anthropic : apiKeys.openai;
  if (!apiKey) throw new Error(`No API key set for ${isAnthropic ? 'Anthropic' : 'OpenAI'}`);

  const MAX_TURNS = 10;
  let finalAnswer = '';
  let usedTools = false;
  let totalTokens = { input: 0, output: 0 };

  // Working message history for the API
  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    if (isAnthropic) {
      response = await callAnthropicAPI(apiKey, modelId, systemPrompt, apiMessages, toolSchemas, cancellationToken);
      if (response.usage) {
        totalTokens.input += response.usage.input_tokens || 0;
        totalTokens.output += response.usage.output_tokens || 0;
      }
      let turnText = '';
      const toolCalls = [];
      for (const block of (response.content || [])) {
        if (block.type === 'text') turnText += block.text;
        if (block.type === 'tool_use') toolCalls.push(block);
      }

      if (toolCalls.length === 0) {
        finalAnswer += turnText;
        break;
      }
      if (!usedTools && turnText) { /* skip preamble */ }
      else if (turnText) finalAnswer += turnText;
      usedTools = true;

      // Add assistant response to history
      apiMessages.push({ role: 'assistant', content: response.content });

      // Execute tools and add results
      const toolResults = [];
      for (const tc of toolCalls) {
        const result = await executeDirectToolCall(tc.name, tc.input, allToolsByName, accumulatedOps, capturedImages, executedCells, configDir, panel, schemata);
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
      }
      apiMessages.push({ role: 'user', content: toolResults });

    } else {
      // OpenAI
      response = await callOpenAIAPI(apiKey, modelId, systemPrompt, apiMessages, toolSchemas, cancellationToken);
      if (response.usage) {
        totalTokens.input += response.usage.prompt_tokens || 0;
        totalTokens.output += response.usage.completion_tokens || 0;
      }
      const choice = response.choices && response.choices[0];
      if (!choice) break;
      const msg = choice.message;
      const turnText = msg.content || '';
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length === 0) {
        finalAnswer += turnText;
        break;
      }
      if (!usedTools && turnText) { /* skip preamble */ }
      else if (turnText) finalAnswer += turnText;
      usedTools = true;

      // Add assistant message
      apiMessages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      // Execute tools
      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        const result = await executeDirectToolCall(tc.function.name, args, allToolsByName, accumulatedOps, capturedImages, executedCells, configDir, panel, schemata);
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  }
  return { answer: finalAnswer, usage: totalTokens };
}

async function executeDirectToolCall(name, input, toolsByName, accumulatedOps, capturedImages, executedCells, configDir, panel, schemata) {
  const tool = toolsByName.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    if (tool.context === 'extension') {
      const handler = loadExtensionTool(tool);
      let result = await handler(input, { execFileAsync, configDir, panel, schemata });
      if (name === 'execute_python' && input.code) {
        executedCells.push({ code: input.code, output: typeof result === 'string' ? result : '' });
      }
      if (typeof result === 'string') {
        result = result.replace(/IMG:([A-Za-z0-9+/=\s]{20,})/g, (_, b64) => {
          capturedImages.push(b64.replace(/\s/g, ''));
          return '[plot generated]';
        });
      }
      return result;
    } else {
      accumulatedOps.push({ fn: name, input });
      return `Done: ${name}(${JSON.stringify(input).slice(0, 200)})`;
    }
  } catch (e) {
    return `Error in ${name}: ${e.message}`;
  }
}

function activate(context) {
  // Ensure ~/.selva/ecosystem/tools/ exists
  const jungleToolsDir = path.join(os.homedir(), '.selva', 'ecosystem', 'tools');
  fs.mkdirSync(jungleToolsDir, { recursive: true });

  // Restore persisted API keys from secure storage
  (async () => {
    try {
      apiKeys.anthropic = await context.secrets.get('apiKey:anthropic') || '';
      apiKeys.openai = await context.secrets.get('apiKey:openai') || '';
    } catch { /* secrets API not available */ }
    // Migrate from old globalState (insecure) to secrets if needed
    const oldAnth = context.globalState.get('apiKey:anthropic', '');
    const oldOai = context.globalState.get('apiKey:openai', '');
    if (oldAnth && !apiKeys.anthropic) {
      apiKeys.anthropic = oldAnth;
      context.secrets.store('apiKey:anthropic', oldAnth);
      context.globalState.update('apiKey:anthropic', undefined); // delete insecure copy
    }
    if (oldOai && !apiKeys.openai) {
      apiKeys.openai = oldOai;
      context.secrets.store('apiKey:openai', oldOai);
      context.globalState.update('apiKey:openai', undefined);
    }
  })();

  const cmd = vscode.commands.registerCommand('selva.open', async (uri) => {
    try {
      // ── Folder picker ──────────────────────────────────────
      let configDir;
      if (uri && uri.fsPath) {
        // Invoked from Explorer context menu on a folder
        configDir = uri.fsPath;
      } else {
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const folders = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Config Folder',
          defaultUri,
        });
        if (!folders || folders.length === 0) return;
        configDir = folders[0].fsPath;
      }

      // ── Reveal existing panel for this folder ──────────────
      if (panels.has(configDir)) {
        panels.get(configDir).reveal(vscode.ViewColumn.One);
        return;
      }

      // ── Check folder contains YAML files ───────────────────
      const hasYaml = (function scanDir(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isFile() && /\.ya?ml$/.test(entry.name)) return true;
          if (entry.isDirectory() && scanDir(path.join(dir, entry.name))) return true;
        }
        return false;
      })(configDir);

      if (!hasYaml) {
        vscode.window.showInformationMessage('Selva: No YAML files found in this folder.');
        return;
      }

      // ── Resource URIs ──────────────────────────────────────
      const nonce = crypto.randomBytes(16).toString('hex');
      const folderName = path.basename(configDir).replace(/ /g, '_');

      const panel = vscode.window.createWebviewPanel(
        'configDashboard',
        folderName,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'vendor'),
          ],
        }
      );

      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo_2D.png');
      panels.set(configDir, panel);
      panel.onDidDispose(() => { panels.delete(configDir); }, null, context.subscriptions);

      const mediaUri = (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file));
      const vendorUri = (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'vendor', file));
      const cssUri      = mediaUri('webview.css');
      const katexCssUri = vendorUri('katex.min.css');
      const yamlUri     = vendorUri('js-yaml.min.js');
      const mermaidUri  = vendorUri('mermaid.min.js');
      const markedUri   = vendorUri('marked.min.js');
      const katexUri    = vendorUri('katex.min.js');
      const utilsUri    = mediaUri('utils.js');
      const stateUri   = mediaUri('state.js');
      const slidersUri = mediaUri('sliders.js');
      const rendererUri = mediaUri('renderer.js');
      const agentUri   = mediaUri('agent.js');
      const eventsUri  = mediaUri('events.js');
      const cspSource  = panel.webview.cspSource;

      const htmlPath = path.join(context.extensionPath, 'webview.html');
      let html = fs.readFileSync(htmlPath, 'utf8');
      html = html
        .replace(/\{\{NONCE\}\}/g, nonce)
        .replace(/\{\{CSP_SOURCE\}\}/g, cspSource)
        .replace('{{CSS_URI}}',       cssUri.toString())
        .replace('{{KATEX_CSS_URI}}', katexCssUri.toString())
        .replace('{{YAML_URI}}',     yamlUri.toString())
        .replace('{{MERMAID_URI}}',  mermaidUri.toString())
        .replace('{{MARKED_URI}}',   markedUri.toString())
        .replace('{{KATEX_URI}}',    katexUri.toString())
        .replace('{{UTILS_URI}}',    utilsUri.toString())
        .replace('{{STATE_URI}}',    stateUri.toString())
        .replace('{{SLIDERS_URI}}',  slidersUri.toString())
        .replace('{{RENDERER_URI}}', rendererUri.toString())
        .replace('{{AGENT_URI}}',    agentUri.toString())
        .replace('{{EVENTS_URI}}',   eventsUri.toString());
      panel.webview.html = html;

      // ── Recursive YAML file discovery ──────────────────────
      function findYamlFiles(dir, base) {
        let results = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return results; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          const relPath  = path.relative(base, fullPath);
          if (entry.isDirectory()) {
            results.push(...findYamlFiles(fullPath, base));
          } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
            results.push(relPath);
          }
        }
        return results.sort();
      }

      // ── Message handler ────────────────────────────────────
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'init': {
            const files = findYamlFiles(configDir, configDir);
            const userDefaultSettings = context.globalState.get('userDefaultSettings', null);
            const pinnedKey = 'pinnedFields:' + configDir;
            const pinnedFields = context.workspaceState.get(pinnedKey, {});
            const defaultPromptTemplate = fs.readFileSync(
              path.join(context.extensionPath, 'ecosystem', 'prompts', 'system.md'), 'utf8'
            );
            // Mask keys for display (show last 4 chars only)
            const maskedKeys = {
              anthropic: apiKeys.anthropic ? '••••' + apiKeys.anthropic.slice(-4) : '',
              openai: apiKeys.openai ? '••••' + apiKeys.openai.slice(-4) : '',
            };
            const additionalInstructions = context.globalState.get('additionalInstructions', '');
            panel.webview.postMessage({ type: 'init', files, configDir, userDefaultSettings, pinnedFields, defaultPromptTemplate, apiKeys: maskedKeys, additionalInstructions });
            sendModelList(panel);
            // Send webview-context tools for registration
            const initTools = loadAllTools(context.extensionPath);
            const webviewTools = initTools
              .filter(t => t.context === 'webview')
              .map(t => ({ name: t.name, code: t.code }));
            panel.webview.postMessage({ type: 'registerTools', tools: webviewTools });
            break;
          }
          case 'listModels': {
            sendModelList(panel);
            break;
          }
          case 'saveUserDefaults': {
            context.globalState.update('userDefaultSettings', msg.settings);
            break;
          }
          case 'savePinned': {
            const pinnedKey = 'pinnedFields:' + configDir;
            context.workspaceState.update(pinnedKey, msg.pinned);
            break;
          }
          case 'readConfig': {
            try {
              const filePath = path.resolve(configDir, msg.filename);
              const safeBase = path.resolve(configDir) + path.sep;
              if (!filePath.startsWith(safeBase)) {
                panel.webview.postMessage({ type: 'configData', error: 'Invalid path' });
                return;
              }
              const raw    = fs.readFileSync(filePath, 'utf8');
              const docs   = yaml.loadAll(raw);
              const docKey = docs.length === 1 ? null : msg.filename.replace(/\.ya?ml$/i, '');
              const parsed = docKey ? { [docKey]: docs } : docs[0];
              panel.webview.postMessage({ type: 'configData', filename: msg.filename, raw, parsed });
            } catch (e) {
              panel.webview.postMessage({ type: 'configData', error: e.message });
            }
            break;
          }
          case 'writeConfig': {
            try {
              const filePath = path.resolve(configDir, msg.filename);
              const safeBase = path.resolve(configDir) + path.sep;
              if (!filePath.startsWith(safeBase)) {
                panel.webview.postMessage({ type: 'writeResult', error: 'Invalid path' });
                return;
              }
              let output;
              const docKey = msg.filename.replace(/\.ya?ml$/i, '');
              if (msg.data && Array.isArray(msg.data[docKey])) {
                output = msg.data[docKey].map(d => yaml.dump(d, { flowLevel: -1, sortKeys: false })).join('---\n');
              } else {
                output = yaml.dump(msg.data, { flowLevel: -1, sortKeys: false });
              }
              fs.writeFileSync(filePath, output, 'utf8');
              panel.webview.postMessage({ type: 'writeResult', success: true, filename: msg.filename });
            } catch (e) {
              panel.webview.postMessage({ type: 'writeResult', error: e.message });
            }
            break;
          }
          case 'bootstrap':
          case 'agentPrompt': {
            const isBootstrap = msg.type === 'bootstrap';
            const resultType = isBootstrap ? 'bootstrapResult' : 'agentResult';
            (async () => {
              try {
                // ── Select model ──────────────────────────────
                const modelId = msg.modelId;
                const isDirectAPI = modelId && modelId.startsWith('direct:');
                let model = null;

                if (!isDirectAPI) {
                  if (!vscode.lm) {
                    panel.webview.postMessage({ type: resultType, ops: [], answer: isBootstrap ? null : undefined, error: isBootstrap ? undefined : 'Language Model API not available.' });
                    return;
                  }
                  let allModels = await vscode.lm.selectChatModels({});
                  model = modelId ? (allModels || []).find(m => m.id === modelId) : null;
                  if (!model) {
                    const byFamily = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
                    model = byFamily && byFamily[0];
                  }
                  if (!model && allModels && allModels.length > 0) model = allModels[0];
                  if (!model) {
                    panel.webview.postMessage({ type: resultType, ops: [], answer: null, error: isBootstrap ? undefined : 'No language model available.' });
                    return;
                  }
                }

                // ── Context budget ────────────────────────────
                const maxTokens = isDirectAPI ? 128000 : (model.maxInputTokens || 4000);
                const usableTokens = Math.floor(maxTokens * 0.75);
                const charBudget = usableTokens * 4;
                const readmeBudget = Math.floor(charBudget * 0.10);
                const fieldCharBudget = Math.floor(charBudget * 0.80);

                // ── Repo context ──────────────────────────────
                let repoContext = '';
                for (const dir of [configDir, path.dirname(configDir)]) {
                  for (const fname of ['README.md', 'readme.md', 'README.txt', 'readme.txt']) {
                    try { repoContext = fs.readFileSync(path.join(dir, fname), 'utf8').slice(0, readmeBudget); break; }
                    catch { /* not found */ }
                  }
                  if (repoContext) break;
                }

                // ── Build schema block ────────────────────────
                const schemata = msg.schemata || [];
                let schemaBlock;

                if (isBootstrap) {
                  // Full schema for bootstrap — agent needs to see everything to classify
                  const totalFieldBudget = Math.max(50, Math.floor(fieldCharBudget / 80));
                  const totalFields = schemata.reduce((s, f) => s + f.fields.length, 0);

                  schemaBlock = schemata.map(({ file, fields }) => {
                    const budget = Math.max(10, Math.round((fields.length / Math.max(totalFields, 1)) * totalFieldBudget));
                    const truncated = fields.length > budget;
                    const lines = fields.slice(0, budget).map(({ path, value, type }) =>
                      `    ${JSON.stringify(path)}  =  ${JSON.stringify(value)}  (${type})`
                    ).join('\n');
                    const truncNote = truncated ? `\n    ... (${fields.length - budget} more fields, ${fields.length} total)` : '';
                    return `  [${file}]\n  FIELDS (${fields.length} total):\n${lines}${truncNote}`;
                  }).join('\n\n');
                } else {
                  // Lightweight file list for queries — agent already knows the files from init
                  const ds = msg.dashboardState || {};
                  schemaBlock = schemata.map(({ file, fields }) => {
                    const type = (ds.fileTypes || {})[file] || 'unknown';
                    return `  [${file}] (${type}, ${fields.length} fields)`;
                  }).join('\n') + '\n  Use get_file_schema(file) to inspect a file\'s fields and values.';
                }

                // ── Dashboard state ───────────────────────────
                let stateBlock;
                if (isBootstrap) {
                  stateBlock = 'CURRENT DASHBOARD STATE:\n  (bootstrap — fresh session, no classifications yet)';
                } else {
                  const ds = msg.dashboardState || {};
                  const pinnedEntries = [];
                  for (const [file, paths] of Object.entries(ds.pinnedFields || {})) {
                    for (const p of (paths || [])) pinnedEntries.push(`  - ${file} → ${(p || []).join('.')}`);
                  }
                  const pinnedBlock = pinnedEntries.length ? `Pinned fields (${pinnedEntries.length}):\n${pinnedEntries.join('\n')}` : 'Pinned fields: none';
                  const lockedList = (ds.lockedFields || []).slice(0, 50);
                  const lockedBlock = lockedList.length ? `Locked fields (${lockedList.length}): ${lockedList.map(k => k.replace(':', ' → ')).join(', ')}` : 'Locked fields: none';
                  stateBlock = `CURRENT DASHBOARD STATE:\n  File classifications: ${JSON.stringify(ds.fileTypes || {})}\n  Active config tab: ${ds.activeConfigFile || '(none)'}\n  Active data tab: ${ds.activeDataFile || '(none)'}\n  ${pinnedBlock}\n  ${lockedBlock}`;
                }

                // ── Load ecosystem tools ──────────────────────
                const allTools = loadAllTools(context.extensionPath);
                const toolSchemas = buildToolSchemas(allTools);
                const toolsByName = new Map(allTools.map(t => [t.name, t]));

                // User-created tools summary for system prompt
                const userTools = allTools.filter(t => t.source.includes('.selva'));
                const toolkitBlock = userTools.length
                  ? `\nECOSYSTEM TOOLS (user-created):\n${userTools.map(t => `  - ${t.name}: ${t.description}`).join('\n')}`
                  : '';

                // ── System prompt ─────────────────────────────
                const template = fs.readFileSync(path.join(context.extensionPath, 'ecosystem', 'prompts', 'system.md'), 'utf8');
                const contextSection = repoContext ? `REPO CONTEXT (from README):\n${repoContext}` : '';
                let systemPrompt = template
                  .replace('{{REPO_CONTEXT}}', contextSection)
                  .replace('{{SCHEMA_BLOCK}}', schemaBlock)
                  .replace('{{DASHBOARD_STATE}}', stateBlock)
                  + toolkitBlock;
                if (!isBootstrap && msg.additionalPrompt) {
                  systemPrompt += '\n\nADDITIONAL USER INSTRUCTIONS:\n' + msg.additionalPrompt;
                }

                // ── Build messages (for vscode.lm path only) ──
                const messages = [];
                if (!isDirectAPI && vscode.lm) {
                  messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
                  if (isBootstrap) {
                    const bootstrapPrompt = fs.readFileSync(path.join(context.extensionPath, 'ecosystem', 'prompts', 'init.md'), 'utf8');
                    messages.push(vscode.LanguageModelChatMessage.User(bootstrapPrompt));
                  } else {
                    const history = msg.conversationHistory || [];
                    const historyBudget = Math.floor(charBudget * 0.30);
                    let historyChars = 0, startIdx = history.length;
                    for (let i = history.length - 1; i >= 0; i--) {
                      const turnChars = (history[i].content || '').length;
                      if (historyChars + turnChars > historyBudget) break;
                      historyChars += turnChars;
                      startIdx = i;
                    }
                    if (startIdx % 2 !== 0 && startIdx > 0) startIdx++;
                    for (const turn of history.slice(startIdx)) {
                      messages.push(turn.role === 'user'
                        ? vscode.LanguageModelChatMessage.User(turn.content)
                        : vscode.LanguageModelChatMessage.Assistant(turn.content));
                    }
                    messages.push(vscode.LanguageModelChatMessage.User(msg.prompt));
                  }
                }

                // ── Tool-use loop ─────────────────────────────
                const tokenSource = new vscode.CancellationTokenSource();
                activeTokenSources.set(configDir, tokenSource);
                const accumulatedOps = [];
                const capturedImages = []; // base64 images from execute_python
                const executedCells = []; // {code, output} pairs from execute_python
                const MAX_TOOL_TURNS = 10;
                let finalAnswer = '';

                // Check if tool-use API is available (VS Code 1.95+)
                const hasToolSupport = !!(vscode.LanguageModelToolCallPart && vscode.LanguageModelToolResultPart);

                // Helper: execute a single tool call via the unified ecosystem
                const executeToolCall = async (call) => {
                  const input = call.input || {};
                  const tool = toolsByName.get(call.name);
                  if (!tool) return `Unknown tool: ${call.name}`;

                  try {
                    if (tool.context === 'extension') {
                      const handler = loadExtensionTool(tool);
                      let result = await handler(input, { execFileAsync, configDir, panel, modelName: model.name || model.family, schemata });
                      // Capture execute_python code + output for notebook mode
                      if (call.name === 'execute_python' && input.code) {
                        executedCells.push({ code: input.code, output: typeof result === 'string' ? result : '' });
                      }
                      // Capture IMG: base64 images from Python output
                      if (typeof result === 'string') {
                        result = result.replace(/IMG:([A-Za-z0-9+/=\s]{20,})/g, (_, b64) => {
                          capturedImages.push(b64.replace(/\s/g, ''));
                          return '[plot generated]';
                        });
                      }
                      return result;
                    } else {
                      accumulatedOps.push({ fn: call.name, input });
                      return `Done: ${call.name}(${JSON.stringify(input).slice(0, 200)})`;
                    }
                  } catch (e) {
                    return `Error in ${call.name}: ${e.message}`;
                  }
                };

                // Try tool-use first, with robust fallback
                let usedTools = false;

                // ── Direct API path ──────────────────────────
                if (isDirectAPI) {
                  const directMessages = [];
                  if (!isBootstrap) {
                    const history = msg.conversationHistory || [];
                    const historyBudget = Math.floor(charBudget * 0.30);
                    let historyChars = 0, startIdx = history.length;
                    for (let i = history.length - 1; i >= 0; i--) {
                      const turnChars = (history[i].content || '').length;
                      if (historyChars + turnChars > historyBudget) break;
                      historyChars += turnChars;
                      startIdx = i;
                    }
                    if (startIdx % 2 !== 0 && startIdx > 0) startIdx++;
                    for (const turn of history.slice(startIdx)) {
                      directMessages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.content });
                    }
                  }
                  const userPrompt = isBootstrap
                    ? fs.readFileSync(path.join(context.extensionPath, 'ecosystem', 'prompts', 'init.md'), 'utf8')
                    : msg.prompt;
                  directMessages.push({ role: 'user', content: userPrompt });

                  try {
                    const directResult = await runDirectAPILoop(
                      modelId, systemPrompt, directMessages, toolSchemas,
                      toolsByName, accumulatedOps, capturedImages, executedCells,
                      configDir, panel, tokenSource.token, schemata
                    );
                    finalAnswer = directResult.answer;
                    // Send token usage to webview
                    if (directResult.usage && (directResult.usage.input > 0 || directResult.usage.output > 0)) {
                      panel.webview.postMessage({
                        type: 'tokenUsage',
                        input: directResult.usage.input,
                        output: directResult.usage.output,
                      });
                    }
                    usedTools = accumulatedOps.length > 0;
                  } catch (e) {
                    if (e.message === 'cancelled') return;
                    throw e;
                  }

                } else if (hasToolSupport) {
                  try {
                    const toolOptions = {
                      tools: toolSchemas,
                      justification: 'Selva agent needs tools to modify config values, lock fields, and run analysis.',
                    };

                    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
                      const response = await model.sendRequest(messages, toolOptions, tokenSource.token);
                      const toolCalls = [];
                      let turnText = '';

                      // Use response.stream if available, else response.text
                      if (response.stream) {
                        for await (const part of response.stream) {
                          if (part instanceof vscode.LanguageModelTextPart) {
                            turnText += part.value;
                          } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            toolCalls.push(part);
                          }
                        }
                      } else {
                        // stream not available — text-only mode
                        for await (const chunk of response.text) { turnText += chunk; }
                      }

                      // Collect text: skip preamble from first turn (before any tools),
                      // keep everything after (model reflecting on tool results)
                      if (toolCalls.length === 0) {
                        // Final turn — always include
                        finalAnswer += turnText;
                        break;
                      }
                      // First turn with tools: skip the "I'll do X" preamble
                      // Later turns with tools: keep (model commenting on intermediate results)
                      if (usedTools && turnText) finalAnswer += turnText;

                      usedTools = true;
                      const assistantParts = [];
                      if (turnText) assistantParts.push(new vscode.LanguageModelTextPart(turnText));
                      assistantParts.push(...toolCalls);
                      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                      for (const call of toolCalls) {
                        const result = await executeToolCall(call);
                        messages.push(
                          vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(call.callId, [
                              new vscode.LanguageModelTextPart(result)
                            ])
                          ])
                        );
                      }
                    }
                  } catch (toolErr) {
                    // Tool-use failed — clear any partial answer and fall through to JSON fallback
                    if (!finalAnswer) finalAnswer = '';
                    usedTools = false;
                  }
                }

                // Fallback: if no tools were used, try JSON parsing (old protocol)
                if (!usedTools && accumulatedOps.length === 0) {
                  let raw = finalAnswer;
                  if (!raw) {
                    const response = await model.sendRequest(messages, {}, tokenSource.token);
                    raw = '';
                    for await (const chunk of response.text) { raw += chunk; }
                  }
                  if (!raw || !raw.trim()) {
                    panel.webview.postMessage({ type: resultType, ops: [], answer: null, error: isBootstrap ? undefined : 'Model returned an empty response.' });
                    return;
                  }
                  const extracted = extractOpsFromText(raw);
                  console.log('[Selva] JSON fallback — raw:', raw.slice(0, 300), '→ ops:', extracted.ops.length, 'answer:', (extracted.answer || '').slice(0, 100));
                  finalAnswer = extracted.answer;
                  accumulatedOps.push(...extracted.ops);
                }

                // ── Auto-execute Python code blocks (for models without tool support) ──
                if (capturedImages.length === 0 && finalAnswer) {
                  // Detect fenced or unfenced Python plotting code
                  let pyCode = null;
                  const pyFenced = finalAnswer.match(/```(?:python|execute_python|py)\n([\s\S]*?)```/);
                  if (pyFenced && /(?:plt\.|matplotlib|savefig|\.plot\(|\.scatter\(|\.bar\(|\.hist\()/.test(pyFenced[1])) {
                    pyCode = pyFenced[1];
                  } else {
                    const unfenced = detectUnfencedPython(finalAnswer);
                    if (unfenced.hasPython && /plt\./m.test(unfenced.code)) {
                      pyCode = unfenced.code;
                    }
                  }
                  if (pyCode) {
                    pyCode = fixPythonForHeadless(pyCode);
                    try {
                      const pyTool = toolsByName.get('execute_python');
                      const pyHandler = pyTool ? loadExtensionTool(pyTool) : null;
                      const pyResult = pyHandler ? await pyHandler({ code: pyCode }, { execFileAsync, configDir, panel }) : '';
                      const imgMatch = (pyResult || '').match(/IMG:([A-Za-z0-9+/=\s]{20,})/);
                      if (imgMatch) {
                        capturedImages.push(imgMatch[1].replace(/\s/g, ''));
                      }
                    } catch { /* Python execution failed — leave code block as-is */ }
                  }
                }

                // ── Execute extension-context ops from JSON fallback ──
                console.log('[Selva] Pre-interception ops:', accumulatedOps.length, accumulatedOps.map(o => o.fn));
                const webviewOps = [];
                for (const op of accumulatedOps) {
                  const toolDef = toolsByName.get(op.fn);
                  if (toolDef && toolDef.context === 'extension') {
                    // Execute extension-context tool directly
                    try {
                      const handler = loadExtensionTool(toolDef);
                      // Ops are already normalized to { fn, input } by extractOpsFromText
                      const input = op.input || {};
                      let result = await handler(input, { execFileAsync, configDir, panel, modelName: 'json-fallback', schemata });
                      // Capture images from Python execution
                      if (typeof result === 'string') {
                        result = result.replace(/IMG:([A-Za-z0-9+/=\s]{20,})/g, (_, b64) => {
                          capturedImages.push(b64.replace(/\s/g, ''));
                          return '[plot generated]';
                        });
                      }
                    } catch (e) { console.error('[Selva] Extension tool failed:', op.fn, e.message); }
                  } else {
                    webviewOps.push(op); // pass to webview
                  }
                }
                // Replace accumulatedOps with only webview ops
                console.log('[Selva] Post-interception: webview ops:', webviewOps.length, 'extension ops executed:', accumulatedOps.length - webviewOps.length);
                accumulatedOps.length = 0;
                accumulatedOps.push(...webviewOps);

                // ── Inject captured images into answer ────────
                if (capturedImages.length > 0) {
                  const imgTags = capturedImages.map(b64 => `IMG:${b64}`).join('\n\n');
                  finalAnswer = (finalAnswer || '') + '\n\n' + imgTags;
                }

                // ── Send result ───────────────────────────────
                activeTokenSources.delete(configDir);
                panel.webview.postMessage({
                  type: resultType,
                  answer: finalAnswer || null,
                  summary: accumulatedOps.length > 0 ? `Executed ${accumulatedOps.length} operation${accumulatedOps.length > 1 ? 's' : ''}.` : null,
                  ops: accumulatedOps,
                  executedCells: executedCells.length > 0 ? executedCells : undefined,
                });

              } catch (e) {
                activeTokenSources.delete(configDir);
                // Don't send error for user-initiated cancellations
                if (e.message && e.message.includes('cancelled')) return;
                panel.webview.postMessage({ type: resultType, ops: [], answer: null, error: isBootstrap ? undefined : (e.message || String(e)) });
              }
            })();
            break;
          }
          case 'editCellCode': {
            (async () => {
              try {
                const prompt = `Modify the following Python code according to this instruction: "${msg.instruction}"\n\nCode:\n\`\`\`python\n${msg.code}\n\`\`\`\n\nReturn ONLY the modified Python code. No explanation, no fences, no markdown — just the raw code.`;

                const isDirectAPI = msg.modelId && msg.modelId.startsWith('direct:');
                let result = '';

                if (isDirectAPI) {
                  const isAnthropic = msg.modelId.startsWith('direct:claude');
                  const apiKey = isAnthropic ? apiKeys.anthropic : apiKeys.openai;
                  if (!apiKey) throw new Error('No API key');
                  if (isAnthropic) {
                    const resp = await callAnthropicAPI(apiKey, msg.modelId, 'You are a code editor. Return only modified code.', [{ role: 'user', content: prompt }], [], null);
                    result = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
                  } else {
                    const resp = await callOpenAIAPI(apiKey, msg.modelId, 'You are a code editor. Return only modified code.', [{ role: 'user', content: prompt }], [], null);
                    result = resp.choices?.[0]?.message?.content || '';
                  }
                } else if (vscode.lm) {
                  let allModels = await vscode.lm.selectChatModels({});
                  let model = msg.modelId ? allModels.find(m => m.id === msg.modelId) : allModels[0];
                  if (!model && allModels.length) model = allModels[0];
                  if (model) {
                    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                    for await (const chunk of response.text) { result += chunk; }
                  }
                }
                // Strip fences if model added them
                result = result.trim().replace(/^```(?:python)?\s*\n?/i, '').replace(/\n?\s*```$/,'').trim();
                panel.webview.postMessage({ type: 'editCellCodeResult', code: result || null });
              } catch (e) {
                panel.webview.postMessage({ type: 'editCellCodeResult', error: e.message });
              }
            })();
            break;
          }
          case 'executeCell': {
            (async () => {
              try {
                let code = fixPythonForHeadless(msg.code);
                const allTools = loadAllTools(context.extensionPath);
                const pyTool = allTools.find(t => t.name === 'execute_python');
                if (!pyTool) throw new Error('execute_python tool not found');
                const handler = loadExtensionTool(pyTool);
                const result = await handler({ code }, { execFileAsync, configDir, panel });
                panel.webview.postMessage({ type: 'executeCellResult', result });
              } catch (e) {
                panel.webview.postMessage({ type: 'executeCellResult', error: e.message || String(e) });
              }
            })();
            break;
          }
          case 'saveAdditionalInstructions': {
            context.globalState.update('additionalInstructions', msg.text || '');
            break;
          }
          case 'setApiKey': {
            if (msg.provider === 'anthropic') apiKeys.anthropic = msg.key || '';
            else if (msg.provider === 'openai') apiKeys.openai = msg.key || '';
            // Store in VS Code SecretStorage (encrypted by OS keychain)
            if (msg.key) {
              context.secrets.store('apiKey:' + msg.provider, msg.key);
            } else {
              context.secrets.delete('apiKey:' + msg.provider);
            }
            sendModelList(panel);
            break;
          }
          case 'abortAgent': {
            const ts = activeTokenSources.get(configDir);
            if (ts) {
              ts.cancel();
              activeTokenSources.delete(configDir);
            }
            break;
          }
          case 'openUrl': {
            const url = msg.url;
            if (url && /^https?:\/\//.test(url)) {
              vscode.env.openExternal(vscode.Uri.parse(url));
            }
            break;
          }
          case 'exportJson': {
            try {
              const filePath = path.resolve(configDir, msg.filename);
              const safeBase = path.resolve(configDir) + path.sep;
              if (!filePath.startsWith(safeBase)) {
                panel.webview.postMessage({ type: 'exportJsonResult', error: 'Invalid path' });
                return;
              }
              const jsonFilename = msg.filename.replace(/\.ya?ml$/i, '.json');
              const jsonPath = path.resolve(configDir, jsonFilename);
              fs.writeFileSync(jsonPath, JSON.stringify(msg.data, null, 2), 'utf8');
              panel.webview.postMessage({ type: 'exportJsonResult', success: true, jsonFilename });
            } catch (e) {
              panel.webview.postMessage({ type: 'exportJsonResult', error: e.message });
            }
            break;
          }
        }
      }, undefined, context.subscriptions);

    } catch (e) {
      vscode.window.showErrorMessage(`Selva: ${e.message}`);
    }
  });

  context.subscriptions.push(cmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
