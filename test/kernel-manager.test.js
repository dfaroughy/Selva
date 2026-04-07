const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { NotebookKernelManager } = require('../lib/kernel-manager');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-kernel-manager-'));
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

console.log('\n\x1b[1mKernel Manager\x1b[0m');

test('restart clears python kernel state for a task', async () => {
  const manager = new NotebookKernelManager();
  const configDir = mkTmpDir();
  const request = { language: 'python', configDir, taskId: 'task_restart' };
  try {
    await manager.execute({ ...request, code: 'value = 11' });
    const restart = await manager.restart(request);
    assert.strictEqual(restart.ok, true);
    assert.strictEqual(restart.status.state, 'idle');

    const result = await manager.execute({
      ...request,
      code: "'value' in globals()",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(String(result.stdout || '').trim(), 'False');
  } finally {
    manager.disposeAll();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('interrupt stops a long-running python cell and keeps the kernel usable', async () => {
  const manager = new NotebookKernelManager();
  const configDir = mkTmpDir();
  const request = { language: 'python', configDir, taskId: 'task_interrupt' };
  try {
    const pending = manager.execute({
      ...request,
      code: 'import time\ntime.sleep(10)\nprint("done")',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const interrupt = await manager.interrupt(request);
    assert.strictEqual(interrupt.ok, true);

    const response = await withTimeout(pending, 3000, 'kernel interrupt');
    assert.strictEqual(response.ok, false);
    assert.match(String(response.stderr || ''), /KeyboardInterrupt/);

    const followUp = await manager.execute({
      ...request,
      code: '21 + 21',
    });
    assert.strictEqual(followUp.ok, true);
    assert.strictEqual(String(followUp.stdout || '').trim(), '42');
  } finally {
    manager.disposeAll();
    fs.rmSync(configDir, { recursive: true, force: true });
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
