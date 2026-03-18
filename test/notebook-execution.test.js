const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  executeNotebookCell,
  disposeNotebookRuntimesForConfigDir,
} = require('../lib/notebook-execution');

const extensionPath = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-notebook-exec-'));
}

function cleanup(configDir) {
  try {
    disposeNotebookRuntimesForConfigDir(configDir);
  } catch {}
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log('\n\x1b[1mNotebook Execution\x1b[0m');

test('python notebook execution preserves state within the same trail kernel', async () => {
  const configDir = mkTmpDir();
  try {
    const first = await executeNotebookCell({
      language: 'python',
      code: 'value = 2',
      configDir,
      extensionPath,
      trailId: 'trail_a',
    });
    assert.strictEqual(String(first).trim(), '(no output)');

    const second = await executeNotebookCell({
      language: 'python',
      code: 'value + 3',
      configDir,
      extensionPath,
      trailId: 'trail_a',
    });
    assert.strictEqual(String(second).trim(), '5');
  } finally {
    cleanup(configDir);
  }
});

test('python notebook execution isolates state between trails', async () => {
  const configDir = mkTmpDir();
  try {
    await executeNotebookCell({
      language: 'python',
      code: 'shared_value = 9',
      configDir,
      extensionPath,
      trailId: 'trail_one',
    });

    const isolated = await executeNotebookCell({
      language: 'python',
      code: "'shared_value' in globals()",
      configDir,
      extensionPath,
      trailId: 'trail_two',
    });
    assert.strictEqual(String(isolated).trim(), 'False');
  } finally {
    cleanup(configDir);
  }
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
