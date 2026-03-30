const path = require('path');
const { listJaneTrails, loadJaneSession } = require('./session-store');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdownSimple(md) {
  // Lightweight markdown → HTML for export (no external deps)
  let html = String(md || '');
  // Protect LaTeX blocks from markdown processing
  const mathBlocks = [];
  // Display math first ($$...$$), then inline ($...$)
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (m) => {
    mathBlocks.push(m);
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  html = html.replace(/\$([^\$\n]+?)\$/g, (m) => {
    mathBlocks.push(m);
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  // Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // Bold, italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre class="code-block${lang ? ' lang-' + lang : ''}"><code>${escapeHtml(code.trim())}</code></pre>`
  );
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => '<ul>' + match + '</ul>');
  // Line breaks → paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*<(h[1-6]|ul|pre)/g, '<$1');
  html = html.replace(/<\/(h[1-6]|ul|pre)>\s*<\/p>/g, '</$1>');
  // Restore LaTeX blocks
  html = html.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathBlocks[parseInt(i)]);
  return html;
}

function renderCell(cell) {
  if (!cell) return '';

  if (cell.type === 'markdown' && cell.content) {
    return `<div class="cell cell-markdown">${renderMarkdownSimple(cell.content)}</div>`;
  }

  if (cell.type === 'mathjax' && cell.content) {
    // KaTeX auto-render will process the $$ delimiters on page load
    return `<div class="cell cell-mathjax" style="text-align:center;margin:12px 0;">$$${cell.content}$$</div>`;
  }

  if (cell.type === 'python' && cell.code) {
    let html = `<div class="cell cell-python">`;
    html += `<pre class="code-block lang-python"><code>${escapeHtml(cell.code)}</code></pre>`;
    if (cell.output) {
      const isError = /^Error \(exit\s+\d+\):|Traceback/i.test(cell.output);
      html += `<pre class="cell-output${isError ? ' cell-output-error' : ''}">${escapeHtml(cell.output)}</pre>`;
    }
    html += `</div>`;
    return html;
  }

  if (cell.type === 'image' && cell.data) {
    return `<div class="cell cell-image"><img src="data:image/png;base64,${cell.data}" alt="plot" /></div>`;
  }

  return '';
}

function renderTrailSection(trail, session, depth = 0) {
  const entries = session.entries || [];
  const bitacora = session.bitacora || '';
  const headerTag = depth === 0 ? 'h2' : 'h3';

  let html = `<section class="trail" id="trail-${escapeHtml(trail.id)}">`;
  html += `<${headerTag} class="trail-title">${escapeHtml(trail.name)}</${headerTag}>`;

  if (trail.parentTrailId) {
    html += `<p class="trail-meta">Forked from parent trail</p>`;
  }
  if (trail.createdAt) {
    html += `<p class="trail-meta">Started: ${new Date(trail.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>`;
  }

  // Bitácora
  if (bitacora) {
    html += `<div class="bitacora">`;
    html += `<h4>Research Log</h4>`;
    html += renderMarkdownSimple(bitacora);
    html += `</div>`;
  }

  // Notebook entries
  if (entries.length > 0) {
    html += `<div class="notebook">`;
    html += `<h4>Notebook</h4>`;
    for (const entry of entries) {
      html += `<div class="entry">`;
      if (entry.question) {
        html += `<div class="entry-question">&gt; ${escapeHtml(entry.question)}</div>`;
      }
      for (const cell of (entry.cells || [])) {
        html += renderCell(cell);
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</section>`;
  return html;
}

function buildTrailTree(trails) {
  // Build a tree from flat trail list using parentTrailId
  const byId = new Map(trails.map((t) => [t.id, t]));
  const roots = [];
  const children = new Map();

  for (const t of trails) {
    const parentId = t.parentTrailId || '';
    if (!parentId || !byId.has(parentId)) {
      roots.push(t);
    } else {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(t);
    }
  }

  function flatten(nodes, depth) {
    const result = [];
    for (const node of nodes) {
      result.push({ trail: node, depth });
      const kids = children.get(node.id) || [];
      result.push(...flatten(kids, depth + 1));
    }
    return result;
  }

  return flatten(roots, 0);
}

function renderProjectGraph(trails) {
  // Simple text representation of the trail tree for the HTML export
  const tree = buildTrailTree(trails);
  if (tree.length === 0) return '';

  let html = `<div class="project-graph"><h3>Research Graph</h3><pre class="graph-tree">`;
  for (const { trail, depth } of tree) {
    const indent = '  '.repeat(depth);
    const connector = depth > 0 ? '└─ ' : '';
    const status = trail.active ? ' ●' : '';
    html += `${indent}${connector}${escapeHtml(trail.name)}${status}\n`;
  }
  html += `</pre></div>`;
  return html;
}

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 20px;
  }
  h1 { font-size: 22pt; margin: 0 0 8px; color: #111; }
  h2 { font-size: 16pt; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #e0e0e0; color: #222; }
  h3 { font-size: 13pt; margin: 24px 0 8px; color: #333; }
  h4 { font-size: 11pt; margin: 16px 0 6px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  p { margin: 6px 0; }
  ul { margin: 4px 0 4px 20px; }
  li { margin: 2px 0; }
  code { font-family: 'Fira Code', 'Consolas', monospace; font-size: 9.5pt; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  strong { font-weight: 600; }

  .project-meta { color: #666; font-size: 10pt; margin-bottom: 24px; }
  .project-graph { margin: 20px 0; }
  .graph-tree { font-family: 'Fira Code', monospace; font-size: 10pt; background: #f8f8f8; padding: 16px; border-radius: 6px; border: 1px solid #e8e8e8; }

  .trail { page-break-before: always; }
  .trail:first-of-type { page-break-before: auto; }
  .trail-title { color: #1a6b3a; }
  .trail-meta { font-size: 9.5pt; color: #888; margin: 2px 0; }

  .bitacora { background: #f0f7f3; border-left: 3px solid #2d8a56; padding: 12px 16px; margin: 12px 0; border-radius: 4px; font-size: 10pt; }
  .bitacora h4 { color: #2d8a56; margin-top: 0; }

  .entry { margin: 16px 0; }
  .entry-question { font-size: 10pt; color: #2d8a56; font-weight: 500; margin-bottom: 6px; padding: 4px 8px; background: #f0f7f3; border-radius: 4px; }

  .cell { margin: 8px 0; }
  .cell-markdown { font-size: 10.5pt; }
  .cell-image { text-align: center; margin: 12px 0; }
  .cell-image img { max-width: 100%; border: 1px solid #e8e8e8; border-radius: 4px; }

  .code-block {
    font-family: 'Fira Code', 'Consolas', monospace;
    font-size: 9pt;
    background: #1e1e2e;
    color: #cdd6f4;
    padding: 12px 16px;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre;
    line-height: 1.5;
  }
  .cell-output {
    font-family: 'Fira Code', monospace;
    font-size: 8.5pt;
    background: #f8f8f8;
    color: #333;
    padding: 8px 16px;
    border-radius: 0 0 6px 6px;
    border: 1px solid #e8e8e8;
    border-top: none;
    white-space: pre-wrap;
    max-height: 300px;
    overflow-y: auto;
  }
  .cell-output-error { color: #c0392b; background: #fdf2f2; border-color: #f0d0d0; }

  @media print {
    body { padding: 0; max-width: none; }
    .trail { page-break-before: always; }
    .trail:first-of-type { page-break-before: auto; }
    .code-block { font-size: 8pt; }
    .cell-image img { max-width: 90%; }
  }
`;

function exportProjectToHtml(configDir, options = {}) {
  const projectName = options.projectName || path.basename(configDir);
  const projectPrompt = options.projectPrompt || '';
  const trails = listJaneTrails(configDir);
  const trailTree = buildTrailTree(trails);

  let body = '';

  // Title
  body += `<h1>${escapeHtml(projectName)}</h1>`;
  body += `<p class="project-meta">Exported from Selva on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} &mdash; ${trails.length} trail${trails.length !== 1 ? 's' : ''}</p>`;

  // Project prompt
  if (projectPrompt) {
    body += `<div class="bitacora"><h4>Project Description</h4>${renderMarkdownSimple(projectPrompt)}</div>`;
  }

  // Trail graph
  body += renderProjectGraph(trails);

  // Each trail
  for (const { trail, depth } of trailTree) {
    const session = loadJaneSession(configDir, trail.id);
    body += renderTrailSection(trail, session, depth);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)} — Selva Research Project</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {delimiters: [
      {left: '$$', right: '$$', display: true},
      {left: '$', right: '$', display: false}
    ]});"></script>
  <style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

  return html;
}

module.exports = { exportProjectToHtml };
