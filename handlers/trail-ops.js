const fs = require('fs');
const path = require('path');
const {
  acknowledgeExternalDrafts,
  setPanelState,
} = require('../lib/session-store');
const { loadAllTools } = require('../lib/selva-runtime');

async function handleTrailOp(msg, ctx) {
  const {
    configDir,
    panel,
    folderName,
    janeRuntime,
    context,
    apiKeys,
    findYamlFiles,
    sendModelList,
    updatePanelTitle,
    listCodingAgents,
    suppressLocalSessionSync,
    pickDefaultCodingAgentId,
  } = ctx;

  switch (msg.type) {
    case 'init': {
      setPanelState(configDir, { open: true });
      const files = findYamlFiles(configDir, configDir);
      const userDefaultSettings = context.globalState.get('userDefaultSettings', null);
      const pinnedKey = 'pinnedFields:' + configDir;
      const pinnedFields = context.workspaceState.get(pinnedKey, {});
      const defaultPromptTemplate = fs.readFileSync(
        path.join(context.extensionPath, 'ecosystem', 'prompts', 'system.md'), 'utf8'
      );
      const maskedKeys = {
        anthropic: apiKeys.anthropic ? '••••' + apiKeys.anthropic.slice(-4) : '',
        openai: apiKeys.openai ? '••••' + apiKeys.openai.slice(-4) : '',
      };
      let janeSession = janeRuntime.getSession();
      const legacyAdditionalInstructions = context.globalState.get('additionalInstructions', '');
      if (!janeSession.additionalInstructions && legacyAdditionalInstructions) {
        janeSession = janeRuntime.setSessionInstructions(legacyAdditionalInstructions);
      }
      const codingAgents = await listCodingAgents();
      const trailState = janeRuntime.listTrails();
      updatePanelTitle(panel, folderName, trailState.activeTrail && trailState.activeTrail.name);
      panel.webview.postMessage({
        type: 'init',
        files,
        configDir,
        userDefaultSettings,
        pinnedFields,
        defaultPromptTemplate,
        apiKeys: maskedKeys,
        additionalInstructions: janeSession.additionalInstructions,
        session: janeSession,
        trails: trailState.trails,
        activeTrail: trailState.activeTrail,
        codingAgents,
        defaultCodingAgentId: pickDefaultCodingAgentId(codingAgents),
      });
      sendModelList(panel);
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
      suppressLocalSessionSync(configDir);
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
  }
}

module.exports = { handleTrailOp };
