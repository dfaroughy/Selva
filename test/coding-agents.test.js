const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  sanitizeCellEditOutput,
} = require('../lib/coding-agents');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

console.log('\n\x1b[1mCoding Agents\x1b[0m');

test('detects installed supported coding agents from extensions', () => {
  const agents = detectCodingAgents({
    extensions: [
      { id: 'openai.chatgpt', version: '26.313.41036', extensionPath: '/tmp/codex' },
      { id: 'Anthropic.claude-code', version: '2.1.76', extensionPath: '/tmp/claude' },
    ],
  });

  assert.strictEqual(agents.length, 2);
  assert.strictEqual(agents[0].id, 'claude-code');
  assert.strictEqual(agents[1].id, 'codex');
  assert.strictEqual(agents[0].version, '2.1.76');
  assert.strictEqual(agents[1].version, '26.313.41036');
});

test('detects Codex from the installed extension even without VS Code commands', () => {
  const agents = detectCodingAgents({
    extensions: [
      { id: 'openai.chatgpt', version: '26.313.41036', extensionPath: '/tmp/codex' },
    ],
  });

  assert.strictEqual(agents.length, 2);
  assert.strictEqual(agents[0].id, 'claude-code');
  assert.strictEqual(agents[1].id, 'codex');
});

test('prefers Claude Code as the default coding agent when available', () => {
  const id = pickDefaultCodingAgentId([
    { id: 'codex' },
    { id: 'claude-code' },
  ]);
  assert.strictEqual(id, 'claude-code');
});

test('picks a fast cell debugger model for supported agents', () => {
  assert.strictEqual(pickCellDebuggerModel('claude-code'), 'sonnet');
  assert.strictEqual(pickCellDebuggerModel('codex'), 'gpt-5.4-mini');
});

test('builds a Selva connect prompt with Jane identity and MCP protocol', () => {
  const prompt = buildCodingAgentConnectPrompt({
    agent: { label: 'Claude Code' },
    initPayload: {
      configDir: '/tmp/workspace',
      sessionId: 'abc123',
      panelOpen: true,
      bootstrapDone: false,
      needsBootstrap: true,
      fileCount: 10,
      configFileCount: 7,
      dataFileCount: 3,
      trailName: 'Test Trail',
      trailCount: 2,
    },
    extensionPath: path.join(__dirname, '..'),
    bitacora: 'ML project studying convergence.',
  });

  // Identity from SYSTEM.md
  assert.ok(prompt.includes('Agentic Research Collaborator'));
  assert.ok(prompt.includes('COLLABORATION CHANNELS'));
  assert.ok(prompt.includes('RESEARCH DISPOSITION'));
  assert.ok(prompt.includes('RESEARCH PROJECT'));
  // Tool rules from TOOLS.md
  assert.ok(prompt.includes('TOOL RULES'));
  // Bitácora injected
  assert.ok(prompt.includes('ML project studying convergence'));
  // MCP protocol
  assert.ok(prompt.includes('jane_init'));
  assert.ok(prompt.includes('jane_add_cells'));
  assert.ok(prompt.includes('execute_python'));
  assert.ok(prompt.includes('/tmp/workspace'));
  assert.ok(prompt.includes('needs bootstrap'));
});

test('builds a project Codex config that points at the Selva MCP server', () => {
  const config = buildCodexProjectConfig({
    command: '/opt/homebrew/bin/node',
    args: ['/tmp/mcp-server.js', '/tmp/workspace'],
  });

  assert.ok(config.includes('[mcp_servers.selva]'));
  assert.ok(config.includes('/opt/homebrew/bin/node'));
  assert.ok(config.includes('/tmp/mcp-server.js'));
  assert.ok(config.includes('/tmp/workspace'));
});

test('builds a cell edit prompt with code, output, and retry context', () => {
  const systemPrompt = buildCellEditSystemPrompt({ sessionInstructions: 'Keep answers compact.' });
  const userPrompt = buildCellEditUserPrompt({
    instruction: 'Fix the plotting bug.',
    code: 'print("hello")',
    output: 'Error (exit 1):\nNameError: name x is not defined',
    attempt: 2,
    maxAttempts: 3,
  });

  assert.strictEqual(CELL_EDIT_RESULT_SCHEMA.required[0], 'code');
  assert.ok(systemPrompt.includes('Jane\'s Python notebook cell editor'));
  assert.ok(systemPrompt.includes('Keep answers compact.'));
  assert.ok(userPrompt.includes('Fix the plotting bug.'));
  assert.ok(userPrompt.includes('Repair attempt 2 of 3.'));
  assert.ok(userPrompt.includes('Current cell output:'));
  assert.ok(userPrompt.includes('NameError'));
});

test('sanitizes raw IMG output before building a cell edit prompt', () => {
  const sanitized = sanitizeCellEditOutput([
    'Error (exit 1):',
    'Traceback (most recent call last):',
    'NameError: name plt is not defined',
    'IMG:' + 'a'.repeat(5000),
    'IMG:' + 'b'.repeat(5000),
  ].join('\n'));

  assert.ok(sanitized.includes('NameError: name plt is not defined'));
  assert.ok(sanitized.includes('[2 plot image output omitted]'));
  assert.ok(!sanitized.includes('IMG:aaaa'));

  const userPrompt = buildCellEditUserPrompt({
    instruction: 'find the bug and fix',
    code: 'print(1)',
    output: [
      'Error (exit 1):',
      'Traceback (most recent call last):',
      'NameError: name plt is not defined',
      'IMG:' + 'c'.repeat(5000),
    ].join('\n'),
    attempt: 1,
    maxAttempts: 3,
  });

  assert.ok(userPrompt.includes('[1 plot image output omitted]'));
  assert.ok(!userPrompt.includes('IMG:cccc'));
});

test('detects execution errors from Selva cell output', () => {
  assert.strictEqual(looksLikeCellExecutionError('Error (exit 1):\nTraceback (most recent call last):'), true);
  assert.strictEqual(looksLikeCellExecutionError('Execution error: timeout'), true);
  assert.strictEqual(looksLikeCellExecutionError('all good\n(no output)'), false);
});

test('parses structured and fenced cell edit results', () => {
  assert.deepStrictEqual(
    parseCellEditAgentResponse('{"code":"print(1)"}'),
    { code: 'print(1)' }
  );
  assert.deepStrictEqual(
    parseCellEditAgentResponse('{"structured_output":{"code":"print(3)"}}'),
    { code: 'print(3)' }
  );
  assert.deepStrictEqual(
    parseCellEditAgentResponse('```python\nprint(2)\n```'),
    { code: 'print(2)' }
  );
});

test('builds a workspace .mcp.json payload that preserves other servers', () => {
  const config = buildWorkspaceMcpConfig({
    command: '/opt/homebrew/bin/node',
    args: ['/tmp/mcp-server.js', '/tmp/workspace'],
    currentConfig: {
      projectName: 'demo',
      mcpServers: {
        other: {
          command: '/usr/bin/env',
          args: ['python'],
        },
      },
    },
  });

  const parsed = JSON.parse(config);
  assert.strictEqual(parsed.projectName, 'demo');
  assert.deepStrictEqual(parsed.mcpServers.other, {
    command: '/usr/bin/env',
    args: ['python'],
  });
  assert.deepStrictEqual(parsed.mcpServers.selva, {
    command: '/opt/homebrew/bin/node',
    args: ['/tmp/mcp-server.js', '/tmp/workspace'],
  });
});

test('resolves agent binaries from extension-relative paths', () => {
  // Find an actually installed Claude Code extension
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  let claudeExt = '';
  try {
    const entries = fs.readdirSync(extDir);
    claudeExt = entries.find((e) => e.startsWith('anthropic.claude-code-')) || '';
  } catch {}
  if (!claudeExt) {
    // Skip if not installed — test is environment-dependent
    return;
  }
  const claude = resolveAgentBinaryPath({
    extensionPath: path.join(extDir, claudeExt),
    binaryRelativePaths: ['resources/native-binary/claude'],
  });
  assert.ok(claude.endsWith('/resources/native-binary/claude'));
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) process.exit(1);
})();
