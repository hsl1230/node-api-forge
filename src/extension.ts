import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  COPY_ENDPOINT_REQUEST_COMMAND_ID,
  DISCOVER_APIS_COMMAND_ID,
  EXPORT_COMMAND_ID,
  HARD_REFRESH_WORKSPACE_COMMAND_ID,
  OPEN_ENDPOINT_SOURCE_COMMAND_ID,
  OPEN_HTTP_FORGE_COMMAND_ID,
  SHOW_FLOW_COMMAND_ID
} from './commands';
import { ApiEndpoint, createDefaultDiscoveryEngine } from './discovery';
import { ApiExplorerTreeProvider } from './discovery/api-explorer-tree-provider';
import { formatEndpointDisplayLabel } from './discovery/endpoint-display';
import { FrameworkDetector } from './discovery/framework-detector';
import { resolveProjectName } from './discovery/project-name';
import { collectSourceFiles } from './discovery/source-files';
import { serializeHttpForgeCollection } from './export/http-forge-collection';
import { FlowDiagramPanel } from './webview/flow-diagram-panel';

const HTTP_FORGE_EXTENSION_ID = 'henry-huang.http-forge';
const FRAMEWORK_CACHE_PREFIX = 'frameworkCache:';
const SUPPORTED_FRAMEWORKS = new Set(['express', 'fastify', 'nestjs'] as const);

interface HttpForgeApi {
  openRequestContext(options: {
    request: {
      id: string;
      name: string;
      method: string;
      url: string;
      headers?: Array<{ key: string; value: string; enabled?: boolean }>;
      query?: Array<{ key: string; value: string; enabled?: boolean }>;
      params?: Record<string, string>;
      body?: unknown;
      description?: string;
    };
    readonly?: boolean;
    allowSave?: boolean;
    title?: string;
    collectionName?: string;
  }): void;
}

type DiscoverySelection = { workspaceFolder: string; includeProjectRoots?: string[] };

type AutoRefreshEventKind = 'create' | 'change' | 'delete';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Node API Forge');
  const discoveryEngine = createDefaultDiscoveryEngine();
  const frameworkDetector = new FrameworkDetector();
  const explorerProvider = new ApiExplorerTreeProvider(discoveryEngine);
  let lastSelection: DiscoverySelection | undefined;
  let lastDiscoveryContext: { projectRoots: string[]; customSeedLoaderModulePath?: string } | undefined;
  let trackedFiles = new Set<string>();
  let autoRefreshTimer: NodeJS.Timeout | undefined;
  let autoRefreshInFlight = false;
  let autoRefreshQueued = false;

  const discoverApis = vscode.commands.registerCommand(DISCOVER_APIS_COMMAND_ID, async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('Node API Forge: No workspace folder open.');
      return;
    }

    const selection = await pickWorkspaceFolder(workspaceFolders);
    if (!selection) {
      return;
    }
    await runDiscovery(selection, true, 'manual-command');
  });

  const openEndpointSource = vscode.commands.registerCommand(OPEN_ENDPOINT_SOURCE_COMMAND_ID, async (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(endpoint.handlerLocation.filePath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(Math.max(endpoint.handlerLocation.line - 1, 0), Math.max((endpoint.handlerLocation.column ?? 1) - 1, 0));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  });

  const copyEndpointRequest = vscode.commands.registerCommand(COPY_ENDPOINT_REQUEST_COMMAND_ID, async (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      return;
    }

    const requestText = formatHttpRequest(endpoint);
    await vscode.env.clipboard.writeText(requestText);
    vscode.window.showInformationMessage(`Node API Forge: Copied ${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression} as an HTTP request.`);
  });

  const openEndpointInHttpForge = vscode.commands.registerCommand(OPEN_HTTP_FORGE_COMMAND_ID, async (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      return;
    }

    const httpForgeExtension = vscode.extensions.getExtension<HttpForgeApi>(HTTP_FORGE_EXTENSION_ID);
    if (!httpForgeExtension) {
      const action = await vscode.window.showErrorMessage(
        'Node API Forge: HTTP Forge extension is required to open endpoint tester.',
        'Open Marketplace'
      );
      if (action === 'Open Marketplace') {
        await vscode.commands.executeCommand('workbench.extensions.search', HTTP_FORGE_EXTENSION_ID);
      }
      return;
    }

    const httpForgeApi = await httpForgeExtension.activate();
    if (!httpForgeApi || typeof httpForgeApi.openRequestContext !== 'function') {
      vscode.window.showErrorMessage('Node API Forge: HTTP Forge API is unavailable.');
      return;
    }

    const resolvedPath = endpoint.resolvedPath ?? endpoint.pathExpression;
    const endpointName = formatEndpointDisplayLabel(endpoint);
    const projectName = getEndpointProjectName(endpoint);
    const baseUrlVariableName = getProjectBaseUrlVariableName(projectName);
    const collectionName = projectName
      ? projectName
      : 'Node API Forge Discovery';

    const title = `Node API: ${endpointName}`;

    const query = (endpoint.parameters ?? [])
      .filter((parameter) => parameter.location === 'query')
      .map((parameter) => ({ key: parameter.name, value: '', enabled: true }));
    const headers = (endpoint.parameters ?? [])
      .filter((parameter) => parameter.location === 'header')
      .map((parameter) => ({ key: parameter.name, value: '', enabled: true }));
    const params = Object.fromEntries(
      (endpoint.parameters ?? [])
        .filter((parameter) => parameter.location === 'path')
        .map((parameter) => [parameter.name, ''])
    );

    httpForgeApi.openRequestContext({
      title,
      readonly: true,
      allowSave: true,
      collectionName,
      request: {
        id: buildEndpointRequestId(endpoint),
        name: endpointName,
        method: endpoint.method,
        url: `{{${baseUrlVariableName}}}${resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`}`,
        headers,
        query,
        params,
        body: endpoint.requestBody ? { type: 'raw', content: '' } : null,
        description: `Discovered from ${endpoint.framework} source at ${endpoint.handlerLocation.filePath}:${endpoint.handlerLocation.line}`
      }
    });
  });

  const showEndpointFlow = vscode.commands.registerCommand(SHOW_FLOW_COMMAND_ID, (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      return;
    }

    FlowDiagramPanel.show(endpoint, context.extensionUri, async (currentEndpoint) => {
      const refreshedEndpoint = await hardRefreshEndpoint(currentEndpoint);
      return refreshedEndpoint ?? currentEndpoint;
    });
  });

  const hardRefreshWorkspace = vscode.commands.registerCommand(HARD_REFRESH_WORKSPACE_COMMAND_ID, async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('Node API Forge: No workspace folder open.');
      return;
    }

    const selection = lastSelection ?? await pickWorkspaceFolder(workspaceFolders);
    if (!selection) {
      return;
    }

    const rootsToInvalidate = selection.includeProjectRoots?.length
      ? selection.includeProjectRoots
      : [selection.workspaceFolder];

    discoveryEngine.invalidateCaches(rootsToInvalidate);
    await clearFrameworkCache(context.workspaceState, rootsToInvalidate);
    await runDiscovery(selection, true, 'workspace-hard-refresh');
  });

  const exportDiscoveredCollection = vscode.commands.registerCommand(EXPORT_COMMAND_ID, async () => {
    const result = explorerProvider.getLastResult();
    if (!result || result.endpoints.length === 0) {
      vscode.window.showWarningMessage('Node API Forge: Run discovery before exporting a collection.');
      return;
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('node-api-forge-discovery.forge.json'),
      filters: {
        'HTTP Forge JSON': ['json', 'forge.json'],
        'JSON Files': ['json']
      },
      title: 'Export Discovered Collection'
    });

    if (!saveUri) {
      return;
    }

    const payload = serializeHttpForgeCollection(result, {
      collectionName: 'Node API Forge Discovery',
      description: 'Discovered endpoints exported from Node API Forge.',
      projectRoots: lastDiscoveryContext?.projectRoots ?? []
    });
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(payload, 'utf8'));
    vscode.window.showInformationMessage(`Node API Forge: Exported discovered collection to ${saveUri.fsPath}`);
  });

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,mjs,cjs,cts,mts,json}');
  const onFileEvent = (kind: AutoRefreshEventKind, uri: vscode.Uri): void => {
    if (!lastSelection || !isAutoRefreshEnabled()) {
      return;
    }
    if (!shouldAutoRefreshForFile(kind, uri.fsPath, trackedFiles, lastDiscoveryContext)) {
      return;
    }
    scheduleAutoRefresh(`${kind}:${normalizePath(uri.fsPath)}`);
  };

  watcher.onDidCreate((uri) => onFileEvent('create', uri));
  watcher.onDidChange((uri) => onFileEvent('change', uri));
  watcher.onDidDelete((uri) => onFileEvent('delete', uri));

  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('nodeApiForge.apiExplorerFrameworkPageSize')) {
      explorerProvider.refreshTree();
    }

    if (!event.affectsConfiguration('nodeApiForge') || !lastSelection || !isAutoRefreshEnabled()) {
      return;
    }
    scheduleAutoRefresh('config-changed');
  });

  context.subscriptions.push(
    discoverApis,
    openEndpointSource,
    copyEndpointRequest,
    openEndpointInHttpForge,
    showEndpointFlow,
    hardRefreshWorkspace,
    exportDiscoveredCollection,
    watcher,
    configWatcher,
    output,
    vscode.window.registerTreeDataProvider('nodeApiForge.apiExplorer', explorerProvider)
  );

  function isAutoRefreshEnabled(): boolean {
    const configuration = vscode.workspace.getConfiguration('nodeApiForge');
    return configuration.get<boolean>('autoRefreshOnFileChanges', true);
  }

  function scheduleAutoRefresh(reason: string): void {
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
    }
    autoRefreshTimer = setTimeout(() => {
      void runAutoRefresh(reason);
    }, 350);
  }

  async function runAutoRefresh(reason: string): Promise<void> {
    if (!lastSelection) {
      return;
    }

    if (autoRefreshInFlight) {
      autoRefreshQueued = true;
      return;
    }

    autoRefreshInFlight = true;
    try {
      await runDiscovery(lastSelection, false, reason);
    } finally {
      autoRefreshInFlight = false;
      if (autoRefreshQueued) {
        autoRefreshQueued = false;
        scheduleAutoRefresh('queued-refresh');
      }
    }
  }

  async function runDiscovery(selection: DiscoverySelection, manual: boolean, reason: string): Promise<void> {
    const { workspaceFolder, includeProjectRoots } = selection;
    const configuration = vscode.workspace.getConfiguration('nodeApiForge');
    const customSeedLoaderModulePath = configuration.get<string>('customSeedLoaderModulePath');
    console.log('[extension] Configuration read - customSeedLoaderModulePath:', customSeedLoaderModulePath);
    const configuredFrameworks = configuration.get<string[]>('frameworks') ?? ['auto'];
    const projectRoots = includeProjectRoots?.length ? includeProjectRoots : [workspaceFolder];
    const frameworksByProjectRoot = await resolveFrameworksByProjectRoot(
      projectRoots,
      configuredFrameworks,
      frameworkDetector,
      context.workspaceState
    );

    const refreshContext = {
      workspaceFolder,
      includeProjectRoots,
      frameworksByProjectRoot,
      customSeedLoaderModulePath
    };

    console.log('[extension] refreshContext:', JSON.stringify(refreshContext, null, 2).substring(0, 300));

    output.appendLine(manual
      ? '--- Node API Forge Discovery Run ---'
      : `--- Node API Forge Auto Refresh (${reason}) ---`);
    output.appendLine(`Workspace: ${workspaceFolder}`);
    if (customSeedLoaderModulePath) {
      output.appendLine(`Custom seed loader: ${customSeedLoaderModulePath}`);
    }

    const result = await explorerProvider.refresh(refreshContext);
    if (!result) {
      return;
    }

    trackedFiles = buildTrackedFiles(result, projectRoots, customSeedLoaderModulePath);
    lastSelection = selection;
    lastDiscoveryContext = { projectRoots, customSeedLoaderModulePath };

    output.appendLine(`Frameworks: ${result.stats.frameworksDetected.join(', ') || 'none'}`);
    output.appendLine(`Providers run: ${result.stats.providersRun.join(', ') || 'none'}`);
    output.appendLine(`Endpoints found: ${result.stats.endpointCount}`);
    output.appendLine(`Unresolved endpoints: ${result.stats.unresolvedEndpointCount}`);
    output.appendLine(
      `Parameter cache: reused ${result.stats.parameterCacheReusedEndpoints ?? 0}, recomputed ${result.stats.parameterCacheRecomputedEndpoints ?? 0}`
    );
    output.appendLine(`Duration: ${result.stats.scanDurationMs}ms`);

    if (result.endpoints.length > 0) {
      output.appendLine('Endpoints:');
      for (const endpoint of result.endpoints) {
        output.appendLine(formatEndpoint(endpoint));
      }
    }

    if (result.warnings.length > 0) {
      output.appendLine('Warnings:');
      for (const warning of result.warnings) {
        output.appendLine(`- [${warning.code}] ${warning.message}`);
      }
    }

    if (manual) {
      output.show(true);
      vscode.window.showInformationMessage(
        `Node API Forge: Found ${result.stats.endpointCount} endpoints (${result.stats.frameworksDetected.join(', ') || 'unknown framework'}).`
      );
    }
  }

  async function hardRefreshEndpoint(endpoint: ApiEndpoint): Promise<ApiEndpoint | undefined> {
    const projectRoots = lastDiscoveryContext?.projectRoots ?? [];
    const matchedProjectRoot = resolveProjectRootForFile(endpoint.handlerLocation.filePath, projectRoots);
    const rootsToInvalidate = matchedProjectRoot ? [matchedProjectRoot] : projectRoots;

    discoveryEngine.invalidateCaches(rootsToInvalidate.length > 0 ? rootsToInvalidate : undefined);
    await clearFrameworkCache(context.workspaceState, rootsToInvalidate);

    const refreshSelection = buildFlowRefreshSelection(lastSelection, endpoint, matchedProjectRoot);
    if (!refreshSelection) {
      output.appendLine('Node API Forge: Hard refresh skipped - unable to resolve workspace selection.');
      return undefined;
    }

    await runDiscovery(refreshSelection, false, 'flow-hard-refresh');

    const latestResult = explorerProvider.getLastResult();
    if (!latestResult) {
      return undefined;
    }

    return matchEndpoint(latestResult.endpoints, endpoint);
  }
}

function buildEndpointRequestId(endpoint: ApiEndpoint): string {
  const projectName = getEndpointProjectName(endpoint) ?? 'unmapped-project';
  const key = `${projectName}:${endpoint.framework}:${endpoint.method}:${endpoint.resolvedPath ?? endpoint.pathExpression}`;
  return `node-api-${key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

function resolveEndpointCommandArg(arg: unknown): ApiEndpoint | undefined {
  if (isApiEndpoint(arg)) {
    return arg;
  }

  if (!arg || typeof arg !== 'object') {
    return undefined;
  }

  const candidateKeys = ['endpoint', 'endpointData', 'data'] as const;
  for (const key of candidateKeys) {
    const value = (arg as Record<string, unknown>)[key];
    if (isApiEndpoint(value)) {
      return value;
    }
  }

  return undefined;
}

function isApiEndpoint(value: unknown): value is ApiEndpoint {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const endpoint = value as Partial<ApiEndpoint>;
  return typeof endpoint.method === 'string'
    && !!endpoint.handlerLocation
    && typeof endpoint.handlerLocation.filePath === 'string'
    && typeof endpoint.handlerLocation.line === 'number';
}

function getEndpointProjectName(endpoint: ApiEndpoint): string | undefined {
  const projectRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  return resolveProjectName(endpoint, projectRoots);
}

function getProjectBaseUrlVariableName(projectName?: string): string {
  if (!projectName) {
    return 'baseUrl';
  }

  const segments = projectName
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return 'baseUrl';
  }

  const [firstSegment, ...remainingSegments] = segments;
  const normalized = [
    firstSegment.toLowerCase(),
    ...remainingSegments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
  ].join('');

  const safeIdentifier = /^[0-9]/.test(normalized)
    ? `project${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : normalized;

  return `${safeIdentifier}BaseUrl`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function buildTrackedFiles(
  result: { endpoints: Array<{ handlerLocation: { filePath: string } }>; warnings: Array<{ filePath?: string }> },
  projectRoots: string[],
  customSeedLoaderModulePath?: string
): Set<string> {
  const tracked = new Set<string>();

  for (const endpoint of result.endpoints) {
    tracked.add(normalizePath(endpoint.handlerLocation.filePath));
  }

  for (const warning of result.warnings) {
    if (warning.filePath) {
      tracked.add(normalizePath(warning.filePath));
    }
  }

  for (const projectRoot of projectRoots) {
    const root = normalizePath(projectRoot);
    for (const sourceFile of collectSourceFiles(projectRoot)) {
      tracked.add(normalizePath(sourceFile));
    }
    tracked.add(`${root}/package.json`);
    tracked.add(`${root}/src/main.ts`);
    tracked.add(`${root}/src/main.js`);
    tracked.add(`${root}/src/app.ts`);
    tracked.add(`${root}/src/app.js`);
    const customLoaderPath = resolveCustomLoaderModulePath(root, customSeedLoaderModulePath);
    if (customLoaderPath) {
      tracked.add(customLoaderPath);
    }
  }

  return tracked;
}

function shouldAutoRefreshForFile(
  kind: AutoRefreshEventKind,
  filePath: string,
  trackedFiles: Set<string>,
  context?: { projectRoots: string[]; customSeedLoaderModulePath?: string }
): boolean {
  const normalized = normalizePath(filePath);
  if (trackedFiles.has(normalized)) {
    return true;
  }

  if (!context) {
    return false;
  }

  for (const root of context.projectRoots.map((projectRoot) => normalizePath(projectRoot))) {
    if (normalized === `${root}/package.json`) {
      return true;
    }

    if (kind === 'create') {
      if (
        normalized === `${root}/src/main.ts`
        || normalized === `${root}/src/main.js`
        || normalized === `${root}/src/app.ts`
        || normalized === `${root}/src/app.js`
      ) {
        return true;
      }

      const customLoaderPath = resolveCustomLoaderModulePath(root, context.customSeedLoaderModulePath);
      if (customLoaderPath && normalized === customLoaderPath) {
        return true;
      }
    }
  }

  return false;
}

function resolveCustomLoaderModulePath(projectRoot: string, customSeedLoaderModulePath?: string): string | undefined {
  if (!customSeedLoaderModulePath) {
    return undefined;
  }

  if (customSeedLoaderModulePath.startsWith('/')) {
    return normalizePath(customSeedLoaderModulePath);
  }

  return normalizePath(`${projectRoot}/${customSeedLoaderModulePath}`);
}

async function clearFrameworkCache(workspaceState: vscode.Memento, projectRoots: string[]): Promise<void> {
  if (projectRoots.length === 0) {
    return;
  }

  for (const projectRoot of projectRoots) {
    await workspaceState.update(`${FRAMEWORK_CACHE_PREFIX}${projectRoot}`, undefined);
  }
}

function resolveProjectRootForFile(filePath: string, projectRoots: string[]): string | undefined {
  const normalizedFilePath = normalizePath(filePath);
  let bestMatch: string | undefined;

  for (const projectRoot of projectRoots) {
    const normalizedRoot = normalizePath(projectRoot);
    if (normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}/`)) {
      if (!bestMatch || normalizedRoot.length > bestMatch.length) {
        bestMatch = projectRoot;
      }
    }
  }

  return bestMatch;
}

function buildFlowRefreshSelection(
  lastSelection: DiscoverySelection | undefined,
  endpoint: ApiEndpoint,
  matchedProjectRoot: string | undefined
): DiscoverySelection | undefined {
  if (lastSelection) {
    return {
      workspaceFolder: lastSelection.workspaceFolder,
      includeProjectRoots: matchedProjectRoot ? [matchedProjectRoot] : lastSelection.includeProjectRoots
    };
  }

  const endpointUri = vscode.Uri.file(endpoint.handlerLocation.filePath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(endpointUri);
  if (!workspaceFolder) {
    return undefined;
  }

  return {
    workspaceFolder: workspaceFolder.uri.fsPath,
    includeProjectRoots: matchedProjectRoot ? [matchedProjectRoot] : undefined
  };
}

function matchEndpoint(endpoints: ApiEndpoint[], target: ApiEndpoint): ApiEndpoint | undefined {
  const normalizedTargetPath = normalizePath(target.handlerLocation.filePath);
  const targetRoute = target.resolvedPath ?? target.pathExpression;

  const exact = endpoints.find((endpoint) =>
    endpoint.method.toUpperCase() === target.method.toUpperCase()
    && (endpoint.resolvedPath ?? endpoint.pathExpression) === targetRoute
    && normalizePath(endpoint.handlerLocation.filePath) === normalizedTargetPath
  );
  if (exact) {
    return exact;
  }

  return endpoints.find((endpoint) =>
    endpoint.method.toUpperCase() === target.method.toUpperCase()
    && (endpoint.resolvedPath ?? endpoint.pathExpression) === targetRoute
  );
}

async function pickWorkspaceFolder(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<{ workspaceFolder: string; includeProjectRoots?: string[] } | undefined> {
  if (workspaceFolders.length === 1) {
    return { workspaceFolder: workspaceFolders[0].uri.fsPath };
  }

  const picked = await vscode.window.showQuickPick(
    workspaceFolders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      value: folder.uri.fsPath
    })).concat([
      {
        label: 'All workspace folders',
        description: 'Analyze every folder in the workspace',
        value: 'ALL_WORKSPACE_FOLDERS'
      }
    ]),
    {
      placeHolder: 'Choose a workspace folder to analyze'
    }
  );

  if (!picked) {
    return undefined;
  }

  if (picked.value === 'ALL_WORKSPACE_FOLDERS') {
    return {
      workspaceFolder: workspaceFolders[0].uri.fsPath,
      includeProjectRoots: workspaceFolders.map((folder) => folder.uri.fsPath)
    };
  }

  return { workspaceFolder: picked.value };
}

function formatEndpoint(endpoint: ApiEndpoint): string {
  const handler = `${endpoint.handlerLocation.filePath}:${endpoint.handlerLocation.line}`;
  const resolved = endpoint.resolvedPath ?? endpoint.pathExpression;
  const middleware = endpoint.middleware.length > 0 ? ` middleware=[${endpoint.middleware.map((item) => item.name).join(', ')}]` : '';
  return `- ${endpoint.framework.toUpperCase()} ${endpoint.method} ${resolved} (confidence=${endpoint.confidence}; handler=${handler}${middleware})`;
}

function formatHttpRequest(endpoint: ApiEndpoint): string {
  const path = endpoint.resolvedPath ?? endpoint.pathExpression;
  const host = 'http://localhost:3000';
  return [
    `${endpoint.method} ${host}${path} HTTP/1.1`,
    'Accept: application/json',
    '',
    ''
  ].join('\n');
}

export function deactivate(): void {
  // No-op for now.
}

async function resolveFrameworksByProjectRoot(
  projectRoots: string[],
  configuredFrameworks: string[],
  frameworkDetector: FrameworkDetector,
  workspaceState: vscode.Memento
): Promise<Record<string, Array<'express' | 'fastify' | 'nestjs' | 'unknown'>>> {
  const { explicit, includeAuto } = parseConfiguredFrameworks(configuredFrameworks);
  if (!includeAuto && explicit.length > 0) {
    return Object.fromEntries(projectRoots.map((projectRoot) => [projectRoot, explicit]));
  }

  const resolved: Record<string, Array<'express' | 'fastify' | 'nestjs' | 'unknown'>> = {};
  for (const projectRoot of projectRoots) {
    const cacheKey = `${FRAMEWORK_CACHE_PREFIX}${projectRoot}`;
    const fingerprint = frameworkDetector.buildFingerprint(projectRoot);
    const packageJsonMtimeMs = getPackageJsonMtimeMs(fingerprint.packageJsonPath);
    const cached = workspaceState.get<{ packageJsonMtimeMs: number | null; frameworks: Array<'express' | 'fastify' | 'nestjs' | 'unknown'> }>(cacheKey);

    if (cached && cached.packageJsonMtimeMs === packageJsonMtimeMs && cached.frameworks.length > 0) {
      resolved[projectRoot] = mergeFrameworkLists(cached.frameworks, explicit);
      continue;
    }

    const detected = frameworkDetector.detectFrameworks(fingerprint);
    resolved[projectRoot] = mergeFrameworkLists(detected, explicit);
    await workspaceState.update(cacheKey, {
      packageJsonMtimeMs,
      frameworks: detected
    });
  }

  return resolved;
}

function normalizeConfiguredFrameworks(configuredFrameworks: string[]): Array<'express' | 'fastify' | 'nestjs' | 'unknown'> {
  const normalized = configuredFrameworks.map((item) => item.toLowerCase());
  const selected = normalized
    .filter((item): item is 'express' | 'fastify' | 'nestjs' => SUPPORTED_FRAMEWORKS.has(item as 'express' | 'fastify' | 'nestjs'));

  return Array.from(new Set(selected));
}

function parseConfiguredFrameworks(configuredFrameworks: string[]): {
  explicit: Array<'express' | 'fastify' | 'nestjs' | 'unknown'>;
  includeAuto: boolean;
} {
  const normalized = configuredFrameworks.map((item) => item.toLowerCase());
  return {
    explicit: normalizeConfiguredFrameworks(configuredFrameworks),
    includeAuto: normalized.includes('auto') || normalized.length === 0
  };
}

function mergeFrameworkLists(
  detected: Array<'express' | 'fastify' | 'nestjs' | 'unknown'>,
  explicit: Array<'express' | 'fastify' | 'nestjs' | 'unknown'>
): Array<'express' | 'fastify' | 'nestjs' | 'unknown'> {
  return Array.from(new Set([...detected, ...explicit]));
}

function getPackageJsonMtimeMs(packageJsonPath: string | undefined): number | null {
  if (!packageJsonPath) {
    return null;
  }
  try {
    return fs.statSync(packageJsonPath).mtimeMs;
  } catch {
    return null;
  }
}
