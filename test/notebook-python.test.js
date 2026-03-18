const assert = require('assert');

const { prepareNotebookPythonExecution } = require('../lib/notebook-python');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

console.log('\n\x1b[1mNotebook Python\x1b[0m');

test('wraps the final bare expression for notebook-style output', () => {
  const prepared = prepareNotebookPythonExecution('value = 2\nvalue + 2');
  assert.ok(prepared.includes('__selva_nb_last_expr'));
  assert.ok(prepared.includes('print(repr(__selva_nb_value))'));
  assert.ok(prepared.includes('__selva_nb_suppress_display = False'));
});

test('suppresses final expression display when the cell ends with a semicolon', () => {
  const prepared = prepareNotebookPythonExecution('2 + 2;');
  assert.ok(prepared.includes('__selva_nb_suppress_display = True'));
});

test('adds plot capture for pyplot cells without clobbering notebook output wrapping', () => {
  const prepared = prepareNotebookPythonExecution('import matplotlib.pyplot as plt\nplt.plot([1], [2])');
  assert.ok(prepared.includes("__selva_nb_matplotlib.use('Agg', force=True)"));
  assert.ok(prepared.includes("__selva_nb_bootstrap_plt.show = lambda *args, **kwargs: None"));
  assert.ok(prepared.includes("__selva_nb_fig_nums = list(__selva_nb_plt.get_fignums())"));
  assert.ok(prepared.includes("__selva_nb_fig.savefig(__selva_nb_buf, format='png', dpi=120, bbox_inches='tight')"));
  assert.ok(prepared.includes("print('IMG:' + base64.b64encode(__selva_nb_buf.getvalue()).decode())"));
});

test('captures figures generically without relying on a plt variable in user code', () => {
  const prepared = prepareNotebookPythonExecution('from matplotlib import pyplot as p\np.plot([1], [2])');
  assert.ok(prepared.includes("__selva_nb_fig_nums = list(__selva_nb_plt.get_fignums())"));
  assert.ok(!prepared.includes("plt.savefig("));
});

test('does not auto-capture plots when the user code already emits IMG output', () => {
  const prepared = prepareNotebookPythonExecution("import base64\nprint('IMG:'+base64.b64encode(b'demo').decode())");
  assert.ok(!prepared.includes("__selva_nb_fig_nums = list(__selva_nb_plt.get_fignums())"));
});

test('returns empty cells unchanged', () => {
  assert.strictEqual(prepareNotebookPythonExecution('   '), '   ');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) process.exit(1);
})();
