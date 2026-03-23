const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { JUNGLE_A, JUNGLE_B } = require('../ecosystem/tools/propose_tool/bigrams.js');
const { withFileLockSync } = require('./file-lock');

const WORKSPACE_STORE_DIRNAME = '.selva';
const TRAILS_DIRNAME = 'trails';
const TRAIL_INDEX_FILENAME = 'index.json';
const TRAIL_FILE_EXTENSION = '.svnb';
const TRAIL_CONTEXT_EXTENSION = '.svctx';

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
    bitacora: '',
    agentModelId: '',
    sessionTokens: 0,
    lastQuestion: '',
    dashboardState: createDefaultDashboardState(),
    bootstrap: {
      done: false,
      answer: '',
      ops: [],
    },
    sessionSummary: '',  // Compressed summary of older conversation entries
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

function getWorkspaceStoreDir(configDir) {
  return path.join(configDir, WORKSPACE_STORE_DIRNAME);
}

function getTrailsDir(configDir) {
  const trailsDir = path.join(getWorkspaceStoreDir(configDir), TRAILS_DIRNAME);
  ensureDir(trailsDir);
  return trailsDir;
}

function getTrailIndexPath(configDir) {
  return path.join(getTrailsDir(configDir), TRAIL_INDEX_FILENAME);
}

function slugify(name) {
  return String(name || 'trail').trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'trail';
}

// Core path functions take dirName (slugified trail name).
// NOTE: _trailDir does NOT create the directory. Directories are created
// only when writing files (via writeJsonAtomic which calls ensureDir on the parent).
function _trailDir(configDir, dirName) {
  return path.join(getTrailsDir(configDir), dirName);
}
function _trailPath(configDir, dirName) {
  return path.join(_trailDir(configDir, dirName), `${dirName}${TRAIL_FILE_EXTENSION}`);
}
function _trailContextPath(configDir, dirName) {
  return path.join(_trailDir(configDir, dirName), `${dirName}${TRAIL_CONTEXT_EXTENSION}`);
}
function _trailMetaPath(configDir, dirName) {
  return path.join(_trailDir(configDir, dirName), 'trail.json');
}

// Public path functions accept trailId and resolve to dirName via index.
function getTrailDir(configDir, trailId) {
  return _trailDir(configDir, dirNameForTrailId(configDir, trailId));
}
function getTrailPath(configDir, trailId) {
  return _trailPath(configDir, dirNameForTrailId(configDir, trailId));
}
function getTrailContextPath(configDir, trailId) {
  return _trailContextPath(configDir, dirNameForTrailId(configDir, trailId));
}
function getTrailMetaPath(configDir, trailId) {
  return _trailMetaPath(configDir, dirNameForTrailId(configDir, trailId));
}
function trailLockPath(configDir, trailId) {
  return getTrailPath(configDir, trailId) + '.lock';
}

// Look up dirName from trailId via the index (cached per configDir)
const _dirNameCache = new Map();
function dirNameForTrailId(configDir, trailId) {
  const cacheKey = `${configDir}:${trailId}`;
  if (_dirNameCache.has(cacheKey)) return _dirNameCache.get(cacheKey);
  const index = readJsonFile(getTrailIndexPath(configDir));
  if (index && Array.isArray(index.trails)) {
    // Cache all trails at once
    for (const t of index.trails) {
      const dn = t.dirName || slugify(t.name || 'trail');
      _dirNameCache.set(`${configDir}:${t.id}`, dn);
    }
    const cached = _dirNameCache.get(cacheKey);
    if (cached) return cached;
  }
  return trailId;
}
function invalidateDirNameCache(configDir) {
  for (const key of _dirNameCache.keys()) {
    if (key.startsWith(configDir + ':')) _dirNameCache.delete(key);
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

function createTrailIdentity(trailName) {
  const bigram = createRandomTrailBase();
  const hex = crypto.randomBytes(8).toString('hex');
  const trailId = `${bigram.replace(/\s+/g, '_')}_${hex}`;
  // If no name provided, reuse the bigram as the human-readable name
  const name = String(trailName || '').trim() || bigram;
  return { trailId, trailName: name };
}

function createTrailId() {
  return createTrailIdentity('').trailId;
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

function normalizeCellProvenance(cell) {
  const author = (cell.author === 'human' || cell.author === 'user') ? 'human' : 'jane';
  const result = { author };
  if (cell.editedBy === 'human' || cell.editedBy === 'jane') {
    result.editedBy = cell.editedBy;
  }
  if (cell.createdAt) result.createdAt = cell.createdAt;
  if (cell.editedAt) result.editedAt = cell.editedAt;
  return result;
}

function normalizeNotebookCell(cell) {
  if (!cell || typeof cell !== 'object') return null;
  const type = String(cell.type || '').toLowerCase();
  if (!type) return null;
  const id = String(cell.id || createEntityId('cell'));
  const provenance = normalizeCellProvenance(cell);

  if (type === 'markdown') {
    return {
      id,
      type: 'markdown',
      content: String(cell.content || ''),
      ...provenance,
    };
  }

  if (type === 'python') {
    return {
      id,
      type: 'python',
      code: String(cell.code || ''),
      output: String(cell.output || ''),
      runState: normalizePythonRunState(cell.runState, cell.output),
      ...provenance,
    };
  }

  if (type === 'image') {
    return {
      id,
      type: 'image',
      data: String(cell.data || ''),
      ...provenance,
    };
  }

  if (type === 'diff') {
    return {
      id,
      type: 'diff',
      diffs: Array.isArray(cell.diffs) ? clone(cell.diffs) : [],
      ...provenance,
    };
  }

  return {
    id,
    type,
    lang: String(cell.lang || ''),
    content: String(cell.content || ''),
    ...provenance,
  };
}

function normalizeSessionEntry(entry) {
  const rawExecuted = Array.isArray(entry && entry.executedCells)
    ? entry.executedCells.map(normalizeExecutedCell).filter((cell) => cell.code)
    : [];

  const normalized = {
    id: String(entry && entry.id ? entry.id : createEntityId('entry')),
    question: String(entry && entry.question ? entry.question : ''),
    answer: String(entry && entry.answer ? entry.answer : ''),
    summary: String(entry && entry.summary ? entry.summary : ''),
    isError: !!(entry && entry.isError),
    timestamp: entry && entry.timestamp ? entry.timestamp : new Date().toISOString(),
  };

  // Always present in the in-memory model for API compat; stripped from .svnb v2 on save
  normalized.executedCells = rawExecuted;

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

const MAX_CONVERSATION_HISTORY_ENTRIES = 200;
const MAX_CONVERSATION_HISTORY_CHARS = 500000;
const SUMMARY_MAX_CHARS = 5000;

function capConversationHistory(history) {
  if (!Array.isArray(history)) return { capped: [], dropped: [] };
  let capped = history.slice(-MAX_CONVERSATION_HISTORY_ENTRIES);
  const droppedByCount = history.slice(0, Math.max(0, history.length - MAX_CONVERSATION_HISTORY_ENTRIES));

  let totalChars = capped.reduce((sum, turn) => sum + (turn.content || '').length, 0);
  const droppedBySize = [];
  while (totalChars > MAX_CONVERSATION_HISTORY_CHARS && capped.length > 2) {
    totalChars -= (capped[0].content || '').length;
    droppedBySize.push(capped[0]);
    capped = capped.slice(1);
  }
  if (capped.length > 0 && capped[0].role !== 'user') {
    droppedBySize.push(capped[0]);
    capped = capped.slice(1);
  }
  return { capped, dropped: [...droppedByCount, ...droppedBySize] };
}

function buildConversationSummary(existingSummary, droppedEntries) {
  if (!droppedEntries || droppedEntries.length === 0) return existingSummary || '';

  const newSummaryParts = [];
  for (const turn of droppedEntries) {
    const content = String(turn.content || '').trim();
    if (!content) continue;
    const role = turn.role === 'user' ? 'User' : 'Assistant';
    // Take first 200 chars of each dropped turn
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    newSummaryParts.push(`[${role}]: ${preview}`);
  }

  const newSummaryText = newSummaryParts.join('\n');
  const combined = existingSummary
    ? existingSummary + '\n---\n' + newSummaryText
    : newSummaryText;

  // Cap the summary itself
  if (combined.length > SUMMARY_MAX_CHARS) {
    return combined.slice(-SUMMARY_MAX_CHARS);
  }
  return combined;
}

function normalizeSession(session, configDir, meta = {}) {
  const base = createDefaultJaneSession(configDir);
  const fallbackTrailName = String(meta.trailName || session.trailName || 'Trail');
  const trailId = String(meta.trailId || session.trailId || createTrailId());
  const createdAt = meta.createdAt || session.createdAt || new Date().toISOString();
  const trailName = fallbackTrailName;

  const cappedResult = capConversationHistory(Array.isArray(session.conversationHistory) ? session.conversationHistory : []);
  const sessionSummary = buildConversationSummary(
    String(session.sessionSummary || ''),
    cappedResult.dropped
  );

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
    bitacora: String(session.bitacora || ''),
    conversationHistory: cappedResult.capped,
    sessionSummary,
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
    dirName: slugify(String(session.trailName || 'Trail')),
    parentTrailId: String(session.parentTrailId || ''),
    createdAt: session.createdAt || session.updatedAt || new Date().toISOString(),
    updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
    bootstrapDone: !!(session.bootstrap && session.bootstrap.done),
    entryCount: Array.isArray(session.entries) ? session.entries.length : 0,
    lastQuestion: session.lastQuestion || '',
  };
}

function normalizeTrailRecord(record) {
  const recordName = String(record && record.name ? record.name : 'Trail');
  const recordId = String(record && record.id ? record.id : createTrailId());
  const dirName = String(record && record.dirName ? record.dirName : slugify(recordName));
  return {
    id: recordId,
    name: recordName,
    dirName,
    parentTrailId: String(record && record.parentTrailId ? record.parentTrailId : ''),
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
  if (options.bitacora) base.bitacora = options.bitacora;
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
  const indexPath = getTrailIndexPath(configDir);
  const existing = readJsonFile(indexPath);

  if (!existing || !Array.isArray(existing.trails)) {
    // New project: empty trail store — user creates the first trail
    const index = normalizeTrailIndex({ activeTrailId: '', trails: [] }, configDir);
    writeJsonAtomic(indexPath, index);
    return index;
  }

  const normalized = normalizeTrailIndex(existing, configDir);
  let changed = false;

  for (const trail of normalized.trails) {
    const trailMetaExists = fs.existsSync(getTrailMetaPath(configDir, trail.id));
    const trailNbExists = fs.existsSync(getTrailPath(configDir, trail.id));

    if (!trailNbExists && !trailMetaExists) {
      const restored = createEmptyTrailSession(configDir, {
        trailId: trail.id,
        trailName: trail.name,
        createdAt: trail.createdAt,
      });
      const { trailMeta: tm, notebook: nb, context: ctx } = splitSessionForPersistence(restored);
      writeJsonAtomic(getTrailMetaPath(configDir, trail.id), tm);
      writeJsonAtomic(getTrailPath(configDir, trail.id), nb);
      writeJsonAtomic(getTrailContextPath(configDir, trail.id), ctx);
      Object.assign(trail, summarizeTrailSession(restored));
      changed = true;
      continue;
    }

    const trailMetaFile = readJsonFile(getTrailMetaPath(configDir, trail.id));
    const notebookFile = readJsonFile(getTrailPath(configDir, trail.id));
    const source = trailMetaFile || notebookFile;
    if (source) {
      const merged = trailMetaFile
        ? { ...source, entries: (notebookFile && notebookFile.entries) || [] }
        : source;
      Object.assign(trail, summarizeTrailSession(normalizeSession(merged, configDir, {
        trailId: trail.id,
        trailName: trail.name,
        createdAt: trail.createdAt,
      })));
    }
  }

  if (normalized.trails.length > 0 && (!normalized.activeTrailId || !normalized.trails.some((t) => t.id === normalized.activeTrailId))) {
    normalized.activeTrailId = normalized.trails[0].id;
    changed = true;
  }
  if (normalized.trails.length === 0) {
    normalized.activeTrailId = '';
    changed = true;
  }

  if (changed) {
    writeJsonAtomic(indexPath, normalized);
  }
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
    // No trails exist — return a bare default session without writing anything to disk
    return createDefaultJaneSession(configDir);
  }

  const meta = {
    trailId: target.id,
    trailName: target.name,
    createdAt: target.createdAt,
  };

  // Try reading trail.json (v2 three-file format)
  const trailMetaFile = readJsonFile(getTrailMetaPath(configDir, target.id));
  const notebookFile = readJsonFile(getTrailPath(configDir, target.id));
  const contextFile = readJsonFile(getTrailContextPath(configDir, target.id));

  // v1 migration: .svnb contains everything (conversationHistory, entries, dashboard, etc.)
  if (!trailMetaFile && notebookFile && (notebookFile.version !== 2 || notebookFile.dashboardState || Array.isArray(notebookFile.conversationHistory))) {
    const migrated = normalizeSession(notebookFile, configDir, meta);
    const { trailMeta: tm, notebook: nb, context: ctx } = splitSessionForPersistence(migrated);
    writeJsonAtomic(getTrailMetaPath(configDir, target.id), tm);
    writeJsonAtomic(getTrailPath(configDir, target.id), nb);
    writeJsonAtomic(getTrailContextPath(configDir, target.id), ctx);
    return migrated;
  }

  // No files at all — create fresh
  if (!trailMetaFile && !notebookFile) {
    const restored = createEmptyTrailSession(configDir, {
      trailId: target.id,
      trailName: target.name,
      createdAt: target.createdAt,
    });
    const { trailMeta: tm, notebook: nb, context: ctx } = splitSessionForPersistence(restored);
    writeJsonAtomic(getTrailMetaPath(configDir, target.id), tm);
    writeJsonAtomic(getTrailPath(configDir, target.id), nb);
    writeJsonAtomic(getTrailContextPath(configDir, target.id), ctx);
    return restored;
  }

  // v2: merge from three files
  return mergeSessionFromFiles(trailMetaFile, notebookFile, contextFile, configDir, meta);
}

function upsertTrailMeta(index, session) {
  const nextMeta = summarizeTrailSession(session);
  const idx = index.trails.findIndex((trail) => trail.id === nextMeta.id);
  if (idx >= 0) index.trails[idx] = nextMeta;
  else index.trails.push(nextMeta);
}

function splitSessionForPersistence(session) {
  // Trail identity (trail.json) — settings and metadata, rarely changes
  const trailMeta = {
    version: 2,
    trailId: session.trailId,
    trailName: session.trailName,
    parentTrailId: session.parentTrailId || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentModelId: session.agentModelId || '',
    additionalInstructions: session.additionalInstructions || '',
    bitacora: session.bitacora || '',
    dashboardState: session.dashboardState,
    bootstrap: { done: !!(session.bootstrap && session.bootstrap.done) },
    panelState: session.panelState,
    pendingExternalDrafts: session.pendingExternalDrafts || [],
  };

  // Notebook cells (.svnb) — the permanent record, changes on cell edits
  const notebook = {
    version: 2,
    entries: (session.entries || []).map((entry) => {
      const lean = {
        id: entry.id,
        question: entry.question || '',
        timestamp: entry.timestamp,
        isError: !!entry.isError,
      };
      if (entry.cells) lean.cells = entry.cells;
      if (Array.isArray(entry.executedCells) && entry.executedCells.length > 0) {
        lean.executedCells = entry.executedCells;
      }
      return lean;
    }),
  };

  // Conversation context (.svctx) — volatile LLM state
  const context = {
    version: 2,
    conversationHistory: session.conversationHistory || [],
    sessionSummary: session.sessionSummary || '',
    sessionTokens: session.sessionTokens || 0,
    lastQuestion: session.lastQuestion || '',
    bootstrap: session.bootstrap || { done: false, answer: '', ops: [] },
  };

  return { trailMeta, notebook, context };
}

function mergeSessionFromFiles(trailMeta, notebook, context, configDir, meta) {
  // Reconstruct the unified in-memory session from the three files
  const merged = {
    ...(trailMeta || {}),
    entries: (notebook && notebook.entries) || [],
    conversationHistory: (context && context.conversationHistory) || [],
    sessionSummary: (context && context.sessionSummary) || '',
    sessionTokens: (context && context.sessionTokens) || 0,
    lastQuestion: (context && context.lastQuestion) || '',
  };
  // Use the full bootstrap from context (has answer + ops), fall back to trailMeta's lean bootstrap
  if (context && context.bootstrap) {
    merged.bootstrap = context.bootstrap;
  }
  return normalizeSession(merged, configDir, meta);
}

function _saveTrailSessionInner(configDir, trailId, session, options = {}) {
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
    || createTrailId()
  );
  const existing = index.trails.find((trail) => trail.id === requestedTrailId) || null;
  const normalized = normalizeSession(session, configDir, {
    trailId: requestedTrailId,
    trailName: session.trailName || (existing && existing.name) || requestedTrailName,
    createdAt: session.createdAt || (existing && existing.createdAt) || new Date().toISOString(),
  });
  normalized.updatedAt = new Date().toISOString();

  // Pre-populate dir name cache so getTrailPath uses the name-based dir, not the raw ID
  const dirName = slugify(normalized.trailName || 'trail');
  _dirNameCache.set(`${configDir}:${requestedTrailId}`, dirName);

  // Split and write to three files
  const { trailMeta, notebook, context } = splitSessionForPersistence(normalized);
  writeJsonAtomic(getTrailMetaPath(configDir, requestedTrailId), trailMeta);
  writeJsonAtomic(getTrailPath(configDir, requestedTrailId), notebook);
  writeJsonAtomic(getTrailContextPath(configDir, requestedTrailId), context);

  upsertTrailMeta(index, normalized);
  if (makeActive) index.activeTrailId = requestedTrailId;
  writeJsonAtomic(getTrailIndexPath(configDir), index);
  invalidateDirNameCache(configDir);
  return normalized;
}

function saveTrailSession(configDir, trailId, session, options = {}) {
  const requestedTrailId = String(
    trailId
    || session.trailId
    || ensureTrailStore(configDir).activeTrailId
    || createTrailId()
  );
  // Pre-populate dir name cache so the lock file path uses the name-based dir
  const trailName = session.trailName || '';
  if (trailName) {
    _dirNameCache.set(`${configDir}:${requestedTrailId}`, slugify(trailName));
  }
  return withFileLockSync(trailLockPath(configDir, requestedTrailId), () => {
    return _saveTrailSessionInner(configDir, trailId, session, options);
  });
}

function saveJaneSession(configDir, session) {
  return saveTrailSession(configDir, session.trailId, session);
}

function updateJaneSession(configDir, updater, options = {}) {
  const resolvedTrailId = options.trailId || null;
  const preIndex = ensureTrailStore(configDir);
  const targetId = resolvedTrailId
    || preIndex.activeTrailId
    || (preIndex.trails[0] && preIndex.trails[0].id)
    || '';
  // No trails exist — nothing to update
  if (!targetId) return null;
  const lockPath = trailLockPath(configDir, targetId);

  const doUpdate = () => {
    const current = loadJaneSession(configDir, resolvedTrailId);
    const next = updater(clone(current)) || current;
    return _saveTrailSessionInner(
      configDir,
      options.trailId || next.trailId || current.trailId,
      next,
      { makeActive: options.makeActive !== false }
    );
  };

  if (lockPath) {
    return withFileLockSync(lockPath, doUpdate);
  }
  return doUpdate();
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
  const index = ensureTrailStore(configDir);
  if (!index.trails.length) return null;
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
  // Check the trail actually exists in the index before trying to load
  const index = ensureTrailStore(configDir);
  if (!index.trails.some(t => t.id === fromTrailId)) return;
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
  const { trailId, trailName } = createTrailIdentity(options.name);
  const safeName = uniqueTrailName(configDir, trailName);
  const fresh = createEmptyTrailSession(configDir, {
    trailId,
    trailName: safeName,
    panelOpen: hasOpenPanelSession(current),
    agentModelId: current.agentModelId || '',
    additionalInstructions: current.additionalInstructions || '',
    bitacora: current.bitacora || '',
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
  const identity = createTrailIdentity(options.name || '');
  const trailId = identity.trailId;
  const trailName = uniqueTrailName(configDir, identity.trailName);
  const now = new Date().toISOString();
  const parentId = String(source.trailId || options.sourceTrailId || '');

  // Build a compressed summary of the parent's conversation as context for the fork.
  // The fork starts with a fresh notebook — no cells copied — but Jane remembers
  // what was discussed and concluded in the parent trail.
  const parentSummaryHeader = `[Forked from trail "${source.trailName || 'parent'}"]\n`;
  const parentConversation = Array.isArray(source.conversationHistory) ? source.conversationHistory : [];
  const parentSessionSummary = buildConversationSummary(
    parentSummaryHeader + (source.sessionSummary || ''),
    parentConversation
  );

  const forked = normalizeSession({
    // Carry over: identity, settings, dashboard, bitácora
    dashboardState: clone(source.dashboardState || createDefaultDashboardState()),
    bootstrap: { done: !!(source.bootstrap && source.bootstrap.done), answer: '', ops: [] },
    agentModelId: source.agentModelId || '',
    additionalInstructions: source.additionalInstructions || '',
    bitacora: source.bitacora || '',
    // Fresh: empty notebook, empty conversation, parent summary as context
    entries: [],
    conversationHistory: [],
    sessionSummary: parentSessionSummary,
    sessionTokens: 0,
    lastQuestion: '',
    // Fork metadata
    trailId,
    trailName,
    parentTrailId: parentId,
    createdAt: now,
    updatedAt: now,
    pendingExternalDrafts: [],
    panelState: {
      ...createDefaultPanelState(),
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

  // Move the trail folder/files to match the new name
  const oldDirName = dirNameForTrailId(configDir, targetId);
  const newDirName = slugify(nextName);
  if (oldDirName !== newDirName) {
    const trailsBase = getTrailsDir(configDir);
    const oldDir = path.join(trailsBase, oldDirName);
    const newDir = path.join(trailsBase, newDirName);
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      // Rename files inside the old directory first
      const oldSlug = slugify(oldDirName);
      const newSlug = slugify(newDirName);
      for (const ext of [TRAIL_FILE_EXTENSION, TRAIL_CONTEXT_EXTENSION]) {
        const oldFile = path.join(oldDir, `${oldSlug}${ext}`);
        const newFile = path.join(oldDir, `${newSlug}${ext}`);
        if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile);
      }
      // Rename the directory
      fs.renameSync(oldDir, newDir);
    }
  }

  // Update the index with the new dirName before saving
  const index = ensureTrailStore(configDir);
  const trailRecord = index.trails.find(t => t.id === targetId);
  if (trailRecord) {
    trailRecord.dirName = newDirName;
    trailRecord.name = nextName;
    writeJsonAtomic(getTrailIndexPath(configDir), index);
  }

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

function switchJaneTrail(configDir, trailId, options = {}) {
  const targetId = String(trailId || '').trim();
  const index = ensureTrailStore(configDir);
  if (!index.trails.some((trail) => trail.id === targetId)) {
    throw new Error(`Trail not found: ${trailId}`);
  }
  // When updateIndex is false (MCP-originated switch), don't change the
  // global activeTrailId — only load the target session without side effects.
  const updateIndex = options.updateIndex !== false;
  if (!updateIndex) {
    const next = loadJaneSession(configDir, targetId);
    const target = index.trails.find((t) => t.id === targetId) || null;
    return {
      trail: target ? { ...target, active: false, path: getTrailPath(configDir, targetId) } : null,
      trails: listJaneTrails(configDir),
      session: next,
    };
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

function deleteJaneTrail(configDir, trailId) {
  const targetId = String(trailId || '').trim();
  const index = ensureTrailStore(configDir);
  const idx = index.trails.findIndex((t) => t.id === targetId);
  if (idx < 0) throw new Error(`Trail not found: ${trailId}`);
  // Allow deleting the last trail — the project can be empty

  const trailDir = getTrailDir(configDir, targetId);
  try { fs.rmSync(trailDir, { recursive: true, force: true }); } catch {}

  index.trails.splice(idx, 1);

  if (index.activeTrailId === targetId) {
    index.activeTrailId = index.trails.length > 0 ? index.trails[0].id : '';
  }

  writeJsonAtomic(getTrailIndexPath(configDir), index);

  return {
    trail: getActiveTrail(configDir),
    trails: listJaneTrails(configDir),
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

const { execFile: _execFileCb } = require('child_process');

function silentGitCommit(configDir, message) {
  const trailsDir = getTrailsDir(configDir);
  // Fire and forget — never block, never throw, never show output
  try {
    _execFileCb('git', ['add', '.'], { cwd: trailsDir, timeout: 5000 }, (addErr) => {
      if (addErr) return; // not a git repo or git not available — silently skip
      _execFileCb('git', ['commit', '-m', `[selva] ${message}`, '--no-gpg-sign', '--allow-empty'], {
        cwd: trailsDir,
        timeout: 5000,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Selva', GIT_AUTHOR_EMAIL: 'selva@local', GIT_COMMITTER_NAME: 'Selva', GIT_COMMITTER_EMAIL: 'selva@local' },
      }, () => {});
    });
  } catch {
    // git not installed or other system error — silently ignore
  }
}

module.exports = {
  acknowledgeExternalDrafts,
  appendJaneEntry,
  buildConversationSummary,
  clearJaneSession,
  clone,
  createDefaultDashboardState,
  createDefaultJaneSession,
  deleteJaneTrail,
  createDefaultPanelState,
  createEntityId,
  createJaneTrail,
  enqueueExternalDraft,
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
  silentGitCommit,
  switchJaneTrail,
  updateJaneSession,
  workspaceIdForConfigDir,
};
