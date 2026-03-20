const { promisify } = require('util');
const { execFile } = require('child_process');

const { loadAllTools, loadExtensionTool } = require('./selva-runtime');
const { prepareNotebookPythonExecution } = require('./notebook-python');
const {
  getNotebookKernelManager,
  disposeNotebookRuntimesForConfigDir,
  disposeAllNotebookRuntimes,
} = require('./kernel-manager');

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
    onStream: request.onStream || null,
  };
}

async function executePythonNotebookCell({
  code,
  configDir,
  extensionPath,
  execFileAsync = defaultExecFileAsync,
  panel,
  trailId = '',
  onStream = null,
}) {
  const kernelManager = getNotebookKernelManager();
  const kernelResult = await kernelManager.execute({
    language: 'python',
    configDir,
    trailId,
    code,
    onStream,
  });

  if (!kernelResult.ok) {
    if (kernelResult.stdout || kernelResult.stderr) {
      return (`Error (exit 1):\n${kernelResult.stderr || ''}\n${kernelResult.stdout || ''}`).trim();
    }
    throw new Error('Python notebook kernel execution failed');
  }

  let result = kernelResult.stdout || '';
  if (kernelResult.stderr) {
    result += (result ? '\n' : '') + 'STDERR: ' + kernelResult.stderr;
  }
  return result || '(no output)';
}

async function executePythonNotebookCellOneShot({
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
  try {
    return await executor(normalized);
  } catch (error) {
    if (normalized.language !== 'python') throw error;
    return executePythonNotebookCellOneShot(normalized);
  }
}

module.exports = {
  normalizeNotebookLanguage,
  normalizeNotebookExecutionRequest,
  executeNotebookCell,
  disposeNotebookRuntimesForConfigDir,
  disposeAllNotebookRuntimes,
};
