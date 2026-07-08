import * as vscode from 'vscode';
import { DISCOVER_APIS_COMMAND_ID, OPEN_HTTP_FORGE_COMMAND_ID } from '../commands';
import { ApiDiscoveryEngine } from './discovery-engine';
import { resolveProjectName } from './project-name';
import { ApiEndpoint, ApiFramework, DiscoveryContext, DiscoveryResult } from './types';

export class ApiExplorerTreeProvider implements vscode.TreeDataProvider<ApiExplorerTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ApiExplorerTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private lastResult: DiscoveryResult | undefined;
  private lastContext: DiscoveryContext | undefined;

  constructor(private readonly discoveryEngine: ApiDiscoveryEngine) {}

  public async refresh(context?: DiscoveryContext): Promise<DiscoveryResult | undefined> {
    if (!context) {
      this.lastResult = undefined;
      this.lastContext = undefined;
      this.changeEmitter.fire();
      return undefined;
    }

    this.lastContext = context;
    this.lastResult = await this.discoveryEngine.discover(context);
    this.changeEmitter.fire();
    return this.lastResult;
  }

  public getLastResult(): DiscoveryResult | undefined {
    return this.lastResult;
  }

  getTreeItem(element: ApiExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ApiExplorerTreeItem): ApiExplorerTreeItem[] {
    try {
      if (!this.lastResult) {
        const item = new ApiExplorerTreeItem('Run Discover APIs to load endpoints', vscode.TreeItemCollapsibleState.None);
        item.command = { command: DISCOVER_APIS_COMMAND_ID, title: 'Discover APIs' };
        return [item];
      }

      if (!element) {
        const projectGroups = groupByProject(this.lastResult.endpoints, this.lastContext);
        return Object.entries(projectGroups).map(([project, projectEndpoints]) => {
          const item = new ApiExplorerTreeItem(
            `${project} (${projectEndpoints.length})`,
            vscode.TreeItemCollapsibleState.Expanded
          );
          item.contextValue = 'projectGroup';
          const frameworks = groupByFramework(projectEndpoints);
          item.children = Object.entries(frameworks)
            .filter(([, endpoints]) => endpoints.length > 0)
            .map(([framework, endpoints]) => {
              const frameworkItem = new ApiExplorerTreeItem(
                `${framework.toUpperCase()} (${endpoints.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
              );
              frameworkItem.contextValue = 'frameworkGroup';
              frameworkItem.children = endpoints.map((endpoint, index) => {
                try {
                  return new EndpointTreeItem(endpoint);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const badEndpoint = new ApiExplorerTreeItem(
                    `Invalid endpoint #${index + 1}: ${message}`,
                    vscode.TreeItemCollapsibleState.None
                  );
                  badEndpoint.contextValue = 'endpointError';
                  return badEndpoint;
                }
              });
              return frameworkItem;
            });
          return item;
        });
      }

      return element.children ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Node API Forge] Failed to render API Explorer tree:', error);
      return [new ApiExplorerTreeItem(`Failed to render API Explorer: ${message}`, vscode.TreeItemCollapsibleState.None)];
    }
  }
}

class ApiExplorerTreeItem extends vscode.TreeItem {
  public children?: ApiExplorerTreeItem[];

  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
  }
}

class EndpointTreeItem extends ApiExplorerTreeItem {
  constructor(private readonly endpoint: ApiEndpoint) {
    super(formatLabel(endpoint), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'endpoint';
    this.description = `${endpoint.confidence} confidence`;
    this.command = {
      command: OPEN_HTTP_FORGE_COMMAND_ID,
      title: 'Open Endpoint in HTTP Forge',
      arguments: [endpoint]
    };
  }
}

function groupByFramework(endpoints: ApiEndpoint[]): Record<ApiFramework, ApiEndpoint[]> {
  return endpoints.reduce(
    (acc, endpoint) => {
      acc[endpoint.framework].push(endpoint);
      return acc;
    },
    { express: [], nestjs: [], fastify: [], unknown: [] } as Record<ApiFramework, ApiEndpoint[]>
  );
}

function groupByProject(endpoints: ApiEndpoint[], context?: DiscoveryContext): Record<string, ApiEndpoint[]> {
  const projectRoots = context?.includeProjectRoots?.length
    ? context.includeProjectRoots
    : (context ? [context.workspaceFolder] : []);

  const grouped: Record<string, ApiEndpoint[]> = {};
  for (const endpoint of endpoints) {
    const project = resolveProjectName(endpoint, projectRoots) ?? 'Unmapped Project';
    if (!grouped[project]) {
      grouped[project] = [];
    }
    grouped[project].push(endpoint);
  }

  return Object.fromEntries(
    Object.entries(grouped).sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  );
}

function formatLabel(endpoint: ApiEndpoint): string {
  const method = endpoint.method ?? 'UNKNOWN';
  const customDisplayName = (endpoint as { displayName?: unknown }).displayName;
  if (typeof customDisplayName === 'string' && customDisplayName.trim().length > 0) {
    return `${method} ${customDisplayName.trim()}`;
  }
  const resolved = endpoint.resolvedPath ?? endpoint.pathExpression ?? '<missing-path>';
  return `${method} ${resolved}`;
}
