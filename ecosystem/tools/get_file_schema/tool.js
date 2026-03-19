// Extension context — returns file schema from the schemata passed in context
module.exports = async function(input, context) {
  const schemata = context.schemata || [];
  const file = input.file;
  const match = schemata.find(s => s.file === file);
  if (!match) return 'File not found: ' + file + '. Available files: ' + schemata.map(s => s.file).join(', ');

  const lines = match.fields.map(f =>
    `  ${JSON.stringify(f.path)}  =  ${String(f.preview != null ? f.preview : (f.type || 'unknown'))}  (${f.type})`
  ).join('\n');

  return `[${file}]\nFIELDS (${match.fields.length} total):\n${lines}\n\nNOTE:\nStructure only. Load the file in Python to inspect actual values.`;
};
