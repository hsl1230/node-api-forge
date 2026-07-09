import { resolveProjectName } from '../discovery/project-name';
import { ApiEndpoint, ApiFramework, DiscoveryResult } from '../discovery/types';

export interface HttpForgeCollectionExportOptions {
  collectionName?: string;
  description?: string;
  baseUrl?: string;
  projectRoots?: string[];
}

export interface HttpForgeCollection {
  id: string;
  name: string;
  description?: string;
  version: string;
  variables: Record<string, string>;
  items: HttpForgeCollectionItem[];
}

export type HttpForgeCollectionItem = HttpForgeFolderItem | HttpForgeRequestItem;

export interface HttpForgeFolderItem {
  type: 'folder';
  id: string;
  name: string;
  description?: string;
  items: HttpForgeCollectionItem[];
}

export interface HttpForgeRequestItem {
  type: 'request';
  id: string;
  name: string;
  description?: string;
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; enabled?: boolean }>;
  query: Array<{ key: string; value: string; enabled?: boolean }>;
  body?: {
    type: 'raw';
    format: 'json';
    content: string;
  };
}

const DEFAULT_BASE_URL = 'http://localhost:3000';

export function buildHttpForgeCollection(result: DiscoveryResult, options: HttpForgeCollectionExportOptions = {}): HttpForgeCollection {
  const collectionName = options.collectionName ?? 'Node API Forge Discovery';
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const grouped = groupEndpointsByProjectAndFramework(result.endpoints, options.projectRoots ?? []);
  let requestIndex = 0;

  return {
    id: `node-api-forge-${Date.now()}`,
    name: collectionName,
    description: options.description ?? 'Exported from Node API Forge discovery results.',
    version: '1.0.0',
    variables: {
      BASE_URL: baseUrl
    },
    items: Object.entries(grouped).map(([projectName, frameworkGroups]) => ({
      type: 'folder' as const,
      id: `project-${slugify(projectName)}`,
      name: projectName,
      description: `Endpoints discovered in project ${projectName}.`,
      items: (['express', 'nestjs', 'fastify', 'lambda', 'unknown'] as ApiFramework[])
        .filter((framework) => frameworkGroups[framework].length > 0)
        .map((framework) => ({
          type: 'folder' as const,
          id: `project-${slugify(projectName)}-framework-${framework}`,
          name: framework.toUpperCase(),
          description: `${framework.toUpperCase()} endpoints discovered in source code.`,
          items: frameworkGroups[framework].map((endpoint) => {
            requestIndex += 1;
            return buildRequestItem(endpoint, requestIndex);
          })
        }))
    }))
  };
}

export function serializeHttpForgeCollection(result: DiscoveryResult, options: HttpForgeCollectionExportOptions = {}): string {
  return JSON.stringify(buildHttpForgeCollection(result, options), null, 2);
}

function groupEndpointsByProjectAndFramework(
  endpoints: ApiEndpoint[],
  projectRoots: string[]
): Record<string, Record<ApiFramework, ApiEndpoint[]>> {
  const grouped: Record<string, Record<ApiFramework, ApiEndpoint[]>> = {};

  for (const endpoint of endpoints) {
    const projectName = resolveProjectName(endpoint, projectRoots) ?? 'Unmapped Project';
    if (!grouped[projectName]) {
      grouped[projectName] = { express: [], nestjs: [], fastify: [], lambda: [], unknown: [] };
    }
    grouped[projectName][endpoint.framework].push(endpoint);
  }

  return Object.fromEntries(
    Object.entries(grouped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectName, frameworkGroups]) => [
        projectName,
        Object.fromEntries(
          (['express', 'nestjs', 'fastify', 'lambda', 'unknown'] as ApiFramework[]).map((framework) => [
            framework,
            frameworkGroups[framework]
          ])
        ) as Record<ApiFramework, ApiEndpoint[]>
      ])
  );
}

function buildRequestItem(endpoint: ApiEndpoint, index: number): HttpForgeRequestItem {
  const resolvedPath = normalizePath(withPathPlaceholders(endpoint.resolvedPath ?? endpoint.pathExpression));
  const body = inferRequestBody(endpoint.method, resolvedPath);
  const headers = [
    { key: 'Accept', value: 'application/json', enabled: true }
  ];

  if (body) {
    headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
  }

  return {
    type: 'request',
    id: `request-${index + 1}-${slugify(endpoint.method)}-${slugify(resolvedPath)}`,
    name: `${endpoint.method} ${resolvedPath}`,
    description: buildDescription(endpoint),
    method: endpoint.method,
    url: `{{BASE_URL}}${resolvedPath}`,
    headers,
    query: [],
    ...(body ? { body } : {})
  };
}

function buildDescription(endpoint: ApiEndpoint): string {
  const handler = `${endpoint.handlerLocation.filePath}:${endpoint.handlerLocation.line}`;
  const middleware = endpoint.middleware.length > 0 ? ` Middleware: ${endpoint.middleware.map((item) => item.name).join(', ')}` : '';
  return `${endpoint.framework.toUpperCase()} endpoint discovered at ${handler}. Confidence: ${endpoint.confidence}.${middleware}`;
}

function normalizePath(pathValue: string): string {
  if (!pathValue) {
    return '/';
  }

  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

function withPathPlaceholders(pathValue: string): string {
  return normalizePath(pathValue)
    .replace(/:([A-Za-z0-9_]+)/g, '{{$1}}')
    .replace(/\{([A-Za-z0-9_]+)\}(?!\})/g, '{{$1}}')
    .replace(/\*/g, '{{wildcard}}');
}

function inferRequestBody(method: string, pathValue: string): HttpForgeRequestItem['body'] | undefined {
  if (!['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    return undefined;
  }

  const segments = pathValue.split('/').filter(Boolean);
  const resourceName = [...segments].reverse().find((segment) => !segment.startsWith('{') && !segment.endsWith('}')) ?? segments.slice(-1)[0] ?? 'item';
  const baseName = resourceName.replace(/\{.+?\}/g, 'value').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';

  return {
    type: 'raw',
    format: 'json',
    content: JSON.stringify(
      {
        name: `${baseName} name`,
        description: `Sample ${baseName} payload`
      },
      null,
      2
    )
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

/** Export only the endpoints belonging to a single named project. */
export function serializeScopedProjectCollection(
  result: DiscoveryResult,
  projectName: string,
  options: HttpForgeCollectionExportOptions = {}
): string {
  const filtered: DiscoveryResult = {
    ...result,
    endpoints: result.endpoints.filter((ep) => {
      const name = resolveProjectName(ep, options.projectRoots ?? []) ?? 'Unmapped Project';
      return name === projectName;
    })
  };
  return serializeHttpForgeCollection(filtered, {
    ...options,
    collectionName: options.collectionName ?? projectName,
    description: `Endpoints for project: ${projectName}`
  });
}

/** Export only the endpoints belonging to a specific project + framework combination. */
export function serializeScopedFrameworkCollection(
  result: DiscoveryResult,
  projectName: string,
  framework: ApiFramework,
  options: HttpForgeCollectionExportOptions = {}
): string {
  const filtered: DiscoveryResult = {
    ...result,
    endpoints: result.endpoints.filter((ep) => {
      const name = resolveProjectName(ep, options.projectRoots ?? []) ?? 'Unmapped Project';
      return name === projectName && ep.framework === framework;
    })
  };
  return serializeHttpForgeCollection(filtered, {
    ...options,
    collectionName: options.collectionName ?? `${projectName} – ${framework.toUpperCase()}`,
    description: `${framework.toUpperCase()} endpoints for project: ${projectName}`
  });
}