async function handleAgentOp(msg, ctx) {
  const {
    vscode,
    configDir,
    panel,
    janeRuntime,
    activeTokenSources,
    runExternalCellEditWithRetries,
  } = ctx;

  switch (msg.type) {
    case 'editCellCode': {
      try {
        const sessionInstructions = janeRuntime.getSession().additionalInstructions || '';
        const activeSession = janeRuntime.getSession();
        const result = await runExternalCellEditWithRetries({
          agentId: msg.agentId || '',
          code: msg.code || '',
          instruction: msg.instruction || '',
          language: msg.language || 'python',
          output: msg.output || '',
          configDir,
          sessionInstructions,
          panel,
          trailId: msg.trailId || activeSession.trailId || '',
        });

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
