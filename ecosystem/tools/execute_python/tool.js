// Extension context — this module is require'd by extension.js
// Returns an async handler function
module.exports = async function(input, context) {
  const { execFileAsync, configDir } = context;
  const code = input.code;
  const inputData = input.input_data ? JSON.stringify(input.input_data) : '';
  try {
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
