// Extracts structured ops from LLM text output.
// Handles: JSON wrapper, bare ops, bare arrays, fenced code blocks, malformed JSON.

const { jsonrepair } = require('../vendor/jsonrepair.js');

/**
 * Extract ops and answer from raw LLM output.
 * @param {string} raw - Raw text from the model
 * @returns {{ answer: string, ops: Array }} - Extracted answer text and ops array
 */
function extractOpsFromText(raw) {
  if (!raw || !raw.trim()) return { answer: '', ops: [] };

  let parsed = null;
  let jsonSliceStart = -1, jsonSliceEnd = -1;

  // 1. Try fenced code blocks: ```json ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      parsed = JSON.parse(jsonrepair(fenceMatch[1].trim()));
    } catch { /* not valid */ }
    if (parsed) {
      jsonSliceStart = raw.indexOf(fenceMatch[0]);
      jsonSliceEnd = jsonSliceStart + fenceMatch[0].length;
    }
  }

  // 2. Try finding {...} object with jsonrepair
  if (!parsed) {
    const objStart = raw.indexOf('{');
    const objEnd = raw.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      const candidate = raw.slice(objStart, objEnd + 1);
      try {
        parsed = JSON.parse(jsonrepair(candidate));
        jsonSliceStart = objStart;
        jsonSliceEnd = objEnd + 1;
      } catch { /* not repairable */ }
    }
  }

  // 3. Try finding [...] array (bare ops) with jsonrepair
  if (!parsed) {
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        const arr = JSON.parse(jsonrepair(raw.slice(arrStart, arrEnd + 1)));
        if (Array.isArray(arr)) {
          parsed = { ops: arr };
          jsonSliceStart = arrStart;
          jsonSliceEnd = arrEnd + 1;
        }
      } catch { /* not repairable */ }
    }
  }

  // 4. Extract answer and ops from parsed result
  if (parsed && typeof parsed === 'object') {
    let answer = parsed.answer || '';
    const ops = [];

    if (Array.isArray(parsed.ops)) {
      ops.push(...parsed.ops);
    } else if (Array.isArray(parsed)) {
      ops.push(...parsed);
    } else if (parsed.fn && (parsed.args || parsed.input)) {
      // Bare single op
      ops.push(parsed);
    }

    // Capture text outside JSON as supplementary answer
    if (!answer && jsonSliceStart >= 0) {
      const before = raw.slice(0, jsonSliceStart).trim();
      const after = raw.slice(jsonSliceEnd).trim();
      answer = [before, after].filter(Boolean).join('\n');
    }

    return { answer, ops: normalizeOps(ops) };
  }

  // 5. No JSON found — treat as plain text
  return { answer: raw.trim(), ops: [] };
}

/**
 * Normalize an op to canonical { fn, input: { ... } } format.
 * Handles: { fn, input }, { fn, args: [...] }, { fn, args: {obj} }
 * @param {object} op - Raw op from model output
 * @returns {{ fn: string, input: object }}
 */
function normalizeOp(op) {
  if (!op || !op.fn) return op;

  // Already canonical
  if (op.input && !op.args) return { fn: op.fn, input: op.input };

  // No args at all
  if (!op.args) return { fn: op.fn, input: {} };

  // args is already an object (not array) — use directly
  if (!Array.isArray(op.args)) return { fn: op.fn, input: op.args };

  // args is array — convert based on tool name
  const args = op.args;

  // propose_tool: args is [{ name, description, code, ... }]
  if (op.fn === 'propose_tool' && args.length === 1 && typeof args[0] === 'object') {
    return { fn: op.fn, input: args[0] };
  }

  // execute_python: args is ["code"] or ["code", {input_data}]
  if (op.fn === 'execute_python') {
    return { fn: op.fn, input: { code: args[0], input_data: args[1] || null } };
  }

  // setFileType: args is ["file", "type"]
  if (op.fn === 'setFileType') {
    return { fn: op.fn, input: { file: args[0], fileType: args[1] } };
  }

  // setValue: args is ["file", ["path"], value]
  if (op.fn === 'setValue') {
    return { fn: op.fn, input: { file: args[0], path: args[1], value: args[2] } };
  }

  // lockAllInFile / unlockAllInFile: args is ["file"]
  if (op.fn === 'lockAllInFile' || op.fn === 'unlockAllInFile') {
    return { fn: op.fn, input: { file: args[0] } };
  }

  // Default pattern: file, path (lockField, unlockField, pinField, unpinField, etc.)
  return { fn: op.fn, input: { file: args[0], path: args[1], value: args[2] } };
}

/**
 * Normalize all ops in an array to canonical format.
 * @param {Array} ops
 * @returns {Array}
 */
function normalizeOps(ops) {
  return (ops || []).map(normalizeOp);
}

/**
 * Detect unfenced Python code in text.
 * @param {string} text
 * @returns {{ hasPython: boolean, code: string|null, textBefore: string|null }}
 */
function detectUnfencedPython(text) {
  if (!text) return { hasPython: false, code: null, textBefore: null };
  if (/```/.test(text)) return { hasPython: false, code: null, textBefore: null };
  if (!/^(?:import |from \w+ import |plt\.|matplotlib)/m.test(text)) {
    return { hasPython: false, code: null, textBefore: null };
  }

  const lines = text.split('\n');
  let codeStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:import |from \w+ import |plt\.|matplotlib|fig|ax[.\s=]|#)/.test(lines[i].trim())) {
      if (codeStart < 0) codeStart = i;
    }
  }

  if (codeStart >= 0) {
    return {
      hasPython: true,
      code: lines.slice(codeStart).join('\n').trim(),
      textBefore: lines.slice(0, codeStart).join('\n').trim() || null,
    };
  }

  return { hasPython: false, code: null, textBefore: null };
}

/**
 * Detect if a Python code block needs matplotlib fixes.
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

module.exports = { extractOpsFromText, normalizeOp, normalizeOps, detectUnfencedPython, fixPythonForHeadless };
