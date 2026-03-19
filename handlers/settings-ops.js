async function handleSettingsOp(msg, ctx) {
  const {
    vscode,
    configDir,
    panel,
    janeRuntime,
    context,
    apiKeys,
    sendModelList,
    listCodingAgents,
    connectCodingAgent,
  } = ctx;

  switch (msg.type) {
    case 'listModels': {
      sendModelList(panel);
      break;
    }
    case 'connectCodingAgent': {
      try {
        const result = await connectCodingAgent({
          agentId: String(msg.agentId || ''),
          janeRuntime,
        });
        panel.webview.postMessage({
          type: 'codingAgentConnected',
          agent: result.agent,
          launchMode: result.launchMode,
          promptCopied: result.promptCopied,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: 'codingAgentConnectionError',
          error: e.message,
        });
      }
      break;
    }
    case 'saveUserDefaults': {
      context.globalState.update('userDefaultSettings', msg.settings);
      break;
    }
    case 'savePinned': {
      const pinnedKey = 'pinnedFields:' + configDir;
      context.workspaceState.update(pinnedKey, msg.pinned);
      break;
    }
    case 'saveAdditionalInstructions':
    case 'janeSessionSetInstructions': {
      janeRuntime.setSessionInstructions(msg.text || '');
      context.globalState.update('additionalInstructions', msg.text || '');
      break;
    }
    case 'setAgentModel':
    case 'janeSessionSetModel': {
      janeRuntime.setSessionModel(msg.modelId || '');
      break;
    }
    case 'setApiKey': {
      if (msg.provider === 'anthropic') apiKeys.anthropic = msg.key || '';
      else if (msg.provider === 'openai') apiKeys.openai = msg.key || '';
      if (msg.key) {
        context.secrets.store('apiKey:' + msg.provider, msg.key);
      } else {
        context.secrets.delete('apiKey:' + msg.provider);
      }
      sendModelList(panel);
      break;
    }
    case 'openUrl': {
      const url = msg.url;
      if (url && /^https?:\/\//.test(url)) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
      break;
    }
  }
}

module.exports = { handleSettingsOp };
