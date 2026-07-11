import * as vscode from 'vscode';
import { DISCOVER_APIS_COMMAND_ID, OPEN_HTTP_FORGE_COMMAND_ID } from '../commands';
import { getNodeApiForgeApiExplorerFrameworkPageSize } from '../config/project-config';
import { ApiDiscoveryEngine } from './discovery-engine';
import { formatEndpointDisplayLabel } from './endpoint-display';
import { resolveProjectName } from './project-name';
import { ApiEndpoint, ApiFramework, DiscoveryContext, DiscoveryResult } from './types';

type ExplorerNodeData =
  | { kind: 'project'; projectName: string; endpoints: ApiEndpoint[] }
  | { kind: 'framework'; framework: ApiFramework; endpoints: ApiEndpoint[] }
  | { kind: 'framework-page'; framework: ApiFramework; endpoints: ApiEndpoint[]; offset: number; limit: number }
  | { kind: 'endpoint'; endpoint: ApiEndpoint };

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

  public refreshTree(): void {
    this.changeEmitter.fire();
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
            vscode.TreeItemCollapsibleState.Collapsed
          );
          item.contextValue = 'projectGroup';
          item.data = { kind: 'project', projectName: project, endpoints: projectEndpoints };
          return item;
        });
      }

      if (element.data?.kind === 'project') {
        const frameworks = groupByFramework(element.data.endpoints);
        return Object.entries(frameworks)
          .filter(([, endpoints]) => endpoints.length > 0)
          .map(([framework, endpoints]) => {
            const frameworkItem = new ApiExplorerTreeItem(
              `${framework.toUpperCase()} (${endpoints.length})`,
              vscode.TreeItemCollapsibleState.Collapsed
            );
            frameworkItem.contextValue = 'frameworkGroup';
            frameworkItem.data = { kind: 'framework', framework: framework as ApiFramework, endpoints };
            return frameworkItem;
          });
      }

      if (element.data?.kind === 'framework') {
        const pageSize = getFrameworkEndpointPageSize();
        if (element.data.endpoints.length > pageSize) {
          const pageItems: ApiExplorerTreeItem[] = [];
          for (let offset = 0; offset < element.data.endpoints.length; offset += pageSize) {
            const end = Math.min(offset + pageSize, element.data.endpoints.length);
            const pageItem = new ApiExplorerTreeItem(
              `Endpoints ${offset + 1}-${end}`,
              vscode.TreeItemCollapsibleState.Collapsed
            );
            pageItem.contextValue = 'frameworkPage';
            pageItem.data = {
              kind: 'framework-page',
              framework: element.data.framework,
              endpoints: element.data.endpoints,
              offset,
              limit: pageSize
            };
            pageItems.push(pageItem);
          }
          return pageItems;
        }

        return element.data.endpoints.map((endpoint, index) => {
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
      }

      if (element.data?.kind === 'framework-page') {
        const pageData = element.data;
        const slice = pageData.endpoints.slice(pageData.offset, pageData.offset + pageData.limit);
        return slice.map((endpoint, index) => {
          try {
            return new EndpointTreeItem(endpoint);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const badEndpoint = new ApiExplorerTreeItem(
              `Invalid endpoint #${pageData.offset + index + 1}: ${message}`,
              vscode.TreeItemCollapsibleState.None
            );
            badEndpoint.contextValue = 'endpointError';
            return badEndpoint;
          }
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
  public data?: ExplorerNodeData;

  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
  }
}

class EndpointTreeItem extends ApiExplorerTreeItem {
  constructor(private readonly endpoint: ApiEndpoint) {
    super(formatEndpointDisplayLabel(endpoint), vscode.TreeItemCollapsibleState.None);
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
    { express: [], nestjs: [], fastify: [], lambda: [], unknown: [] } as Record<ApiFramework, ApiEndpoint[]>
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

function getFrameworkEndpointPageSize(): number {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const configured = getNodeApiForgeApiExplorerFrameworkPageSize(workspaceRoot);

  if (!Number.isFinite(configured)) {
    return 200;
  }

  const normalized = Math.trunc(configured);
  return Math.min(1000, Math.max(25, normalized));
}
