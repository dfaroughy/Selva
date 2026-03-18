const { promisify } = require('util');
const { execFile } = require('child_process');

const { loadAllTools, loadExtensionTool } = require('./selva-runtime');
const { prepareNotebookPythonExecution } = require('./notebook-python');

const defaultExecFileAsync = promisify(execFile);
const DEFAULT_NOTEBOOK_LANGUAGE = 'python';
const NOTEBOOK_LANGUAGE_ALIASES = Object.freeze({
  py: 'python',
  python: 'python',
  execute_python: 'python',
});

function normalizeNotebookLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_NOTEBOOK_LANGUAGE;
  return NOTEBOOK_LANGUAGE_ALIASES[normalized] || normalized;
}

function normalizeNotebookExecutionRequest(request = {}) {
  return {
    language: normalizeNotebookLanguage(request.language),
    code: String(request.code || ''),
    configDir: request.configDir,
    extensionPath: request.extensionPath,
    execFileAsync: request.execFileAsync || defaultExecFileAsync,
    panel: request.panel,
    trailId: String(request.trailId || ''),
  };
}

async function executePythonNotebookCell({
  code,
  configDir,
  extensionPath,
  execFileAsync = defaultExecFileAsync,
  panel,
}) {
  const allTools = loadAllTools(extensionPath);
  const pythonTool = allTools.find(
    (tool) => tool.name === 'execute_python' && tool.context === 'extension'
  );
  if (!pythonTool) {
    throw new Error('execute_python tool not found');
  }

  const handler = loadExtensionTool(pythonTool);
  return handler(
    { code: prepareNotebookPythonExecution(code) },
    { execFileAsync, configDir, panel }
  );
}

const NOTEBOOK_RUNTIME_EXECUTORS = Object.freeze({
  python: executePythonNotebookCell,
});

async function executeNotebookCell(request = {}) {
  const normalized = normalizeNotebookExecutionRequest(request);
  const executor = NOTEBOOK_RUNTIME_EXECUTORS[normalized.language];
  if (!executor) {
    throw new Error(`Notebook runtime not found for language: ${normalized.language}`);
  }
  return executor(normalized);
}

module.exports = {
  normalizeNotebookLanguage,
  normalizeNotebookExecutionRequest,
  executeNotebookCell,
};
