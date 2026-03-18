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

console.log('\n\x1b[1mSession Store\x1b[0m');

test('session store persists model and additional instructions', () => {
  const configDir = mkTmpDir();
  try {
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
    updateJaneSession(configDir, (session) => {
      session.agentModelId = 'direct:gpt-4o';
      session.additionalInstructions = 'Keep answers compact.';
      session.entries.push({ question: 'first', answer: 'hello' });
      return session;
    });

    const initialTrail = getActiveTrail(configDir);
    assert.ok(initialTrail);
    assert.ok(initialTrail.path.endsWith('.svnb'));
    assert.ok(initialTrail.name);
    assert.ok(!/^Trail \d+$/.test(initialTrail.name));
    assert.match(initialTrail.id, /^[A-Za-z0-9_]+_[a-f0-9]{32}$/);
    assert.ok(initialTrail.file === `${initialTrail.id}.svnb`);
    assert.strictEqual(listJaneTrails(configDir).length, 1);

    const created = createJaneTrail(configDir, { name: 'Clean Slate' });
    assert.strictEqual(created.trail.name, 'Clean Slate');
    assert.match(created.trail.id, /^Clean_Slate_[a-f0-9]{32}$/);
    assert.strictEqual(created.trail.file, `${created.trail.id}.svnb`);
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

test('default Trail ids are derived from the jungle bigram name', () => {
  const configDir = mkTmpDir();
  try {
    const trail = getActiveTrail(configDir);
    assert.ok(trail);
    assert.match(trail.name, /^[A-Za-z]+ [A-Za-z]+(?: \d+)?$/);
    const expectedPrefix = trail.name.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    assert.ok(trail.id.startsWith(`${expectedPrefix}_`));
    assert.strictEqual(trail.file, `${trail.id}.svnb`);
  } finally {
    cleanup(configDir);
  }
});

test('session store imports a legacy session only for a workspace with no Trail history yet', () => {
  const configDir = mkTmpDir();
  const legacyPath = legacySessionPathForConfigDir(configDir);
  try {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        configDir,
        entries: [{ question: 'legacy question', answer: 'legacy answer' }],
        updatedAt: new Date().toISOString(),
      }, null, 2),
      'utf8'
    );

    const session = loadJaneSession(configDir);
    assert.strictEqual(session.entries.length, 1);
    assert.strictEqual(session.entries[0].question, 'legacy question');
  } finally {
    cleanup(configDir);
  }
});

test('session store does not re-import a legacy session after the workspace has already initialized Trails', () => {
  const configDir = mkTmpDir();
  const legacyPath = legacySessionPathForConfigDir(configDir);
  try {
    updateJaneSession(configDir, (session) => session);

    const trailsDir = path.join(configDir, '.selva', 'trails');
    fs.rmSync(trailsDir, { recursive: true, force: true });

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        configDir,
        entries: [{ question: 'should not resurrect', answer: 'old content' }],
        updatedAt: new Date().toISOString(),
      }, null, 2),
      'utf8'
    );

    const session = loadJaneSession(configDir);
    assert.strictEqual(session.entries.length, 0);
  } finally {
    cleanup(configDir);
  }
});

test('session store can auto-name and rename Trails without collisions', () => {
  const configDir = mkTmpDir();
  try {
    const initial = getActiveTrail(configDir);
    assert.ok(initial.name);
    assert.ok(!/^Trail \d+$/.test(initial.name));

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
