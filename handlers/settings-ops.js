async function handleSettingsOp(msg, ctx) {
  const {
    vscode,
    configDir,
    panel,
    janeRuntime,
    context,
    connectCodingAgent,
  } = ctx;

  switch (msg.type) {
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
    case 'saveProjectPrompt': {
      const projectPromptKey = 'projectPrompt:' + configDir;
      context.workspaceState.update(projectPromptKey, msg.text || '');
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
