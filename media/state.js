// ── VSCode API ─────────────────────────────────────────────
const vscode = acquireVsCodeApi();

// ── Theme definitions ──────────────────────────────────────
const DARK_BADGES = {
  '--badge-str-bg':'#1a3a2a',   '--badge-str-fg':'#3fb950',
  '--badge-float-bg':'#1a2a3a', '--badge-float-fg':'#58a6ff',
  '--badge-int-bg':'#101e30',   '--badge-int-fg':'#89cff0',
  '--badge-bool-bg':'#2a1a3a',  '--badge-bool-fg':'#bc8cff',
  '--badge-null-bg':'#2a2a1a',  '--badge-null-fg':'#d29922',
  '--badge-list-bg':'#2a1a2a',  '--badge-list-fg':'#f778ba',
};

const THEMES = {
  selva: {
    label: 'Selva', bg: '#000000',
    defaults: { labelColor: '#b8d4c8', fieldColor: '#4ec080', accentColor: '#4ec080', bg0Color: '#000000', bg1Color: '#000000' },
    vars: { '--bg-0':'#000000','--bg-1':'#000000','--bg-2':'#0d1a12','--bg-3':'#18261e',
            '--border':'#1a2e20','--text-0':'#e0efe6','--text-1':'#b8d4c8','--text-2':'#6d9a80',
            ...DARK_BADGES }
  },
  claudius: {
    label: 'Claudius', bg: '#010409',
    defaults: { labelColor: '#E6EDF3', fieldColor: '#58A6FF', accentColor: '#FFA198' },
    vars: { '--bg-0':'#010409','--bg-1':'#010409','--bg-2':'#0d1117','--bg-3':'#161b22',
            '--border':'#21262d','--text-0':'#F0F6FC','--text-1':'#E6EDF3','--text-2':'#8b949e',
            ...DARK_BADGES }
  },
  slate: {
    label: 'Slate', bg: '#1e1e2e',
    defaults: { labelColor: '#c0c0d0', fieldColor: '#a78bfa', accentColor: '#a78bfa' },
    vars: { '--bg-0':'#1e1e2e','--bg-1':'#262637','--bg-2':'#2e2e42','--bg-3':'#3a3a50',
            '--border':'#3a3a50','--text-0':'#e0e0ef','--text-1':'#c0c0d0','--text-2':'#8888a0',
            ...DARK_BADGES }
  },
  nord: {
    label: 'Nord', bg: '#2e3440',
    defaults: { labelColor: '#d8dee9', fieldColor: '#88c0d0', accentColor: '#88c0d0' },
    vars: { '--bg-0':'#2e3440','--bg-1':'#3b4252','--bg-2':'#434c5e','--bg-3':'#4c566a',
            '--border':'#4c566a','--text-0':'#eceff4','--text-1':'#d8dee9','--text-2':'#81a1c1',
            ...DARK_BADGES }
  },
  desert: {
    label: 'Desert', bg: '#f5f0e8',
    defaults: { labelColor: '#5c3d2e', fieldColor: '#c07050', accentColor: '#c07050' },
    vars: { '--bg-0':'#f5f0e8','--bg-1':'#ede4d3','--bg-2':'#e0d5c0','--bg-3':'#c8bea8',
            '--border':'#c8bea8','--text-0':'#2d1a0e','--text-1':'#5c3d2e','--text-2':'#8b6050',
            '--badge-str-bg':'#e8f4e6',   '--badge-str-fg':'#2a6a2a',
            '--badge-float-bg':'#e6ecf4', '--badge-float-fg':'#1a4878',
            '--badge-int-bg':'#dceef8',   '--badge-int-fg':'#0a3060',
            '--badge-bool-bg':'#f0e8f4',  '--badge-bool-fg':'#5a1880',
            '--badge-null-bg':'#f8f0d8',  '--badge-null-fg':'#7a4a00',
            '--badge-list-bg':'#f4e8f0',  '--badge-list-fg':'#7a1840' }
  },
  sunset: {
    label: 'Sunset', bg: '#fff5f0',
    defaults: { labelColor: '#5c2810', fieldColor: '#d94f2a', accentColor: '#d94f2a' },
    vars: { '--bg-0':'#fff5f0','--bg-1':'#ffe8dc','--bg-2':'#ffd4c0','--bg-3':'#f5bca8',
            '--border':'#e8a890','--text-0':'#2d1008','--text-1':'#5c2810','--text-2':'#a04530',
            '--badge-str-bg':'#e8f4e0',   '--badge-str-fg':'#2a6a10',
            '--badge-float-bg':'#e0ecff', '--badge-float-fg':'#1a3a8a',
            '--badge-int-bg':'#d0e8ff',   '--badge-int-fg':'#0a2060',
            '--badge-bool-bg':'#f4e0f8',  '--badge-bool-fg':'#6a1080',
            '--badge-null-bg':'#fff0c0',  '--badge-null-fg':'#7a4800',
            '--badge-list-bg':'#ffe0f0',  '--badge-list-fg':'#8a1050' }
  },
};

// ── SVG icon constants ─────────────────────────────────────
const YAML_ICON_SVG = `<svg class="yaml-icon" width="14" height="16" viewBox="0 0 14 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="13" height="15" rx="2"/><line x1="3.5" y1="5" x2="10.5" y2="5"/><line x1="3.5" y1="8" x2="8.5" y2="8"/><line x1="3.5" y1="11" x2="9.5" y2="11"/></svg>`;
const DATA_ICON_SVG = `<svg class="data-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="8" width="3" height="5" rx="0.5"/><rect x="5.5" y="4" width="3" height="9" rx="0.5"/><rect x="10" y="1" width="3" height="12" rx="0.5"/></svg>`;
const LOCK_CLOSED_SVG = `<svg class="lock-icon" width="9" height="12" viewBox="0 0 9 12" fill="none"><rect x="0.5" y="5" width="8" height="6.5" rx="1.5"/><path d="M2.5 5V3.5a2 2 0 0 1 4 0V5"/></svg>`;
const LOCK_OPEN_SVG = `<svg class="lock-icon" width="9" height="12" viewBox="0 0 9 12" fill="none"><rect x="0.5" y="5" width="8" height="6.5" rx="1.5"/><path d="M2.5 5V3.5a2 2 0 0 1 4 0" /></svg>`;
const PIN_ICON_SVG = `<svg class="pin-icon" width="9" height="12" viewBox="0 0 9 12" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="4.5" cy="4" r="3"/><line x1="4.5" y1="7" x2="4.5" y2="11.5"/></svg>`;

// ── State ──────────────────────────────────────────────────
const state = {
  files: [],
  configs: {},
  activeFile: null,
  activeConfigFile: null,   // kept for backward compat with backend-ops
  activeDataFile: null,     // kept for backward compat with backend-ops
  fieldMap: {},
  fieldCounter: 0,
  pinned: {},
  pathToFid: {},
  renderingFile: null,
  _bgLoads: new Set(),
  _agentPending: null,
  _bootstrapPending: null,
  _bootstrapDone: false,
  _bootstrapRestore: null,
  _bootstrapRestored: false,
  conversationHistory: [],  // [{role:'user'|'assistant', content:string}]
  agentModelId: '',
  availableModels: [],
  availableCodingAgents: [],
  selectedCodingAgentId: '',
  fileTypes: {},
  lockedFields: new Set(),
  defaultPromptTemplate: '',
  sessionTokens: 0,  // accumulated token count for this session
  sessionEntries: [],
  tasks: [],
  activeTaskId: '',
  activeTaskName: '',
  activeTaskPath: '',
  kernelStatus: {
    language: 'python',
    taskId: '',
    started: false,
    state: 'cold',
    pendingCount: 0,
    currentRequestId: '',
  },
  _pendingExternalDrafts: new Map(),
  _appliedExternalDraftIds: new Set(),
  // ── Generic hooks for agent-created tools ──
  hooks: {
    // Per-field overrides: key (file:JSON(path)) → {min, max, step, hidden, readOnly, style, label, ...}
    fieldOverrides: {},
    // Callbacks run after renderEditors()
    onAfterRender: [],
    // Callbacks run before renderEditors()
    onBeforeRender: [],
    // Inject custom CSS (idempotent — keyed by id)
    _injectedStyles: {},
    injectCSS(id, css) {
      if (state.hooks._injectedStyles[id]) {
        state.hooks._injectedStyles[id].textContent = css;
        return;
      }
      const el = document.createElement('style');
      el.textContent = css;
      el.dataset.hookId = id;
      document.head.appendChild(el);
      state.hooks._injectedStyles[id] = el;
    },
    removeCSS(id) {
      if (state.hooks._injectedStyles[id]) {
        state.hooks._injectedStyles[id].remove();
        delete state.hooks._injectedStyles[id];
      }
    },
  },
};

// ── Settings ───────────────────────────────────────────────
const SETTINGS_KEY = 'config-dashboard-settings';
const defaultSettings = {
  theme: 'selva',
  labelFont: "'JetBrains Mono', monospace",
  fieldFont: "'Major Mono Display', monospace",
  valueFont: "'Courier New', Courier, monospace",
  systemFont: "'Open Sans', -apple-system, sans-serif",
  fontSize: 12,
  bg0Color: '#000000',
  bg1Color: '#000000',
  labelColor: '#b8d4c8',
  fieldColor: '#4ec080',
  accentColor: '#4ec080',
  density: 'compact',
  showBadges: true,
  showCounts: true,
  autoExpand: true,
  sortKeys: false,
  showSliders: true,
  notebookMode: true,
};
let settings = { ...defaultSettings };

// Detect macOS for keyboard shortcut hint
if (navigator.userAgent.includes('Mac') || navigator.userAgentData?.platform === 'macOS') {
  const modKeyEl = document.getElementById('mod-key');
  if (modKeyEl) modKeyEl.textContent = '\u2318';
}

function loadSettings() {
  try {
    const prev = vscode.getState();
    if (prev && prev.settings) {
      settings = { ...defaultSettings, ...prev.settings };
    } else if (prev && prev.userDefaultSettings) {
      settings = { ...defaultSettings, ...prev.userDefaultSettings };
    }
  } catch {}
  applySettings();
  syncSettingsUI();
}

function saveSettings() {
  const prev = vscode.getState() || {};
  vscode.setState({ ...prev, settings });
}

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--font-label', settings.labelFont);
  root.setProperty('--font-field', settings.fieldFont);
  root.setProperty('--font-value', settings.valueFont);
  root.setProperty('--font-system', settings.systemFont);
  root.setProperty('--font-size-base', settings.fontSize + 'px');
  root.setProperty('--color-label', settings.labelColor);
  root.setProperty('--color-field', settings.fieldColor);
  root.setProperty('--accent', settings.accentColor);

  const hex = settings.accentColor.replace('#','');
  const r = Math.max(0, parseInt(hex.slice(0,2),16) - 40);
  const g = Math.max(0, parseInt(hex.slice(2,4),16) - 40);
  const b = Math.max(0, parseInt(hex.slice(4,6),16) - 40);
  root.setProperty('--accent-dim', `rgb(${r},${g},${b})`);

  const theme = THEMES[settings.theme];
  if (theme) {
    for (const [k, v] of Object.entries(theme.vars)) root.setProperty(k, v);
  }

  // Override bg colors if user customized them (apply after theme)
  if (settings.bg0Color) {
    root.setProperty('--bg-0', settings.bg0Color);
    // Derive bg-2, bg-3, border from bg0 (lighten progressively)
    const h = settings.bg0Color.replace('#','');
    const lighten = (hex, amt) => {
      const r = Math.min(255, parseInt(hex.slice(0,2),16) + amt);
      const g = Math.min(255, parseInt(hex.slice(2,4),16) + amt);
      const b = Math.min(255, parseInt(hex.slice(4,6),16) + amt);
      return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    };
    root.setProperty('--bg-2', lighten(h, 20));
    root.setProperty('--bg-3', lighten(h, 35));
    root.setProperty('--border', lighten(h, 40));
  }
  if (settings.bg1Color) {
    root.setProperty('--bg-1', settings.bg1Color);
  }

  const densityMap = {
    compact: { pad: '4px', gap: '8px', secGap: '2px' },
    comfortable: { pad: '7px', gap: '12px', secGap: '4px' },
    spacious: { pad: '11px', gap: '16px', secGap: '8px' },
  };
  const d = densityMap[settings.density] || densityMap.comfortable;
  root.setProperty('--field-pad-y', d.pad);
  root.setProperty('--field-gap', d.gap);
  root.setProperty('--section-gap', d.secGap);

  document.body.classList.toggle('hide-badges', !settings.showBadges);
  document.body.classList.toggle('hide-counts', !settings.showCounts);
  document.body.classList.toggle('hide-sliders', !settings.showSliders);

  syncMermaidTheme();
}

function syncMermaidTheme() {
  if (typeof mermaid === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const bg0 = cs.getPropertyValue('--bg-0').trim();
  const bg1 = cs.getPropertyValue('--bg-1').trim();
  const bg2 = cs.getPropertyValue('--bg-2').trim();
  const text0 = cs.getPropertyValue('--text-0').trim();
  const text1 = cs.getPropertyValue('--text-1').trim();
  const text2 = cs.getPropertyValue('--text-2').trim();
  const accent = cs.getPropertyValue('--accent').trim();
  const border = cs.getPropertyValue('--border').trim();
  const fontBadge = cs.getPropertyValue('--font-badge').trim();
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    fontFamily: fontBadge,
    fontSize: 11,
    themeVariables: {
      fontFamily: fontBadge,
      fontSize: '11px',
      background: bg0,
      primaryColor: bg2,
      primaryBorderColor: border,
      primaryTextColor: text0,
      secondaryColor: bg1,
      secondaryBorderColor: border,
      secondaryTextColor: text1,
      tertiaryColor: bg2,
      tertiaryBorderColor: border,
      tertiaryTextColor: text2,
      lineColor: accent,
      textColor: text0,
      mainBkg: bg1,
      nodeBorder: border,
      clusterBkg: bg1,
      clusterBorder: border,
      titleColor: text0,
      edgeLabelBackground: bg1,
      nodeTextColor: text0,
      actorTextColor: text0,
      actorBkg: bg2,
      actorBorder: border,
      actorLineColor: accent,
      signalColor: text0,
      signalTextColor: text0,
      labelBoxBkgColor: bg1,
      labelBoxBorderColor: border,
      labelTextColor: text0,
      loopTextColor: text1,
      noteBkgColor: bg2,
      noteBorderColor: border,
      noteTextColor: text1,
      sectionBkgColor: bg1,
      sectionBkgColor2: bg2,
      altSectionBkgColor: bg2,
      taskBkgColor: bg2,
      taskBorderColor: border,
      taskTextColor: text0,
      activeTaskBkgColor: accent,
      activeTaskBorderColor: accent,
      gridColor: border,
      doneTaskBkgColor: bg2,
      pie1: accent,
      pie2: text2,
      pie3: border,
      pie4: bg2,
      pieTitleTextSize: '14px',
      pieTitleTextColor: text0,
      pieSectionTextColor: text0,
      pieSectionTextSize: '11px',
      pieLegendTextColor: text1,
      pieLegendTextSize: '11px',
      pieOuterStrokeColor: border,
    },
    securityLevel: 'strict',
  });
}

function syncSettingsUI() {
  document.getElementById('set-label-font').value = settings.labelFont;
  document.getElementById('set-field-font').value = settings.fieldFont;
  document.getElementById('set-value-font').value = settings.valueFont;
  document.getElementById('set-system-font').value = settings.systemFont;
  document.getElementById('set-font-size').value = settings.fontSize;
  document.getElementById('font-size-val').textContent = settings.fontSize;
  document.getElementById('set-bg0-color').value = settings.bg0Color;
  document.getElementById('set-bg1-color').value = settings.bg1Color;
  document.getElementById('set-label-color').value = settings.labelColor;
  document.getElementById('set-field-color').value = settings.fieldColor;
  document.getElementById('set-accent-color').value = settings.accentColor;
  document.getElementById('set-density').value = settings.density;
  document.getElementById('set-badges').checked = settings.showBadges;
  document.getElementById('set-counts').checked = settings.showCounts;
  document.getElementById('set-autoexpand').checked = settings.autoExpand;
  document.getElementById('set-sortkeys').checked = settings.sortKeys;
  document.getElementById('set-sliders').checked = settings.showSliders;
  document.getElementById('set-notebook').checked = settings.notebookMode;
  document.querySelectorAll('.sp-theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === settings.theme);
  });
}

function onSettingChange() {
  settings.labelFont = document.getElementById('set-label-font').value;
  settings.fieldFont = document.getElementById('set-field-font').value;
  settings.valueFont = document.getElementById('set-value-font').value;
  settings.systemFont = document.getElementById('set-system-font').value;
  settings.fontSize = parseInt(document.getElementById('set-font-size').value);
  settings.bg0Color = document.getElementById('set-bg0-color').value;
  settings.bg1Color = document.getElementById('set-bg1-color').value;
  settings.labelColor = document.getElementById('set-label-color').value;
  settings.fieldColor = document.getElementById('set-field-color').value;
  settings.accentColor = document.getElementById('set-accent-color').value;
  settings.density = document.getElementById('set-density').value;
  settings.showBadges = document.getElementById('set-badges').checked;
  settings.showCounts = document.getElementById('set-counts').checked;
  settings.autoExpand = document.getElementById('set-autoexpand').checked;
  settings.sortKeys = document.getElementById('set-sortkeys').checked;
  settings.showSliders = document.getElementById('set-sliders').checked;
  settings.notebookMode = document.getElementById('set-notebook').checked;
  document.getElementById('font-size-val').textContent = settings.fontSize;
  applySettings();
  saveSettings();
  if (state.activeFile) renderEditor();
  if (typeof updateNotebookComposerVisibility === 'function') updateNotebookComposerVisibility();
}

function selectTheme(themeName) {
  settings.theme = themeName;
  const t = THEMES[themeName];
  if (t) {
    settings.bg0Color    = t.vars['--bg-0'] || settings.bg0Color;
    settings.bg1Color    = t.vars['--bg-1'] || settings.bg1Color;
    if (t.defaults) {
      settings.labelColor  = t.defaults.labelColor;
      settings.fieldColor  = t.defaults.fieldColor;
      settings.accentColor = t.defaults.accentColor;
    }
  }
  applySettings();
  saveSettings();
  syncSettingsUI();
}

function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  const overlay = document.getElementById('settings-overlay');
  const btn = document.getElementById('settings-btn');
  const open = panel.style.display !== 'block';
  panel.style.display = open ? 'block' : 'none';
  overlay.style.display = open ? 'block' : 'none';
  btn.classList.toggle('active', open);
}

function buildThemeSwatches() {
  const container = document.getElementById('theme-swatches');
  container.innerHTML = Object.entries(THEMES).map(([key, t]) =>
    `<div>
      <div class="sp-theme-swatch${settings.theme === key ? ' active' : ''}"
           data-theme="${key}" title="${t.label}"
           style="background: linear-gradient(135deg, ${t.bg} 55%, ${t.defaults.accentColor} 55%)"></div>
      <span class="swatch-label">${t.label}</span>
    </div>`
  ).join('');
}

function saveAsUserDefault() {
  vscode.postMessage({ type: 'saveUserDefaults', settings: { ...settings } });
  toast('Saved as your default settings', 'success');
}

function resetToFactoryDefault() {
  settings = { ...defaultSettings };
  applySettings();
  saveSettings();
  syncSettingsUI();
  if (state.activeFile) renderEditor();
  toast('Reset to factory defaults', 'success');
}
