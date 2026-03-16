// Real-world LLM output patterns for testing JSON extraction

module.exports = {
  // Standard wrapper: {"answer":"...", "ops":[...]}
  standardWrapper: {
    input: '{"answer": "Learning rate updated.", "summary": "Set LR to 0.01", "ops": [{"fn": "setValue", "args": ["trainer.yaml", ["training", "lr"], 0.01]}]}',
    expectedOps: 1,
    expectedAnswer: 'Learning rate updated.',
  },

  // Bare single op: {"fn":"...", "args":[...]}
  bareSingleOp: {
    input: '{"fn": "setFileType", "args": ["figure_5a.yaml", "data"]}',
    expectedOps: 1,
    expectedFn: 'setFileType',
  },

  // Bare array of ops
  bareArray: {
    input: '[{"fn": "setFileType", "args": ["fig.yaml", "data"]}, {"fn": "lockAllInFile", "args": ["fig.yaml"]}]',
    expectedOps: 2,
  },

  // Fenced JSON block
  fencedJson: {
    input: '```json\n{"answer": "Done.", "ops": [{"fn": "setValue", "args": ["train.yaml", ["lr"], 0.1]}]}\n```',
    expectedOps: 1,
    expectedAnswer: 'Done.',
  },

  // Text before and after JSON
  textAroundJson: {
    input: 'Here is the classification:\n{"answer": null, "ops": [{"fn": "setFileType", "args": ["data.yaml", "data"]}]}\nAll files classified.',
    expectedOps: 1,
    expectedAnswer: 'Here is the classification:\nAll files classified.',
  },

  // Malformed JSON (missing commas) — jsonrepair should fix
  malformedMissingCommas: {
    input: '{"answer": "Done" "ops": [{"fn": "setValue" "args": ["train.yaml" ["lr"] 0.01]}]}',
    expectedOps: 1,
    expectedAnswer: 'Done',
  },

  // Malformed JSON (trailing comma)
  malformedTrailingComma: {
    input: '{"answer": "OK", "ops": [{"fn": "lockField", "args": ["f.yaml", ["x"]]},]}',
    expectedOps: 1,
  },

  // propose_tool with complex code field containing braces
  proposeToolComplex: {
    input: '{"fn": "propose_tool", "args": [{"name": "setSliderBounds", "description": "Set slider bounds", "context": "webview", "inputSchema": {"type": "object", "properties": {"file": {"type": "string"}, "path": {"type": "array"}, "min": {"type": "number"}, "max": {"type": "number"}}, "required": ["file", "path", "min", "max"]}, "code": "(function(input){var k=input.file+\':\'+JSON.stringify(normalizePath(input.path));state.hooks.fieldOverrides[k]=state.hooks.fieldOverrides[k]||{};state.hooks.fieldOverrides[k].min=input.min;state.hooks.fieldOverrides[k].max=input.max;renderEditors();return \'done\';})", "origin_query": "set slider bounds", "reasoning": "no built-in tool"}]}',
    expectedOps: 1,
    expectedFn: 'propose_tool',
  },

  // Text with embedded propose_tool (model explains then gives JSON)
  textThenProposeTool: {
    input: 'I\'ll create a new tool for this.\n{"fn": "propose_tool", "args": [{"name": "hideField", "description": "Hide a field", "context": "webview", "code": "(function(input){return \'hidden\';})", "inputSchema": {}}]}',
    expectedOps: 1,
    expectedFn: 'propose_tool',
    expectedAnswer: "I'll create a new tool for this.",
  },

  // Fenced array (bare ops in fence)
  fencedArray: {
    input: '```json\n[{"fn": "setFileType", "args": ["a.yaml", "config"]}, {"fn": "setFileType", "args": ["b.yaml", "data"]}]\n```',
    expectedOps: 2,
  },

  // Plain text answer (no JSON at all)
  plainText: {
    input: 'The learning rate is currently set to 0.001 in trainer.yaml. This is a typical starting value for Adam optimizer.',
    expectedOps: 0,
    expectedAnswer: 'The learning rate is currently set to 0.001 in trainer.yaml. This is a typical starting value for Adam optimizer.',
  },

  // Empty response
  emptyResponse: {
    input: '',
    expectedOps: 0,
    expectedAnswer: '',
  },

  // Whitespace-only response
  whitespaceOnly: {
    input: '   \n\n  ',
    expectedOps: 0,
    expectedAnswer: '',
  },

  // Multiple JSON objects in text (should take the outermost valid one)
  multipleJsonObjects: {
    input: 'The config has {"lr": 0.01} but I will change it.\n{"answer": "Updated.", "ops": [{"fn": "setValue", "args": ["t.yaml", ["lr"], 0.1]}]}',
    expectedOps: 1,
  },

  // JSON with single quotes (common GPT mistake)
  singleQuotes: {
    input: "{\"answer\": \"Done\", \"ops\": [{'fn': 'setValue', 'args': ['train.yaml', ['lr'], 0.01]}]}",
    expectedOps: 1,
  },

  // Markdown-wrapped JSON with explanation
  markdownWrapped: {
    input: 'Here is my response:\n\n```json\n{"answer": "Classified.", "ops": [{"fn": "setFileType", "args": ["results.yaml", "data"]}, {"fn": "lockAllInFile", "args": ["results.yaml"]}]}\n```\n\nLet me know if you need anything else.',
    expectedOps: 2,
    expectedAnswer: 'Classified.',
  },
};
