import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ApiEndpoint, SourceLocation } from '../discovery/types';

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

  private constructor(
    panel: vscode.WebviewPanel,
    endpoint: ApiEndpoint,
    resourceRoot: vscode.Uri,
    onHardRefresh?: (endpoint: ApiEndpoint) => Promise<ApiEndpoint | undefined>
  ) {
    this.panel = panel;
    this.endpoint = endpoint;
    this.resourceRoot = resourceRoot;
    this.onHardRefresh = onHardRefresh;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; filePath?: string; line?: number }) => {
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
        }
      },
      null,
      this.disposables
    );
  }

  public static show(
    endpoint: ApiEndpoint,
    extensionUri: vscode.Uri,
    onHardRefresh?: (endpoint: ApiEndpoint) => Promise<ApiEndpoint | undefined>
  ): FlowDiagramPanel {
    const route = endpoint.resolvedPath ?? endpoint.pathExpression;
    const title = `Flow: ${endpoint.method} ${route}`;
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
    const instance = new FlowDiagramPanel(panel, endpoint, resourceRoot, onHardRefresh);
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
      const route = refreshedEndpoint.resolvedPath ?? refreshedEndpoint.pathExpression;
      this.panel.title = `Flow: ${refreshedEndpoint.method} ${route}`;
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

  lines.push(`    REQ["${esc(endpoint.method + ' ' + route)}"]`);
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
  const rootFiles = new Set<string>();
  rootFiles.add(normalizePath(endpoint.handlerLocation.filePath));

  for (const middleware of endpoint.middleware ?? []) {
    if (middleware.location?.filePath) {
      rootFiles.add(normalizePath(middleware.location.filePath));
    }
  }

  for (const parameter of endpoint.parameters ?? []) {
    if (parameter.detectionLocation?.filePath) {
      rootFiles.add(normalizePath(parameter.detectionLocation.filePath));
    }
    for (const evidence of parameter.evidenceLocations ?? []) {
      if (evidence.filePath) {
        rootFiles.add(normalizePath(evidence.filePath));
      }
    }
  }

  if (endpoint.requestBody?.detectionLocation?.filePath) {
    rootFiles.add(normalizePath(endpoint.requestBody.detectionLocation.filePath));
  }

  for (const cookie of endpoint.cookies ?? []) {
    if (cookie.detectionLocation?.filePath) {
      rootFiles.add(normalizePath(cookie.detectionLocation.filePath));
    }
  }

  for (const response of endpoint.responses ?? []) {
    for (const header of response.headers ?? []) {
      if (header.detectionLocation?.filePath) {
        rootFiles.add(normalizePath(header.detectionLocation.filePath));
      }
    }
  }

  return Array.from(rootFiles);
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
  const configured = vscode.workspace.getConfiguration('nodeApiForge').get<string[]>('searchComponentLibAllowlist') ?? [];
  return configured
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
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

function resolveAccessMode(location: SourceLocation | undefined, fallback: 'read' | 'write'): 'read' | 'write' {
  if (location?.accessMode === 'read' || location?.accessMode === 'write') {
    return location.accessMode;
  }
  return fallback;
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
  const initialData = `<script>window.DIAGRAM_SRC = ${JSON.stringify(diagram)};window.ENDPOINT = ${JSON.stringify(endpoint)};window.COMPONENT_GRAPH = ${JSON.stringify(componentGraph)};</script>`;

  html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
  html = html.replace('{{styleUri}}',    styleUri.toString());
  html = html.replace('{{mermaidUri}}',  mermaidUri.toString());
  html = html.replace('{{scriptUri}}',   scriptUri.toString());
  html = html.replace('{{initialData}}', initialData);

  return html;
}
