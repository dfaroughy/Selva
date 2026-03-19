// ── Pending edits (delta between original and current) ──────
function buildPendingEdits() {
  const edits = [];
  for (const [file, cfg] of Object.entries(state.configs)) {
    if (!cfg) continue;
    _collectEdits(cfg.original, cfg.current, [], file, edits);
  }
  return edits;
}

function _collectEdits(orig, cur, pathArr, file, edits) {
  if (orig === cur) return;
  if (orig == null || cur == null || typeof orig !== typeof cur) {
    edits.push({ file, path: pathArr, value: cur });
    return;
  }
  if (typeof orig !== 'object') {
    if (orig !== cur) edits.push({ file, path: pathArr, value: cur });
    return;
  }
  if (Array.isArray(orig) && Array.isArray(cur)) {
    if (JSON.stringify(orig) !== JSON.stringify(cur)) {
      edits.push({ file, path: pathArr, value: cur });
    }
    return;
  }
  const keys = new Set([...Object.keys(orig), ...Object.keys(cur)]);
  for (const k of keys) {
    _collectEdits(orig[k], cur[k], [...pathArr, k], file, edits);
  }
}

function buildDashboardState() {
  return {
    fileTypes: { ...state.fileTypes },
    lockedFields: [...state.lockedFields],
    pinnedFields: { ...state.pinned },
    activeConfigFile: state.activeConfigFile,
    activeDataFile: state.activeDataFile,
  };
}

// ── Dynamic tool registry ─────────────────────────────────
// Tools are registered dynamically from ecosystem/tools/ via eval
const agentOps = {};

function registerTool(name, code) {
  try {
    const fn = eval(code);
    if (typeof fn === 'function') {
      agentOps[name] = fn;
    } else {
      console.warn(`[Selva] registerTool "${name}": eval did not return a function, got`, typeof fn);
    }
  } catch (e) {
    console.error(`[Selva] Failed to register tool "${name}":`, e);
  }
}

function executeOps(ops) {
  const results = [];
  const diffs = [];
  const affectedFiles = new Set();

  for (const op of ops) {
    const fn = agentOps[op.fn];
    const input = op.input || {};
    if (!fn) {
      console.warn(`[Selva] unknown op: ${op.fn} — registered tools:`, Object.keys(agentOps));
      results.push(`unknown op: ${op.fn}`);
      continue;
    }

    // Track setValue diffs
    if (op.fn === 'setValue' && input.file && input.path) {
      const config = state.configs[input.file];
      if (config) {
        const p = normalizePath(input.path);
        const oldVal = getNestedValue(config.current, p);
        if (oldVal !== undefined) {
          diffs.push({ file: input.file, path: p, oldVal, newVal: input.value });
          affectedFiles.add(input.file);
        }
      }
    } else {
      affectedFiles.add(input.file || '');
    }

    const result = fn(input);
    results.push(result);
  }
  return { results, diffs, affectedFiles };
}

// ── Agent UI helpers ───────────────────────────────────────
let _agentRunning = false;
let _timerInterval = null;
let _timerStart = 0;
let _pythonCellCounter = 0;

function startTimer() {
  if (_timerInterval) clearInterval(_timerInterval);
  const el = document.getElementById('agent-timer');
  if (!el) return;
  _timerStart = Date.now();
  el.textContent = '0.0s';
  _timerInterval = setInterval(() => {
    const elapsed = (Date.now() - _timerStart) / 1000;
    el.textContent = elapsed < 60
      ? elapsed.toFixed(1) + 's'
      : Math.floor(elapsed / 60) + 'm ' + Math.floor(elapsed % 60) + 's';
  }, 100);
}

function stopTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  // Leave final time displayed until next run
}

function setAgentBusy(busy) {
  _agentRunning = busy;
  const input = document.getElementById('agent-input');
  const btn   = document.getElementById('agent-run-btn');
  if (input) {
    input.disabled = busy;
    if (!busy) {
      // Clear query and restore placeholder when done
      input.value = '';
      input.classList.remove('agent-thinking');
    }
  }
  if (btn) {
    btn.disabled = false; // always clickable (run or abort)
    btn.classList.toggle('agent-running', busy);
    btn.title = busy ? 'Abort' : 'Run';
    const play = btn.querySelector('.agent-icon-play');
    const stop = btn.querySelector('.agent-icon-stop');
    if (play) play.classList.toggle('hidden', busy);
    if (stop) stop.classList.toggle('hidden', !busy);
  }
  if (busy) startTimer(); else stopTimer();
}

function updateTokenDisplay() {
  const el = document.getElementById('agent-token-count');
  if (!el) return;
  const t = state.sessionTokens;
  if (t <= 0) { el.textContent = ''; return; }
  let label;
  if (t >= 1000000) label = (t / 1000000).toFixed(1) + 'M';
  else if (t >= 1000) label = (t / 1000).toFixed(1) + 'K';
  else label = String(t);
  el.textContent = label + ' tokens';
  // Warning at 1M
  if (t >= 1000000 && !state._tokenWarningShown) {
    state._tokenWarningShown = true;
    toast('Session has used over 1M tokens — costs may be significant', 'error');
  }
  // Red when over 1M
  el.classList.toggle('token-warning', t >= 1000000);
}

// Provider logos (official SVGs, scaled to 16px, filled with --text-2)
const PROVIDER_LOGOS = {
  anthropic: `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--text-2)"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  openai: `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--text-2)"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>`,
  copilot: `<svg width="16" height="13" viewBox="0 0 512 416" fill="var(--text-2)" fill-rule="evenodd" clip-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2"><path d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z" fill-rule="nonzero"/><path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z"/></svg>`,
  generic: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--text-2)" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2" fill="var(--text-2)"/></svg>`,
};

const CODING_AGENT_LOGOS = {
  'claude-code': `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  codex: PROVIDER_LOGOS.openai.replaceAll('var(--text-2)', 'currentColor'),
};

function getProviderFromModel(model) {
  if (!model) return 'generic';
  const id = (model.id || '').toLowerCase();
  const vendor = (model.vendor || '').toLowerCase();
  if (id.startsWith('direct:claude') || vendor.includes('anthropic')) return 'anthropic';
  if (id.startsWith('direct:gpt') || id.startsWith('direct:o') || vendor.includes('openai')) return 'openai';
  if (vendor.includes('copilot') || /^gpt|^o\d/.test(model.family || '')) return 'copilot';
  if (/claude/.test(model.family || '')) return 'anthropic';
  return 'copilot'; // default for VS Code LM models
}

function updateAgentModelLabel() {
  const el = document.getElementById('agent-model-label');
  const logoEl = document.getElementById('agent-model-logo');
  const m = state.availableModels.find(m => m.id === state.agentModelId);
  if (el) el.textContent = m ? m.family : state.agentModelId || 'auto';
  if (logoEl) {
    const provider = getProviderFromModel(m);
    logoEl.innerHTML = PROVIDER_LOGOS[provider] || PROVIDER_LOGOS.generic;
  }
}

function updateCodingAgentControls(preferredAgentId) {
  const row = document.getElementById('session-agent-bar');
  const select = document.getElementById('coding-agent-select');
  const button = document.getElementById('connect-agent-btn');
  const logo = document.getElementById('coding-agent-provider-logo');
  const agents = Array.isArray(state.availableCodingAgents) ? state.availableCodingAgents : [];

  if (!row || !select || !button || !logo) return;

  if (!agents.length) {
    row.classList.add('hidden');
    return;
  }

  row.classList.remove('hidden');
  const requestedId = preferredAgentId || state.selectedCodingAgentId || (vscode.getState() || {}).selectedCodingAgentId || '';
  const selectedAgent = agents.find((agent) => agent.id === requestedId) || agents[0];
  state.selectedCodingAgentId = selectedAgent ? selectedAgent.id : '';

  select.innerHTML = agents.map((agent) => {
    const versionSuffix = agent.version ? ` (${agent.version})` : '';
    return `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.label + versionSuffix)}</option>`;
  }).join('');
  select.value = state.selectedCodingAgentId;
  button.disabled = !selectedAgent;
  button.title = selectedAgent ? `Connect ${selectedAgent.label} via MCP` : 'Connect MCP';
  button.setAttribute('aria-label', selectedAgent ? `Connect ${selectedAgent.label} via MCP` : 'Connect MCP');
  if (logo) {
    logo.innerHTML = selectedAgent ? (CODING_AGENT_LOGOS[selectedAgent.id] || '') : '';
    logo.classList.toggle('hidden', !selectedAgent);
  }

  const prev = vscode.getState() || {};
  vscode.setState({ ...prev, selectedCodingAgentId: state.selectedCodingAgentId });
}

function connectSelectedCodingAgent() {
  if (!state.selectedCodingAgentId) {
    toast('No coding agent available', 'error');
    return;
  }
  vscode.postMessage({ type: 'connectCodingAgent', agentId: state.selectedCodingAgentId });
}

function showModelPicker() {
  const btn = document.getElementById('agent-model-btn');
  const existing = document.getElementById('agent-model-menu');
  if (existing) { existing.remove(); return; }

  vscode.postMessage({ type: 'listModels' });

  const models = state.availableModels.filter(m =>
    !/^copilotcli/i.test(m.vendor) && !/^copilotcli/i.test(m.id)
  );
  if (!models.length) {
    toast('No language models found', 'error');
    return;
  }

  const menu = document.createElement('div');
  menu.id = 'agent-model-menu';
  menu.className = 'agent-model-menu';
  menu.innerHTML = models.map(m => {
    const label = m.vendor + ' / ' + m.family;
    const sel = m.id === state.agentModelId ? ' selected' : '';
    return `<div class="agent-model-option${sel}" data-model-id="${escapeHtml(m.id)}" title="${escapeHtml(m.id)}">${escapeHtml(label)}</div>`;
  }).join('');
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);
  menu.addEventListener('click', e => {
    const opt = e.target.closest('.agent-model-option');
    if (!opt) return;
    state.agentModelId = opt.dataset.modelId;
    updateAgentModelLabel();
    vscode.postMessage({ type: 'janeSessionSetModel', modelId: state.agentModelId });
    menu.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('click', dismiss);
      }
    });
  }, 0);
}

// ── Chat log with typing animation ──────────────────────────
let _typingTimer = null;
let _mermaidIdCounter = 0;
// No cap on chat entries — user dismisses manually

// ── Notebook cell system ─────────────────────────────────
// Every block in the agent's answer is a "cell" with consistent controls

const CELL_CLOSE_SVG = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.5 4V2.5a1 1 0 011-1h3a1 1 0 011 1V4"/><path d="M3.5 4v9a1.5 1.5 0 001.5 1.5h6a1.5 1.5 0 001.5-1.5V4"/></svg>`;
const CELL_COPY_SVG = `<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="9" height="9" rx="1.5"/><path d="M10 4V2.5A1.5 1.5 0 008.5 1h-6A1.5 1.5 0 001 2.5v6A1.5 1.5 0 002.5 10H4"/></svg>`;
const CELL_INSERT_UP_SVG = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2.2v6.2"/><path d="M4.6 4.6L7 2.2l2.4 2.4"/><path d="M3 11h8"/><path d="M7 9.2v3.2"/><path d="M5.4 11h3.2"/></svg>`;
const CELL_INSERT_DOWN_SVG = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11.8V5.6"/><path d="M4.6 9.4L7 11.8l2.4-2.4"/><path d="M3 3h8"/><path d="M7 1v3.2"/><path d="M5.4 3h3.2"/></svg>`;
const PY_LOGO_SVG = `<svg class="py-logo" width="14" height="14" viewBox="0 0 14 14"><path d="M7 0C4.5 0 4.8 1 4.8 1l0 2h2.4v.7H3.5S1 3.4 1 7s2 3.4 2 3.4h1.2V8.2s-.1-2 2-2h2.6s1.9 0 1.9-1.8V1.9S11 0 7 0zM5.2 1.2a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4z" fill="#3572A5"/><path d="M7 14c2.5 0 2.2-1 2.2-1l0-2H6.8v-.7h3.7s2.5.3 2.5-3.3-2-3.4-2-3.4H9.8v2.2s.1 2-2 2H5.2s-1.9 0-1.9 1.8v2.5S3 14 7 14zM8.8 12.8a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z" fill="#FDD835"/></svg>`;

function _cellToolbar(buttons) {
  const bar = document.createElement('div');
  bar.className = 'nb-cell-toolbar';
  bar.innerHTML = `<div class="nb-toolbar-inner">${buttons}</div>`;
  return bar;
}

function createNotebookEntityId(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${prefix}_${window.crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function _makeCollapsible(cell, toggleEl) {
  toggleEl.addEventListener('click', () => {
    cell.classList.toggle('cell-collapsed');
    toggleEl.innerHTML = cell.classList.contains('cell-collapsed') ? ICON_EXPAND : ICON_COLLAPSE;
  });
}

function _makeDeletable(cell, closeEl) {
  closeEl.addEventListener('click', () => {
    cell.remove();
    flushNotebookSessionPersist();
  });
}

function _renderOutput(outputEl, rawResult) {
  outputEl.dataset.rawResult = rawResult || '';
  if (!rawResult) { outputEl.innerHTML = '<span class="nb-output-empty">(no output)</span>'; return; }
  const imgs = [];
  const textLines = [];
  for (const line of String(rawResult).split(/\r?\n/)) {
    const match = line.match(/^IMG:([A-Za-z0-9+/=]+)$/);
    if (match) imgs.push(match[1]);
    else textLines.push(line);
  }
  const result = textLines.join('\n');
  let html = '';
  if (result.trim()) html += `<pre class="nb-output-text">${escapeHtml(result.trim())}</pre>`;
  for (const b64 of imgs) html += `<img class="agent-plot" src="data:image/png;base64,${b64}" alt="plot" />`;
  outputEl.innerHTML = html || '<span class="nb-output-empty">(no output)</span>';
}

let _persistNotebookTimer = null;
let _cellRequestSeq = 0;

function nextCellRequestId(prefix = 'cell') {
  _cellRequestSeq += 1;
  return `${prefix}-${Date.now()}-${_cellRequestSeq}`;
}

function findNotebookCellById(cellId, fallbackCell) {
  const id = String(cellId || '').trim();
  if (!id) return fallbackCell || null;
  const selector = `.nb-cell[data-cell-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`;
  return document.querySelector(selector) || fallbackCell || null;
}

function isLegacyPendingNotebookPythonOutput(output) {
  const text = String(output || '').trim();
  if (!text) return false;
  // Compatibility for notebook cells persisted before explicit runState existed.
  return /^\[[^\]]*\bplot\b[^\]]*\]$/i.test(text);
}

function looksLikeCellExecutionErrorText(output) {
  const text = String(output || '').trim();
  if (!text) return false;
  return /^Error \(exit\s+\d+\):/i.test(text)
    || /^Execution error:/i.test(text)
    || /Traceback \(most recent call last\):/i.test(text)
    || /\b(?:SyntaxError|NameError|TypeError|ValueError|IndexError|KeyError|ModuleNotFoundError|ImportError|AttributeError|RuntimeError)\b/.test(text);
}

function normalizeNotebookPythonRunState(runState, output) {
  const normalized = String(runState || '').trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'done' || normalized === 'error') {
    return normalized;
  }
  if (normalized === 'running') {
    return 'pending';
  }
  const text = String(output || '').trim();
  if (!text) return 'pending';
  if (isLegacyPendingNotebookPythonOutput(text)) return 'pending';
  if (looksLikeCellExecutionErrorText(text)) return 'error';
  return 'done';
}

function getNotebookCellLanguage(cell, fallback = 'python') {
  const raw = String((cell && cell.dataset && cell.dataset.lang) || fallback || '').trim().toLowerCase();
  if (!raw) return 'python';
  if (raw === 'py' || raw === 'execute_python') return 'python';
  return raw;
}

function mergeAdjacentMarkdownCells(cells) {
  const merged = [];
  for (const cell of (cells || [])) {
    if (!cell) continue;
    if (cell.type === 'markdown' && merged.length > 0 && merged[merged.length - 1].type === 'markdown') {
      const prev = merged[merged.length - 1];
      prev.content = [prev.content, cell.content].filter(Boolean).join('\n\n').trim();
      continue;
    }
    merged.push(cell);
  }
  return merged;
}

function normalizeNotebookCellsForRender(cells) {
  return (cells || []).map((cell) => {
    if (!cell || cell.type !== 'python') return cell;
    if (!String(cell.code || '').trim()) return cell;
    return {
      ...cell,
      runState: normalizeNotebookPythonRunState(cell.runState, cell.output),
    };
  });
}

function buildNotebookCellModels(answerText, executedCells, diffs) {
  const cells = [];
  let fullText = answerText || '';

  if (fullText && !/```/.test(fullText) && /^(?:import |from \w+ import |plt\.|matplotlib)/m.test(fullText)) {
    const lines = fullText.split('\n');
    let codeStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:import |from \w+ import |plt\.|matplotlib|fig|ax[.\s=]|#)/.test(lines[i].trim())) {
        if (codeStart < 0) codeStart = i;
      }
    }
    if (codeStart >= 0) {
      const before = lines.slice(0, codeStart).join('\n').trim();
      const code = lines.slice(codeStart).join('\n').trim();
      fullText = (before ? before + '\n\n' : '') + '```python\n' + code + '\n```';
    }
  }

  const standaloneImages = [];
  fullText = fullText
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^IMG:([A-Za-z0-9+/=]+)$/);
      if (!match) return true;
      standaloneImages.push(match[1]);
      return false;
    })
    .join('\n')
    .trim();

  if (fullText) {
    const blocks = splitTextIntoParagraphs(parseRichBlocks(fullText));
    for (const block of blocks) {
      if (block.type === 'text') {
        cells.push({ type: 'markdown', content: block.content });
      } else if (block.type === 'code' && /^(python|execute_python|py)$/i.test(block.lang || '')) {
        cells.push({ type: 'python', code: block.content, output: '', runState: 'pending' });
      } else if (block.type === 'code') {
        cells.push({ type: 'code', lang: block.lang || 'text', content: block.content });
      } else if (block.type === 'ascii') {
        cells.push({ type: 'ascii', content: block.content });
      } else if (block.type === 'mermaid') {
        cells.push({ type: 'mermaid', content: block.content });
      } else if (block.type === 'svg') {
        cells.push({ type: 'svg', content: block.content });
      }
    }
  }

  for (const ec of (executedCells || [])) {
    cells.push({
      type: 'python',
      code: ec.code || '',
      output: ec.output || '',
      runState: normalizeNotebookPythonRunState(ec.runState, ec.output),
    });
  }

  for (const b64 of standaloneImages) {
    cells.push({ type: 'image', data: b64 });
  }

  if (diffs && diffs.length > 0) {
    cells.push({ type: 'diff', diffs });
  }

  return normalizeNotebookCellsForRender(mergeAdjacentMarkdownCells(cells));
}

function serializeNotebookCell(cell) {
  const cellId = cell.dataset.cellId || createNotebookEntityId('cell');
  const type = cell.dataset.cellType || '';
  if (type === 'markdown') {
    const editor = cell.querySelector('.nb-md-editor');
    return { id: cellId, type: 'markdown', content: editor ? editor.value : '' };
  }
  if (type === 'python') {
    const codeArea = cell._cmEditor || cell.querySelector('.py-cell-input');
    const output = cell.querySelector('.nb-output');
    return {
      id: cellId,
      type: 'python',
      code: codeArea ? (typeof codeArea.getValue === 'function' ? codeArea.getValue() : codeArea.value) : '',
      output: output ? (output.dataset.rawResult || '') : '',
      runState: normalizeNotebookPythonRunState(cell.dataset.runState, output ? (output.dataset.rawResult || '') : ''),
    };
  }
  if (type === 'image') {
    return { id: cellId, type: 'image', data: cell.dataset.imageData || '' };
  }
  if (type === 'diff') {
    try {
      return { id: cellId, type: 'diff', diffs: JSON.parse(cell.dataset.diffs || '[]') };
    } catch {
      return { id: cellId, type: 'diff', diffs: [] };
    }
  }
  return {
    id: cellId,
    type,
    lang: cell.dataset.lang || '',
    content: cell.dataset.content || '',
  };
}

function serializeNotebookEntry(entryEl) {
  const cells = [...entryEl.querySelectorAll(':scope > .nb-cells > .nb-cell')]
    .map(serializeNotebookCell)
    .filter((cell) => cell && (
      (cell.type === 'markdown' && cell.content)
      || (cell.type === 'python' && cell.code)
      || (cell.type === 'image' && cell.data)
      || (cell.type === 'diff')
      || cell.content
    ));
  return {
    id: entryEl.dataset.entryId || createNotebookEntityId('entry'),
    question: (entryEl.querySelector('.nb-prompt-text') || {}).textContent || '',
    answer: '',
    summary: '',
    executedCells: [],
    cells: mergeAdjacentMarkdownCells(cells),
    isError: entryEl.classList.contains('nb-entry-error'),
    timestamp: entryEl.dataset.timestamp || new Date().toISOString(),
  };
}

function persistNotebookSessionEntries() {
  const log = document.getElementById('agent-chat-log');
  if (!log) return;
  const entries = [...log.querySelectorAll(':scope > .nb-entry')].map(serializeNotebookEntry);
  state.sessionEntries = entries;
  vscode.postMessage({ type: 'persistSessionEntries', entries });
}

function flushNotebookSessionPersist() {
  if (_persistNotebookTimer) {
    clearTimeout(_persistNotebookTimer);
    _persistNotebookTimer = null;
  }
  persistNotebookSessionEntries();
}

function scheduleNotebookSessionPersist() {
  if (_persistNotebookTimer) clearTimeout(_persistNotebookTimer);
  _persistNotebookTimer = setTimeout(() => {
    _persistNotebookTimer = null;
    persistNotebookSessionEntries();
  }, 250);
}

function bindNotebookPersistenceLifecycle() {
  if (window.__selvaNotebookPersistBound) return;
  window.__selvaNotebookPersistBound = true;

  const flushOnLifecycle = () => {
    if (_persistNotebookTimer) flushNotebookSessionPersist();
  };

  window.addEventListener('pagehide', flushOnLifecycle);
  window.addEventListener('beforeunload', flushOnLifecycle);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnLifecycle();
  });
}

bindNotebookPersistenceLifecycle();

function buildCodeMirrorEditor(host, initialCode, onRun) {
  if (typeof window.CodeMirror !== 'function') return null;
  const editor = window.CodeMirror(host, {
    value: initialCode || '',
    mode: 'python',
    lineNumbers: true,
    lineWrapping: false,
    indentUnit: 4,
    tabSize: 4,
    viewportMargin: Infinity,
    matchBrackets: true,
    extraKeys: {
      'Shift-Enter': () => onRun(),
      'Cmd-/': 'toggleComment',
      'Ctrl-/': 'toggleComment',
      'Alt-/': 'toggleComment',
      Tab(cm) {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
          return;
        }
        cm.replaceSelection('    ', 'end');
      },
      'Shift-Tab'(cm) {
        if (cm.somethingSelected()) {
          cm.indentSelection('subtract');
          return;
        }
        const cursor = cm.getCursor();
        const line = cm.getLine(cursor.line);
        const match = line.match(/^( {1,4}|\t)/);
        if (!match) return;
        cm.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: match[0].length });
      },
    },
  });
  editor.on('change', () => scheduleNotebookSessionPersist());
  editor.on('blur', () => flushNotebookSessionPersist());
  requestAnimationFrame(() => editor.refresh());
  return editor;
}

// ── Build a notebook cell by type ────────────────────────

function buildCell(block) {
  const kind = String(block.type || '').toLowerCase();
  const cell = document.createElement('div');
  cell.className = 'nb-cell nb-' + kind;
  cell.dataset.cellType = kind;
  cell.dataset.cellId = block.id || createNotebookEntityId('cell');

  if (kind === 'markdown') {
    const startEditing = !!block.startEditing;
    const mdLogo = `<svg class="md-logo" width="16" height="10" viewBox="0 0 208 128" fill="#4169aa"><path d="M15 10h18l30 39 30-39h18v108h-21V44L63 83 36 44v74H15zm123 0h21v66l35-38 35 38V10h21v108h-21l-35-39-35 39H138z"/></svg>`;
    const toolbar = _cellToolbar(
      `${mdLogo}<span class="py-toolbar-spacer"></span>` +
      `<button class="nb-run nb-md-run" title="Render (Shift+Enter)"><svg width="8" height="10" viewBox="0 0 12 14" fill="currentColor"><path d="M1 0.5v13l10.5-6.5z"/></svg><span>Run</span></button>` +
      `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);

    // Rendered output (shown by default)
    const rendered = document.createElement('div');
    rendered.className = 'nb-cell-body rich-text';
    if (startEditing) rendered.classList.add('hidden');
    rendered.innerHTML = renderMarkdownLatex(block.content || '');
    cell.appendChild(rendered);

    // Raw source editor (hidden by default)
    const editor = document.createElement('textarea');
    editor.className = 'nb-md-editor' + (startEditing ? '' : ' hidden');
    editor.value = block.content || '';
    editor.spellcheck = false;
    editor.rows = Math.max(3, editor.value.split('\n').length + 1);
    cell.appendChild(editor);

    let editMode = startEditing;
    function toggleEditMode() {
      editMode = !editMode;
      rendered.classList.toggle('hidden', editMode);
      editor.classList.toggle('hidden', !editMode);
      if (editMode) {
        editor.rows = Math.max(3, editor.value.split('\n').length + 1);
        editor.focus();
      }
    }
    function runMd() {
      rendered.innerHTML = renderMarkdownLatex(editor.value);
      if (editMode) toggleEditMode();
      wireLinks(cell);
      scheduleNotebookSessionPersist();
    }

    // Double-click rendered text to edit
    rendered.addEventListener('dblclick', toggleEditMode);

    // Run button
    toolbar.querySelector('.nb-md-run').addEventListener('click', runMd);

    // Shift+Enter in editor to render
    editor.addEventListener('keydown', (e) => {
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        runMd();
      }
    });
    // Auto-resize editor
    editor.addEventListener('input', () => {
      editor.rows = Math.max(3, editor.value.split('\n').length + 1);
      scheduleNotebookSessionPersist();
    });
    editor.addEventListener('blur', () => flushNotebookSessionPersist());

    _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));
    if (startEditing) {
      requestAnimationFrame(() => {
        editor.rows = Math.max(3, editor.value.split('\n').length + 1);
        editor.focus();
      });
    }
    return cell;
  }

  // ── Python cell ────────────────────────────────────
  if (kind === 'python') {
    cell.dataset.lang = String(block.lang || 'python');
    const cellNum = ++_pythonCellCounter;

    // Margin play button (top of cell, aligned with header)
    const marginRunBtn = document.createElement('button');
    marginRunBtn.className = 'nb-margin-run';
    marginRunBtn.title = 'Run (Shift+Enter)';
    marginRunBtn.innerHTML = '<svg width="10" height="12" viewBox="0 0 12 14" fill="currentColor"><path d="M1 0.5v13l10.5-6.5z"/></svg>';
    cell.appendChild(marginRunBtn);

    // Cell number index (bottom of cell in margin)
    const cellIndex = document.createElement('div');
    cellIndex.className = 'nb-cell-index';
    cellIndex.textContent = `[${cellNum}]`;
    cell.appendChild(cellIndex);

    const toolbar = _cellToolbar(
      `${PY_LOGO_SVG}` +
      `<button class="nb-cell-prompt-btn" title="Ask agent to edit this code">&gt;_</button>` +
      `<input type="text" class="nb-cell-prompt-input hidden" placeholder="edit or debug instructions..." spellcheck="false">` +
      `<span class="py-toolbar-spacer"></span>` +
      `<button class="nb-insert nb-insert-up" title="Insert python cell above">${CELL_INSERT_UP_SVG}</button>` +
      `<button class="nb-insert nb-insert-down" title="Insert python cell below">${CELL_INSERT_DOWN_SVG}</button>` +
      `<button class="nb-run" style="display:none"></button>` +
      `<button class="nb-copy" title="Copy">${CELL_COPY_SVG}</button>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);

    // Click to select cell
    cell.addEventListener('click', () => {
      document.querySelectorAll('.nb-cell-selected').forEach(c => c.classList.remove('nb-cell-selected'));
      cell.classList.add('nb-cell-selected');
    });
    const runBtn = toolbar.querySelector('.nb-run');
    const copyBtn = toolbar.querySelector('.nb-copy');
    const insertUpBtn = toolbar.querySelector('.nb-insert-up');
    const insertDownBtn = toolbar.querySelector('.nb-insert-down');
    const playSvg = '<svg width="8" height="10" viewBox="0 0 12 14" fill="currentColor"><path d="M1 0.5v13l10.5-6.5z"/></svg><span>Run</span>';
    const stopSvg = '<svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="10" height="10" rx="1.5"/></svg><span>Stop</span>';
    const marginPlaySvg = '<svg width="10" height="12" viewBox="0 0 12 14" fill="currentColor"><path d="M1 0.5v13l10.5-6.5z"/></svg>';
    const marginStopSvg = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="10" height="10" rx="1.5"/></svg>';
    // Margin play button delegates to the hidden toolbar run button
    marginRunBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runBtn.click();
    });

    // Cell-level agent prompt
    const promptBtn = toolbar.querySelector('.nb-cell-prompt-btn');
    const promptInput = toolbar.querySelector('.nb-cell-prompt-input');
    promptBtn.addEventListener('click', () => {
      promptBtn.classList.add('hidden');
      promptInput.classList.remove('hidden');
      promptInput.focus();
    });
    promptInput.addEventListener('blur', () => {
      if (!promptInput.value.trim()) {
        promptInput.classList.add('hidden');
        promptBtn.classList.remove('hidden');
      }
    });
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        promptInput.value = '';
        promptInput.classList.add('hidden');
        promptBtn.classList.remove('hidden');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const instruction = promptInput.value.trim();
        if (!instruction) return;
        const requestId = nextCellRequestId('edit');
        const cellId = cell.dataset.cellId || '';
        const handler = (event) => {
          const msg = event.data;
          if (msg.type !== 'editCellCodeResult') return;
          if (msg.requestId !== requestId) return;
          window.removeEventListener('message', handler);
          promptInput.disabled = false;
          promptInput.placeholder = 'edit or debug instructions...';
          promptInput.value = '';
          promptInput.classList.add('hidden');
          promptBtn.classList.remove('hidden');
          const targetCell = findNotebookCellById(cellId, cell) || cell;
          const targetOutput = targetCell.querySelector('.nb-output') || output;
          if (msg.error) {
            targetCell.dataset.runState = 'error';
            targetOutput.className = 'nb-output';
            targetOutput.dataset.rawResult = msg.error;
            targetOutput.innerHTML = `<pre class="nb-output-error">${escapeHtml(msg.error)}</pre>`;
            toast('Cell edit failed', 'error');
            return;
          }
          if (msg.code) {
            if (targetCell._cmEditor) {
              targetCell._cmEditor.setValue(msg.code);
              targetCell._cmEditor.focus();
            } else {
              const fallbackInput = targetCell.querySelector('.py-cell-input');
              if (fallbackInput) fallbackInput.value = msg.code;
            }
            const hasExecutionResult = Object.prototype.hasOwnProperty.call(msg, 'output');
            if (hasExecutionResult) {
              targetCell.dataset.runState = msg.output && looksLikeCellExecutionErrorText(msg.output)
                ? 'error'
                : 'done';
              targetOutput.className = 'nb-output' + (msg.output ? '' : ' hidden');
              if (msg.output) {
                _renderOutput(targetOutput, msg.output);
              } else {
                targetOutput.dataset.rawResult = '';
                targetOutput.innerHTML = '';
              }
            }
            if (msg.validationError) {
              toast(msg.validationError, 'error');
            } else if (msg.validated) {
              toast(`Code updated and validated in ${msg.attempts || 1} attempt${(msg.attempts || 1) > 1 ? 's' : ''}`, 'success');
            } else {
              toast('Code updated', 'success');
            }
            flushNotebookSessionPersist();
            // Always auto-run after debug/edit
            targetCell.dataset.runState = 'pending';
            const targetRunBtn = targetCell.querySelector('.nb-run');
            if (targetRunBtn && !targetRunBtn.disabled) {
              requestAnimationFrame(() => targetRunBtn.click());
            }
          }
        };
        window.addEventListener('message', handler);
        promptInput.disabled = true;
        promptInput.placeholder = 'thinking...';
        // Send to agent: modify this specific code
        vscode.postMessage({
          type: 'editCellCode',
          requestId,
          cellId,
          language: getNotebookCellLanguage(cell),
          trailId: state.activeTrailId || '',
          code: cell._cmEditor ? cell._cmEditor.getValue() : (cell.querySelector('.py-cell-input') || {}).value || '',
          instruction,
          output: looksLikeCellExecutionErrorText((cell.querySelector('.nb-output') || {}).dataset?.rawResult || '')
            ? ((cell.querySelector('.nb-output') || {}).dataset?.rawResult || '')
            : '',
          agentId: state.selectedCodingAgentId || '',
          modelId: state.agentModelId,
        });
      }
    });

    const runCurrentCode = () => runBtn.click();

    // Code area
    const codeWrap = document.createElement('div');
    codeWrap.className = 'py-cell';
    const codeEditorHost = document.createElement('div');
    codeEditorHost.className = 'py-cell-editor';
    codeWrap.appendChild(codeEditorHost);
    codeWrap.appendChild(cellIndex);
    cell.appendChild(codeWrap);

    const codeEditor = buildCodeMirrorEditor(codeEditorHost, block.code || '', runCurrentCode);
    if (codeEditor) {
      cell._cmEditor = codeEditor;
    } else {
      const codeArea = document.createElement('textarea');
      codeArea.className = 'py-cell-input';
      codeArea.value = block.code || '';
      codeArea.spellcheck = false;
      codeWrap.appendChild(codeArea);
      codeArea.addEventListener('input', () => {
        scheduleNotebookSessionPersist();
      });
      codeArea.addEventListener('blur', () => flushNotebookSessionPersist());
      codeArea.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key === 'Enter') {
          e.preventDefault();
          runCurrentCode();
        }
      });
    }

    // Output area
    const output = document.createElement('div');
    const initialOutput = block.output || '';
    cell.dataset.runState = normalizeNotebookPythonRunState(block.runState, initialOutput);
    output.className = 'nb-output' + (initialOutput ? '' : ' hidden');
    cell.appendChild(output);
    if (initialOutput) {
      _renderOutput(output, initialOutput);
    }

    // Output margin menu (three dots → dropdown with clear/copy)
    // Lives as a sibling after the output div, positioned absolutely
    const outputMenuWrap = document.createElement('div');
    outputMenuWrap.className = 'nb-output-menu-wrap' + (initialOutput ? '' : ' hidden');
    const outputDots = document.createElement('button');
    outputDots.className = 'nb-output-dots';
    outputDots.innerHTML = '&#8943;';
    outputDots.title = 'Output actions';
    const outputDropdown = document.createElement('div');
    outputDropdown.className = 'nb-output-dropdown hidden';
    outputDropdown.innerHTML =
      `<button class="nb-output-dropdown-item nb-output-clear" title="Clear output">` +
      `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.5 4V2.5a1 1 0 011-1h3a1 1 0 011 1V4"/><path d="M3.5 4v9a1.5 1.5 0 001.5 1.5h6a1.5 1.5 0 001.5-1.5V4"/></svg>` +
      `</button>` +
      `<button class="nb-output-dropdown-item nb-output-copy-out" title="Copy output">` +
      `${CELL_COPY_SVG}` +
      `</button>`;
    outputMenuWrap.appendChild(outputDots);
    outputMenuWrap.appendChild(outputDropdown);
    cell.appendChild(outputMenuWrap);

    outputDots.addEventListener('click', (e) => {
      e.stopPropagation();
      outputDropdown.classList.toggle('hidden');
    });
    outputDropdown.querySelector('.nb-output-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      outputDropdown.classList.add('hidden');
      output.dataset.rawResult = '';
      output.className = 'nb-output hidden';
      outputMenuWrap.classList.add('hidden');
      _renderOutput(output, '');
      scheduleNotebookSessionPersist();
    });
    outputDropdown.querySelector('.nb-output-copy-out').addEventListener('click', (e) => {
      e.stopPropagation();
      outputDropdown.classList.add('hidden');
      const rawText = output.dataset.rawResult || output.textContent || '';
      navigator.clipboard.writeText(rawText).then(() => toast('Output copied'));
    });
    document.addEventListener('click', () => outputDropdown.classList.add('hidden'));

    // Copy
    copyBtn.addEventListener('click', () => {
      const currentCode = cell._cmEditor ? cell._cmEditor.getValue() : ((cell.querySelector('.py-cell-input') || {}).value || '');
      navigator.clipboard.writeText(currentCode).then(() => toast('Copied'));
    });
    insertUpBtn.addEventListener('click', () => {
      insertNotebookCellRelative(cell, 'python', 'before');
    });
    insertDownBtn.addEventListener('click', () => {
      insertNotebookCellRelative(cell, 'python', 'after');
    });

    // Delete
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));

    // Run button
    runBtn.addEventListener('click', function() {
      const requestId = nextCellRequestId('run');
      const cellId = cell.dataset.cellId || '';
      const handler = (event) => {
        const msg = event.data;
        if (msg.type !== 'executeCellResult') return;
        if (msg.requestId !== requestId) return;
        window.removeEventListener('message', handler);
        const targetCell = findNotebookCellById(cellId, cell) || cell;
        const targetOutput = targetCell.querySelector('.nb-output') || output;
        this.disabled = false;
        this.innerHTML = playSvg;
        this.classList.remove('py-running');
        marginRunBtn.innerHTML = marginPlaySvg;
        marginRunBtn.classList.remove('nb-margin-running');
        if (msg.error) {
          targetCell.dataset.runState = 'error';
          _renderOutput(targetOutput, msg.error);
        } else {
          targetCell.dataset.runState = looksLikeCellExecutionErrorText(msg.result) ? 'error' : 'done';
          _renderOutput(targetOutput, msg.result);
        }
        // Show the output menu now that there's output
        outputMenuWrap.classList.remove('hidden');
        if (msg.status) setNotebookKernelStatus(msg.status);
        else requestNotebookKernelStatus();
        flushNotebookSessionPersist();
      };
      window.addEventListener('message', handler);
      this.disabled = true;
      this.innerHTML = stopSvg;
      this.classList.add('py-running');
      marginRunBtn.innerHTML = marginStopSvg;
      marginRunBtn.classList.add('nb-margin-running');
      // Update execution counter on the cell index
      cellIndex.textContent = `[${++_pythonCellCounter}]`;
      cell.dataset.runState = 'running';
      setNotebookKernelStatus({
        language: getNotebookCellLanguage(cell),
        trailId: state.activeTrailId || '',
        started: true,
        state: 'busy',
      });
      output.className = 'nb-output';
      output.innerHTML = '<span class="nb-output-pending">Running...</span>';
      const currentCode = cell._cmEditor ? cell._cmEditor.getValue() : ((cell.querySelector('.py-cell-input') || {}).value || '');
      vscode.postMessage({
        type: 'executeCell',
        requestId,
        cellId,
        code: currentCode,
        language: getNotebookCellLanguage(cell),
        trailId: state.activeTrailId || '',
      });
    });

    const shouldAutoRun = cell.dataset.runState === 'pending';
    if (shouldAutoRun) {
      requestAnimationFrame(() => {
        const currentCode = cell._cmEditor
          ? cell._cmEditor.getValue()
          : ((cell.querySelector('.py-cell-input') || {}).value || '');
        if (!String(currentCode || '').trim()) return;
        runBtn.click();
      });
    }

    return cell;
  }

  // ── Mermaid cell ───────────────────────────────────
  if (kind === 'mermaid') {
    cell.dataset.content = block.content || '';
    const toolbar = _cellToolbar(
      `<span class="nb-cell-type">mermaid</span><span class="py-toolbar-spacer"></span>` +
      `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);
    const body = document.createElement('div');
    body.className = 'nb-cell-body';
    cell.appendChild(body);
    const id = 'mermaid-' + (++_mermaidIdCounter);
    if (typeof mermaid !== 'undefined') {
      mermaid.render(id, block.content || '').then(({ svg }) => { body.innerHTML = svg; })
        .catch(() => { body.textContent = block.content || ''; });
    } else { body.textContent = block.content || ''; }
    _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));
    return cell;
  }

  // ── SVG cell ───────────────────────────────────────
  if (kind === 'svg') {
    cell.dataset.content = block.content || '';
    const toolbar = _cellToolbar(
      `<span class="nb-cell-type">svg</span><span class="py-toolbar-spacer"></span>` +
      `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);
    const body = document.createElement('div');
    body.className = 'nb-cell-body';
    body.innerHTML = block.content || '';
    cell.appendChild(body);
    _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));
    return cell;
  }

  if (kind === 'image') {
    cell.dataset.imageData = block.data || '';
    const toolbar = _cellToolbar(
      `<span class="nb-cell-type">plot</span><span class="py-toolbar-spacer"></span>` +
      `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);
    const body = document.createElement('div');
    body.className = 'nb-cell-body';
    body.innerHTML = `<img class="agent-plot" src="data:image/png;base64,${block.data || ''}" alt="plot" />`;
    cell.appendChild(body);
    _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));
    return cell;
  }

  if (kind === 'diff') {
    const diffs = Array.isArray(block.diffs) ? block.diffs : [];
    cell.dataset.diffs = JSON.stringify(diffs);
    const toolbar = _cellToolbar(
      `<span class="nb-cell-type">changes</span><span class="py-toolbar-spacer"></span>` +
      `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
      `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
    );
    cell.appendChild(toolbar);
    const body = document.createElement('div');
    body.className = 'nb-cell-body';
    body.innerHTML = diffs.map(({ file, path, oldVal, newVal }) =>
      `<div class="agent-diff-line">` +
      `<span class="agent-diff-file">${escapeHtml(file)}</span>` +
      `<span class="agent-diff-key">${escapeHtml(path.join('.'))}</span>` +
      `<span class="agent-diff-old">${escapeHtml(String(oldVal))}</span>` +
      `<span class="agent-diff-arrow">\u2192</span>` +
      `<span class="agent-diff-new">${escapeHtml(String(newVal))}</span>` +
      `</div>`
    ).join('');
    cell.appendChild(body);
    _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
    _makeDeletable(cell, toolbar.querySelector('.nb-close'));
    return cell;
  }

  // ── ASCII / code cell (non-Python) ─────────────────
  cell.dataset.content = block.content || '';
  if (block.lang) cell.dataset.lang = block.lang;
  const langLabel = kind === 'code' ? (block.lang || 'code') : kind;
  const toolbar = _cellToolbar(
    `<span class="nb-cell-type">${escapeHtml(langLabel)}</span><span class="py-toolbar-spacer"></span>` +
    `<button class="nb-copy" title="Copy">${CELL_COPY_SVG}</button>` +
    `<span class="nb-toggle">${ICON_COLLAPSE}</span>` +
    `<button class="nb-close" title="Remove">${CELL_CLOSE_SVG}</button>`
  );
  cell.appendChild(toolbar);
  const body = document.createElement('pre');
  body.className = 'nb-cell-body nb-pre';
  body.textContent = block.content || '';
  cell.appendChild(body);
  _makeCollapsible(cell, toolbar.querySelector('.nb-toggle'));
  _makeDeletable(cell, toolbar.querySelector('.nb-close'));
  const copyBtn = toolbar.querySelector('.nb-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(block.content || '').then(() => toast('Copied'));
  });
  return cell;
}

// ── Render answer as notebook cells ──────────────────
function renderNotebookCells(container, cells) {
  for (const cell of (cells || [])) {
    container.appendChild(buildCell(cell));
  }
  wireLinks(container);
}

function ensureNotebookTailEntry() {
  const log = document.getElementById('agent-chat-log');
  if (!log) return null;

  let entry = [...log.querySelectorAll(':scope > .nb-entry')].pop();
  if (!entry) {
    addChatEntry('manual note', '', null, false, null, {
      instant: true,
      skipPersist: true,
      timestamp: new Date().toISOString(),
      cells: [],
    });
    entry = [...log.querySelectorAll(':scope > .nb-entry')].pop();
  }
  if (!entry) return null;

  log.classList.remove('hidden');
  entry.classList.remove('nb-collapsed');
  const toggle = entry.querySelector('.nb-entry-toggle');
  if (toggle) toggle.innerHTML = ICON_COLLAPSE;
  return entry.querySelector('.nb-cells');
}

function createManualNotebookCellModel(kind) {
  return kind === 'python'
    ? { type: 'python', lang: 'python', code: '', output: '', runState: 'pending', expanded: true }
    : { type: 'markdown', content: '', startEditing: true };
}

function focusNotebookCell(cell) {
  if (!cell) return;
  requestAnimationFrame(() => {
    if (cell._cmEditor) {
      cell._cmEditor.refresh();
      cell._cmEditor.focus();
      return;
    }
    const input = cell.querySelector('.py-cell-input, textarea');
    if (input) input.focus();
  });
}

function insertNotebookCellRelative(targetCell, kind, position = 'after') {
  if (!targetCell || !targetCell.parentNode) return null;
  const cell = buildCell(createManualNotebookCellModel(kind));
  if (position === 'before') {
    targetCell.parentNode.insertBefore(cell, targetCell);
  } else {
    targetCell.parentNode.insertBefore(cell, targetCell.nextSibling);
  }
  focusNotebookCell(cell);
  scheduleNotebookSessionPersist();
  return cell;
}

function addManualNotebookCell(kind) {
  const cellsDiv = ensureNotebookTailEntry();
  if (!cellsDiv) return;

  const cell = buildCell(createManualNotebookCellModel(kind));
  cellsDiv.appendChild(cell);

  const panels = document.getElementById('dashboard-panels');
  if (panels) panels.scrollTop = panels.scrollHeight;
  focusNotebookCell(cell);
  scheduleNotebookSessionPersist();
}

function updateNotebookComposerVisibility() {
  const panel = document.getElementById('notebook-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', settings.notebookMode === false);
  updateNotebookKernelToolbar();
}

function normalizeNotebookKernelState(value) {
  const stateValue = String(value || '').trim().toLowerCase();
  if (['cold', 'starting', 'idle', 'busy', 'dead', 'error'].includes(stateValue)) {
    return stateValue;
  }
  return 'cold';
}

function getNotebookKernelLabel(kernelState) {
  switch (kernelState) {
    case 'starting':
      return 'kernel starting';
    case 'idle':
      return 'kernel idle';
    case 'busy':
      return 'kernel busy';
    case 'dead':
      return 'kernel offline';
    case 'error':
      return 'kernel error';
    default:
      return 'kernel cold';
  }
}

function setNotebookKernelStatus(nextStatus = {}) {
  const merged = {
    ...(state.kernelStatus || {}),
    ...(nextStatus || {}),
  };
  merged.state = normalizeNotebookKernelState(merged.state);
  state.kernelStatus = merged;
  updateNotebookKernelToolbar();
}

function updateNotebookKernelToolbar() {
  const bar = document.getElementById('notebook-kernel-toolbar');
  const pill = document.getElementById('notebook-kernel-pill');
  const label = document.getElementById('notebook-kernel-status');
  const trailName = document.getElementById('notebook-trail-name');
  const interruptBtn = document.getElementById('notebook-kernel-interrupt-btn');
  const restartBtn = document.getElementById('notebook-kernel-restart-btn');
  if (!pill || !label || !trailName) return;

  const notebookHidden = settings.notebookMode === false;
  if (bar) bar.classList.toggle('hidden', notebookHidden);
  if (notebookHidden) return;

  const kernelState = normalizeNotebookKernelState((state.kernelStatus || {}).state);
  pill.className = `notebook-kernel-pill kernel-${kernelState}`;
  label.textContent = getNotebookKernelLabel(kernelState);
  trailName.textContent = state.activeTrailName || '--';

  if (interruptBtn) interruptBtn.disabled = kernelState !== 'busy';
  if (restartBtn) restartBtn.disabled = kernelState === 'starting';
}

function requestNotebookKernelStatus() {
  vscode.postMessage({
    type: 'getKernelStatus',
    trailId: state.activeTrailId || '',
    language: 'python',
  });
}

function addChatEntry(question, answerText, diffs, isError, executedCells, options = {}) {
  const log = document.getElementById('agent-chat-log');
  if (!log) return;

  if (_typingTimer) { clearInterval(_typingTimer); _typingTimer = null; }
  log.querySelectorAll('.typing-cursor').forEach(c => c.remove());

  // Auto-collapse previous entries
  log.querySelectorAll('.nb-entry:not(.nb-collapsed)').forEach(prev => {
    prev.classList.add('nb-collapsed');
    const tog = prev.querySelector('.nb-entry-toggle');
    if (tog) tog.innerHTML = ICON_EXPAND;
  });

  // ── Create notebook entry ──────────────────────────
  const entry = document.createElement('div');
  entry.className = 'nb-entry' + (isError ? ' nb-entry-error' : '');
  entry.dataset.entryId = options.entryId || createNotebookEntityId('entry');
  entry.dataset.timestamp = options.timestamp || new Date().toISOString();

  // Prompt cell (always visible)
  const promptCell = document.createElement('div');
  promptCell.className = 'nb-prompt-cell';
  promptCell.innerHTML = `<span class="nb-prompt-label">&gt;</span> <span class="nb-prompt-text">${escapeHtml(question)}</span><span class="nb-entry-actions"><span class="nb-entry-toggle" title="Collapse">${ICON_COLLAPSE}</span><button class="nb-entry-dismiss" title="Remove">${CELL_CLOSE_SVG}</button></span>`;
  entry.appendChild(promptCell);

  promptCell.querySelector('.nb-entry-dismiss').addEventListener('click', () => {
    entry.remove();
    if (!log.querySelectorAll('.nb-entry').length) log.classList.add('hidden');
    if (!options.skipPersist) flushNotebookSessionPersist();
  });
  promptCell.querySelector('.nb-entry-toggle').addEventListener('click', function() {
    entry.classList.toggle('nb-collapsed');
    this.innerHTML = entry.classList.contains('nb-collapsed') ? ICON_EXPAND : ICON_COLLAPSE;
  });

  // Answer cells container
  const cellsDiv = document.createElement('div');
  cellsDiv.className = 'nb-cells';
  entry.appendChild(cellsDiv);

  // Append entry to log
  log.appendChild(entry);
  log.classList.remove('hidden');
  const panels = document.getElementById('dashboard-panels');
  if (panels) panels.scrollTop = panels.scrollHeight;

  // ── Render cells ───────────────────────────────────
  const text = answerText || '';
  const cellModels = Array.isArray(options.cells)
    ? normalizeNotebookCellsForRender(mergeAdjacentMarkdownCells(options.cells))
    : buildNotebookCellModels(text, executedCells, diffs);

  if (isError) {
    renderNotebookCells(cellsDiv, cellModels);
    if (!options.skipPersist) scheduleNotebookSessionPersist();
    return;
  }

  const hasRichContent = /```\w*\n[\s\S]*?```/.test(text) ||
    /IMG:[A-Za-z0-9+/=]{20,}/.test(text) ||
    (executedCells && executedCells.length > 0) ||
    /^(?:import |from \w+ import )/m.test(text);

  if (options.instant || hasRichContent || !text) {
    renderNotebookCells(cellsDiv, cellModels);
    if (!options.skipPersist) scheduleNotebookSessionPersist();
    return;
  }

  // Plain text: typing animation, then convert to cells
  const tempDiv = document.createElement('div');
  tempDiv.className = 'nb-typing';
  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  tempDiv.appendChild(cursor);
  cellsDiv.appendChild(tempDiv);

  let i = 0;
  const speed = Math.max(8, Math.min(25, 1200 / text.length));
  _typingTimer = setInterval(() => {
    if (i < text.length) {
      const chunk = text.slice(i, i + 3);
      cursor.insertAdjacentText('beforebegin', chunk);
      i += 3;
    } else {
      clearInterval(_typingTimer);
      _typingTimer = null;
      tempDiv.remove();
      renderNotebookCells(cellsDiv, cellModels);
      if (!options.skipPersist) scheduleNotebookSessionPersist();
    }
  }, speed);
}

function wireLinks(container) {
  container.querySelectorAll('a[href]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const url = a.getAttribute('href');
      if (url && /^https?:\/\//.test(url)) {
        vscode.postMessage({ type: 'openUrl', url });
      }
    });
  });
}

// ── Agent prompt execution ──────────────────────────────────
function _executeAgentPrompt(prompt) {
  if (!state.files.length) {
    setAgentBusy(false);
    toast('No configs loaded', 'error');
    return;
  }
  vscode.postMessage({
    type: 'janeSessionRun',
    prompt,
    pendingEdits: buildPendingEdits(),
    dashboardState: buildDashboardState(),
    modelId: state.agentModelId,
  });
}

function runAgentPrompt() {
  // If agent is running, abort
  if (_agentRunning) {
    vscode.postMessage({ type: 'abortAgent' });
    setAgentBusy(false);
    addChatEntry(state._lastQuestion || '...', 'Aborted by user.', null, true);
    return;
  }

  const input  = document.getElementById('agent-input');
  const prompt = (input ? input.value : '').trim();
  if (!prompt) return;
  if (!state.files.length) { toast('No config files found', 'error'); return; }

  setAgentBusy(true);
  state._lastQuestion = prompt;
  // Keep query visible but grayed out while thinking
  input.classList.add('agent-thinking');

  const missing = state.files.filter(f => !state.configs[f]);
  if (missing.length === 0) {
    _executeAgentPrompt(prompt);
    return;
  }
  state._agentPending = { prompt, awaiting: new Set(missing) };
  for (const f of missing) vscode.postMessage({ type: 'readConfig', filename: f });
}
