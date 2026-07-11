import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getNodeApiForgeExternalCallLibraries,
  getNodeApiForgeSearchComponentLibAllowlist,
  resolveNodeApiForgeWorkspaceRoot
} from '../config/project-config';
import { detectExternalCalls, ExternalCall, ExternalCallLibraryConfig } from '../discovery/analyzer/external-call-analyzer';
import { formatEndpointDisplayLabel } from '../discovery/endpoint-display';
import { ApiEndpoint, SourceLocation } from '../discovery/types';
import {
  generateEndpointDoc,
  getDocFilePath,
  getExistingDoc
} from '../services/endpoint-doc-service';

interface PathAliasEntry {
  key: string;
  targets: string[];
  baseDirectory: string;
}

interface ComponentGraphPayload {
  rootFiles: string[];
  childrenByFile: Record<string, string[]>;
  kindByFile: Record<string, 'handler' | 'middleware' | 'detected' | 'dependency'>;
  lineByFile: Record<string, number>;
  metricsByFile: Record<string, { reads: number; writes: number; data: number }>;
}

interface ComponentTraversalResult {
  files: string[];
  edges: Array<{ from: string; to: string }>;
}

const PATH_ALIAS_CACHE = new Map<string, PathAliasEntry[]>();

/**
 * FlowDiagramPanel – multi-tab request-flow visualizer for a discovered endpoint.
 *
 * Tabs (mirroring AGL Flow Analyzer, minus External Calls and Configuration):
 *   1. ➡️  Flow Diagram   – Mermaid flowchart with zoom/pan/drag
 *   2. 🔗  Middleware Chain – ordered list with file links
 *   3. 🌳  Component Tree  – endpoint → middleware → handler hierarchy
 *   4. 🔄  Data Flow       – parameters grouped by source type
 *   5. 📄  Documentation   – description + HTTP snippet + parameter table
 */
export class FlowDiagramPanel {
  private static readonly VIEW_TYPE = 'nodeApiForge.flowDiagram';
  private readonly panel: vscode.WebviewPanel;
  private readonly resourceRoot: vscode.Uri;
  private readonly onHardRefresh?: (endpoint: ApiEndpoint) => Promise<ApiEndpoint | undefined>;
  private endpoint: ApiEndpoint;
  private disposables: vscode.Disposable[] = [];
  private docsAbortController?: vscode.CancellationTokenSource;
  private projectRoots: string[];

  private constructor(
    panel: vscode.WebviewPanel,
    endpoint: ApiEndpoint,
    resourceRoot: vscode.Uri,
    onHardRefresh?: (endpoint: ApiEndpoint) => Promise<ApiEndpoint | undefined>,
    projectRoots: string[] = []
  ) {
    this.panel = panel;
    this.endpoint = endpoint;
    this.resourceRoot = resourceRoot;
    this.onHardRefresh = onHardRefresh;
    this.projectRoots = projectRoots;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; filePath?: string; line?: number; content?: string; format?: string }) => {
        if (msg.command === 'navigateTo' && msg.filePath) {
          await navigateToSource(msg.filePath, msg.line ?? 1);
          return;
        }

        if (msg.command === 'hardRefresh') {
          await this.handleHardRefresh();
          return;
        }

        if (msg.command === 'searchEndpoint') {
          await this.handleSearchEndpoint();
          return;
        }

        if (msg.command === 'testEndpoint') {
          await this.handleTestEndpoint();
          return;
        }

        if (msg.command === 'generateDoc') {
          await this.handleGenerateDoc();
          return;
        }

        if (msg.command === 'openDocFile') {
          await this.handleOpenDocFile();
          return;
        }

        if (msg.command === 'getDocStatus') {
          this.handleGetDocStatus();
          return;
        }

        if (msg.command === 'exportSvg' && msg.content) {
          await this.handleExportDiagram(msg.content, 'svg');
          return;
        }

        if (msg.command === 'exportPng' && msg.content) {
          await this.handleExportDiagram(msg.content, 'png');
        }
      },
      null,
      this.disposables
    );
  }

  public static show(
    endpoint: ApiEndpoint,
    extensionUri: vscode.Uri,
    onHardRefresh?: (endpoint: ApiEndpoint) => Promise<ApiEndpoint | undefined>,
    projectRoots: string[] = []
  ): FlowDiagramPanel {
    const title = `Flow: ${formatEndpointDisplayLabel(endpoint)}`;
    const resourceRoot = vscode.Uri.joinPath(extensionUri, 'resources', 'features', 'flow-analyzer');
    const panel = vscode.window.createWebviewPanel(
      FlowDiagramPanel.VIEW_TYPE,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [resourceRoot]
      }
    );
    const instance = new FlowDiagramPanel(panel, endpoint, resourceRoot, onHardRefresh, projectRoots);
    instance.render();
    return instance;
  }

  private render(): void {
    this.panel.webview.html = buildWebviewHtml(this.endpoint, this.panel.webview, this.resourceRoot);
  }

  private async handleHardRefresh(): Promise<void> {
    if (!this.onHardRefresh) {
      await this.panel.webview.postMessage({ command: 'hardRefreshDone', success: false });
      return;
    }

    try {
      const refreshedEndpoint = await this.onHardRefresh(this.endpoint);
      if (!refreshedEndpoint) {
        await this.panel.webview.postMessage({ command: 'hardRefreshDone', success: false });
        vscode.window.showWarningMessage('Node API Forge: Full refresh completed, but the endpoint could not be rematched.');
        return;
      }

      this.endpoint = refreshedEndpoint;
      this.panel.title = `Flow: ${formatEndpointDisplayLabel(refreshedEndpoint)}`;
      this.render();
    } catch (error) {
      await this.panel.webview.postMessage({ command: 'hardRefreshDone', success: false });
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Node API Forge: Hard refresh failed (${message}).`);
    }
  }

  private async handleSearchEndpoint(): Promise<void> {
    const route = this.endpoint.resolvedPath ?? this.endpoint.pathExpression;
    const handlerSymbol = this.endpoint.handlerLocation.symbolName;
    const query = route && !route.includes('${') ? route : (handlerSymbol ?? this.endpoint.pathExpression);
    const relatedFiles = collectRelatedComponentFiles(this.endpoint);
    const filesToInclude = toFindInFilesIncludePattern(relatedFiles);

    await vscode.commands.executeCommand('workbench.action.findInFiles', {
      query,
      filesToInclude,
      isRegexp: false,
      triggerSearch: true
    });
  }

  private async handleTestEndpoint(): Promise<void> {
    await vscode.commands.executeCommand('nodeApiForge.openEndpointInHttpForge', this.endpoint);
  }

  /** Return the project root that should be used for doc storage. */
  private resolveProjectRootForDocs(): string | undefined {
    const handlerPath = this.endpoint.handlerLocation.filePath;

    // First priority: walk up from the handler file to find the nearest package.json.
    // This always finds the correct sub-project boundary (e.g. agl-recording-middleware/).
    let dir = path.dirname(handlerPath);
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Second priority: use the projectRoot stamped by the discovery engine.
    // Useful when no package.json exists but includeProjectRoots is explicitly configured.
    if (this.endpoint.projectRoot) return this.endpoint.projectRoot;

    // Third priority: match against the discovery-context project roots.
    if (this.projectRoots.length > 0) {
      let bestMatch: string | undefined;
      const normalizedHandler = handlerPath.replace(/\\/g, '/');
      for (const root of this.projectRoots) {
        const normalizedRoot = root.replace(/\\/g, '/');
        if (normalizedHandler === normalizedRoot || normalizedHandler.startsWith(`${normalizedRoot}/`)) {
          if (!bestMatch || normalizedRoot.length > bestMatch.length) {
            bestMatch = root;
          }
        }
      }
      if (bestMatch) return bestMatch;
    }

    // Last resort: VS Code workspace folder
    const handlerUri = vscode.Uri.file(handlerPath);
    return vscode.workspace.getWorkspaceFolder(handlerUri)?.uri.fsPath;
  }

  private handleGetDocStatus(): void {
    const projectRoot = this.resolveProjectRootForDocs();
    const ep = this.endpoint;
    const route = ep.resolvedPath ?? ep.pathExpression;
    const existing = projectRoot ? getExistingDoc(projectRoot, ep.method, route) : undefined;

    this.panel.webview.postMessage({
      command: 'docStatus',
      content: {
        exists: !!existing,
        summary: existing?.summary,
        doc: existing?.doc,
        hasCopilot: true, // checked lazily during generation
      },
    });
  }

  private async handleGenerateDoc(): Promise<void> {
    this.docsAbortController?.cancel();
    this.docsAbortController = new vscode.CancellationTokenSource();

    const projectRoot = this.resolveProjectRootForDocs();
    if (!projectRoot) {
      await this.panel.webview.postMessage({
        command: 'docResult',
        content: { exists: false, error: 'Could not determine project root for doc storage.' },
      });
      return;
    }

    await this.panel.webview.postMessage({ command: 'docGenerating' });

    const report = (step: string, detail?: string) => {
      this.panel.webview.postMessage({
        command: 'docProgress',
        content: { step, detail: detail ?? '', timestamp: Date.now() },
      });
    };

    // Collect component files for this endpoint
    const componentFiles = this.collectAllComponentFiles();

    try {
      const ep = this.endpoint;
      const result = await generateEndpointDoc(ep, componentFiles, projectRoot, report);
      if (result) {
        await this.panel.webview.postMessage({
          command: 'docResult',
          content: { exists: true, summary: result.summary, doc: result.doc },
        });
        // Sync the generated doc to any matching HTTP Forge collection request.
        try {
          await vscode.commands.executeCommand(
            'nodeApiForge.syncDocToHttpForge',
            ep,
            result.doc,
            result.summary
          );
          report('  ✓ Synced to HTTP Forge collection');
        } catch {
          // HTTP Forge may not be installed — ignore silently
        }
      } else {
        await this.panel.webview.postMessage({
          command: 'docResult',
          content: { exists: false, error: 'Doc generation returned no result. Check progress log for details.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.panel.webview.postMessage({
        command: 'docResult',
        content: { exists: false, error: message },
      });
    }
  }

  private async handleOpenDocFile(): Promise<void> {
    const projectRoot = this.resolveProjectRootForDocs();
    if (!projectRoot) return;
    const ep = this.endpoint;
    const route = ep.resolvedPath ?? ep.pathExpression;
    const filePath = getDocFilePath(projectRoot, ep.method, route);
    if (!fs.existsSync(filePath)) {
      vscode.window.showWarningMessage('Documentation file not found. Generate it first.');
      return;
    }
    const uri = vscode.Uri.file(filePath);
    await vscode.window.showTextDocument(uri);
  }

  /** Collect all unique source files in the endpoint's component tree. */
  private collectAllComponentFiles(): string[] {
    const ep = this.endpoint;
    const seen = new Set<string>();
    const add = (fp: string | undefined) => { if (fp) seen.add(fp); };
    add(ep.handlerLocation.filePath);
    (ep.middleware ?? []).forEach(m => add(m.location?.filePath));
    const rootFiles = collectComponentRootFiles(ep);
    const allowlistedLibraries = getSearchAllowlistedLibraries();
    const traversal = collectComponentTraversal(rootFiles, allowlistedLibraries);
    traversal.files.forEach(f => add(f));
    return [...seen];
  }

  private async handleExportDiagram(content: string, format: 'svg' | 'png'): Promise<void> {
    const defaultName = `flow-diagram.${format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: format === 'svg'
        ? { 'SVG Image': ['svg'] }
        : { 'PNG Image': ['png'] }
    });

    if (!uri) return;

    if (format === 'svg') {
      const buffer = Buffer.from(content, 'utf8');
      await vscode.workspace.fs.writeFile(uri, buffer);
    } else {
      // PNG comes as base64 data URL: "data:image/png;base64,..."
      const base64 = content.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      await vscode.workspace.fs.writeFile(uri, buffer);
    }

    vscode.window.showInformationMessage(`Flow diagram exported to ${uri.fsPath}`);
  }

  private dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

// ─── Source navigation ────────────────────────────────────────────────────────

async function navigateToSource(filePath: string, line: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    const pos = new vscode.Position(Math.max(line - 1, 0), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch { /* inaccessible file – ignore */ }
}

// ─── Mermaid diagram ──────────────────────────────────────────────────────────

function buildMermaidDiagram(endpoint: ApiEndpoint): string {
  const lines: string[] = ['flowchart TD'];
  const route = endpoint.resolvedPath ?? endpoint.pathExpression;
  const label = formatEndpointDisplayLabel(endpoint) ?? (endpoint.method + ' ' + route);

  lines.push(`    REQ["${esc(label)}"]`);
  lines.push(`    style REQ fill:#1e3a5f,color:#90cdf4,stroke:#2b6cb0,stroke-width:2px`);

  const hf = endpoint.handlerLocation;
  const hFile = path.basename(hf.filePath);
  const hLabel = hf.symbolName ? `${hf.symbolName}\\n${hFile}:${hf.line}` : `${hFile}:${hf.line}`;
  lines.push(`    HANDLER["${esc(hLabel)}"]`);
  lines.push(`    style HANDLER fill:#1a3a2a,color:#9ae6b4,stroke:#276749,stroke-width:2px`);

  const mwNodes = endpoint.middleware.map((mw, idx) => {
    const short = mw.name.replace(/\\/g, '/').split('/').pop() ?? mw.name;
    return { id: `MW${idx}`, label: short };
  });
  for (const n of mwNodes) { lines.push(`    ${n.id}["${esc(n.label)}"]`); }

  const params = endpoint.parameters ?? [];
  const edgeParts = [
    ...params.filter((p) => p.location === 'path').slice(0, 3).map((p) => `:${p.name}`),
    ...params.filter((p) => p.location === 'query').slice(0, 3).map((p) => `?${p.name}`)
  ].join(', ');

  const first = mwNodes.length > 0 ? mwNodes[0].id : 'HANDLER';
  lines.push(edgeParts ? `    REQ -->|"${esc(edgeParts)}"| ${first}` : `    REQ --> ${first}`);
  for (let i = 0; i < mwNodes.length - 1; i++) { lines.push(`    ${mwNodes[i].id} --> ${mwNodes[i + 1].id}`); }
  if (mwNodes.length > 0) { lines.push(`    ${mwNodes[mwNodes.length - 1].id} --> HANDLER`); }

  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/[<>]/g, '');
}

function collectRelatedComponentFiles(endpoint: ApiEndpoint): string[] {
  const rootFiles = collectComponentRootFiles(endpoint);
  const allowlistedLibraries = getSearchAllowlistedLibraries();
  return collectComponentTreeFiles(rootFiles, allowlistedLibraries);
}

function collectComponentRootFiles(endpoint: ApiEndpoint): string[] {
  // Roots are middleware (in registration order) then handler — matching the
  // Middleware Chain tab.  Detection files (parameters, cookies, headers, body)
  // are NOT roots; they appear as tree nodes when reachable via the traversal.
  const seen = new Set<string>();
  const rootFiles: string[] = [];

  for (const middleware of endpoint.middleware ?? []) {
    if (middleware.location?.filePath) {
      const normalized = normalizePath(middleware.location.filePath);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        rootFiles.push(normalized);
      }
    }
  }

  const handlerPath = normalizePath(endpoint.handlerLocation.filePath);
  if (!seen.has(handlerPath)) {
    rootFiles.push(handlerPath);
  }

  return rootFiles;
}

function buildComponentGraph(endpoint: ApiEndpoint): ComponentGraphPayload {
  const rootFiles = collectComponentRootFiles(endpoint);
  const allowlistedLibraries = getSearchAllowlistedLibraries();
  const traversal = collectComponentTraversal(rootFiles, allowlistedLibraries);

  const childrenByFile: Record<string, string[]> = {};
  for (const edge of traversal.edges) {
    if (!childrenByFile[edge.from]) {
      childrenByFile[edge.from] = [];
    }
    if (!childrenByFile[edge.from].includes(edge.to)) {
      childrenByFile[edge.from].push(edge.to);
    }
  }

  const kindByFile: Record<string, 'handler' | 'middleware' | 'detected' | 'dependency'> = {};
  const lineByFile: Record<string, number> = {};
  const metricsByFile: Record<string, { reads: number; writes: number; data: number }> = {};
  for (const file of traversal.files) {
    kindByFile[file] = 'dependency';
    metricsByFile[file] = { reads: 0, writes: 0, data: 0 };
  }

  const handlerPath = normalizePath(endpoint.handlerLocation.filePath);
  if (kindByFile[handlerPath] !== undefined) {
    kindByFile[handlerPath] = 'handler';
    addSourceLine(lineByFile, handlerPath, endpoint.handlerLocation.line);
  }

  for (const middleware of endpoint.middleware ?? []) {
    const middlewarePath = middleware.location?.filePath ? normalizePath(middleware.location.filePath) : undefined;
    if (!middlewarePath || kindByFile[middlewarePath] === undefined || kindByFile[middlewarePath] === 'handler') {
      continue;
    }
    kindByFile[middlewarePath] = 'middleware';
    if (middleware.location?.line) {
      addSourceLine(lineByFile, middlewarePath, middleware.location.line);
    }
  }

  for (const root of rootFiles) {
    const normalized = normalizePath(root);
    if (kindByFile[normalized] === 'dependency') {
      kindByFile[normalized] = 'detected';
    }
  }

  for (const parameter of endpoint.parameters ?? []) {
    if (parameter.detectionLocation?.filePath && parameter.detectionLocation.line) {
      addSourceLine(lineByFile, normalizePath(parameter.detectionLocation.filePath), parameter.detectionLocation.line);
      const mode = resolveAccessMode(parameter.detectionLocation, 'read');
      addMetric(metricsByFile, normalizePath(parameter.detectionLocation.filePath), mode);
    }
    for (const evidence of parameter.evidenceLocations ?? []) {
      if (evidence.filePath && evidence.line) {
        addSourceLine(lineByFile, normalizePath(evidence.filePath), evidence.line);
        const mode = resolveAccessMode(evidence, 'read');
        addMetric(metricsByFile, normalizePath(evidence.filePath), mode);
      }
    }
  }

  if (endpoint.requestBody?.detectionLocation?.filePath && endpoint.requestBody.detectionLocation.line) {
    addSourceLine(
      lineByFile,
      normalizePath(endpoint.requestBody.detectionLocation.filePath),
      endpoint.requestBody.detectionLocation.line
    );
    const mode = resolveAccessMode(endpoint.requestBody.detectionLocation, 'read');
    addMetric(metricsByFile, normalizePath(endpoint.requestBody.detectionLocation.filePath), mode);
  }

  for (const cookie of endpoint.cookies ?? []) {
    if (cookie.detectionLocation?.filePath && cookie.detectionLocation.line) {
      addSourceLine(lineByFile, normalizePath(cookie.detectionLocation.filePath), cookie.detectionLocation.line);
      const fallbackMode = cookie.type === 'response' ? 'write' : 'read';
      const mode = resolveAccessMode(cookie.detectionLocation, fallbackMode);
      addMetric(metricsByFile, normalizePath(cookie.detectionLocation.filePath), mode);
    }
  }

  for (const response of endpoint.responses ?? []) {
    for (const header of response.headers ?? []) {
      if (header.detectionLocation?.filePath && header.detectionLocation.line) {
        addSourceLine(lineByFile, normalizePath(header.detectionLocation.filePath), header.detectionLocation.line);
        const mode = resolveAccessMode(header.detectionLocation, 'write');
        addMetric(metricsByFile, normalizePath(header.detectionLocation.filePath), mode);
      }
    }
  }

  return {
    rootFiles: rootFiles.filter((root) => traversal.files.includes(normalizePath(root))).map((root) => normalizePath(root)),
    childrenByFile,
    kindByFile,
    lineByFile,
    metricsByFile
  };
}

function addMetric(
  metricsByFile: Record<string, { reads: number; writes: number; data: number }>,
  filePath: string,
  mode: 'read' | 'write'
): void {
  const bucket = metricsByFile[filePath];
  if (!bucket) {
    return;
  }

  if (mode === 'read') {
    bucket.reads += 1;
  } else {
    bucket.writes += 1;
  }
  bucket.data += 1;
}

function resolveAccessMode(location: SourceLocation | undefined, fallback: 'read' | 'write'): 'read' | 'write' {
  if (location?.accessMode === 'read' || location?.accessMode === 'write') {
    return location.accessMode;
  }
  return fallback;
}

function addSourceLine(lineByFile: Record<string, number>, filePath: string, line: number): void {
  if (!Number.isFinite(line) || line <= 0) {
    return;
  }

  const existing = lineByFile[filePath];
  if (existing === undefined) {
    lineByFile[filePath] = line;
    return;
  }

  lineByFile[filePath] = Math.min(existing, line);
}

function getSearchAllowlistedLibraries(): string[] {
  const workspaceRoot = resolveNodeApiForgeWorkspaceRoot();
  const configured = getNodeApiForgeSearchComponentLibAllowlist(workspaceRoot);
  return configured
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Resolve each allowlisted library package name to its root directory on disk.
 * Handles both node_modules installs and local `file:` dependencies cloned
 * into the workspace.  Returns normalised absolute paths (forward slashes).
 */
function resolveLibraryRoots(packages: string[], contextFiles: string[]): string[] {
  // Use the first available context file to anchor require.resolve
  const contextDir = contextFiles.length > 0
    ? path.dirname(contextFiles[0])
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const roots: string[] = [];
  for (const pkg of packages) {
    try {
      // Resolve <pkg>/package.json → its directory is the package root
      const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [contextDir] });
      roots.push(normalizePath(path.dirname(pkgJson)));
    } catch {
      // Some packages don't expose package.json — try resolving the main entry
      try {
        const main = require.resolve(pkg, { paths: [contextDir] });
        // Walk up until we find the package root (directory containing package.json)
        let dir = path.dirname(main);
        while (dir !== path.dirname(dir)) {
          if (fs.existsSync(path.join(dir, 'package.json'))) {
            roots.push(normalizePath(dir));
            break;
          }
          dir = path.dirname(dir);
        }
      } catch { /* skip unresolvable packages */ }
    }
  }
  return [...new Set(roots)];
}

function collectComponentTreeFiles(rootFiles: string[], allowlistedLibraries: string[]): string[] {
  return collectComponentTraversal(rootFiles, allowlistedLibraries).files;
}

function collectComponentTraversal(rootFiles: string[], allowlistedLibraries: string[]): ComponentTraversalResult {
  const discovered = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const edgeKeys = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const maxFiles = 800;

  for (const root of rootFiles) {
    const normalized = normalizePath(root);
    if (!normalized || queued.has(normalized) || !fs.existsSync(normalized)) {
      continue;
    }
    queued.add(normalized);
    queue.push(normalized);
  }

  while (queue.length > 0 && discovered.size < maxFiles) {
    const filePath = queue.shift()!;
    if (discovered.has(filePath)) {
      continue;
    }
    discovered.add(filePath);

    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const specs = extractDependencySpecifiers(content);
    for (const specifier of specs) {
      const resolved = resolveDependencyFile(specifier, filePath, allowlistedLibraries);
      if (!resolved) {
        continue;
      }
      const normalizedResolved = normalizePath(resolved);

      const edgeKey = `${filePath}->${normalizedResolved}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({ from: filePath, to: normalizedResolved });
      }

      if (discovered.has(normalizedResolved) || queued.has(normalizedResolved)) {
        continue;
      }
      queued.add(normalizedResolved);
      queue.push(normalizedResolved);
    }
  }

  return {
    files: Array.from(discovered),
    edges
  };
}

function extractDependencySpecifiers(content: string): string[] {
  const specs = new Set<string>();

  const add = (value?: string): void => {
    if (!value) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    specs.add(trimmed);
  };

  const importExportPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const requirePattern = /require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  const dynamicImportPattern = /import\(\s*['"]([^'"\n]+)['"]\s*\)/g;

  for (const match of content.matchAll(importExportPattern)) {
    add(match[1]);
  }
  for (const match of content.matchAll(requirePattern)) {
    add(match[1]);
  }
  for (const match of content.matchAll(dynamicImportPattern)) {
    add(match[1]);
  }

  return Array.from(specs);
}

function resolveDependencyFile(specifier: string, fromFile: string, allowlistedLibraries: string[]): string | undefined {
  if (!specifier) {
    return undefined;
  }

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return resolveLocalModule(specifier, path.dirname(fromFile));
  }

  const aliasResolved = resolveTsPathAlias(specifier, fromFile);
  if (aliasResolved) {
    return aliasResolved;
  }

  if (!isAllowlistedDependency(specifier, allowlistedLibraries)) {
    return undefined;
  }

  try {
    const resolved = require.resolve(specifier, { paths: [path.dirname(fromFile)] });
    return resolveLocalModule(resolved, path.dirname(fromFile));
  } catch {
    return undefined;
  }
}

function isAllowlistedDependency(specifier: string, allowlistedLibraries: string[]): boolean {
  for (const allowed of allowlistedLibraries) {
    if (specifier === allowed || specifier.startsWith(`${allowed}/`)) {
      return true;
    }
  }
  return false;
}

function resolveTsPathAlias(specifier: string, fromFile: string): string | undefined {
  const aliasEntries = getPathAliasEntriesForFile(fromFile);
  for (const entry of aliasEntries) {
    const wildcard = matchAlias(entry.key, specifier);
    if (wildcard === undefined) {
      continue;
    }

    for (const target of entry.targets) {
      const substituted = target.includes('*') ? target.replace(/\*/g, wildcard) : target;
      const basePath = path.isAbsolute(substituted)
        ? substituted
        : path.resolve(entry.baseDirectory, substituted);
      const resolved = resolveLocalModule(basePath, path.dirname(fromFile));
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

function matchAlias(pattern: string, specifier: string): string | undefined {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex < 0) {
    return pattern === specifier ? '' : undefined;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }

  const start = prefix.length;
  const end = specifier.length - suffix.length;
  if (end < start) {
    return undefined;
  }

  return specifier.slice(start, end);
}

function getPathAliasEntriesForFile(fromFile: string): PathAliasEntry[] {
  const configPath = findNearestTsConfig(path.dirname(fromFile));
  if (!configPath) {
    return [];
  }

  const cached = PATH_ALIAS_CACHE.get(configPath);
  if (cached) {
    return cached;
  }

  const compilerOptions = loadCompilerOptions(configPath, new Set<string>());
  const paths = compilerOptions.paths;
  if (!paths || Object.keys(paths).length === 0) {
    PATH_ALIAS_CACHE.set(configPath, []);
    return [];
  }

  const baseUrl = typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl.length > 0
    ? compilerOptions.baseUrl
    : '.';
  const baseDirectory = path.resolve(path.dirname(configPath), baseUrl);

  const entries: PathAliasEntry[] = Object.entries(paths)
    .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
    .map(([key, targets]) => ({
      key,
      targets: targets.filter((target): target is string => typeof target === 'string' && target.length > 0),
      baseDirectory
    }))
    .filter((entry) => entry.targets.length > 0);

  PATH_ALIAS_CACHE.set(configPath, entries);
  return entries;
}

function findNearestTsConfig(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    const tsConfig = path.join(current, 'tsconfig.json');
    if (fs.existsSync(tsConfig)) {
      return tsConfig;
    }

    const jsConfig = path.join(current, 'jsconfig.json');
    if (fs.existsSync(jsConfig)) {
      return jsConfig;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function loadCompilerOptions(configPath: string, visited: Set<string>): {
  baseUrl?: string;
  paths?: Record<string, string[]>;
} {
  const normalized = normalizePath(configPath);
  if (visited.has(normalized)) {
    return {};
  }
  visited.add(normalized);

  const currentConfig = readConfigJson(configPath);
  if (!currentConfig || typeof currentConfig !== 'object') {
    return {};
  }

  const extendsField = typeof currentConfig.extends === 'string' ? currentConfig.extends : undefined;
  let parent: { baseUrl?: string; paths?: Record<string, string[]> } = {};
  if (extendsField) {
    const parentConfigPath = resolveExtendedConfigPath(extendsField, configPath);
    if (parentConfigPath) {
      parent = loadCompilerOptions(parentConfigPath, visited);
    }
  }

  const compilerOptions = currentConfig.compilerOptions && typeof currentConfig.compilerOptions === 'object'
    ? currentConfig.compilerOptions
    : {};

  const baseUrl = typeof compilerOptions.baseUrl === 'string'
    ? compilerOptions.baseUrl
    : parent.baseUrl;

  const paths: Record<string, string[]> = {
    ...(parent.paths ?? {})
  };
  if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
    for (const [key, value] of Object.entries(compilerOptions.paths)) {
      if (!Array.isArray(value)) {
        continue;
      }
      paths[key] = value.filter((entry): entry is string => typeof entry === 'string');
    }
  }

  return {
    baseUrl,
    paths: Object.keys(paths).length > 0 ? paths : undefined
  };
}

function resolveExtendedConfigPath(extendsField: string, fromConfigPath: string): string | undefined {
  if (!extendsField.startsWith('.') && !path.isAbsolute(extendsField)) {
    return undefined;
  }

  const fromDir = path.dirname(fromConfigPath);
  const candidate = path.isAbsolute(extendsField)
    ? extendsField
    : path.resolve(fromDir, extendsField);

  const options = path.extname(candidate)
    ? [candidate]
    : [candidate, `${candidate}.json`];

  for (const option of options) {
    if (fs.existsSync(option) && fs.statSync(option).isFile()) {
      return option;
    }
  }

  return undefined;
}

function readConfigJson(configPath: string): any {
  let raw = '';
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }

  // Minimal JSONC handling for tsconfig/jsconfig parsing.
  const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments.replace(/(^|\s)\/\/.*$/gm, '$1');
  const normalized = noLineComments.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(normalized);
  } catch {
    return undefined;
  }
}

function resolveLocalModule(specifierOrPath: string, fromDir: string): string | undefined {
  const candidate = path.isAbsolute(specifierOrPath)
    ? specifierOrPath
    : path.resolve(fromDir, specifierOrPath);

  const ext = path.extname(candidate);
  const candidates = ext
    ? [candidate]
    : [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.js`,
        `${candidate}.jsx`,
        `${candidate}.mts`,
        `${candidate}.cts`,
        `${candidate}.mjs`,
        `${candidate}.cjs`,
        path.join(candidate, 'index.ts'),
        path.join(candidate, 'index.tsx'),
        path.join(candidate, 'index.js'),
        path.join(candidate, 'index.jsx'),
        path.join(candidate, 'index.mts'),
        path.join(candidate, 'index.cts'),
        path.join(candidate, 'index.mjs'),
        path.join(candidate, 'index.cjs')
      ];

  for (const entry of candidates) {
    if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
      return entry;
    }
  }

  return undefined;
}

function toFindInFilesIncludePattern(files: string[]): string {
  if (files.length === 0) {
    return '';
  }

  const entries = files.map((filePath) => {
    const relative = vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false);
    return normalizePath(relative);
  });

  if (entries.length === 1) {
    return entries[0];
  }

  return `{${entries.join(',')}}`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function buildWebviewHtml(endpoint: ApiEndpoint, webview: vscode.Webview, resourceRoot: vscode.Uri): string {
  const styleUri   = webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, 'style.css'));
  const scriptUri  = webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, 'script.js'));
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, 'mermaid.min.js'));

  const htmlPath = vscode.Uri.joinPath(resourceRoot, 'index.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

  const diagram = buildMermaidDiagram(endpoint);
  const componentGraph = buildComponentGraph(endpoint);
  const allFiles = [
    ...componentGraph.rootFiles,
    ...Object.keys(componentGraph.childrenByFile)
  ];
  const workspaceRoot = resolveNodeApiForgeWorkspaceRoot(endpoint.handlerLocation.filePath);
  const userLibraries: ExternalCallLibraryConfig[] = getNodeApiForgeExternalCallLibraries(workspaceRoot);
  const externalCalls: ExternalCall[] = detectExternalCalls([...new Set(allFiles)], userLibraries);

  const allowlistedLibraries = getSearchAllowlistedLibraries();
  const libRoots = resolveLibraryRoots(allowlistedLibraries, allFiles);
  const initialData = `<script>window.DIAGRAM_SRC = ${JSON.stringify(diagram)};window.ENDPOINT = ${JSON.stringify(endpoint)};window.COMPONENT_GRAPH = ${JSON.stringify(componentGraph)};window.EXTERNAL_CALLS = ${JSON.stringify(externalCalls)};window.SYS_MW_LIB_ROOTS = ${JSON.stringify(libRoots)};</script>`;

  html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
  html = html.replace('{{styleUri}}',    styleUri.toString());
  html = html.replace('{{mermaidUri}}',  mermaidUri.toString());
  html = html.replace('{{scriptUri}}',   scriptUri.toString());
  html = html.replace('{{initialData}}', initialData);

  return html;
}
