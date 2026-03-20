const { executeNotebookCell } = require('../lib/notebook-execution');
const { getNotebookKernelManager } = require('../lib/kernel-manager');

async function handleKernelOp(msg, ctx) {
  const { configDir, panel, janeRuntime, execFileAsync, extensionPath } = ctx;

  switch (msg.type) {
    case 'executeCell': {
      try {
        const activeSession = janeRuntime.getSession();
        const request = {
          language: msg.language || 'python',
          configDir,
          trailId: msg.trailId || activeSession.trailId || '',
        };
        const onStream = (text) => {
          panel.webview.postMessage({
            type: 'cellOutputStream',
            requestId: msg.requestId || '',
            cellId: msg.cellId || '',
            text,
          });
        };
        const result = await executeNotebookCell({
          language: request.language,
          code: msg.code,
          configDir,
          extensionPath,
          execFileAsync,
          panel,
          trailId: request.trailId,
          onStream,
        });
        panel.webview.postMessage({
          type: 'executeCellResult',
          requestId: msg.requestId || '',
          cellId: msg.cellId || '',
          result,
          status: getNotebookKernelManager().getStatus(request),
        });
      } catch (e) {
        const activeSession = janeRuntime.getSession();
        const request = {
          language: msg.language || 'python',
          configDir,
          trailId: msg.trailId || activeSession.trailId || '',
        };
        panel.webview.postMessage({
          type: 'executeCellResult',
          requestId: msg.requestId || '',
          cellId: msg.cellId || '',
          error: e.message || String(e),
          status: getNotebookKernelManager().getStatus(request),
        });
      }
      break;
    }
    case 'getKernelStatus': {
      const activeSession = janeRuntime.getSession();
      const request = {
        language: msg.language || 'python',
        configDir,
        trailId: msg.trailId || activeSession.trailId || '',
      };
      panel.webview.postMessage({
        type: 'kernelStatusResult',
        requestId: msg.requestId || '',
        status: getNotebookKernelManager().getStatus(request),
      });
      break;
    }
    case 'kernelControl': {
      const activeSession = janeRuntime.getSession();
      const request = {
        language: msg.language || 'python',
        configDir,
        trailId: msg.trailId || activeSession.trailId || '',
      };
      try {
        let result;
        const manager = getNotebookKernelManager();
        if (msg.action === 'interrupt') {
          result = await manager.interrupt(request);
        } else if (msg.action === 'restart') {
          result = await manager.restart(request);
        } else {
          throw new Error(`Unsupported kernel action: ${msg.action || ''}`);
        }
        panel.webview.postMessage({
          type: 'kernelControlResult',
          requestId: msg.requestId || '',
          action: msg.action || '',
          ...result,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: 'kernelControlResult',
          requestId: msg.requestId || '',
          action: msg.action || '',
          ok: false,
          message: e.message || String(e),
          status: getNotebookKernelManager().getStatus(request),
        });
      }
      break;
    }
  }
}

module.exports = { handleKernelOp };
