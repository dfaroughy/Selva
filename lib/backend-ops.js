const {
  buildSchema,
  getNestedValue,
  setNestedValue,
} = require('./selva-runtime');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(pathArr) {
  return (pathArr || []).map((item) => String(item));
}

function lockKey(file, pathArr) {
  return `${file}:${JSON.stringify(normalizePath(pathArr))}`;
}

function ensureDashboardState(session) {
  if (!session.dashboardState) {
    session.dashboardState = {
      fileTypes: {},
      lockedFields: [],
      pinnedFields: {},
      activeConfigFile: null,
      activeDataFile: null,
    };
  }
  if (!session.dashboardState.fileTypes) session.dashboardState.fileTypes = {};
  if (!session.dashboardState.lockedFields) session.dashboardState.lockedFields = [];
  if (!session.dashboardState.pinnedFields) session.dashboardState.pinnedFields = {};
  return session.dashboardState;
}

function ensurePinnedFile(dashboardState, file) {
  if (!dashboardState.pinnedFields[file]) dashboardState.pinnedFields[file] = [];
  return dashboardState.pinnedFields[file];
}

function ensureUniquePinned(list, pathArr) {
  const pathJson = JSON.stringify(normalizePath(pathArr));
  if (!list.some((item) => JSON.stringify(normalizePath(item)) === pathJson)) {
    list.push(normalizePath(pathArr));
  }
}

function readFileFieldPaths(runtime, file) {
  const { parsed } = runtime.readYaml(file);
  return buildSchema(file, parsed).fields.map((field) => field.path);
}

function applyWebviewOpsToSession({ session, ops, runtime, persistConfigChanges = false }) {
  const next = clone(session);
  const dashboardState = ensureDashboardState(next);
  const diffs = [];

  for (const op of (ops || [])) {
    const input = op.input || {};
    switch (op.fn) {
      case 'setFileType':
        if (input.file && input.fileType) {
          dashboardState.fileTypes[input.file] = input.fileType;
        }
        break;

      case 'pinField':
        if (input.file && input.path) {
          const pinned = ensurePinnedFile(dashboardState, input.file);
          ensureUniquePinned(pinned, input.path);
        }
        break;

      case 'unpinField':
        if (input.file && input.path) {
          const pathJson = JSON.stringify(normalizePath(input.path));
          const pinned = ensurePinnedFile(dashboardState, input.file);
          dashboardState.pinnedFields[input.file] = pinned.filter(
            (item) => JSON.stringify(normalizePath(item)) !== pathJson
          );
        }
        break;

      case 'lockField':
        if (input.file && input.path) {
          const key = lockKey(input.file, input.path);
          if (!dashboardState.lockedFields.includes(key)) {
            dashboardState.lockedFields.push(key);
          }
        }
        break;

      case 'unlockField':
        if (input.file && input.path) {
          const key = lockKey(input.file, input.path);
          dashboardState.lockedFields = dashboardState.lockedFields.filter((item) => item !== key);
        }
        break;

      case 'lockAllInFile':
        if (input.file) {
          for (const fieldPath of readFileFieldPaths(runtime, input.file)) {
            const key = lockKey(input.file, fieldPath);
            if (!dashboardState.lockedFields.includes(key)) {
              dashboardState.lockedFields.push(key);
            }
          }
        }
        break;

      case 'unlockAllInFile':
        if (input.file) {
          const prefix = `${input.file}:`;
          dashboardState.lockedFields = dashboardState.lockedFields.filter((item) => !item.startsWith(prefix));
        }
        break;

      case 'setValue':
        if (persistConfigChanges && input.file && input.path) {
          const { parsed } = runtime.readYaml(input.file);
          const pathArr = normalizePath(input.path);
          const existing = getNestedValue(parsed, pathArr);
          if (existing !== undefined) {
            let coerced = input.value;
            if (typeof existing === 'number' && typeof input.value !== 'number') {
              const num = Number(input.value);
              coerced = Number.isNaN(num) ? input.value : num;
            } else if (typeof existing === 'boolean' && typeof input.value !== 'boolean') {
              coerced = String(input.value).toLowerCase() === 'true';
            }
            diffs.push({ file: input.file, path: pathArr, oldVal: existing, newVal: coerced });
            setNestedValue(parsed, pathArr, coerced);
            runtime.writeYaml(input.file, parsed);
          }
        }
        break;

      default:
        break;
    }
  }

  return { session: next, diffs };
}

module.exports = {
  applyWebviewOpsToSession,
  lockKey,
  normalizePath,
};
