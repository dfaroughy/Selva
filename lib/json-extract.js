// Python code preprocessing for headless execution.

/**
 * Fix Python code for headless matplotlib execution.
 * - Injects Agg backend if matplotlib is used without explicit backend
 * - Removes plt.show() calls
 * - Adds base64 PNG output capture if plotting without output
 * @param {string} code
 * @returns {string} - Fixed code
 */
function fixPythonForHeadless(code) {
  let fixed = code;
  // Ensure Agg backend
  if (/matplotlib/.test(fixed) && !/matplotlib\.use/.test(fixed)) {
    fixed = `import matplotlib\nmatplotlib.use('Agg')\n` + fixed;
  }
  // Remove plt.show()
  fixed = fixed.replace(/plt\.show\(\)/g, '');
  // Add base64 output if plotting but no output
  if (/plt\./.test(fixed) && !/b64encode/.test(fixed)) {
    fixed += `\nimport base64, io\nbuf = io.BytesIO()\nplt.savefig(buf, format='png', dpi=120, bbox_inches='tight')\nbuf.seek(0)\nprint('IMG:' + base64.b64encode(buf.getvalue()).decode())`;
  }
  return fixed;
}

module.exports = { fixPythonForHeadless };
