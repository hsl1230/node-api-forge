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
  pan: { x: 0, y: 0, dragging: false, startX: 0, startY: 0 },
  expandedNodes: new Set(),
  diagramNodeMeta: {},
  hideSysMiddleware: false,
  docsAccumulatedText: '',
  sidebar: {
    history: [],
    current: null
  },
  lastDiagramClick: { nodeId: null, time: 0 }
};

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  // 'loose' enables the `click nodeId callbackFn` directive so Mermaid wires up
  // click listeners itself after bindFunctions() is called — no DOM id decoding needed.
  securityLevel: 'loose',
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
  renderExternalCalls();
  renderDocumentation();
  setupZoomControls();
  setupSearch();
  setupSidebar();
  setupDiagramExport();
  setupSystemMiddlewareToggle();
  setupDocButtons();
  document.getElementById('search-btn')?.addEventListener('click', onSearchClick);
  document.getElementById('test-btn')?.addEventListener('click', onTestClick);
  document.getElementById('refresh-btn')?.addEventListener('click', onHardRefreshClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
  // Request current doc status from extension host
  vscode.postMessage({ command: 'getDocStatus' });
});

function onSearchClick() {
  vscode.postMessage({ command: 'searchEndpoint' });
}

function onTestClick() {
  vscode.postMessage({ command: 'testEndpoint' });
}

window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;

  if (message.command === 'hardRefreshDone') {
    if (!message.success) {
      const button = document.getElementById('refresh-btn');
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
        button.textContent = button.dataset.originalLabel || '🔄 Refresh Endpoint';
      }
    }
    return;
  }

  if (message.command === 'docStatus') {
    handleDocStatus(message.content || {});
    return;
  }

  if (message.command === 'docGenerating') {
    handleDocGenerating();
    return;
  }

  if (message.command === 'docProgress') {
    handleDocProgress(message.content || {});
    return;
  }

  if (message.command === 'docResult') {
    handleDocResult(message.content || {});
    return;
  }
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
async function renderMermaidDiagram(preserveViewport = false) {
  const viewport = document.getElementById('diagram-viewport');
  if (!viewport) return;
  // Snapshot current pan/zoom before the async render so we can restore it.
  const savedPan = { x: state.pan.x, y: state.pan.y };
  const savedZoom = state.zoom;
  try {
    const model = buildFlowDiagramModel();
    state.diagramNodeMeta = model.nodeMeta;
    // bindFunctions MUST be called after innerHTML is set — Mermaid v11 uses it to
    // attach the click listeners registered via `click nodeId callbackFn` directives.
    const { svg, bindFunctions } = await mermaid.render('flowchart-main', model.source);
    viewport.innerHTML = `<div>${svg}</div>`;
    if (bindFunctions) bindFunctions(viewport);
    setupDiagramPan(document.getElementById('mermaid-diagram'), viewport);
    setupNodeClickHandlers(viewport);
    if (preserveViewport) {
      // Restore pan/zoom so the viewport stays where the user had it.
      state.pan.x = savedPan.x;
      state.pan.y = savedPan.y;
      state.zoom = savedZoom;
      applyTransform(viewport);
    } else {
      setTimeout(centerDiagram, 50);
    }
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
// Called by Mermaid's bindFunctions() for every node that has a `click nodeId onMermaidNodeClick`
// directive.  nodeId is the plain Mermaid ID (e.g. "MW0", "HANDLER", "MW0_C1").
// Using this official mechanism avoids fragile DOM-id decoding.
window.onMermaidNodeClick = function onMermaidNodeClick(nodeId) {
  const meta = state.diagramNodeMeta[nodeId];
  if (!meta) return;

  // Double-click on a collapsible node: toggle expand/collapse only
  const now = Date.now();
  const isDoubleClick = meta.toggleKey
    && nodeId === state.lastDiagramClick.nodeId
    && (now - state.lastDiagramClick.time) < 300;
  state.lastDiagramClick = { nodeId, time: now };

  if (isDoubleClick) {
    toggleExpandedNode(meta.toggleKey);
    renderMermaidDiagram(true); // preserve current pan/zoom
    // fall through — also open the sidebar so the user sees the details
  }

  // Single click (and double-click): open the details sidebar
  if (meta.type === 'handler') {
    openSidebarForHandler();
    return;
  }

  if (meta.type === 'middleware') {
    openSidebarForMiddleware(meta.middlewareIndex);
    return;
  }

  if (meta.type === 'component') {
    openSidebarForComponentNode(meta.filePath, meta.line, meta.kind, meta.hasChildren, meta.metrics);
    return;
  }

  if (meta.type === 'external') {
    openSidebarForExternalCallNode(meta);
  }
};

function setupNodeClickHandlers(viewport) {
  // Cursor styling only — click events are handled by Mermaid's bindFunctions()
  // via the `click nodeId onMermaidNodeClick` directives in the diagram source.
  viewport.querySelectorAll('.node').forEach(node => {
    node.style.cursor = 'pointer';
  });
}

function decodeMermaidNodeId(rawId) {
  if (!rawId) {
    return '';
  }
  // Mermaid v11:  'flowchart-{nodeId}-{counter}'       e.g. 'flowchart-MW0-3'
  // Mermaid v9:   'flowchart-main-{nodeId}-{counter}'  e.g. 'flowchart-main-MW0-3'
  // The chart render name ('flowchart-main') is NOT used as a node-ID prefix in v11.
  const m = rawId.match(/^flowchart-(?:main-)?(.+)-\d+$/);
  if (m && m[1]) {
    return m[1];
  }
  return rawId;
}

function toggleExpandedNode(toggleKey) {
  if (!toggleKey) {
    return;
  }
  if (state.expandedNodes.has(toggleKey)) {
    state.expandedNodes.delete(toggleKey);
  } else {
    state.expandedNodes.add(toggleKey);
  }
}

function buildFlowDiagramModel() {
  const endpoint = window.ENDPOINT || {};
  const graph = window.COMPONENT_GRAPH || {};
  const lines = ['flowchart TD'];
  const nodeMeta = {};
  const hideSysMiddleware = state.hideSysMiddleware === true;

  // Build a lookup map: normalised filePath → ExternalCall[]
  const externalCallsByFile = new Map();
  for (const call of (window.EXTERNAL_CALLS || [])) {
    const fp = normalizeFsPath(call.filePath || '');
    if (!fp) continue;
    if (!externalCallsByFile.has(fp)) externalCallsByFile.set(fp, []);
    externalCallsByFile.get(fp).push(call);
  }

  const route = endpoint.resolvedPath || endpoint.pathExpression || '/';
  const endpointLabel = formatEndpointLabel(endpoint, route);
  const handlerLocation = endpoint.handlerLocation || {};
  const handlerFile = shortPath(handlerLocation.filePath || 'handler');
  const handlerLabel = handlerLocation.symbolName
    ? `${handlerLocation.symbolName}\\n${handlerFile}:${handlerLocation.line || 1}`
    : `${handlerFile}:${handlerLocation.line || 1}`;

  lines.push('    classDef extCall fill:#1a2a3a,color:#63b3ed,stroke:#2c5282,stroke-width:1px,stroke-dasharray:4 2');
  lines.push(`    REQ["${escMermaid(endpointLabel)}"]`);
  lines.push('    style REQ fill:#1e3a5f,color:#90cdf4,stroke:#2b6cb0,stroke-width:2px');
  lines.push(`    HANDLER["${escMermaid(handlerLabel)}"]`);
  lines.push('    style HANDLER fill:#1a3a2a,color:#9ae6b4,stroke:#276749,stroke-width:2px');

  nodeMeta.REQ = { type: 'request' };
  nodeMeta.HANDLER = { type: 'handler' };

  const allMiddleware = endpoint.middleware || [];
  const middleware = hideSysMiddleware
    ? allMiddleware.filter((mw) => !isSystemMiddleware(mw))
    : allMiddleware;

  const handlerPath = normalizeFsPath(handlerLocation.filePath || '');
  const params = endpoint.parameters || [];
  const edgeParts = [
    ...params.filter((p) => p.location === 'path').slice(0, 3).map((p) => `:${p.name}`),
    ...params.filter((p) => p.location === 'query').slice(0, 3).map((p) => `?${p.name}`)
  ].join(', ');

  for (let i = 0; i < middleware.length; i++) {
    const mw = middleware[i] || {};
    const nodeId = `MW${i}`;
    const mwPath = normalizeFsPath(mw.location && mw.location.filePath ? mw.location.filePath : '');
    const directChildren = getGraphChildren(graph, mwPath).filter((child) => child !== handlerPath);
    const hasChildren = directChildren.length > 0;
    const toggleKey = `mw:${nodeId}`;
    const expanded = hasChildren && state.expandedNodes.has(toggleKey);
    const shortName = (mw.name || '').replace(/\\/g, '/').split('/').pop() || (mw.name || `middleware-${i + 1}`);
    const labelPrefix = hasChildren ? (expanded ? '▼ ' : '▶ ') : '';
    const label = `${labelPrefix}${shortName}`;

    lines.push(`    ${nodeId}["${escMermaid(label)}"]`);
    lines.push(`    style ${nodeId} fill:#2d3748,color:#e2e8f0,stroke:#4a5568,stroke-width:1.5px`);

    nodeMeta[nodeId] = {
      type: 'middleware',
      middlewareIndex: i,
      toggleKey: hasChildren ? toggleKey : undefined
    };

    if (expanded) {
      appendComponentSubtree({
        lines,
        nodeMeta,
        graph,
        parentNodeId: nodeId,
        parentToggleKey: toggleKey,
        children: directChildren,
        visited: new Set([mwPath]),
        ancestryToken: nodeId,
        externalCallsByFile
      });
    }

    // Attach external call nodes for this middleware
    const mwCalls = externalCallsByFile.get(mwPath) || [];
    if (mwCalls.length > 0) {
      appendExternalCallNodes(lines, nodeMeta, nodeId, mwCalls);
    }
  }

  // Attach external call nodes for the handler
  if (handlerPath) {
    const handlerCalls = externalCallsByFile.get(handlerPath) || [];
    if (handlerCalls.length > 0) {
      appendExternalCallNodes(lines, nodeMeta, 'HANDLER', handlerCalls);
    }
  }

  const firstNode = middleware.length > 0 ? 'MW0' : 'HANDLER';
  lines.push(edgeParts ? `    REQ -->|"${escMermaid(edgeParts)}"| ${firstNode}` : `    REQ --> ${firstNode}`);
  for (let i = 0; i < middleware.length - 1; i++) {
    lines.push(`    MW${i} --> MW${i + 1}`);
  }
  if (middleware.length > 0) {
    lines.push(`    MW${middleware.length - 1} --> HANDLER`);
  }

  // Add Mermaid `click` directives for every node so bindFunctions() can wire
  // up click listeners after the SVG is inserted.  The callback is the global
  // function `onMermaidNodeClick(nodeId)` defined below.
  for (const nodeId of Object.keys(nodeMeta)) {
    lines.push(`    click ${nodeId} onMermaidNodeClick`);
  }

  return { source: lines.join('\n'), nodeMeta };
}

function appendComponentSubtree(ctx) {
  const { lines, nodeMeta, graph, parentNodeId, parentToggleKey, children, visited, ancestryToken, externalCallsByFile } = ctx;

  children.forEach((childPath, index) => {
    const childKey = `${parentToggleKey}:${childPath}`;
    const childNodeId = `${ancestryToken}_C${index}`;
    const childChildren = getGraphChildren(graph, childPath);
    const hasChildren = childChildren.length > 0;
    const expanded = hasChildren && state.expandedNodes.has(childKey);
    const labelPrefix = hasChildren ? (expanded ? '▼ ' : '▶ ') : '';
    const label = `${labelPrefix}${shortPath(childPath)}`;
    const line = getNodeLine(graph, childPath);
    const kind = getNodeKind(graph, childPath);
    const metrics = getNodeMetrics(graph, childPath);

    lines.push(`    ${childNodeId}["${escMermaid(label)}"]`);
    lines.push(`    style ${childNodeId} fill:#3b2f4a,color:#e9d8fd,stroke:#6b46c1,stroke-width:1.25px`);
    lines.push(`    ${parentNodeId} --> ${childNodeId}`);

    nodeMeta[childNodeId] = {
      type: 'component',
      filePath: childPath,
      line,
      kind,
      metrics,
      hasChildren,
      toggleKey: hasChildren ? childKey : undefined
    };

    // Attach external call nodes for this component
    if (externalCallsByFile) {
      const compCalls = externalCallsByFile.get(normalizeFsPath(childPath)) || [];
      if (compCalls.length > 0) {
        appendExternalCallNodes(lines, nodeMeta, childNodeId, compCalls);
      }
    }

    if (!hasChildren || !expanded || visited.has(childPath)) {
      return;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(childPath);
    appendComponentSubtree({
      lines,
      nodeMeta,
      graph,
      parentNodeId: childNodeId,
      parentToggleKey: childKey,
      children: childChildren,
      visited: nextVisited,
      ancestryToken: childNodeId,
      externalCallsByFile
    });
  });
}

const EXT_CALL_ICONS = { http: '🌐', database: '🗄️', cache: '⚡', queue: '📨', storage: '💾' };

function appendExternalCallNodes(lines, nodeMeta, parentId, calls) {
  calls.forEach((call, idx) => {
    const extId = `${parentId}_EXT${idx}`;
    const icon = EXT_CALL_ICONS[call.type] || '📡';
    const label = `${icon} ${(call.type || 'ext').toUpperCase()}: ${call.client || 'unknown'}`;
    lines.push(`    ${extId}(["${escMermaid(label)}"]):::extCall`);
    lines.push(`    ${parentId} -.-> ${extId}`);
    nodeMeta[extId] = {
      type: 'external',
      filePath: call.filePath,
      line: call.line,
      snippet: call.snippet,
      client: call.client,
      callType: call.type
    };
  });
}

function getGraphChildren(graph, filePath) {
  const childrenByFile = (graph && graph.childrenByFile) || {};
  return childrenByFile[normalizeFsPath(filePath)] || [];
}

function getNodeLine(graph, filePath) {
  const lineByFile = (graph && graph.lineByFile) || {};
  const line = Number(lineByFile[normalizeFsPath(filePath)] || 1);
  return Number.isFinite(line) && line > 0 ? line : 1;
}

function getNodeKind(graph, filePath) {
  const kindByFile = (graph && graph.kindByFile) || {};
  return kindByFile[normalizeFsPath(filePath)] || 'dependency';
}

function getNodeMetrics(graph, filePath) {
  const metricsByFile = (graph && graph.metricsByFile) || {};
  const metrics = metricsByFile[normalizeFsPath(filePath)] || { reads: 0, writes: 0, data: 0 };
  return {
    reads: Number.isFinite(metrics.reads) ? Number(metrics.reads) : 0,
    writes: Number.isFinite(metrics.writes) ? Number(metrics.writes) : 0,
    data: Number.isFinite(metrics.data) ? Number(metrics.data) : 0
  };
}

function normalizeFsPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function formatEndpointLabel(endpoint, route) {
  if (endpoint.displayName && String(endpoint.displayName).trim().length > 0) {
    return String(endpoint.displayName).trim();
  }
  if (endpoint.operationId && String(endpoint.operationId).trim().length > 0) {
    return String(endpoint.operationId).trim();
  }
  return `${endpoint.method || 'GET'} ${route}`;
}

function escMermaid(value) {
  return String(value ?? '').replace(/"/g, '&quot;').replace(/[<>]/g, '');
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
    .map(root => buildComponentNodeHtml(root, graph, state, new Set(), 0))
    .join('');

  container.querySelectorAll('.tree-root-header').forEach((hdr) => {
    hdr.addEventListener('click', (e) => {
      const hasChildren = hdr.dataset.hasChildren === 'true';
      const filePath = hdr.dataset.filepath;
      const line = parseInt(hdr.dataset.line || '1');
      const kind = hdr.dataset.kind || 'dependency';
      const metrics = (state.metricsByPath && state.metricsByPath[filePath]) || { reads: 0, writes: 0, data: 0 };

      // Clicking the toggle arrow always expands/collapses, regardless of single/double click.
      if (e.target.classList.contains('tree-toggle') && hasChildren) {
        const root = hdr.closest('.tree-root');
        const children = root ? root.querySelector(':scope > .tree-children') : null;
        if (children) {
          const open = children.classList.toggle('expanded');
          e.target.textContent = open ? '▼' : '▶';
        }
        return;
      }

      // Single click anywhere else opens the sidebar.
      openSidebarForComponentNode(filePath, line, kind, hasChildren, metrics);
    });

    hdr.addEventListener('dblclick', (e) => {
      const hasChildren = hdr.dataset.hasChildren === 'true';
      const filePath = hdr.dataset.filepath;
      const line = parseInt(hdr.dataset.line || '1');

      // Double-click on the toggle (or anywhere) expands/collapses if node has children,
      // otherwise navigates to source.
      if (hasChildren) {
        const root = hdr.closest('.tree-root');
        const children = root ? root.querySelector(':scope > .tree-children') : null;
        const toggle = hdr.querySelector('.tree-toggle');
        if (children) {
          const open = children.classList.toggle('expanded');
          if (toggle) toggle.textContent = open ? '▼' : '▶';
        }
      } else {
        navigate(filePath, line);
      }
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

function buildComponentNodeHtml(filePath, graph, state, ancestors, depth = 0) {
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

  // Each depth level adds 16px left padding so children appear visually nested
  const paddingLeft = 12 + depth * 16;

  let childHtml = '';
  if (hasChildren) {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(filePath);
    childHtml = `<div class="tree-children">${children.map((childPath) => {
      if (nextAncestors.has(childPath)) {
        const cycleLine = state.lineByPath[childPath] || 1;
        const cycleMetrics = state.metricsByPath[childPath] || { reads: 0, writes: 0, data: 0 };
        const cycleBadgeHtml = buildNodeBadgeHtml(cycleMetrics);
        const cyclePadding = 12 + (depth + 1) * 16;
        return `<div class="tree-root" data-tree-node="${state.idByPath[childPath] || ''}">
          <div class="tree-root-header" style="padding-left:${cyclePadding}px" data-has-children="false" data-kind="dependency" data-filepath="${escAttr(childPath)}" data-line="${cycleLine}">
            <span class="tree-toggle empty">▶</span>
            <span>♻️</span>
            <span class="tree-root-name">${escHtml(shortPath(childPath))}</span>
            <div class="tree-node-badges">${cycleBadgeHtml}</div>
            <span class="tree-leaf-meta">cycle</span>
          </div>
        </div>`;
      }
      return buildComponentNodeHtml(childPath, graph, state, nextAncestors, depth + 1);
    }).join('')}</div>`;
  }

  return `
    <div class="tree-root" data-tree-node="${nodeId}">
      <div class="tree-root-header" style="padding-left:${paddingLeft}px" data-has-children="${hasChildren}" data-kind="${escAttr(kind)}" data-filepath="${escAttr(filePath)}" data-line="${nodeLine}">
        <span class="tree-toggle${hasChildren ? '' : ' empty'}">${hasChildren ? '▶' : '▶'}</span>
        <span>${icon}</span>
        <span class="tree-root-name">${escHtml(displayName)}</span>
        <div class="tree-node-badges">${badgeHtml}</div>
        <span class="tree-leaf-meta">${escHtml(title)}</span>
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
  const dataEvidence = collectEndpointDataLocations(window.ENDPOINT || {});
  const groups = [
    { key: 'path',   icon: '🔑', label: 'Path Parameters',     color: '#dcdcaa' },
    { key: 'query',  icon: '🔍', label: 'Query Parameters',    color: '#9cdcfe' },
    { key: 'body',   icon: '📦', label: 'Request Body Fields', color: '#4ec9b0' },
    { key: 'header', icon: '📋', label: 'Request Headers',     color: '#c586c0' },
    { key: 'cookie', icon: '🍪', label: 'Cookies',             color: '#ce9178' },
    { key: 'locals', icon: '🧠', label: 'res.locals',          color: '#b5cea8' },
  ];

  const paramGroupsHtml = groups.map(g => {
    const items = params.filter(p => p.location === g.key);
    const counts = countParameterReadsWrites(items);
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
          <span class="group-badges">
            <span class="group-badge read" title="Read count">R ${counts.reads}</span>
            <span class="group-badge write" title="Write count">W ${counts.writes}</span>
          </span>
          <span class="param-group-chevron">▶</span>
        </div>
        <div class="param-group-body" style="display:none;">
          ${items.length > 0 ? rows : '<div class="empty-group">None detected</div>'}
        </div>
      </div>`;
  }).join('');

  let html = paramGroupsHtml;

  const rb = window.ENDPOINT.requestBody;
  if (rb) {
    const rbMode = rb.detectionLocation?.accessMode === 'write' ? 'write' : 'read';
    html += `
      <div class="param-group">
        <div class="param-group-header">
          <span>📤</span>
          <span class="param-group-title">Request Body</span>
          <span class="param-group-count">${escHtml(rb.type || 'unknown type')}</span>
          <span class="group-badges">
            <span class="group-badge read" title="Read count">R ${rbMode === 'read' ? 1 : 0}</span>
            <span class="group-badge write" title="Write count">W ${rbMode === 'write' ? 1 : 0}</span>
          </span>
          <span class="param-group-chevron">▶</span>
        </div>
        <div class="param-group-body" style="display:none;">
          <div class="param-row">
            <span class="param-type">${escHtml(rb.type || '')}</span>
            ${rb.schema ? `<span class="param-desc">${escHtml(rb.schema)}</span>` : ''}
            ${rb.required ? '<span class="param-required">required</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  const dataGroupsHtml = renderDetectedDataGroups(dataEvidence);
  html += `
    <div class="param-group">
      <div class="param-group-header">
        <span>🧠</span>
        <span class="param-group-title">Detected Data Usage</span>
        <span class="param-group-count">${dataEvidence.length}</span>
        <span class="group-badges">
          <span class="group-badge read" title="Read count">R ${dataEvidence.filter((d) => d.mode === 'read').length}</span>
          <span class="group-badge write" title="Write count">W ${dataEvidence.filter((d) => d.mode === 'write').length}</span>
        </span>
        <span class="param-group-chevron">▶</span>
      </div>
      <div class="param-group-body" style="display:none;">
        ${dataGroupsHtml}
      </div>
    </div>`;

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

function countParameterReadsWrites(params) {
  let reads = 0;
  let writes = 0;
  (params || []).forEach((param) => {
    const locs = normalizeParameterLocations(param);
    reads += locs.read.length;
    writes += locs.write.length;
  });
  return { reads, writes };
}

function renderDetectedDataGroups(entries) {
  if (!entries || entries.length === 0) {
    return '<div class="empty-group">No data evidence detected</div>';
  }

  const grouped = new Map();
  entries.forEach((entry) => {
    const key = entry.source || 'unknown';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(entry);
  });

  const blocks = [];
  for (const [source, items] of grouped.entries()) {
    const readCount = items.filter((item) => item.mode === 'read').length;
    const writeCount = items.filter((item) => item.mode === 'write').length;
    blocks.push(`
      <div class="param-group nested-param-group">
        <div class="param-group-header">
          <span>📌</span>
          <span class="param-group-title">${escHtml(source)}</span>
          <span class="param-group-count">${items.length}</span>
          <span class="group-badges">
            <span class="group-badge read" title="Read count">R ${readCount}</span>
            <span class="group-badge write" title="Write count">W ${writeCount}</span>
          </span>
          <span class="param-group-chevron">▶</span>
        </div>
        <div class="param-group-body" style="display:none;">
          ${items.map((item) => `
            <div class="param-row data-row" data-name="${escAttr(item.name || source)}">
              <span class="param-name">${escHtml(item.name || 'value')}</span>
              <span class="param-item-loc">${escHtml(item.mode)}</span>
              <div class="clickable-file param-loc-link" onclick="navigate('${escAttrOnclick(item.filePath)}',${item.line})">
                <code>${escHtml(shortPath(item.filePath))}</code>
                <span class="line-badge">:${item.line}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `);
  }

  return blocks.join('');
}

function setupSearch() {
  const input = document.getElementById('property-search');
  if (!input) return;
  let t;
  input.addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(() => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.param-row, .data-row').forEach(row => {
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
  document.getElementById('sidebar-back-btn')?.addEventListener('click', () => {
    goSidebarBack();
  });
  updateSidebarBackButton();
}

function openSidebarForMiddleware(idx) {
  const mw = (window.ENDPOINT.middleware || [])[idx];
  if (!mw) return;
  const graph = window.COMPONENT_GRAPH || {};
  const endpoint = window.ENDPOINT || {};
  const short = mw.name.replace(/\\/g, '/').split('/').pop() || mw.name;
  const mwPath = normalizeFsPath((mw.location && mw.location.filePath) || '');
  const mwLine = Number((mw.location && mw.location.line) || 1);
  const children = mwPath ? getGraphChildren(graph, mwPath) : [];

  const endpointData = collectEndpointDataLocations(endpoint);
  const localData = endpointData.filter((entry) => normalizeFsPath(entry.filePath) === mwPath);
  const localReads = localData.filter((entry) => entry.mode === 'read');
  const localWrites = localData.filter((entry) => entry.mode === 'write');

  setSidebar(short, `
    ${renderSidebarFileSection('📁 File', mwPath, mwLine)}
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ Middleware</div>
      <div class="sb-kv-list">
        <div class="sb-kv"><span>Order</span><strong>${idx + 1}/${(endpoint.middleware || []).length}</strong></div>
        <div class="sb-kv"><span>Name</span><code>${escHtml(mw.name)}</code></div>
        <div class="sb-kv"><span>Sub-components</span><strong>${children.length}</strong></div>
      </div>
    </div>
    ${renderCollapsibleSection('📦 Components', renderFileList(children), children.length > 0, true)}
    ${renderCollapsibleSection('👁️ Input Data', renderDataGroups(localReads), localReads.length > 0, true)}
    ${renderCollapsibleSection('✏️ Output Data', renderDataGroups(localWrites), localWrites.length > 0, true)}
    <div class="sb-section">
      <div class="sb-section-title">🧭 Endpoint Context</div>
      <div class="sb-kv-list">
        <div class="sb-kv"><span>Method</span><strong>${escHtml(endpoint.method || 'GET')}</strong></div>
        <div class="sb-kv"><span>Path</span><code>${escHtml(endpoint.resolvedPath || endpoint.pathExpression || '/')}</code></div>
        <div class="sb-kv"><span>Framework</span><strong>${escHtml(endpoint.framework || 'unknown')}</strong></div>
        <div class="sb-kv"><span>Confidence</span><strong>${escHtml(endpoint.confidence || 'unknown')}</strong></div>
      </div>
    </div>`, { viewKey: `middleware:${idx}` });
}

function openSidebarForHandler() {
  const endpoint = window.ENDPOINT || {};
  const hf = endpoint.handlerLocation || {};
  const handlerPath = normalizeFsPath(hf.filePath || '');
  const handlerLine = Number(hf.line || 1);
  const endpointData = collectEndpointDataLocations(endpoint);
  const localData = endpointData.filter((entry) => normalizeFsPath(entry.filePath) === handlerPath);
  const localReads = localData.filter((entry) => entry.mode === 'read');
  const localWrites = localData.filter((entry) => entry.mode === 'write');
  const middlewareList = endpoint.middleware || [];

  setSidebar(hf.symbolName || 'Handler', `
    ${renderSidebarFileSection('📁 File', handlerPath, handlerLine)}
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ Handler</div>
      <div class="sb-kv-list">
        <div class="sb-kv"><span>Symbol</span><strong>${escHtml(hf.symbolName || 'anonymous')}</strong></div>
        <div class="sb-kv"><span>Framework</span><strong>${escHtml(endpoint.framework || 'unknown')}</strong></div>
        <div class="sb-kv"><span>Confidence</span><strong>${escHtml(endpoint.confidence || 'unknown')}</strong></div>
      </div>
    </div>
    ${renderCollapsibleSection('👁️ Input Data', renderDataGroups(localReads), localReads.length > 0, true)}
    ${renderCollapsibleSection('✏️ Output Data', renderDataGroups(localWrites), localWrites.length > 0, true)}
    ${renderCollapsibleSection(
      '🔗 Middleware Chain',
      middlewareList.length > 0
        ? middlewareList.map((mw, i) => {
            const loc = mw.location || {};
            return `<div class="clickable-file" onclick="navigate('${escAttrOnclick(loc.filePath || '')}',${Number(loc.line || 1)})"><code>${i + 1}. ${escHtml((mw.name || '').replace(/\\/g, '/').split('/').pop() || mw.name || 'middleware')}</code><span class="line-badge">:${Number(loc.line || 1)}</span></div>`;
          }).join('')
        : '<div class="no-params">No middleware detected</div>',
      true,
      true
    )}`, { viewKey: 'handler' });
}

function openSidebarForComponentNode(filePath, line, kind, hasChildren, metrics) {
  const name = shortPath(filePath);
  const kindText = kindLabel(kind || 'dependency');
  const m = metrics || { reads: 0, writes: 0, data: 0 };
  const graph = window.COMPONENT_GRAPH || {};
  const normalizedPath = normalizeFsPath(filePath);
  const children = getGraphChildren(graph, normalizedPath);
  const parents = getGraphParents(graph, normalizedPath);
  const endpointData = collectEndpointDataLocations(window.ENDPOINT || {});
  const localData = endpointData.filter((entry) => normalizeFsPath(entry.filePath) === normalizedPath);
  const localReads = localData.filter((entry) => entry.mode === 'read');
  const localWrites = localData.filter((entry) => entry.mode === 'write');

  setSidebar(name || 'Component', `
    ${renderSidebarFileSection('📁 File', normalizedPath, line || 1)}
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ Component</div>
      <div class="sb-kv-list">
        <div class="sb-kv"><span>Type</span><strong>${escHtml(kindText)}</strong></div>
        <div class="sb-kv"><span>Parents</span><strong>${parents.length}</strong></div>
        <div class="sb-kv"><span>Children</span><strong>${children.length}</strong></div>
        <div class="sb-kv"><span>Reads / Writes / Data</span><strong>${m.reads} / ${m.writes} / ${m.data}</strong></div>
      </div>
    </div>
    ${renderCollapsibleSection('⬆️ Parents', renderFileList(parents), parents.length > 0, false)}
    ${renderCollapsibleSection('⬇️ Sub-components', renderFileList(children), children.length > 0, true)}
    ${renderCollapsibleSection('👁️ Input Data', renderDataGroups(localReads), localReads.length > 0, true)}
    ${renderCollapsibleSection('✏️ Output Data', renderDataGroups(localWrites), localWrites.length > 0, true)}
  `, { viewKey: `component:${normalizedPath}` });
}

function openSidebarForExternalCallNode(meta) {
  const icons = { http: '🌐', database: '🗄️', cache: '⚡', queue: '📨', storage: '💾' };
  const icon = icons[meta.callType] || '📡';
  const typeLabel = (meta.callType || 'external').toUpperCase();
  const title = `${icon} ${typeLabel}: ${meta.client || 'unknown'}`;

  setSidebar(title, `
    ${renderSidebarFileSection('📁 Detected In', meta.filePath, meta.line || 1)}
    <div class="sb-section">
      <div class="sb-section-title">ℹ️ External Call</div>
      <div class="sb-kv-list">
        <div class="sb-kv"><span>Type</span><strong>${escHtml(typeLabel)}</strong></div>
        <div class="sb-kv"><span>Client</span><strong>${escHtml(meta.client || 'unknown')}</strong></div>
        <div class="sb-kv"><span>Line</span><strong>${Number(meta.line || 1)}</strong></div>
      </div>
    </div>
    ${meta.snippet ? `<div class="sb-section">
      <div class="sb-section-title">💬 Snippet</div>
      <pre class="sb-snippet">${escHtml(meta.snippet)}</pre>
    </div>` : ''}
  `, { viewKey: `external:${meta.filePath}:${meta.line}` });
}

function renderSidebarFileSection(title, filePath, line) {
  if (!filePath) {
    return `<div class="sb-section"><div class="sb-section-title">${title}</div><div class="no-params">Location not resolved</div></div>`;
  }

  return `<div class="sb-section">
    <div class="sb-section-title">${title}</div>
    <div class="clickable-file" onclick="navigate('${escAttrOnclick(filePath)}',${Number(line || 1)})">
      <code>${escHtml(shortPath(filePath))}</code>
      <span class="line-badge">:${Number(line || 1)}</span>
    </div>
  </div>`;
}

function renderCollapsibleSection(title, content, hasContent, openByDefault) {
  const body = hasContent ? content : '<div class="no-params">None</div>';
  return `<details class="sb-collapsible" ${openByDefault ? 'open' : ''}>
    <summary>${escHtml(title)}</summary>
    <div class="sb-collapsible-body">${body}</div>
  </details>`;
}

function renderFileList(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return '<div class="no-params">None</div>';
  }

  return filePaths.map((fp) => {
    const line = getNodeLine(window.COMPONENT_GRAPH || {}, fp);
    return `<div class="clickable-file" onclick="navigate('${escAttrOnclick(fp)}',${line})">
      <code>${escHtml(shortPath(fp))}</code>
      <span class="line-badge">:${line}</span>
    </div>`;
  }).join('');
}

function renderDataGroups(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '<div class="no-params">No local data evidence for this node</div>';
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = entry.source || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }

  const sections = [];
  for (const [source, items] of groups.entries()) {
    const rows = items.map((item) => `<div class="clickable-file" onclick="navigate('${escAttrOnclick(item.filePath)}',${item.line})">
      <code>${escHtml(item.name || 'value')}</code>
      <span class="param-item-loc">${escHtml(source)}</span>
      <span class="line-badge">:${item.line}</span>
    </div>`).join('');
    sections.push(`<div class="sb-data-group"><div class="sb-data-group-title">${escHtml(source)} (${items.length})</div>${rows}</div>`);
  }

  return sections.join('');
}

function collectEndpointDataLocations(endpoint) {
  const rows = [];
  const params = endpoint.parameters || [];
  for (const p of params) {
    const norm = normalizeParameterLocations(p);
    const source = p.location === 'locals' ? 'res.locals' : `req.${p.location}`;
    norm.read.forEach((loc) => rows.push({ source, name: p.name, mode: 'read', filePath: loc.filePath, line: loc.line }));
    norm.write.forEach((loc) => rows.push({ source, name: p.name, mode: 'write', filePath: loc.filePath, line: loc.line }));
  }

  const requestBody = endpoint.requestBody;
  if (requestBody && requestBody.detectionLocation && requestBody.detectionLocation.filePath) {
    rows.push({
      source: 'req.body',
      name: requestBody.schema || requestBody.type || 'requestBody',
      mode: (requestBody.detectionLocation.accessMode === 'write' ? 'write' : 'read'),
      filePath: requestBody.detectionLocation.filePath,
      line: Number(requestBody.detectionLocation.line || 1)
    });
  }

  const cookies = endpoint.cookies || [];
  for (const c of cookies) {
    if (!c.detectionLocation || !c.detectionLocation.filePath) continue;
    const fallback = c.type === 'response' ? 'write' : 'read';
    rows.push({
      source: c.type === 'response' ? 'res.cookie' : 'req.cookie',
      name: c.name,
      mode: c.detectionLocation.accessMode === 'write' ? 'write' : (c.detectionLocation.accessMode === 'read' ? 'read' : fallback),
      filePath: c.detectionLocation.filePath,
      line: Number(c.detectionLocation.line || 1)
    });
  }

  const responses = endpoint.responses || [];
  for (const response of responses) {
    const headers = response.headers || [];
    for (const header of headers) {
      if (!header.detectionLocation || !header.detectionLocation.filePath) continue;
      rows.push({
        source: 'res.header',
        name: header.name,
        mode: header.detectionLocation.accessMode === 'read' ? 'read' : 'write',
        filePath: header.detectionLocation.filePath,
        line: Number(header.detectionLocation.line || 1)
      });
    }
  }

  return dedupeDataRows(rows);
}

function dedupeDataRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${normalizeFsPath(row.filePath)}:${row.line}:${row.mode}:${row.source}:${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, filePath: normalizeFsPath(row.filePath), line: Number(row.line || 1) });
  }
  return out;
}

function getGraphParents(graph, filePath) {
  const target = normalizeFsPath(filePath);
  const byFile = (graph && graph.childrenByFile) || {};
  const parents = [];
  Object.keys(byFile).forEach((parent) => {
    const children = byFile[parent] || [];
    if (children.includes(target)) {
      parents.push(parent);
    }
  });
  return parents;
}

function setSidebar(title, content, options = {}) {
  const { viewKey = title, fromHistory = false } = options;

  if (!fromHistory && state.sidebar.current) {
    state.sidebar.history.push(state.sidebar.current);
  }

  state.sidebar.current = { title, content, viewKey };
  renderSidebarHeader();
  document.getElementById('sidebar-content').innerHTML = content;
  document.getElementById('detail-sidebar').classList.add('open');
  updateSidebarBackButton();
}

function goSidebarBack() {
  if (state.sidebar.history.length === 0) {
    return;
  }

  const previous = state.sidebar.history.pop();
  if (!previous) {
    return;
  }

  setSidebar(previous.title, previous.content, { viewKey: previous.viewKey, fromHistory: true });
}

function updateSidebarBackButton() {
  const backBtn = document.getElementById('sidebar-back-btn');
  if (!(backBtn instanceof HTMLButtonElement)) {
    return;
  }

  const hasHistory = state.sidebar.history.length > 0;
  backBtn.disabled = !hasHistory;
  backBtn.title = hasHistory ? 'Back' : 'No previous view';
}

function renderSidebarHeader() {
  const titleEl = document.getElementById('sidebar-title');
  const breadcrumbEl = document.getElementById('sidebar-breadcrumb');
  if (!titleEl || !breadcrumbEl) {
    return;
  }

  const currentTitle = (state.sidebar.current && state.sidebar.current.title) || 'Detail';
  titleEl.textContent = currentTitle;

  const fullTrail = [...state.sidebar.history.map((item) => item.title), currentTitle];
  const trail = fullTrail.length > 4 ? ['...', ...fullTrail.slice(-4)] : fullTrail;
  breadcrumbEl.textContent = trail.join(' > ');
}

function closeSidebar() {
  document.getElementById('detail-sidebar').classList.remove('open');
}

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

// ── System Middleware detection ───────────────────────────────────────────────
const SYSTEM_MIDDLEWARE_NAMES = new Set([
  'cors', 'helmet', 'morgan', 'compression', 'bodyparser', 'body-parser',
  'cookieparser', 'cookie-parser', 'methodoverride', 'method-override',
  'express-session', 'session', 'csurf', 'csrf', 'serve-static',
  'multer', 'busboy', 'express-validator', 'celebrate', 'joi',
  'passport', 'passport-local', 'express-rate-limit', 'rate-limit',
  'hpp', 'express-mongo-sanitize', 'xss-clean', 'express-fileupload'
]);

function isSystemMiddleware(mw) {
  const name = String(mw.name || '').toLowerCase().replace(/\\/g, '/');
  const shortName = name.split('/').pop() || name;
  if (name.includes('node_modules')) return true;

  // Check if the middleware file lives under a registered library root
  // (packages listed in nodeApiForge.searchComponentLibAllowlist that may be
  // cloned locally rather than installed in node_modules)
  const mwFilePath = normalizeFsPath((mw.location && mw.location.filePath) || '');
  const libRoots = window.SYS_MW_LIB_ROOTS || [];
  if (mwFilePath && libRoots.some(root => mwFilePath.startsWith(normalizeFsPath(root) + '/'))) {
    return true;
  }

  const baseName = shortName.replace(/\.\w+$/, '');
  return SYSTEM_MIDDLEWARE_NAMES.has(baseName) || SYSTEM_MIDDLEWARE_NAMES.has(name);
}

function setupSystemMiddlewareToggle() {
  const checkbox = document.getElementById('hide-sys-middleware');
  if (!(checkbox instanceof HTMLInputElement)) return;
  checkbox.addEventListener('change', () => {
    state.hideSysMiddleware = checkbox.checked;
    renderMermaidDiagram();
  });
}

// ── SVG / PNG Export ──────────────────────────────────────────────────────────
function setupDiagramExport() {
  document.getElementById('export-svg-btn')?.addEventListener('click', exportSvg);
  document.getElementById('export-png-btn')?.addEventListener('click', exportPng);
}

function exportSvg() {
  const svgEl = document.querySelector('#diagram-viewport svg');
  if (!svgEl) { alert('No diagram to export yet.'); return; }
  const content = new XMLSerializer().serializeToString(svgEl);
  vscode.postMessage({ command: 'exportSvg', content });
}

function exportPng() {
  const svgEl = document.querySelector('#diagram-viewport svg');
  if (!svgEl) { alert('No diagram to export yet.'); return; }

  const svgData = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const scale = window.devicePixelRatio || 2;
    canvas.width = (img.width || 800) * scale;
    canvas.height = (img.height || 600) * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const content = canvas.toDataURL('image/png');
    vscode.postMessage({ command: 'exportPng', content });
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('PNG export failed.'); };
  img.src = url;
}

// ── External Calls tab ────────────────────────────────────────────────────────
function renderExternalCalls() {
  const container = document.getElementById('ext-calls-list');
  if (!container) return;

  const calls = window.EXTERNAL_CALLS || [];
  if (calls.length === 0) {
    container.innerHTML = '<div class="empty-group" style="padding:20px;color:var(--text-muted)">No external calls detected in the component tree.</div>';
    return;
  }

  const typeGroups = new Map();
  calls.forEach(call => {
    if (!typeGroups.has(call.type)) typeGroups.set(call.type, []);
    typeGroups.get(call.type).push(call);
  });

  const typeIcons = { http: '🌐', database: '🗄️', cache: '⚡', queue: '📨', storage: '📦' };
  const typeLabels = { http: 'HTTP Calls', database: 'Database Queries', cache: 'Cache Access', queue: 'Message Queue', storage: 'Cloud Storage' };

  const html = Array.from(typeGroups.entries()).map(([type, items]) => {
    const icon = typeIcons[type] || '📡';
    const label = typeLabels[type] || type.toUpperCase();
    const rows = items.map(call => `
      <div class="param-row ext-call-row" data-file="${escAttr(call.filePath)}" data-client="${escAttr(call.client)}">
        <span class="param-name" style="color:#9cdcfe">${escHtml(call.client)}</span>
        <span class="param-type" style="font-family:monospace;font-size:11px">${escHtml(shortPath(call.filePath))}:${call.line}</span>
        <span class="param-desc" style="font-family:monospace;font-size:11px;color:var(--text-muted)">${escHtml(call.snippet)}</span>
        <span style="cursor:pointer;color:var(--accent-blue);font-size:11px" onclick="navigate('${escAttrOnclick(call.filePath)}',${call.line})">→ open</span>
      </div>`).join('');
    return `
      <div class="param-group">
        <div class="param-group-header">
          <span>${icon}</span>
          <span class="param-group-title">${label}</span>
          <span class="param-group-count">${items.length}</span>
          <span class="param-group-chevron">▶</span>
        </div>
        <div class="param-group-body" style="display:none;">${rows}</div>
      </div>`;
  }).join('');

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

  const filterInput = document.getElementById('ext-call-filter');
  filterInput?.addEventListener('input', () => {
    const q = (filterInput.value || '').toLowerCase();
    container.querySelectorAll('.ext-call-row').forEach(row => {
      const file = (row.dataset.file || '').toLowerCase();
      const client = (row.dataset.client || '').toLowerCase();
      row.style.display = (!q || file.includes(q) || client.includes(q)) ? '' : 'none';
    });
  });
}

// ── AI Documentation Generation ───────────────────────────────────────────────
function setupDocButtons() {
  document.getElementById('generate-doc-btn')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'generateDoc' });
  });
  document.getElementById('open-doc-file-btn')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'openDocFile' });
  });
}

function handleDocStatus(content) {
  const statusEl  = document.getElementById('doc-status');
  const summaryEl = document.getElementById('doc-summary');
  const contentEl = document.getElementById('doc-content');
  const openBtn   = document.getElementById('open-doc-file-btn');
  const genBtn    = document.getElementById('generate-doc-btn');

  if (content.exists) {
    if (statusEl)  { statusEl.style.display  = 'none'; }
    if (summaryEl) {
      summaryEl.style.display = 'block';
      summaryEl.innerHTML = `<div class="doc-summary-box"><strong>Summary:</strong> ${escHtml(content.summary || '')}</div>`;
    }
    if (contentEl) {
      contentEl.style.display = 'block';
      contentEl.innerHTML = renderMarkdown(content.doc || '');
    }
    if (openBtn) { openBtn.style.display = 'inline-flex'; }
    if (genBtn)  {
      genBtn.textContent = '🔄 Regenerate';
      genBtn.disabled = false;
    }
  } else {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = content.hasCopilot === false
        ? `<div class="doc-empty-state">
            <p>No documentation generated yet.</p>
            <p class="doc-hint">GitHub Copilot is required to generate documentation.</p>
          </div>`
        : `<div class="doc-empty-state">
            <p>No documentation generated yet for this endpoint.</p>
            <p class="doc-hint">Click <strong>✨ Generate</strong> to create documentation using Copilot.</p>
          </div>`;
    }
    if (summaryEl) { summaryEl.style.display = 'none'; }
    if (contentEl) { contentEl.style.display = 'none'; }
    if (openBtn)   { openBtn.style.display = 'none'; }
    if (genBtn)    { genBtn.textContent = '✨ Generate'; genBtn.disabled = false; }
  }
}

function handleDocGenerating() {
  const statusEl  = document.getElementById('doc-status');
  const contentEl = document.getElementById('doc-content');
  const genBtn    = document.getElementById('generate-doc-btn');

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div class="doc-loading-state">
        <div class="loading-spinner"></div>
        <p>Generating documentation with Copilot...</p>
        <p class="doc-hint">This may take a moment — multi-phase analysis in progress.</p>
        <div id="doc-progress-log" class="doc-progress-log"></div>
      </div>`;
  }
  if (contentEl) { contentEl.style.display = 'none'; }
  if (genBtn instanceof HTMLButtonElement) {
    genBtn.disabled = true;
    genBtn.textContent = '⏳ Generating…';
  }
}

function handleDocProgress(content) {
  const logEl = document.getElementById('doc-progress-log');
  if (!logEl) return;

  const step   = content.step   || '';
  const detail = content.detail || '';

  let stepClass = 'step';
  if (step.startsWith('Phase') || step.startsWith('Step')) { stepClass = 'step phase'; }
  else if (step.includes('✓')) { stepClass = 'step success'; }
  else if (step.includes('⚠')) { stepClass = 'step warn'; }
  else if (step.includes('✗')) { stepClass = 'step error'; }

  const line = document.createElement('div');
  line.className = 'doc-progress-line';
  line.innerHTML =
    `<span class="${stepClass}">${escHtml(step)}</span>` +
    (detail ? `<span class="detail"> — ${escHtml(detail)}</span>` : '');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function handleDocResult(content) {
  const genBtn = document.getElementById('generate-doc-btn');
  if (genBtn instanceof HTMLButtonElement) {
    genBtn.disabled = false;
    genBtn.textContent = content.exists ? '🔄 Regenerate' : '✨ Generate';
  }
  if (content.exists) {
    handleDocStatus(content);
  } else {
    const statusEl = document.getElementById('doc-status');
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = `<div class="doc-error-state"><p>⚠️ ${escHtml(content.error || 'Failed to generate documentation.')}</p></div>`;
    }
  }
}

/**
 * Simple markdown-to-HTML renderer.
 */
function renderMarkdown(md) {
  if (!md) return '';
  let html = md
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="doc-code-block"><code>$2</code></pre>')
    .replace(/^---+$/gm, '<hr class="doc-hr">')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="doc-inline-code">$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Process complete markdown tables as a block: header row + separator + body rows.
    // Doing this in one pass avoids blank lines from empty separator replacements.
    .replace(/^(\|.+\|)[ \t]*\n\|[-| :]+\|[ \t]*\n((?:\|.+\|[ \t]*\n?)*)/gm, (_match, headerRow, bodyRows) => {
      const headers = headerRow.replace(/^\||\|$/g, '').split('|').map(c => `<td>${c.trim()}</td>`).join('');
      const rows = bodyRows.trim().split('\n').filter(Boolean).map(row => {
        const cells = row.replace(/^\||\|$/g, '').split('|').map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<table class="doc-table"><tr>${headers}</tr>${rows}</table>`;
    })
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    .replace(/\n+((<\/?(?:h[1-4]|table|ul|pre|div|hr)>)|$)/g, '$1')
    .replace(/((<\/?(?:h[1-4]|table|ul|pre|div|hr)>))\n+/g, '$1')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/<p>\s*<\/p>/g, '');
  return `<div class="doc-rendered"><p>${html}</p></div>`;
}
