const { getNotebookKernelManager } = require('../../../lib/kernel-manager');

async function executeWithKernel({ code, configDir, taskId }) {
  const kernelResult = await getNotebookKernelManager().execute({
    language: 'python',
    configDir,
    taskId,
    code,
  });

  if (!kernelResult.ok) {
    if (kernelResult.stdout || kernelResult.stderr) {
      return (`Error (exit 1):\n${kernelResult.stderr || ''}\n${kernelResult.stdout || ''}`).trim();
    }
    throw new Error('Python kernel execution failed');
  }

  let result = kernelResult.stdout || '';
  if (kernelResult.stderr) {
    result += (result ? '\n' : '') + 'STDERR: ' + kernelResult.stderr;
  }
  return result || '(no output)';
}

// Extension context — this module is require'd by extension.js
// Returns an async handler function
module.exports = async function(input, context) {
  const { execFileAsync, configDir, taskId } = context;
  const code = input.code;
  const inputData = input.input_data ? JSON.stringify(input.input_data) : '';
  try {
    if (taskId && !inputData) {
      return await executeWithKernel({
        code,
        configDir,
        taskId: String(taskId || ''),
      });
    }
    const { stdout, stderr } = await execFileAsync('python3', ['-c', code], {
      input: inputData,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: configDir,
    });
    let result = stdout || '';
    if (stderr) result += (result ? '\n' : '') + 'STDERR: ' + stderr;
    return result || '(no output)';
  } catch (e) {
    if (e.stdout || e.stderr) {
      return ('Error (exit ' + (e.code || '?') + '):\n' + (e.stderr || '') + '\n' + (e.stdout || '')).trim();
    }
    return 'Execution error: ' + e.message;
  }
};
