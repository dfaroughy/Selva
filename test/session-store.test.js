const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkspaceRuntime } = require('../lib/selva-runtime');
const { applyWebviewOpsToSession } = require('../lib/backend-ops');
const {
  acknowledgeExternalDrafts,
  clearJaneSession,
  createJaneTrail,
  enqueueExternalDraft,
  getActiveTrail,
  getSessionPath,
  hasOpenPanelSession,
  listJaneTrails,
  loadJaneSession,
  renameJaneTrail,
  replaceJaneEntries,
  setPanelState,
  switchJaneTrail,
  updateJaneSession,
} = require('../lib/session-store');

const extensionPath = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selva-session-'));
}

function legacySessionPathForConfigDir(configDir) {
  const workspaceId = crypto
    .createHash('sha1')
    .update(String(configDir))
    .digest('hex');
  return path.join(os.homedir(), '.selva', 'sessions', `${workspaceId}.json`);
}

function cleanup(configDir) {
  try {
    fs.rmSync(legacySessionPathForConfigDir(configDir), { force: true });
  } catch {}
  try { clearJaneSession(configDir); } catch {}
  fs.rmSync(configDir, { recursive: true, force: true });
}

// Helper: create a trail on a fresh workspace (since no auto-creation)
function ensureTestTrail(configDir, name) {
  return createJaneTrail(configDir, { name: name || '' });
}

console.log('\n\x1b[1mSession Store\x1b[0m');

test('session store persists model and additional instructions', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir);
    updateJaneSession(configDir, (session) => {
      session.agentModelId = 'direct:gpt-4o';
      session.additionalInstructions = 'Be precise.';
      return session;
    });
    const reloaded = loadJaneSession(configDir);
    assert.strictEqual(reloaded.agentModelId, 'direct:gpt-4o');
    assert.strictEqual(reloaded.additionalInstructions, 'Be precise.');
    assert.ok(fs.existsSync(getSessionPath(configDir)));
  } finally {
    cleanup(configDir);
  }
});

test('session store persists workspace trails as .svnb files and can switch between them', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir, 'First Trail');
    updateJaneSession(configDir, (session) => {
      session.agentModelId = 'direct:gpt-4o';
      session.additionalInstructions = 'Keep answers compact.';
      session.entries.push({ question: 'first', answer: 'hello' });
      return session;
    });

    const initialTrail = getActiveTrail(configDir);
    assert.ok(initialTrail);
    assert.ok(initialTrail.path.endsWith('.svnb'));
    assert.strictEqual(initialTrail.name, 'First Trail');
    assert.match(initialTrail.id, /^[A-Za-z]+_[A-Za-z]+_[a-f0-9]{16}$/);
    assert.strictEqual(listJaneTrails(configDir).length, 1);

    const created = createJaneTrail(configDir, { name: 'Clean Slate' });
    assert.strictEqual(created.trail.name, 'Clean Slate');
    assert.match(created.trail.id, /^[A-Za-z]+_[A-Za-z]+_[a-f0-9]{16}$/);
    assert.strictEqual(created.session.entries.length, 0);
    assert.strictEqual(created.session.bootstrap.done, false);
    assert.strictEqual(created.session.agentModelId, 'direct:gpt-4o');
    assert.strictEqual(created.session.additionalInstructions, 'Keep answers compact.');
    assert.strictEqual(listJaneTrails(configDir).length, 2);
    assert.strictEqual(getActiveTrail(configDir).id, created.trail.id);

    const switched = switchJaneTrail(configDir, initialTrail.id);
    assert.strictEqual(switched.trail.id, initialTrail.id);
    assert.strictEqual(loadJaneSession(configDir).entries.length, 1);
    assert.strictEqual(loadJaneSession(configDir).entries[0].question, 'first');
  } finally {
    cleanup(configDir);
  }
});

test('default Trail ids use bigram_hex format independent of trail name', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir);
    const trail = getActiveTrail(configDir);
    assert.ok(trail);
    assert.match(trail.name, /^[A-Za-z]+ [A-Za-z]+(?: \d+)?$/);
    // ID is Bigram_Bigram_hex (independent of trail name)
    assert.match(trail.id, /^[A-Za-z]+_[A-Za-z]+_[a-f0-9]{16}$/);
  } finally {
    cleanup(configDir);
  }
});

test('empty project returns empty session with no trails on disk', () => {
  const configDir = mkTmpDir();
  try {
    const session = loadJaneSession(configDir);
    assert.strictEqual(session.entries.length, 0);
    assert.strictEqual(listJaneTrails(configDir).length, 0);
    assert.strictEqual(getActiveTrail(configDir), null);
  } finally {
    cleanup(configDir);
  }
});

test('session store can auto-name and rename Trails without collisions', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir);
    const initial = getActiveTrail(configDir);
    assert.ok(initial.name);

    const created = createJaneTrail(configDir, {});
    assert.ok(created.trail.name);
    assert.ok(created.trail.name !== initial.name);

    const renamed = renameJaneTrail(configDir, {
      trailId: created.trail.id,
      name: initial.name,
    });
    assert.ok(renamed.trail.name.startsWith(initial.name));
    assert.ok(renamed.trail.name !== initial.name);
  } finally {
    cleanup(configDir);
  }
});

test('applyWebviewOpsToSession updates dashboard state for file types, pins, and locks', () => {
  const configDir = mkTmpDir();
  try {
    const runtime = createWorkspaceRuntime({ configDir, extensionPath });
    const session = loadJaneSession(configDir);
    const result = applyWebviewOpsToSession({
      session,
      runtime,
      persistConfigChanges: false,
      ops: [
        { fn: 'setFileType', input: { file: 'trainer.yaml', fileType: 'config' } },
        { fn: 'pinField', input: { file: 'trainer.yaml', path: ['trainer', 'learning_rate'] } },
        { fn: 'lockField', input: { file: 'trainer.yaml', path: ['trainer', 'learning_rate'] } },
      ],
    });
    assert.strictEqual(result.session.dashboardState.fileTypes['trainer.yaml'], 'config');
    assert.strictEqual(result.session.dashboardState.pinnedFields['trainer.yaml'].length, 1);
    assert.strictEqual(result.session.dashboardState.lockedFields.length, 1);
  } finally {
    cleanup(configDir);
  }
});

test('applyWebviewOpsToSession can persist setValue changes for MCP Jane turns', () => {
  const configDir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(configDir, 'trainer.yaml'),
      ['trainer:', '  learning_rate: 0.001', ''].join('\n'),
      'utf8'
    );
    const runtime = createWorkspaceRuntime({ configDir, extensionPath });
    const session = loadJaneSession(configDir);
    const result = applyWebviewOpsToSession({
      session,
      runtime,
      persistConfigChanges: true,
      ops: [
        { fn: 'setValue', input: { file: 'trainer.yaml', path: ['trainer', 'learning_rate'], value: 0.02 } },
      ],
    });
    assert.strictEqual(result.diffs.length, 1);
    const updated = fs.readFileSync(path.join(configDir, 'trainer.yaml'), 'utf8');
    assert.match(updated, /learning_rate: 0\.02/);
  } finally {
    cleanup(configDir);
  }
});

test('session store tracks open panel state and external draft queue', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir);
    setPanelState(configDir, { open: true });
    enqueueExternalDraft(configDir, {
      id: 'draft-1',
      source: 'mcp:set_value',
      note: 'stage trainer lr',
      ops: [
        { fn: 'setValue', input: { file: 'trainer.yaml', path: ['trainer', 'learning_rate'], value: 0.2 } },
      ],
    });
    let session = loadJaneSession(configDir);
    assert.strictEqual(hasOpenPanelSession(session), true);
    assert.strictEqual(session.pendingExternalDrafts.length, 1);
    assert.strictEqual(session.pendingExternalDrafts[0].ops[0].fn, 'setValue');

    acknowledgeExternalDrafts(configDir, ['draft-1']);
    setPanelState(configDir, { open: false });
    session = loadJaneSession(configDir);
    assert.strictEqual(hasOpenPanelSession(session), false);
    assert.strictEqual(session.pendingExternalDrafts.length, 0);
  } finally {
    cleanup(configDir);
  }
});

test('session store persists edited notebook cells and deleted entries as canonical cell data', () => {
  const configDir = mkTmpDir();
  try {
    ensureTestTrail(configDir);
    replaceJaneEntries(configDir, [
      {
        question: 'plot fig 10',
        cells: [
          { type: 'markdown', content: 'First paragraph.' },
          { type: 'python', code: 'print(1)', output: '1' },
        ],
      },
    ]);
    let session = loadJaneSession(configDir);
    assert.strictEqual(session.entries.length, 1);
    assert.ok(session.entries[0].id);
    assert.strictEqual(session.entries[0].cells.length, 2);
    assert.ok(session.entries[0].cells[0].id);
    assert.ok(session.entries[0].cells[1].id);
    assert.strictEqual(session.entries[0].cells[1].code, 'print(1)');
    assert.strictEqual(session.entries[0].cells[1].runState, 'done');

    replaceJaneEntries(configDir, [
      {
        id: session.entries[0].id,
        question: 'plot fig 10',
        cells: [
          { id: session.entries[0].cells[1].id, type: 'python', code: 'print(2)', output: '2', runState: 'done' },
        ],
      },
    ]);
    session = loadJaneSession(configDir);
    assert.strictEqual(session.entries.length, 1);
    assert.strictEqual(session.entries[0].cells.length, 1);
    assert.ok(session.entries[0].id);
    assert.ok(session.entries[0].cells[0].id);
    assert.strictEqual(session.entries[0].cells[0].code, 'print(2)');
    assert.strictEqual(session.entries[0].cells[0].runState, 'done');
  } finally {
    cleanup(configDir);
  }
});

console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) process.exit(1);
