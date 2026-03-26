function prepareNotebookPythonExecution(code) {
  const source = String(code || '');
  if (!source.trim()) return source;

  const encodedSource = Buffer.from(source, 'utf8').toString('base64');
  const suppressDisplay = /;\s*$/.test(source);
  const shouldAutoCapturePlots = !/(?:IMG:|b64encode\s*\()/i.test(source);

  const lines = [
    'import ast',
    'import base64',
    'import io',
    'import os',
    '',
    `__selva_nb_source = base64.b64decode(${JSON.stringify(encodedSource)}).decode('utf-8')`,
    `__selva_nb_suppress_display = ${suppressDisplay ? 'True' : 'False'}`,
    "__selva_nb_tree = ast.parse(__selva_nb_source, filename='<selva-cell>', mode='exec')",
    '__selva_nb_last_expr = None',
    'if (not __selva_nb_suppress_display) and __selva_nb_tree.body and isinstance(__selva_nb_tree.body[-1], ast.Expr):',
    '    __selva_nb_last_expr = __selva_nb_tree.body.pop().value',
    "__selva_nb_globals = {'__name__': '__main__'}",
    '__selva_nb_matplotlib = None',
    'try:',
    "    os.environ.setdefault('MPLBACKEND', 'Agg')",
    '    import matplotlib as __selva_nb_matplotlib',
    '    try:',
    "        __selva_nb_matplotlib.use('Agg', force=True)",
    '    except Exception:',
    '        pass',
    '    try:',
    '        import matplotlib.pyplot as __selva_nb_bootstrap_plt',
    '        __selva_nb_bootstrap_plt.show = lambda *args, **kwargs: None',
    '    except Exception:',
    '        pass',
    'except Exception:',
    '    __selva_nb_matplotlib = None',
    'ast.fix_missing_locations(__selva_nb_tree)',
    "exec(compile(__selva_nb_tree, '<selva-cell>', 'exec'), __selva_nb_globals, __selva_nb_globals)",
    'if __selva_nb_last_expr is not None:',
    '    __selva_nb_expr = ast.Expression(__selva_nb_last_expr)',
    '    ast.fix_missing_locations(__selva_nb_expr)',
    "    __selva_nb_value = eval(compile(__selva_nb_expr, '<selva-cell>', 'eval'), __selva_nb_globals, __selva_nb_globals)",
    '    if __selva_nb_value is not None:',
    '        print(repr(__selva_nb_value))',
  ];

  if (shouldAutoCapturePlots) {
    lines.push(
      'try:',
      '    if __selva_nb_matplotlib is not None:',
      '        import matplotlib.pyplot as __selva_nb_plt',
      '        __selva_nb_fig_nums = list(__selva_nb_plt.get_fignums())',
      '        for __selva_nb_fig_num in __selva_nb_fig_nums:',
      '            __selva_nb_fig = __selva_nb_plt.figure(__selva_nb_fig_num)',
      '            __selva_nb_buf = io.BytesIO()',
      "            __selva_nb_fig.savefig(__selva_nb_buf, format='png', dpi=120, bbox_inches='tight')",
      '            __selva_nb_buf.seek(0)',
      "            print('IMG:' + base64.b64encode(__selva_nb_buf.getvalue()).decode())",
      '        if __selva_nb_fig_nums:',
      "            __selva_nb_plt.close('all')",
      'except Exception as __selva_nb_plot_error:',
      "    print('SELVA_PLOT_CAPTURE_WARNING: ' + repr(__selva_nb_plot_error))"
    );
  }

  lines.push('');

  return lines.join('\n');
}

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

module.exports = {
  prepareNotebookPythonExecution,
  fixPythonForHeadless,
};
