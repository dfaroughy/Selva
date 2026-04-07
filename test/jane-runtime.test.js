const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { disposeNotebookRuntimesForConfigDir } = require('../lib/notebook-execution');
const { createWorkspaceRuntime } = require('../lib/selva-runtime');
const { createJaneRuntime } = require('../lib/jane-runtime');
const { clearJaneSession, createJaneTask, setPanelState } = require('../lib/session-store');

const extensionPath = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-jane-runtime-'));
}

function cleanup(configDir) {
  try { disposeNotebookRuntimesForConfigDir(configDir); } catch {}
  try { clearJaneSession(configDir); } catch {}
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log('\n\x1b[1mJane Runtime\x1b[0m');

test('lists canonical session-oriented Jane tools', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const toolNames = janeRuntime.listSessionTools().map((tool) => tool.name);
    assert.ok(toolNames.includes('jane_init'));
    assert.ok(toolNames.includes('jane_get_instruction_pack'));
    assert.ok(toolNames.includes('jane_task_list'));
    assert.ok(toolNames.includes('jane_task_new'));
    assert.ok(toolNames.includes('jane_task_fork'));
    assert.ok(toolNames.includes('jane_task_switch'));
    assert.ok(toolNames.includes('jane_task_rename'));
    assert.ok(toolNames.includes('jane_apply_ops'));
    assert.ok(toolNames.includes('jane_add_cells'));
    assert.ok(toolNames.includes('jane_update_cell'));
    assert.ok(toolNames.includes('jane_session_run'));
    assert.ok(toolNames.includes('jane_session_get'));
    assert.ok(toolNames.includes('jane_session_record_entry'));
    assert.ok(!toolNames.includes('jane_prompt'));
  } finally {
    cleanup(configDir);
  }
});

test('accepts legacy Jane tool aliases for session settings', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    await janeRuntime.handleSessionToolCall('jane_set_model', { modelId: 'direct:gpt-4o' });
    await janeRuntime.handleSessionToolCall('jane_set_additional_instructions', { text: 'Be precise.' });
    const session = await janeRuntime.handleSessionToolCall('jane_get_session');
    assert.strictEqual(session.agentModelId, 'direct:gpt-4o');
    assert.strictEqual(session.additionalInstructions, 'Be precise.');
    assert.strictEqual(janeRuntime.isSessionTool('jane_prompt'), true);
  } finally {
    cleanup(configDir);
  }
});

test('builds a compact init payload for fresh external agents', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(configDir, 'trainer.yaml'), 'trainer:\n  learning_rate: 0.1\n', 'utf8');
    fs.writeFileSync(path.join(configDir, 'submission.yaml'), 'name: figure\n', 'utf8');
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const init = await janeRuntime.handleSessionToolCall('jane_init');
    assert.strictEqual(init.configDir, configDir);
    assert.strictEqual(init.fileCount, 2);
    assert.strictEqual(init.needsBootstrap, true);
    assert.ok(init.taskId);
    assert.ok(init.taskName);
    assert.ok(Array.isArray(init.tasks));
    assert.strictEqual(init.taskCount, 1);
    assert.ok(Array.isArray(init.availableTools.jane));
    assert.ok(init.availableTools.jane.includes('jane_init'));
    assert.ok(init.availableTools.jane.includes('jane_get_instruction_pack'));
    assert.ok(init.availableTools.jane.includes('jane_task_new'));
    assert.ok(init.availableTools.dashboardOps.includes('setValue'));
    assert.ok(init.availableTools.workspace.some((t) => t.name === 'set_value'));
    assert.ok(init.dashboardState.lockedFieldCount <= 2);
    assert.ok(!init.recommendedFirstCalls.includes('jane_get_instruction_pack'));
  } finally {
    cleanup(configDir);
  }
});

test('jane task tools create and switch fresh notebook lineages', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(configDir, 'trainer.yaml'), 'trainer:\n  learning_rate: 0.1\n', 'utf8');
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    await janeRuntime.handleSessionToolCall('jane_add_cells', {
      question: 'first task note',
      cells: [{ type: 'markdown', content: 'hello' }],
    });
    const originalTaskId = janeRuntime.getSession().taskId;

    const created = await janeRuntime.handleSessionToolCall('jane_task_new', { name: 'Fresh Task' });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.activeTask.name, 'Fresh Task');
    assert.strictEqual(created.needsBootstrap, true);
    assert.strictEqual(janeRuntime.getSession().entries.length, 0);

    const renamed = await janeRuntime.handleSessionToolCall('jane_task_rename', {
      taskId: created.activeTask.id,
      name: 'Renamed Task',
    });
    assert.strictEqual(renamed.ok, true);
    assert.strictEqual(renamed.activeTask.name, 'Renamed Task');

    const switched = await janeRuntime.handleSessionToolCall('jane_task_switch', { taskId: originalTaskId });
    assert.strictEqual(switched.ok, true);
    assert.strictEqual(janeRuntime.getSession().taskId, originalTaskId);
    assert.strictEqual(janeRuntime.getSession().entries.length, 1);
  } finally {
    cleanup(configDir);
  }
});

test('builds a shared Jane instruction pack for external agents', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(configDir, 'trainer.yaml'), 'trainer:\n  learning_rate: 0.1\n', 'utf8');
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    await janeRuntime.handleSessionToolCall('jane_session_set_instructions', { text: 'Keep answers compact.' });
    const pack = await janeRuntime.handleSessionToolCall('jane_get_instruction_pack');
    assert.ok(pack.prompts.additionalInstructions === 'Keep answers compact.' || pack.prompts.bitacora === 'Keep answers compact.');
    assert.ok(pack.prompts.bootstrapPrompt.includes('CLASSIFY FILES'));
    assert.ok(pack.toolCatalog.dashboardOps.some((tool) => tool.name === 'setValue'));
    assert.ok(pack.toolCatalog.workspace.some((tool) => tool.name === 'execute_python'));
    assert.ok(pack.preferredFlow.includes('jane_add_cells'));
    assert.ok(!('context' in pack));
    assert.ok(!('assembledSystemPrompt' in pack.prompts));
    assert.ok(JSON.stringify(pack).length < 20000);
  } finally {
    cleanup(configDir);
  }
});

test('jane_init stays compact even when the session contains many locked fields', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(configDir, 'figure.yaml'),
      'dependent_variables:\n  - header:\n      name: y\n    values:\n      - value: 1\n      - value: 2\n',
      'utf8'
    );
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    await janeRuntime.bootstrapSessionDeterministically();
    const init = await janeRuntime.handleSessionToolCall('jane_init');
    assert.ok(JSON.stringify(init).length < 20000);
    assert.strictEqual(init.dashboardState.lockedFieldCount > 0, true);
    assert.deepStrictEqual(init.dashboardState.dataFiles, ['figure.yaml']);
  } finally {
    cleanup(configDir);
  }
});

test('bootstrap falls back to deterministic workspace setup when no model provider is available', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(configDir, 'trainer.yaml'), 'trainer:\n  learning_rate: 0.1\n', 'utf8');
    fs.writeFileSync(
      path.join(configDir, 'figure.yaml'),
      'dependent_variables:\n  - header:\n      name: y\n    values:\n      - value: 1\n',
      'utf8'
    );
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const result = await janeRuntime.handleSessionToolCall('jane_session_bootstrap', {}, {
      apiKeys: {},
      vscodeApi: {},
    });
    assert.strictEqual(result.error, null);
    assert.ok(result.answer.includes('Initialized Selva'));
    assert.ok(Array.isArray(result.ops));
    assert.ok(result.ops.some((op) => op.fn === 'setFileType'));
    assert.ok(result.ops.some((op) => op.fn === 'lockAllInFile'));
    const sessionSummary = janeRuntime.getSessionSummary();
    assert.strictEqual(sessionSummary.bootstrapDone, true);
    assert.deepStrictEqual(sessionSummary.dashboardState.dataFiles, ['figure.yaml']);
    assert.deepStrictEqual(sessionSummary.dashboardState.configFiles, ['trainer.yaml']);
  } finally {
    cleanup(configDir);
  }
});

test('clears persisted Jane session state through the canonical API', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    await janeRuntime.handleSessionToolCall('jane_session_set_model', { modelId: 'direct:gpt-4o-mini' });
    await janeRuntime.handleSessionToolCall('jane_session_set_instructions', { text: 'Test instructions' });
    await janeRuntime.handleSessionToolCall('jane_session_clear');
    const session = janeRuntime.getSession();
    assert.strictEqual(session.agentModelId, '');
    assert.strictEqual(session.additionalInstructions, '');
    assert.deepStrictEqual(session.entries, []);
  } finally {
    cleanup(configDir);
  }
});

test('records an external notebook entry into the Jane session', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const result = await janeRuntime.handleSessionToolCall('jane_session_record_entry', {
      question: 'plot figure 10',
      answer: 'Here is the explanation.',
      executedCells: [
        {
          code: 'print("hello")',
          output: 'hello',
        },
      ],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.question, 'plot figure 10');
    assert.strictEqual(result.entry.executedCells.length, 1);
    assert.strictEqual(result.entry.cells.length, 2);
    assert.strictEqual(result.entry.cells[0].type, 'markdown');
    assert.strictEqual(result.entry.cells[1].type, 'python');
    const session = janeRuntime.getSession();
    assert.strictEqual(session.entries.length, 1);
    assert.strictEqual(session.entries[0].question, 'plot figure 10');
    assert.strictEqual(session.entries[0].executedCells.length, 1);
    assert.strictEqual(session.entries[0].cells.length, 2);
  } finally {
    cleanup(configDir);
  }
});

test('jane_session_record_entry accepts executedCells passed as a JSON string', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const result = await janeRuntime.handleSessionToolCall('jane_session_record_entry', {
      question: 'stringified executed cells',
      answer: 'Plot explanation.',
      executedCells: JSON.stringify([
        {
          code: '2+3',
          output: '[plot displayed]',
        },
      ]),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.cells.length, 2);
    assert.strictEqual(result.entry.cells[0].type, 'markdown');
    assert.strictEqual(result.entry.cells[1].type, 'python');
    assert.strictEqual(String(result.entry.cells[1].output || '').trim(), '5');
    assert.strictEqual(result.entry.cells[1].runState, 'done');
    assert.strictEqual(result.entry.executedCells.length, 1);
  } finally {
    cleanup(configDir);
  }
});

test('jane_add_cells accepts cells passed as a JSON string', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const result = await janeRuntime.handleSessionToolCall('jane_add_cells', {
      question: 'two cells',
      cells: JSON.stringify([
        { type: 'python', code: 'x = 55', output: '' },
        { type: 'python', code: 'x + 5', output: '' },
      ]),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.cells.length, 2);
    assert.strictEqual(result.entry.cells[0].type, 'python');
    assert.strictEqual(result.entry.cells[1].type, 'python');
  } finally {
    cleanup(configDir);
  }
});

test('jane_apply_ops persists config changes when no panel is open', async () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(configDir, 'trainer.yaml'), 'trainer:\n  learning_rate: 0.2\n', 'utf8');
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    const result = await janeRuntime.handleSessionToolCall('jane_apply_ops', {
      ops: [
        { fn: 'setValue', input: { file: 'trainer.yaml', path: ['trainer', 'learning_rate'], value: 0.075 } },
      ],
    });
    assert.strictEqual(result.ok, true);
    assert.match(fs.readFileSync(path.join(configDir, 'trainer.yaml'), 'utf8'), /learning_rate: 0\.075/);
  } finally {
    cleanup(configDir);
  }
});

test('jane_add_cells and jane_update_cell mutate notebook cells by stable ids', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });
    setPanelState(configDir, { open: true });

    const addResult = await janeRuntime.handleSessionToolCall('jane_add_cells', {
      question: 'plot figure 5',
      cells: [
        { type: 'markdown', content: 'Initial note.' },
        { type: 'python', code: '2+2', output: '4' },
      ],
    });

    assert.strictEqual(addResult.ok, true);
    assert.ok(addResult.entry.id);
    assert.strictEqual(addResult.entry.cells.length, 2);
    assert.ok(addResult.entry.cells[0].id);
    assert.ok(addResult.entry.cells[1].id);

    const updateResult = await janeRuntime.handleSessionToolCall('jane_update_cell', {
      entryId: addResult.entry.id,
      cellId: addResult.entry.cells[1].id,
      patch: {
        code: '3+3',
        output: '6',
      },
    });

    assert.strictEqual(updateResult.ok, true);
    assert.strictEqual(updateResult.entry.cells[1].code, '3+3');
    assert.strictEqual(updateResult.entry.cells[1].output, '6');

    await janeRuntime.handleSessionToolCall('jane_update_cell', {
      entryId: addResult.entry.id,
      cellId: addResult.entry.cells[0].id,
      delete: true,
    });

    const session = janeRuntime.getSession();
    assert.strictEqual(session.entries[0].cells.length, 1);
    assert.strictEqual(session.entries[0].cells[0].code, '3+3');
  } finally {
    cleanup(configDir);
  }
});

test('jane_add_cells auto-executes python notebook cells that arrive without output', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });

    const addResult = await janeRuntime.handleSessionToolCall('jane_add_cells', {
      question: 'compute four',
      cells: [
        { type: 'python', code: '2+2' },
      ],
    });

    assert.strictEqual(addResult.ok, true);
    assert.strictEqual(addResult.entry.cells.length, 1);
    assert.strictEqual(addResult.entry.cells[0].type, 'python');
    assert.strictEqual(String(addResult.entry.cells[0].output || '').trim(), '4');
    assert.strictEqual(addResult.entry.cells[0].runState, 'done');
  } finally {
    cleanup(configDir);
  }
});

test('jane_session_record_entry re-executes python cells when output is only a plot placeholder', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });

    const result = await janeRuntime.handleSessionToolCall('jane_session_record_entry', {
      question: 'plot placeholder',
      answer: 'Plot explanation.',
      executedCells: [
        {
          code: '2+2',
          output: '[plot]',
        },
      ],
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.cells.length, 2);
    assert.strictEqual(result.entry.cells[1].type, 'python');
    assert.strictEqual(String(result.entry.cells[1].output || '').trim(), '4');
    assert.strictEqual(result.entry.cells[1].runState, 'done');
  } finally {
    cleanup(configDir);
  }
});

test('jane_session_record_entry re-executes python cells when output is [plot generated]', async () => {
  const configDir = mkTmpDir();
  try {
    createJaneTask(configDir);
    const workspaceRuntime = createWorkspaceRuntime({ configDir, extensionPath });
    const janeRuntime = createJaneRuntime({ configDir, extensionPath, workspaceRuntime });

    const result = await janeRuntime.handleSessionToolCall('jane_session_record_entry', {
      question: 'plot generated placeholder',
      answer: 'Plot explanation.',
      executedCells: [
        {
          code: '2+2',
          output: '[plot generated]',
        },
      ],
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.cells.length, 2);
    assert.strictEqual(result.entry.cells[1].type, 'python');
    assert.strictEqual(String(result.entry.cells[1].output || '').trim(), '4');
    assert.strictEqual(result.entry.cells[1].runState, 'done');
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
