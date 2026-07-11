import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  COPY_ENDPOINT_REQUEST_COMMAND_ID,
  DISCOVER_APIS_COMMAND_ID,
  EXPORT_COMMAND_ID,
  EXPORT_FRAMEWORK_COMMAND_ID,
  EXPORT_PROJECT_COMMAND_ID,
  GO_TO_TEST_FILE_COMMAND_ID,
  HARD_REFRESH_WORKSPACE_COMMAND_ID,
  OPEN_ENDPOINT_SOURCE_COMMAND_ID,
  OPEN_HTTP_FORGE_COMMAND_ID,
  SEARCH_IN_ENDPOINT_COMMAND_ID,
  SHOW_FLOW_COMMAND_ID
} from './commands';
import {
  getNodeApiForgeAutoRefreshOnFileChanges,
  getNodeApiForgeContextProperties,
  getNodeApiForgeCustomSeedLoaderModulePath,
  getNodeApiForgeFrameworks,
  resolveNodeApiForgeProjectConfigPaths
} from './config/project-config';
import { ApiEndpoint, ApiFramework, createDefaultDiscoveryEngine } from './discovery';
import { ApiExplorerTreeProvider } from './discovery/api-explorer-tree-provider';
import { formatEndpointDisplayLabel } from './discovery/endpoint-display';
import { FrameworkDetector } from './discovery/framework-detector';
import { resolveProjectName } from './discovery/project-name';
import { collectSourceFiles } from './discovery/source-files';
import { serializeHttpForgeCollection, serializeScopedFrameworkCollection, serializeScopedProjectCollection } from './export/http-forge-collection';
import { getExistingDoc } from './services/endpoint-doc-service';
import { FlowDiagramPanel } from './webview/flow-diagram-panel';

const HTTP_FORGE_EXTENSION_ID = 'henry-huang.http-forge';
const FRAMEWORK_CACHE_PREFIX = 'frameworkCache:';
const SUPPORTED_FRAMEWORKS = new Set(['express', 'fastify', 'nestjs', 'lambda'] as const);
const FEW_ENDPOINTS_THRESHOLD = 2;

interface HttpForgeCollectionItem {
  type: 'request' | 'folder';
  id?: string;
  doc?: string;
  summary?: string;
  items?: HttpForgeCollectionItem[];
  [key: string]: unknown;
}

interface HttpForgeCollection {
  id: string;
  name: string;
  items: HttpForgeCollectionItem[];
  [key: string]: unknown;
}

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
      doc?: string;
      summary?: string;
    };
    readonly?: boolean;
    allowSave?: boolean;
    title?: string;
    collectionName?: string;
    disableSchemas?: boolean;
  }): void;
  getAllCollections?(): HttpForgeCollection[];
  saveCollection?(collection: HttpForgeCollection): Promise<void>;
}

function normalizeContextProperties(values: string[] | undefined): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : ['locals'];
}

type DiscoverySelection = { workspaceFolder: string; includeProjectRoots?: string[] };

type AutoRefreshEventKind = 'create' | 'change' | 'delete';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Node API Forge');
  const discoveryEngine = createDefaultDiscoveryEngine();
  const frameworkDetector = new FrameworkDetector();
  const explorerProvider = new ApiExplorerTreeProvider(discoveryEngine);
  let lastSelection: DiscoverySelection | undefined;
  let lastDiscoveryContext: { projectRoots: string[]; customSeedLoaderModulePath?: string; contextProperties?: string[] } | undefined;
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

    // Load any previously generated documentation to include in the request.
    // Use package.json walk-up first (always finds the nearest sub-project like agl-recording-middleware/).
    // Fall back to endpoint.projectRoot only when no package.json exists (rare).
    const projectRoot = resolveProjectRootForEndpoint(endpoint)
      ?? endpoint.projectRoot
      ?? resolveProjectRootForFile(endpoint.handlerLocation.filePath, lastDiscoveryContext?.projectRoots ?? []);
    const existingDoc = projectRoot
      ? getExistingDoc(projectRoot, endpoint.method, resolvedPath)
      : undefined;

    const gitBranch = await getGitBranch();
    const ticketMatch = gitBranch?.match(/([A-Z]+-\d+)/);
    const branchGroup = ticketMatch ? ` [${ticketMatch[1]}]` : '';
    const collectionName = projectName
      ? `${projectName}${branchGroup}`
      : `Node API Forge Discovery${branchGroup}`;

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
      disableSchemas: true,
      request: {
        id: buildEndpointRequestId(endpoint),
        name: endpointName,
        method: endpoint.method,
        url: `{{${baseUrlVariableName}}}${resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`}`,
        headers,
        query,
        params,
        body: endpoint.requestBody ? { type: 'raw', content: '' } : null,
        description: `Discovered from ${endpoint.framework} source at ${endpoint.handlerLocation.filePath}:${endpoint.handlerLocation.line}`,
        doc: existingDoc?.doc,
        summary: existingDoc?.summary
      }
    });
  });

  //Steven, identify, Edvin

  const showEndpointFlow = vscode.commands.registerCommand(SHOW_FLOW_COMMAND_ID, (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      return;
    }

    // Enrich this endpoint with component analysis on-demand (deferred from bulk discovery).
    discoveryEngine.enrichEndpoint(endpoint, lastDiscoveryContext?.contextProperties);

    FlowDiagramPanel.show(endpoint, context.extensionUri, async (currentEndpoint) => {
      const refreshedEndpoint = await hardRefreshEndpoint(currentEndpoint);
      return refreshedEndpoint ?? currentEndpoint;
    }, lastDiscoveryContext?.projectRoots ?? []);
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

  const searchInEndpoint = vscode.commands.registerCommand(SEARCH_IN_ENDPOINT_COMMAND_ID, async (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      vscode.window.showWarningMessage('Node API Forge: No endpoint selected for search.');
      return;
    }
    // Enrich this endpoint with component analysis on-demand.
    discoveryEngine.enrichEndpoint(endpoint, lastDiscoveryContext?.contextProperties);
    FlowDiagramPanel.show(endpoint, context.extensionUri, async (currentEndpoint) => {
      const refreshedEndpoint = await hardRefreshEndpoint(currentEndpoint);
      return refreshedEndpoint ?? currentEndpoint;
    }, lastDiscoveryContext?.projectRoots ?? []);
    // Give the panel a moment to open, then trigger search
    setTimeout(() => {
      vscode.commands.executeCommand('nodeApiForge.searchInEndpoint._internal', endpoint);
    }, 300);
  });

  /**
   * Called by FlowDiagramPanel after successfully generating a doc.
   * Finds the matching request across all HTTP Forge collections and updates its `doc` field.
   */
  const syncDocToHttpForge = vscode.commands.registerCommand(
    'nodeApiForge.syncDocToHttpForge',
    async (endpoint: ApiEndpoint, doc: string, summary: string) => {
      const httpForgeExtension = vscode.extensions.getExtension<HttpForgeApi>(HTTP_FORGE_EXTENSION_ID);
      if (!httpForgeExtension) return;
      const httpForgeApi = await httpForgeExtension.activate();
      if (!httpForgeApi?.getAllCollections || !httpForgeApi?.saveCollection) return;

      const requestId = buildEndpointRequestId(endpoint);
      const collections = httpForgeApi.getAllCollections();
      for (const collection of collections) {
        if (updateDocInItems(collection.items, requestId, doc, summary)) {
          await httpForgeApi.saveCollection(collection);
          return;
        }
      }
    }
  );

  const exportProjectCollection = vscode.commands.registerCommand(EXPORT_PROJECT_COMMAND_ID, async (arg?: unknown) => {
    const result = explorerProvider.getLastResult();
    if (!result) {
      vscode.window.showWarningMessage('Node API Forge: Run discovery before exporting a collection.');
      return;
    }

    const nodeData = (arg && typeof arg === 'object' && 'data' in arg)
      ? (arg as { data?: { kind: string; projectName?: string } }).data
      : undefined;
    const projectName = nodeData?.kind === 'project' ? nodeData.projectName : undefined;
    if (!projectName) {
      vscode.window.showWarningMessage('Node API Forge: Could not determine project name.');
      return;
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${projectName.replace(/[^a-zA-Z0-9-_]/g, '-')}-collection.forge.json`),
      filters: { 'HTTP Forge JSON': ['json', 'forge.json'] },
      title: `Export ${projectName} Collection`
    });
    if (!saveUri) return;

    const payload = serializeScopedProjectCollection(result, projectName, {
      projectRoots: lastDiscoveryContext?.projectRoots ?? []
    });
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(payload, 'utf8'));
    vscode.window.showInformationMessage(`Node API Forge: Exported ${projectName} collection to ${saveUri.fsPath}`);
  });

  const exportFrameworkCollection = vscode.commands.registerCommand(EXPORT_FRAMEWORK_COMMAND_ID, async (arg?: unknown) => {
    const result = explorerProvider.getLastResult();
    if (!result) {
      vscode.window.showWarningMessage('Node API Forge: Run discovery before exporting a collection.');
      return;
    }

    const nodeData = (arg && typeof arg === 'object' && 'data' in arg)
      ? (arg as { data?: { kind: string; projectName?: string; framework?: ApiFramework } }).data
      : undefined;

    // frameworkGroup items carry `{ kind: 'framework', framework, endpoints }` in `data`
    // But they're nested under a project item. We need to reconstruct the projectName
    // by looking up what project this framework belongs to.
    // Fallback: use getEndpointProjectName from first endpoint.
    const frameworkFromData = nodeData?.kind === 'framework' ? nodeData.framework : undefined;
    if (!frameworkFromData) {
      vscode.window.showWarningMessage('Node API Forge: Could not determine framework.');
      return;
    }

    // Get project name from the framework group's endpoints via parent context
    // Since we don't have direct access to parent, derive from the first endpoint in the filtered result
    const frameworkEndpoints = result.endpoints.filter((ep) => ep.framework === frameworkFromData);
    if (frameworkEndpoints.length === 0) {
      vscode.window.showWarningMessage('Node API Forge: No endpoints found for this framework.');
      return;
    }
    const projectName = resolveProjectName(frameworkEndpoints[0], lastDiscoveryContext?.projectRoots ?? []) ?? 'Unmapped Project';

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${projectName.replace(/[^a-zA-Z0-9-_]/g, '-')}-${frameworkFromData}.forge.json`),
      filters: { 'HTTP Forge JSON': ['json', 'forge.json'] },
      title: `Export ${projectName} – ${frameworkFromData.toUpperCase()} Collection`
    });
    if (!saveUri) return;

    const payload = serializeScopedFrameworkCollection(result, projectName, frameworkFromData, {
      projectRoots: lastDiscoveryContext?.projectRoots ?? []
    });
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(payload, 'utf8'));
    vscode.window.showInformationMessage(`Node API Forge: Exported ${frameworkFromData.toUpperCase()} collection to ${saveUri.fsPath}`);
  });

  const goToTestFile = vscode.commands.registerCommand(GO_TO_TEST_FILE_COMMAND_ID, async (arg?: unknown) => {
    const endpoint = resolveEndpointCommandArg(arg);
    if (!endpoint) {
      vscode.window.showWarningMessage('Node API Forge: No endpoint selected.');
      return;
    }

    const handlerFile = endpoint.handlerLocation.filePath;
    const testFile = await findTestFile(handlerFile);
    if (!testFile) {
      vscode.window.showWarningMessage(
        `Node API Forge: No test file found for ${path.basename(handlerFile)}. Expected patterns: *.test.ts, *.spec.ts, __tests__/*.ts`
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document, { preview: false });
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

  context.subscriptions.push(
    discoverApis,
    openEndpointSource,
    copyEndpointRequest,
    openEndpointInHttpForge,
    showEndpointFlow,
    hardRefreshWorkspace,
    exportDiscoveredCollection,
    searchInEndpoint,
    syncDocToHttpForge,
    exportProjectCollection,
    exportFrameworkCollection,
    goToTestFile,
    watcher,
    output,
    vscode.window.registerTreeDataProvider('nodeApiForge.apiExplorer', explorerProvider)
  );

  function isAutoRefreshEnabled(): boolean {
    const workspaceRoot = lastSelection?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return getNodeApiForgeAutoRefreshOnFileChanges(workspaceRoot);
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
    const customSeedLoaderModulePath = getNodeApiForgeCustomSeedLoaderModulePath(workspaceFolder);
    const contextProperties = normalizeContextProperties(getNodeApiForgeContextProperties(workspaceFolder));
    console.log('[extension] Configuration read - customSeedLoaderModulePath:', customSeedLoaderModulePath);
    const configuredFrameworks = getNodeApiForgeFrameworks(workspaceFolder);
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
      customSeedLoaderModulePath,
      contextProperties,
      skipComponentAnalysis: true
    };

    console.log('[extension] refreshContext:', JSON.stringify(refreshContext, null, 2).substring(0, 300));

    output.appendLine(manual
      ? '--- Node API Forge Discovery Run ---'
      : `--- Node API Forge Auto Refresh (${reason}) ---`);
    output.appendLine(`Workspace: ${workspaceFolder}`);
    if (customSeedLoaderModulePath) {
      output.appendLine(`Custom seed loader: ${customSeedLoaderModulePath}`);
    }
    output.appendLine(`Context properties: ${contextProperties.join(', ')}`);

    const result = await explorerProvider.refresh(refreshContext);
    if (!result) {
      return;
    }

    trackedFiles = buildTrackedFiles(result, workspaceFolder, projectRoots, customSeedLoaderModulePath);
    lastSelection = selection;
    lastDiscoveryContext = { projectRoots, customSeedLoaderModulePath, contextProperties };

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

      if (!customSeedLoaderModulePath && result.stats.endpointCount <= FEW_ENDPOINTS_THRESHOLD) {
        const docsUri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'custom-seed-loader.md');
        const action = await vscode.window.showWarningMessage(
          result.stats.endpointCount === 0
            ? 'Node API Forge: No endpoints were discovered. This usually means some routes are registered outside the source patterns Node API Forge can infer. Configure a custom seed loader to supply those endpoints. See the Custom Seed Loader document for setup.'
            : `Node API Forge: Only ${result.stats.endpointCount} endpoint(s) were discovered. Some routes may be registered indirectly or outside the source patterns Node API Forge can infer. Configure a custom seed loader to supplement discovery. See the Custom Seed Loader document for setup.`,
          'Open Docs',
          'Open Config'
        );

        if (action === 'Open Docs') {
          const document = await vscode.workspace.openTextDocument(docsUri);
          await vscode.window.showTextDocument(document, { preview: false });
        } else if (action === 'Open Config') {
          await openNodeApiForgeProjectConfig(workspaceFolder);
        }
      }
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

    const matched = matchEndpoint(latestResult.endpoints, endpoint);
    if (matched) {
      // Run component analysis for this specific endpoint (skipped during bulk refresh).
      discoveryEngine.enrichEndpoint(matched, lastDiscoveryContext?.contextProperties);
    }
    return matched;
  }
}

function buildEndpointRequestId(endpoint: ApiEndpoint): string {
  const projectName = getEndpointProjectName(endpoint) ?? 'unmapped-project';
  const key = `${projectName}:${endpoint.framework}:${endpoint.method}:${endpoint.resolvedPath ?? endpoint.pathExpression}`;
  return `node-api-${key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

/** Walk up from the handler file to find the nearest package.json directory. */
function resolveProjectRootForEndpoint(endpoint: ApiEndpoint): string | undefined {
  let dir = path.dirname(endpoint.handlerLocation.filePath);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const uri = vscode.Uri.file(endpoint.handlerLocation.filePath);
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

/**
 * Recursively find a request by ID in an HTTP Forge collection item tree and
 * update its `doc` and `summary` fields in-place. Returns true if found.
 */
function updateDocInItems(
  items: HttpForgeCollectionItem[],
  requestId: string,
  doc: string,
  summary: string
): boolean {
  for (const item of items) {
    if (item.type === 'request' && item.id === requestId) {
      item.doc = doc;
      item.summary = summary;
      return true;
    }
    if (item.type === 'folder' && Array.isArray(item.items)) {
      if (updateDocInItems(item.items, requestId, doc, summary)) return true;
    }
  }
  return false;
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
  workspaceFolder: string,
  projectRoots: string[],
  customSeedLoaderModulePath?: string
): Set<string> {
  const tracked = new Set<string>();

  for (const configPath of resolveNodeApiForgeProjectConfigPaths(workspaceFolder)) {
    tracked.add(normalizePath(configPath));
  }

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

async function openNodeApiForgeProjectConfig(workspaceRoot: string): Promise<void> {
  const configPath = resolveNodeApiForgeProjectConfigPaths(workspaceRoot)[0];
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

  if (!fs.existsSync(configPath)) {
    const initialConfig = {
      frameworks: ['auto'],
      contextProperties: ['locals'],
      customSeedLoaderModulePath: '',
      autoRefreshOnFileChanges: true,
      externalCallLibraries: [],
      searchComponentLibAllowlist: [],
      apiExplorerFrameworkPageSize: 200
    };
    await fs.promises.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf-8');
  }

  const document = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(document, { preview: false });
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

/** Get the current git branch name using the VS Code git extension API. */
async function getGitBranch(): Promise<string | undefined> {
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return undefined;
    const gitApi = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = gitApi?.getAPI?.(1);
    if (!api) return undefined;
    const repos = api.repositories as Array<{ state: { HEAD?: { name?: string } } }>;
    if (!repos || repos.length === 0) return undefined;
    return repos[0].state.HEAD?.name;
  } catch {
    return undefined;
  }
}

/**
 * Given a handler file path, try to find a co-located test file.
 * Searches common test patterns: *.test.ts, *.spec.ts, __tests__/*, test/*.
 */
async function findTestFile(handlerFilePath: string): Promise<string | undefined> {
  const dir = path.dirname(handlerFilePath);
  const base = path.basename(handlerFilePath, path.extname(handlerFilePath));
  const ext = path.extname(handlerFilePath);

  const candidates = [
    path.join(dir, `${base}.test${ext}`),
    path.join(dir, `${base}.spec${ext}`),
    path.join(dir, `${base}.test.ts`),
    path.join(dir, `${base}.spec.ts`),
    path.join(dir, `${base}.test.js`),
    path.join(dir, `${base}.spec.js`),
    path.join(dir, '__tests__', `${base}.test${ext}`),
    path.join(dir, '__tests__', `${base}.spec${ext}`),
    path.join(dir, '__tests__', `${base}${ext}`),
    path.join(dir, '..', '__tests__', `${base}.test${ext}`),
    path.join(dir, '..', '__tests__', `${base}.spec${ext}`),
    path.join(dir, '..', 'test', `${base}.test${ext}`),
    path.join(dir, '..', 'test', `${base}.spec${ext}`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Broader search using VS Code file search
  const results = await vscode.workspace.findFiles(
    `**/${base}.{test,spec}.{ts,js,tsx,jsx}`,
    '**/node_modules/**',
    1
  );
  return results[0]?.fsPath;
}

async function resolveFrameworksByProjectRoot(
  projectRoots: string[],
  configuredFrameworks: string[],
  frameworkDetector: FrameworkDetector,
  workspaceState: vscode.Memento
): Promise<Record<string, ApiFramework[]>> {
  const { explicit, includeAuto } = parseConfiguredFrameworks(configuredFrameworks);
  if (!includeAuto && explicit.length > 0) {
    return Object.fromEntries(projectRoots.map((projectRoot) => [projectRoot, explicit]));
  }

  const resolved: Record<string, ApiFramework[]> = {};
  for (const projectRoot of projectRoots) {
    const cacheKey = `${FRAMEWORK_CACHE_PREFIX}${projectRoot}`;
    const fingerprint = frameworkDetector.buildFingerprint(projectRoot);
    const packageJsonMtimeMs = getPackageJsonMtimeMs(fingerprint.packageJsonPath);
    const cached = workspaceState.get<{ packageJsonMtimeMs: number | null; frameworks: ApiFramework[] }>(cacheKey);

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

function normalizeConfiguredFrameworks(configuredFrameworks: string[]): ApiFramework[] {
  const normalized = configuredFrameworks.map((item) => item.toLowerCase());
  const validFrameworks = new Set<ApiFramework>(['express', 'fastify', 'nestjs', 'lambda', 'unknown']);
  const selected = normalized
    .filter((item): item is ApiFramework => validFrameworks.has(item as ApiFramework));

  return Array.from(new Set(selected));
}

function parseConfiguredFrameworks(configuredFrameworks: string[]): {
  explicit: ApiFramework[];
  includeAuto: boolean;
} {
  const normalized = configuredFrameworks.map((item) => item.toLowerCase());
  return {
    explicit: normalizeConfiguredFrameworks(configuredFrameworks),
    includeAuto: normalized.includes('auto') || normalized.length === 0
  };
}

function mergeFrameworkLists(
  detected: ApiFramework[],
  explicit: ApiFramework[]
): ApiFramework[] {
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
