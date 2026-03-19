// ── Input handlers ─────────────────────────────────────────
function onInput(fid, rawValue) {
  const { path, type, file } = state.fieldMap[fid];
  let value;
  const isNum = type === 'int' || type === 'float';
  if (isNum) {
    if (rawValue === '' || rawValue === '-' || rawValue === '.') value = rawValue;
    else { const n = Number(rawValue); value = isNaN(n) ? rawValue : n; }
  } else { value = rawValue; }
  setNestedValue(state.configs[file].current, path, value);
  if (isNum) syncSlider(fid, typeof value === 'number' ? value : NaN);
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function onToggle(fid, checked) {
  const { path, file } = state.fieldMap[fid];
  setNestedValue(state.configs[file].current, path, checked);
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function convertNull(fid) {
  const { path, file } = state.fieldMap[fid];
  setNestedValue(state.configs[file].current, path, '');
  state.fieldMap[fid].type = 'str';
  renderEditor();
  updateButtons();
  renderTabs();
}

function onArrayItemInput(fid, index, value) {
  const { path, file } = state.fieldMap[fid];
  const arr = getNestedValue(state.configs[file].current, path);
  arr[index] = value;
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function removeArrayItem(fid, index) {
  const { path, file } = state.fieldMap[fid];
  getNestedValue(state.configs[file].current, path).splice(index, 1);
  renderEditor(); updateButtons(); renderTabs();
}

function addArrayItem(fid) {
  const { path, file } = state.fieldMap[fid];
  getNestedValue(state.configs[file].current, path).push('');
  renderEditor(); updateButtons(); renderTabs();
}

function resetField(fid) {
  const { path, file } = state.fieldMap[fid];
  const origValue = getNestedValue(state.configs[file].original, path);
  setNestedValue(state.configs[file].current, path, deepClone(origValue));
  renderEditor(); updateButtons(); renderTabs();
}

function refreshFieldState(fid) {
  const { path, file } = state.fieldMap[fid];
  const current = getNestedValue(state.configs[file].current, path);
  const original = getNestedValue(state.configs[file].original, path);
  const mod = !valEqual(current, original);
  const fieldEl = document.querySelector(`.field[data-fid="${fid}"]`);
  if (!fieldEl) return;
  fieldEl.classList.toggle('modified', mod);
  const inp = fieldEl.querySelector('input[data-action="input"]');
  if (inp) inp.classList.toggle('modified', mod);
  const resetBtn = fieldEl.querySelector('.field-reset');
  if (resetBtn) resetBtn.classList.toggle('visible', mod);

  const curType = state.fieldMap[fid].type;
  if ((curType === 'int' || curType === 'float') && inp) {
    const raw = inp.value;
    const parsed = Number(raw);
    if (!isNaN(parsed) && raw.trim() !== '') {
      const newType = (raw.includes('.') || raw.toLowerCase().includes('e')) ? 'float' : 'int';
      if (newType !== curType) {
        state.fieldMap[fid].type = newType;
        const badge = fieldEl.querySelector('.type-badge');
        if (badge) { badge.className = `type-badge type-${newType}`; badge.textContent = newType; }
      }
    }
  }
}

// ── Buttons ────────────────────────────────────────────────
function updateButtons() {
  const activeMod = isModified(state.activeFile);
  const anyMod = state.files.some(f => state.configs[f] && isModified(f));
  const saveBtn = document.getElementById('save-btn');
  const resetBtn = document.getElementById('reset-btn');
  if (saveBtn) saveBtn.disabled = !anyMod;
  if (resetBtn) resetBtn.disabled = !activeMod;
  const indicator = document.querySelector('.btn-save-indicator');
  if (indicator) {
    const n = state.files.filter(f => state.configs[f] && isModified(f)).length;
    indicator.textContent = n > 1 ? `Save all (${n})` : 'Save';
  }
}

function saveFile() {
  const modifiedFiles = state.files.filter(f => state.configs[f] && isModified(f));
  if (!modifiedFiles.length) return;
  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="btn-save-indicator">Saving...</span>';
  for (const filename of modifiedFiles) {
    vscode.postMessage({ type: 'writeConfig', filename, data: state.configs[filename].current });
  }
}

function resetFile() {
  const config = state.configs[state.activeFile];
  if (!config) return;
  config.current = deepClone(config.original);
  renderEditor(); renderTabs(); updateButtons();
  toast('Reset ' + state.activeFile, 'success');
}

function applySessionSnapshot(session) {
  const snap = session || {};
  const dashboard = snap.dashboardState || {};

  state.conversationHistory = Array.isArray(snap.conversationHistory) ? snap.conversationHistory.slice() : [];
  state.sessionEntries = Array.isArray(snap.entries) ? snap.entries.slice() : [];
  state.sessionTokens = snap.sessionTokens || 0;
  state.agentModelId = snap.agentModelId || state.agentModelId;
  state._bootstrapDone = !!(snap.bootstrap && snap.bootstrap.done);
  state._bootstrapRestore = snap.bootstrap || null;
  state._bootstrapRestored = false;

  state.fileTypes = { ...(dashboard.fileTypes || {}) };
  state.lockedFields = new Set(Array.isArray(dashboard.lockedFields) ? dashboard.lockedFields : []);
  state.pinned = deepClone(dashboard.pinnedFields || {});

  const configFiles = state.files.filter((file) => state.fileTypes[file] !== 'data');
  const dataFiles = state.files.filter((file) => state.fileTypes[file] === 'data');

  const requestedConfig = dashboard.activeConfigFile || null;
  const requestedData = dashboard.activeDataFile || null;
  state.activeConfigFile = requestedConfig && configFiles.includes(requestedConfig)
    ? requestedConfig
    : (configFiles[0] || null);
  state.activeDataFile = requestedData && dataFiles.includes(requestedData)
    ? requestedData
    : (dataFiles[0] || null);
  state.activeFile = state.activeConfigFile || state.activeDataFile || state.activeFile || null;

  updateTokenDisplay();
  const prev = vscode.getState() || {};
  vscode.setState({ ...prev, pinned: state.pinned });
}

function rebuildChatLogFromSession() {
  const log = document.getElementById('agent-chat-log');
  if (log) {
    log.innerHTML = '';
    log.classList.add('hidden');
  }
  for (const entry of state.sessionEntries) {
    addChatEntry(
      entry.question || 'session',
      entry.answer || entry.summary || '',
      null,
      !!entry.isError,
      entry.executedCells || null,
      {
        entryId: entry.id || '',
        instant: true,
        skipPersist: true,
        timestamp: entry.timestamp || '',
        cells: Array.isArray(entry.cells) ? entry.cells : null,
      }
    );
  }
}

function renderDashboardFromSession() {
  const dataFiles = state.files.filter((file) => state.fileTypes[file] === 'data');
  document.getElementById('data-panel').classList.toggle('hidden', dataFiles.length === 0);
  renderTabs();
  renderEditors();
  renderPinnedBar();
  updateButtons();
  updateAgentModelLabel();
}

function updateTrailControls() {
  const select = document.getElementById('trail-select');
  const status = document.getElementById('trail-status');
  const nameInput = document.getElementById('trail-name-input');
  if (!select) return;

  const trails = Array.isArray(state.trails) ? state.trails : [];
  select.innerHTML = trails.map((trail) => {
    const suffix = trail.bootstrapDone ? '' : ' • needs bootstrap';
    return `<option value="${escapeHtml(trail.id)}">${escapeHtml((trail.name || 'Trail') + suffix)}</option>`;
  }).join('');
  select.disabled = trails.length === 0;
  if (state.activeTrailId) select.value = state.activeTrailId;
  if (nameInput && trails.length === 0) nameInput.value = '';

  if (status) {
    if (!trails.length) {
      status.textContent = 'Trails are persisted notebook lineages for this workspace.';
      return;
    }
    const active = trails.find((trail) => trail.id === state.activeTrailId) || trails[0];
    const updatedAt = active && active.updatedAt ? new Date(active.updatedAt).toLocaleString() : '';
    const detail = active && active.bootstrapDone ? 'bootstrapped' : 'needs bootstrap';
    status.textContent = `${active.name || 'Trail'} · ${detail}${updatedAt ? ` · updated ${updatedAt}` : ''}`;
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = active && active.name ? active.name : '';
    }
  }
}

function applyTrailStatePayload(trails, activeTrail) {
  state.trails = Array.isArray(trails) ? trails.slice() : [];
  state.activeTrailId = activeTrail && activeTrail.id ? activeTrail.id : '';
  state.activeTrailName = activeTrail && activeTrail.name ? activeTrail.name : '';
  state.activeTrailPath = activeTrail && activeTrail.path ? activeTrail.path : '';
  updateTrailControls();
}

function resetLoadedConfigDrafts() {
  for (const config of Object.values(state.configs)) {
    if (!config) continue;
    config.current = deepClone(config.original);
  }
}

function finalizeHydratedSession() {
  if (state._bootstrapRestore && !state._bootstrapRestored) {
    const ops = state._bootstrapRestore.ops || [];
    if (ops.length > 0) executeOps(ops);
    state._bootstrapRestored = true;
    const configFiles = state.files.filter(f => state.fileTypes[f] !== 'data');
    const dataFiles = state.files.filter(f => state.fileTypes[f] === 'data');
    if (!state.activeConfigFile || state.fileTypes[state.activeConfigFile] === 'data') {
      state.activeConfigFile = configFiles[0] || null;
    }
    if (!state.activeDataFile && dataFiles.length > 0) {
      state.activeDataFile = dataFiles[0];
    }
    state.activeFile = state.activeConfigFile || state.activeDataFile || state.activeFile;
    document.getElementById('data-panel').classList.toggle('hidden', dataFiles.length === 0);
    renderTabs();
    renderEditors();
    renderPinnedBar();
    updateButtons();
  } else {
    _triggerBootstrap();
  }
}

function hydrateTrailSession(session, options = {}) {
  if (options.resetLoadedConfigs) resetLoadedConfigDrafts();
  state._pendingExternalDrafts = new Map();
  state._appliedExternalDraftIds = new Set();
  state._agentPending = null;
  applySessionSnapshot(session || {});
  queueExternalDrafts((session || {}).pendingExternalDrafts || []);
  rebuildChatLogFromSession();

  if (state.files.length === 0) {
    renderDashboardFromSession();
    return;
  }

  state._bootstrapPending = new Set(state.files.filter((file) => !state.configs[file]));
  for (const file of state._bootstrapPending) {
    vscode.postMessage({ type: 'readConfig', filename: file });
  }
  applyPendingExternalDrafts();
  if (state._bootstrapPending.size === 0) {
    finalizeHydratedSession();
  }
}

function queueExternalDrafts(drafts) {
  for (const draft of (drafts || [])) {
    if (!draft || !draft.id || !Array.isArray(draft.ops) || draft.ops.length === 0) continue;
    const id = String(draft.id);
    if (state._appliedExternalDraftIds.has(id) || state._pendingExternalDrafts.has(id)) continue;
    state._pendingExternalDrafts.set(id, {
      id,
      note: draft.note || '',
      ops: draft.ops,
    });
  }
}

function draftFilesLoaded(draft) {
  return (draft.ops || []).every((op) => {
    const file = op && op.input ? op.input.file : null;
    return !file || !!state.configs[file];
  });
}

function draftOpsRegistered(draft) {
  return (draft.ops || []).every((op) => !!agentOps[op.fn]);
}

function applyPendingExternalDrafts() {
  const readyDrafts = [...state._pendingExternalDrafts.values()].filter(
    (draft) => draftFilesLoaded(draft) && draftOpsRegistered(draft)
  );
  if (readyDrafts.length === 0) return;

  const appliedIds = [];
  let stagedValueOps = 0;
  for (const draft of readyDrafts) {
    executeOps(draft.ops || []);
    state._pendingExternalDrafts.delete(draft.id);
    state._appliedExternalDraftIds.add(draft.id);
    appliedIds.push(draft.id);
    stagedValueOps += (draft.ops || []).filter((op) => op.fn === 'setValue').length;
  }

  renderTabs();
  renderEditors();
  renderPinnedBar();
  updateButtons();
  updateAgentModelLabel();

  const hasData = state.files.some((file) => state.fileTypes[file] === 'data');
  document.getElementById('data-panel').classList.toggle('hidden', !hasData);

  if (appliedIds.length > 0) {
    vscode.postMessage({ type: 'ackExternalDrafts', ids: appliedIds });
  }
  if (stagedValueOps > 0) {
    const noun = stagedValueOps === 1 ? 'change' : 'changes';
    toast(`Staged ${stagedValueOps} external ${noun}. Use Save to commit.`, 'success');
  }
}

function handleBootstrapResultMessage(msg) {
  state._bootstrapDone = true;
  setAgentBusy(false);
  const ops = msg.ops || [];
  if (ops.length > 0) {
    executeOps(ops);
  }

  const configFiles = state.files.filter(f => state.fileTypes[f] !== 'data');
  const dataFiles = state.files.filter(f => state.fileTypes[f] === 'data');

  if (state.activeConfigFile && state.fileTypes[state.activeConfigFile] === 'data') {
    state.activeDataFile = state.activeConfigFile;
    state.activeConfigFile = null;
  }
  if (!state.activeConfigFile || state.fileTypes[state.activeConfigFile] === 'data') {
    state.activeConfigFile = configFiles[0] || null;
  }
  state.activeFile = state.activeConfigFile || state.activeDataFile;
  if (!state.activeDataFile && dataFiles.length > 0) {
    state.activeDataFile = dataFiles[0];
  }

  document.getElementById('data-panel').classList.toggle('hidden', dataFiles.length === 0);
  renderTabs();
  renderEditors();
  renderPinnedBar();
  updateButtons();

  state.conversationHistory.push(
    { role: 'user', content: '[Bootstrap: initialize session, classify files, pin key fields]' },
    { role: 'assistant', content: msg.answer || 'Session initialized.' }
  );

  if (msg.answer) {
    state._lastQuestion = 'bootstrap';
    addChatEntry('session initialized', msg.answer, null, false);
  }
}

function handleAgentResultMessage(msg) {
  setAgentBusy(false);
  const question = state._lastQuestion || '\u2026';
  console.log('[Selva] agentResult:', { answer: (msg.answer || '').slice(0, 200), opsCount: (msg.ops || []).length, summary: msg.summary });

  if (msg.error) {
    toast('Agent: ' + msg.error, 'error');
    addChatEntry(question, 'Error: ' + msg.error, null, true);
    return;
  }

  state.conversationHistory.push({ role: 'user', content: question });
  const agentResponse = msg.answer || msg.summary || '';
  state.conversationHistory.push({ role: 'assistant', content: agentResponse });

  let answer = msg.answer || '';
  const entryCells = (settings.notebookMode && Array.isArray(msg.entry && msg.entry.cells) && msg.entry.cells.length > 0)
    ? msg.entry.cells
    : null;
  const executedCells = (!entryCells && settings.notebookMode && msg.executedCells && msg.executedCells.length > 0)
    ? msg.executedCells
    : null;
  if (executedCells) {
    answer = answer
      .split(/\r?\n/)
      .filter((line) => !/^IMG:[A-Za-z0-9+/=]+$/.test(line))
      .join('\n')
      .trim();
  }

  if ((answer || entryCells || executedCells) && (!msg.ops || msg.ops.length === 0)) {
    addChatEntry(question, answer, null, false, executedCells, entryCells ? { cells: entryCells } : undefined);
    return;
  }
  const ops = msg.ops || [];
  if (ops.length === 0) {
    addChatEntry(question, msg.summary || 'No changes needed.', [], false);
    toast('Agent made no changes', 'info');
    return;
  }

  const { results, diffs, affectedFiles } = executeOps(ops);
  const failedOps = results.filter(r => typeof r === 'string' && r.startsWith('unknown op:'));
  if (failedOps.length > 0) {
    console.warn('[Selva] Failed ops:', failedOps, 'Registered tools:', Object.keys(agentOps));
  }
  const answerText = answer || '';
  const summaryText = failedOps.length > 0
    ? `${failedOps.length} op(s) failed: tools not registered. Try reloading the dashboard.`
    : (msg.summary || `Executed ${ops.length} operation${ops.length > 1 ? 's' : ''}.`);

  if (diffs.length > 0 || affectedFiles.size > 0) {
    toast(`Agent: ${ops.length} op${ops.length > 1 ? 's' : ''} across ${affectedFiles.size} file${affectedFiles.size > 1 ? 's' : ''}`, 'success');
  }

  const displayText = answerText ? answerText + '\n' + summaryText : summaryText;
  addChatEntry(
    question,
    displayText,
    diffs.length > 0 ? diffs : [],
    false,
    executedCells,
    entryCells ? { cells: entryCells } : undefined
  );

  renderTabs();
  renderEditors();
  renderPinnedBar();
  updateButtons();

  const hasData = state.files.some(f => state.fileTypes[f] === 'data');
  document.getElementById('data-panel').classList.toggle('hidden', !hasData);
}

// ── Message handler from extension host ────────────────────
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      state.files = msg.files;
      if (msg.defaultPromptTemplate) {
        state.defaultPromptTemplate = msg.defaultPromptTemplate;
      }
      if (msg.userDefaultSettings) {
        const prev = vscode.getState();
        if (!prev || !prev.settings) {
          settings = { ...defaultSettings, ...msg.userDefaultSettings };
          applySettings();
          saveSettings();
          syncSettingsUI();
        }
      }
      if (msg.pinnedFields && Object.keys(msg.pinnedFields).length > 0) {
        state.pinned = msg.pinnedFields;
        const prev = vscode.getState() || {};
        vscode.setState({ ...prev, pinned: state.pinned });
      }
      // Show masked API keys in settings
      if (msg.apiKeys) {
        if (msg.apiKeys.anthropic) document.getElementById('set-anthropic-key').placeholder = msg.apiKeys.anthropic;
        if (msg.apiKeys.openai) document.getElementById('set-openai-key').placeholder = msg.apiKeys.openai;
      }
      // Restore additional instructions
      if (msg.additionalInstructions) {
        const editor = document.getElementById('sysprompt-editor');
        if (editor) editor.value = msg.additionalInstructions;
        updateSyspromptSparks();
      }
      const session = msg.session || {};
      applyTrailStatePayload(msg.trails || [], msg.activeTrail || null);
      state.availableCodingAgents = Array.isArray(msg.codingAgents) ? msg.codingAgents.slice() : [];
      updateCodingAgentControls(msg.defaultCodingAgentId || '');
      hydrateTrailSession(session);
      if ((!session.dashboardState || !session.dashboardState.pinnedFields || Object.keys(session.dashboardState.pinnedFields).length === 0)
          && msg.pinnedFields && Object.keys(msg.pinnedFields).length > 0) {
        state.pinned = msg.pinnedFields;
        renderPinnedBar();
      }
      break;
    }
    case 'configData': {
      if (msg.error) {
        state._bgLoads.delete(msg.filename);
        if (state._bootstrapPending) state._bootstrapPending.delete(msg.filename);
        toast('Error loading: ' + msg.error, 'error');
        return;
      }
      state.configs[msg.filename] = {
        original: deepClone(msg.parsed),
        current: deepClone(msg.parsed),
        raw: msg.raw || '',
      };
      if (state.fileTypes[msg.filename] === 'data') {
        lockAllFieldsInFile(msg.filename);
      }
      applyPendingExternalDrafts();
      // Check if this completes the bootstrap loading phase
      if (state._bootstrapPending && state._bootstrapPending.has(msg.filename)) {
        state._bootstrapPending.delete(msg.filename);
        // Render the first file as active while waiting
        if (!state._bootstrapDone) {
          if (msg.filename === state.activeConfigFile || !state.activeFile) {
            state.activeFile = msg.filename;
            renderTabs();
            renderEditors();
            updateButtons();
            updateAgentModelLabel();
          }
        }
        if (state._bootstrapPending.size === 0) {
          finalizeHydratedSession();
        }
      } else if (state._bgLoads.has(msg.filename)) {
        state._bgLoads.delete(msg.filename);
        renderPinnedBar();
      } else if (state._agentPending && state._agentPending.awaiting.has(msg.filename)) {
        state._agentPending.awaiting.delete(msg.filename);
        updateAgentModelLabel();
        if (state._agentPending.awaiting.size === 0) {
          const prompt = state._agentPending.prompt;
          state._agentPending = null;
          _executeAgentPrompt(prompt);
        }
      } else {
        state.activeFile = msg.filename;
        const isData = state.fileTypes[msg.filename] === 'data';
        if (isData) {
          state.activeDataFile = msg.filename;
        } else {
          state.activeConfigFile = msg.filename;
        }
        renderTabs();
        renderEditors();
        updateButtons();
        updateAgentModelLabel();
      }
      break;
    }
    case 'writeResult': {
      const saveBtn = document.getElementById('save-btn');
      if (msg.success) {
        const config = state.configs[msg.filename];
        if (config) config.original = deepClone(config.current);
        renderEditor(); renderTabs();
        toast('Saved ' + msg.filename, 'success');
      } else {
        toast('Error: ' + (msg.error || 'Unknown'), 'error');
      }
      saveBtn.innerHTML = '<span class="btn-save-indicator">Save</span>';
      updateButtons();
      break;
    }
    case 'exportJsonResult': {
      if (msg.success) toast('Exported ' + msg.jsonFilename, 'success');
      else toast('Export failed: ' + (msg.error || 'Unknown'), 'error');
      break;
    }
    case 'bootstrapResult': {
      handleBootstrapResultMessage(msg);
      break;
    }
    case 'registerTools': {
      // Bulk register webview-context tools from ecosystem
      for (const tool of (msg.tools || [])) {
        registerTool(tool.name, tool.code);
      }
      applyPendingExternalDrafts();
      break;
    }
    case 'registerTool': {
      // Single tool registration (from propose_tool mid-session)
      if (msg.name && msg.code) {
        registerTool(msg.name, msg.code);
      }
      applyPendingExternalDrafts();
      break;
    }
    case 'tokenUsage': {
      state.sessionTokens += (msg.input || 0) + (msg.output || 0);
      updateTokenDisplay();
      break;
    }
    case 'availableModels': {
      state.availableModels = (msg.models || []).filter(m =>
        !/^copilotcli/i.test(m.vendor) && !/^copilotcli/i.test(m.id)
      );
      if (!state.agentModelId || !state.availableModels.find(m => m.id === state.agentModelId)) {
        // Prefer gpt-4.1 as default, then gpt-4o, fallback to first available
        const preferred = state.availableModels.find(m => /gpt-4\.1/i.test(m.family) || /gpt-4\.1/i.test(m.id))
          || state.availableModels.find(m => /gpt-4o/i.test(m.family) || /gpt-4o/i.test(m.id));
        state.agentModelId = preferred ? preferred.id : (state.availableModels.length > 0 ? state.availableModels[0].id : '');
      }
      updateAgentModelLabel();
      break;
    }
    case 'codingAgentConnected': {
      const label = msg.agent && msg.agent.label ? msg.agent.label : 'Coding agent';
      if (msg.launchMode === 'terminal') {
        toast(`${label} terminal opened with the Selva startup prompt.`, 'success');
      } else if (msg.launchMode === 'seeded') {
        toast(`${label} opened with a Selva startup prompt.`, 'success');
      } else {
        toast(`${label} opened. Selva startup prompt copied to clipboard.`, 'success');
      }
      break;
    }
    case 'codingAgentConnectionError': {
      toast('Connect failed: ' + (msg.error || 'Unknown error'), 'error');
      break;
    }
    case 'agentResult': {
      handleAgentResultMessage(msg);
      break;
    }
    case 'janeSessionResult': {
      if (msg.mode === 'bootstrap') handleBootstrapResultMessage(msg);
      else handleAgentResultMessage(msg);
      break;
    }
    case 'janeSessionSync': {
      const trailState = msg.trailState || {};
      const nextTrailId = trailState.activeTrail && trailState.activeTrail.id ? trailState.activeTrail.id : '';
      const trailChanged = !!(nextTrailId && nextTrailId !== state.activeTrailId);
      applyTrailStatePayload(trailState.trails || [], trailState.activeTrail || null);
      if (trailChanged) {
        hydrateTrailSession(msg.session || {}, { resetLoadedConfigs: true });
        requestNotebookKernelStatus();
        break;
      }
      applySessionSnapshot(msg.session || {});
      queueExternalDrafts((msg.session || {}).pendingExternalDrafts || []);
      rebuildChatLogFromSession();
      renderDashboardFromSession();
      applyPendingExternalDrafts();
      requestNotebookKernelStatus();
      break;
    }
    case 'trailState': {
      applyTrailStatePayload(msg.trails || [], msg.activeTrail || null);
      hydrateTrailSession(msg.session || {}, { resetLoadedConfigs: true });
      const verb = msg.action === 'new'
        ? 'Started'
        : (msg.action === 'fork'
          ? 'Forked to'
          : (msg.action === 'rename' ? 'Renamed to' : 'Switched to'));
      toast(`${verb} ${state.activeTrailName || 'Trail'}`, 'success');
      requestNotebookKernelStatus();
      break;
    }
    case 'kernelStatusResult': {
      setNotebookKernelStatus(msg.status || {});
      break;
    }
    case 'kernelControlResult': {
      setNotebookKernelStatus(msg.status || {});
      if (!msg.ok) {
        toast(msg.message || 'Kernel action failed', 'error');
        break;
      }
      if (msg.action === 'interrupt') {
        toast(msg.interrupted ? 'Kernel interrupt sent' : (msg.message || 'Kernel is idle'), msg.interrupted ? 'success' : 'info');
      } else if (msg.action === 'restart') {
        toast('Kernel restarted', 'success');
      } else {
        toast(msg.message || 'Kernel updated', 'success');
      }
      break;
    }
  }
});

// ── Event delegation: editors ──────────────────────────────
function onEditorClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const { action, fid, index } = target.dataset;
  switch (action) {
    case 'toggle-section':       toggleSection(target.closest('.section')); break;
    case 'toggle-section-deep':  toggleSectionDeep(target.closest('.section')); break;
    case 'convert-null':     convertNull(fid); break;
    case 'remove-item':      removeArrayItem(fid, Number(index)); break;
    case 'add-item':         addArrayItem(fid); break;
    case 'reset-field':      resetField(fid); break;
    case 'lock-field': {
      const key = lockFieldKey(fid);
      if (key) {
        if (state.lockedFields.has(key)) {
          state.lockedFields.delete(key);
        } else {
          state.lockedFields.add(key);
        }
        renderEditors();
        updateButtons();
      }
      break;
    }
    case 'pin-field': {
      const entry = state.fieldMap[fid];
      if (entry) {
        if (isPinnedPath(entry.path, entry.file)) unpinField(entry.path);
        else pinField(entry.path, entry.file);
      }
      break;
    }
    case 'export-json-file': {
      const filename = target.dataset.filename;
      const cfg = state.configs[filename];
      if (cfg) vscode.postMessage({ type: 'exportJson', filename, data: cfg.current });
      break;
    }
  }
}
function onEditorChange(e) {
  const t = e.target;
  if (t.dataset.action === 'toggle') onToggle(t.dataset.fid, t.checked);
  else if (t.dataset.action === 'toggle-log-cb') toggleLogScale(t);
  else if (t.dataset.action === 'toggle-log2-cb') toggleLog2Scale(t);
}
function onEditorInput(e) {
  const t = e.target;
  if (t.dataset.action === 'input') onInput(t.dataset.fid, t.value);
  else if (t.dataset.action === 'array-input') onArrayItemInput(t.dataset.fid, Number(t.dataset.index), t.value);
  else if (t.dataset.action === 'num-slider') onSliderInput(t);
}

['config-editor', 'data-editor'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', onEditorClick);
  el.addEventListener('change', onEditorChange);
  el.addEventListener('input', onEditorInput);
});

// ── Event delegation: file tabs ────────────────────────────
document.getElementById('file-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-filename]');
  if (!tab) return;
  const panel = tab.closest('.dash-panel');
  const filename = tab.dataset.filename;
  const isActive = filename === state.activeConfigFile;
  if (panel && panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    selectFile(filename);
    return;
  }
  if (panel && isActive) {
    panel.classList.add('collapsed');
    return;
  }
  selectFile(filename);
});
document.getElementById('data-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-filename]');
  if (!tab) return;
  const panel = tab.closest('.dash-panel');
  const filename = tab.dataset.filename;
  const isActive = filename === state.activeDataFile;
  if (panel && panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    selectFile(filename);
    return;
  }
  if (panel && isActive) {
    panel.classList.add('collapsed');
    return;
  }
  selectFile(filename);
});

// ── Event delegation: theme swatches ──────────────────────
document.getElementById('theme-swatches').addEventListener('click', e => {
  const swatch = e.target.closest('[data-theme]');
  if (swatch) selectTheme(swatch.dataset.theme);
});

// ── Static element listeners ───────────────────────────────
const resetBtnEl = document.getElementById('reset-btn');
if (resetBtnEl) resetBtnEl.addEventListener('click', resetFile);
const saveBtnEl = document.getElementById('save-btn');
if (saveBtnEl) saveBtnEl.addEventListener('click', saveFile);

// ── Panel collapse/expand ───────────────────────────────────
document.querySelectorAll('.dash-panel-header[data-action="toggle-panel"]').forEach(header => {
  header.addEventListener('click', e => {
    if (e.target.closest('.pin-clear-btn')) return;
    if (e.target.closest('nav')) return;
    if (e.target.closest('.tab')) return;
    if (e.target.closest('.notebook-header-toolbar')) return;
    const panel = header.closest('.dash-panel');
    panel.classList.toggle('collapsed');
  });
});

// ── Pin clear-all ──────────────────────────────────────────
document.getElementById('pin-clear-all').addEventListener('click', () => {
  state.pinned = {};
  savePinned();
  renderPinnedBar();
  refreshPinButtons();
});

// ── Pinned bar event handlers ───────────────────────────────
document.getElementById('pinned-bar').addEventListener('input', e => {
  const t = e.target;
  const file = t.dataset.pf;
  const pa = t.dataset.pa;
  if (pa !== 'input' && pa !== 'pin-slider') return;
  const path = JSON.parse(t.dataset.pp);
  if (!state.configs[file]) return;

  let val;
  if (pa === 'pin-slider') {
    const mode = t.dataset.mode;
    const sv = parseFloat(t.value);
    val = (mode === 'int') ? Math.round(sv) : parseFloat(sv.toPrecision(6));
    const textInp = t.closest('.pin-row').querySelector('.pin-val-input');
    if (textInp) textInp.value = String(val);
  } else {
    const cur = getNestedValue(state.configs[file].current, path);
    const raw = t.value;
    val = typeof cur === 'number' ? (isNaN(Number(raw)) ? raw : Number(raw)) : raw;
    const pinSlider = t.closest('.pin-row').querySelector('.num-slider[data-pa="pin-slider"]');
    if (pinSlider && typeof val === 'number') {
      const mode = pinSlider.dataset.mode;
      const min = parseFloat(pinSlider.min), max = parseFloat(pinSlider.max), step = parseFloat(pinSlider.step);
      pinSlider.value = Math.max(min, Math.min(max, mode === 'int' ? Math.round(val / step) * step : val));
    }
  }

  setNestedValue(state.configs[file].current, path, val);
  const mod = !valEqual(val, getNestedValue(state.configs[file].original, path));
  t.classList.toggle('pin-modified', mod);
  t.closest('.pin-row').classList.toggle('pin-modified', mod);
  if (file === state.activeConfigFile || file === state.activeDataFile) {
    const fid = state.pathToFid[file + ':' + pathKey(path)];
    if (fid) {
      const inp = document.getElementById(fid);
      if (inp) inp.value = String(val);
      syncSlider(fid, typeof val === 'number' ? val : NaN);
      refreshFieldState(fid);
    }
    updateButtons(); renderTabs();
  }
});

document.getElementById('pinned-bar').addEventListener('change', e => {
  const t = e.target;
  const pa = t.dataset.pa;
  if (pa === 'toggle') {
    const file = t.dataset.pf;
    const path = JSON.parse(t.dataset.pp);
    if (!state.configs[file]) return;
    setNestedValue(state.configs[file].current, path, t.checked);
    if (file === state.activeConfigFile || file === state.activeDataFile) {
      const fid = state.pathToFid[file + ':' + pathKey(path)];
      if (fid) refreshFieldState(fid);
      updateButtons(); renderTabs();
    }
  } else if (pa === 'pin-log-cb') {
    const pinRow = t.closest('.pin-row');
    const sliderCol = pinRow.querySelector('.pin-slider-col');
    const slider = sliderCol.querySelector('.num-slider');
    const origVal = parseFloat(slider.dataset.orig);
    const textInput = pinRow.querySelector('.pin-val-input');
    const curVal = textInput ? parseFloat(textInput.value) : origVal;
    if (t.checked) {
      slider.dataset.mode = 'log';
      const logMin = Math.log(origVal / 10), logMax = Math.log(origVal * 10);
      slider.min = logMin; slider.max = logMax; slider.step = (logMax - logMin) / 100;
      slider.value = curVal > 0 ? Math.log(curVal) : logMin;
      replaceRuler(sliderCol, buildLogTickRuler(logMin, logMax));
    } else {
      slider.dataset.mode = 'linear';
      const span = Math.abs(origVal) || 1;
      const linMin = origVal - span, linMax = origVal + span;
      slider.min = linMin; slider.max = linMax; slider.step = (2 * span) / 100;
      slider.value = Math.max(linMin, Math.min(linMax, curVal));
      replaceRuler(sliderCol, buildTickRuler(linMin, linMax, 'float'));
    }
  } else if (pa === 'pin-log2-cb') {
    const pinRow = t.closest('.pin-row');
    const sliderCol = pinRow.querySelector('.pin-slider-col');
    const slider = sliderCol.querySelector('.num-slider');
    const origVal = parseInt(slider.dataset.orig);
    const textInput = pinRow.querySelector('.pin-val-input');
    const curVal = textInput ? Number(textInput.value) : origVal;
    if (t.checked) {
      const refN = curVal > 0 ? Math.round(Math.log2(curVal)) : origVal > 0 ? Math.round(Math.log2(origVal)) : 3;
      const minN = Math.max(0, refN - 5), maxN = refN + 5;
      const curN = curVal > 0 ? Math.max(minN, Math.min(maxN, Math.round(Math.log2(curVal)))) : minN;
      slider.dataset.mode = 'pow2';
      slider.min = minN; slider.max = maxN; slider.step = 1; slider.value = curN;
      replaceRuler(sliderCol, buildTickRuler(minN, maxN, 'pow2'));
    } else {
      slider.dataset.mode = 'int';
      const span = Math.abs(origVal) || 10;
      const min = origVal >= 0 ? 0 : origVal - span, max = origVal + span;
      const intTicks = buildIntTickRuler(min, max);
      slider.min = min; slider.max = max; slider.step = intTicks.step;
      slider.value = Math.max(min, Math.min(max, Math.round(curVal / intTicks.step) * intTicks.step));
      replaceRuler(sliderCol, intTicks.html);
    }
  }
});

document.getElementById('pinned-bar').addEventListener('click', e => {
  const btn = e.target.closest('[data-pa="unpin"]');
  if (!btn) return;
  const file = btn.dataset.pf;
  const path = JSON.parse(btn.dataset.pp);
  if (!state.pinned[file]) return;
  const k = pathKey(path);
  state.pinned[file] = state.pinned[file].filter(p => pathKey(p) !== k);
  savePinned();
  renderPinnedBar();
  refreshPinButtons();
});

// ── Settings listeners ─────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', toggleSettings);
document.getElementById('settings-overlay').addEventListener('click', toggleSettings);
document.querySelector('.sp-close').addEventListener('click', toggleSettings);

document.getElementById('set-label-font').addEventListener('change', onSettingChange);
document.getElementById('set-field-font').addEventListener('change', onSettingChange);
document.getElementById('set-value-font').addEventListener('change', onSettingChange);
document.getElementById('set-font-size').addEventListener('input', onSettingChange);
document.getElementById('set-bg0-color').addEventListener('input', onSettingChange);
document.getElementById('set-bg1-color').addEventListener('input', onSettingChange);
document.getElementById('set-label-color').addEventListener('input', onSettingChange);
document.getElementById('set-field-color').addEventListener('input', onSettingChange);
document.getElementById('set-accent-color').addEventListener('input', onSettingChange);
document.getElementById('set-density').addEventListener('change', onSettingChange);
document.getElementById('set-badges').addEventListener('change', onSettingChange);
document.getElementById('set-counts').addEventListener('change', onSettingChange);
document.getElementById('set-autoexpand').addEventListener('change', onSettingChange);
document.getElementById('set-sortkeys').addEventListener('change', onSettingChange);
document.getElementById('set-sliders').addEventListener('change', onSettingChange);
document.getElementById('set-notebook').addEventListener('change', onSettingChange);

// ── API key listeners (sent to extension for secure storage) ──
document.getElementById('set-anthropic-key').addEventListener('change', e => {
  vscode.postMessage({ type: 'setApiKey', provider: 'anthropic', key: e.target.value.trim() });
  // Refresh model list to include direct models
  vscode.postMessage({ type: 'listModels' });
});
document.getElementById('set-openai-key').addEventListener('change', e => {
  vscode.postMessage({ type: 'setApiKey', provider: 'openai', key: e.target.value.trim() });
  vscode.postMessage({ type: 'listModels' });
});

document.getElementById('save-defaults-btn').addEventListener('click', saveAsUserDefault);
document.getElementById('reset-defaults-btn').addEventListener('click', resetToFactoryDefault);

document.getElementById('search').addEventListener('input', applySearch);

// ── Agent CLI bar listeners ─────────────────────────────────
const agentRunBtn = document.getElementById('agent-run-btn');
if (agentRunBtn) agentRunBtn.addEventListener('click', runAgentPrompt);
const agentInputEl = document.getElementById('agent-input');
if (agentInputEl) {
  agentInputEl.addEventListener('click', () => {
    agentInputEl.classList.remove('agent-thinking');
  });
  agentInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAgentPrompt(); }
  });
}
const agentModelBtn = document.getElementById('agent-model-btn');
if (agentModelBtn) agentModelBtn.addEventListener('click', showModelPicker);
const codingAgentSelectEl = document.getElementById('coding-agent-select');
if (codingAgentSelectEl) {
  codingAgentSelectEl.addEventListener('change', e => {
    state.selectedCodingAgentId = e.target.value || '';
    updateCodingAgentControls();
  });
}
const connectAgentBtn = document.getElementById('connect-agent-btn');
if (connectAgentBtn) connectAgentBtn.addEventListener('click', connectSelectedCodingAgent);
const trailPanelBtn = document.getElementById('trail-panel-btn');
if (trailPanelBtn) {
  trailPanelBtn.addEventListener('click', () => {
    const panel = document.getElementById('trail-panel');
    const syspromptPanel = document.getElementById('agent-sysprompt-panel');
    const syspromptBtn = document.getElementById('agent-sysprompt-btn');
    if (!panel) return;
    if (syspromptPanel) syspromptPanel.classList.add('hidden');
    if (syspromptBtn) syspromptBtn.classList.remove('active');
    const hidden = panel.classList.toggle('hidden');
    trailPanelBtn.classList.toggle('active', !hidden);
  });
}
const trailSelectEl = document.getElementById('trail-select');
if (trailSelectEl) {
  trailSelectEl.addEventListener('change', e => {
    const trailId = e.target.value || '';
    if (!trailId || trailId === state.activeTrailId) return;
    vscode.postMessage({ type: 'janeTrailSwitch', trailId });
  });
}
function getTrailPanelName(mode) {
  const input = document.getElementById('trail-name-input');
  const raw = input ? input.value.trim() : '';
  if (mode === 'rename') return raw;
  return raw && raw !== String(state.activeTrailName || '').trim() ? raw : '';
}
const trailRenameBtn = document.getElementById('trail-rename-btn');
if (trailRenameBtn) {
  trailRenameBtn.addEventListener('click', () => {
    const name = getTrailPanelName('rename');
    if (!name) {
      toast('Enter a Trail name first', 'error');
      return;
    }
    if (name === String(state.activeTrailName || '').trim()) {
      toast('Trail name is already up to date', 'success');
      return;
    }
    vscode.postMessage({
      type: 'janeTrailRename',
      trailId: state.activeTrailId || '',
      name,
    });
  });
}
const trailNewBtn = document.getElementById('trail-new-btn');
if (trailNewBtn) {
  trailNewBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'janeTrailNew', name: getTrailPanelName('new') });
  });
}
const trailForkBtn = document.getElementById('trail-fork-btn');
if (trailForkBtn) {
  trailForkBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'janeTrailFork',
      name: getTrailPanelName('fork'),
      sourceTrailId: state.activeTrailId || '',
    });
  });
}

// ── System prompt panel toggle ──────────────────────────────
const agentSyspromptBtn = document.getElementById('agent-sysprompt-btn');
if (agentSyspromptBtn) {
  agentSyspromptBtn.addEventListener('click', () => {
    const panel = document.getElementById('agent-sysprompt-panel');
    const trailPanel = document.getElementById('trail-panel');
    const trailBtn = document.getElementById('trail-panel-btn');
    if (!panel) return;
    if (trailPanel) trailPanel.classList.add('hidden');
    if (trailBtn) trailBtn.classList.remove('active');
    const hidden = panel.classList.toggle('hidden');
    agentSyspromptBtn.classList.toggle('active', !hidden);
  });
}
const syspromptResetBtn = document.getElementById('sysprompt-reset');
if (syspromptResetBtn) {
  syspromptResetBtn.addEventListener('click', () => {
    const editor = document.getElementById('sysprompt-editor');
    if (editor) editor.value = '';
    updateSyspromptSparks();
    vscode.postMessage({ type: 'janeSessionSetInstructions', text: '' });
  });
}

function updateSyspromptSparks() {
  const editor = document.getElementById('sysprompt-editor');
  const active = !!(editor && editor.value.trim());
  const button = document.getElementById('agent-sysprompt-btn');
  if (button) button.classList.toggle('has-instructions', active);
}
const syspromptEditor = document.getElementById('sysprompt-editor');
if (syspromptEditor) {
  syspromptEditor.addEventListener('input', () => {
    updateSyspromptSparks();
    vscode.postMessage({ type: 'janeSessionSetInstructions', text: syspromptEditor.value });
  });
}

const notebookAddBtn = document.getElementById('notebook-add-btn');
const notebookAddMenu = document.getElementById('notebook-add-menu');
if (notebookAddBtn && notebookAddMenu) {
  notebookAddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    notebookAddMenu.classList.toggle('hidden');
  });
  notebookAddMenu.addEventListener('click', (e) => {
    const option = e.target.closest('[data-cell-type]');
    if (!option) return;
    addManualNotebookCell(option.dataset.cellType);
    notebookAddMenu.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    const wrap = e.target.closest('.notebook-add-wrap');
    if (!wrap) notebookAddMenu.classList.add('hidden');
  });
}

const kernelRefreshBtn = document.getElementById('notebook-kernel-refresh-btn');
if (kernelRefreshBtn) {
  kernelRefreshBtn.addEventListener('click', () => {
    requestNotebookKernelStatus();
  });
}
const kernelInterruptBtn = document.getElementById('notebook-kernel-interrupt-btn');
if (kernelInterruptBtn) {
  kernelInterruptBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'kernelControl',
      action: 'interrupt',
      trailId: state.activeTrailId || '',
      language: 'python',
    });
  });
}
const kernelRestartBtn = document.getElementById('notebook-kernel-restart-btn');
if (kernelRestartBtn) {
  kernelRestartBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'kernelControl',
      action: 'restart',
      trailId: state.activeTrailId || '',
      language: 'python',
    });
  });
}

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!document.getElementById('save-btn').disabled) saveFile();
  }
  if (e.key === 'Escape') {
    const panel = document.getElementById('settings-panel');
    if (panel.style.display === 'block') toggleSettings();
  }
});

updateNotebookKernelToolbar();
requestNotebookKernelStatus();

// ── Bootstrap trigger ────────────────────────────────────────
function _triggerBootstrap() {
  if (state._bootstrapDone) return;
  setAgentBusy(true);
  vscode.postMessage({
    type: 'janeSessionBootstrap',
    pendingEdits: buildPendingEdits(),
    modelId: state.agentModelId,
  });
}

// ── Init ───────────────────────────────────────────────────
function init() {
  buildThemeSwatches();
  loadSettings();
  updateNotebookComposerVisibility();
  loadPinned();
  document.getElementById('pinned-panel-title').innerHTML = PIN_ICON_SVG + ' pinned';
  document.getElementById('config-panel-title').innerHTML = YAML_ICON_SVG + ' configs';
  document.getElementById('data-panel-title').innerHTML = DATA_ICON_SVG + ' data';
  document.getElementById('pinned-panel').classList.add('hidden');
  vscode.postMessage({ type: 'init' });
}

init();
