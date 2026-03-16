// Extension context — handles creating new tools in ~/.selva/ecosystem/tools/
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { jungleBigram } = require('./bigrams.js');

module.exports = async function(input, context) {
  const toolsBaseDir = path.join(os.homedir(), '.selva', 'ecosystem', 'tools');
  const jungleDir = path.join(toolsBaseDir, input.name);

  // Create directory
  fs.mkdirSync(jungleDir, { recursive: true });

  // Generate tool code
  const toolCode = input.context === 'extension'
    ? '// Extension context\nmodule.exports = async function(input, context) {\n  const { execFileAsync, configDir } = context;\n  ' + input.code + '\n};\n'
    : input.code + '\n';

  // Generate hash + bigram ID from tool code
  const hash = crypto.createHash('sha256').update(toolCode).digest('hex');
  const bigramId = jungleBigram(hash);

  // Write metadata.json
  const metadata = {
    name: input.name,
    id: bigramId,
    hash: hash,
    description: input.description,
    context: input.context || 'webview',
    inputSchema: input.inputSchema || {},
    created: new Date().toISOString().split('T')[0],
    origin_query: input.origin_query || null,
    reasoning: input.reasoning || null,
    model: context.modelName || 'unknown',
    tested: false,
    approved: false,
    version: 1
  };
  fs.writeFileSync(path.join(jungleDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  // Write tool.js
  fs.writeFileSync(path.join(jungleDir, 'tool.js'), toolCode, 'utf8');

  // Update tools.lock (audit trail)
  const lockPath = path.join(os.homedir(), '.selva', 'ecosystem', 'tools.lock');
  let lock = {};
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* new */ }
  lock[input.name] = {
    id: bigramId,
    hash: hash,
    created_by: context.modelName || 'unknown',
    created_at: new Date().toISOString(),
    tested: false,
    approved: false,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');

  // Regenerate tools.md index
  let index = '# Selva Ecosystem Tools\n\nAuto-generated index of user-created tools.\n\n';
  try {
    const dirs = fs.readdirSync(toolsBaseDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(toolsBaseDir, dir.name, 'metadata.json'), 'utf8'));
        index += '## ' + meta.name + (meta.id ? ' (`' + meta.id + '`)' : '') + '\n';
        index += '- **Description**: ' + meta.description + '\n';
        index += '- **Context**: ' + meta.context + '\n';
        index += '- **Created**: ' + (meta.created || 'unknown') + '\n';
        index += '- **Status**: ' + (meta.approved ? 'approved' : 'pending review') + '\n';
        if (meta.origin_query) index += '- **Origin**: ' + meta.origin_query + '\n';
        index += '\n';
      } catch { /* skip invalid */ }
    }
  } catch { /* no tools yet */ }
  fs.writeFileSync(path.join(os.homedir(), '.selva', 'ecosystem', 'tools.md'), index, 'utf8');

  // Send tool to webview for immediate registration (if webview context)
  if (input.context === 'webview' && context.panel) {
    context.panel.webview.postMessage({
      type: 'registerTool',
      name: input.name,
      code: input.code,
    });
  }

  return 'Tool "' + input.name + '" (' + bigramId + ') created and registered.';
};
