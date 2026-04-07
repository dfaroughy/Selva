const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const executePythonTool = require('../ecosystem/tools/execute_python/tool');
const { disposeNotebookRuntimesForConfigDir } = require('../lib/kernel-manager');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-execute-python-tool-'));
}

function cleanup(configDir) {
  try { disposeNotebookRuntimesForConfigDir(configDir); } catch {}
  fs.rmSync(configDir, { recursive: true, force: true });
}

async function runTest(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

(async () => {
  await runTest('execute_python uses the kernel for plain code when taskId is present', async () => {
    const configDir = mkTmpDir();
    try {
      const context = {
        configDir,
        taskId: 'task-a',
        execFileAsync: async () => {
          throw new Error('one-shot fallback should not be used');
        },
      };

      const first = await executePythonTool({ code: 'value = 7' }, context);
      assert.strictEqual(first, '(no output)');

      const second = await executePythonTool({ code: 'value + 5' }, context);
      assert.strictEqual(second, '12\n');
    } finally {
      cleanup(configDir);
    }
  });

  await runTest('execute_python falls back to one-shot when input_data is provided', async () => {
    const configDir = mkTmpDir();
    try {
      let fallbackCalls = 0;
      const result = await executePythonTool(
        { code: 'print("ignored")', input_data: { x: 1 } },
        {
          configDir,
          taskId: 'task-a',
          execFileAsync: async (command, args, options) => {
            fallbackCalls += 1;
            assert.strictEqual(command, 'python3');
            assert.deepStrictEqual(args, ['-c', 'print("ignored")']);
            assert.strictEqual(options.cwd, configDir);
            assert.strictEqual(options.input, JSON.stringify({ x: 1 }));
            return { stdout: 'fallback ok', stderr: '' };
          },
        }
      );
      assert.strictEqual(result, 'fallback ok');
      assert.strictEqual(fallbackCalls, 1);
    } finally {
      cleanup(configDir);
    }
  });
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
