const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildToolSchemas,
  createWorkspaceRuntime,
  loadAllTools,
  resolveWorkspacePath,
} = require('../lib/selva-runtime');

const extensionPath = path.resolve(__dirname, '..');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-runtime-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack}\n`);
    process.exitCode = 1;
  }
}

test('loadAllTools returns built-in tool metadata', () => {
  const tools = loadAllTools(extensionPath);
  assert.ok(tools.some((tool) => tool.name === 'execute_python'));
  assert.ok(tools.some((tool) => tool.name === 'setValue'));
  const schemas = buildToolSchemas(tools);
  assert.ok(schemas.some((tool) => tool.name === 'execute_python'));
});

test('resolveWorkspacePath blocks traversal outside workspace', () => {
  const tmpDir = mkTmpDir();
  try {
    const nested = resolveWorkspacePath(tmpDir, 'configs/example.yaml');
    assert.ok(nested.startsWith(tmpDir));
    assert.throws(() => resolveWorkspacePath(tmpDir, '../escape.yaml'), /Path traversal blocked/);
  } finally {
    cleanup(tmpDir);
  }
});

test('workspace runtime can list, read, and update YAML via MCP-style tools', async () => {
  const tmpDir = mkTmpDir();
  try {
    const yamlPath = path.join(tmpDir, 'trainer.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'trainer:',
        '  learning_rate: 0.001',
        '  max_epochs: 200',
        '',
      ].join('\n'),
      'utf8'
    );

    const runtime = createWorkspaceRuntime({ configDir: tmpDir, extensionPath });
    const listResult = await runtime.callTool('list_files', {});
    assert.match(listResult, /trainer\.yaml/);

    const readResult = await runtime.callTool('read_config', { file: 'trainer.yaml' });
    assert.match(readResult, /learning_rate/);
    assert.match(readResult, /0\.001/);

    const setResult = await runtime.callTool('set_value', {
      file: 'trainer.yaml',
      path: ['trainer', 'learning_rate'],
      value: 0.01,
    });
    assert.match(setResult, /saved to disk/);

    const updated = fs.readFileSync(yamlPath, 'utf8');
    assert.match(updated, /learning_rate: 0\.01/);
  } finally {
    cleanup(tmpDir);
  }
});
