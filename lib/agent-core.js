const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  extractOpsFromText,
  detectUnfencedPython,
  fixPythonForHeadless,
} = require('./json-extract');
const { loadExtensionTool } = require('./selva-runtime');

function createToolkitBlock(allTools = []) {
  const userTools = allTools.filter((tool) => (tool.source || '').includes('.selva'));
  if (!userTools.length) return '';
  return `\nECOSYSTEM TOOLS (user-created):\n${userTools.map((tool) => `  - ${tool.name}: ${tool.description}`).join('\n')}`;
}

function readRepoContext(configDir, readmeBudget) {
  for (const dir of [configDir, path.dirname(configDir)]) {
    for (const fname of ['README.md', 'readme.md', 'README.txt', 'readme.txt']) {
      try {
        return fs.readFileSync(path.join(dir, fname), 'utf8').slice(0, readmeBudget);
      } catch {
        // Ignore missing files.
      }
    }
  }
  return '';
}

function buildSchemaBlock({ schemata = [], isBootstrap = false, fieldCharBudget = 0, dashboardState = {} }) {
  if (isBootstrap) {
    const totalFieldBudget = Math.max(50, Math.floor(fieldCharBudget / 80));
    const totalFields = schemata.reduce((sum, file) => sum + file.fields.length, 0);

    return schemata.map(({ file, fields }) => {
      const budget = Math.max(10, Math.round((fields.length / Math.max(totalFields, 1)) * totalFieldBudget));
      const truncated = fields.length > budget;
      const lines = fields.slice(0, budget).map(({ path, preview, value, type }) =>
        `    ${JSON.stringify(path)}  =  ${String(preview != null ? preview : JSON.stringify(value))}  (${type})`
      ).join('\n');
      const truncNote = truncated ? `\n    ... (${fields.length - budget} more fields, ${fields.length} total)` : '';
      return `  [${file}]\n  FIELDS (${fields.length} total):\n${lines}${truncNote}`;
    }).join('\n\n');
  }

  return schemata.map(({ file, fields }) => {
    const type = (dashboardState.fileTypes || {})[file] || 'unknown';
    return `  [${file}] (${type}, ${fields.length} fields)`;
  }).join('\n') + '\n  Use get_file_schema(file) to inspect a file\'s structure.';
}

function buildStateBlock({ dashboardState = {}, isBootstrap = false }) {
  if (isBootstrap) {
    return 'CURRENT DASHBOARD STATE:\n  (bootstrap — fresh session, no classifications yet)';
  }

  const pinnedEntries = [];
  for (const [file, paths] of Object.entries(dashboardState.pinnedFields || {})) {
    for (const p of (paths || [])) pinnedEntries.push(`  - ${file} → ${(p || []).join('.')}`);
  }
  const pinnedBlock = pinnedEntries.length
    ? `Pinned fields (${pinnedEntries.length}):\n${pinnedEntries.join('\n')}`
    : 'Pinned fields: none';
  const lockedList = (dashboardState.lockedFields || []).slice(0, 50);
  const lockedBlock = lockedList.length
    ? `Locked fields (${lockedList.length}): ${lockedList.map((key) => key.replace(':', ' → ')).join(', ')}`
    : 'Locked fields: none';
  return `CURRENT DASHBOARD STATE:\n  File classifications: ${JSON.stringify(dashboardState.fileTypes || {})}\n  Active config tab: ${dashboardState.activeConfigFile || '(none)'}\n  Active data tab: ${dashboardState.activeDataFile || '(none)'}\n  ${pinnedBlock}\n  ${lockedBlock}`;
}

function buildSystemPrompt({
  template,
  repoContext = '',
  schemaBlock = '',
  stateBlock = '',
  allTools = [],
  additionalPrompt = '',
  isBootstrap = false,
}) {
  const contextSection = repoContext ? `REPO CONTEXT (from README):\n${repoContext}` : '';
  let systemPrompt = template
    .replace('{{REPO_CONTEXT}}', contextSection)
    .replace('{{SCHEMA_BLOCK}}', schemaBlock)
    .replace('{{DASHBOARD_STATE}}', stateBlock)
    + createToolkitBlock(allTools);
  if (!isBootstrap && additionalPrompt) {
    systemPrompt += '\n\nADDITIONAL USER INSTRUCTIONS:\n' + additionalPrompt;
  }
  return systemPrompt;
}

function sliceConversationHistory(history = [], historyBudget = 0) {
  let historyChars = 0;
  let startIdx = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const turnChars = (history[i].content || '').length;
    if (historyChars + turnChars > historyBudget) break;
    historyChars += turnChars;
    startIdx = i;
  }
  if (startIdx % 2 !== 0 && startIdx > 0) startIdx++;
  return history.slice(startIdx);
}

function buildDirectMessages({
  isBootstrap = false,
  bootstrapPrompt = '',
  prompt = '',
  conversationHistory = [],
  charBudget = 0,
}) {
  if (isBootstrap) {
    return [{ role: 'user', content: bootstrapPrompt }];
  }

  const history = sliceConversationHistory(conversationHistory, Math.floor(charBudget * 0.30));
  return [
    ...history.map((turn) => ({
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.content,
    })),
    { role: 'user', content: prompt },
  ];
}

function buildLanguageModelMessages({
  vscode,
  systemPrompt,
  isBootstrap = false,
  bootstrapPrompt = '',
  prompt = '',
  conversationHistory = [],
  charBudget = 0,
}) {
  const messages = [vscode.LanguageModelChatMessage.User(systemPrompt)];
  if (isBootstrap) {
    messages.push(vscode.LanguageModelChatMessage.User(bootstrapPrompt));
    return messages;
  }

  const history = sliceConversationHistory(conversationHistory, Math.floor(charBudget * 0.30));
  for (const turn of history) {
    messages.push(
      turn.role === 'user'
        ? vscode.LanguageModelChatMessage.User(turn.content)
        : vscode.LanguageModelChatMessage.Assistant(turn.content)
    );
  }
  messages.push(vscode.LanguageModelChatMessage.User(prompt));
  return messages;
}

async function callAnthropicAPI(apiKey, modelId, systemPrompt, messages, tools, cancellationToken) {
  const anthropicModel = modelId.replace('direct:', '');
  const anthropicMessages = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const anthropicTools = (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

  const body = {
    model: anthropicModel,
    max_tokens: 4096,
    system: systemPrompt,
    messages: anthropicMessages,
  };
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  return new Promise((resolve, reject) => {
    if (cancellationToken && cancellationToken.isCancellationRequested) {
      reject(new Error('cancelled'));
      return;
    }

    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid API response'));
        }
      });
    });
    req.on('error', reject);
    if (cancellationToken) {
      cancellationToken.onCancellationRequested(() => {
        req.destroy();
        reject(new Error('cancelled'));
      });
    }
    req.write(postData);
    req.end();
  });
}

async function callOpenAIAPI(apiKey, modelId, systemPrompt, messages, tools, cancellationToken) {
  const openaiModel = modelId.replace('direct:', '');
  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const openaiTools = (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  const body = { model: openaiModel, messages: openaiMessages };
  if (openaiTools.length > 0) body.tools = openaiTools;

  return new Promise((resolve, reject) => {
    if (cancellationToken && cancellationToken.isCancellationRequested) {
      reject(new Error('cancelled'));
      return;
    }

    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid API response'));
        }
      });
    });
    req.on('error', reject);
    if (cancellationToken) {
      cancellationToken.onCancellationRequested(() => {
        req.destroy();
        reject(new Error('cancelled'));
      });
    }
    req.write(postData);
    req.end();
  });
}

function captureImagesFromResult(result, capturedImages) {
  if (typeof result !== 'string') return result;
  return result.replace(/(^|\n)IMG:([A-Za-z0-9+/=]+)(?=\n|$)/g, (_, prefix, b64) => {
    capturedImages.push(b64);
    return `${prefix}[plot generated]`;
  });
}

async function executeToolCall(call, options) {
  const {
    toolsByName,
    accumulatedOps,
    capturedImages,
    executedCells,
    execFileAsync,
    configDir,
    panel,
    schemata,
    trailId,
    modelName,
    recordExecutedCell = true,
  } = options;

  const input = call.input || {};
  const tool = toolsByName.get(call.name);
  if (!tool) return `Unknown tool: ${call.name}`;

  try {
    if (tool.context === 'extension') {
      const handler = loadExtensionTool(tool);
      let result = await handler(input, {
        execFileAsync,
        configDir,
        panel,
        modelName,
        schemata,
        trailId,
      });
      if (recordExecutedCell && call.name === 'execute_python' && input.code) {
        executedCells.push({ code: input.code, output: typeof result === 'string' ? result : '' });
      }
      return captureImagesFromResult(result, capturedImages);
    }

    accumulatedOps.push({ fn: call.name, input });
    return `Done: ${call.name}(${JSON.stringify(input).slice(0, 200)})`;
  } catch (err) {
    return `Error in ${call.name}: ${err.message}`;
  }
}

async function runDirectAPILoop(options) {
  const {
    modelId,
    apiKeys,
    systemPrompt,
    messages,
    toolSchemas,
    executeTool,
    cancellationToken,
  } = options;

  const isAnthropic = modelId.startsWith('direct:claude');
  const apiKey = isAnthropic ? apiKeys.anthropic : apiKeys.openai;
  if (!apiKey) throw new Error(`No API key set for ${isAnthropic ? 'Anthropic' : 'OpenAI'}`);

  const MAX_TURNS = 10;
  let finalAnswer = '';
  let usedTools = false;
  const totalTokens = { input: 0, output: 0 };
  const apiMessages = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;

    if (isAnthropic) {
      response = await callAnthropicAPI(apiKey, modelId, systemPrompt, apiMessages, toolSchemas, cancellationToken);
      if (response.usage) {
        totalTokens.input += response.usage.input_tokens || 0;
        totalTokens.output += response.usage.output_tokens || 0;
      }

      let turnText = '';
      const toolCalls = [];
      for (const block of (response.content || [])) {
        if (block.type === 'text') turnText += block.text;
        if (block.type === 'tool_use') toolCalls.push(block);
      }

      if (toolCalls.length === 0) {
        finalAnswer += turnText;
        break;
      }

      if (usedTools && turnText) finalAnswer += turnText;
      usedTools = true;
      apiMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const toolCall of toolCalls) {
        const result = await executeTool({ name: toolCall.name, input: toolCall.input });
        toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: result });
      }
      apiMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    response = await callOpenAIAPI(apiKey, modelId, systemPrompt, apiMessages, toolSchemas, cancellationToken);
    if (response.usage) {
      totalTokens.input += response.usage.prompt_tokens || 0;
      totalTokens.output += response.usage.completion_tokens || 0;
    }
    const choice = response.choices && response.choices[0];
    if (!choice) break;

    const message = choice.message;
    const turnText = message.content || '';
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      finalAnswer += turnText;
      break;
    }

    if (usedTools && turnText) finalAnswer += turnText;
    usedTools = true;
    apiMessages.push({
      role: 'assistant',
      content: message.content,
      tool_calls: message.tool_calls,
    });

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const result = await executeTool({ name: toolCall.function.name, input: args });
      apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  return { answer: finalAnswer, usage: totalTokens, usedTools };
}

async function runVscodeToolLoop(options) {
  const {
    vscode,
    model,
    messages,
    toolSchemas,
    executeTool,
    cancellationToken,
  } = options;

  const MAX_TURNS = 10;
  let finalAnswer = '';
  let usedTools = false;

  const toolOptions = {
    tools: toolSchemas,
    justification: 'Selva agent needs tools to modify config values, lock fields, and run analysis.',
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await model.sendRequest(messages, toolOptions, cancellationToken);
    const toolCalls = [];
    let turnText = '';

    if (response.stream) {
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          turnText += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }
    } else {
      for await (const chunk of response.text) turnText += chunk;
    }

    if (toolCalls.length === 0) {
      finalAnswer += turnText;
      break;
    }

    if (usedTools && turnText) finalAnswer += turnText;
    usedTools = true;

    const assistantParts = [];
    if (turnText) assistantParts.push(new vscode.LanguageModelTextPart(turnText));
    assistantParts.push(...toolCalls);
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    for (const toolCall of toolCalls) {
      const result = await executeTool({ name: toolCall.name, input: toolCall.input || {} });
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(toolCall.callId, [
            new vscode.LanguageModelTextPart(result),
          ]),
        ])
      );
    }
  }

  return { answer: finalAnswer, usedTools };
}

async function maybeAutoExecutePlotCode(options) {
  const { finalAnswer, capturedImages, executeTool } = options;
  if (capturedImages.length > 0 || !finalAnswer) return;

  let pyCode = null;
  const pyFenced = finalAnswer.match(/```(?:python|execute_python|py)\n([\s\S]*?)```/);
  if (pyFenced && /(?:plt\.|matplotlib|savefig|\.plot\(|\.scatter\(|\.bar\(|\.hist\()/.test(pyFenced[1])) {
    pyCode = pyFenced[1];
  } else {
    const unfenced = detectUnfencedPython(finalAnswer);
    if (unfenced.hasPython && /plt\./m.test(unfenced.code)) {
      pyCode = unfenced.code;
    }
  }

  if (!pyCode) return;

  pyCode = fixPythonForHeadless(pyCode);
  try {
    await executeTool({
      name: 'execute_python',
      input: { code: pyCode },
      modelName: 'auto-python',
      recordExecutedCell: false,
    });
  } catch {
    // Python execution is best-effort in this fallback path.
  }
}

async function interceptExtensionOps(options) {
  const {
    accumulatedOps,
    toolsByName,
    executeTool,
  } = options;

  console.log('[Selva] Pre-interception ops:', accumulatedOps.length, accumulatedOps.map((op) => op.fn));
  const webviewOps = [];

  for (const op of accumulatedOps) {
    const toolDef = toolsByName.get(op.fn);
    if (toolDef && toolDef.context === 'extension') {
      try {
        await executeTool({
          name: op.fn,
          input: op.input || {},
          modelName: 'json-fallback',
          recordExecutedCell: false,
        });
      } catch (err) {
        console.error('[Selva] Extension tool failed:', op.fn, err.message);
      }
    } else {
      webviewOps.push(op);
    }
  }

  console.log('[Selva] Post-interception: webview ops:', webviewOps.length, 'extension ops executed:', accumulatedOps.length - webviewOps.length);
  accumulatedOps.length = 0;
  accumulatedOps.push(...webviewOps);
}

function injectCapturedImages(finalAnswer, capturedImages) {
  if (!capturedImages.length) return finalAnswer;
  const imgTags = capturedImages.map((b64) => `IMG:${b64}`).join('\n\n');
  return (finalAnswer || '') + '\n\n' + imgTags;
}

async function runAgentRequest(options) {
  const {
    vscode,
    model,
    modelId,
    isDirectAPI,
    systemPrompt,
    isBootstrap = false,
    prompt = '',
    bootstrapPrompt = '',
    conversationHistory = [],
    charBudget = 0,
    toolSchemas,
    toolsByName,
    configDir,
    panel,
    token,
    schemata,
    trailId,
    apiKeys,
    execFileAsync,
  } = options;

  const accumulatedOps = [];
  const capturedImages = [];
  const executedCells = [];
  let finalAnswer = '';
  let usedTools = false;
  const usage = { input: 0, output: 0 };

  const executeTool = async (call) => {
    const { modelName, recordExecutedCell } = call;
    return executeToolCall(
      { name: call.name, input: call.input || {} },
      {
        toolsByName,
        accumulatedOps,
        capturedImages,
        executedCells,
        execFileAsync,
        configDir,
        panel,
        schemata,
        trailId,
        modelName: modelName || (model && (model.name || model.family)) || 'agent',
        recordExecutedCell,
      }
    );
  };

  const messages = !isDirectAPI && vscode.lm
    ? buildLanguageModelMessages({
      vscode,
      systemPrompt,
      isBootstrap,
      bootstrapPrompt,
      prompt,
      conversationHistory,
      charBudget,
    })
    : [];

  const hasToolSupport = !!(vscode.LanguageModelToolCallPart && vscode.LanguageModelToolResultPart);

  if (isDirectAPI) {
    const directResult = await runDirectAPILoop({
      modelId,
      apiKeys,
      systemPrompt,
      messages: buildDirectMessages({
        isBootstrap,
        bootstrapPrompt,
        prompt,
        conversationHistory,
        charBudget,
      }),
      toolSchemas,
      executeTool,
      cancellationToken: token,
    });
    finalAnswer = directResult.answer;
    usedTools = directResult.usedTools;
    usage.input += directResult.usage.input || 0;
    usage.output += directResult.usage.output || 0;
  } else if (hasToolSupport) {
    try {
      const toolResult = await runVscodeToolLoop({
        vscode,
        model,
        messages,
        toolSchemas,
        executeTool,
        cancellationToken: token,
      });
      finalAnswer = toolResult.answer;
      usedTools = toolResult.usedTools;
    } catch {
      if (!finalAnswer) finalAnswer = '';
      usedTools = false;
    }
  }

  if (!usedTools && accumulatedOps.length === 0) {
    let raw = finalAnswer;
    if (!raw) {
      const response = await model.sendRequest(messages, {}, token);
      raw = '';
      for await (const chunk of response.text) raw += chunk;
    }
    if (!raw || !raw.trim()) {
      return {
        answer: null,
        ops: [],
        executedCells: undefined,
        usage,
        error: 'Model returned an empty response.',
      };
    }
    const extracted = extractOpsFromText(raw);
    console.log('[Selva] JSON fallback — raw:', raw.slice(0, 300), '→ ops:', extracted.ops.length, 'answer:', (extracted.answer || '').slice(0, 100));
    finalAnswer = extracted.answer;
    accumulatedOps.push(...extracted.ops);
  }

  await maybeAutoExecutePlotCode({
    finalAnswer,
    capturedImages,
    executeTool,
  });

  await interceptExtensionOps({
    accumulatedOps,
    toolsByName,
    executeTool,
  });

  finalAnswer = injectCapturedImages(finalAnswer, capturedImages);

  return {
    answer: finalAnswer || null,
    ops: accumulatedOps,
    executedCells: executedCells.length > 0 ? executedCells : undefined,
    usage,
    error: null,
  };
}

module.exports = {
  buildSchemaBlock,
  buildDirectMessages,
  buildLanguageModelMessages,
  buildStateBlock,
  buildSystemPrompt,
  callAnthropicAPI,
  callOpenAIAPI,
  createToolkitBlock,
  readRepoContext,
  runAgentRequest,
  sliceConversationHistory,
};
