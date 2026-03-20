const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const yaml = require('./vendor/js-yaml.min.js');
const { handleTrailOp } = require('./handlers/trail-ops');
const { handleAgentOp } = require('./handlers/agent-ops');
const { handleFileOp } = require('./handlers/file-ops');
const { handleKernelOp } = require('./handlers/kernel-ops');
const { handleSettingsOp } = require('./handlers/settings-ops');
const {
  disposeAllNotebookRuntimes,
} = require('./lib/notebook-execution');
const {
  createWorkspaceRuntime,
} = require('./lib/selva-runtime');
const { createJaneRuntime } = require('./lib/jane-runtime');
const {
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

async function connectCodingAgent({ agentId, janeRuntime }) {
  const agents = await listCodingAgents();
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error('Selected coding agent is not available in this VS Code instance.');
  }

  const initPayload = janeRuntime.buildInitPayload();
  const configDir = initPayload.configDir || janeRuntime.configDir;
  const session = janeRuntime.getSession();
  const startupPrompt = buildCodingAgentConnectPrompt({
    agent,
    initPayload,
    extensionPath: __dirname,
    bitacora: session.bitacora || '',
    trailInstructions: session.additionalInstructions || '',
  });
  // Save the connect prompt to the trail folder for inspection
  try {
    const trailId = session.trailId || '';
    if (trailId) {
      const trailDir = path.join(getTrailsDir(configDir), trailId);
      fs.mkdirSync(trailDir, { recursive: true });
      fs.writeFileSync(path.join(trailDir, 'LAST_PROMPT.md'), startupPrompt, 'utf8');
    }
  } catch {}

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
      const sessionWatcher = fs.watch(trailsDir, { recursive: true }, () => {
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
      const handlerCtx = {
        vscode,
        configDir,
        panel,
        folderName,
        janeRuntime,
        context,
        apiKeys,
        yaml,
        activeTokenSources,
        execFileAsync,
        extensionPath: __dirname,
        findYamlFiles,
        updatePanelTitle,
        listCodingAgents,
        connectCodingAgent,
        suppressLocalSessionSync,
        pickDefaultCodingAgentId,
        runExternalCellEditWithRetries,
      };

      const TRAIL_OPS = new Set([
        'init', 'ackExternalDrafts', 'persistSessionEntries',
        'janeTrailNew', 'janeTrailFork', 'janeTrailSwitch', 'janeTrailRename', 'janeTrailDelete',
        'exportNotebook',
      ]);
      const AGENT_OPS = new Set([
        'editCellCode', 'abortAgent',
      ]);
      const FILE_OPS = new Set(['readConfig', 'writeConfig', 'exportJson']);
      const KERNEL_OPS = new Set(['executeCell', 'getKernelStatus', 'kernelControl']);

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (TRAIL_OPS.has(msg.type)) return handleTrailOp(msg, handlerCtx);
        if (AGENT_OPS.has(msg.type)) return handleAgentOp(msg, handlerCtx);
        if (FILE_OPS.has(msg.type)) return handleFileOp(msg, handlerCtx);
        if (KERNEL_OPS.has(msg.type)) return handleKernelOp(msg, handlerCtx);
        return handleSettingsOp(msg, handlerCtx);
      }, undefined, context.subscriptions);

    } catch (e) {
      vscode.window.showErrorMessage(`Selva: ${e.message}`);
    }
  });

  context.subscriptions.push(cmd);
}

function deactivate() {
  disposeAllNotebookRuntimes();
}

module.exports = { activate, deactivate };
