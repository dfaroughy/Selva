const fs = require('fs');
const path = require('path');

function handleFileOp(msg, ctx) {
  const { configDir, panel, yaml } = ctx;

  switch (msg.type) {
    case 'readConfig': {
      try {
        const filePath = path.resolve(configDir, msg.filename);
        const safeBase = path.resolve(configDir) + path.sep;
        if (!filePath.startsWith(safeBase)) {
          panel.webview.postMessage({ type: 'configData', error: 'Invalid path' });
          return;
        }
        const raw    = fs.readFileSync(filePath, 'utf8');
        const docs   = yaml.loadAll(raw);
        const docKey = docs.length === 1 ? null : msg.filename.replace(/\.ya?ml$/i, '');
        const parsed = docKey ? { [docKey]: docs } : docs[0];
        panel.webview.postMessage({ type: 'configData', filename: msg.filename, raw, parsed });
      } catch (e) {
        panel.webview.postMessage({ type: 'configData', error: e.message });
      }
      break;
    }
    case 'writeConfig': {
      try {
        const filePath = path.resolve(configDir, msg.filename);
        const safeBase = path.resolve(configDir) + path.sep;
        if (!filePath.startsWith(safeBase)) {
          panel.webview.postMessage({ type: 'writeResult', error: 'Invalid path' });
          return;
        }
        let output;
        const docKey = msg.filename.replace(/\.ya?ml$/i, '');
        if (msg.data && Array.isArray(msg.data[docKey])) {
          output = msg.data[docKey].map(d => yaml.dump(d, { flowLevel: -1, sortKeys: false })).join('---\n');
        } else {
          output = yaml.dump(msg.data, { flowLevel: -1, sortKeys: false });
        }
        fs.writeFileSync(filePath, output, 'utf8');
        panel.webview.postMessage({ type: 'writeResult', success: true, filename: msg.filename });
      } catch (e) {
        panel.webview.postMessage({ type: 'writeResult', error: e.message });
      }
      break;
    }
    case 'exportJson': {
      try {
        const filePath = path.resolve(configDir, msg.filename);
        const safeBase = path.resolve(configDir) + path.sep;
        if (!filePath.startsWith(safeBase)) {
          panel.webview.postMessage({ type: 'exportJsonResult', error: 'Invalid path' });
          return;
        }
        const jsonFilename = msg.filename.replace(/\.ya?ml$/i, '.json');
        const jsonPath = path.resolve(configDir, jsonFilename);
        fs.writeFileSync(jsonPath, JSON.stringify(msg.data, null, 2), 'utf8');
        panel.webview.postMessage({ type: 'exportJsonResult', success: true, jsonFilename });
      } catch (e) {
        panel.webview.postMessage({ type: 'exportJsonResult', error: e.message });
      }
      break;
    }
  }
}

module.exports = { handleFileOp };
