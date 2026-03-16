// ── Expand/Collapse icons (rounded square corners) ────────
// Expand: 4 open corners (no background)
const ICON_EXPAND = `<svg class="ec-icon" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 4V1.5a.5.5 0 01.5-.5H4"/><path d="M8 1h2.5a.5.5 0 01.5.5V4"/><path d="M11 8v2.5a.5.5 0 01-.5.5H8"/><path d="M4 11H1.5a.5.5 0 01-.5-.5V8"/></svg>`;
// Collapse: 4 connected corners (accent background)
const ICON_COLLAPSE = `<svg class="ec-icon ec-active" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="1" width="10" height="10" rx="2"/></svg>`;

// ── Polyfill ───────────────────────────────────────────────
const deepClone = typeof structuredClone !== 'undefined'
  ? structuredClone
  : v => JSON.parse(JSON.stringify(v));

// ── Value helpers ──────────────────────────────────────────
function valEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function getNestedValue(obj, path) {
  let cur = obj;
  for (const k of path) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

function setNestedValue(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

function pathKey(path) { return JSON.stringify(path); }

function normalizePath(path) {
  if (typeof path === 'string') return path.split('.').map(seg => /^\d+$/.test(seg) ? Number(seg) : seg);
  if (Array.isArray(path) && path.length === 1 && typeof path[0] === 'string' && path[0].includes('.')) {
    return path[0].split('.').map(seg => /^\d+$/.test(seg) ? Number(seg) : seg);
  }
  return (path || []).map(seg => typeof seg === 'number' ? seg : (/^\d+$/.test(String(seg)) ? Number(seg) : String(seg)));
}

// ── String helpers ─────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function linkifyUrls(text) {
  const urlRe = /https?:\/\/[^\s"'<>)}\]]+/g;
  let last = 0, out = '', m;
  while ((m = urlRe.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const url = m[0].replace(/[.,;:!?]+$/, '');
    urlRe.lastIndex = m.index + url.length;
    out += `<a href="${escapeHtml(url)}" class="agent-link" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function commonPrefix(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (strs[i].indexOf(p) !== 0) p = p.slice(0, -1);
    if (p === '') break;
  }
  return p;
}

// ── Object flatten (for export) ────────────────────────────
function flattenObj(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenObj(val, p));
    } else {
      result[p] = val;
    }
  }
  return result;
}

// ── Rich block parser (fenced code blocks in agent answers) ─
// Supports layout hints: ```mermaid [right]  or ```ascii [left]
// Adjacent [left]+[right] blocks are grouped into a side-by-side row.
function parseRichBlocks(text) {
  const blocks = [];
  const fenceRe = /```(\w*)(?:\s*\[(\w+)\])?\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) {
      const pre = text.slice(last, m.index).trim();
      if (pre) blocks.push({ type: 'text', content: pre, layout: null });
    }
    const lang = (m[1] || '').toLowerCase();
    const layout = (m[2] || '').toLowerCase() || null; // left, right, span, or null
    const content = m[3].trim();
    let blockType;
    if (lang === 'mermaid') blockType = 'mermaid';
    else if (lang === 'svg') blockType = 'svg';
    else if (lang === 'vegalite' || lang === 'vega-lite') blockType = 'vegalite';
    else if (lang === 'ascii' || lang === 'text') blockType = 'ascii';
    else blockType = 'code';
    const block = { type: blockType, content, layout };
    if (blockType === 'code') block.lang = lang || 'text';
    blocks.push(block);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) blocks.push({ type: 'text', content: tail, layout: null });
  }
  if (blocks.length === 0 && text.trim()) {
    blocks.push({ type: 'text', content: text.trim(), layout: null });
  }
  return blocks;
}

// Split text blocks into individual paragraphs for cell-based rendering
function splitTextIntoParagraphs(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      // Split on double newlines (markdown paragraph breaks)
      const paras = block.content.split(/\n{2,}/);
      for (const p of paras) {
        const trimmed = p.trim();
        if (trimmed) result.push({ type: 'text', content: trimmed, layout: block.layout });
      }
    } else {
      result.push(block);
    }
  }
  return result;
}

// Group blocks into layout rows: adjacent [left]+[right] become a row.
function groupBlocksIntoRows(blocks) {
  const rows = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const next = i + 1 < blocks.length ? blocks[i + 1] : null;
    if (b.layout === 'left' && next && next.layout === 'right') {
      rows.push({ type: 'row', blocks: [b, next] });
      i += 2;
    } else if (b.layout === 'right' && next && next.layout === 'left') {
      rows.push({ type: 'row', blocks: [next, b] });
      i += 2;
    } else {
      rows.push({ type: 'single', block: b });
      i++;
    }
  }
  return rows;
}

// ── Markdown + LaTeX rendering ─────────────────────────────
function renderMarkdownLatex(text) {
  // First, protect base64 images from markdown parser
  const imgBlocks = [];
  let processed = text;
  processed = processed.replace(/IMG:([A-Za-z0-9+/=\s]{20,})/g, (_, b64) => {
    const idx = imgBlocks.length;
    imgBlocks.push(b64.replace(/\s/g, '')); // strip any whitespace in base64
    return `\x02IMG${idx}\x03`;
  });
  // Protect LaTeX from markdown parser by replacing with placeholders
  const latexBlocks = [];
  // Display math: $$...$$
  processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
    const idx = latexBlocks.length;
    latexBlocks.push({ expr: expr.trim(), display: true });
    return `\x02LTX${idx}\x03`;
  });
  // Inline math: $...$  (not preceded by another $)
  processed = processed.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_, expr) => {
    const idx = latexBlocks.length;
    latexBlocks.push({ expr: expr.trim(), display: false });
    return `\x02LTX${idx}\x03`;
  });
  // Protect underscored_identifiers from becoming italic
  processed = processed.replace(/\b(\w+_\w+(?:_\w+)*)\b/g, (m) => '`' + m + '`');
  // Render markdown (strikethrough disabled to avoid ~~ in scientific text)
  let html;
  if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true, extensions: [{ name: 'del', level: 'inline', tokenizer() { return undefined; } }] });
    html = marked.parse(processed);
  } else {
    html = escapeHtml(processed).replace(/\n/g, '<br>');
  }
  // Restore LaTeX placeholders with KaTeX rendering
  html = html.replace(/\x02LTX(\d+)\x03/g, (_, idx) => {
    const { expr, display } = latexBlocks[Number(idx)];
    if (typeof katex !== 'undefined') {
      try {
        return katex.renderToString(expr, {
          displayMode: display,
          throwOnError: false,
          output: 'html',
        });
      } catch { return escapeHtml(expr); }
    }
    return escapeHtml(display ? `$$${expr}$$` : `$${expr}$`);
  });
  // Restore base64 image placeholders
  html = html.replace(/\x02IMG(\d+)\x03/g, (_, idx) => {
    const b64 = imgBlocks[Number(idx)];
    return `<img class="agent-plot" src="data:image/png;base64,${b64}" alt="plot" />`;
  });
  // Remove orphan IMG: references that weren't valid base64
  html = html.replace(/IMG:\S{0,19}(?=\s|<|$)/g, '');
  return html;
}

// ── Python syntax highlighting (GitHub-dark style) ────────
function highlightPython(code) {
  const keywords = /\b(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None)\b/g;
  const builtins = /\b(print|range|len|int|float|str|list|dict|set|tuple|type|isinstance|enumerate|zip|map|filter|sorted|reversed|open|abs|min|max|sum|round|input|super|property|staticmethod|classmethod|hasattr|getattr|setattr)\b/g;
  const numbers = /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi;

  // Tokenize to avoid highlighting inside strings/comments
  const tokens = [];
  let last = 0;
  const merged = new RegExp(`("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(#.*$)`, 'gm');
  let m;
  while ((m = merged.exec(code)) !== null) {
    if (m.index > last) tokens.push({ type: 'code', text: code.slice(last, m.index) });
    tokens.push({ type: m[1] ? 'string' : 'comment', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) tokens.push({ type: 'code', text: code.slice(last) });

  return tokens.map(t => {
    if (t.type === 'string') return `<span class="py-str">${escapeHtml(t.text)}</span>`;
    if (t.type === 'comment') return `<span class="py-cmt">${escapeHtml(t.text)}</span>`;
    // Highlight code tokens
    let s = escapeHtml(t.text);
    s = s.replace(/\b(def|class)\s+(\w+)/g, '<span class="py-kw">$1</span> <span class="py-fn">$2</span>');
    s = s.replace(keywords, '<span class="py-kw">$&</span>');
    s = s.replace(builtins, '<span class="py-bi">$&</span>');
    s = s.replace(numbers, '<span class="py-num">$&</span>');
    s = s.replace(/^(\s*@\w[\w.]*)/gm, '<span class="py-dec">$1</span>');
    return s;
  }).join('');
}

// ── Toast notification ─────────────────────────────────────
function toast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
