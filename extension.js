const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const yaml = require('./vendor/js-yaml.min.js');
const {
  callAnthropicAPI,
  callOpenAIAPI,
} = require('./lib/agent-core');
const { executeNotebookCell } = require('./lib/notebook-execution');
const {
  createWorkspaceRuntime,
  loadAllTools,
  loadExtensionTool,
} = require('./lib/selva-runtime');
const { createJaneRuntime } = require('./lib/jane-runtime');
const {
  acknowledgeExternalDrafts,
  getTrailsDir,
  setPanelState,
} = require('./lib/session-store');
const {
  CELL_EDIT_RESULT_SCHEMA,
  buildCellEditSystemPrompt,
  buildCellEditUserPrompt,
  buildCodingAgentConnectPrompt,
  buildCodexProjectConfig,
  buildWorkspaceMcpConfig,
  detectCodingAgents,
  looksLikeCellExecutionError,
  parseCellEditAgentResponse,
  pickCellDebuggerModel,
  pickDefaultCodingAgentId,
  resolveAgentBinaryPath,
} = require('./lib/coding-agents');

const execFileAsync = promisify(execFile);

const panels = new Map(); // configDir -> WebviewPanel
const activeTokenSources = new Map(); // configDir -> CancellationTokenSource
const localSessionSyncSuppressUntil = new Map(); // configDir -> epoch ms
const CELL_EDIT_MAX_ATTEMPTS = 3;
const CELL_EDIT_AGENT_TIMEOUT_MS = 180000;

const os = require('os');

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

async function listCodingAgents() {
  const extensions = vscode.extensions.all.map((extension) => ({
    id: extension.id,
    version: extension.packageJSON && extension.packageJSON.version ? extension.packageJSON.version : '',
    extensionPath: extension.extensionPath || '',
  }));
  return detectCodingAgents({ extensions });
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function wrapManagedConfigBlock(body) {
  return ['# >>> Selva MCP >>>', body.trimEnd(), '# <<< Selva MCP <<<', ''].join('\n');
}

function readWorkspaceSelvaMcpConfig(configDir) {
  const mcpConfigPath = path.join(configDir, '.mcp.json');
  if (!fs.existsSync(mcpConfigPath)) {
    return {
      command: '/opt/homebrew/bin/node',
      args: [path.join(__dirname, 'mcp-server.js'), configDir],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    const server = parsed && parsed.mcpServers ? parsed.mcpServers.selva : null;
    const command = server && server.command ? String(server.command) : '/opt/homebrew/bin/node';
    const args = Array.isArray(server && server.args)
      ? server.args.map((arg) => String(arg))
      : [path.join(__dirname, 'mcp-server.js'), configDir];
    return { command, args };
  } catch {
    return {
      command: '/opt/homebrew/bin/node',
      args: [path.join(__dirname, 'mcp-server.js'), configDir],
    };
  }
}

function ensureWorkspaceSelvaMcpConfig(configDir) {
  const mcpConfigPath = path.join(configDir, '.mcp.json');
  const desired = {
    command: '/opt/homebrew/bin/node',
    args: [path.join(__dirname, 'mcp-server.js'), configDir],
  };

  if (!fs.existsSync(mcpConfigPath)) {
    fs.writeFileSync(mcpConfigPath, buildWorkspaceMcpConfig({
      command: desired.command,
      args: desired.args,
    }), 'utf8');
    return { configPath: mcpConfigPath, status: 'created' };
  }

  let parsed;
  const currentText = fs.readFileSync(mcpConfigPath, 'utf8');
  try {
    parsed = JSON.parse(currentText);
  } catch {
    const backupPath = `${mcpConfigPath}.bak-${Date.now()}`;
    fs.writeFileSync(backupPath, currentText, 'utf8');
    fs.writeFileSync(mcpConfigPath, buildWorkspaceMcpConfig({
      command: desired.command,
      args: desired.args,
    }), 'utf8');
    return { configPath: mcpConfigPath, backupPath, status: 'repaired' };
  }

  const currentServer = parsed
    && parsed.mcpServers
    && typeof parsed.mcpServers === 'object'
    && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers.selva
    : null;
  const currentArgs = Array.isArray(currentServer && currentServer.args)
    ? currentServer.args.map((arg) => String(arg))
    : [];
  const currentCommand = currentServer && currentServer.command ? String(currentServer.command) : '';
  if (currentCommand === desired.command && JSON.stringify(currentArgs) === JSON.stringify(desired.args)) {
    return { configPath: mcpConfigPath, status: 'unchanged' };
  }

  fs.writeFileSync(mcpConfigPath, buildWorkspaceMcpConfig({
    command: desired.command,
    args: desired.args,
    currentConfig: parsed,
  }), 'utf8');
  return { configPath: mcpConfigPath, status: 'updated' };
}

function ensureCodexProjectConfig(configDir) {
  const codexDir = path.join(configDir, '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const mcpConfig = readWorkspaceSelvaMcpConfig(configDir);
  const managedBlock = wrapManagedConfigBlock(buildCodexProjectConfig({
    command: mcpConfig.command,
    args: mcpConfig.args,
  }));

  fs.mkdirSync(codexDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, managedBlock, 'utf8');
    return { configPath, status: 'created' };
  }

  const current = fs.readFileSync(configPath, 'utf8');
  const beginMarker = '# >>> Selva MCP >>>';
  const endMarker = '# <<< Selva MCP <<<';
  if (current.includes(beginMarker) && current.includes(endMarker)) {
    const updated = current.replace(new RegExp(`${beginMarker}[\\s\\S]*?${endMarker}\\n?`, 'm'), managedBlock);
    if (updated !== current) fs.writeFileSync(configPath, updated, 'utf8');
    return { configPath, status: updated === current ? 'unchanged' : 'updated' };
  }

  if (/\[mcp_servers\.selva\]/.test(current)) {
    return { configPath, status: 'present' };
  }

  const prefix = current.trim().length ? `${current.trimEnd()}\n\n` : '';
  fs.writeFileSync(configPath, prefix + managedBlock, 'utf8');
  return { configPath, status: 'updated' };
}

function suppressLocalSessionSync(configDir, durationMs = 800) {
  localSessionSyncSuppressUntil.set(configDir, Date.now() + durationMs);
}

function createTerminalLaunchScript({ agent, binaryPath, configDir, startupPrompt }) {
  const tempDir = path.join(os.tmpdir(), 'selva-coding-agent');
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const promptFile = path.join(tempDir, `${agent.id}-${stamp}.prompt.txt`);
  const scriptFile = path.join(tempDir, `${agent.id}-${stamp}.launch.sh`);

  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(promptFile, startupPrompt, 'utf8');

  const scriptLines = [
    '#!/bin/zsh',
    'set -e',
    `PROMPT_FILE=${shellQuote(promptFile)}`,
    'PROMPT_CONTENT="$(cat "$PROMPT_FILE")"',
  ];

  if (agent.id === 'claude-code') {
    const mcpConfigPath = path.join(configDir, '.mcp.json');
    scriptLines.push(
      `${shellQuote(binaryPath)} --permission-mode dontAsk --allowedTools mcp__selva --mcp-config ${shellQuote(mcpConfigPath)} -- "$PROMPT_CONTENT"`
    );
  } else if (agent.id === 'codex') {
    scriptLines.push(
      `${shellQuote(binaryPath)} -C ${shellQuote(configDir)} "$PROMPT_CONTENT"`
    );
  } else {
    scriptLines.push(`${shellQuote(binaryPath)} "$PROMPT_CONTENT"`);
  }

  fs.writeFileSync(scriptFile, scriptLines.join('\n') + '\n', { mode: 0o700 });
  try {
    fs.chmodSync(scriptFile, 0o700);
  } catch {
    // best effort only; writeFileSync mode is enough on supported platforms
  }

  return {
    promptFile,
    scriptFile,
    launchCommand: shellQuote(scriptFile),
  };
}

function createManagedTempFile(prefix, extension, contents) {
  const tempDir = path.join(os.tmpdir(), 'selva-coding-agent');
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const filePath = path.join(tempDir, `${prefix}-${stamp}.${extension}`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function runCliWithInput(binaryPath, args, {
  cwd,
  timeout = 0,
  maxBuffer = 10 * 1024 * 1024,
  input = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutId = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut || !!error.killed;
      reject(error);
    };

    const appendChunk = (streamName, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (streamName === 'stdout') stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > maxBuffer) {
        const error = new Error(`CLI ${streamName} exceeded maxBuffer`);
        error.code = 'MAXBUFFER';
        try { child.kill('SIGTERM'); } catch {}
        fail(error);
      }
    };

    child.stdout.on('data', (chunk) => appendChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => appendChunk('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${binaryPath} ${args.join(' ')}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    });

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        const forceKill = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2000);
        if (typeof forceKill.unref === 'function') forceKill.unref();
      }, timeout);
      if (typeof timeoutId.unref === 'function') timeoutId.unref();
    }

    child.stdin.end(input || '');
  });
}

async function resolveRequestedCodingAgent(agentId) {
  const agents = await listCodingAgents();
  if (!agents.length) {
    throw new Error('No coding agents are available in this VS Code instance.');
  }

  const effectiveId = agentId || pickDefaultCodingAgentId(agents);
  const agent = agents.find((candidate) => candidate.id === effectiveId) || agents[0];
  if (!agent) {
    throw new Error('Selected coding agent is not available in this VS Code instance.');
  }

  const binaryPath = resolveAgentBinaryPath(agent);
  if (!binaryPath) {
    throw new Error(`Could not find the ${agent.label} CLI binary in the installed VS Code extension.`);
  }

  return { agent, binaryPath };
}

function formatCliFailure(error) {
  const stdout = error && error.stdout ? String(error.stdout).trim() : '';
  const stderr = error && error.stderr ? String(error.stderr).trim() : '';
  const details = [stderr, stdout].filter(Boolean).join('\n\n');
  if (details) return details;

  if (error && (error.code === 'E2BIG' || /E2BIG/.test(String(error.message || '')))) {
    return 'The cell edit prompt was too large to launch the coding agent.';
  }

  if (error && error.code === 'MAXBUFFER') {
    return 'The coding agent returned too much output while editing the cell.';
  }

  if (error && error.killed) {
    return 'Timed out waiting for the coding agent to return edited code.';
  }

  const message = String((error && error.message) || '').trim();
  if (/^Command failed:/.test(message)) {
    const exitCode = typeof error.code === 'number' ? ` (exit ${error.code})` : '';
    return `The coding agent exited before returning a valid response${exitCode}.`;
  }

  return message || 'Unknown coding agent failure';
}

function updatePanelTitle(panel, folderName, trailName) {
  const safeFolder = folderName || 'Selva';
  const safeTrail = String(trailName || '').trim();
  panel.title = safeTrail ? `${safeFolder} · ${safeTrail}` : safeFolder;
}

async function runClaudeCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId = '' }) {
  try {
    const args = [
      '-p',
    ];
    if (modelId) args.push('--model', modelId);
    args.push(
      '--effort', 'low',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(CELL_EDIT_RESULT_SCHEMA),
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--system-prompt', systemPrompt,
    );
    const { stdout } = await runCliWithInput(binaryPath, args, {
      cwd: configDir,
      timeout: CELL_EDIT_AGENT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      input: userPrompt,
    });
    return parseCellEditAgentResponse(stdout);
  } catch (error) {
    throw new Error(`Claude Code cell edit failed: ${formatCliFailure(error)}`);
  }
}

async function runCodexCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId = '' }) {
  const schemaFile = createManagedTempFile('cell-edit-schema', 'json', JSON.stringify(CELL_EDIT_RESULT_SCHEMA, null, 2));
  const outputFile = createManagedTempFile('cell-edit-output', 'json', '');
  const prompt = [systemPrompt, userPrompt].filter(Boolean).join('\n\n');

  try {
    const args = [
      '-a', 'never',
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      '--output-schema', schemaFile,
      '-o', outputFile,
      '-C', configDir,
    ];
    if (modelId) args.push('--model', modelId);
    args.push('-');
    const { stdout } = await runCliWithInput(binaryPath, args, {
      cwd: configDir,
      timeout: CELL_EDIT_AGENT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      input: prompt,
    });
    const raw = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : stdout;
    return parseCellEditAgentResponse(raw);
  } catch (error) {
    throw new Error(`Codex cell edit failed: ${formatCliFailure(error)}`);
  } finally {
    try { fs.unlinkSync(schemaFile); } catch {}
    try { fs.unlinkSync(outputFile); } catch {}
  }
}

async function runExternalCellEditOnce({
  agentId,
  code,
  instruction,
  output,
  configDir,
  sessionInstructions,
}) {
  const { agent, binaryPath } = await resolveRequestedCodingAgent(agentId);
  const cellDebuggerModel = pickCellDebuggerModel(agent.id);
  const systemPrompt = buildCellEditSystemPrompt({ sessionInstructions });
  const shouldIncludeOutput = looksLikeCellExecutionError(output);
  const userPrompt = buildCellEditUserPrompt({
    instruction,
    code,
    output: shouldIncludeOutput ? output : '',
    attempt: 1,
    maxAttempts: 1,
  });

  const response = agent.id === 'codex'
    ? await runCodexCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId: cellDebuggerModel })
    : await runClaudeCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId: cellDebuggerModel });

  return {
    agent,
    code: response.code || '',
  };
}

async function runExternalCellEditWithRetries({
  agentId,
  code,
  instruction,
  language,
  output,
  configDir,
  sessionInstructions,
  panel,
  trailId,
}) {
  const { agent, binaryPath } = await resolveRequestedCodingAgent(agentId);
  const cellDebuggerModel = pickCellDebuggerModel(agent.id);
  const systemPrompt = buildCellEditSystemPrompt({ sessionInstructions });
  const shouldValidate = looksLikeCellExecutionError(output);
  let currentCode = String(code || '');
  let currentOutput = String(output || '');
  let latestValidationOutput = currentOutput;

  for (let attempt = 1; attempt <= CELL_EDIT_MAX_ATTEMPTS; attempt++) {
    const userPrompt = buildCellEditUserPrompt({
      instruction,
      code: currentCode,
      output: shouldValidate ? currentOutput : '',
      attempt,
      maxAttempts: CELL_EDIT_MAX_ATTEMPTS,
    });

    const response = agent.id === 'codex'
      ? await runCodexCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId: cellDebuggerModel })
      : await runClaudeCellEdit({ binaryPath, configDir, systemPrompt, userPrompt, modelId: cellDebuggerModel });

    currentCode = response.code || currentCode;
    if (!shouldValidate) {
      return {
        agent,
        code: currentCode,
        output: currentOutput,
        attempts: attempt,
        validated: false,
      };
    }

    latestValidationOutput = await executeNotebookCell({
      language: language || 'python',
      code: currentCode,
      configDir,
      extensionPath: __dirname,
      execFileAsync,
      panel,
      trailId,
    });

    if (!looksLikeCellExecutionError(latestValidationOutput)) {
      return {
        agent,
        code: currentCode,
        output: latestValidationOutput,
        attempts: attempt,
        validated: true,
      };
    }

    currentOutput = latestValidationOutput;
  }

  return {
    agent,
    code: currentCode,
    output: latestValidationOutput,
    attempts: CELL_EDIT_MAX_ATTEMPTS,
    validated: true,
    error: `Updated code still fails after ${CELL_EDIT_MAX_ATTEMPTS} repair attempts.`,
  };
}

async function runLegacyInternalCellEdit({ code, instruction, modelId }) {
  const prompt = `Modify the following Python code according to this instruction: "${instruction}"\n\nCode:\n\`\`\`python\n${code}\n\`\`\`\n\nReturn ONLY the modified Python code. No explanation, no fences, no markdown — just the raw code.`;

  const isDirectAPI = modelId && modelId.startsWith('direct:');
  let result = '';

  if (isDirectAPI) {
    const isAnthropic = modelId.startsWith('direct:claude');
    const apiKey = isAnthropic ? apiKeys.anthropic : apiKeys.openai;
    if (!apiKey) throw new Error('No API key');
    if (isAnthropic) {
      const resp = await callAnthropicAPI(apiKey, modelId, 'You are a code editor. Return only modified code.', [{ role: 'user', content: prompt }], [], null);
      result = (resp.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    } else {
      const resp = await callOpenAIAPI(apiKey, modelId, 'You are a code editor. Return only modified code.', [{ role: 'user', content: prompt }], [], null);
      result = resp.choices?.[0]?.message?.content || '';
    }
  } else if (vscode.lm) {
    const allModels = await vscode.lm.selectChatModels({});
    let model = modelId ? allModels.find((candidate) => candidate.id === modelId) : allModels[0];
    if (!model && allModels.length) model = allModels[0];
    if (model) {
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
      for await (const chunk of response.text) { result += chunk; }
    }
  }

  const parsed = parseCellEditAgentResponse(result);
  return {
    code: parsed.code || '',
    output: '',
    validated: false,
    attempts: 1,
  };
}

async function connectCodingAgent({ agentId, janeRuntime }) {
  const agents = await listCodingAgents();
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error('Selected coding agent is not available in this VS Code instance.');
  }

  const initPayload = janeRuntime.buildInitPayload();
  const configDir = initPayload.configDir || janeRuntime.configDir;
  const startupPrompt = buildCodingAgentConnectPrompt({ agent, initPayload });
  const workspaceMcpSync = ensureWorkspaceSelvaMcpConfig(configDir);
  let configSync = null;

  if (agent.id === 'codex') {
    configSync = ensureCodexProjectConfig(configDir);
  }

  const binaryPath = resolveAgentBinaryPath(agent);
  if (!binaryPath) {
    throw new Error(`Could not find the ${agent.label} CLI binary in the installed VS Code extension.`);
  }

  const launchArtifacts = createTerminalLaunchScript({
    agent,
    binaryPath,
    configDir,
    startupPrompt,
  });
  const terminal = vscode.window.createTerminal({
    name: `Selva ${agent.label}`,
    cwd: configDir,
  });
  await vscode.env.clipboard.writeText(startupPrompt);
  terminal.show(true);
  terminal.sendText(launchArtifacts.launchCommand, true);

  return {
    agent,
    launchMode: 'terminal',
    promptCopied: true,
    launchCommand: launchArtifacts.scriptFile,
    workspaceMcpSync,
    configSync,
  };
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

      ensureWorkspaceSelvaMcpConfig(configDir);

      // ── Resource URIs ──────────────────────────────────────
      const nonce = crypto.randomBytes(16).toString('hex');
      const folderName = path.basename(configDir).replace(/ /g, '_');
      const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath: context.extensionPath });
      const janeRuntime = createJaneRuntime({ configDir, extensionPath: context.extensionPath, workspaceRuntime });
      const trailsDir = getTrailsDir(configDir);
      const initialTrailState = janeRuntime.listTrails();

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
      updatePanelTitle(panel, folderName, initialTrailState.activeTrail && initialTrailState.activeTrail.name);
      panels.set(configDir, panel);
      setPanelState(configDir, { open: true });
      panel.onDidDispose(() => {
        panels.delete(configDir);
        setPanelState(configDir, { open: false });
      }, null, context.subscriptions);

      const mediaUri = (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file));
      const vendorUri = (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'vendor', file));
      const cssUri      = mediaUri('webview.css');
      const codeMirrorCssUri = vendorUri('codemirror/lib/codemirror.css');
      const katexCssUri = vendorUri('katex.min.css');
      const codeMirrorUri = vendorUri('codemirror/lib/codemirror.js');
      const codeMirrorCommentUri = vendorUri('codemirror/addon/comment/comment.js');
      const codeMirrorMatchBracketsUri = vendorUri('codemirror/addon/edit/matchbrackets.js');
      const codeMirrorPythonUri = vendorUri('codemirror/mode/python/python.js');
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
        .replace('{{CODEMIRROR_CSS_URI}}', codeMirrorCssUri.toString())
        .replace('{{KATEX_CSS_URI}}', katexCssUri.toString())
        .replace('{{CODEMIRROR_URI}}', codeMirrorUri.toString())
        .replace('{{CODEMIRROR_COMMENT_URI}}', codeMirrorCommentUri.toString())
        .replace('{{CODEMIRROR_MATCHBRACKETS_URI}}', codeMirrorMatchBracketsUri.toString())
        .replace('{{CODEMIRROR_PYTHON_URI}}', codeMirrorPythonUri.toString())
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

      // ── File watcher (auto-reload on external changes, e.g. MCP) ──
      const watcher = fs.watch(configDir, { recursive: true }, (eventType, filename) => {
        if (!filename || !/\.ya?ml$/i.test(filename)) return;
        // Debounce: ignore rapid successive events
        if (watcher._debounce) clearTimeout(watcher._debounce);
        watcher._debounce = setTimeout(() => {
          try {
            const filePath = path.resolve(configDir, filename);
            const safeBase = path.resolve(configDir) + path.sep;
            if (!filePath.startsWith(safeBase)) return;
            const raw = fs.readFileSync(filePath, 'utf8');
            const docs = yaml.loadAll(raw);
            const docKey = docs.length === 1 ? null : filename.replace(/\.ya?ml$/i, '');
            const parsed = docKey ? { [docKey]: docs } : docs[0];
            panel.webview.postMessage({ type: 'configData', filename, raw, parsed, external: true });
          } catch { /* file may be mid-write */ }
        }, 300);
      });
      const sessionWatcher = fs.watch(trailsDir, () => {
        if (sessionWatcher._debounce) clearTimeout(sessionWatcher._debounce);
        sessionWatcher._debounce = setTimeout(() => {
          try {
            if ((localSessionSyncSuppressUntil.get(configDir) || 0) > Date.now()) return;
            const trailState = janeRuntime.listTrails();
            updatePanelTitle(panel, folderName, trailState.activeTrail && trailState.activeTrail.name);
            panel.webview.postMessage({
              type: 'janeSessionSync',
              session: janeRuntime.getSession(),
              trailState,
            });
          } catch { /* session may be mid-write */ }
        }, 120);
      });
      panel.onDidDispose(() => {
        watcher.close();
        sessionWatcher.close();
      }, null, context.subscriptions);

      // ── Message handler ────────────────────────────────────
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'init': {
            setPanelState(configDir, { open: true });
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
            let janeSession = janeRuntime.getSession();
            const legacyAdditionalInstructions = context.globalState.get('additionalInstructions', '');
            if (!janeSession.additionalInstructions && legacyAdditionalInstructions) {
              janeSession = janeRuntime.setSessionInstructions(legacyAdditionalInstructions);
            }
            const codingAgents = await listCodingAgents();
            const trailState = janeRuntime.listTrails();
            updatePanelTitle(panel, folderName, trailState.activeTrail && trailState.activeTrail.name);
            panel.webview.postMessage({
              type: 'init',
              files,
              configDir,
              userDefaultSettings,
              pinnedFields,
              defaultPromptTemplate,
              apiKeys: maskedKeys,
              additionalInstructions: janeSession.additionalInstructions,
              session: janeSession,
              trails: trailState.trails,
              activeTrail: trailState.activeTrail,
              codingAgents,
              defaultCodingAgentId: pickDefaultCodingAgentId(codingAgents),
            });
            sendModelList(panel);
            // Send webview-context tools for registration
            const initTools = loadAllTools(context.extensionPath);
            const webviewTools = initTools
              .filter(t => t.context === 'webview')
              .map(t => ({ name: t.name, code: t.code }));
            panel.webview.postMessage({ type: 'registerTools', tools: webviewTools });
            break;
          }
          case 'ackExternalDrafts': {
            acknowledgeExternalDrafts(configDir, msg.ids || []);
            break;
          }
          case 'persistSessionEntries': {
            suppressLocalSessionSync(configDir);
            janeRuntime.replaceSessionEntries(msg.entries || []);
            break;
          }
          case 'janeTrailNew': {
            suppressLocalSessionSync(configDir);
            const result = janeRuntime.createTrail({ name: msg.name || '' });
            updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
            panel.webview.postMessage({
              type: 'trailState',
              action: 'new',
              session: janeRuntime.getSession(),
              trails: result.trails,
              activeTrail: result.activeTrail,
            });
            break;
          }
          case 'janeTrailFork': {
            suppressLocalSessionSync(configDir);
            const result = janeRuntime.forkTrail({
              name: msg.name || '',
              sourceTrailId: msg.sourceTrailId || '',
            });
            updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
            panel.webview.postMessage({
              type: 'trailState',
              action: 'fork',
              session: janeRuntime.getSession(),
              trails: result.trails,
              activeTrail: result.activeTrail,
            });
            break;
          }
          case 'janeTrailSwitch': {
            suppressLocalSessionSync(configDir);
            const result = janeRuntime.switchTrail({ trailId: msg.trailId || '' });
            updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
            panel.webview.postMessage({
              type: 'trailState',
              action: 'switch',
              session: janeRuntime.getSession(),
              trails: result.trails,
              activeTrail: result.activeTrail,
            });
            break;
          }
          case 'janeTrailRename': {
            suppressLocalSessionSync(configDir);
            const result = janeRuntime.renameTrail({
              trailId: msg.trailId || '',
              name: msg.name || '',
            });
            updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
            panel.webview.postMessage({
              type: 'trailState',
              action: 'rename',
              session: janeRuntime.getSession(),
              trails: result.trails,
              activeTrail: result.activeTrail,
            });
            break;
          }
          case 'listModels': {
            sendModelList(panel);
            break;
          }
          case 'connectCodingAgent': {
            try {
              const result = await connectCodingAgent({
                agentId: String(msg.agentId || ''),
                janeRuntime,
              });
              panel.webview.postMessage({
                type: 'codingAgentConnected',
                agent: result.agent,
                launchMode: result.launchMode,
                promptCopied: result.promptCopied,
              });
            } catch (e) {
              panel.webview.postMessage({
                type: 'codingAgentConnectionError',
                error: e.message,
              });
            }
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
          case 'agentPrompt':
          case 'janeSessionBootstrap':
          case 'janeSessionRun': {
            const isBootstrap = msg.type === 'bootstrap' || msg.type === 'janeSessionBootstrap';
            (async () => {
              try {
                const tokenSource = new vscode.CancellationTokenSource();
                activeTokenSources.set(configDir, tokenSource);
                const agentResult = isBootstrap
                  ? await janeRuntime.bootstrapSession({
                    modelId: msg.modelId || '',
                    schemata: msg.schemata || [],
                    dashboardState: msg.dashboardState || null,
                    apiKeys,
                    vscodeApi: vscode,
                    panel,
                    token: tokenSource.token,
                    execFileAsync,
                    persistConfigChanges: false,
                    onUsage: (usage) => {
                      panel.webview.postMessage({
                        type: 'tokenUsage',
                        input: usage.input,
                        output: usage.output,
                      });
                    },
                  })
                  : await janeRuntime.runSessionTurn({
                    prompt: msg.prompt || '',
                    modelId: msg.modelId || '',
                    schemata: msg.schemata || [],
                    dashboardState: msg.dashboardState || null,
                    apiKeys,
                    vscodeApi: vscode,
                    panel,
                    token: tokenSource.token,
                    execFileAsync,
                    persistConfigChanges: false,
                    onUsage: (usage) => {
                      panel.webview.postMessage({
                        type: 'tokenUsage',
                        input: usage.input,
                        output: usage.output,
                      });
                    },
                  });

                activeTokenSources.delete(configDir);
                panel.webview.postMessage({
                  type: 'janeSessionResult',
                  mode: isBootstrap ? 'bootstrap' : 'turn',
                  answer: agentResult.answer,
                  summary: agentResult.summary,
                  ops: agentResult.ops,
                  executedCells: agentResult.executedCells,
                  artifacts: agentResult.artifacts,
                  session: agentResult.session,
                  entry: agentResult.entry,
                  modelId: agentResult.modelId,
                  error: agentResult.error,
                });

              } catch (e) {
                activeTokenSources.delete(configDir);
                // Don't send error for user-initiated cancellations
                if (e.message && e.message.includes('cancelled')) return;
                panel.webview.postMessage({
                  type: 'janeSessionResult',
                  mode: isBootstrap ? 'bootstrap' : 'turn',
                  ops: [],
                  answer: null,
                  error: isBootstrap ? undefined : (e.message || String(e)),
                });
              }
            })();
            break;
          }
          case 'editCellCode': {
            (async () => {
              try {
                const sessionInstructions = janeRuntime.getSession().additionalInstructions || '';
                let result;

                if (msg.agentId) {
                  const activeSession = janeRuntime.getSession();
                  result = await runExternalCellEditWithRetries({
                    agentId: msg.agentId,
                    code: msg.code || '',
                    instruction: msg.instruction || '',
                    language: msg.language || 'python',
                    output: msg.output || '',
                    configDir,
                    sessionInstructions,
                    panel,
                    trailId: msg.trailId || activeSession.trailId || '',
                  });
                } else {
                  result = await runLegacyInternalCellEdit({
                    code: msg.code || '',
                    instruction: msg.instruction || '',
                    modelId: msg.modelId || '',
                  });
                }

                panel.webview.postMessage({
                  type: 'editCellCodeResult',
                  requestId: msg.requestId || '',
                  cellId: msg.cellId || '',
                  code: result.code || null,
                  output: Object.prototype.hasOwnProperty.call(result, 'output') ? result.output : undefined,
                  attempts: result.attempts || 1,
                  validated: !!result.validated,
                  validationError: result.error || '',
                  agentId: msg.agentId || '',
                });
              } catch (e) {
                panel.webview.postMessage({
                  type: 'editCellCodeResult',
                  requestId: msg.requestId || '',
                  cellId: msg.cellId || '',
                  error: e.message,
                });
              }
            })();
            break;
          }
          case 'executeCell': {
            (async () => {
              try {
                const activeSession = janeRuntime.getSession();
                const result = await executeNotebookCell({
                  language: msg.language || 'python',
                  code: msg.code,
                  configDir,
                  extensionPath: __dirname,
                  execFileAsync,
                  panel,
                  trailId: msg.trailId || activeSession.trailId || '',
                });
                panel.webview.postMessage({
                  type: 'executeCellResult',
                  requestId: msg.requestId || '',
                  cellId: msg.cellId || '',
                  result,
                });
              } catch (e) {
                panel.webview.postMessage({
                  type: 'executeCellResult',
                  requestId: msg.requestId || '',
                  cellId: msg.cellId || '',
                  error: e.message || String(e),
                });
              }
            })();
            break;
          }
          case 'saveAdditionalInstructions':
          case 'janeSessionSetInstructions': {
            janeRuntime.setSessionInstructions(msg.text || '');
            context.globalState.update('additionalInstructions', msg.text || '');
            break;
          }
          case 'setAgentModel':
          case 'janeSessionSetModel': {
            janeRuntime.setSessionModel(msg.modelId || '');
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
