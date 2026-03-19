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
  clone,
  enqueueExternalDraft,
  hasOpenPanelSession,
} = require(path.join(__dirname, 'lib', 'session-store'));
const { coerceValue } = require(path.join(__dirname, 'lib', 'value-coerce'));

const configDir = process.argv[2] || process.cwd();
const runtime = createWorkspaceRuntime({ configDir, extensionPath: __dirname });
const janeRuntime = createJaneRuntime({
  configDir,
  extensionPath: __dirname,
  workspaceRuntime: runtime,
});

// Buffer of successful execute_python results. When the agent calls
// jane_session_record_entry or jane_add_cells, these are attached automatically
// so the notebook gets the real code/output instead of the agent's reconstruction.
// Failed executions are excluded — only the final working code matters.
const pendingExecutedCells = [];

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

function formatSchemaReadout(file, raw, parsed) {
  const schema = buildSchema(file, parsed);
  const lines = schema.fields
    .map((field) => `  ${JSON.stringify(field.path)}  =  ${String(field.preview || field.type)}  (${field.type})`)
    .join('\n');
  let result = `[${file}]\nFIELDS (${schema.fields.length} total):\n${lines}`;
  result += '\n\nNOTE: Use execute_python to load and inspect actual values from disk.';
  const stagedCount = getPendingDraftValueOps().filter((op) => op.input.file === file).length;
  if (stagedCount > 0) {
    result += `\nSTAGED DRAFTS APPLIED IN VIEW (${stagedCount} pending setValue op${stagedCount > 1 ? 's' : ''})`;
  }
  return result;
}

function buildDraftAwareSchemata() {
  return runtime.discoverYamlFiles().map((file) => {
    const { parsed } = readEffectiveYaml(file);
    return {
      file,
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

  const coerced = coerceValue(existing, args.value);

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
    // When the agent records a notebook entry, attach any buffered executed cells
    // so the notebook gets real code/output instead of the agent's reconstruction.
    if ((toolName === 'jane_session_record_entry' || toolName === 'jane_add_cells')
        && pendingExecutedCells.length > 0) {
      const buffered = pendingExecutedCells.splice(0);
      const existing = toolName === 'jane_add_cells'
        ? (Array.isArray(toolArgs.cells) ? toolArgs.cells : [])
        : [];
      // Use the buffered cells as the authoritative source; keep any non-python
      // cells (like markdown) the agent explicitly provided.
      const agentNonCode = existing.filter((c) => c && c.type !== 'python' && c.type !== 'image');
      toolArgs.cells = [...agentNonCode, ...buffered];
      if (toolName === 'jane_session_record_entry' && !toolArgs.executedCells) {
        // Clear executedCells so the agent's abbreviated versions are not used.
        toolArgs.executedCells = [];
      }
    }
    return janeRuntime.handleSessionToolCall(toolName, toolArgs, {
      apiKeys: getApiKeys(),
      panel: null,
      vscodeApi: {},
      token: NULL_TOKEN,
      execFileAsync: undefined,
      persistConfigChanges: !panelOpen,
      stageDraftValueOps: panelOpen,
    });
  }

  if (toolName === 'read_config' && panelOpen) {
    const { raw, parsed } = readEffectiveYaml(toolArgs.file);
    return formatSchemaReadout(toolArgs.file, raw, parsed);
  }

  if (toolName === 'get_file_schema' && panelOpen) {
    const { raw, parsed } = readEffectiveYaml(toolArgs.file);
    return formatSchemaReadout(toolArgs.file, raw, parsed);
  }

  if (toolName === 'set_value' && panelOpen) {
    return stageSetValueDraft(toolArgs);
  }

  const result = await runtime.callTool(toolName, toolArgs);

  // Buffer successful execute_python results. Failed executions are excluded
  // so the notebook only gets the final working code, not debug iterations.
  if (toolName === 'execute_python' && toolArgs.code && typeof result === 'string') {
    const isError = /^Error \(exit\s+\d+\)|^Execution error:|Traceback \(most recent call last\)/i.test(result.trim());
    if (!isError) {
      const cells = [];
      let textOutput = result;
      const imgMatches = [...result.matchAll(/(?:^|\n)IMG:([A-Za-z0-9+/=]+)(?=\n|$)/g)];
      if (imgMatches.length > 0) {
        textOutput = result.replace(/(?:^|\n)IMG:([A-Za-z0-9+/=]+)(?=\n|$)/g, '').trim();
        textOutput = textOutput || '(plot generated)';
      }
      cells.push({ type: 'python', code: toolArgs.code, output: textOutput, runState: 'done' });
      for (const m of imgMatches) {
        cells.push({ type: 'image', data: m[1] });
      }
      pendingExecutedCells.push(...cells);
    }
  }

  return result;
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

const TOOL_RESULT_MAX_CHARS = 3000;

function compactToolResult(text) {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const headBudget = Math.floor(TOOL_RESULT_MAX_CHARS * 0.7);
  const tailBudget = TOOL_RESULT_MAX_CHARS - headBudget;
  const head = text.slice(0, headBudget);
  const tail = text.slice(-tailBudget);
  const dropped = text.length - headBudget - tailBudget;
  return head + `\n\n... (${dropped} chars omitted) ...\n\n` + tail;
}

function toTextToolResult(toolName, result) {
  const compactResult = compactJaneToolResult(toolName, result);

  if (typeof result === 'string') {
    return {
      content: [{ type: 'text', text: compactToolResult(result) }],
    };
  }

  const text = JSON.stringify(compactResult);
  return {
    content: [{ type: 'text', text: compactToolResult(text) }],
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
