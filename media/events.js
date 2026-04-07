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
  state.configs[file].dirty = true;
  if (isNum) syncSlider(fid, typeof value === 'number' ? value : NaN);
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function onToggle(fid, checked) {
  const { path, file } = state.fieldMap[fid];
  setNestedValue(state.configs[file].current, path, checked);
  state.configs[file].dirty = true;
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function convertNull(fid) {
  const { path, file } = state.fieldMap[fid];
  setNestedValue(state.configs[file].current, path, '');
  state.configs[file].dirty = true;
  state.fieldMap[fid].type = 'str';
  renderEditor();
  updateButtons();
  renderTabs();
}

function onArrayItemInput(fid, index, value) {
  const { path, file } = state.fieldMap[fid];
  const arr = getNestedValue(state.configs[file].current, path);
  arr[index] = value;
  state.configs[file].dirty = true;
  refreshFieldState(fid);
  updateButtons();
  renderTabs();
}

function removeArrayItem(fid, index) {
  const { path, file } = state.fieldMap[fid];
  getNestedValue(state.configs[file].current, path).splice(index, 1);
  state.configs[file].dirty = true;
  renderEditor(); updateButtons(); renderTabs();
}

function addArrayItem(fid) {
  const { path, file } = state.fieldMap[fid];
  getNestedValue(state.configs[file].current, path).push('');
  state.configs[file].dirty = true;
  renderEditor(); updateButtons(); renderTabs();
}

function resetField(fid) {
  const { path, file } = state.fieldMap[fid];
  const origValue = getNestedValue(state.configs[file].original, path);
  setNestedValue(state.configs[file].current, path, deepClone(origValue));
  // Recompute dirty flag — could still be dirty from other field changes
  state.configs[file].dirty = JSON.stringify(state.configs[file].original) !== JSON.stringify(state.configs[file].current);
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
  config.dirty = false;
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

  // Select first file as active if none set
  const requestedActive = dashboard.activeConfigFile || dashboard.activeDataFile || null;
  state.activeFile = requestedActive && state.files.includes(requestedActive)
    ? requestedActive
    : (state.files[0] || null);
  state.activeConfigFile = state.activeFile;
  state.activeDataFile = null;

  updateTokenDisplay();
  const prev = vscode.getState() || {};
  vscode.setState({ ...prev, pinned: state.pinned });
}

function rebuildChatLogFromSession(options = {}) {
  // Flush pending DOM edits before rebuilding — but only when the rebuild
  // is user-initiated (task switch, manual refresh). When the rebuild is
  // triggered by janeSessionSync (external MCP write), the disk state is
  // authoritative and a flush would overwrite it with stale DOM content.
  if (!options.external) {
    if (_persistNotebookTimer) {
      clearTimeout(_persistNotebookTimer);
      _persistNotebookTimer = null;
    }
    const wasRunning = _agentRunning;
    _agentRunning = false;
    persistNotebookSessionEntries();
    _agentRunning = wasRunning;
  } else if (_persistNotebookTimer) {
    clearTimeout(_persistNotebookTimer);
    _persistNotebookTimer = null;
  }

  _pythonCellCounter = 0;
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
  renderTabs();
  renderEditors();
  renderPinnedBar();
  updateButtons();
  updateAgentModelLabel();
}

function updateTaskControls() {
  // Task controls are now managed via the task graph canvas
}

function applyTaskStatePayload(tasks, activeTask) {
  state.tasks = Array.isArray(tasks) ? tasks.slice() : [];
  state.activeTaskId = activeTask && activeTask.id ? activeTask.id : '';
  state.activeTaskName = activeTask && activeTask.name ? activeTask.name : '';
  state.activeTaskPath = activeTask && activeTask.path ? activeTask.path : '';
  updateTaskControls();
  renderTaskGraph();
}

// ── Task graph (interactive canvas) ─────────────────────
let _taskGraphHover = null;
let _projectNodeSelected = false;
let _dragNode = null;       // { type: 'project'|'task', id?, offsetX, offsetY }
const _userPositions = {};  // taskId → { x, y } — persists user-dragged positions
let _projectUserPos = null; // { x, y } — persists dragged project node position

function renderTaskGraph() {
  const canvas = document.getElementById('task-graph');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const tasks = Array.isArray(state.tasks) ? state.tasks : [];

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#4ec080';
  const text0 = style.getPropertyValue('--text-0').trim() || '#e6e6e6';
  const text2 = style.getPropertyValue('--text-2').trim() || '#666';
  const border = style.getPropertyValue('--border').trim() || '#333';
  const bg1 = style.getPropertyValue('--bg-1').trim() || '#111';
  const fontSystem = style.getPropertyValue('--font-system').trim() || 'sans-serif';

  // Project node at center-left (use dragged position if available)
  const folderName = (state.configDir || '').split('/').pop() || 'Project';
  const projectX = _projectUserPos ? _projectUserPos.x : 60;
  const projectY = _projectUserPos ? _projectUserPos.y : H / 2;

  // Layout task nodes in a vertical spread to the right of the project
  const nodes = [];
  const taskStartX = 180;
  const spacing = Math.min(40, (H - 40) / Math.max(tasks.length, 1));
  const startY = H / 2 - ((tasks.length - 1) * spacing) / 2;

  // Build parent→children map for fork offsets
  const childrenOf = {};
  for (const task of tasks) {
    const pid = task.parentTaskId || '';
    if (pid) {
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(task.id);
    }
  }

  // Position nodes in two passes: roots first, then forks (so parents exist before children)
  const nodeMap = {};
  const parentIds = new Set(tasks.filter(t => t.parentTaskId).map(t => t.parentTaskId));
  const rootTasks = tasks.filter(t => !t.parentTaskId || !parentIds.has(t.parentTaskId) && !tasks.some(p => p.id === t.parentTaskId));
  const forkTasks = tasks.filter(t => t.parentTaskId && tasks.some(p => p.id === t.parentTaskId));

  // Pass 1: place root tasks (no parent or parent not in task list)
  let yIdx = 0;
  for (const task of rootTasks) {
    const x = taskStartX;
    const y = startY + yIdx * spacing;
    yIdx++;
    const node = { id: task.id, name: task.name || 'Task', x, y, task, isFork: false };
    nodes.push(node);
    nodeMap[task.id] = node;
  }

  // Pass 2: place forks with repulsion (parent guaranteed to be positioned)
  const forkSpacing = Math.max(spacing, 30); // minimum 30px between fork siblings
  const placeForks = (parentList) => {
    for (const task of parentList) {
      if (nodeMap[task.id]) continue;
      const parent = nodeMap[task.parentTaskId];
      if (!parent) continue;
      const siblings = childrenOf[task.parentTaskId] || [];
      const sibIdx = siblings.indexOf(task.id);
      const x = parent.x + 100;
      const y = parent.y + (sibIdx - (siblings.length - 1) / 2) * forkSpacing;
      const node = { id: task.id, name: task.name || 'Task', x, y, task, isFork: true };
      nodes.push(node);
      nodeMap[task.id] = node;
    }
  };
  // Iterate until all forks are placed (handles multi-level forks)
  for (let pass = 0; pass < 5 && forkTasks.some(t => !nodeMap[t.id]); pass++) {
    placeForks(forkTasks);
  }

  // Apply user-dragged positions (overrides auto-layout)
  for (const node of nodes) {
    const pos = _userPositions[node.id];
    if (pos) { node.x = pos.x; node.y = pos.y; }
  }

  // Draw edges
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = border;
  for (const node of nodes) {
    if (node.isFork && nodeMap[node.task.parentTaskId]) {
      // Fork edge: parent → child
      const parent = nodeMap[node.task.parentTaskId];
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.lineTo(node.x, node.y);
      ctx.stroke();
    } else {
      // Root edge: project → task
      ctx.beginPath();
      ctx.moveTo(projectX, projectY);
      ctx.lineTo(node.x, node.y);
      ctx.stroke();
    }
  }

  // Draw project node
  const projectRadius = 14;
  ctx.beginPath();
  ctx.arc(projectX, projectY, projectRadius, 0, Math.PI * 2);
  ctx.fillStyle = _projectNodeSelected ? accent : bg1;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = _projectNodeSelected ? 3 : 2;
  ctx.stroke();
  // Name below project node
  ctx.fillStyle = accent;
  ctx.font = `600 9px ${fontSystem}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(folderName, projectX, projectY + projectRadius + 4);

  // Draw task nodes
  const nodeRadius = 6;
  for (const node of nodes) {
    const isActive = node.id === state.activeTaskId;
    const isHovered = _taskGraphHover === node.id;

    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius + (isHovered ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = isActive ? accent : bg1;
    ctx.fill();
    ctx.strokeStyle = isActive ? accent : (isHovered ? text0 : border);
    ctx.lineWidth = isActive ? 2.5 : 1.5;
    ctx.stroke();

    // Name below node
    ctx.fillStyle = isActive ? accent : text2;
    ctx.font = `400 9px ${fontSystem}`;
    ctx.fillText(node.name, node.x, node.y + nodeRadius + 10);

    // Entry count badge
    if (node.task.entryCount > 0) {
      ctx.fillStyle = text2;
      ctx.font = `400 8px ${fontSystem}`;
      ctx.fillText(`${node.task.entryCount} entries`, node.x, node.y + nodeRadius + 20);
    }
  }

  // Store nodes for hit testing
  canvas._taskNodes = nodes;
  canvas._projectNode = { x: projectX, y: projectY, radius: projectRadius };
}

function taskGraphHitTest(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const nodes = canvas._taskNodes || [];
  for (const node of nodes) {
    const dx = x - node.x;
    const dy = y - node.y;
    if (dx * dx + dy * dy <= 12 * 12) return node;
  }
  return null;
}

function taskGraphProjectHitTest(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const pn = canvas._projectNode;
  if (!pn) return false;
  const dx = x - pn.x;
  const dy = y - pn.y;
  return dx * dx + dy * dy <= pn.radius * pn.radius;
}

function showNewTaskPopup(canvas) {
  // Remove existing popup if any
  const existing = document.getElementById('task-graph-popup');
  if (existing) existing.remove();

  const rect = canvas.getBoundingClientRect();
  const pn = canvas._projectNode || { x: 60, y: 100 };
  const popup = document.createElement('div');
  popup.id = 'task-graph-popup';
  popup.className = 'task-graph-popup';
  popup.style.left = (rect.left + pn.x - 60) + 'px';
  popup.style.top = (rect.top + pn.y + pn.radius + 8) + 'px';
  popup.innerHTML =
    `<button class="task-graph-popup-add">+ add research task</button>` +
    `<input type="text" class="task-graph-popup-input" placeholder="Task name (leave empty for auto)" spellcheck="false">`;
  document.body.appendChild(popup);

  const addBtn = popup.querySelector('.task-graph-popup-add');
  const nameInput = popup.querySelector('.task-graph-popup-input');

  function createTask() {
    const name = nameInput.value.trim();
    vscode.postMessage({ type: 'janeTaskNew', name });
    popup.remove();
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    nameInput.classList.toggle('hidden');
    if (!nameInput.classList.contains('hidden')) {
      nameInput.focus();
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      createTask();
    }
    if (e.key === 'Escape') {
      popup.remove();
    }
  });

  // Dismiss on outside click (delayed to avoid immediate dismiss)
  setTimeout(() => {
    const dismiss = (e) => {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.removeEventListener('click', dismiss);
    document.addEventListener('click', dismiss);
  }, 0);

  nameInput.focus();
}

function showTaskInfoPopup(canvas, node) {
  const existing = document.getElementById('task-graph-popup');
  if (existing) existing.remove();

  const rect = canvas.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'task-graph-popup';
  popup.className = 'task-graph-popup';
  popup.style.left = (rect.left + node.x - 80) + 'px';
  popup.style.top = (rect.top + node.y + 18) + 'px';

  const entries = node.task.entryCount || 0;
  const updated = node.task.updatedAt ? new Date(node.task.updatedAt).toLocaleString() : '';
  const status = node.task.bootstrapDone ? 'bootstrapped' : 'needs bootstrap';
  const lastQ = node.task.lastQuestion ? node.task.lastQuestion.slice(0, 60) + (node.task.lastQuestion.length > 60 ? '…' : '') : '—';

  popup.innerHTML =
    `<div class="task-graph-popup-info">` +
    `<div class="task-info-name">${escapeHtml(node.name)}</div>` +
    `<div class="task-info-detail">${status} · ${entries} entries</div>` +
    `<div class="task-info-detail">${updated ? 'updated ' + updated : ''}</div>` +
    `<div class="task-info-lastq">last: ${escapeHtml(lastQ)}</div>` +
    `</div>`;
  document.body.appendChild(popup);

  setTimeout(() => {
    const dismiss = (e) => {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
  }, 0);
}

function showTaskContextMenu(_canvas, node, clientX, clientY) {
  const existing = document.getElementById('task-graph-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'task-graph-popup';
  popup.className = 'task-graph-popup';
  popup.style.left = clientX + 'px';
  popup.style.top = clientY + 'px';

  const FORK_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 3h4a3 3 0 0 1 3 3v1"/><path d="M6 13h4a3 3 0 0 0 3-3v-1"/><circle cx="4" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><circle cx="14" cy="8" r="2"/></svg>`;
  const TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5.5 4V2.5a1 1 0 011-1h3a1 1 0 011 1V4"/><path d="M3.5 4v9a1.5 1.5 0 001.5 1.5h6a1.5 1.5 0 001.5-1.5V4"/></svg>`;

  const RENAME_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z"/></svg>`;

  popup.innerHTML =
    `<div class="task-ctx-rename-row">` +
    `<span class="task-ctx-rename-icon">${RENAME_SVG}</span>` +
    `<input type="text" class="task-ctx-rename-input" value="${escapeHtml(node.name)}" spellcheck="false">` +
    `</div>` +
    `<button class="task-graph-popup-add task-ctx-fork">${FORK_SVG} fork task</button>` +
    `<input type="text" class="task-graph-popup-input hidden" placeholder="Fork name (leave empty for auto)" spellcheck="false">` +
    `<button class="task-graph-popup-delete task-ctx-delete">${TRASH_SVG} delete task</button>`;
  document.body.appendChild(popup);

  const renameInput = popup.querySelector('.task-ctx-rename-input');
  const forkBtn = popup.querySelector('.task-ctx-fork');
  const nameInput = popup.querySelector('.task-graph-popup-input');
  const deleteBtn = popup.querySelector('.task-ctx-delete');

  // Rename on Enter
  renameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const newName = renameInput.value.trim();
      if (newName && newName !== node.name) {
        vscode.postMessage({ type: 'janeTaskRename', taskId: node.id, name: newName });
      }
      popup.remove();
    }
    if (e.key === 'Escape') {
      popup.remove();
    }
  });
  renameInput.focus();
  renameInput.select();

  forkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    nameInput.classList.toggle('hidden');
    if (!nameInput.classList.contains('hidden')) {
      nameInput.focus();
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = nameInput.value.trim();
      vscode.postMessage({ type: 'janeTaskFork', name, sourceTaskId: node.id });
      popup.remove();
    }
    if (e.key === 'Escape') {
      popup.remove();
    }
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.remove();
    showDeleteTaskConfirmation(node);
  });

  setTimeout(() => {
    const dismiss = (e) => {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
  }, 0);
}

function showDeleteTaskConfirmation(node) {
  const existing = document.getElementById('task-delete-confirm');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'task-delete-confirm';
  overlay.className = 'task-delete-overlay';
  overlay.innerHTML =
    `<div class="task-delete-dialog">` +
    `<div class="task-delete-message">Are you sure you want to delete task<br><strong>${escapeHtml(node.name)}</strong>?</div>` +
    `<div class="task-delete-hint">This will delete the task and any downstream forks.</div>` +
    `<div class="task-delete-actions">` +
    `<button class="btn task-delete-yes">Yes</button>` +
    `<button class="btn task-delete-no">No</button>` +
    `</div></div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.task-delete-yes').addEventListener('click', () => {
    vscode.postMessage({ type: 'janeTaskDelete', taskId: node.id });
    overlay.remove();
  });
  overlay.querySelector('.task-delete-no').addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// Wire canvas interactions
(function initTaskGraph() {
  const canvas = document.getElementById('task-graph');
  if (!canvas) return;

  let _dragStartX = 0, _dragStartY = 0, _didDrag = false;

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    _didDrag = false;
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;

    // Check project node
    const pn = canvas._projectNode;
    if (pn) {
      const dx = mx - pn.x, dy = my - pn.y;
      if (dx * dx + dy * dy <= pn.radius * pn.radius) {
        _dragNode = { type: 'project', offsetX: dx, offsetY: dy };
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
    // Check task nodes
    const nodes = canvas._taskNodes || [];
    for (const node of nodes) {
      const dx = mx - node.x, dy = my - node.y;
      if (dx * dx + dy * dy <= 12 * 12) {
        _dragNode = { type: 'task', id: node.id, offsetX: dx, offsetY: dy };
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (_dragNode) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const dist = Math.abs(e.clientX - _dragStartX) + Math.abs(e.clientY - _dragStartY);
      if (dist > 3) _didDrag = true;

      if (_dragNode.type === 'project') {
        _projectUserPos = { x: mx - _dragNode.offsetX, y: my - _dragNode.offsetY };
      } else {
        _userPositions[_dragNode.id] = { x: mx - _dragNode.offsetX, y: my - _dragNode.offsetY };
      }
      renderTaskGraph();
      return;
    }

    // Hover detection (no drag)
    const isProject = taskGraphProjectHitTest(canvas, e.clientX, e.clientY);
    const node = isProject ? null : taskGraphHitTest(canvas, e.clientX, e.clientY);
    const hoverId = node ? node.id : null;
    const showPointer = isProject || hoverId;
    if (hoverId !== _taskGraphHover || (isProject && !_taskGraphHover)) {
      _taskGraphHover = hoverId;
      canvas.style.cursor = showPointer ? 'grab' : 'default';
      renderTaskGraph();
    }
  });

  canvas.addEventListener('mouseup', () => {
    const wasDragging = !!_dragNode;
    const dragType = _dragNode ? _dragNode.type : null;
    const dragId = _dragNode ? _dragNode.id : null;
    _dragNode = null;
    canvas.style.cursor = 'default';

    // If it was a click (not a drag), handle click actions
    if (!_didDrag) {
      if (wasDragging && dragType === 'project') {
        _projectNodeSelected = !_projectNodeSelected;
        const promptPanel = document.getElementById('project-prompt-panel');
        if (promptPanel) promptPanel.classList.toggle('hidden', !_projectNodeSelected);
        renderTaskGraph();
        return;
      }
      if (wasDragging && dragType === 'task') {
        if (dragId !== state.activeTaskId) {
          vscode.postMessage({ type: 'janeTaskSwitch', taskId: dragId });
        } else {
          const node = (canvas._taskNodes || []).find(n => n.id === dragId);
          if (node) showTaskInfoPopup(canvas, node);
        }
        return;
      }
    }
  });

  canvas.addEventListener('mouseleave', () => {
    _dragNode = null;
    if (_taskGraphHover) {
      _taskGraphHover = null;
      canvas.style.cursor = 'default';
      renderTaskGraph();
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    // Right-click project node → new task popup
    if (taskGraphProjectHitTest(canvas, e.clientX, e.clientY)) {
      e.preventDefault();
      showNewTaskPopup(canvas);
      return;
    }
    const node = taskGraphHitTest(canvas, e.clientX, e.clientY);
    if (node) {
      e.preventDefault();
      showTaskContextMenu(canvas, node, e.clientX, e.clientY);
      return;
    }
    if (taskGraphProjectHitTest(canvas, e.clientX, e.clientY)) {
      e.preventDefault();
    }
  });

  // Redraw on resize
  const ro = new ResizeObserver(() => renderTaskGraph());
  ro.observe(canvas);
})();

function resetLoadedConfigDrafts() {
  for (const config of Object.values(state.configs)) {
    if (!config) continue;
    config.current = deepClone(config.original);
    config.dirty = false;
  }
}

function finalizeHydratedSession() {
  if (state._bootstrapRestore && !state._bootstrapRestored) {
    const ops = state._bootstrapRestore.ops || [];
    if (ops.length > 0) executeOps(ops);
    state._bootstrapRestored = true;
    if (!state.activeFile || !state.files.includes(state.activeFile)) {
      state.activeFile = state.files[0] || null;
      state.activeConfigFile = state.activeFile;
    }
    renderTabs();
    renderEditors();
    renderPinnedBar();
    updateButtons();
  } else {
    _triggerBootstrap();
  }
}

function hydrateTaskSession(session, options = {}) {
  if (options.resetLoadedConfigs) resetLoadedConfigDrafts();
  state._pendingExternalDrafts = new Map();
  state._appliedExternalDraftIds = new Set();
  state._agentPending = null;
  applySessionSnapshot(session || {});
  queueExternalDrafts((session || {}).pendingExternalDrafts || []);
  // Disk state is authoritative on hydration — don't flush the (possibly empty) DOM
  rebuildChatLogFromSession({ external: true });

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

  if (!state.activeFile || !state.files.includes(state.activeFile)) {
    state.activeFile = state.files[0] || null;
    state.activeConfigFile = state.activeFile;
  }
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
  // Clear any pending persist timer from user edits during the agent turn —
  // the agent already persisted its entry on the extension side, and we're
  // about to add it to the DOM and persist the full state afterwards.
  if (_persistNotebookTimer) {
    clearTimeout(_persistNotebookTimer);
    _persistNotebookTimer = null;
  }
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
      // Restore task instructions and bitácora
      const instrEditor = document.getElementById('sysprompt-editor');
      if (instrEditor) instrEditor.value = msg.additionalInstructions || '';
      const bitacoraDisplay = document.getElementById('bitacora-display');
      if (bitacoraDisplay) bitacoraDisplay.innerHTML = renderMarkdownLatex(msg.bitacora || '*(No bitácora yet)*');
      const ppEditor = document.getElementById('project-prompt-editor');
      if (ppEditor) ppEditor.value = msg.projectPrompt || '';
      const session = msg.session || {};
      applyTaskStatePayload(msg.tasks || [], msg.activeTask || null);
      state.availableCodingAgents = Array.isArray(msg.codingAgents) ? msg.codingAgents.slice() : [];
      updateCodingAgentControls(msg.defaultCodingAgentId || '');
      hydrateTaskSession(session);
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
        dirty: false,
      };
      // All files are editable — no auto-lock
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
        state.activeConfigFile = msg.filename;
        renderTabs();
        renderEditors();
        updateButtons();
        updateAgentModelLabel();
      }
      break;
    }
    case 'filesUpdated': {
      // New or deleted YAML files detected by the file watcher
      const newFiles = msg.files || [];
      const added = newFiles.filter(f => !state.files.includes(f));
      const removed = state.files.filter(f => !newFiles.includes(f));
      state.files = newFiles;
      // Clean up removed files
      for (const f of removed) {
        delete state.configs[f];
        delete state.fileTypes[f];
      }
      // Request data for new files
      for (const f of added) {
        vscode.postMessage({ type: 'readConfig', filename: f });
      }
      if (added.length || removed.length) {
        renderTabs();
        renderEditors();
        if (added.length) toast(added.length + ' new file' + (added.length > 1 ? 's' : '') + ' detected', 'info');
      }
      break;
    }
    case 'writeResult': {
      const saveBtn = document.getElementById('save-btn');
      if (msg.success) {
        const config = state.configs[msg.filename];
        if (config) { config.original = deepClone(config.current); config.dirty = false; }
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
      const taskState = msg.taskState || {};
      const nextTaskId = taskState.activeTask && taskState.activeTask.id ? taskState.activeTask.id : '';
      const taskChanged = !!(nextTaskId && nextTaskId !== state.activeTaskId);
      applyTaskStatePayload(taskState.tasks || [], taskState.activeTask || null);
      // Refresh bitácora display
      const syncSession = msg.session || {};
      const bd = document.getElementById('bitacora-display');
      if (bd) bd.innerHTML = renderMarkdownLatex(syncSession.bitacora || '*(No bitácora yet)*');
      if (taskChanged) {
        hydrateTaskSession(syncSession, { resetLoadedConfigs: true });
        const ie = document.getElementById('sysprompt-editor');
        if (ie) ie.value = syncSession.additionalInstructions || '';
        requestNotebookKernelStatus();
        break;
      }
      // Check if entries changed BEFORE applying the snapshot
      const diskEntryCount = Array.isArray(syncSession.entries) ? syncSession.entries.length : 0;
      const domEntryCount = (state.sessionEntries || []).length;
      const diskLastId = diskEntryCount > 0 ? (syncSession.entries[diskEntryCount - 1].id || '') : '';
      const domLastId = domEntryCount > 0 ? (state.sessionEntries[domEntryCount - 1].id || '') : '';
      const entriesChanged = diskEntryCount !== domEntryCount || diskLastId !== domLastId;
      applySessionSnapshot(syncSession);
      queueExternalDrafts(syncSession.pendingExternalDrafts || []);
      if (entriesChanged) {
        rebuildChatLogFromSession({ external: true });
      }
      renderDashboardFromSession();
      applyPendingExternalDrafts();
      requestNotebookKernelStatus();
      break;
    }
    case 'taskState': {
      applyTaskStatePayload(msg.tasks || [], msg.activeTask || null);
      updateCodingAgentControls();
      const taskSession = msg.session || {};
      hydrateTaskSession(taskSession, { resetLoadedConfigs: true });
      // Update bitácora and task instructions for the new/switched task
      const bdEl = document.getElementById('bitacora-display');
      if (bdEl) bdEl.innerHTML = renderMarkdownLatex(taskSession.bitacora || '*(No bitácora yet)*');
      const ieEl = document.getElementById('sysprompt-editor');
      if (ieEl) ieEl.value = taskSession.additionalInstructions || '';
      updateSyspromptSparks();
      const verb = msg.action === 'new'
        ? 'Started'
        : (msg.action === 'fork'
          ? 'Forked to'
          : (msg.action === 'rename' ? 'Renamed to' : 'Switched to'));
      toast(`${verb} ${state.activeTaskName || 'Task'}`, 'success');
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
    case 'exportNotebookResult': {
      if (msg.ok) {
        toast('Exported ' + (msg.filename || 'notebook'), 'success');
      } else if (msg.error) {
        toast('Export failed: ' + msg.error, 'error');
      }
      break;
    }
    case 'exportProjectResult': {
      if (msg.ok) {
        toast('Project exported to ' + (msg.filename || 'report.html'), 'success');
      } else if (msg.error) {
        toast('Project export failed: ' + msg.error, 'error');
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
  const isActive = filename === state.activeFile;
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
  state.configs[file].dirty = true;
  const mod = !valEqual(val, getNestedValue(state.configs[file].original, path));
  t.classList.toggle('pin-modified', mod);
  t.closest('.pin-row').classList.toggle('pin-modified', mod);
  if (file === state.activeFile) {
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
    state.configs[file].dirty = true;
    if (file === state.activeFile) {
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
document.getElementById('set-system-font').addEventListener('change', onSettingChange);
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

document.getElementById('save-defaults-btn').addEventListener('click', saveAsUserDefault);
document.getElementById('reset-defaults-btn').addEventListener('click', resetToFactoryDefault);

let _searchTimer = null;
document.getElementById('search').addEventListener('input', () => {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(applySearch, 150);
});

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
const taskSelectEl = document.getElementById('task-select');
if (taskSelectEl) {
  taskSelectEl.addEventListener('change', e => {
    const taskId = e.target.value || '';
    if (!taskId || taskId === state.activeTaskId) return;
    vscode.postMessage({ type: 'janeTaskSwitch', taskId });
  });
}
function getTaskPanelName(mode) {
  const input = document.getElementById('task-name-input');
  const raw = input ? input.value.trim() : '';
  if (mode === 'rename') return raw;
  return raw && raw !== String(state.activeTaskName || '').trim() ? raw : '';
}
const taskRenameBtn = document.getElementById('task-rename-btn');
if (taskRenameBtn) {
  taskRenameBtn.addEventListener('click', () => {
    const name = getTaskPanelName('rename');
    if (!name) {
      toast('Enter a Task name first', 'error');
      return;
    }
    if (name === String(state.activeTaskName || '').trim()) {
      toast('Task name is already up to date', 'success');
      return;
    }
    vscode.postMessage({
      type: 'janeTaskRename',
      taskId: state.activeTaskId || '',
      name,
    });
  });
}
const taskNewBtn = document.getElementById('task-new-btn');
if (taskNewBtn) {
  taskNewBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'janeTaskNew', name: getTaskPanelName('new') });
  });
}
const taskForkBtn = document.getElementById('task-fork-btn');
if (taskForkBtn) {
  taskForkBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'janeTaskFork',
      name: getTaskPanelName('fork'),
      sourceTaskId: state.activeTaskId || '',
    });
  });
}

// ── Project prompt (workspace-wide) ──────────────────────
const projectPromptEditor = document.getElementById('project-prompt-editor');
if (projectPromptEditor) {
  projectPromptEditor.addEventListener('input', () => {
    vscode.postMessage({ type: 'saveProjectPrompt', text: projectPromptEditor.value });
  });
}
const projectPromptResetBtn = document.getElementById('project-prompt-reset');
if (projectPromptResetBtn) {
  projectPromptResetBtn.addEventListener('click', () => {
    if (projectPromptEditor) projectPromptEditor.value = '';
    vscode.postMessage({ type: 'saveProjectPrompt', text: '' });
  });
}

// ── Task instructions ──────────────────────────────
const syspromptResetBtn = document.getElementById('sysprompt-reset');
if (syspromptResetBtn) {
  syspromptResetBtn.addEventListener('click', () => {
    const editor = document.getElementById('sysprompt-editor');
    if (editor) editor.value = '';
    vscode.postMessage({ type: 'janeSessionSetInstructions', text: '' });
  });
}

const syspromptEditor = document.getElementById('sysprompt-editor');
if (syspromptEditor) {
  syspromptEditor.addEventListener('input', () => {
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

const exportIpynbBtn = document.getElementById('export-ipynb-btn');
if (exportIpynbBtn) {
  exportIpynbBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportNotebook', format: 'ipynb' });
  });
}
const exportPyBtn = document.getElementById('export-py-btn');
if (exportPyBtn) {
  exportPyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportNotebook', format: 'py' });
  });
}
const exportProjectBtn = document.getElementById('export-project-btn');
if (exportProjectBtn) {
  exportProjectBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportProject' });
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
      taskId: state.activeTaskId || '',
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
      taskId: state.activeTaskId || '',
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
  const filesPanelTitle = document.getElementById('files-panel-title');
  if (filesPanelTitle) filesPanelTitle.innerHTML = YAML_ICON_SVG + ' files';
  document.getElementById('pinned-panel').classList.add('hidden');
  vscode.postMessage({ type: 'init' });
}

init();
