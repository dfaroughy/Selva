// Extension context — returns file schema from the schemata passed in context
module.exports = async function(input, context) {
  const schemata = context.schemata || [];
  const file = input.file;
  const match = schemata.find(s => s.file === file);
  if (!match) return 'File not found: ' + file + '. Available files: ' + schemata.map(s => s.file).join(', ');

  const lines = match.fields.map(f =>
    `  ${JSON.stringify(f.path)}  =  ${JSON.stringify(f.value)}  (${f.type})`
  ).join('\n');

  let result = `[${file}]\nFIELDS (${match.fields.length} total):\n${lines}`;
  if (match.raw) {
    const rawPreview = match.raw.slice(0, 3000);
    result += '\n\nRAW YAML:\n' + rawPreview;
    if (match.raw.length > 3000) result += '\n... (truncated, ' + match.raw.length + ' chars total)';
  }
  return result;
};
