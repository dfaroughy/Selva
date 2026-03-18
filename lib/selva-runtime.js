const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yaml = require(path.join(__dirname, '..', 'vendor', 'js-yaml.min.js'));
const { fixPythonForHeadless } = require('./json-extract');
const { loadJaneSession } = require('./session-store');

const defaultExecFileAsync = promisify(execFile);

const USER_TOOLS_DIR = path.join(os.homedir(), '.selva', 'ecosystem', 'tools');
const TOOL_LOCK_PATH = path.join(os.homedir(), '.selva', 'ecosystem', 'tools.lock');
const DEFAULT_EXTENSION_PATH = path.resolve(__dirname, '..');

const MCP_SERVER_INFO = Object.freeze({
  name: 'selva',
  version: '0.2.0',
});

const BUILTIN_MCP_TOOLS = Object.freeze([
  {
    name: 'list_files',
    description: 'List all YAML config files in the workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_config',
    description: 'Read and summarize a YAML config file. Returns field paths, types, and compact structural previews.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'YAML filename (relative to config dir)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'set_value',
    description: 'Set a value in a YAML config file. Reads the file, modifies the value at the given path, and writes it back. Preserves types (number→number, bool→bool).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'YAML filename' },
        path: {
          type: 'array',
          items: { type: 'string' },
          description: 'JSON path array of keys to the field, e.g. ["training", "lr"]',
        },
        value: { description: 'New value to set' },
      },
      required: ['file', 'path', 'value'],
    },
  },
  {
    name: 'execute_python',
    description: 'Execute a Python code snippet in the config directory. For data analysis, plotting, numerics. Matplotlib plots are auto-captured as base64 PNG. Input data can be passed as JSON on stdin.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        trailId: {
          type: 'string',
          description: 'Optional Trail id for stateful execution. Defaults to the active Trail when available.',
        },
        input_data: {
          type: 'object',
          description: 'Optional JSON data passed on stdin (access via json.load(sys.stdin))',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_file_schema',
    description: 'Get a structural schema (field paths, types, array sizes, compact previews) for a file. Load the file in Python for actual data values.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'YAML filename' },
      },
      required: ['file'],
    },
  },
  {
    name: 'propose_tool',
    description: 'Create a new reusable tool in the Selva ecosystem (~/.selva/ecosystem/tools/). For extension-context tools, write Python code. The tool persists across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name (snake_case)' },
        description: { type: 'string', description: 'What the tool does' },
        context: {
          type: 'string',
          enum: ['extension'],
          description: 'Tool context (extension for MCP)',
        },
        inputSchema: { type: 'object', description: 'JSON schema for tool input' },
        code: { type: 'string', description: 'Python code for the tool' },
        origin_query: { type: 'string', description: 'User query that prompted creation' },
        reasoning: { type: 'string', description: 'Why this tool was needed' },
      },
      required: ['name', 'description', 'context', 'inputSchema', 'code'],
    },
  },
]);

function asContextSet(context) {
  if (!context) return null;
  return new Set(Array.isArray(context) ? context : [context]);
}

function mergeToolsByName(tools) {
  const byName = new Map();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}

function loadToolsFromDir(dir, options = {}) {
  const includeCode = options.includeCode !== false;
  const contexts = asContextSet(options.context);
  const tools = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const toolDir = path.join(dir, entry.name);
        const metaPath = path.join(toolDir, 'metadata.json');
        const toolPath = path.join(toolDir, 'tool.js');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const context = meta.context || 'webview';
        if (contexts && !contexts.has(context)) continue;

        const tool = {
          name: meta.name,
          description: meta.description,
          inputSchema: meta.inputSchema || {},
          context,
          source: dir,
          toolDir,
          toolPath,
        };
        if (includeCode && fs.existsSync(toolPath)) {
          tool.code = fs.readFileSync(toolPath, 'utf8');
        }
        tools.push(tool);
      } catch {
        // Skip invalid tool folders.
      }
    }
  } catch {
    // Directory may not exist yet.
  }

  return tools;
}

function loadAllTools(extensionPath = DEFAULT_EXTENSION_PATH, options = {}) {
  const builtinDir = path.join(extensionPath, 'ecosystem', 'tools');
  const builtin = loadToolsFromDir(builtinDir, options);
  const user = loadToolsFromDir(USER_TOOLS_DIR, options);
  return mergeToolsByName([...builtin, ...user]);
}

function buildToolSchemas(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function loadExtensionTool(tool) {
  const modPath = tool.toolPath || path.join(tool.source, tool.name, 'tool.js');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function resolveWorkspacePath(configDir, relativePath) {
  const safeBase = path.resolve(configDir);
  const resolved = path.resolve(configDir, relativePath);
  if (resolved !== safeBase && !resolved.startsWith(safeBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

function discoverYamlFiles(dir, relativePrefix = '') {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        results.push(path.join(relativePrefix, entry.name));
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        results.push(
          ...discoverYamlFiles(path.join(dir, entry.name), path.join(relativePrefix, entry.name))
        );
      }
    }
  } catch {
    // Ignore unreadable subdirectories.
  }
  return results;
}

function readYamlFile(configDir, file) {
  const full = resolveWorkspacePath(configDir, file);
  const raw = fs.readFileSync(full, 'utf8');
  const docs = yaml.loadAll(raw);
  return {
    full,
    raw,
    parsed: docs.length === 1 ? docs[0] : docs,
  };
}

function writeYamlFile(configDir, file, data) {
  const full = resolveWorkspacePath(configDir, file);
  let output;
  if (Array.isArray(data) && data.length > 1) {
    output = data.map((doc) => yaml.dump(doc, { lineWidth: -1 })).join('---\n');
  } else {
    const doc = Array.isArray(data) ? data[0] : data;
    output = yaml.dump(doc, { lineWidth: -1 });
  }
  fs.writeFileSync(full, output, 'utf8');
  return full;
}

function getNestedValue(obj, pathArr) {
  let cur = obj;
  for (const key of pathArr) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

function setNestedValue(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i];
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (cur == null) return false;
  }
  const lastKey = pathArr[pathArr.length - 1];
  if (Array.isArray(cur)) cur[Number(lastKey)] = value;
  else cur[lastKey] = value;
  return true;
}

function buildSchema(file, parsed) {
  const fields = [];

  function classifyValueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function summarizeArrayItems(items) {
    if (!items.length) return 'empty';
    const itemKinds = [];
    for (const item of items.slice(0, 5)) {
      const kind = classifyValueType(item);
      if (kind === 'object' && item && !Array.isArray(item)) {
        const keys = Object.keys(item).slice(0, 3).join(',');
        itemKinds.push(keys ? `object{${keys}}` : 'object');
      } else {
        itemKinds.push(kind);
      }
    }
    return [...new Set(itemKinds)].join('|');
  }

  function summarizeValue(value) {
    const kind = classifyValueType(value);
    if (kind === 'array') {
      return `array(len=${value.length}, item=${summarizeArrayItems(value)})`;
    }
    if (kind === 'object') {
      return `object(keys=${Object.keys(value || {}).length})`;
    }
    if (kind === 'string') {
      return `string(len=${value.length})`;
    }
    return kind;
  }

  function walk(obj, pathArr) {
    if (obj == null || typeof obj !== 'object') return;
    const keys = Array.isArray(obj) ? obj.map((_, idx) => idx) : Object.keys(obj);
    for (const key of keys) {
      const val = obj[key];
      const nextPath = [...pathArr, String(key)];
      if (val != null && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, nextPath);
      } else {
        fields.push({
          path: nextPath,
          preview: summarizeValue(val),
          type: classifyValueType(val),
        });
      }
    }
  }

  walk(parsed, []);
  return { file, fields };
}

function formatSchemaField(field) {
  const preview = field.preview != null
    ? String(field.preview)
    : field.value != null
      ? JSON.stringify(field.value)
      : field.type || 'unknown';
  return `  ${JSON.stringify(field.path)}  =  ${preview}  (${field.type})`;
}

function formatSchemaResult(file, schema, note = 'Structure only. Load the file in Python to inspect actual values.') {
  const lines = schema.fields.map(formatSchemaField).join('\n');
  return `[${file}]\nFIELDS (${schema.fields.length} total):\n${lines}\n\nNOTE:\n${note}`;
}

async function executePython(configDir, args, execFileAsyncImpl = defaultExecFileAsync) {
  const code = fixPythonForHeadless(args.code);
  const inputData = args.input_data ? JSON.stringify(args.input_data) : '';
  try {
    const { stdout, stderr } = await execFileAsyncImpl('python3', ['-c', code], {
      input: inputData,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: configDir,
    });
    let result = stdout || '';
    result = result.replace(/(^|\n)IMG:([A-Za-z0-9+/=]+)(?=\n|$)/g, (_, prefix) => {
      return '[matplotlib plot generated — base64 PNG captured]';
    });
    if (stderr) result += (result ? '\n' : '') + 'STDERR: ' + stderr;
    return result || '(no output)';
  } catch (err) {
    if (err.stdout || err.stderr) {
      return ('Error (exit ' + (err.code || '?') + '):\n' + (err.stderr || '') + '\n' + (err.stdout || '')).trim();
    }
    return 'Execution error: ' + err.message;
  }
}

function createWorkspaceRuntime(options) {
  const {
    configDir,
    extensionPath = DEFAULT_EXTENSION_PATH,
    dynamicTools = new Map(),
    execFileAsync = defaultExecFileAsync,
  } = options;

  function listTools() {
    const builtinNames = new Set(BUILTIN_MCP_TOOLS.map((tool) => tool.name));
    const userTools = loadToolsFromDir(USER_TOOLS_DIR, {
      includeCode: false,
      context: 'extension',
    });
    const merged = [...BUILTIN_MCP_TOOLS];
    for (const tool of userTools) {
      if (!builtinNames.has(tool.name)) {
        merged.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    for (const [name, tool] of dynamicTools) {
      if (!builtinNames.has(name)) {
        merged.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return merged;
  }

  async function callSessionTool(toolDef, args) {
    const handler = loadExtensionTool(toolDef);
    const activeTrailId = String((loadJaneSession(configDir).trailId || ''));
    return handler(args, {
      execFileAsync,
      configDir,
      trailId: String(args && args.trailId ? args.trailId : activeTrailId),
    });
  }

  async function proposeTool(args) {
    fs.mkdirSync(USER_TOOLS_DIR, { recursive: true });
    const toolDir = path.join(USER_TOOLS_DIR, args.name);
    fs.mkdirSync(toolDir, { recursive: true });

    const toolCode = '// Extension context\nmodule.exports = async function(input, context) {\n'
      + '  const { execFileAsync, configDir } = context;\n  '
      + args.code + '\n};\n';

    const hash = crypto.createHash('sha256').update(toolCode).digest('hex');
    let bigramId = hash.slice(0, 8);
    try {
      const { jungleBigram } = require(path.join(
        extensionPath,
        'ecosystem',
        'tools',
        'propose_tool',
        'bigrams.js'
      ));
      bigramId = jungleBigram(hash);
    } catch {
      // Fall back to a short hash if the helper is unavailable.
    }

    const metadata = {
      name: args.name,
      id: bigramId,
      hash,
      description: args.description,
      context: args.context || 'extension',
      inputSchema: args.inputSchema || {},
      created: new Date().toISOString().split('T')[0],
      origin_query: args.origin_query || null,
      reasoning: args.reasoning || null,
      model: 'claude-code',
      tested: false,
      approved: false,
      version: 1,
    };

    fs.writeFileSync(path.join(toolDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
    fs.writeFileSync(path.join(toolDir, 'tool.js'), toolCode, 'utf8');

    let lock = {};
    try {
      lock = JSON.parse(fs.readFileSync(TOOL_LOCK_PATH, 'utf8'));
    } catch {
      // New lock file.
    }
    lock[args.name] = {
      id: bigramId,
      hash,
      created_by: 'claude-code',
      created_at: new Date().toISOString(),
      tested: false,
      approved: false,
    };
    fs.writeFileSync(TOOL_LOCK_PATH, JSON.stringify(lock, null, 2), 'utf8');

    dynamicTools.set(args.name, {
      name: args.name,
      description: args.description,
      inputSchema: args.inputSchema || {},
      toolDir,
      toolPath: path.join(toolDir, 'tool.js'),
      context: args.context || 'extension',
      source: USER_TOOLS_DIR,
    });

    return `Tool "${args.name}" (${bigramId}) created and registered.`;
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'list_files': {
        const files = discoverYamlFiles(configDir);
        return files.length
          ? `Found ${files.length} YAML file(s):\n` + files.map((file) => `  - ${file}`).join('\n')
          : 'No YAML files found in ' + configDir;
      }

      case 'read_config': {
        const { parsed } = readYamlFile(configDir, args.file);
        const schema = buildSchema(args.file, parsed);
        return formatSchemaResult(args.file, schema);
      }

      case 'set_value': {
        const { parsed } = readYamlFile(configDir, args.file);
        const pathArr = args.path.map(String);
        const existing = getNestedValue(parsed, pathArr);
        if (existing === undefined) {
          return 'Path not found: ' + JSON.stringify(pathArr) + ' in ' + args.file;
        }
        let coerced = args.value;
        if (typeof existing === 'number' && typeof args.value !== 'number') {
          const num = Number(args.value);
          coerced = Number.isNaN(num) ? args.value : num;
        } else if (typeof existing === 'boolean' && typeof args.value !== 'boolean') {
          coerced = String(args.value).toLowerCase() === 'true';
        }
        setNestedValue(parsed, pathArr, coerced);
        writeYamlFile(configDir, args.file, parsed);
        return `${args.file}:${pathArr.join('.')} = ${JSON.stringify(coerced)} (saved to disk)`;
      }

      case 'execute_python':
        return callSessionTool({
          name: 'execute_python',
          toolPath: path.join(extensionPath, 'ecosystem', 'tools', 'execute_python', 'tool.js'),
          toolDir: path.join(extensionPath, 'ecosystem', 'tools', 'execute_python'),
          context: 'extension',
          source: path.join(extensionPath, 'ecosystem', 'tools'),
        }, args);

      case 'get_file_schema': {
        const { parsed } = readYamlFile(configDir, args.file);
        const schema = buildSchema(args.file, parsed);
        return formatSchemaResult(args.file, schema);
      }

      case 'propose_tool':
        return proposeTool(args);

      default: {
        if (dynamicTools.has(name)) {
          try {
            return await callSessionTool(dynamicTools.get(name), args);
          } catch (err) {
            return 'Error executing tool ' + name + ': ' + err.message;
          }
        }
        const userToolPath = path.join(USER_TOOLS_DIR, name, 'tool.js');
        if (fs.existsSync(userToolPath)) {
          try {
            return await callSessionTool(
              {
                name,
                toolPath: userToolPath,
                toolDir: path.dirname(userToolPath),
                context: 'extension',
                source: USER_TOOLS_DIR,
              },
              args
            );
          } catch (err) {
            return 'Error executing tool ' + name + ': ' + err.message;
          }
        }
        return 'Unknown tool: ' + name;
      }
    }
  }

  return {
    configDir,
    dynamicTools,
    listTools,
    callTool,
    discoverYamlFiles: () => discoverYamlFiles(configDir),
    readYaml: (file) => readYamlFile(configDir, file),
    writeYaml: (file, data) => writeYamlFile(configDir, file, data),
  };
}

module.exports = {
  BUILTIN_MCP_TOOLS,
  MCP_SERVER_INFO,
  USER_TOOLS_DIR,
  buildSchema,
  buildToolSchemas,
  createWorkspaceRuntime,
  discoverYamlFiles,
  getNestedValue,
  loadAllTools,
  loadExtensionTool,
  loadToolsFromDir,
  readYamlFile,
  resolveWorkspacePath,
  setNestedValue,
  writeYamlFile,
};
