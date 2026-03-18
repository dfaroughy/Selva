const path = require('path');

const CELL_EDIT_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    code: { type: 'string' },
  },
  required: ['code'],
  additionalProperties: false,
});

const SUPPORTED_CODING_AGENTS = Object.freeze([
  {
    id: 'claude-code',
    label: 'Claude Code',
    extensionId: 'anthropic.claude-code',
    promptMode: 'inline',
    launchMode: 'terminal',
    binaryRelativePaths: ['resources/native-binary/claude'],
    description: 'Launch Claude Code CLI in an integrated terminal with the Selva startup prompt.',
  },
  {
    id: 'codex',
    label: 'Codex',
    extensionId: 'openai.chatgpt',
    promptMode: 'inline',
    launchMode: 'terminal',
    binaryRelativePaths: [
      'bin/macos-aarch64/codex',
      'bin/macos-x64/codex',
      'bin/linux-x64/codex',
      'bin/linux-arm64/codex',
      'bin/win32-x64/codex.exe',
      'bin/win32-arm64/codex.exe',
    ],
    experimental: true,
    description: 'Launch Codex CLI in an integrated terminal with the Selva startup prompt.',
  },
]);

const CELL_EDIT_OUTPUT_CHAR_LIMIT = 12000;

function normalizeExtensionRecord(record) {
  if (!record) return { id: '', version: '' };
  if (typeof record === 'string') return { id: String(record).toLowerCase(), version: '' };
  const packageVersion = record.packageJSON && record.packageJSON.version ? record.packageJSON.version : '';
  return {
    id: String(record.id || '').toLowerCase(),
    version: String(record.version || packageVersion || ''),
    extensionPath: String(record.extensionPath || ''),
  };
}

function detectCodingAgents({ extensions = [] } = {}) {
  const installedExtensions = new Map();
  for (const record of extensions) {
    const normalized = normalizeExtensionRecord(record);
    if (!normalized.id) continue;
    installedExtensions.set(normalized.id, normalized);
  }

  return SUPPORTED_CODING_AGENTS
    .filter((agent) => installedExtensions.has(agent.extensionId))
    .map((agent) => {
      const extension = installedExtensions.get(agent.extensionId) || { version: '', extensionPath: '' };
      return {
        ...agent,
        version: extension.version || '',
        extensionPath: extension.extensionPath || '',
      };
    });
}

function pickDefaultCodingAgentId(agents = []) {
  if (!Array.isArray(agents) || agents.length === 0) return '';
  const preferredOrder = ['claude-code', 'codex'];
  for (const id of preferredOrder) {
    if (agents.some((agent) => agent.id === id)) return id;
  }
  return agents[0].id || '';
}

function pickCellDebuggerModel(agentId) {
  const id = String(agentId || '').trim().toLowerCase();
  if (id === 'claude-code') return 'sonnet';
  if (id === 'codex') return 'gpt-5.4-mini';
  return '';
}

function resolveAgentBinaryPath(agent) {
  if (!agent || !agent.extensionPath) return '';
  for (const relPath of agent.binaryRelativePaths || []) {
    const candidate = path.join(agent.extensionPath, relPath);
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch {
      // ignore missing binaries and continue scanning
    }
  }
  return '';
}

function buildCodexProjectConfig({ command, args = [] }) {
  return [
    '# Managed by Selva',
    '[mcp_servers.selva]',
    `command = ${JSON.stringify(String(command || 'node'))}`,
    `args = [${args.map((arg) => JSON.stringify(String(arg || ''))).join(', ')}]`,
    '',
  ].join('\n');
}

function buildWorkspaceMcpConfig({ command, args = [], currentConfig = {} }) {
  const normalizedCurrent = currentConfig && typeof currentConfig === 'object' && !Array.isArray(currentConfig)
    ? { ...currentConfig }
    : {};
  const currentServers = normalizedCurrent.mcpServers
    && typeof normalizedCurrent.mcpServers === 'object'
    && !Array.isArray(normalizedCurrent.mcpServers)
    ? { ...normalizedCurrent.mcpServers }
    : {};

  currentServers.selva = {
    command: String(command || '/opt/homebrew/bin/node'),
    args: Array.isArray(args) ? args.map((arg) => String(arg || '')) : [],
  };

  normalizedCurrent.mcpServers = currentServers;
  return JSON.stringify(normalizedCurrent, null, 2) + '\n';
}

function buildCodingAgentConnectPrompt({ agent, initPayload }) {
  const launchLabel = agent && agent.label ? agent.label : 'coding agent';
  const snapshot = initPayload || {};
  const lines = [
    `You are connecting to Selva as ${launchLabel}.`,
    `Use the MCP server named "selva" for workspace ${snapshot.configDir || '(unknown workspace)'}.`,
    '',
    'Initialization protocol:',
    '1. Call `jane_init` first.',
    '2. Call `jane_get_instruction_pack` next and follow it as the shared Jane contract for this workspace.',
    snapshot.needsBootstrap
      ? '3. If `jane_init` reports `needsBootstrap=true`, call `jane_session_bootstrap` before any other work.'
      : '3. Hydrate from the existing Jane session before taking action.',
    '4. Keep Selva as the source of truth for notebook cells, dashboard state, and staged YAML edits.',
    '5. Prefer Selva/Jane operations over direct filesystem edits when the Selva panel is open.',
    '6. Use `jane_apply_ops` for structured dashboard/config changes, and use `jane_add_cells` / `jane_update_cell` for notebook-visible markdown/python cells.',
    '7. For simple deterministic work like reading configs or running Python, use the Selva workspace tools directly (`read_config`, `set_value`, `get_file_schema`, `execute_python`).',
    '8. Only use `jane_session_run` when Selva has an internal Jane model configured. Otherwise you are Jane and should act through the MCP tools yourself.',
    '',
    'Current Selva snapshot:',
    `- session id: ${snapshot.sessionId || '(unknown)'}`,
    `- panel open: ${snapshot.panelOpen ? 'yes' : 'no'}`,
    `- bootstrap done: ${snapshot.bootstrapDone ? 'yes' : 'no'}`,
    `- files: ${snapshot.fileCount || 0} total (${snapshot.configFileCount || 0} config, ${snapshot.dataFileCount || 0} data)`,
    `- active config file: ${snapshot.activeConfigFile || '(none)'}`,
    `- active data file: ${snapshot.activeDataFile || '(none)'}`,
    `- pending drafts: ${snapshot.pendingDraftCount || 0}`,
    '',
    'After initialization, briefly confirm the workspace state and wait for the next Selva task unless the launch request already includes one.',
  ];

  return lines.join('\n');
}

function buildCellEditSystemPrompt({ sessionInstructions = '' } = {}) {
  const lines = [
    'You are Jane\'s Python notebook cell editor inside Selva.',
    'Edit only the provided Python cell code.',
    'Use the instruction and any provided cell output to improve the code.',
    'If the output contains an exception or traceback, repair the code so it runs successfully.',
    'For matplotlib notebook cells, Selva captures figures automatically.',
    'Do not print IMG:... or base64 image payloads yourself unless the user explicitly asks for that raw output format.',
    'Do not call plt.savefig(...) unless the user explicitly wants an image file saved to disk.',
    'Do not explain your work.',
    'Return only a JSON object with one string field named "code".',
  ];

  const extra = String(sessionInstructions || '').trim();
  if (extra) {
    lines.push('', 'Additional Selva session instructions:', extra);
  }

  return lines.join('\n');
}

function sanitizeCellEditOutput(output) {
  const raw = String(output || '').trim();
  if (!raw) return '';

  const ansiStripped = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = ansiStripped.split(/\r?\n/);
  const kept = [];
  let imageCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^IMG:[A-Za-z0-9+/=]+$/.test(trimmed)) {
      imageCount += 1;
      continue;
    }
    kept.push(line);
  }

  let sanitized = kept.join('\n').trim();
  if (imageCount > 0) {
    const summary = `[${imageCount} plot image output omitted]`;
    sanitized = sanitized ? `${sanitized}\n\n${summary}` : summary;
  }

  if (sanitized.length <= CELL_EDIT_OUTPUT_CHAR_LIMIT) return sanitized;

  const head = sanitized.slice(0, 7000).trimEnd();
  const tail = sanitized.slice(-3500).trimStart();
  return `${head}\n\n...[cell output truncated]...\n\n${tail}`;
}

function buildCellEditUserPrompt({
  instruction = '',
  code = '',
  output = '',
  attempt = 1,
  maxAttempts = 1,
} = {}) {
  const lines = [
    `Cell edit instruction: ${String(instruction || '').trim() || 'Improve this Python cell.'}`,
    '',
    `Repair attempt ${attempt} of ${maxAttempts}.`,
    '',
    'Current Python cell:',
    '```python',
    String(code || ''),
    '```',
  ];

  const outputText = sanitizeCellEditOutput(output);
  if (outputText) {
    lines.push(
      '',
      'Current cell output:',
      '```text',
      outputText,
      '```'
    );
  }

  lines.push(
    '',
    'Return JSON only and ensure the "code" field contains the full replacement Python cell.'
  );

  return lines.join('\n');
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|python)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function parseCellEditAgentResponse(raw) {
  const text = String(raw || '').trim();
  if (!text) return { code: '' };

  const normalized = stripCodeFence(text);
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed.code === 'string') {
      return { code: parsed.code };
    }
    if (parsed && parsed.structured_output && typeof parsed.structured_output.code === 'string') {
      return { code: parsed.structured_output.code };
    }
    if (parsed && typeof parsed.result === 'string' && parsed.result.trim()) {
      return { code: stripCodeFence(parsed.result) };
    }
  } catch {
    // Fall through to raw-code parsing.
  }

  return { code: stripCodeFence(text) };
}

function looksLikeCellExecutionError(output) {
  const text = String(output || '').trim();
  if (!text) return false;
  return /^Error \(exit\s+\d+\):/i.test(text)
    || /^Execution error:/i.test(text)
    || /Traceback \(most recent call last\):/i.test(text)
    || /\b(?:SyntaxError|NameError|TypeError|ValueError|IndexError|KeyError|ModuleNotFoundError|ImportError|AttributeError|RuntimeError)\b/.test(text);
}

module.exports = {
  CELL_EDIT_RESULT_SCHEMA,
  SUPPORTED_CODING_AGENTS,
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
  sanitizeCellEditOutput,
};
