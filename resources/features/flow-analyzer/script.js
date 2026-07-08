/**
 * Node API Forge – Flow Analyzer client-side script
 * Runs inside the VS Code webview.
 *
 * Globals injected by the extension (via {{initialData}} block in index.html):
 *   window.DIAGRAM_SRC  – Mermaid flowchart source string
 *   window.ENDPOINT     – serialized ApiEndpoint object
 */

/* global acquireVsCodeApi, mermaid */

// ── VS Code API + state ──────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const state = {
  zoom: 1,
  pan: { x: 0, y: 0, dragging: false, startX: 0, startY: 0 }
};

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis', nodeSpacing: 50, rankSpacing: 60 }
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  setupTabs();
  renderMermaidDiagram();
  renderMiddlewareChain();
  renderComponentTree();
  renderDataFlow();
  renderDocumentation();
  setupZoomControls();
  setupSearch();
  setupSidebar();
  document.getElementById('search-btn')?.addEventListener('click', onSearchClick);
  document.getElementById('test-btn')?.addEventListener('click', onTestClick);
  document.getElementById('refresh-btn')?.addEventListener('click', onHardRefreshClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
});

function onSearchClick() {
  vscode.postMessage({ command: 'searchEndpoint' });
}

function onTestClick() {
  vscode.postMessage({ command: 'testEndpoint' });
}

window.addEventListener('message', event => {
  const message = event.data;
  if (!message || message.command !== 'hardRefreshDone') {
    return;
  }

  if (message.success) {
    return;
  }

  const button = document.getElementById('refresh-btn');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.disabled = false;
  button.textContent = button.dataset.originalLabel || '🔄 Refresh Endpoint';
});

function onHardRefreshClick(event) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }

  button.disabled = true;
  const originalLabel = button.textContent;
  button.dataset.originalLabel = originalLabel || '🔄 Refresh Endpoint';
  button.textContent = '⏳ Re-analyzing...';

  vscode.postMessage({ command: 'hardRefresh' });
}

// ── Header ───────────────────────────────────────────────────────────────────
function renderHeader() {
  const el = document.getElementById('endpoint-info');
  if (!el) return;
  const route = window.ENDPOINT.resolvedPath || window.ENDPOINT.pathExpression;
  el.innerHTML =
    `<span class="method ${window.ENDPOINT.method.toLowerCase()}">${window.ENDPOINT.method}</span>` +
    `<span class="uri"> ${escHtml(route)}</span>`;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');
    });
  });
}

// ── Flow Diagram ─────────────────────────────────────────────────────────────
async function renderMermaidDiagram() {
  const viewport = document.getElementById('diagram-viewport');
  if (!viewport) return;
  try {
    const { svg } = await mermaid.render('flowchart-main', window.DIAGRAM_SRC);
    viewport.innerHTML = `<div>${svg}</div>`;
    setupDiagramPan(document.getElementById('mermaid-diagram'), viewport);
    setupNodeClickHandlers(viewport);
    setTimeout(centerDiagram, 50);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    viewport.innerHTML = `<div style="color:#f44;padding:20px">Render error: ${escHtml(message)}<br><br>Mermaid could not be loaded or rendered. Check network access to jsdelivr or proxy settings.</div>`;
  }
}

function setupDiagramPan(container, viewport) {
  if (!container || !viewport) return;
  container.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.node')) return;
    state.pan.dragging = true;
    state.pan.startX = e.clientX - state.pan.x;
    state.pan.startY = e.clientY - state.pan.y;
  });
  document.addEventListener('mousemove', e => {
    if (!state.pan.dragging) return;
    state.pan.x = e.clientX - state.pan.startX;
    state.pan.y = e.clientY - state.pan.startY;
    applyTransform(viewport);
  });
  document.addEventListener('mouseup', () => { state.pan.dragging = false; });
  container.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) {
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.max(0.1, Math.min(5, state.zoom + delta));
      const ratio = newZoom / state.zoom;
      state.pan.x = e.offsetX - (e.offsetX - state.pan.x) * ratio;
      state.pan.y = e.offsetY - (e.offsetY - state.pan.y) * ratio;
      state.zoom = newZoom;
    } else {
      state.pan.x -= (e.shiftKey ? e.deltaY : e.deltaX) * 1.5;
      state.pan.y -= (e.shiftKey ? 0 : e.deltaY) * 1.5;
    }
    applyTransform(viewport);
    updateZoomDisplay();
  }, { passive: false });
}

function applyTransform(vp) {
  if (vp) vp.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;
}
function updateZoomDisplay() {
  const el = document.getElementById('zoom-info');
  if (el) el.textContent = `${Math.round(state.zoom * 100)}%`;
}
function centerDiagram() {
  const container = document.getElementById('mermaid-diagram');
  const vp = document.getElementById('diagram-viewport');
  if (!container || !vp) return;
  const svgEl = vp.querySelector('svg');
  if (!svgEl) return;
  const cw = container.clientWidth;
  const svgW = svgEl.getBoundingClientRect().width / state.zoom;
  state.pan.x = Math.max(0, (cw - svgW * state.zoom) / 2);
  state.pan.y = 20;
  applyTransform(vp);
}
function setupZoomControls() {
  const vp = () => document.getElementById('diagram-viewport');
  document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
    state.zoom = Math.min(5, state.zoom + 0.15); applyTransform(vp()); updateZoomDisplay();
  });
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
    state.zoom = Math.max(0.1, state.zoom - 0.15); applyTransform(vp()); updateZoomDisplay();
  });
  document.getElementById('reset-zoom-btn')?.addEventListener('click', () => {
    state.zoom = 1; state.pan.x = 0; state.pan.y = 0; applyTransform(vp()); updateZoomDisplay();
  });
  document.getElementById('center-btn')?.addEventListener('click', centerDiagram);
}
function setupNodeClickHandlers(viewport) {
  viewport.querySelectorAll('.node').forEach(node => {
    node.style.cursor = 'pointer';
    const rawId = node.id || '';
    const m = rawId.match(/flowchart-main-([A-Z0-9]+)-/);
    const id = m ? m[1] : rawId.replace(/^flowchart-main-/, '').replace(/-\d+$/, '');
    node.addEventListener('click', e => {
      e.stopPropagation();
      if (id === 'HANDLER') openSidebarForHandler();
      else if (id.startsWith('MW')) openSidebarForMiddleware(parseInt(id.replace('MW', ''), 10));
    });
  });
}

// ── Middleware Chain ──────────────────────────────────────────────────────────
function renderMiddlewareChain() {
  const container = document.getElementById('middleware-chain');
  if (!container) return;
  const mws = window.ENDPOINT.middleware || [];
  const mwItems = mws.map((mw, i) => {
    const short = mw.name.replace(/\\/g, '/').split('/').pop() || mw.name;
    const loc = mw.location ? `${shortPath(mw.location.filePath)}:${mw.location.line}` : 'location unknown';
    return `
      <div class="middleware-item" data-mw-index="${i}">
        <div class="mw-index">${i + 1}</div>
        <div class="mw-content">
          <div class="mw-name">${escHtml(short)}</div>
          <div class="mw-meta">${escHtml(mw.name)}</div>
          <div class="mw-meta">${escHtml(loc)}</div>
        </div>
      </div>`;
  });

  const hf = window.ENDPOINT.handlerLocation;
  const handlerName = hf.symbolName || shortPath(hf.filePath);
  const handlerItem = `
    <div class="middleware-item handler-step" data-handler-step="true">
      <div class="mw-index">${mws.length + 1}</div>
      <div class="mw-content">
        <div class="mw-name">${escHtml(handlerName)}</div>
        <div class="mw-meta">Handler</div>
        <div class="mw-meta">${escHtml(shortPath(hf.filePath))}:${hf.line}</div>
      </div>
    </div>`;

  const steps = [...mwItems, handlerItem];
  container.innerHTML = steps.map((item, idx) => {
    const arrow = idx < steps.length - 1 ? '<div class="middleware-arrow">↓</div>' : '';
    return `${item}${arrow}`;
  }).join('');

  container.querySelectorAll('.middleware-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.dataset.handlerStep === 'true') {
        openSidebarForHandler();
        return;
      }
      openSidebarForMiddleware(parseInt(item.dataset.mwIndex));
    });
  });
}

// ── Component Tree ────────────────────────────────────────────────────────────
function renderComponentTree() {
  const container = document.getElementById('component-tree-container');
  if (!container) return;
  const graph = window.COMPONENT_GRAPH;
  if (!graph || !Array.isArray(graph.rootFiles) || graph.rootFiles.length === 0) {
    container.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px">No component graph available.</div>';
    return;
  }

  const state = buildGraphRenderState(graph);
  container.innerHTML = graph.rootFiles
    .map(root => buildComponentNodeHtml(root, graph, state, new Set()))
    .join('');

  container.querySelectorAll('.tree-root-header').forEach((hdr) => {
    hdr.addEventListener('click', (event) => {
      const hasChildren = hdr.dataset.hasChildren === 'true';
      const filePath = hdr.dataset.filepath;
      const line = parseInt(hdr.dataset.line || '1');
      const kind = hdr.dataset.kind || 'dependency';
      const metrics = (state.metricsByPath && state.metricsByPath[filePath]) || { reads: 0, writes: 0, data: 0 };

      const target = event.target;
      if (target instanceof Element && target.classList.contains('tree-toggle')) {
        if (!hasChildren) {
          return;
        }

        const nodeId = hdr.dataset.nodeId;
        const root = nodeId ? container.querySelector(`[data-tree-node="${nodeId}"]`) : null;
        const children = root?.querySelector(':scope > .tree-children');
        const toggle = root?.querySelector(':scope > .tree-root-header .tree-toggle');
        if (children) {
          const open = children.classList.toggle('expanded');
          if (toggle && !toggle.classList.contains('empty')) {
            toggle.textContent = open ? '▼' : '▶';
          }
        }
        return;
      }

      openSidebarForComponentNode(filePath, line, kind, hasChildren, metrics);
    });

    hdr.addEventListener('dblclick', () => {
      const filePath = hdr.dataset.filepath;
      const line = parseInt(hdr.dataset.line || '1');
      navigate(filePath, line);
    });
  });

  document.getElementById('expand-all-btn')?.addEventListener('click', () => {
    container.querySelectorAll('.tree-children').forEach(c => c.classList.add('expanded'));
    container.querySelectorAll('.tree-toggle:not(.empty)').forEach(t => { t.textContent = '▼'; });
  });
  document.getElementById('collapse-all-btn')?.addEventListener('click', () => {
    container.querySelectorAll('.tree-children').forEach(c => c.classList.remove('expanded'));
    container.querySelectorAll('.tree-toggle:not(.empty)').forEach(t => { t.textContent = '▶'; });
  });
}

function buildGraphRenderState(graph) {
  const idByPath = {};
  const lineByPath = {};
  const metricsByPath = {};
  let counter = 0;
  const allPaths = new Set(graph.rootFiles || []);
  Object.keys(graph.childrenByFile || {}).forEach((from) => {
    allPaths.add(from);
    (graph.childrenByFile[from] || []).forEach((to) => allPaths.add(to));
  });
  allPaths.forEach((filePath) => {
    idByPath[filePath] = `node-${counter++}`;
    const hintedLine = graph.lineByFile && Number.isFinite(graph.lineByFile[filePath])
      ? Number(graph.lineByFile[filePath])
      : 1;
    lineByPath[filePath] = hintedLine > 0 ? hintedLine : 1;

    const rawMetrics = graph.metricsByFile && graph.metricsByFile[filePath]
      ? graph.metricsByFile[filePath]
      : { reads: 0, writes: 0, data: 0 };
    metricsByPath[filePath] = {
      reads: Number.isFinite(rawMetrics.reads) ? Number(rawMetrics.reads) : 0,
      writes: Number.isFinite(rawMetrics.writes) ? Number(rawMetrics.writes) : 0,
      data: Number.isFinite(rawMetrics.data) ? Number(rawMetrics.data) : 0
    };
  });
  return { idByPath, lineByPath, metricsByPath };
}

function buildComponentNodeHtml(filePath, graph, state, ancestors) {
  const children = (graph.childrenByFile && graph.childrenByFile[filePath]) || [];
  const kind = (graph.kindByFile && graph.kindByFile[filePath]) || 'dependency';
  const hasChildren = children.length > 0;
  const nodeId = state.idByPath[filePath] || `node-${Math.random().toString(36).slice(2)}`;
  const nodeLine = state.lineByPath[filePath] || 1;
  const nodeMetrics = state.metricsByPath[filePath] || { reads: 0, writes: 0, data: 0 };
  const icon = kindIcon(kind);
  const title = kindLabel(kind);
  const displayName = shortPath(filePath);
  const badgeHtml = buildNodeBadgeHtml(nodeMetrics);

  let childHtml = '';
  if (hasChildren) {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(filePath);
    childHtml = `<div class="tree-children">${children.map((childPath) => {
      if (nextAncestors.has(childPath)) {
        const cycleLine = state.lineByPath[childPath] || 1;
        const cycleMetrics = state.metricsByPath[childPath] || { reads: 0, writes: 0, data: 0 };
        const cycleBadgeHtml = buildNodeBadgeHtml(cycleMetrics);
        return `<div class="tree-root" data-tree-node="${state.idByPath[childPath] || ''}">
          <div class="tree-root-header" data-has-children="false" data-kind="dependency" data-filepath="${escAttr(childPath)}" data-line="${cycleLine}">
            <span class="tree-toggle empty">▶</span>
            <span>♻️</span>
            <span class="tree-root-name">${escHtml(shortPath(childPath))}</span>
            <div class="tree-node-badges">${cycleBadgeHtml}</div>
            <span class="tree-leaf-meta" style="margin-left:auto">cycle reference</span>
          </div>
        </div>`;
      }
      return buildComponentNodeHtml(childPath, graph, state, nextAncestors);
    }).join('')}</div>`;
  }

  return `
    <div class="tree-root" data-tree-node="${nodeId}">
      <div class="tree-root-header" data-node-id="${nodeId}" data-has-children="${hasChildren ? 'true' : 'false'}" data-kind="${escAttr(kind)}" data-filepath="${escAttr(filePath)}" data-line="${nodeLine}">
        <span class="tree-toggle${hasChildren ? '' : ' empty'}">▶</span>
        <span>${icon}</span>
        <span class="tree-root-name">${escHtml(displayName)}</span>
        <div class="tree-node-badges">${badgeHtml}</div>
        <span class="tree-leaf-meta" style="margin-left:auto">${escHtml(title)}</span>
      </div>
      ${childHtml}
    </div>`;
}

function buildNodeBadgeHtml(metrics) {
  const m = metrics || { reads: 0, writes: 0, data: 0 };
  const badges = [];
  if (m.reads > 0) {
    badges.push(`<span class="tree-node-badge read" title="Read accesses">👁️ ${m.reads}</span>`);
  }
  if (m.writes > 0) {
    badges.push(`<span class="tree-node-badge write" title="Write accesses">✏️ ${m.writes}</span>`);
  }
  if (m.data > 0) {
    badges.push(`<span class="tree-node-badge data" title="Data touches">📋 ${m.data}</span>`);
  }
  return badges.join('');
}

function kindIcon(kind) {
  if (kind === 'handler') return '🎯';
  if (kind === 'middleware') return '🧱';
  if (kind === 'detected') return '🔎';
  return '📦';
}

function kindLabel(kind) {
  if (kind === 'handler') return 'handler';
  if (kind === 'middleware') return 'middleware';
  if (kind === 'detected') return 'detected root';
  return 'dependency';
}

// ── Data Flow ─────────────────────────────────────────────────────────────────
function renderDataFlow() {
  const container = document.getElementById('property-list');
  if (!container) return;
  const params = window.ENDPOINT.parameters || [];
  const groups = [
    { key: 'path',   icon: '🔑', label: 'Path Parameters',     color: '#dcdcaa' },
    { key: 'query',  icon: '🔍', label: 'Query Parameters',    color: '#9cdcfe' },
    { key: 'body',   icon: '📦', label: 'Request Body Fields', color: '#4ec9b0' },
    { key: 'header', icon: '📋', label: 'Request Headers',     color: '#c586c0' },
    { key: 'cookie', icon: '🍪', label: 'Cookies',             color: '#ce9178' },
  ];

  let html = groups.map(g => {
    const items = params.filter(p => p.location === g.key);
    const rows = items.map(p => `
      <div class="param-row" data-name="${escAttr(p.name)}">
        <span class="param-name" style="color:${g.color}">${escHtml(p.name)}</span>
        <span class="param-type">${escHtml(p.type || '')}</span>
        <span class="${p.required ? 'param-required' : 'param-optional'}">${p.required ? 'required' : 'optional'}</span>
        <span class="param-desc">${escHtml(p.description || '')}</span>
        ${renderParameterLocations(p)}
      </div>`).join('');
    return `
      <div class="param-group">
        <div class="param-group-header">
          <span>${g.icon}</span>
          <span class="param-group-title">${g.label}</span>
          <span class="param-group-count">${items.length}</span>
          <span class="param-group-chevron">▼</span>
        </div>
        <div class="param-group-body">
          ${items.length > 0 ? rows : '<div class="empty-group">None detected</div>'}
        </div>
      </div>`;
  }).join('');

  const rb = window.ENDPOINT.requestBody;
  if (rb) {
    html += `
      <div class="param-group">
        <div class="param-group-header">
          <span>📤</span>
          <span class="param-group-title">Request Body</span>
          <span class="param-group-count">${escHtml(rb.type || 'unknown type')}</span>
        </div>
        <div class="param-group-body">
          <div class="param-row">
            <span class="param-type">${escHtml(rb.type || '')}</span>
            ${rb.schema ? `<span class="param-desc">${escHtml(rb.schema)}</span>` : ''}
            ${rb.required ? '<span class="param-required">required</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.param-group-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = hdr.nextElementSibling;
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      const chev = hdr.querySelector('.param-group-chevron');
      if (chev) chev.textContent = open ? '▶' : '▼';
    });
  });
}

function setupSearch() {
  const input = document.getElementById('property-search');
  if (!input) return;
  let t;
  input.addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(() => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.param-row').forEach(row => {
        row.style.display = !q || (row.dataset.name || '').toLowerCase().includes(q) ? '' : 'none';
      });
    }, 150);
  });
}

function renderParameterLocations(param) {
  const normalized = normalizeParameterLocations(param);
  if (normalized.read.length === 0 && normalized.write.length === 0) {
    return '';
  }

  const readRows = normalized.read.map(loc => `
    <div class="clickable-file param-loc-link" onclick="navigate('${escAttrOnclick(loc.filePath)}',${loc.line})">
      <code>READ: ${escHtml(shortPath(loc.filePath))}</code>
      <span class="line-badge">:${loc.line}</span>
    </div>`).join('');

  const writeRows = normalized.write.map(loc => `
    <div class="clickable-file param-loc-link" onclick="navigate('${escAttrOnclick(loc.filePath)}',${loc.line})">
      <code>WRITE: ${escHtml(shortPath(loc.filePath))}</code>
      <span class="line-badge">:${loc.line}</span>
    </div>`).join('');

  return `
    <div class="param-locations">
      ${writeRows}
      ${readRows}
    </div>`;
}

function normalizeParameterLocations(param) {
  const raw = [];
  if (param.detectionLocation) {
    raw.push(param.detectionLocation);
  }
  if (Array.isArray(param.evidenceLocations)) {
    raw.push(...param.evidenceLocations);
  }

  const seen = new Set();
  const read = [];
  const write = [];
  for (const loc of raw) {
    if (!loc || !loc.filePath) {
      continue;
    }
    const line = Number(loc.line || 1);
    const mode = loc.accessMode === 'write' ? 'write' : 'read';
    const key = `${loc.filePath}:${line}:${mode}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const normalizedLoc = { filePath: loc.filePath, line };
    if (mode === 'write') {
      write.push(normalizedLoc);
    } else {
      read.push(normalizedLoc);
    }
  }

  return { read, write };
}

// ── Documentation ─────────────────────────────────────────────────────────────
function renderDocumentation() {
  const container = document.getElementById('doc-content');
  if (!container) return;
  const ep = window.ENDPOINT;
  const route = ep.resolvedPath || ep.pathExpression;
  const params = ep.parameters || [];
  const hf = ep.handlerLocation;
  const conf = ep.confidence;

  const infoRows = [
    ['Method',     `<span class="method ${ep.method.toLowerCase()}" style="display:inline-block;padding:2px 8px;border-radius:3px;font-weight:600">${escHtml(ep.method)}</span>`],
    ['Path',       `<code>${escHtml(route)}</code>`],
    ['Framework',  escHtml(ep.framework)],
    ['Confidence', `<span class="confidence-badge confidence-${conf}">${escHtml(conf)}</span>`],
    ['Handler',    `<code style="cursor:pointer;color:var(--accent-blue)" onclick="navigate('${escAttrOnclick(hf.filePath)}',${hf.line})">${escHtml(shortPath(hf.filePath))}:${hf.line}</code>`],
  ].map(([k, v]) => `<tr><td style="color:var(--text-secondary);width:90px">${k}</td><td>${v}</td></tr>`).join('');

  let paramTable = '';
  if (params.length > 0) {
    const rows = params.map(p => `
      <tr>
        <td><code>${escHtml(p.name)}</code></td>
        <td>${escHtml(p.location)}</td>
        <td>${escHtml(p.type || '—')}</td>
        <td>${p.required ? '<span class="param-required">required</span>' : '<span class="param-optional">optional</span>'}</td>
        <td>${escHtml(p.description || '—')}</td>
      </tr>`).join('');
    paramTable = `
      <div class="doc-section">
        <div class="doc-section-title">Parameters</div>
        <div class="doc-section-body" style="padding:0">
          <table class="doc-table">
            <thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  container.innerHTML = `
    <div class="doc-section">
      <div class="doc-section-title">Endpoint Info</div>
      <div class="doc-section-body" style="padding:0">
        <table class="doc-table"><tbody>${infoRows}</tbody></table>
      </div>
    </div>
    <div class="doc-section">
      <div class="doc-section-title">Description</div>
      <div class="doc-section-body">
        ${ep.description
          ? `<div class="doc-description">${escHtml(ep.description)}</div>`
          : '<div class="doc-no-desc">No description available for this endpoint.</div>'}
      </div>
    </div>
    <div class="doc-section">
      <div class="doc-section-title">HTTP Snippet</div>
      <div class="doc-section-body"><div class="http-snippet">${escHtml(buildHttpSnippet())}</div></div>
    </div>
    ${paramTable}`;
}

function buildHttpSnippet() {
  const ep = window.ENDPOINT;
  const route = ep.resolvedPath || ep.pathExpression;
  const params = ep.parameters || [];
  const qp = params.filter(p => p.location === 'query').map(p => `${p.name}=`).join('&');
  const url = qp ? `${route}?${qp}` : route;
  const headerLines = params.filter(p => p.location === 'header').map(p => `${p.name}: <value>`).join('\n');
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(ep.method.toUpperCase()) || !!ep.requestBody;
  let s = `${ep.method.toUpperCase()} http://localhost:3000${url} HTTP/1.1\nAccept: application/json`;
  if (headerLines) s += `\n${headerLines}`;
  if (hasBody) s += `\nContent-Type: application/json\n\n{}`;
  return s;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function setupSidebar() {
  document.getElementById('close-sidebar')?.addEventListener('click', closeSidebar);
}

function openSidebarForMiddleware(idx) {
  const mw = (window.ENDPOINT.middleware || [])[idx];
  if (!mw) return;
  const short = mw.name.replace(/\\/g, '/').split('/').pop() || mw.name;
  const locHtml = mw.location
    ? `<div class="clickable-file" onclick="navigate('${escAttrOnclick(mw.location.filePath)}',${mw.location.line})">
         <code>${escHtml(shortPath(mw.location.filePath))}</code>
         <span class="line-badge">:${mw.location.line}</span>
       </div>`
    : '<div class="no-params">Location not resolved</div>';

  const params = window.ENDPOINT.parameters || [];
  const paramsHtml = params.length > 0
    ? params.map(p => `
        <div class="param-item">
          <div class="param-item-name">${escHtml(p.name)}</div>
          <div class="param-item-meta">
            <span class="param-item-loc">${p.location}</span>
            ${p.type ? `<span class="param-item-type">${escHtml(p.type)}</span>` : ''}
            ${p.required ? '<span class="param-required">required</span>' : ''}
          </div>
        </div>`).join('')
    : '<div class="no-params">No parameters detected</div>';

  setSidebar(short, `
    <div class="sb-section">
      <div class="sb-section-title">📁 File</div>
      ${locHtml}
    </div>
    <div class="sb-section">
      <div class="sb-section-title">📋 Endpoint Parameters</div>
      ${paramsHtml}
    </div>`);
}

function openSidebarForHandler() {
  const hf = window.ENDPOINT.handlerLocation;
  setSidebar(hf.symbolName || 'Handler', `
    <div class="sb-section">
      <div class="sb-section-title">📁 File</div>
      <div class="clickable-file" onclick="navigate('${escAttrOnclick(hf.filePath)}',${hf.line})">
        <code>${escHtml(shortPath(hf.filePath))}</code>
        <span class="line-badge">:${hf.line}</span>
      </div>
    </div>
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ Info</div>
      <div style="font-size:12px;display:flex;flex-direction:column;gap:4px">
        <div>Framework: <strong>${escHtml(window.ENDPOINT.framework)}</strong></div>
        <div>Confidence: <strong>${escHtml(window.ENDPOINT.confidence)}</strong></div>
        <div>Hint: <strong>double-click tree nodes to open source</strong></div>
      </div>
    </div>`);
}

function openSidebarForComponentNode(filePath, line, kind, hasChildren, metrics) {
  const name = shortPath(filePath);
  const kindText = kindLabel(kind || 'dependency');
  const m = metrics || { reads: 0, writes: 0, data: 0 };
  setSidebar(name || 'Component', `
    <div class="sb-section">
      <div class="sb-section-title">📁 File</div>
      <div class="clickable-file" onclick="navigate('${escAttrOnclick(filePath)}',${line || 1})">
        <code>${escHtml(name)}</code>
        <span class="line-badge">:${line || 1}</span>
      </div>
    </div>
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ Node</div>
      <div style="font-size:12px;display:flex;flex-direction:column;gap:4px">
        <div>Type: <strong>${escHtml(kindText)}</strong></div>
        <div>Has subcomponents: <strong>${hasChildren ? 'yes' : 'no'}</strong></div>
        <div>Reads: <strong>${m.reads}</strong> · Writes: <strong>${m.writes}</strong> · Data: <strong>${m.data}</strong></div>
        <div>Action: <strong>double-click to open source</strong></div>
      </div>
    </div>`);
}

function setSidebar(title, content) {
  document.getElementById('sidebar-title').textContent = title;
  document.getElementById('sidebar-content').innerHTML = content;
  document.getElementById('detail-sidebar').classList.add('open');
}
function closeSidebar() { document.getElementById('detail-sidebar').classList.remove('open'); }

// ── Utilities ─────────────────────────────────────────────────────────────────
function navigate(filePath, line) {
  vscode.postMessage({ command: 'navigateTo', filePath, line: line || 1 });
}
function shortPath(fp) {
  if (!fp) return '';
  return fp.replace(/\\/g, '/').split('/').slice(-2).join('/');
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Safe escape for use inside single-quoted onclick attribute values */
function escAttrOnclick(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}
