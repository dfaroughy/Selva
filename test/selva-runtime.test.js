const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJaneTask } = require('../lib/session-store');
const {
  buildToolSchemas,
  createWorkspaceRuntime,
  loadAllTools,
  resolveWorkspacePath,
} = require('../lib/selva-runtime');
const { disposeNotebookRuntimesForConfigDir } = require('../lib/kernel-manager');

const extensionPath = path.resolve(__dirname, '..');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-runtime-'));
}

function cleanup(dir) {
  try { disposeNotebookRuntimesForConfigDir(dir); } catch {}
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

    createJaneTask(tmpDir);
    const runtime = createWorkspaceRuntime({ configDir: tmpDir, extensionPath });
    const listResult = await runtime.callTool('list_files', {});
    assert.match(listResult, /trainer\.yaml/);

    const readResult = await runtime.callTool('read_config', { file: 'trainer.yaml' });
    assert.match(readResult, /learning_rate/);
    assert.match(readResult, /number/);
    assert.match(readResult, /Structure only/);

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

test('workspace runtime execute_python uses the active Task kernel by default', async () => {
  const tmpDir = mkTmpDir();
  try {
    createJaneTask(tmpDir);
    const runtime = createWorkspaceRuntime({ configDir: tmpDir, extensionPath });

    const first = await runtime.callTool('execute_python', { code: 'x = 55' });
    assert.strictEqual(first, '(no output)');

    const second = await runtime.callTool('execute_python', { code: 'x + 5' });
    assert.strictEqual(second, '60\n');
  } finally {
    cleanup(tmpDir);
  }
});

test('workspace runtime discovers and reads JSON files alongside YAML', async () => {
  const tmpDir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      'model:\n  name: resnet\n  layers: 50\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'params.json'),
      JSON.stringify({ learning_rate: 0.001, batch_size: 32 }, null, 2),
      'utf8'
    );

    createJaneTask(tmpDir);
    const runtime = createWorkspaceRuntime({ configDir: tmpDir, extensionPath });

    // list_files should find both
    const listResult = await runtime.callTool('list_files', {});
    assert.match(listResult, /config\.yaml/);
    assert.match(listResult, /params\.json/);

    // read_config should work for JSON
    const readResult = await runtime.callTool('read_config', { file: 'params.json' });
    assert.match(readResult, /learning_rate/);
    assert.match(readResult, /batch_size/);

    // set_value should work for JSON
    const setResult = await runtime.callTool('set_value', {
      file: 'params.json',
      path: ['learning_rate'],
      value: 0.01,
    });
    assert.match(setResult, /saved to disk/);

    // Verify the JSON file was updated correctly
    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, 'params.json'), 'utf8'));
    assert.strictEqual(updated.learning_rate, 0.01);
    assert.strictEqual(updated.batch_size, 32); // untouched
  } finally {
    cleanup(tmpDir);
  }
});

test('workspace runtime get_file_schema works for JSON files', async () => {
  const tmpDir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'experiment.json'),
      JSON.stringify({
        name: 'run_001',
        hyperparams: { lr: 0.001, dropout: 0.1, epochs: 100 },
        metrics: { accuracy: 0.95, loss: 0.05 },
      }, null, 2),
      'utf8'
    );

    createJaneTask(tmpDir);
    const runtime = createWorkspaceRuntime({ configDir: tmpDir, extensionPath });

    const schemaResult = await runtime.callTool('get_file_schema', { file: 'experiment.json' });
    assert.match(schemaResult, /experiment\.json/);
    assert.match(schemaResult, /hyperparams/);
    assert.match(schemaResult, /metrics/);
    assert.match(schemaResult, /accuracy/);
  } finally {
    cleanup(tmpDir);
  }
});
