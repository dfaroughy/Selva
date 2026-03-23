const fs = require('fs');
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

  const detected = SUPPORTED_CODING_AGENTS
    .filter((agent) => installedExtensions.has(agent.extensionId))
    .map((agent) => {
      const extension = installedExtensions.get(agent.extensionId) || { version: '', extensionPath: '' };
      return {
        ...agent,
        version: extension.version || '',
        extensionPath: extension.extensionPath || '',
      };
    });

  // Always include Claude Code — it may be installed as a CLI without the VS Code extension
  if (!detected.some((a) => a.id === 'claude-code')) {
    const claudeAgent = SUPPORTED_CODING_AGENTS.find((a) => a.id === 'claude-code');
    if (claudeAgent) {
      detected.unshift({ ...claudeAgent, version: '', extensionPath: '' });
    }
  }

  return detected;
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

function readPromptFile(extensionPath, name) {
  try {
    return fs.readFileSync(path.join(extensionPath, 'ecosystem', 'prompts', name), 'utf8').trim();
  } catch {
    return '';
  }
}

function buildCodingAgentConnectPrompt({ agent, initPayload, extensionPath, bitacora, trailInstructions }) {
  const snapshot = initPayload || {};

  // ── Layer 2: Jane's identity ──
  const identity = readPromptFile(extensionPath, 'SYSTEM.md')
    // Strip the {{PLACEHOLDER}} lines — they're for the dead internal agent
    .replace(/\{\{[A-Z_]+\}\}/g, '')
    // Strip the JSON FALLBACK section — Claude has native tool support
    .replace(/─── JSON FALLBACK[\s\S]*?(?=─── |$)/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const toolRules = readPromptFile(extensionPath, 'TOOLS.md');
  const notebookRules = readPromptFile(extensionPath, 'NOTEBOOK.md');
  const pythonRules = readPromptFile(extensionPath, 'PYTHON.md');

  // ── Bitácora ──
  const bitacoraSection = bitacora
    ? `─── BITÁCORA (from previous session) ───\n\n${bitacora}`
    : '';

  // ── Layer 1: MCP protocol ──
  const protocol = [
    `─── SELVA MCP PROTOCOL ───`,
    '',
    `You are connected to workspace: ${snapshot.configDir || '(unknown)'}`,
    `MCP server: "selva"`,
    '',
    'Initialization:',
    '1. Call `jane_init` to get the workspace snapshot (files, dashboard state, trails, bitácora).',
    snapshot.needsBootstrap
      ? '2. Bootstrap needed — classify files, set slider bounds, and write the initial Bitácora.'
      : '2. Session exists — review the bitácora and trail state before acting.',
    '',
    'Selva tools:',
    '- `read_config`, `set_value`, `get_file_schema` — read and edit YAML configs',
    '- `execute_python` — run Python in the stateful Trail kernel',
    '- `jane_add_cells` — add markdown/python cells to the notebook',
    '- `jane_update_cell` — edit or delete existing notebook cells',
    '- `jane_apply_ops` — batch dashboard operations (classify files, lock, pin, set values)',
    '- `jane_trail_new`, `jane_trail_fork`, `jane_trail_switch` — manage Trails',
    '- `propose_tool` — create new reusable tools when no built-in tool fits',
    '',
    'Workspace snapshot:',
    `- trail: "${snapshot.trailName || 'Trail'}" (${snapshot.bootstrapDone ? 'bootstrapped' : 'needs bootstrap'})`,
    `- files: ${snapshot.fileCount || 0} total (${snapshot.configFileCount || 0} config, ${snapshot.dataFileCount || 0} data)`,
    `- panel open: ${snapshot.panelOpen ? 'yes' : 'no'}`,
    `- other trails: ${(snapshot.trailCount || 1) - 1}`,
  ].join('\n');

  // ── Trail Instructions (human → Jane) ──
  const instructionsSection = trailInstructions
    ? `─── TRAIL INSTRUCTIONS (from the researcher) ───\n\n${trailInstructions}`
    : '';

  // ── Assemble ──
  const sections = [
    identity,
    toolRules,
    notebookRules,
    pythonRules,
    instructionsSection,
    bitacoraSection,
    protocol,
  ].filter(Boolean);

  return sections.join('\n\n');
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
