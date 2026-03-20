// ── File selection ─────────────────────────────────────────
function selectFile(filename) {
  if (!state.configs[filename]) {
    vscode.postMessage({ type: 'readConfig', filename });
    return;
  }
  state.activeFile = filename;
  const isData = state.fileTypes[filename] === 'data';
  if (isData) {
    if (state.activeDataFile === filename) { renderTabs(); return; } // already selected
    state.activeDataFile = filename;
    renderTabs();
    renderEditorInto('data-editor', filename);
  } else {
    if (state.activeConfigFile === filename) { renderTabs(); return; } // already selected
    state.activeConfigFile = filename;
    renderTabs();
    renderEditorInto('config-editor', filename);
  }
  updateButtons();
  updateAgentModelLabel();
}

// ── Tabs ───────────────────────────────────────────────────
function renderTabs() {
  const nav = document.getElementById('file-tabs');
  const dataNav = document.getElementById('data-tabs');

  const configFiles = state.files.filter(f => state.fileTypes[f] !== 'data');
  const dataFiles = state.files.filter(f => state.fileTypes[f] === 'data');

  const configPrefix = commonPrefix(configFiles.map(f => f.replace(/\.ya?ml$/, '')));
  nav.innerHTML = configFiles.map(f => {
    const isActive = f === state.activeConfigFile;
    const modified = state.configs[f] && isModified(f);
    let label = f.replace(/\.ya?ml$/, '').replace(/ /g, '_');
    if (configPrefix.length > 0) label = label.slice(configPrefix.length) || label;
    return `<button class="tab${isActive ? ' active' : ''}" data-filename="${escapeHtml(f)}">${escapeHtml(label)}${modified ? '<span class="dot"></span>' : ''}</button>`;
  }).join('');

  if (dataFiles.length > 0) {
    const dataPrefix = commonPrefix(dataFiles.map(f => f.replace(/\.ya?ml$/, '')));
    dataNav.innerHTML = dataFiles.map(f => {
      const isActive = f === state.activeDataFile;
      let label = f.replace(/\.ya?ml$/, '').replace(/ /g, '_');
      if (dataPrefix.length > 0) label = label.slice(dataPrefix.length) || label;
      return `<button class="tab${isActive ? ' active' : ''}" data-filename="${escapeHtml(f)}">${escapeHtml(label)}</button>`;
    }).join('');
  } else {
    dataNav.innerHTML = '';
  }
}

function isModified(filename) {
  const c = state.configs[filename];
  if (!c) return false;
  return !!c.dirty;
}

// ── Editor rendering ───────────────────────────────────────
function renderEditors() {
  // Fire pre-render hooks
  if (state.hooks) {
    for (const fn of (state.hooks.onBeforeRender || [])) {
      try { fn(); } catch { /* ignore hook errors */ }
    }
  }

  state.fieldMap = {};
  state.fieldCounter = 0;
  state.pathToFid = {};

  renderEditorInto('config-editor', state.activeConfigFile);
  renderEditorInto('data-editor', state.activeDataFile);

  const hasPinned = Object.values(state.pinned).some(paths => paths.length > 0);
  document.getElementById('pinned-panel').classList.toggle('hidden', !hasPinned);

  renderPinnedBar();
  applySectionHeights();
  refreshSectionDeepButtons();
  applySearch();

  // Apply fieldOverrides: hidden, style, readOnly
  if (state.hooks && state.hooks.fieldOverrides) {
    for (const [key, ovr] of Object.entries(state.hooks.fieldOverrides)) {
      const fid = state.pathToFid[key];
      if (!fid) continue;
      const el = document.querySelector(`[data-fid="${fid}"]`);
      if (!el) continue;
      if (ovr.hidden) el.style.display = 'none';
      if (ovr.style) Object.assign(el.style, ovr.style);
      if (ovr.readOnly) {
        const input = el.querySelector('.field-input');
        if (input) input.disabled = true;
      }
      if (ovr.label) {
        const keyEl = el.querySelector('.field-key');
        if (keyEl) keyEl.firstChild.textContent = ovr.label;
      }
    }
  }

  // Fire post-render hooks
  if (state.hooks) {
    for (const fn of (state.hooks.onAfterRender || [])) {
      try { fn(); } catch { /* ignore hook errors */ }
    }
  }
}

function getSectionPath(sectionEl) {
  const parts = [];
  let el = sectionEl;
  while (el && el.classList && el.classList.contains('section')) {
    const nameEl = el.querySelector(':scope > .section-header .section-name');
    if (nameEl) parts.unshift(nameEl.textContent);
    el = el.parentElement && el.parentElement.closest('.section');
  }
  return parts.join('/');
}

// Cache of expanded section paths per file
const _expandedCache = {};

function _saveExpansionState(main, filename) {
  if (!filename || !main) return;
  const paths = new Set();
  main.querySelectorAll('.section:not(.collapsed)').forEach(s => {
    paths.add(getSectionPath(s));
  });
  if (paths.size > 0) _expandedCache[filename] = paths;
}

function renderEditorInto(elementId, filename) {
  const main = document.getElementById(elementId);
  if (!main) return;
  const config = filename ? state.configs[filename] : null;
  if (!config) {
    const isData = elementId === 'data-editor';
    main.innerHTML = `<div class="empty-state"><p>${isData ? 'No data files were found' : 'No config files were found'}</p></div>`;
    return;
  }

  // Save current expansion state (for the file being replaced)
  const prevFile = main.dataset.currentFile;
  if (prevFile) _saveExpansionState(main, prevFile);
  main.dataset.currentFile = filename;

  // Use cached expansion state for the target file
  const expandedPaths = _expandedCache[filename] || new Set();

  state.renderingFile = filename;
  const footerHtml = `<div class="editor-footer">` +
    `<hr class="editor-footer-sep">` +
    `<div class="editor-footer-row">` +
      `<button class="editor-export-btn" data-action="export-json-file" data-filename="${escapeHtml(filename)}">{} Export as JSON</button>` +
    `</div>` +
  `</div>`;
  main.innerHTML = renderNode(config.current, config.original, []) + footerHtml;
  state.renderingFile = null;

  if (expandedPaths.size > 0) {
    main.querySelectorAll('.section').forEach(s => {
      if (expandedPaths.has(getSectionPath(s))) {
        s.classList.remove('collapsed');
      }
    });
  } else if (settings.autoExpand) {
    main.querySelectorAll('.section').forEach(s => s.classList.remove('collapsed'));
  } else {
    main.querySelectorAll(':scope > .section').forEach(s => s.classList.remove('collapsed'));
  }
}

function renderEditor() { renderEditors(); }

// ── Field registration ─────────────────────────────────────
function registerField(path, type) {
  const id = 'f' + (state.fieldCounter++);
  const file = state.renderingFile || state.activeFile;
  state.fieldMap[id] = { path: [...path], type, file };
  state.pathToFid[file + ':' + JSON.stringify(path)] = id;
  return id;
}

// ── Recursive node renderer ────────────────────────────────
function renderNode(value, original, path) {
  if (value === null || value === undefined) {
    return renderScalarField(path, value, original, 'null');
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] !== 'object' || value[0] === null) {
      return renderScalarArrayField(path, value, original);
    }
    return renderObjectArray(path, value, original);
  }
  if (typeof value === 'object') {
    return renderObjectNode(value, original, path);
  }
  const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'str';
  return renderScalarField(path, value, original, type);
}

function sortedKeys(obj) {
  const keys = Object.keys(obj);
  return settings.sortKeys ? keys.sort() : keys;
}

function renderObjectNode(obj, original, path) {
  let html = '';
  for (const key of sortedKeys(obj)) {
    const val = obj[key];
    const orig = original != null ? original[key] : undefined;
    const childPath = [...path, key];

    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const childCount = Object.keys(val).length;
      const dispKey = escapeHtml(String(key).toLowerCase());
      const collapseBtn = (path.length === 0) ? `<button class="section-collapse-btn" data-action="toggle-section-deep">${ICON_EXPAND}</button>` : '';
      html += `<div class="section collapsed">
        <div class="section-header" data-action="toggle-section">
          <span class="chevron">&#9654;</span>
          <span class="section-name">${dispKey}</span>
          <span class="section-count">${childCount}</span>
          ${collapseBtn}
        </div>
        <div class="section-body">${renderObjectNode(val, orig, childPath)}</div>
      </div>`;
    } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      const dispKey = escapeHtml(String(key).toLowerCase());
      const collapseBtn = (path.length === 0) ? `<button class="section-collapse-btn" data-action="toggle-section-deep">${ICON_EXPAND}</button>` : '';
      html += `<div class="section collapsed">
        <div class="section-header" data-action="toggle-section">
          <span class="chevron">&#9654;</span>
          <span class="section-name">${dispKey}</span>
          <span class="section-count">${val.length} items</span>
          ${collapseBtn}
        </div>
        <div class="section-body">${renderObjectArray(childPath, val, orig)}</div>
      </div>`;
    } else {
      html += renderNode(val, orig, childPath);
    }
  }
  return html;
}

function renderObjectArray(path, arr, origArr) {
  let html = '';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const origItem = origArr && origArr[i] ? origArr[i] : {};
    const parentKey = path.length > 0 ? String(path[path.length - 1]) : 'item';
    const label = escapeHtml(String(item.name || item.fn_key || `${parentKey}_${i}`).toLowerCase());
    const childCount = Object.keys(item).length;
    html += `<div class="section collapsed">
      <div class="section-header" data-action="toggle-section">
        <span class="chevron">&#9654;</span>
        <span class="section-name">${label}</span>
        <span class="section-count">${childCount}</span>
      </div>
      <div class="section-body">${renderObjectNode(item, origItem, [...path, i])}</div>
    </div>`;
  }
  return html;
}

function renderScalarField(path, value, original, type) {
  const key = path[path.length - 1];
  const dispKey = escapeHtml(String(key));
  const fid = registerField(path, type);
  const mod = !valEqual(value, original) ? ' modified' : '';
  const resetVisible = mod ? ' visible' : '';

  const isNum = type === 'int' || type === 'float';
  let inputHtml;
  if (type === 'bool') {
    const checked = value ? ' checked' : '';
    inputHtml = `<label class="toggle">
      <input type="checkbox" id="${fid}"${checked} data-action="toggle" data-fid="${fid}">
      <span class="toggle-slider"></span>
    </label>`;
  } else if (type === 'null') {
    inputHtml = `<span class="null-badge" data-action="convert-null" data-fid="${fid}" title="Click to set a value">null</span>`;
  } else {
    inputHtml = `<input type="text" id="${fid}" value="${escapeHtml(String(value))}" class="${mod ? 'modified' : ''}" data-action="input" data-fid="${fid}">`;
  }

  const typeBadge = `<span class="type-badge type-${type}">${type}</span>`;
  const origTitle = original !== undefined ? ` title="Original: ${escapeHtml(String(original))}"` : '';
  const origNum = typeof original === 'number' ? original : value;
  const fieldLocked = isFieldLocked(fid);
  const sliderHtml = (!fieldLocked && isNum && isSliderField(origNum)) ? buildSliderHtml(fid, value, origNum) : '';
  const lockedCls = fieldLocked ? ' locked' : '';

  return `<div class="field${mod}${lockedCls}" data-fid="${fid}" data-key="${escapeHtml(String(key))}"${origTitle}>
    <span class="field-key">${dispKey} ${typeBadge}</span>
    <span class="field-input">${inputHtml}</span>
    ${sliderHtml}
    ${buildLockBtn(fid)}
    ${buildPinBtn(fid)}
    <button class="field-reset${resetVisible}" data-action="reset-field" data-fid="${fid}" title="Reset to original">&#8635;</button>
  </div>`;
}

function renderScalarArrayField(path, value, original) {
  const key = path[path.length - 1];
  const dispKey = escapeHtml(String(key));
  const fid = registerField(path, 'list');
  const mod = !valEqual(value, original) ? ' modified' : '';
  const resetVisible = mod ? ' visible' : '';

  let itemsHtml = '';
  for (let i = 0; i < value.length; i++) {
    itemsHtml += `<div class="array-item">
      <input type="text" value="${escapeHtml(String(value[i]))}" data-action="array-input" data-fid="${fid}" data-index="${i}">
      <button class="array-btn remove" data-action="remove-item" data-fid="${fid}" data-index="${i}" title="Remove">&times;</button>
    </div>`;
  }
  itemsHtml += `<button class="array-btn add" data-action="add-item" data-fid="${fid}">+ add</button>`;

  const typeBadge = `<span class="type-badge type-list">list</span>`;
  const fieldLocked = isFieldLocked(fid);
  const lockedCls = fieldLocked ? ' locked' : '';

  return `<div class="field${mod}${lockedCls}" data-fid="${fid}" data-key="${escapeHtml(String(key))}">
    <span class="field-key">${dispKey} ${typeBadge}</span>
    <span class="field-input"><div class="array-items">${itemsHtml}</div></span>
    ${buildLockBtn(fid)}
    ${buildPinBtn(fid)}
    <button class="field-reset${resetVisible}" data-action="reset-field" data-fid="${fid}" title="Reset to original">&#8635;</button>
  </div>`;
}

// ── Lock/pin button helpers ────────────────────────────────
function lockFieldKey(fid) {
  const entry = state.fieldMap[fid];
  if (!entry) return null;
  return entry.file + ':' + JSON.stringify(entry.path);
}

function isFieldLocked(fid) {
  const entry = state.fieldMap[fid];
  if (!entry) return false;
  // Check exact path and all parent paths (locking a parent locks children)
  const file = entry.file;
  const path = entry.path;
  for (let i = path.length; i >= 1; i--) {
    const key = file + ':' + JSON.stringify(path.slice(0, i));
    if (state.lockedFields.has(key)) return true;
  }
  return false;
}

function lockAllFieldsInFile(filename) {
  const config = state.configs[filename];
  if (!config) return;
  (function walk(obj, path) {
    if (obj == null || typeof obj !== 'object') {
      state.lockedFields.add(filename + ':' + JSON.stringify(path));
      return;
    }
    if (Array.isArray(obj)) {
      // Recurse into array items instead of just locking the array path
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], [...path, i]);
      }
      return;
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key], [...path, key]);
    }
  })(config.current, []);
}

function buildLockBtn(fid) {
  const locked = isFieldLocked(fid);
  const label = locked ? 'unlock' : 'lock';
  const cls = locked ? ' locked' : '';
  const icon = locked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
  return `<button class="lock-btn${cls}" data-action="lock-field" data-fid="${fid}" title="${label}">${icon}</button>`;
}

function buildPinBtn(fid) {
  const entry = state.fieldMap[fid];
  const pinned = entry ? isPinnedPath(entry.path, entry.file) : false;
  const label = pinned ? 'unpin' : 'pin';
  const cls = pinned ? ' pinned' : '';
  return `<button class="pin-btn${cls}" data-action="pin-field" data-fid="${fid}" title="${label}">${PIN_ICON_SVG}${label}</button>`;
}

function refreshPinButtons() {
  document.querySelectorAll('.pin-btn[data-fid]').forEach(btn => {
    const entry = state.fieldMap[btn.dataset.fid];
    const pinned = entry ? isPinnedPath(entry.path, entry.file) : false;
    btn.classList.toggle('pinned', pinned);
    btn.title = pinned ? 'unpin' : 'pin';
    btn.childNodes[1].textContent = pinned ? 'unpin' : 'pin';
  });
}

// ── Pinned fields ───────────────────────────────────────────
function loadPinned() {
  const prev = vscode.getState();
  if (prev && prev.pinned) state.pinned = prev.pinned;
}

function savePinned() {
  const prev = vscode.getState() || {};
  vscode.setState({ ...prev, pinned: state.pinned });
  vscode.postMessage({ type: 'savePinned', pinned: state.pinned });
}

function isPinnedPath(path, file) {
  const f = file || state.renderingFile || state.activeFile;
  const pins = state.pinned[f] || [];
  const k = pathKey(path);
  return pins.some(p => pathKey(p) === k);
}

function pinField(path, file) {
  const f = file || state.activeFile;
  if (!state.pinned[f]) state.pinned[f] = [];
  if (isPinnedPath(path, f)) return;
  state.pinned[f].push([...path]);
  savePinned();
  renderPinnedBar();
  refreshPinButtons();
}

function unpinField(path) {
  const k = pathKey(path);
  for (const file of Object.keys(state.pinned)) {
    state.pinned[file] = state.pinned[file].filter(p => pathKey(p) !== k);
  }
  savePinned();
  renderPinnedBar();
  refreshPinButtons();
}

// ── Pinned bar rendering ───────────────────────────────────
function renderPinnedBar() {
  const bar = document.getElementById('pinned-bar');
  const cards = [];
  for (const [file, paths] of Object.entries(state.pinned)) {
    for (const path of paths) {
      const config = state.configs[file];
      cards.push({
        file,
        path,
        value: config ? getNestedValue(config.current, path) : undefined,
        origValue: config ? getNestedValue(config.original, path) : undefined,
        loaded: !!config,
      });
    }
  }

  const pinnedPanel = document.getElementById('pinned-panel');
  if (!cards.length) { bar.innerHTML = ''; pinnedPanel.classList.add('hidden'); return; }
  pinnedPanel.classList.remove('hidden');

  const rowsHtml = cards.map(({ file, path, value, origValue, loaded }) => {
    const fileLabel = escapeHtml(file.replace(/\.ya?ml$/i, ''));
    const leafKey = escapeHtml(String(path[path.length - 1]));
    const pData = escapeHtml(JSON.stringify(path));
    const fData = escapeHtml(file);
    const modified = loaded && !valEqual(value, origValue);
    const modCls = modified ? ' pin-modified' : '';

    const crumbParts = [fileLabel];
    for (const seg of path.slice(0, -1)) {
      if (typeof seg === 'number') {
        crumbParts[crumbParts.length - 1] += `[${seg}]`;
      } else {
        crumbParts.push(escapeHtml(String(seg)));
      }
    }
    const crumb = crumbParts.join('<span class="pin-crumb-sep"> \u203A </span>');

    let valueHtml;
    if (!loaded) {
      valueHtml = `<span class="pin-unloaded">\u2014</span>`;
    } else if (typeof value === 'boolean') {
      valueHtml =
        `<label class="pin-toggle-wrap">` +
          `<input type="checkbox"${value ? ' checked' : ''} data-pf="${fData}" data-pp="${pData}" data-pa="toggle">` +
          `<span class="pin-track"></span>` +
        `</label>`;
    } else if (value === null || value === undefined) {
      valueHtml = `<span class="pin-null">null</span>`;
    } else if (typeof value === 'number' && typeof origValue === 'number') {
      const sliderHtml = buildPinSliderHtml(fData, pData, value, origValue);
      valueHtml =
        `<input class="pin-val-input${modCls}" type="text" value="${escapeHtml(String(value))}"` +
          ` data-pf="${fData}" data-pp="${pData}" data-pa="input">` +
        sliderHtml;
    } else {
      valueHtml =
        `<input class="pin-val-input${modCls}" type="text" value="${escapeHtml(String(value))}"` +
          ` data-pf="${fData}" data-pp="${pData}" data-pa="input">`;
    }

    return `<div class="pin-row${modCls}">` +
      `<div class="pin-crumb">${crumb}</div>` +
      `<div class="pin-field-line">` +
        `<span class="pin-name">${leafKey}</span>` +
        valueHtml +
        `<button class="unpin-btn" data-pf="${fData}" data-pp="${pData}" data-pa="unpin" title="Unpin">&#215;</button>` +
      `</div>` +
    `</div>`;
  }).join('');

  const exportRow = `<div class="pin-export-row">` +
    `<div class="pin-export-btn-wrap"><button class="pin-export-btn" id="pin-exp-cli">&gt;_</button><span class="pin-tip">CLI args</span></div>` +
    `<div class="pin-export-btn-wrap"><button class="pin-export-btn" id="pin-exp-json">{}</button><span class="pin-tip">Flat JSON</span></div>` +
    `<div class="pin-export-btn-wrap"><button class="pin-export-btn" id="pin-exp-env">$</button><span class="pin-tip">Env vars</span></div>` +
  `</div>`;

  bar.innerHTML = rowsHtml + exportRow;
  document.getElementById('pin-exp-cli').addEventListener('click', copyPinnedAsCLI);
  document.getElementById('pin-exp-json').addEventListener('click', copyPinnedAsJSON);
  document.getElementById('pin-exp-env').addEventListener('click', copyPinnedAsEnv);
}

// ── Section helpers ────────────────────────────────────────
function toggleSection(sectionEl) {
  sectionEl.classList.toggle('collapsed');
  const body = sectionEl.querySelector(':scope > .section-body');
  if (!sectionEl.classList.contains('collapsed')) {
    body.style.maxHeight = body.scrollHeight + 'px';
    setTimeout(() => { body.style.maxHeight = 'none'; }, 220);
  } else {
    body.style.maxHeight = body.scrollHeight + 'px';
    requestAnimationFrame(() => { body.style.maxHeight = '0'; });
  }
}

function toggleSectionDeep(sectionEl) {
  const body = sectionEl.querySelector(':scope > .section-body');
  if (!body) return;
  const nested = Array.from(body.querySelectorAll('.section'));
  if (!nested.length) return;
  const anyExpanded = nested.some(s => !s.classList.contains('collapsed'));
  nested.forEach(s => s.classList.toggle('collapsed', anyExpanded));
  const btn = sectionEl.querySelector(':scope > .section-header > .section-collapse-btn');
  if (btn) btn.innerHTML = anyExpanded ? ICON_EXPAND : ICON_COLLAPSE;
  applySectionHeights();
}

function refreshSectionDeepButtons() {
  document.querySelectorAll('#config-editor > .section, #data-editor > .section').forEach(sectionEl => {
    const btn = sectionEl.querySelector(':scope > .section-header > .section-collapse-btn');
    if (!btn) return;
    const nested = sectionEl.querySelectorAll('.section');
    const anyExpanded = nested.length > 0 && Array.from(nested).some(s => !s.classList.contains('collapsed'));
    btn.innerHTML = anyExpanded ? ICON_COLLAPSE : ICON_EXPAND;
  });
}

function applySectionHeights() {
  document.querySelectorAll('.section:not(.collapsed) > .section-body').forEach(b => { b.style.maxHeight = 'none'; });
  document.querySelectorAll('.section.collapsed > .section-body').forEach(b => { b.style.maxHeight = '0'; });
}

// ── Search / filter ────────────────────────────────────────
function applySearch() {
  const query = document.getElementById('search').value.toLowerCase().trim();
  const editors = [document.getElementById('config-editor'), document.getElementById('data-editor')];
  if (!query) {
    editors.forEach(ed => {
      if (!ed) return;
      ed.querySelectorAll('.field').forEach(el => el.classList.remove('hidden'));
      ed.querySelectorAll('.section').forEach(sec => { sec.style.display = ''; });
    });
    return;
  }
  editors.forEach(ed => {
    if (!ed) return;
    ed.querySelectorAll('.field').forEach(el => {
      const key = (el.dataset.key || '').toLowerCase();
      const input = el.querySelector('input');
      const val = input ? input.value.toLowerCase() : '';
      el.classList.toggle('hidden', !key.includes(query) && !val.includes(query));
    });
    ed.querySelectorAll('.section').forEach(sec => {
      const hasVisible = sec.querySelector('.field:not(.hidden)');
      sec.style.display = hasVisible ? '' : 'none';
      if (hasVisible) {
        sec.classList.remove('collapsed');
        const body = sec.querySelector(':scope > .section-body');
        if (body) body.style.maxHeight = 'none';
      }
    });
  });
}

// ── Export helpers ──────────────────────────────────────────
function copyAsCLI() {
  const config = state.configs[state.activeFile];
  if (!config) return;
  const flat = flattenObj(config.current);
  const args = Object.entries(flat).map(([k, v]) => {
    if (v === null) return `--${k} null`;
    if (v === true) return `--${k}`;
    if (v === false) return `--no-${k}`;
    if (Array.isArray(v)) return `--${k} ${v.join(',')}`;
    return `--${k} ${v}`;
  }).join(' \\\n  ');
  navigator.clipboard.writeText(args);
  toast('Copied CLI args to clipboard', 'success');
}

function copyAsJSON() {
  const config = state.configs[state.activeFile];
  if (!config) return;
  const flat = flattenObj(config.current);
  navigator.clipboard.writeText(JSON.stringify(flat, null, 2));
  toast('Copied flat JSON to clipboard', 'success');
}

function copyAsEnv() {
  const config = state.configs[state.activeFile];
  if (!config) return;
  const flat = flattenObj(config.current);
  const envStr = Object.entries(flat).map(([k, v]) => {
    const envKey = k.replace(/\./g, '__').toUpperCase();
    const envVal = Array.isArray(v) ? v.join(',') : String(v);
    return `${envKey}=${envVal}`;
  }).join('\n');
  navigator.clipboard.writeText(envStr);
  toast('Copied env vars to clipboard', 'success');
}

// ── Pinned-only export helpers ──────────────────────────────
function buildPinnedLeafPairs() {
  const result = [];
  for (const [file, paths] of Object.entries(state.pinned)) {
    const config = state.configs[file];
    if (!config) continue;
    for (const path of paths) {
      result.push({ key: String(path[path.length - 1]), val: getNestedValue(config.current, path) });
    }
  }
  return result;
}

function buildPinnedNestedObj() {
  const result = {};
  for (const [file, paths] of Object.entries(state.pinned)) {
    const config = state.configs[file];
    if (!config) continue;
    for (const path of paths) {
      const val = getNestedValue(config.current, path);
      let cur = result;
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i];
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
        cur = cur[k];
      }
      cur[path[path.length - 1]] = val;
    }
  }
  return result;
}

function copyPinnedAsCLI() {
  const pairs = buildPinnedLeafPairs();
  if (!pairs.length) { toast('No pinned fields', 'info'); return; }
  const args = pairs.map(({ key, val }) => {
    if (val === null) return `--${key} null`;
    if (val === true) return `--${key} true`;
    if (val === false) return `--${key} false`;
    if (Array.isArray(val)) return `--${key} ${val.join(',')}`;
    return `--${key} ${val}`;
  }).join(' \\\n  ');
  navigator.clipboard.writeText(args);
  toast('Copied CLI args to clipboard', 'success');
}

function copyPinnedAsJSON() {
  const obj = buildPinnedNestedObj();
  navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
  toast('Copied JSON to clipboard', 'success');
}

function copyPinnedAsEnv() {
  const pairs = buildPinnedLeafPairs();
  if (!pairs.length) { toast('No pinned fields', 'info'); return; }
  const envStr = pairs.map(({ key, val }) => {
    const envKey = key.toUpperCase();
    const envVal = Array.isArray(val) ? val.join(',') : String(val);
    return `${envKey}=${envVal}`;
  }).join('\n');
  navigator.clipboard.writeText(envStr);
  toast('Copied env vars to clipboard', 'success');
}
