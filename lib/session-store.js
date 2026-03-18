const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { JUNGLE_A, JUNGLE_B } = require('../ecosystem/tools/propose_tool/bigrams.js');

const LEGACY_SESSIONS_DIR = path.join(os.homedir(), '.selva', 'sessions');
const WORKSPACE_STORE_DIRNAME = '.selva';
const TRAILS_DIRNAME = 'trails';
const TRAIL_INDEX_FILENAME = 'index.json';
const TRAIL_FILE_EXTENSION = '.svnb';
const TRAIL_STORE_MARKER_FILENAME = '.trail-store-initialized';

function ensureSessionsDir() {
  fs.mkdirSync(LEGACY_SESSIONS_DIR, { recursive: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEntityId(prefix = 'entity') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function createDefaultDashboardState() {
  return {
    fileTypes: {},
    lockedFields: [],
    pinnedFields: {},
    activeConfigFile: null,
    activeDataFile: null,
  };
}

function createDefaultPanelState() {
  return {
    open: false,
    updatedAt: null,
  };
}

function createDefaultJaneSession(configDir) {
  return {
    version: 1,
    configDir,
    conversationHistory: [],
    entries: [],
    additionalInstructions: '',
    agentModelId: '',
    sessionTokens: 0,
    lastQuestion: '',
    dashboardState: createDefaultDashboardState(),
    bootstrap: {
      done: false,
      answer: '',
      ops: [],
    },
    panelState: createDefaultPanelState(),
    pendingExternalDrafts: [],
    updatedAt: new Date().toISOString(),
  };
}

function workspaceIdForConfigDir(configDir) {
  return crypto.createHash('sha1').update(String(configDir)).digest('hex');
}

function sessionIdForConfigDir(configDir) {
  return workspaceIdForConfigDir(configDir);
}

function getLegacySessionPath(configDir) {
  ensureSessionsDir();
  return path.join(LEGACY_SESSIONS_DIR, workspaceIdForConfigDir(configDir) + '.json');
}

function getWorkspaceStoreDir(configDir) {
  return path.join(configDir, WORKSPACE_STORE_DIRNAME);
}

function getTrailStoreMarkerPath(configDir) {
  return path.join(getWorkspaceStoreDir(configDir), TRAIL_STORE_MARKER_FILENAME);
}

function getTrailsDir(configDir) {
  const trailsDir = path.join(getWorkspaceStoreDir(configDir), TRAILS_DIRNAME);
  ensureDir(trailsDir);
  return trailsDir;
}

function getTrailIndexPath(configDir) {
  return path.join(getTrailsDir(configDir), TRAIL_INDEX_FILENAME);
}

function trailFileName(trailId) {
  return `${trailId}${TRAIL_FILE_EXTENSION}`;
}

function getTrailPath(configDir, trailId) {
  return path.join(getTrailsDir(configDir), trailFileName(trailId));
}

function markTrailStoreInitialized(configDir) {
  const markerPath = getTrailStoreMarkerPath(configDir);
  ensureDir(path.dirname(markerPath));
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, '1\n', 'utf8');
  }
}

function createRandomTrailBase(hashHex = crypto.randomBytes(8).toString('hex')) {
  const a = parseInt(hashHex.slice(0, 2), 16) % JUNGLE_A.length;
  const b = parseInt(hashHex.slice(2, 4), 16) % JUNGLE_B.length;
  return `${JUNGLE_A[a]} ${JUNGLE_B[b]}`;
}

function createDefaultTrailName(existingCount = 0, existingNames = []) {
  const used = new Set(Array.isArray(existingNames) ? existingNames : []);
  for (let i = 0; i < 16; i += 1) {
    const candidate = createRandomTrailBase();
    if (!used.has(candidate)) return candidate;
  }
  return `${createRandomTrailBase()} ${existingCount + 1}`;
}

function slugifyTrailName(trailName) {
  return String(trailName || 'Trail')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Trail';
}

function randomTrailSuffix() {
  return crypto.randomUUID().replace(/-/g, '');
}

function createTrailId(trailName) {
  return `${slugifyTrailName(trailName)}_${randomTrailSuffix()}`;
}

function createTrailIdentity(trailName) {
  const name = String(trailName || '').trim() || 'Trail';
  return {
    trailName: name,
    trailId: createTrailId(name),
  };
}

function normalizeDraftOp(op) {
  return {
    fn: String(op.fn || ''),
    input: clone(op.input || {}),
  };
}

function normalizeExternalDraft(draft) {
  return {
    id: String(draft.id || crypto.randomUUID()),
    source: String(draft.source || 'external'),
    note: String(draft.note || ''),
    createdAt: draft.createdAt || new Date().toISOString(),
    ops: Array.isArray(draft.ops) ? draft.ops.map(normalizeDraftOp) : [],
  };
}

function normalizeExecutedCell(cell) {
  return {
    code: String(cell && cell.code ? cell.code : ''),
    output: String(cell && cell.output ? cell.output : ''),
  };
}

function isLegacyPendingPythonOutput(output) {
  const text = String(output || '').trim();
  if (!text) return false;
  // Compatibility for notebook cells persisted before explicit runState existed.
  return /^\[[^\]]*\bplot\b[^\]]*\]$/i.test(text);
}

function looksLikePythonExecutionError(output) {
  const text = String(output || '').trim();
  if (!text) return false;
  return /^Error \(exit\s+\d+\):/i.test(text)
    || /^Execution error:/i.test(text)
    || /Traceback \(most recent call last\):/i.test(text)
    || /\b(?:SyntaxError|NameError|TypeError|ValueError|IndexError|KeyError|ModuleNotFoundError|ImportError|AttributeError|RuntimeError)\b/.test(text);
}

function normalizePythonRunState(runState, output) {
  const normalized = String(runState || '').trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'done' || normalized === 'error') {
    return normalized;
  }
  if (normalized === 'running') {
    return 'pending';
  }

  const text = String(output || '').trim();
  if (!text) return 'pending';
  if (isLegacyPendingPythonOutput(text)) return 'pending';
  if (looksLikePythonExecutionError(text)) return 'error';
  return 'done';
}

function normalizeNotebookCell(cell) {
  if (!cell || typeof cell !== 'object') return null;
  const type = String(cell.type || '').toLowerCase();
  if (!type) return null;
  const id = String(cell.id || createEntityId('cell'));

  if (type === 'markdown') {
    return {
      id,
      type: 'markdown',
      content: String(cell.content || ''),
    };
  }

  if (type === 'python') {
    return {
      id,
      type: 'python',
      code: String(cell.code || ''),
      output: String(cell.output || ''),
      runState: normalizePythonRunState(cell.runState, cell.output),
    };
  }

  if (type === 'image') {
    return {
      id,
      type: 'image',
      data: String(cell.data || ''),
    };
  }

  if (type === 'diff') {
    return {
      id,
      type: 'diff',
      diffs: Array.isArray(cell.diffs) ? clone(cell.diffs) : [],
    };
  }

  return {
    id,
    type,
    lang: String(cell.lang || ''),
    content: String(cell.content || ''),
  };
}

function normalizeSessionEntry(entry) {
  const normalized = {
    id: String(entry && entry.id ? entry.id : createEntityId('entry')),
    question: String(entry && entry.question ? entry.question : ''),
    answer: String(entry && entry.answer ? entry.answer : ''),
    summary: String(entry && entry.summary ? entry.summary : ''),
    executedCells: Array.isArray(entry && entry.executedCells)
      ? entry.executedCells.map(normalizeExecutedCell).filter((cell) => cell.code)
      : [],
    isError: !!(entry && entry.isError),
    timestamp: entry && entry.timestamp ? entry.timestamp : new Date().toISOString(),
  };

  if (Array.isArray(entry && entry.cells)) {
    normalized.cells = entry.cells
      .map(normalizeNotebookCell)
      .filter((cell) => cell && (
        (cell.type === 'markdown' && cell.content)
        || (cell.type === 'python' && cell.code)
        || (cell.type === 'image' && cell.data)
        || (cell.type === 'diff')
        || cell.content
      ));
  }

  return normalized;
}

function normalizeSession(session, configDir, meta = {}) {
  const base = createDefaultJaneSession(configDir);
  const fallbackTrailName = String(meta.trailName || session.trailName || 'Trail');
  const trailId = String(meta.trailId || session.trailId || createTrailId(fallbackTrailName));
  const createdAt = meta.createdAt || session.createdAt || new Date().toISOString();
  const trailName = fallbackTrailName;

  return {
    ...base,
    ...session,
    configDir,
    trailId,
    trailName,
    createdAt,
    dashboardState: {
      ...base.dashboardState,
      ...(session.dashboardState || {}),
      fileTypes: { ...(base.dashboardState.fileTypes || {}), ...((session.dashboardState || {}).fileTypes || {}) },
      pinnedFields: { ...(base.dashboardState.pinnedFields || {}), ...((session.dashboardState || {}).pinnedFields || {}) },
      lockedFields: Array.isArray((session.dashboardState || {}).lockedFields)
        ? [...session.dashboardState.lockedFields]
        : [...base.dashboardState.lockedFields],
    },
    bootstrap: {
      ...base.bootstrap,
      ...(session.bootstrap || {}),
      ops: Array.isArray((session.bootstrap || {}).ops) ? [...session.bootstrap.ops] : [],
    },
    panelState: {
      ...base.panelState,
      ...(session.panelState || {}),
    },
    conversationHistory: Array.isArray(session.conversationHistory) ? [...session.conversationHistory] : [],
    entries: Array.isArray(session.entries) ? session.entries.map(normalizeSessionEntry) : [],
    pendingExternalDrafts: Array.isArray(session.pendingExternalDrafts)
      ? session.pendingExternalDrafts.map(normalizeExternalDraft).filter((draft) => draft.ops.length > 0)
      : [],
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function summarizeTrailSession(session) {
  return {
    id: String(session.trailId || ''),
    name: String(session.trailName || 'Trail'),
    file: trailFileName(String(session.trailId || '')),
    createdAt: session.createdAt || session.updatedAt || new Date().toISOString(),
    updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
    bootstrapDone: !!(session.bootstrap && session.bootstrap.done),
    entryCount: Array.isArray(session.entries) ? session.entries.length : 0,
    lastQuestion: session.lastQuestion || '',
  };
}

function normalizeTrailRecord(record) {
  const recordName = String(record && record.name ? record.name : 'Trail');
  const recordId = String(record && record.id ? record.id : createTrailId(recordName));
  return {
    id: recordId,
    name: recordName,
    file: String(record && record.file ? record.file : trailFileName(recordId)),
    createdAt: record && record.createdAt ? record.createdAt : new Date().toISOString(),
    updatedAt: record && record.updatedAt ? record.updatedAt : new Date().toISOString(),
    bootstrapDone: !!(record && record.bootstrapDone),
    entryCount: Number(record && record.entryCount ? record.entryCount : 0),
    lastQuestion: String(record && record.lastQuestion ? record.lastQuestion : ''),
  };
}

function normalizeTrailIndex(index, configDir) {
  return {
    version: 1,
    configDir,
    workspaceId: workspaceIdForConfigDir(configDir),
    activeTrailId: index && index.activeTrailId ? String(index.activeTrailId) : '',
    trails: Array.isArray(index && index.trails) ? index.trails.map(normalizeTrailRecord) : [],
  };
}

function createEmptyTrailSession(configDir, options = {}) {
  const base = createDefaultJaneSession(configDir);
  if (options.agentModelId) base.agentModelId = options.agentModelId;
  if (options.additionalInstructions) base.additionalInstructions = options.additionalInstructions;
  if (options.panelOpen) {
    base.panelState = {
      ...createDefaultPanelState(),
      open: true,
      updatedAt: new Date().toISOString(),
    };
  }
  return normalizeSession(base, configDir, {
    trailId: options.trailId,
    trailName: options.trailName,
    createdAt: options.createdAt,
  });
}

function ensureTrailStore(configDir) {
  const markerPath = getTrailStoreMarkerPath(configDir);
  const hadMarker = fs.existsSync(markerPath);
  const indexPath = getTrailIndexPath(configDir);
  const existing = readJsonFile(indexPath);
  if (!existing || !Array.isArray(existing.trails) || existing.trails.length === 0) {
    const legacy = hadMarker ? null : readJsonFile(getLegacySessionPath(configDir));
    const { trailId, trailName } = createTrailIdentity(createDefaultTrailName(0));
    const session = legacy
      ? normalizeSession(legacy, configDir, {
        trailId,
        trailName,
        createdAt: legacy.createdAt || legacy.updatedAt || new Date().toISOString(),
      })
      : createEmptyTrailSession(configDir, { trailId, trailName });
    writeJsonAtomic(getTrailPath(configDir, trailId), session);
    const index = normalizeTrailIndex({
      activeTrailId: trailId,
      trails: [summarizeTrailSession(session)],
    }, configDir);
    writeJsonAtomic(indexPath, index);
    markTrailStoreInitialized(configDir);
    return index;
  }

  const normalized = normalizeTrailIndex(existing, configDir);
  let changed = false;

  for (const trail of normalized.trails) {
    const trailPath = getTrailPath(configDir, trail.id);
    if (!fs.existsSync(trailPath)) {
      const restored = createEmptyTrailSession(configDir, {
        trailId: trail.id,
        trailName: trail.name,
        createdAt: trail.createdAt,
      });
      writeJsonAtomic(trailPath, restored);
      Object.assign(trail, summarizeTrailSession(restored));
      changed = true;
      continue;
    }

    const session = readJsonFile(trailPath);
    if (session) {
      Object.assign(trail, summarizeTrailSession(normalizeSession(session, configDir, {
        trailId: trail.id,
        trailName: trail.name,
        createdAt: trail.createdAt,
      })));
    }
  }

  if (!normalized.activeTrailId || !normalized.trails.some((trail) => trail.id === normalized.activeTrailId)) {
    normalized.activeTrailId = normalized.trails[0].id;
    changed = true;
  }

  if (changed) {
    writeJsonAtomic(indexPath, normalized);
  }
  markTrailStoreInitialized(configDir);
  return normalized;
}

function listJaneTrails(configDir) {
  const index = ensureTrailStore(configDir);
  return index.trails.map((trail) => ({
    ...trail,
    active: trail.id === index.activeTrailId,
    path: getTrailPath(configDir, trail.id),
  }));
}

function getActiveTrail(configDir) {
  const index = ensureTrailStore(configDir);
  const trail = index.trails.find((item) => item.id === index.activeTrailId) || index.trails[0] || null;
  if (!trail) return null;
  return {
    ...trail,
    active: true,
    path: getTrailPath(configDir, trail.id),
  };
}

function getSessionPath(configDir) {
  const trail = getActiveTrail(configDir);
  if (!trail) {
    const { trailId } = createTrailIdentity(createDefaultTrailName(0));
    return getTrailPath(configDir, trailId);
  }
  return trail.path;
}

function loadJaneSession(configDir, trailId = null) {
  const index = ensureTrailStore(configDir);
  const target = trailId
    ? (index.trails.find((trail) => trail.id === String(trailId)) || null)
    : (index.trails.find((trail) => trail.id === index.activeTrailId) || index.trails[0] || null);

  if (!target) {
    const { trailId, trailName } = createTrailIdentity(createDefaultTrailName(0));
    return createEmptyTrailSession(configDir, {
      trailId,
      trailName,
    });
  }

  const parsed = readJsonFile(getTrailPath(configDir, target.id));
  if (!parsed) {
    const restored = createEmptyTrailSession(configDir, {
      trailId: target.id,
      trailName: target.name,
      createdAt: target.createdAt,
    });
    writeJsonAtomic(getTrailPath(configDir, target.id), restored);
    return restored;
  }

  return normalizeSession(parsed, configDir, {
    trailId: target.id,
    trailName: target.name,
    createdAt: target.createdAt,
  });
}

function upsertTrailMeta(index, session) {
  const nextMeta = summarizeTrailSession(session);
  const idx = index.trails.findIndex((trail) => trail.id === nextMeta.id);
  if (idx >= 0) index.trails[idx] = nextMeta;
  else index.trails.push(nextMeta);
}

function saveTrailSession(configDir, trailId, session, options = {}) {
  const index = ensureTrailStore(configDir);
  const makeActive = options.makeActive !== false;
  const requestedTrailName = String(
    session.trailName
    || (index.trails.find((trail) => trail.id === String(trailId || session.trailId || index.activeTrailId || '')) || {}).name
    || createDefaultTrailName(index.trails.length)
  );
  const requestedTrailId = String(
    trailId
    || session.trailId
    || index.activeTrailId
    || createTrailId(requestedTrailName)
  );
  const existing = index.trails.find((trail) => trail.id === requestedTrailId) || null;
  const normalized = normalizeSession(session, configDir, {
    trailId: requestedTrailId,
    trailName: session.trailName || (existing && existing.name) || requestedTrailName,
    createdAt: session.createdAt || (existing && existing.createdAt) || new Date().toISOString(),
  });
  normalized.updatedAt = new Date().toISOString();
  writeJsonAtomic(getTrailPath(configDir, requestedTrailId), normalized);
  upsertTrailMeta(index, normalized);
  if (makeActive) index.activeTrailId = requestedTrailId;
  writeJsonAtomic(getTrailIndexPath(configDir), index);
  return normalized;
}

function saveJaneSession(configDir, session) {
  return saveTrailSession(configDir, session.trailId, session);
}

function updateJaneSession(configDir, updater, options = {}) {
  const current = loadJaneSession(configDir, options.trailId || null);
  const next = updater(clone(current)) || current;
  return saveTrailSession(
    configDir,
    options.trailId || next.trailId || current.trailId,
    next,
    { makeActive: options.makeActive !== false }
  );
}

function appendJaneEntry(configDir, entry) {
  return updateJaneSession(configDir, (session) => {
    session.entries.push(normalizeSessionEntry(entry));
    return session;
  });
}

function replaceJaneEntries(configDir, entries) {
  return updateJaneSession(configDir, (session) => {
    session.entries = Array.isArray(entries) ? entries.map(normalizeSessionEntry) : [];
    return session;
  });
}

function setPanelState(configDir, panelState) {
  return updateJaneSession(configDir, (session) => {
    session.panelState = {
      ...createDefaultPanelState(),
      ...(session.panelState || {}),
      ...(panelState || {}),
      updatedAt: new Date().toISOString(),
    };
    return session;
  });
}

function hasOpenPanelSession(session) {
  return !!(session && session.panelState && session.panelState.open);
}

function enqueueExternalDraft(configDir, draft) {
  return updateJaneSession(configDir, (session) => {
    const normalized = normalizeExternalDraft(draft);
    session.pendingExternalDrafts = Array.isArray(session.pendingExternalDrafts)
      ? session.pendingExternalDrafts.filter((item) => item.id !== normalized.id)
      : [];
    session.pendingExternalDrafts.push(normalized);
    return session;
  });
}

function acknowledgeExternalDrafts(configDir, ids) {
  const idSet = new Set((ids || []).map((id) => String(id)));
  return updateJaneSession(configDir, (session) => {
    session.pendingExternalDrafts = (session.pendingExternalDrafts || []).filter(
      (draft) => !idSet.has(String(draft.id))
    );
    return session;
  });
}

function uniqueTrailName(configDir, requestedName, options = {}) {
  const excludeTrailId = String(options.excludeTrailId || '').trim();
  const trails = listJaneTrails(configDir).filter((trail) => trail.id !== excludeTrailId);
  const existingNames = new Set(trails.map((trail) => trail.name));
  const base = String(requestedName || '').trim() || createDefaultTrailName(existingNames.size, [...existingNames]);
  if (!existingNames.has(base)) return base;
  let counter = 2;
  while (existingNames.has(`${base} (${counter})`)) counter += 1;
  return `${base} (${counter})`;
}

function transferPanelOpen(configDir, fromTrailId, toTrailId) {
  if (!fromTrailId || fromTrailId === toTrailId) return;
  const current = loadJaneSession(configDir, fromTrailId);
  if (!hasOpenPanelSession(current)) return;
  updateJaneSession(configDir, (session) => {
    session.panelState = {
      ...createDefaultPanelState(),
      ...(session.panelState || {}),
      open: false,
      updatedAt: new Date().toISOString(),
    };
    return session;
  }, { trailId: fromTrailId, makeActive: false });
}

function createJaneTrail(configDir, options = {}) {
  const current = loadJaneSession(configDir);
  const trailName = uniqueTrailName(configDir, options.name);
  const trailId = createTrailId(trailName);
  const fresh = createEmptyTrailSession(configDir, {
    trailId,
    trailName,
    panelOpen: hasOpenPanelSession(current),
    agentModelId: current.agentModelId || '',
    additionalInstructions: current.additionalInstructions || '',
  });
  transferPanelOpen(configDir, current.trailId, trailId);
  const saved = saveTrailSession(configDir, trailId, fresh, { makeActive: true });
  return {
    trail: getActiveTrail(configDir),
    trails: listJaneTrails(configDir),
    session: saved,
  };
}

function forkJaneTrail(configDir, options = {}) {
  const source = loadJaneSession(configDir, options.sourceTrailId || null);
  const trailName = uniqueTrailName(configDir, options.name || '');
  const trailId = createTrailId(trailName);
  const now = new Date().toISOString();
  const forked = normalizeSession({
    ...clone(source),
    trailId,
    trailName,
    createdAt: now,
    updatedAt: now,
    pendingExternalDrafts: [],
    panelState: {
      ...createDefaultPanelState(),
      ...(source.panelState || {}),
      open: hasOpenPanelSession(source),
      updatedAt: now,
    },
  }, configDir, {
    trailId,
    trailName,
    createdAt: now,
  });
  transferPanelOpen(configDir, loadJaneSession(configDir).trailId, trailId);
  const saved = saveTrailSession(configDir, trailId, forked, { makeActive: true });
  return {
    trail: getActiveTrail(configDir),
    trails: listJaneTrails(configDir),
    session: saved,
  };
}

function renameJaneTrail(configDir, options = {}) {
  const targetId = String(options.trailId || '').trim() || String((getActiveTrail(configDir) || {}).id || '');
  if (!targetId) {
    throw new Error('No active Trail to rename.');
  }
  const current = loadJaneSession(configDir, targetId);
  const nextName = uniqueTrailName(configDir, options.name || current.trailName || '', {
    excludeTrailId: targetId,
  });
  const active = getActiveTrail(configDir);
  const saved = saveTrailSession(configDir, targetId, {
    ...current,
    trailName: nextName,
  }, {
    makeActive: !!(active && active.id === targetId),
  });
  const trail = listJaneTrails(configDir).find((item) => item.id === targetId) || getActiveTrail(configDir);
  return {
    trail,
    trails: listJaneTrails(configDir),
    session: saved,
  };
}

function switchJaneTrail(configDir, trailId) {
  const targetId = String(trailId || '').trim();
  const index = ensureTrailStore(configDir);
  if (!index.trails.some((trail) => trail.id === targetId)) {
    throw new Error(`Trail not found: ${trailId}`);
  }
  const previous = loadJaneSession(configDir);
  const next = loadJaneSession(configDir, targetId);
  const shouldOpen = hasOpenPanelSession(previous) || hasOpenPanelSession(next);
  transferPanelOpen(configDir, previous.trailId, targetId);
  const saved = saveTrailSession(configDir, targetId, {
    ...next,
    panelState: {
      ...createDefaultPanelState(),
      ...(next.panelState || {}),
      open: shouldOpen,
      updatedAt: new Date().toISOString(),
    },
  }, { makeActive: true });
  return {
    trail: getActiveTrail(configDir),
    trails: listJaneTrails(configDir),
    session: saved,
  };
}

function clearJaneSession(configDir) {
  const current = loadJaneSession(configDir);
  const cleared = createEmptyTrailSession(configDir, {
    trailId: current.trailId,
    trailName: current.trailName,
    createdAt: current.createdAt,
    panelOpen: hasOpenPanelSession(current),
  });
  return saveTrailSession(configDir, current.trailId, cleared, { makeActive: true });
}

module.exports = {
  acknowledgeExternalDrafts,
  appendJaneEntry,
  clearJaneSession,
  createDefaultDashboardState,
  createDefaultJaneSession,
  createDefaultPanelState,
  createEntityId,
  createJaneTrail,
  enqueueExternalDraft,
  ensureSessionsDir,
  forkJaneTrail,
  getActiveTrail,
  getSessionPath,
  getTrailIndexPath,
  getTrailPath,
  getTrailsDir,
  hasOpenPanelSession,
  listJaneTrails,
  loadJaneSession,
  looksLikePythonExecutionError,
  normalizeNotebookCell,
  normalizePythonRunState,
  normalizeSessionEntry,
  renameJaneTrail,
  replaceJaneEntries,
  saveJaneSession,
  sessionIdForConfigDir,
  setPanelState,
  switchJaneTrail,
  updateJaneSession,
  workspaceIdForConfigDir,
};
