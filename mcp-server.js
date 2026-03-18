#!/usr/bin/env node
// Selva MCP Server
// Exposes Selva's YAML and Jane session tools via the official MCP stdio transport.

const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const {
  buildSchema,
  createWorkspaceRuntime,
  getNestedValue,
  MCP_SERVER_INFO,
  setNestedValue,
} = require(path.join(__dirname, 'lib', 'selva-runtime'));
const { createJaneRuntime } = require(path.join(__dirname, 'lib', 'jane-runtime'));
const {
  enqueueExternalDraft,
  hasOpenPanelSession,
} = require(path.join(__dirname, 'lib', 'session-store'));

const configDir = process.argv[2] || process.cwd();
const runtime = createWorkspaceRuntime({ configDir, extensionPath: __dirname });
const janeRuntime = createJaneRuntime({
  configDir,
  extensionPath: __dirname,
  workspaceRuntime: runtime,
});

const NULL_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

function getApiKeys() {
  return {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPendingDraftValueOps() {
  const session = janeRuntime.getSession();
  if (!hasOpenPanelSession(session)) return [];
  return (session.pendingExternalDrafts || [])
    .flatMap((draft) => draft.ops || [])
    .filter((op) => op && op.fn === 'setValue' && op.input && op.input.file && op.input.path);
}

function applyDraftValueOps(file, parsed) {
  const next = clone(parsed);
  for (const op of getPendingDraftValueOps()) {
    if (op.input.file !== file) continue;
    setNestedValue(next, op.input.path.map(String), clone(op.input.value));
  }
  return next;
}

function readEffectiveYaml(file) {
  const { raw, parsed } = runtime.readYaml(file);
  return {
    raw,
    parsed: applyDraftValueOps(file, parsed),
  };
}

function formatSchemaReadout(file, raw, parsed, rawLimit = 4000) {
  const schema = buildSchema(file, parsed);
  const lines = schema.fields
    .map((field) => `  ${JSON.stringify(field.path)}  =  ${JSON.stringify(field.value)}  (${field.type})`)
    .join('\n');
  let result = `[${file}]\nFIELDS (${schema.fields.length} total):\n${lines}`;
  const rawPreview = raw.slice(0, rawLimit);
  result += '\n\nRAW YAML:\n' + rawPreview;
  if (raw.length > rawLimit) result += '\n... (truncated, ' + raw.length + ' chars total)';
  const stagedCount = getPendingDraftValueOps().filter((op) => op.input.file === file).length;
  if (stagedCount > 0) {
    result += `\n\nSTAGED DRAFTS APPLIED IN VIEW (${stagedCount} pending setValue op${stagedCount > 1 ? 's' : ''})`;
  }
  return result;
}

function buildDraftAwareSchemata() {
  return runtime.discoverYamlFiles().map((file) => {
    const { raw, parsed } = readEffectiveYaml(file);
    return {
      file,
      raw,
      fields: buildSchema(file, parsed).fields,
    };
  });
}

function stageSetValueDraft(args) {
  const pathArr = (args.path || []).map(String);
  const { parsed } = readEffectiveYaml(args.file);
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

  enqueueExternalDraft(configDir, {
    source: 'mcp:set_value',
    note: `Staged ${args.file}:${pathArr.join('.')} in the open Selva panel.`,
    ops: [
      {
        fn: 'setValue',
        input: {
          file: args.file,
          path: pathArr,
          value: coerced,
        },
      },
    ],
  });

  return `${args.file}:${pathArr.join('.')} = ${JSON.stringify(coerced)} (staged in open Selva panel; use Save to commit)`;
}

async function callTool(toolName, toolArgs) {
  const panelOpen = hasOpenPanelSession(janeRuntime.getSession());

  if (janeRuntime.isSessionTool(toolName)) {
    return janeRuntime.handleSessionToolCall(toolName, toolArgs, {
      apiKeys: getApiKeys(),
      panel: null,
      vscodeApi: {},
      token: NULL_TOKEN,
      execFileAsync: undefined,
      persistConfigChanges: !panelOpen,
      schemata: panelOpen ? buildDraftAwareSchemata() : undefined,
      stageDraftValueOps: panelOpen,
    });
  }

  if (toolName === 'read_config' && panelOpen) {
    const { raw, parsed } = readEffectiveYaml(toolArgs.file);
    return formatSchemaReadout(toolArgs.file, raw, parsed, 4000);
  }

  if (toolName === 'get_file_schema' && panelOpen) {
    const { raw, parsed } = readEffectiveYaml(toolArgs.file);
    return formatSchemaReadout(toolArgs.file, raw, parsed, 3000);
  }

  if (toolName === 'set_value' && panelOpen) {
    return stageSetValueDraft(toolArgs);
  }

  return runtime.callTool(toolName, toolArgs);
}

function compactEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    id: entry.id || '',
    question: entry.question || '',
    answer: entry.answer || '',
    summary: entry.summary || '',
    isError: !!entry.isError,
    executedCellCount: Array.isArray(entry.executedCells) ? entry.executedCells.length : 0,
    cellCount: Array.isArray(entry.cells) ? entry.cells.length : 0,
    cells: Array.isArray(entry.cells)
      ? entry.cells.map((cell) => ({
        id: cell && cell.id ? cell.id : '',
        type: cell && cell.type ? cell.type : '',
        lang: cell && cell.lang ? cell.lang : '',
        contentPreview: cell && cell.content ? String(cell.content).slice(0, 120) : '',
        codePreview: cell && cell.code ? String(cell.code).slice(0, 120) : '',
        outputPreview: cell && cell.output ? String(cell.output).slice(0, 120) : '',
        dataLength: cell && cell.data ? String(cell.data).length : 0,
        diffCount: Array.isArray(cell && cell.diffs) ? cell.diffs.length : 0,
      }))
      : [],
    timestamp: entry.timestamp || null,
  };
}

function compactJaneToolResult(toolName, result) {
  if (!janeRuntime.isSessionTool(toolName)) return result;
  if (!result || typeof result !== 'object') return result;

  if (Array.isArray(result.ops) || Object.prototype.hasOwnProperty.call(result, 'session')) {
    return {
      ok: result.ok !== undefined ? !!result.ok : undefined,
      modelId: result.modelId || '',
      answer: result.answer || '',
      summary: result.summary || '',
      error: result.error || null,
      usage: result.usage || { input: 0, output: 0 },
      opCount: Array.isArray(result.ops) ? result.ops.length : 0,
      ops: Array.isArray(result.ops) ? result.ops : [],
      executedCellCount: Array.isArray(result.executedCells) ? result.executedCells.length : 0,
      entry: compactEntry(result.entry),
      session: janeRuntime.getSessionSummary(),
    };
  }

  return result;
}

function toTextToolResult(toolName, result) {
  const compactResult = compactJaneToolResult(toolName, result);

  if (typeof result === 'string') {
    return {
      content: [{ type: 'text', text: result }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(compactResult) }],
  };
}

async function main() {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...runtime.listTools(), ...janeRuntime.listSessionTools()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};

    try {
      const result = await callTool(toolName, toolArgs);
      return toTextToolResult(toolName, result);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: ' + (error instanceof Error ? error.message : String(error)),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`Selva MCP server started — configDir: ${configDir}\n`);

  const closeServer = async () => {
    try {
      await server.close();
    } catch {
      // Ignore shutdown errors.
    }
  };

  process.on('SIGINT', () => {
    closeServer().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    closeServer().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  process.stderr.write(`Selva MCP server failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
