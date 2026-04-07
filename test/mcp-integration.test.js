const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-mcp-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Spawn the MCP server and communicate via JSON-RPC over stdio.
function spawnMcpServer(configDir) {
  const serverPath = path.resolve(__dirname, '..', 'mcp-server.js');
  const child = spawn(process.execPath, [serverPath, configDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const id = msg.id != null ? String(msg.id) : null;
    if (id && pending.has(id)) {
      const { resolve } = pending.get(id);
      pending.delete(id);
      resolve(msg);
    }
  });

  function send(method, params = {}) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(payload + '\n');
    });
  }

  function kill() {
    try { child.kill('SIGTERM'); } catch {}
    rl.close();
  }

  return { send, kill, child };
}

// ── Tests ──────────────────────────────────────────────────

test('MCP server starts and responds to initialize', async () => {
  const configDir = createTmpDir();
  fs.writeFileSync(path.join(configDir, 'test.yaml'), 'learning_rate: 0.01\nepochs: 10\n', 'utf8');

  const server = spawnMcpServer(configDir);
  try {
    const initResult = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    assert.ok(initResult.result, 'initialize should return a result');
    assert.ok(initResult.result.capabilities, 'should have capabilities');

    // Send initialized notification (no response expected)
    server.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
  } finally {
    server.kill();
    cleanup(configDir);
  }
});

test('MCP server lists tools including workspace and Jane tools', async () => {
  const configDir = createTmpDir();
  fs.writeFileSync(path.join(configDir, 'config.yaml'), 'x: 1\n', 'utf8');

  const server = spawnMcpServer(configDir);
  try {
    await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    server.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    const toolsResult = await server.send('tools/list', {});
    assert.ok(toolsResult.result, 'tools/list should return a result');
    const toolNames = toolsResult.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('list_files'), 'should include list_files');
    assert.ok(toolNames.includes('read_config'), 'should include read_config');
    assert.ok(toolNames.includes('set_value'), 'should include set_value');
    assert.ok(toolNames.includes('jane_init'), 'should include jane_init');
    assert.ok(toolNames.includes('jane_task_list'), 'should include jane_task_list');
  } finally {
    server.kill();
    cleanup(configDir);
  }
});

test('MCP server calls list_files and returns YAML files', async () => {
  const configDir = createTmpDir();
  fs.writeFileSync(path.join(configDir, 'params.yaml'), 'lr: 0.001\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'data.yml'), 'rows: 100\n', 'utf8');

  const server = spawnMcpServer(configDir);
  try {
    await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    server.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    const callResult = await server.send('tools/call', {
      name: 'list_files',
      arguments: {},
    });
    assert.ok(callResult.result, 'tools/call should return a result');
    const text = callResult.result.content[0].text;
    assert.ok(text.includes('params.yaml'), 'should list params.yaml');
    assert.ok(text.includes('data.yml'), 'should list data.yml');
  } finally {
    server.kill();
    cleanup(configDir);
  }
});

test('MCP server calls set_value and modifies YAML on disk', async () => {
  const configDir = createTmpDir();
  const yamlPath = path.join(configDir, 'config.yaml');
  fs.writeFileSync(yamlPath, 'learning_rate: 0.01\nepochs: 10\n', 'utf8');

  const server = spawnMcpServer(configDir);
  try {
    await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    server.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    const callResult = await server.send('tools/call', {
      name: 'set_value',
      arguments: {
        file: 'config.yaml',
        path: ['learning_rate'],
        value: 0.05,
      },
    });
    assert.ok(callResult.result, 'tools/call should return a result');
    const text = callResult.result.content[0].text;
    assert.ok(text.includes('0.05'), 'response should confirm new value');

    // Verify on disk
    const updated = fs.readFileSync(yamlPath, 'utf8');
    assert.ok(updated.includes('0.05'), 'YAML file should contain 0.05');
    assert.ok(!updated.includes('0.01'), 'YAML file should no longer contain 0.01');
  } finally {
    server.kill();
    cleanup(configDir);
  }
});

// ── Runner ─────────────────────────────────────────────────

(async () => {
  console.log('\n\x1b[1mMCP Integration\x1b[0m');
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
  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) process.exit(1);
})();
