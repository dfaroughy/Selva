const assert = require('assert');
const { fixPythonForHeadless } = require('../lib/json-extract');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n\x1b[1mPython Headless Fix\x1b[0m');

test('injects Agg backend when missing', () => {
  const code = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])';
  const fixed = fixPythonForHeadless(code);
  assert.ok(fixed.includes("matplotlib.use('Agg')"));
});

test('does not double-inject Agg backend', () => {
  const code = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])";
  const fixed = fixPythonForHeadless(code);
  const count = (fixed.match(/matplotlib\.use/g) || []).length;
  assert.strictEqual(count, 1);
});

test('removes plt.show()', () => {
  const code = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()';
  const fixed = fixPythonForHeadless(code);
  assert.ok(!fixed.includes('plt.show()'));
});

test('adds base64 output when missing', () => {
  const code = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])';
  const fixed = fixPythonForHeadless(code);
  assert.ok(fixed.includes('b64encode'));
  assert.ok(fixed.includes("print('IMG:'"));
});

test('does not add base64 output when already present', () => {
  const code = "import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nimport base64\nbuf=io.BytesIO()\nplt.savefig(buf)\nprint('IMG:'+base64.b64encode(buf.getvalue()).decode())";
  const fixed = fixPythonForHeadless(code);
  const count = (fixed.match(/b64encode/g) || []).length;
  assert.strictEqual(count, 1);
});

test('no changes for non-matplotlib code', () => {
  const code = 'print("hello world")';
  const fixed = fixPythonForHeadless(code);
  assert.strictEqual(fixed, code);
});

test('handles multiple plt.show() calls', () => {
  const code = 'plt.plot([1])\nplt.show()\nplt.plot([2])\nplt.show()';
  const fixed = fixPythonForHeadless(code);
  assert.ok(!fixed.includes('plt.show()'));
});

test('preserves non-matplotlib code', () => {
  const code = 'import json\ndata = json.loads(input)\nprint(data)';
  const fixed = fixPythonForHeadless(code);
  assert.strictEqual(fixed, code);
  assert.ok(!fixed.includes('matplotlib'));
});

console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) process.exit(1);
