const fs = require('fs');
const path = require('path');
const {
  acknowledgeExternalDrafts,
  setPanelState,
} = require('../lib/session-store');
const { loadAllTools } = require('../lib/selva-runtime');
const { exportToIpynb, exportToPython } = require('../lib/notebook-export');
const { exportProjectToHtml } = require('../lib/project-export');

async function handleTrailOp(msg, ctx) {
  const {
    configDir,
    panel,
    folderName,
    janeRuntime,
    context,
    findYamlFiles,
    updatePanelTitle,
    listCodingAgents,
    suppressLocalSessionSync,
    pickDefaultCodingAgentId,
  } = ctx;

  switch (msg.type) {
    case 'init': {
      // Trail-independent data (always available)
      const files = findYamlFiles(configDir, configDir);
      const userDefaultSettings = context.globalState.get('userDefaultSettings', null);
      const pinnedKey = 'pinnedFields:' + configDir;
      const pinnedFields = context.workspaceState.get(pinnedKey, {});
      const projectPromptKey = 'projectPrompt:' + configDir;
      const projectPrompt = context.workspaceState.get(projectPromptKey, '');
      const codingAgents = await listCodingAgents();
      let defaultPromptTemplate = '';
      try {
        defaultPromptTemplate = fs.readFileSync(
          path.join(context.extensionPath, 'ecosystem', 'prompts', 'SYSTEM.md'), 'utf8'
        );
      } catch {}

      // Trail-dependent data (may be empty if no trails exist yet)
      const trailState = janeRuntime.listTrails();
      const hasTrails = trailState.trails.length > 0;
      let janeSession = {};
      if (hasTrails) {
        try { setPanelState(configDir, { open: true }); } catch {}
        janeSession = janeRuntime.getSession();
        const legacyAdditionalInstructions = context.globalState.get('additionalInstructions', '');
        if (!janeSession.additionalInstructions && legacyAdditionalInstructions) {
          janeSession = janeRuntime.setSessionInstructions(legacyAdditionalInstructions);
        }
      }
      updatePanelTitle(panel, folderName, trailState.activeTrail && trailState.activeTrail.name);

      panel.webview.postMessage({
        type: 'init',
        files,
        configDir,
        userDefaultSettings,
        pinnedFields,
        defaultPromptTemplate,
        additionalInstructions: janeSession.additionalInstructions || '',
        bitacora: janeSession.bitacora || '',
        projectPrompt,
        session: janeSession,
        trails: trailState.trails,
        activeTrail: trailState.activeTrail,
        codingAgents,
        defaultCodingAgentId: pickDefaultCodingAgentId(codingAgents),
      });
      const initTools = loadAllTools(context.extensionPath);
      const webviewTools = initTools
        .filter(t => t.context === 'webview')
        .map(t => ({ name: t.name, code: t.code }));
      panel.webview.postMessage({ type: 'registerTools', tools: webviewTools });
      break;
    }
    case 'ackExternalDrafts': {
      acknowledgeExternalDrafts(configDir, msg.ids || []);
      break;
    }
    case 'persistSessionEntries': {
      // Do NOT suppress session sync here — MCP-originated writes
      // (jane_add_cells etc.) must still reach the webview via the
      // file watcher. The webview's own persist is harmless: the
      // subsequent janeSessionSync rebuild is a no-op when entries
      // haven't changed (same content).
      janeRuntime.replaceSessionEntries(msg.entries || []);
      break;
    }
    case 'janeTrailNew': {
      suppressLocalSessionSync(configDir);
      const result = janeRuntime.createTrail({ name: msg.name || '' });
      updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
      panel.webview.postMessage({
        type: 'trailState',
        action: 'new',
        session: janeRuntime.getSession(),
        trails: result.trails,
        activeTrail: result.activeTrail,
      });
      break;
    }
    case 'janeTrailFork': {
      suppressLocalSessionSync(configDir);
      const result = janeRuntime.forkTrail({
        name: msg.name || '',
        sourceTrailId: msg.sourceTrailId || '',
      });
      updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
      panel.webview.postMessage({
        type: 'trailState',
        action: 'fork',
        session: janeRuntime.getSession(),
        trails: result.trails,
        activeTrail: result.activeTrail,
      });
      break;
    }
    case 'janeTrailSwitch': {
      suppressLocalSessionSync(configDir);
      const result = janeRuntime.switchTrail({ trailId: msg.trailId || '' });
      updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
      panel.webview.postMessage({
        type: 'trailState',
        action: 'switch',
        session: janeRuntime.getSession(),
        trails: result.trails,
        activeTrail: result.activeTrail,
      });
      break;
    }
    case 'janeTrailRename': {
      suppressLocalSessionSync(configDir);
      const result = janeRuntime.renameTrail({
        trailId: msg.trailId || '',
        name: msg.name || '',
      });
      updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
      panel.webview.postMessage({
        type: 'trailState',
        action: 'rename',
        session: janeRuntime.getSession(),
        trails: result.trails,
        activeTrail: result.activeTrail,
      });
      break;
    }
    case 'janeTrailDelete': {
      suppressLocalSessionSync(configDir);
      try {
        const result = janeRuntime.deleteTrail({
          trailId: msg.trailId || '',
        });
        updatePanelTitle(panel, folderName, result.activeTrail && result.activeTrail.name);
        panel.webview.postMessage({
          type: 'trailState',
          action: 'delete',
          session: janeRuntime.getSession(),
          trails: result.trails,
          activeTrail: result.activeTrail,
        });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: err.message });
      }
      break;
    }
    case 'exportNotebook': {
      const vscodeApi = ctx.vscode;
      const format = msg.format || 'ipynb';
      const session = janeRuntime.getSession();
      const entries = Array.isArray(session.entries) ? session.entries : [];
      const allCells = [];
      for (const entry of entries) {
        if (Array.isArray(entry.cells)) {
          for (const cell of entry.cells) {
            if (cell) allCells.push(cell);
          }
        }
      }
      const trailState = janeRuntime.listTrails();
      const trailName = (trailState.activeTrail && trailState.activeTrail.name) || 'notebook';
      const safeName = String(trailName).replace(/[^a-zA-Z0-9_\-]/g, '_');
      let content, filename;
      if (format === 'py') {
        content = exportToPython(allCells);
        filename = safeName + '.py';
      } else {
        const nb = exportToIpynb(allCells, {
          selva: { trail: trailName },
        });
        content = JSON.stringify(nb, null, 1);
        filename = safeName + '.ipynb';
      }
      try {
        const defaultUri = vscodeApi.Uri.file(path.join(configDir, filename));
        const filters = format === 'py'
          ? { 'Python': ['py'] }
          : { 'Jupyter Notebook': ['ipynb'] };
        const uri = await vscodeApi.window.showSaveDialog({
          defaultUri,
          filters,
          title: 'Export Notebook',
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, content, 'utf8');
          panel.webview.postMessage({ type: 'exportNotebookResult', ok: true, filename: path.basename(uri.fsPath) });
          vscodeApi.window.showInformationMessage(`Exported to ${path.basename(uri.fsPath)}`);
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'exportNotebookResult', ok: false, error: err.message });
      }
      break;
    }
    case 'exportProject': {
      const vscodeApi = ctx.vscode;
      const projectName = path.basename(configDir);
      const projectPromptKey = 'projectPrompt:' + configDir;
      const projectPrompt = context.workspaceState.get(projectPromptKey, '');
      try {
        const html = exportProjectToHtml(configDir, { projectName, projectPrompt });
        const defaultUri = vscodeApi.Uri.file(path.join(configDir, projectName + '_report.html'));
        const uri = await vscodeApi.window.showSaveDialog({
          defaultUri,
          filters: { 'HTML': ['html'] },
          title: 'Export Research Project',
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, html, 'utf8');
          panel.webview.postMessage({ type: 'exportProjectResult', ok: true, filename: path.basename(uri.fsPath) });
          vscodeApi.window.showInformationMessage(`Project exported to ${path.basename(uri.fsPath)}`);
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'exportProjectResult', ok: false, error: err.message });
      }
      break;
    }
  }
}

module.exports = { handleTrailOp };
