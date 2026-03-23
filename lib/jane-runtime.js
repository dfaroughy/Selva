const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const {
  buildSchema,
  buildToolSchemas,
  loadAllTools,
  loadExtensionTool,
} = require('./selva-runtime');
const {
  clearJaneSession,
  createJaneTrail,
  createDefaultDashboardState,
  deleteJaneTrail,
  enqueueExternalDraft,
  forkJaneTrail,
  getActiveTrail,
  getTrailsDir,
  hasOpenPanelSession,
  listJaneTrails,
  looksLikePythonExecutionError,
  loadJaneSession,
  normalizeNotebookCell,
  normalizePythonRunState,
  renameJaneTrail,
  replaceJaneEntries,
  sessionIdForConfigDir,
  silentGitCommit,
  switchJaneTrail,
  updateJaneSession,
} = require('./session-store');
const { applyWebviewOpsToSession } = require('./backend-ops');
const { executeNotebookCell } = require('./notebook-execution');

const BOOTSTRAP_HISTORY_PROMPT = '[Bootstrap: initialize session, classify files, pin key fields]';
const defaultExecFileAsync = promisify(execFile);
const NULL_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

function detectWorkspaceDomain(schemata, repoContext) {
  const fieldText = schemata.map(s =>
    s.fields.map(f => (f.path || []).join('.') + ' ' + (f.preview || '')).join(' ')
  ).join(' ');
  const allText = ((repoContext || '') + '\n' + fieldText).toLowerCase();

  const mlSignals = ['learning_rate', 'lr', 'epochs', 'batch_size', 'optimizer', 'dropout',
    'hidden_dim', 'num_layers', 'weight_decay', 'scheduler', 'embedding', 'attention',
    'transformer', 'pytorch', 'tensorflow', 'training', 'backbone', 'encoder', 'decoder'];
  const physicsSignals = ['energy', 'cross_section', 'luminosity', 'monte_carlo', 'detector',
    'particle', 'histogram', 'signal', 'background', 'systematic', 'gev', 'tev',
    'branching_ratio', 'decay', 'coupling', 'n_events', 'cross-section'];
  const dataSignals = ['columns', 'rows', 'csv', 'pandas', 'dataframe', 'features',
    'target', 'correlation', 'regression', 'classification', 'statistics', 'sample'];

  const score = (signals) => signals.filter(s => allText.includes(s)).length;
  const mlScore = score(mlSignals);
  const physicsScore = score(physicsSignals);
  const dataScore = score(dataSignals);

  const max = Math.max(mlScore, physicsScore, dataScore);
  if (max < 2) return null;
  if (mlScore === max) return 'ml';
  if (physicsScore === max) return 'physics';
  return 'data';
}

function loadDomainPrompt(extensionPath, domain) {
  if (!domain) return '';
  try {
    return fs.readFileSync(path.join(extensionPath, 'ecosystem', 'prompts', 'domain', `${domain.toUpperCase()}.md`), 'utf8');
  } catch {
    return '';
  }
}

const NOTEBOOK_CELL_TYPES = ['markdown', 'python', 'image', 'diff', 'code', 'ascii', 'mermaid', 'svg'];
const WEBVIEW_OP_ALIASES = {
  set_value: 'setValue',
  set_file_type: 'setFileType',
  lock_all_in_file: 'lockAllInFile',
  unlock_all_in_file: 'unlockAllInFile',
  pin_field: 'pinField',
  unpin_field: 'unpinField',
  lock_field: 'lockField',
  unlock_field: 'unlockField',
};

const NOTEBOOK_CELL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: NOTEBOOK_CELL_TYPES },
    content: { type: 'string' },
    code: { type: 'string' },
    output: { type: 'string' },
    data: { type: 'string' },
    lang: { type: 'string' },
    diffs: { type: 'array', items: {} },
  },
  required: ['type'],
};

const WEBVIEW_OP_SCHEMA = {
  type: 'object',
  properties: {
    fn: { type: 'string', description: 'Canonical webview op name such as setValue or lockAllInFile' },
    input: { type: 'object', properties: {}, additionalProperties: true },
  },
  required: ['fn'],
};

const JANE_SESSION_TOOLS = [
  {
    name: 'jane_init',
    description: 'Return a compact Selva/Jane initialization payload for a fresh external coding agent. Use this first when attaching through MCP.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jane_get_instruction_pack',
    description: 'Return Jane\'s shared instruction pack for this workspace: current system prompt context, bootstrap prompt, notebook contract, and tool catalog for external coding agents.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jane_trail_list',
    description: 'List the persisted Trails for this workspace. A Trail is one long-lived Selva notebook lineage stored as a .svnb file.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jane_trail_new',
    description: 'Create a fresh Trail for this workspace, make it active, and start from an empty notebook that needs bootstrap.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional human-friendly name for the new Trail.' },
      },
    },
  },
  {
    name: 'jane_trail_fork',
    description: 'Fork the current Trail into a new Trail, keeping the current notebook lineage and dashboard state as a starting point.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional name for the forked Trail.' },
        sourceTrailId: { type: 'string', description: 'Optional source Trail id. Defaults to the current active Trail.' },
      },
    },
  },
  {
    name: 'jane_trail_switch',
    description: 'Switch the active Trail for this workspace so future Jane actions operate on that Trail.',
    inputSchema: {
      type: 'object',
      properties: {
        trailId: { type: 'string', description: 'Target Trail id to activate.' },
      },
      required: ['trailId'],
    },
  },
  {
    name: 'jane_trail_rename',
    description: 'Rename a persisted Trail. If trailId is omitted, rename the active Trail.',
    inputSchema: {
      type: 'object',
      properties: {
        trailId: { type: 'string', description: 'Optional Trail id to rename. Defaults to the active Trail.' },
        name: { type: 'string', description: 'New human-friendly name for the Trail.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'jane_trail_delete',
    description: 'Delete a persisted Trail. Cannot delete the last remaining Trail.',
    inputSchema: {
      type: 'object',
      properties: {
        trailId: { type: 'string', description: 'Trail id to delete.' },
      },
      required: ['trailId'],
    },
  },
  {
    name: 'jane_apply_ops',
    description: 'Apply Jane dashboard/configuration ops directly against the persisted Selva session. Use this for structured state changes instead of jane_session_run.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: WEBVIEW_OP_SCHEMA,
          description: 'Array of Jane/Selva dashboard ops. Use webview op names such as setValue, setFileType, pinField, lockField, lockAllInFile.',
        },
        note: {
          type: 'string',
          description: 'Optional note describing why these ops were applied.',
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'jane_add_cells',
    description: 'Create a new Jane notebook entry or append cells to an existing entry. Use this after direct tool work so the Selva UI reflects the turn as notebook cells.',
    inputSchema: {
      type: 'object',
      properties: {
        entryId: { type: 'string', description: 'Optional existing entry id to append cells to.' },
        question: { type: 'string', description: 'Prompt label for a new notebook entry. Defaults to "manual note" when omitted for a new entry.' },
        answer: { type: 'string', description: 'Optional markdown answer to prepend as a markdown cell when creating or extending an entry.' },
        summary: { type: 'string', description: 'Optional short summary for the entry.' },
        isError: { type: 'boolean', description: 'Whether this entry represents an error state.' },
        cells: {
          type: 'array',
          items: NOTEBOOK_CELL_SCHEMA,
          description: 'Notebook cells to add. Markdown explanations should usually be markdown cells, executable snippets should be python cells.',
        },
      },
      required: ['cells'],
    },
  },
  {
    name: 'jane_update_cell',
    description: 'Update or delete one persisted Jane notebook cell by id.',
    inputSchema: {
      type: 'object',
      properties: {
        entryId: { type: 'string', description: 'Notebook entry id containing the cell.' },
        cellId: { type: 'string', description: 'Notebook cell id to update or delete.' },
        delete: { type: 'boolean', description: 'When true, remove the cell instead of patching it.' },
        patch: {
          type: 'object',
          description: 'Partial cell patch. Use fields like content, code, output, data, lang, or diffs.',
          properties: {
            content: { type: 'string' },
            code: { type: 'string' },
            output: { type: 'string' },
            data: { type: 'string' },
            lang: { type: 'string' },
            diffs: { type: 'array', items: {} },
          },
          additionalProperties: true,
        },
      },
      required: ['entryId', 'cellId'],
    },
  },
  {
    name: 'jane_session_get',
    description: 'Return the persisted Jane session for this workspace, including history, entries, dashboard state, and bootstrap snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'When true, return the full persisted session instead of the compact summary.',
        },
      },
    },
  },
  {
    name: 'jane_session_set_model',
    description: 'Set Jane\'s default model for this workspace. For MCP prompting, use a direct model id such as direct:gpt-4o or direct:claude-sonnet-4-20250514.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model identifier to persist for future Jane turns' },
      },
      required: ['modelId'],
    },
  },
  {
    name: 'jane_session_set_instructions',
    description: 'Persist additional system instructions for Jane in this workspace session.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Additional system instructions appended to Jane\'s base prompt' },
      },
      required: ['text'],
    },
  },
  {
    name: 'jane_session_clear',
    description: 'Clear Jane\'s persisted session state for this workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jane_session_bootstrap',
    description: 'Run Jane\'s bootstrap initialization for this workspace and persist the resulting session snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Optional direct model id override' },
      },
    },
  },
  {
    name: 'jane_session_run',
    description: '[Deprecated] Use the MCP tools directly instead. This tool is no longer functional.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User prompt for Jane' },
        modelId: { type: 'string', description: 'Optional model id override' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'jane_session_record_entry',
    description: 'Record a completed external-agent turn into the Jane notebook/session so the Selva UI shows the markdown and python cells.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The user request or prompt for this turn.' },
        answer: { type: 'string', description: 'Markdown/text answer to render in the notebook entry.' },
        summary: { type: 'string', description: 'Optional short summary for the entry.' },
        isError: { type: 'boolean', description: 'Whether this turn ended in an error.' },
        executedCells: {
          type: 'array',
          description: 'Optional python cells to render in the notebook entry.',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Python code shown in the notebook cell.' },
              output: { type: 'string', description: 'Captured cell output, including optional IMG:<base64> tags.' },
            },
            required: ['code'],
          },
        },
        cells: {
          type: 'array',
          description: 'Optional explicit notebook cells for the entry.',
          items: NOTEBOOK_CELL_SCHEMA,
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'jane_set_bitacora',
    description: 'Append an entry to the Bitácora — Jane\'s append-only research log for the active Trail. Each entry is a timestamped record of something learned: a breakthrough, a dead end, a hypothesis, a dataset property. Start each entry with the date. This persists across sessions and helps future-you understand the project context.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'A new bitácora entry to append (not the full log — just the new entry). Start with the date.' },
      },
      required: ['text'],
    },
  },
];

const LEGACY_TOOL_ALIASES = {
  jane_session_init: 'jane_init',
  jane_get_session: 'jane_session_get',
  jane_set_model: 'jane_session_set_model',
  jane_set_additional_instructions: 'jane_session_set_instructions',
  jane_clear_session: 'jane_session_clear',
  jane_bootstrap: 'jane_session_bootstrap',
  jane_prompt: 'jane_session_run',
  jane_record_turn: 'jane_session_record_entry',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalToolName(name) {
  return LEGACY_TOOL_ALIASES[name] || name;
}

function summarizeOps(ops) {
  const count = (ops || []).length;
  return count > 0 ? `Executed ${count} operation${count > 1 ? 's' : ''}.` : 'No changes needed.';
}

function uniqueFileCountFromLockedFields(lockedFields) {
  const files = new Set();
  for (const item of (lockedFields || [])) {
    const idx = String(item || '').indexOf(':');
    files.add(idx >= 0 ? item.slice(0, idx) : String(item || ''));
  }
  files.delete('');
  return files.size;
}

function countPinnedFields(pinnedFields) {
  return Object.values(pinnedFields || {}).reduce(
    (total, list) => total + (Array.isArray(list) ? list.length : 0),
    0
  );
}

function summarizeDashboardState(dashboardState, files) {
  const fileTypes = (dashboardState && dashboardState.fileTypes) || {};
  const pinnedFields = (dashboardState && dashboardState.pinnedFields) || {};
  const lockedFields = Array.isArray(dashboardState && dashboardState.lockedFields)
    ? dashboardState.lockedFields
    : [];
  const configFiles = files.filter((file) => fileTypes[file] !== 'data');
  const dataFiles = files.filter((file) => fileTypes[file] === 'data');

  return {
    activeConfigFile: (dashboardState && dashboardState.activeConfigFile) || null,
    activeDataFile: (dashboardState && dashboardState.activeDataFile) || null,
    configFiles,
    dataFiles,
    configFileCount: configFiles.length,
    dataFileCount: dataFiles.length,
    pinnedFileCount: Object.keys(pinnedFields).length,
    pinnedFieldCount: countPinnedFields(pinnedFields),
    lockedFieldCount: lockedFields.length,
    lockedFileCount: uniqueFileCountFromLockedFields(lockedFields),
  };
}

function summarizeSessionSnapshot(session, files) {
  const safeSession = session || {};
  const dashboardState = clone(safeSession.dashboardState || createDefaultDashboardState());
  const fileList = Array.isArray(files) ? files.slice() : [];
  const dashboardSummary = summarizeDashboardState(dashboardState, fileList);
  const activeTrail = safeSession.configDir ? getActiveTrail(safeSession.configDir) : null;

  return {
    sessionId: String(safeSession.trailId || sessionIdForConfigDir(safeSession.configDir || '')),
    trailId: activeTrail && activeTrail.id ? activeTrail.id : String(safeSession.trailId || ''),
    trailName: activeTrail && activeTrail.name ? activeTrail.name : String(safeSession.trailName || 'Trail'),
    trailPath: activeTrail && activeTrail.path ? activeTrail.path : null,
    bootstrapDone: !!(safeSession.bootstrap && safeSession.bootstrap.done),
    panelOpen: hasOpenPanelSession(safeSession),
    agentModelId: safeSession.agentModelId || '',
    additionalInstructions: safeSession.additionalInstructions || '',
    sessionTokens: safeSession.sessionTokens || 0,
    lastQuestion: safeSession.lastQuestion || '',
    conversationTurnCount: Math.floor(((safeSession.conversationHistory || []).length || 0) / 2),
    entryCount: Array.isArray(safeSession.entries) ? safeSession.entries.length : 0,
    pendingDraftCount: Array.isArray(safeSession.pendingExternalDrafts) ? safeSession.pendingExternalDrafts.length : 0,
    updatedAt: safeSession.updatedAt || null,
    dashboardState: dashboardSummary,
  };
}

function listWebviewActionTools(extensionPath) {
  return loadAllTools(extensionPath)
    .filter((tool) => tool.context === 'webview')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      context: tool.context,
    }));
}

function normalizeJaneOpName(name) {
  return WEBVIEW_OP_ALIASES[String(name || '').trim()] || String(name || '').trim();
}

function coerceJaneOps(ops, extensionPath) {
  const allowedNames = new Set(listWebviewActionTools(extensionPath).map((tool) => tool.name));
  return (ops || []).map((op) => {
    const fn = normalizeJaneOpName(op && op.fn);
    if (!fn || !allowedNames.has(fn)) {
      throw new Error(`Unsupported Jane op: ${op && op.fn ? op.fn : '(missing fn)'}`);
    }
    return {
      fn,
      input: clone((op && op.input) || {}),
    };
  });
}

function buildToolCatalog({ extensionPath, workspaceRuntime }) {
  return {
    jane: JANE_SESSION_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    dashboardOps: listWebviewActionTools(extensionPath).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    workspace: workspaceRuntime.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  };
}

function buildInstructionPack({ configDir, extensionPath, workspaceRuntime, session }) {
  const activeSession = session || loadJaneSession(configDir);
  const activeTrail = getActiveTrail(configDir);
  const systemTemplate = fs.readFileSync(path.join(extensionPath, 'ecosystem', 'prompts', 'SYSTEM.md'), 'utf8');
  const bootstrapPrompt = fs.readFileSync(path.join(extensionPath, 'ecosystem', 'prompts', 'INIT.md'), 'utf8');

  return {
    version: 1,
    sessionId: String(activeSession.trailId || sessionIdForConfigDir(configDir)),
    trail: activeTrail,
    configDir,
    summary: 'Jane is Selva\'s persisted runtime/session inside the active Trail. Use workspace tools, jane_apply_ops, notebook cell APIs, and trail controls.',
    preferredFlow: [
      'jane_init',
      'jane_get_instruction_pack',
      'jane_trail_list',
      activeSession.bootstrap && activeSession.bootstrap.done ? 'jane_session_get' : 'jane_session_bootstrap',
      'jane_apply_ops',
      'jane_add_cells',
      'jane_update_cell',
    ],
    notebookContract: [
      'Treat Selva as the source of truth for notebook entries, cells, dashboard state, and staged YAML edits.',
      'Use jane_add_cells to create notebook-visible markdown/python cells after direct workspace tool calls.',
      'Use jane_update_cell to revise or delete persisted notebook cells by id.',
      'Use jane_apply_ops for dashboard ops such as setValue, setFileType, pinField, and lockAllInFile.',
      'Use jane_trail_new and jane_trail_switch to move between long-lived Selva notebook lineages for the same workspace.',
      'Python execution is stateful within the active Trail. Reuse that state when helpful, but load large file-backed data in code instead of prompt context.',
    ],
    prompts: {
      systemTemplate,
      bootstrapPrompt,
      additionalInstructions: activeSession.additionalInstructions || '',
      bitacora: activeSession.bitacora || '',
    },
    toolCatalog: buildToolCatalog({ extensionPath, workspaceRuntime }),
  };
}

function sanitizeNotebookCell(cell) {
  return normalizeNotebookCell(cell);
}

function coerceArrayArgument(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeCellsForHistory(cells, fallback = '') {
  const markdown = (cells || [])
    .filter((cell) => cell && cell.type === 'markdown' && cell.content)
    .map((cell) => String(cell.content).trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (markdown) return markdown;
  return String(fallback || '').trim() || '[Notebook cells updated]';
}

function ensureEntryCells(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.cells) && entry.cells.length > 0) {
    return entry.cells.map((cell) => sanitizeNotebookCell(cell)).filter(Boolean);
  }

  const cells = [];
  const answerText = String(entry.answer || entry.summary || '').trim();
  if (answerText) {
    cells.push(sanitizeNotebookCell({ type: 'markdown', content: answerText, author: 'jane' }));
  }
  for (const executedCell of (entry.executedCells || [])) {
    const normalized = sanitizeNotebookCell({
      type: 'python',
      code: executedCell.code || '',
      output: executedCell.output || '',
      author: 'jane',
    });
    if (normalized) cells.push(normalized);
  }
  entry.cells = cells;
  return entry.cells;
}

function materializeRecordedEntryCells({ answer = '', summary = '', executedCells = [], explicitCells } = {}) {
  const now = new Date().toISOString();
  if (Array.isArray(explicitCells)) {
    return explicitCells.map((c) => {
      const cell = sanitizeNotebookCell(c);
      if (cell && !cell.author) cell.author = 'jane';
      if (cell && !cell.createdAt) cell.createdAt = now;
      return cell;
    }).filter(Boolean);
  }

  const cells = [];
  const markdown = String(answer || summary || '').trim();
  if (markdown) {
    const mdCell = sanitizeNotebookCell({ type: 'markdown', content: markdown, author: 'jane', createdAt: now });
    if (mdCell) cells.push(mdCell);
  }

  for (const executedCell of (executedCells || [])) {
    const pyCell = sanitizeNotebookCell({
      type: 'python',
      code: executedCell.code || '',
      output: executedCell.output || '',
      runState: 'pending',
      author: 'jane',
      createdAt: now,
    });
    if (pyCell) cells.push(pyCell);
  }

  return cells;
}

async function materializePythonNotebookOutputs(cells, {
  configDir,
  extensionPath,
  execFileAsync = defaultExecFileAsync,
  trailId = '',
} = {}) {
  const normalized = (cells || []).map((cell) => clone(cell));
  const effectiveTrailId = String(trailId || (loadJaneSession(configDir).trailId || ''));
  for (const cell of normalized) {
    if (!cell || cell.type !== 'python') continue;
    if (!String(cell.code || '').trim()) continue;
    cell.runState = normalizePythonRunState(cell.runState, cell.output);
    if (cell.runState === 'done' || cell.runState === 'error') continue;
    try {
      cell.output = await executeNotebookCell({
        language: 'python',
        code: cell.code,
        configDir,
        extensionPath,
        execFileAsync,
        trailId: effectiveTrailId,
      });
      cell.runState = looksLikePythonExecutionError(cell.output) ? 'error' : 'done';
    } catch (error) {
      cell.output = `Execution error: ${error.message || String(error)}`;
      cell.runState = 'error';
    }
  }
  return normalized;
}

function parsedRootKeys(parsed) {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) {
    return parsed
      .flatMap((item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : []))
      .map(String);
  }
  if (typeof parsed === 'object') return Object.keys(parsed).map(String);
  return [];
}

function classifyFileHeuristically(file, parsed) {
  const lower = String(file || '').toLowerCase();
  const base = path.basename(lower);
  const keys = new Set(parsedRootKeys(parsed));

  if (lower.includes('hepdata') || lower.includes('/figure_') || lower.startsWith('figure_')) {
    return 'data';
  }
  if (base === 'submission.yaml' || base === 'submission.yml') {
    return 'data';
  }
  if (keys.has('independent_variables') || keys.has('dependent_variables')) {
    return 'data';
  }
  return 'config';
}

function buildDeterministicBootstrapPlan(workspaceRuntime) {
  const files = workspaceRuntime.discoverYamlFiles();
  const ops = [];
  const configFiles = [];
  const dataFiles = [];

  for (const file of files) {
    const { parsed } = workspaceRuntime.readYaml(file);
    const fileType = classifyFileHeuristically(file, parsed);
    ops.push({
      fn: 'setFileType',
      input: { file, fileType },
    });
    if (fileType === 'data') {
      ops.push({
        fn: 'lockAllInFile',
        input: { file },
      });
      dataFiles.push(file);
    } else {
      configFiles.push(file);
    }
  }

  return {
    files,
    ops,
    configFiles,
    dataFiles,
    answer: `Initialized Selva with ${configFiles.length} config file${configFiles.length === 1 ? '' : 's'} and ${dataFiles.length} data file${dataFiles.length === 1 ? '' : 's'}. Locked all data files using deterministic workspace classification.`,
  };
}

function buildWorkspaceSchemata(workspaceRuntime) {
  return workspaceRuntime.discoverYamlFiles().map((file) => {
    const { parsed } = workspaceRuntime.readYaml(file);
    return {
      file,
      fields: buildSchema(file, parsed).fields,
    };
  });
}

function createSessionEntry({ question, answer, summary, executedCells, cells, isError }) {
  return {
    question: question || '',
    answer: answer || '',
    summary: summary || '',
    executedCells: Array.isArray(executedCells) ? executedCells : [],
    cells: Array.isArray(cells) ? cells : undefined,
    isError: !!isError,
    timestamp: new Date().toISOString(),
  };
}

function extractDraftValueOps(ops) {
  return (ops || [])
    .filter((op) => op && op.fn === 'setValue' && op.input && op.input.file && op.input.path)
    .map((op) => ({
      fn: 'setValue',
      input: clone(op.input),
    }));
}

function createJaneRuntime({ configDir, extensionPath, workspaceRuntime }) {
  // NOTE: The built-in agent (runSessionAction) has been removed.
  // Jane is always Claude Code connected via MCP.
  // The internal agent functions (resolveExecutionContext, runAgentRequest,
  // buildSystemPrompt, etc.) lived in lib/agent-core.js which has been deleted.

  // MCP trail independence: Jane (via MCP) can operate on a different trail
  // than the one the human is viewing in the webview. The webview's active
  // trail is controlled by index.json activeTrailId. Jane's trail is tracked
  // here in-memory and never written to index.json.
  let mcpTrailId = '';

  return {
    listSessionTools() {
      return JANE_SESSION_TOOLS;
    },

    isSessionTool(name) {
      const canonicalName = canonicalToolName(name);
      return JANE_SESSION_TOOLS.some((tool) => tool.name === canonicalName);
    },

    async handleSessionToolCall(name, args = {}, options = {}) {
      const canonicalName = canonicalToolName(name);
      const isMcp = !!options.mcpOrigin;
      // When called from MCP, trail operations don't change the webview's
      // active trail. They update Jane's in-memory mcpTrailId instead.
      switch (canonicalName) {
        case 'jane_init': {
          // On init, set mcpTrailId to the current active trail
          if (isMcp) {
            const activeTrail = getActiveTrail(configDir);
            if (activeTrail) mcpTrailId = activeTrail.id;
          }
          return this.buildInitPayload();
        }
        case 'jane_get_instruction_pack':
          return this.getInstructionPack();
        case 'jane_trail_list':
          return this.listTrails();
        case 'jane_trail_new': {
          const result = this.createTrail(args);
          if (isMcp) mcpTrailId = result.activeTrail && result.activeTrail.id || '';
          return result;
        }
        case 'jane_trail_fork': {
          const result = this.forkTrail(args);
          if (isMcp) mcpTrailId = result.activeTrail && result.activeTrail.id || '';
          return result;
        }
        case 'jane_trail_switch':
          return this.switchTrail(args, { updateIndex: !isMcp });
        case 'jane_trail_rename':
          return this.renameTrail(args);
        case 'jane_trail_delete':
          return this.deleteTrail(args);
        case 'jane_apply_ops':
          return this.applyOps(args);
        case 'jane_add_cells':
          return this.addCells(args, options);
        case 'jane_update_cell':
          return this.updateCell(args);
        case 'jane_session_get':
          return args.verbose
            ? this.getSession(isMcp ? mcpTrailId : null)
            : this.getSessionSummary(isMcp ? mcpTrailId : null);
        case 'jane_session_set_model':
          this.setSessionModel(args.modelId || '', isMcp ? mcpTrailId : null);
          return this.getSessionSummary(isMcp ? mcpTrailId : null);
        case 'jane_session_set_instructions':
          this.setSessionInstructions(args.text || '', isMcp ? mcpTrailId : null);
          return this.getSessionSummary(isMcp ? mcpTrailId : null);
        case 'jane_set_bitacora':
          this.setBitacora(args.text || '', isMcp ? mcpTrailId : null);
          return { ok: true, bitacora: args.text || '' };
        case 'jane_session_clear':
          this.clearSession();
          return this.getSessionSummary(isMcp ? mcpTrailId : null);
        case 'jane_session_bootstrap':
          return this.bootstrapSession({
            modelId: args.modelId || '',
            ...options,
          });
        case 'jane_session_run':
          throw new Error('jane_session_run is deprecated. Use the MCP tools directly — you are Jane.');
        case 'jane_session_record_entry':
          return this.recordExternalEntry(args, options);
        default:
          throw new Error(`Unknown Jane session tool: ${name}`);
      }
    },

    // MCP trail independence API
    getMcpTrailId() { return mcpTrailId; },
    setMcpTrailId(id) { mcpTrailId = String(id || ''); },

    getSession(trailId) {
      return loadJaneSession(configDir, trailId || null);
    },

    // Get the session for the MCP trail (or fall back to active trail)
    getMcpSession() {
      return loadJaneSession(configDir, mcpTrailId || null);
    },

    getSessionSummary(trailId) {
      const session = loadJaneSession(configDir, trailId || null);
      const files = workspaceRuntime.discoverYamlFiles();
      return summarizeSessionSnapshot(session, files);
    },

    getInstructionPack() {
      return buildInstructionPack({
        configDir,
        extensionPath,
        workspaceRuntime,
        session: loadJaneSession(configDir),
      });
    },

    listTrails() {
      return {
        activeTrail: getActiveTrail(configDir),
        trails: listJaneTrails(configDir),
      };
    },

    buildInitPayload() {
      const session = loadJaneSession(configDir);
      const trailState = this.listTrails();
      const files = workspaceRuntime.discoverYamlFiles();
      const sessionSummary = summarizeSessionSnapshot(session, files);
      const dashboardState = sessionSummary.dashboardState;
      return {
        configDir,
        sessionId: String(session.trailId || sessionIdForConfigDir(configDir)),
        trailId: session.trailId || '',
        trailName: session.trailName || 'Trail',
        activeTrail: trailState.activeTrail,
        trails: trailState.trails,
        trailCount: trailState.trails.length,
        bootstrapDone: !!(session.bootstrap && session.bootstrap.done),
        needsBootstrap: !(session.bootstrap && session.bootstrap.done),
        panelOpen: hasOpenPanelSession(session),
        fileCount: files.length,
        configFileCount: dashboardState.configFileCount,
        dataFileCount: dashboardState.dataFileCount,
        files,
        activeConfigFile: dashboardState.activeConfigFile || null,
        activeDataFile: dashboardState.activeDataFile || null,
        pendingDraftCount: (session.pendingExternalDrafts || []).length,
        dashboardState,
        sessionSummary,
        availableTools: {
          jane: JANE_SESSION_TOOLS.map((tool) => tool.name),
          dashboardOps: listWebviewActionTools(extensionPath).map((tool) => tool.name),
          workspace: workspaceRuntime.listTools().map((tool) => ({ name: tool.name, description: tool.description })),
        },
        recommendedFirstCalls: [
          'jane_init',
          'jane_trail_list',
          !(session.bootstrap && session.bootstrap.done) ? 'jane_session_bootstrap' : 'jane_session_get',
        ],
      };
    },

    createTrail(args = {}) {
      const result = createJaneTrail(configDir, { name: args.name || '' });
      silentGitCommit(configDir, `Trail "${result.trail && result.trail.name || 'new'}": created`);
      return {
        ok: true,
        activeTrail: result.trail,
        trails: result.trails,
        needsBootstrap: !(result.session.bootstrap && result.session.bootstrap.done),
        session: summarizeSessionSnapshot(result.session, workspaceRuntime.discoverYamlFiles()),
      };
    },

    forkTrail(args = {}) {
      const result = forkJaneTrail(configDir, {
        name: args.name || '',
        sourceTrailId: args.sourceTrailId || '',
      });
      silentGitCommit(configDir, `Trail "${result.trail && result.trail.name || 'fork'}": forked`);
      return {
        ok: true,
        activeTrail: result.trail,
        trails: result.trails,
        needsBootstrap: !(result.session.bootstrap && result.session.bootstrap.done),
        session: summarizeSessionSnapshot(result.session, workspaceRuntime.discoverYamlFiles()),
      };
    },

    switchTrail(args = {}, options = {}) {
      const updateIndex = options.updateIndex !== false;
      const result = switchJaneTrail(configDir, args.trailId || '', { updateIndex });
      // If MCP-originated (updateIndex=false), update in-memory MCP trail pointer
      if (!updateIndex) {
        mcpTrailId = args.trailId || '';
      }
      return {
        ok: true,
        activeTrail: result.trail,
        trails: result.trails,
        needsBootstrap: !(result.session.bootstrap && result.session.bootstrap.done),
        session: summarizeSessionSnapshot(result.session, workspaceRuntime.discoverYamlFiles()),
      };
    },

    renameTrail(args = {}) {
      const result = renameJaneTrail(configDir, {
        trailId: args.trailId || '',
        name: args.name || '',
      });
      return {
        ok: true,
        activeTrail: getActiveTrail(configDir),
        trails: result.trails,
        needsBootstrap: !(result.session.bootstrap && result.session.bootstrap.done),
        session: summarizeSessionSnapshot(result.session, workspaceRuntime.discoverYamlFiles()),
      };
    },

    deleteTrail(args = {}) {
      const result = deleteJaneTrail(configDir, args.trailId || '');
      silentGitCommit(configDir, `Trail "${args.trailId || ''}": deleted`);
      return {
        ok: true,
        activeTrail: result.trail,
        trails: result.trails,
      };
    },

    setSessionModel(modelId, trailId) {
      const opts = {};
      if (trailId) opts.trailId = trailId;
      return updateJaneSession(configDir, (session) => {
        session.agentModelId = modelId || '';
        return session;
      }, opts);
    },

    setSessionInstructions(text, trailId) {
      const opts = {};
      if (trailId) opts.trailId = trailId;
      return updateJaneSession(configDir, (session) => {
        session.additionalInstructions = text || '';
        return session;
      }, opts);
    },

    getBitacora(trailId) {
      const session = loadJaneSession(configDir, trailId || null);
      return session.bitacora || '';
    },

    setBitacora(text, trailId) {
      const opts = {};
      if (trailId) opts.trailId = trailId;
      return updateJaneSession(configDir, (session) => {
        const newEntry = String(text || '').trim();
        if (!newEntry) return session;
        const existing = String(session.bitacora || '').trim();
        session.bitacora = existing
          ? existing + '\n\n' + newEntry
          : newEntry;
        return session;
      }, opts);
    },

    clearSession() {
      clearJaneSession(configDir);
      return { ok: true };
    },

    applyOps(args = {}) {
      const ops = coerceJaneOps(args.ops || [], extensionPath);
      const note = String(args.note || '').trim();
      const panelOpen = hasOpenPanelSession(loadJaneSession(configDir));

      let persisted = updateJaneSession(configDir, (session) => {
        const afterOps = applyWebviewOpsToSession({
          session,
          ops,
          runtime: workspaceRuntime,
          persistConfigChanges: !panelOpen,
        });
        return afterOps.session;
      });

      if (panelOpen && ops.length > 0) {
        persisted = enqueueExternalDraft(configDir, {
          source: 'jane_apply_ops',
          note: note || 'Applied Jane ops in the open Selva panel.',
          ops,
        });
      }

      return {
        ok: true,
        summary: summarizeOps(ops),
        ops,
        session: summarizeSessionSnapshot(persisted, workspaceRuntime.discoverYamlFiles()),
      };
    },

    replaceSessionEntries(entries) {
      return replaceJaneEntries(configDir, entries);
    },

    async addCells(args = {}, executionOptions = {}) {
      const rawCells = coerceArrayArgument(args.cells);
      let cells = rawCells.map(sanitizeNotebookCell).filter(Boolean);
      const answer = String(args.answer || '').trim();
      if (answer) {
        const markdownCell = sanitizeNotebookCell({ type: 'markdown', content: answer });
        if (markdownCell) cells.unshift(markdownCell);
      }
      const effectiveTrailId = (executionOptions.mcpOrigin && mcpTrailId) || loadJaneSession(configDir).trailId || '';
      cells = await materializePythonNotebookOutputs(cells, {
        configDir,
        extensionPath,
        execFileAsync: executionOptions.execFileAsync || defaultExecFileAsync,
        trailId: effectiveTrailId,
      });
      if (cells.length === 0) {
        throw new Error('jane_add_cells requires at least one valid notebook cell.');
      }

      let createdEntryId = '';
      let createdNewEntry = false;
      const question = String(args.question || '').trim();
      const summary = String(args.summary || '').trim();
      const isError = !!args.isError;
      const targetEntryId = String(args.entryId || '').trim();

      const updateOptions = {};
      if (executionOptions.mcpOrigin && mcpTrailId) updateOptions.trailId = mcpTrailId;
      const persisted = updateJaneSession(configDir, (session) => {
        let targetEntry = targetEntryId
          ? (session.entries || []).find((entry) => String(entry.id || '') === targetEntryId)
          : null;

        if (targetEntryId && !targetEntry) {
          // Entry ID is stale (user may have edited the notebook while the agent was working).
          // Fall through to create a new entry instead of failing.
          targetEntry = null;
        }

        if (!targetEntry) {
          createdNewEntry = true;
          targetEntry = createSessionEntry({
            question: question || 'manual note',
            answer: '',
            summary,
            executedCells: [],
            cells,
            isError,
          });
          session.entries.push(targetEntry);
          createdEntryId = String(targetEntry.id || '');
          session.lastQuestion = question || session.lastQuestion;
          if (question || answer || summary) {
            session.conversationHistory.push(
              { role: 'user', content: question || 'manual note' },
              { role: 'assistant', content: summarizeCellsForHistory(cells, summary || answer) }
            );
          }
          return session;
        }

        const existingCells = ensureEntryCells(targetEntry);
        targetEntry.cells = [...existingCells, ...cells];
        if (question && !targetEntry.question) targetEntry.question = question;
        if (summary) targetEntry.summary = summary;
        if (isError) targetEntry.isError = true;
        createdEntryId = String(targetEntry.id || '');
        return session;
      }, updateOptions);

      const entry = createdEntryId
        ? ((persisted.entries || []).find((item) => String(item.id || '') === createdEntryId) || null)
        : (createdNewEntry ? (persisted.entries[persisted.entries.length - 1] || null) : null);
      return {
        ok: true,
        entry,
        session: summarizeSessionSnapshot(persisted, workspaceRuntime.discoverYamlFiles()),
      };
    },

    updateCell(args = {}) {
      const entryId = String(args.entryId || '').trim();
      const cellId = String(args.cellId || '').trim();
      if (!entryId || !cellId) {
        throw new Error('jane_update_cell requires both entryId and cellId.');
      }

      let updatedEntry = null;
      const persisted = updateJaneSession(configDir, (session) => {
        const entry = (session.entries || []).find((item) => String(item.id || '') === entryId);
        if (!entry) {
          // Entry ID is stale — notebook was modified while the agent held a reference.
          return session;
        }

        const cells = ensureEntryCells(entry);
        const idx = cells.findIndex((cell) => String(cell.id || '') === cellId);
        if (idx < 0) {
          // Cell ID is stale — cell was deleted or moved while the agent held a reference.
          return session;
        }

        if (args.delete) {
          cells.splice(idx, 1);
        } else {
          const patch = args.patch && typeof args.patch === 'object' ? clone(args.patch) : {};
          const currentCell = clone(cells[idx]);
          const nextCell = sanitizeNotebookCell({ ...currentCell, ...patch, id: currentCell.id });
          if (!nextCell) {
            throw new Error(`Invalid notebook cell patch for ${cellId}`);
          }
          cells[idx] = nextCell;
        }

        entry.cells = cells;
        updatedEntry = entry;
        return session;
      });

      return {
        ok: true,
        entry: updatedEntry || ((persisted.entries || []).find((item) => String(item.id || '') === entryId) || null),
        session: summarizeSessionSnapshot(persisted, workspaceRuntime.discoverYamlFiles()),
      };
    },

    bootstrapSession(options = {}) {
      return this.bootstrapSessionDeterministically(options);
    },

    bootstrapSessionDeterministically(options = {}) {
      const plan = buildDeterministicBootstrapPlan(workspaceRuntime);
      let persisted = updateJaneSession(configDir, (current) => {
        const afterOps = applyWebviewOpsToSession({
          session: current,
          ops: plan.ops,
          runtime: workspaceRuntime,
          persistConfigChanges: false,
        }).session;
        current.dashboardState = afterOps.dashboardState;
        current.dashboardState.activeConfigFile = current.dashboardState.activeConfigFile || plan.configFiles[0] || null;
        current.dashboardState.activeDataFile = current.dashboardState.activeDataFile || plan.dataFiles[0] || null;
        current.bootstrap = {
          done: true,
          answer: plan.answer,
          ops: plan.ops,
        };
        current.conversationHistory.push(
          { role: 'user', content: BOOTSTRAP_HISTORY_PROMPT },
          { role: 'assistant', content: plan.answer }
        );
        current.entries.push(createSessionEntry({
          question: 'session initialized',
          answer: plan.answer,
          summary: summarizeOps(plan.ops),
          executedCells: [],
          isError: false,
        }));
        return current;
      });

      return {
        modelId: options.modelId || loadJaneSession(configDir).agentModelId || '',
        answer: plan.answer,
        summary: summarizeOps(plan.ops),
        executedCells: [],
        ops: plan.ops,
        usage: { input: 0, output: 0 },
        error: null,
        session: persisted,
        entry: persisted.entries[persisted.entries.length - 1] || null,
        artifacts: {
          cells: [],
          ops: plan.ops,
          summary: summarizeOps(plan.ops),
        },
      };
    },

    async recordExternalEntry(args = {}, executionOptions = {}) {
      const question = args.question || '';
      const answer = args.answer || '';
      const summary = args.summary || '';
      const isError = !!args.isError;
      const executedCellArgs = coerceArrayArgument(args.executedCells);
      const explicitCellArgs = coerceArrayArgument(args.cells);
      const executedCells = executedCellArgs
          .filter((cell) => cell && typeof cell.code === 'string' && cell.code.trim())
          .map((cell) => ({
            code: cell.code,
            output: typeof cell.output === 'string' ? cell.output : '',
          }))
      const cells = await materializePythonNotebookOutputs(materializeRecordedEntryCells({
        answer,
        summary,
        executedCells,
        explicitCells: explicitCellArgs.length > 0 ? explicitCellArgs : undefined,
      }), {
        configDir,
        extensionPath,
        execFileAsync: executionOptions.execFileAsync || defaultExecFileAsync,
        trailId: loadJaneSession(configDir).trailId || '',
      });

      const persisted = updateJaneSession(configDir, (session) => {
        session.lastQuestion = question;
        if (question || answer) {
          session.conversationHistory.push(
            { role: 'user', content: question || '' },
            { role: 'assistant', content: answer || summary || summarizeCellsForHistory(cells) }
          );
        }
        session.entries.push(createSessionEntry({
          question,
          answer,
          summary,
          executedCells,
          cells,
          isError,
        }));
        return session;
      });

      return {
        ok: true,
        entry: persisted.entries[persisted.entries.length - 1] || null,
        session: summarizeSessionSnapshot(persisted, workspaceRuntime.discoverYamlFiles()),
      };
    },
  };
}

module.exports = {
  BOOTSTRAP_HISTORY_PROMPT,
  JANE_SESSION_TOOLS,
  LEGACY_TOOL_ALIASES,
  canonicalToolName,
  createJaneRuntime,
  summarizeOps,
};
