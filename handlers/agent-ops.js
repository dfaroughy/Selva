async function handleAgentOp(msg, ctx) {
  const {
    vscode,
    configDir,
    panel,
    janeRuntime,
    apiKeys,
    activeTokenSources,
    execFileAsync,
    runExternalCellEditWithRetries,
    runLegacyInternalCellEdit,
  } = ctx;

  switch (msg.type) {
    case 'bootstrap':
    case 'agentPrompt':
    case 'janeSessionBootstrap':
    case 'janeSessionRun': {
      const isBootstrap = msg.type === 'bootstrap' || msg.type === 'janeSessionBootstrap';
      try {
        const tokenSource = new vscode.CancellationTokenSource();
        activeTokenSources.set(configDir, tokenSource);
        const agentResult = isBootstrap
          ? await janeRuntime.bootstrapSession({
            modelId: msg.modelId || '',
            pendingEdits: msg.pendingEdits || [],
            dashboardState: msg.dashboardState || null,
            apiKeys,
            vscodeApi: vscode,
            panel,
            token: tokenSource.token,
            execFileAsync,
            persistConfigChanges: false,
            onUsage: (usage) => {
              panel.webview.postMessage({
                type: 'tokenUsage',
                input: usage.input,
                output: usage.output,
              });
            },
          })
          : await janeRuntime.runSessionTurn({
            prompt: msg.prompt || '',
            modelId: msg.modelId || '',
            pendingEdits: msg.pendingEdits || [],
            dashboardState: msg.dashboardState || null,
            apiKeys,
            vscodeApi: vscode,
            panel,
            token: tokenSource.token,
            execFileAsync,
            persistConfigChanges: false,
            onUsage: (usage) => {
              panel.webview.postMessage({
                type: 'tokenUsage',
                input: usage.input,
                output: usage.output,
              });
            },
          });

        activeTokenSources.delete(configDir);
        panel.webview.postMessage({
          type: 'janeSessionResult',
          mode: isBootstrap ? 'bootstrap' : 'turn',
          answer: agentResult.answer,
          summary: agentResult.summary,
          ops: agentResult.ops,
          executedCells: agentResult.executedCells,
          artifacts: agentResult.artifacts,
          session: agentResult.session,
          entry: agentResult.entry,
          modelId: agentResult.modelId,
          error: agentResult.error,
        });

      } catch (e) {
        activeTokenSources.delete(configDir);
        if (e.message && e.message.includes('cancelled')) return;
        panel.webview.postMessage({
          type: 'janeSessionResult',
          mode: isBootstrap ? 'bootstrap' : 'turn',
          ops: [],
          answer: null,
          error: isBootstrap ? undefined : (e.message || String(e)),
        });
      }
      break;
    }
    case 'editCellCode': {
      try {
        const sessionInstructions = janeRuntime.getSession().additionalInstructions || '';
        let result;

        if (msg.agentId) {
          const activeSession = janeRuntime.getSession();
          result = await runExternalCellEditWithRetries({
            agentId: msg.agentId,
            code: msg.code || '',
            instruction: msg.instruction || '',
            language: msg.language || 'python',
            output: msg.output || '',
            configDir,
            sessionInstructions,
            panel,
            trailId: msg.trailId || activeSession.trailId || '',
          });
        } else {
          result = await runLegacyInternalCellEdit({
            code: msg.code || '',
            instruction: msg.instruction || '',
            modelId: msg.modelId || '',
          });
        }

        panel.webview.postMessage({
          type: 'editCellCodeResult',
          requestId: msg.requestId || '',
          cellId: msg.cellId || '',
          code: result.code || null,
          output: Object.prototype.hasOwnProperty.call(result, 'output') ? result.output : undefined,
          attempts: result.attempts || 1,
          validated: !!result.validated,
          validationError: result.error || '',
          agentId: msg.agentId || '',
        });
      } catch (e) {
        panel.webview.postMessage({
          type: 'editCellCodeResult',
          requestId: msg.requestId || '',
          cellId: msg.cellId || '',
          error: e.message,
        });
      }
      break;
    }
    case 'abortAgent': {
      const ts = activeTokenSources.get(configDir);
      if (ts) {
        ts.cancel();
        activeTokenSources.delete(configDir);
      }
      break;
    }
  }
}

module.exports = { handleAgentOp };
