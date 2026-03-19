const assert = require('assert');
const { extractOpsFromText, normalizeOp, normalizeOps, detectUnfencedPython, fixPythonForHeadless } = require('../lib/json-extract');
const fixtures = require('./fixtures/model-outputs');

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

// ── JSON Extraction Tests ────────────────────────────────

console.log('\n\x1b[1mJSON Extraction\x1b[0m');

test('standard wrapper: extracts ops and answer', () => {
  const { answer, ops } = extractOpsFromText(fixtures.standardWrapper.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(answer, 'Learning rate updated.');
  assert.strictEqual(ops[0].fn, 'setValue');
});

test('bare single op: extracts one op', () => {
  const { ops } = extractOpsFromText(fixtures.bareSingleOp.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].fn, 'setFileType');
});

test('bare array: extracts multiple ops', () => {
  const { ops } = extractOpsFromText(fixtures.bareArray.input);
  assert.strictEqual(ops.length, 2);
  assert.strictEqual(ops[0].fn, 'setFileType');
  assert.strictEqual(ops[1].fn, 'lockAllInFile');
});

test('fenced JSON: extracts from ```json blocks', () => {
  const { answer, ops } = extractOpsFromText(fixtures.fencedJson.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(answer, 'Done.');
});

test('text around JSON: captures surrounding text as answer', () => {
  const { answer, ops } = extractOpsFromText(fixtures.textAroundJson.input);
  assert.strictEqual(ops.length, 1);
  assert.ok(answer.includes('Here is the classification:'));
  assert.ok(answer.includes('All files classified.'));
});

test('malformed missing commas: jsonrepair fixes it', () => {
  const { answer, ops } = extractOpsFromText(fixtures.malformedMissingCommas.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(answer, 'Done');
});

test('malformed trailing comma: jsonrepair fixes it', () => {
  const { ops } = extractOpsFromText(fixtures.malformedTrailingComma.input);
  assert.strictEqual(ops.length, 1);
});

test('propose_tool with complex code field', () => {
  const { ops } = extractOpsFromText(fixtures.proposeToolComplex.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].fn, 'propose_tool');
  assert.strictEqual(ops[0].input.name, 'setSliderBounds');
  assert.ok(ops[0].input.code.includes('fieldOverrides'));
});

test('text then propose_tool: captures preamble as answer', () => {
  const { answer, ops } = extractOpsFromText(fixtures.textThenProposeTool.input);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].fn, 'propose_tool');
  assert.ok(answer.includes('create a new tool'));
});

test('fenced array: extracts bare ops from fence', () => {
  const { ops } = extractOpsFromText(fixtures.fencedArray.input);
  assert.strictEqual(ops.length, 2);
});

test('plain text: no ops, full text as answer', () => {
  const { answer, ops } = extractOpsFromText(fixtures.plainText.input);
  assert.strictEqual(ops.length, 0);
  assert.ok(answer.includes('learning rate'));
});

test('empty response: empty answer and no ops', () => {
  const { answer, ops } = extractOpsFromText(fixtures.emptyResponse.input);
  assert.strictEqual(ops.length, 0);
  assert.strictEqual(answer, '');
});

test('whitespace-only: empty answer and no ops', () => {
  const { answer, ops } = extractOpsFromText(fixtures.whitespaceOnly.input);
  assert.strictEqual(ops.length, 0);
  assert.strictEqual(answer, '');
});

test('multiple JSON objects: extracts valid ops', () => {
  const { ops } = extractOpsFromText(fixtures.multipleJsonObjects.input);
  assert.ok(ops.length >= 1);
});

test('single quotes: jsonrepair fixes it', () => {
  const { ops } = extractOpsFromText(fixtures.singleQuotes.input);
  assert.strictEqual(ops.length, 1);
});

test('markdown-wrapped: extracts from fenced block, ignores surrounding text', () => {
  const { answer, ops } = extractOpsFromText(fixtures.markdownWrapped.input);
  assert.strictEqual(ops.length, 2);
  assert.strictEqual(answer, 'Classified.');
});

// ── Python Detection Tests ───────────────────────────────

console.log('\n\x1b[1mPython Detection\x1b[0m');

test('detects unfenced Python with imports', () => {
  const text = 'Here is the plot:\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()';
  const { hasPython, code, textBefore } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, true);
  assert.ok(code.includes('import matplotlib'));
  assert.strictEqual(textBefore, 'Here is the plot:');
});

test('does not detect fenced Python', () => {
  const text = '```python\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\n```';
  const { hasPython } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, false);
});

test('does not detect non-Python text', () => {
  const text = 'The learning rate is 0.001. Try reducing it by a factor of 3.';
  const { hasPython } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, false);
});

test('detects Python starting with from...import', () => {
  const text = 'from numpy import array\nimport matplotlib.pyplot as plt\nplt.scatter([1],[2])';
  const { hasPython, code } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, true);
  assert.ok(code.includes('from numpy'));
});

test('empty text returns false', () => {
  const { hasPython } = detectUnfencedPython('');
  assert.strictEqual(hasPython, false);
});

// ── Python Headless Fix Tests ────────────────────────────

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

// ── Tool Loading Tests ───────────────────────────────────

console.log('\n\x1b[1mTool Loading\x1b[0m');

const path = require('path');
const { loadToolsFromDir, buildToolSchemas } = (() => {
  // Extract from extension.js without VS Code dependency
  const fs = require('fs');
  function loadToolsFromDir(dir) {
    const tools = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const metaPath = path.join(dir, entry.name, 'metadata.json');
          const codePath = path.join(dir, entry.name, 'tool.js');
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const code = fs.readFileSync(codePath, 'utf8');
          tools.push({ name: meta.name, description: meta.description, inputSchema: meta.inputSchema || {}, context: meta.context || 'webview', code, source: dir });
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }
    return tools;
  }
  function buildToolSchemas(tools) {
    return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }
  return { loadToolsFromDir, buildToolSchemas };
})();

test('loads built-in tools from ecosystem/tools/', () => {
  const tools = loadToolsFromDir(path.join(__dirname, '..', 'ecosystem', 'tools'));
  assert.ok(tools.length >= 8, `Expected >=8 tools, got ${tools.length}`);
  const names = tools.map(t => t.name);
  assert.ok(names.includes('setValue'));
  assert.ok(names.includes('execute_python'));
  assert.ok(names.includes('propose_tool'));
});

test('each tool has required fields', () => {
  const tools = loadToolsFromDir(path.join(__dirname, '..', 'ecosystem', 'tools'));
  for (const t of tools) {
    assert.ok(t.name, `Tool missing name`);
    assert.ok(t.description, `Tool ${t.name} missing description`);
    assert.ok(t.code, `Tool ${t.name} missing code`);
    assert.ok(['webview', 'extension'].includes(t.context), `Tool ${t.name} invalid context: ${t.context}`);
  }
});

test('buildToolSchemas produces valid schemas', () => {
  const tools = loadToolsFromDir(path.join(__dirname, '..', 'ecosystem', 'tools'));
  const schemas = buildToolSchemas(tools);
  assert.strictEqual(schemas.length, tools.length);
  for (const s of schemas) {
    assert.ok(s.name);
    assert.ok(s.description);
    assert.ok(typeof s.inputSchema === 'object');
  }
});

test('returns empty array for nonexistent directory', () => {
  const tools = loadToolsFromDir('/nonexistent/path');
  assert.strictEqual(tools.length, 0);
});

// ── Bigram Tests ─────────────────────────────────────────

console.log('\n\x1b[1mBigram Generator\x1b[0m');

const { jungleBigram } = require('../ecosystem/tools/propose_tool/bigrams.js');
const crypto = require('crypto');

test('produces deterministic bigram from hash', () => {
  const hash = crypto.createHash('sha256').update('test-code').digest('hex');
  const a = jungleBigram(hash);
  const b = jungleBigram(hash);
  assert.strictEqual(a, b);
});

test('different code produces different bigram', () => {
  const h1 = crypto.createHash('sha256').update('code-a').digest('hex');
  const h2 = crypto.createHash('sha256').update('code-b').digest('hex');
  assert.notStrictEqual(jungleBigram(h1), jungleBigram(h2));
});

test('bigram contains underscore separator and 8-char hash suffix', () => {
  const hash = crypto.createHash('sha256').update('test').digest('hex');
  const bigram = jungleBigram(hash);
  assert.ok(bigram.includes('_'), `No underscore: ${bigram}`);
  const parts = bigram.split('_');
  assert.strictEqual(parts[1].length, 8, `Hash suffix should be 8 chars: ${parts[1]}`);
});

// ── Op Normalization Tests ────────────────────────────────

console.log('\n\x1b[1mOp Normalization\x1b[0m');

test('normalizes setValue with positional args', () => {
  const op = normalizeOp({ fn: 'setValue', args: ['train.yaml', ['lr'], 0.01] });
  assert.strictEqual(op.fn, 'setValue');
  assert.strictEqual(op.input.file, 'train.yaml');
  assert.deepStrictEqual(op.input.path, ['lr']);
  assert.strictEqual(op.input.value, 0.01);
  assert.strictEqual(op.args, undefined);
});

test('normalizes setFileType with positional args', () => {
  const op = normalizeOp({ fn: 'setFileType', args: ['data.yaml', 'data'] });
  assert.strictEqual(op.input.file, 'data.yaml');
  assert.strictEqual(op.input.fileType, 'data');
});

test('normalizes lockAllInFile with single arg', () => {
  const op = normalizeOp({ fn: 'lockAllInFile', args: ['data.yaml'] });
  assert.strictEqual(op.input.file, 'data.yaml');
});

test('normalizes execute_python with code string arg', () => {
  const op = normalizeOp({ fn: 'execute_python', args: ['print("hello")'] });
  assert.strictEqual(op.input.code, 'print("hello")');
});

test('normalizes execute_python with code + input_data', () => {
  const op = normalizeOp({ fn: 'execute_python', args: ['code', { x: 1 }] });
  assert.strictEqual(op.input.code, 'code');
  assert.deepStrictEqual(op.input.input_data, { x: 1 });
});

test('normalizes propose_tool with object arg', () => {
  const op = normalizeOp({ fn: 'propose_tool', args: [{ name: 'myTool', code: '()=>{}' }] });
  assert.strictEqual(op.input.name, 'myTool');
  assert.strictEqual(op.input.code, '()=>{}');
});

test('passes through already-canonical ops unchanged', () => {
  const op = normalizeOp({ fn: 'setValue', input: { file: 'a.yaml', path: ['x'], value: 1 } });
  assert.strictEqual(op.input.file, 'a.yaml');
  assert.strictEqual(op.input.value, 1);
});

test('handles args as object (not array)', () => {
  const op = normalizeOp({ fn: 'setSliderBounds', args: { file: 'a.yaml', path: ['lr'], min: 0, max: 1 } });
  assert.strictEqual(op.input.file, 'a.yaml');
  assert.strictEqual(op.input.min, 0);
});

test('normalizeOps normalizes all ops in array', () => {
  const ops = normalizeOps([
    { fn: 'setValue', args: ['f.yaml', ['x'], 1] },
    { fn: 'lockAllInFile', args: ['f.yaml'] },
  ]);
  assert.strictEqual(ops.length, 2);
  assert.strictEqual(ops[0].input.file, 'f.yaml');
  assert.strictEqual(ops[1].input.file, 'f.yaml');
  assert.strictEqual(ops[0].args, undefined);
  assert.strictEqual(ops[1].args, undefined);
});

test('extractOpsFromText returns normalized ops', () => {
  const { ops } = extractOpsFromText('{"answer":"ok","ops":[{"fn":"setValue","args":["f.yaml",["x"],1]}]}');
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].input.file, 'f.yaml');
  assert.strictEqual(ops[0].input.value, 1);
  assert.strictEqual(ops[0].args, undefined);
});

test('extractOpsFromText normalizes bare execute_python op', () => {
  const { ops } = extractOpsFromText('{"fn":"execute_python","args":["print(1)"]}');
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].input.code, 'print(1)');
});

// ── Block Parsing & Splitting Tests ──────────────────────

console.log('\n\x1b[1mBlock Parsing & Splitting\x1b[0m');

// Inline parseRichBlocks and splitTextIntoParagraphs (from utils.js)
function parseRichBlocks(text) {
  const blocks = [];
  const fenceRe = /```(\w*)(?:\s*\[(\w+)\])?\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) {
      const pre = text.slice(last, m.index).trim();
      if (pre) blocks.push({ type: 'text', content: pre, layout: null });
    }
    const lang = (m[1] || '').toLowerCase();
    const layout = (m[2] || '').toLowerCase() || null;
    const content = m[3].trim();
    let blockType;
    if (lang === 'mermaid') blockType = 'mermaid';
    else if (lang === 'svg') blockType = 'svg';
    else if (lang === 'ascii' || lang === 'text') blockType = 'ascii';
    else blockType = 'code';
    const block = { type: blockType, content, layout };
    if (blockType === 'code') block.lang = lang || 'text';
    blocks.push(block);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) blocks.push({ type: 'text', content: tail, layout: null });
  }
  if (blocks.length === 0 && text.trim()) {
    blocks.push({ type: 'text', content: text.trim(), layout: null });
  }
  return blocks;
}

function splitTextIntoParagraphs(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const paras = block.content.split(/\n{2,}/);
      for (const p of paras) {
        const trimmed = p.trim();
        if (trimmed) result.push({ type: 'text', content: trimmed, layout: block.layout });
      }
    } else {
      result.push(block);
    }
  }
  return result;
}

test('parseRichBlocks: text only', () => {
  const blocks = parseRichBlocks('Hello world');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'text');
  assert.strictEqual(blocks[0].content, 'Hello world');
});

test('parseRichBlocks: text + python code', () => {
  const blocks = parseRichBlocks('Explanation here\n\n```python\nprint(1)\n```\n\nMore text');
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].type, 'text');
  assert.strictEqual(blocks[1].type, 'code');
  assert.strictEqual(blocks[1].lang, 'python');
  assert.strictEqual(blocks[2].type, 'text');
});

test('parseRichBlocks: mermaid block', () => {
  const blocks = parseRichBlocks('```mermaid\ngraph TD\nA-->B\n```');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'mermaid');
});

test('parseRichBlocks: multiple code blocks', () => {
  const blocks = parseRichBlocks('Text\n```python\na=1\n```\nMiddle\n```ascii\ntable\n```\nEnd');
  assert.strictEqual(blocks.length, 5);
  assert.strictEqual(blocks[0].type, 'text');
  assert.strictEqual(blocks[1].type, 'code');
  assert.strictEqual(blocks[2].type, 'text');
  assert.strictEqual(blocks[3].type, 'ascii');
  assert.strictEqual(blocks[4].type, 'text');
});

test('splitTextIntoParagraphs: splits double newlines', () => {
  const blocks = [{ type: 'text', content: 'Para 1\n\nPara 2\n\nPara 3', layout: null }];
  const result = splitTextIntoParagraphs(blocks);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].content, 'Para 1');
  assert.strictEqual(result[1].content, 'Para 2');
  assert.strictEqual(result[2].content, 'Para 3');
});

test('splitTextIntoParagraphs: preserves code blocks', () => {
  const blocks = [
    { type: 'text', content: 'A\n\nB', layout: null },
    { type: 'code', content: 'x=1', lang: 'python', layout: null },
    { type: 'text', content: 'C', layout: null },
  ];
  const result = splitTextIntoParagraphs(blocks);
  assert.strictEqual(result.length, 4); // A, B, code, C
  assert.strictEqual(result[0].content, 'A');
  assert.strictEqual(result[1].content, 'B');
  assert.strictEqual(result[2].type, 'code');
  assert.strictEqual(result[3].content, 'C');
});

test('splitTextIntoParagraphs: handles empty paragraphs', () => {
  const blocks = [{ type: 'text', content: 'A\n\n\n\nB', layout: null }];
  const result = splitTextIntoParagraphs(blocks);
  assert.strictEqual(result.length, 2);
});

test('splitTextIntoParagraphs: single paragraph unchanged', () => {
  const blocks = [{ type: 'text', content: 'Just one line', layout: null }];
  const result = splitTextIntoParagraphs(blocks);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].content, 'Just one line');
});

test('full pipeline: parseRichBlocks + splitTextIntoParagraphs', () => {
  const text = 'Intro paragraph\n\nSecond paragraph\n\n```python\nprint(1)\n```\n\nConclusion';
  const blocks = parseRichBlocks(text);
  const split = splitTextIntoParagraphs(blocks);
  assert.strictEqual(split.length, 4); // Intro, Second, code, Conclusion
  assert.strictEqual(split[0].type, 'text');
  assert.strictEqual(split[0].content, 'Intro paragraph');
  assert.strictEqual(split[1].type, 'text');
  assert.strictEqual(split[1].content, 'Second paragraph');
  assert.strictEqual(split[2].type, 'code');
  assert.strictEqual(split[3].type, 'text');
  assert.strictEqual(split[3].content, 'Conclusion');
});

// ── get_file_schema Tool Tests ───────────────────────────

console.log('\n\x1b[1mget_file_schema Tool\x1b[0m');

const getFileSchemaHandler = require('../ecosystem/tools/get_file_schema/tool.js');

test('get_file_schema: returns schema for existing file', async () => {
  const schemata = [
    {
      file: 'train.yaml',
      fields: [
        { path: ['lr'], preview: 'number', type: 'number' },
        { path: ['epochs'], preview: 'number', type: 'number' },
      ],
    },
    { file: 'data.yaml', fields: [{ path: ['x'], preview: 'number', type: 'number' }] },
  ];
  const result = await getFileSchemaHandler({ file: 'train.yaml' }, { schemata });
  assert.ok(result.includes('[train.yaml]'));
  assert.ok(result.includes('FIELDS (2 total)'));
  assert.ok(result.includes('number'));
  assert.ok(!result.includes('RAW YAML'));
  assert.ok(result.includes('Structure only'));
});

test('get_file_schema: returns error for missing file', async () => {
  const schemata = [{ file: 'a.yaml', fields: [], raw: '' }];
  const result = await getFileSchemaHandler({ file: 'missing.yaml' }, { schemata });
  assert.ok(result.includes('File not found'));
  assert.ok(result.includes('a.yaml'));
});

test('get_file_schema: shows compact structural previews for large arrays', async () => {
  const schemata = [{
    file: 'big.yaml',
    fields: [{ path: ['values'], preview: 'array(len=1000, item=number)', type: 'array' }],
  }];
  const result = await getFileSchemaHandler({ file: 'big.yaml' }, { schemata });
  assert.ok(result.includes('array(len=1000, item=number)'));
  assert.ok(!result.includes('RAW YAML'));
});

test('get_file_schema: handles empty schemata', async () => {
  const result = await getFileSchemaHandler({ file: 'any.yaml' }, { schemata: [] });
  assert.ok(result.includes('File not found'));
});

// ── Context Optimization Tests ──────────────────────────

console.log('\n\x1b[1mContext Optimization\x1b[0m');

test('tool loading includes get_file_schema', () => {
  const tools = loadToolsFromDir(path.join(__dirname, '..', 'ecosystem', 'tools'));
  const names = tools.map(t => t.name);
  assert.ok(names.includes('get_file_schema'), 'get_file_schema should be in built-in tools');
});

test('get_file_schema is extension-context', () => {
  const tools = loadToolsFromDir(path.join(__dirname, '..', 'ecosystem', 'tools'));
  const tool = tools.find(t => t.name === 'get_file_schema');
  assert.ok(tool);
  assert.strictEqual(tool.context, 'extension');
});

// ── Notebook Cell Structure Tests ───────────────────────

console.log('\n\x1b[1mNotebook Cell Structure\x1b[0m');

test('parseRichBlocks: produces correct cell types for mixed content', () => {
  const text = 'Intro\n\n```python\nprint(1)\n```\n\nMiddle\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```ascii\n| a | b |\n```\n\nEnd';
  const blocks = parseRichBlocks(text);
  const types = blocks.map(b => b.type);
  assert.deepStrictEqual(types, ['text', 'code', 'text', 'mermaid', 'ascii', 'text']);
});

test('splitTextIntoParagraphs + parseRichBlocks: each paragraph is a separate cell', () => {
  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  const blocks = parseRichBlocks(text);
  const split = splitTextIntoParagraphs(blocks);
  assert.strictEqual(split.length, 3);
  assert.ok(split.every(b => b.type === 'text'));
});

test('parseRichBlocks: SVG block detected', () => {
  const blocks = parseRichBlocks('```svg\n<circle cx="50" cy="50" r="40"/>\n```');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'svg');
});

test('parseRichBlocks: layout hints preserved', () => {
  const blocks = parseRichBlocks('```python [left]\nprint(1)\n```\n```mermaid [right]\npie title X\n```');
  assert.strictEqual(blocks[0].layout, 'left');
  assert.strictEqual(blocks[1].layout, 'right');
});

test('parseRichBlocks: empty input returns empty array', () => {
  const blocks = parseRichBlocks('');
  assert.strictEqual(blocks.length, 0);
});

test('parseRichBlocks: whitespace-only returns empty array', () => {
  const blocks = parseRichBlocks('   \n\n  ');
  assert.strictEqual(blocks.length, 0);
});

// ── Op Normalization Edge Cases ─────────────────────────

console.log('\n\x1b[1mOp Normalization Edge Cases\x1b[0m');

test('normalizes get_file_schema with positional args', () => {
  const op = normalizeOp({ fn: 'get_file_schema', args: ['train.yaml'] });
  assert.strictEqual(op.input.file, 'train.yaml');
});

test('normalizes lockField with positional args', () => {
  const op = normalizeOp({ fn: 'lockField', args: ['f.yaml', ['a', 'b']] });
  assert.strictEqual(op.input.file, 'f.yaml');
  assert.deepStrictEqual(op.input.path, ['a', 'b']);
});

test('normalizes unlockField with positional args', () => {
  const op = normalizeOp({ fn: 'unlockField', args: ['f.yaml', ['x']] });
  assert.strictEqual(op.input.file, 'f.yaml');
  assert.deepStrictEqual(op.input.path, ['x']);
});

test('normalizes pinField with positional args', () => {
  const op = normalizeOp({ fn: 'pinField', args: ['f.yaml', ['lr']] });
  assert.strictEqual(op.input.file, 'f.yaml');
});

test('normalizes unpinField with positional args', () => {
  const op = normalizeOp({ fn: 'unpinField', args: ['f.yaml', ['lr']] });
  assert.strictEqual(op.input.file, 'f.yaml');
});

test('normalizeOp handles null/undefined gracefully', () => {
  assert.strictEqual(normalizeOp(null), null);
  assert.strictEqual(normalizeOp(undefined), undefined);
  const noFn = normalizeOp({});
  assert.deepStrictEqual(noFn, {});
});

test('normalizeOp: empty args array', () => {
  const op = normalizeOp({ fn: 'setValue', args: [] });
  assert.strictEqual(op.fn, 'setValue');
  assert.strictEqual(op.input.file, undefined);
});

// ── Python Detection Edge Cases ─────────────────────────

console.log('\n\x1b[1mPython Detection Edge Cases\x1b[0m');

test('detectUnfencedPython: detects plt.scatter', () => {
  const text = 'import numpy as np\nimport matplotlib.pyplot as plt\nplt.scatter([1,2],[3,4])';
  const { hasPython, code } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, true);
  assert.ok(code.includes('plt.scatter'));
});

test('detectUnfencedPython: ignores text mentioning python without code', () => {
  const text = 'Python is a great language for data science. You should use matplotlib for plots.';
  const { hasPython } = detectUnfencedPython(text);
  assert.strictEqual(hasPython, false);
});

test('fixPythonForHeadless: handles multiple plt.show() calls', () => {
  const code = 'plt.plot([1])\nplt.show()\nplt.plot([2])\nplt.show()';
  const fixed = fixPythonForHeadless(code);
  assert.ok(!fixed.includes('plt.show()'));
});

test('fixPythonForHeadless: preserves non-matplotlib code', () => {
  const code = 'import json\ndata = json.loads(input)\nprint(data)';
  const fixed = fixPythonForHeadless(code);
  assert.strictEqual(fixed, code);
  assert.ok(!fixed.includes('matplotlib'));
});

// ── Summary ──────────────────────────────────────────────

console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
