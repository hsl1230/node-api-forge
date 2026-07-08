import * as ts from 'typescript';
import { createResolutionContext, joinPaths, toPathValue } from '../path-utils';
import { ApiEndpoint, DiscoveryContext, EndpointConfidence, FrameworkFingerprint } from '../types';
import { ComponentAnalyzer, PrefixState, RouteDefinitionBase, analyzeComponentChainMetadata, combineConfidence, extractPathParameters } from './component-analyzer';

interface RouteDefinition extends RouteDefinitionBase {
  owner: string;
  middlewareNodes: ts.Expression[];
  handlerNode: ts.Expression;
}

interface MountEdge {
  parent: string;
  child: string;
  prefix: PrefixState;
  middlewareNodes: ts.Expression[];
}

interface ParamCallback {
  paramName: string;
  node: ts.Expression;
}

interface ResolvedPrefixState extends PrefixState {
  middlewareNodes: ts.Expression[];
}

/**
 * Analyzes Express applications for API endpoints.
 *
 * Handles:
 * - app.get/post/put/delete/patch routes
 * - nested router mounts via app.use(prefix, router)
 * - route() chains
 * - middleware extraction
 */
export class ExpressComponentAnalyzer implements ComponentAnalyzer {
  public async analyzeFile(
    filePath: string,
    content: string,
    fingerprint: FrameworkFingerprint,
    context: DiscoveryContext
  ): Promise<ApiEndpoint[]> {
    const source = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );

    const routerNames = new Set<string>(['app', 'router']);
    const mountEdges: MountEdge[] = [];
    const routeDefinitions: RouteDefinition[] = [];
    const ownerMiddlewareNodes = new Map<string, ts.Expression[]>();
    const ownerParamCallbacks = new Map<string, ParamCallback[]>();
    const resolutionContext = createResolutionContext(source, fingerprint.projectRoot, context.envOverrides);

    const collectRouters = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initText = node.initializer.getText(source);
        if (/express\.Router\s*\(/.test(initText) || /Router\s*\(/.test(initText) || /express\(\)/.test(initText)) {
          routerNames.add(node.name.text);
        }
      }
      ts.forEachChild(node, collectRouters);
    };

    collectRouters(source);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const objectName = node.expression.expression.getText(source);
        const methodName = node.expression.name.text;

        if (methodName === 'use' && node.arguments.length >= 1 && routerNames.has(objectName)) {
          const lastArg = node.arguments[node.arguments.length - 1];
          const hasMountedRouter = node.arguments.length >= 2 && ts.isIdentifier(lastArg) && routerNames.has(lastArg.text);

          if (hasMountedRouter && ts.isIdentifier(lastArg)) {
            const mountValue = toPathValue(node.arguments[0], source, resolutionContext);
            mountEdges.push({
              parent: objectName,
              child: lastArg.text,
              prefix: mountValue,
              middlewareNodes: node.arguments.slice(1, -1)
            });
          } else {
            const middlewareArgs = isPathArgument(node.arguments[0]) ? node.arguments.slice(1) : node.arguments.slice(0);
            const existing = ownerMiddlewareNodes.get(objectName) ?? [];
            existing.push(...middlewareArgs);
            ownerMiddlewareNodes.set(objectName, existing);
          }
        }

        if (methodName === 'param' && node.arguments.length >= 2 && routerNames.has(objectName)) {
          const paramName = getParamName(node.arguments[0]);
          const callbackNode = node.arguments[1];
          if (paramName && callbackNode && ts.isExpression(callbackNode)) {
            const existing = ownerParamCallbacks.get(objectName) ?? [];
            existing.push({ paramName, node: callbackNode });
            ownerParamCallbacks.set(objectName, existing);
          }
        }

        const routeMethod = mapExpressMethod(methodName);
        if (routeMethod && routerNames.has(objectName) && node.arguments.length >= 1) {
          const routeValue = toPathValue(node.arguments[0], source, resolutionContext);
          const middleware = extractExpressMiddleware(node.arguments.slice(1), source);
          const handlerArg = node.arguments[node.arguments.length - 1];
          const handlerPos = source.getLineAndCharacterOfPosition(handlerArg.getStart(source));
          routeDefinitions.push({
            owner: objectName,
            method: routeMethod,
            pathExpression: routeValue.pathExpression,
            resolvedPath: routeValue.resolvedPath,
            confidence: routeValue.confidence,
            middleware,
            middlewareNodes: node.arguments.slice(1, -1),
            handlerNode: handlerArg,
            handlerLocation: {
              filePath,
              line: handlerPos.line + 1,
              column: handlerPos.character + 1,
              symbolName: handlerArg.getText(source)
            }
          });
        }

        if (methodName === 'route' && node.arguments[0]) {
          const basePath = toPathValue(node.arguments[0], source, resolutionContext);
          const chain = node.parent;
          if (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
            const chainMethod = mapExpressMethod(chain.expression.name.text);
            if (chainMethod) {
              const handler = chain.arguments[0] ?? node.arguments[0];
              const handlerPos = source.getLineAndCharacterOfPosition(handler.getStart(source));
              routeDefinitions.push({
                owner: objectName,
                method: chainMethod,
                pathExpression: basePath.pathExpression,
                resolvedPath: basePath.resolvedPath,
                confidence: basePath.confidence,
                middleware: [],
                middlewareNodes: [],
                handlerNode: handler,
                handlerLocation: {
                  filePath,
                  line: handlerPos.line + 1,
                  column: handlerPos.character + 1,
                  symbolName: handler.getText(source)
                }
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);

    const endpoints: ApiEndpoint[] = [];
    const prefixMap = buildPrefixMap(mountEdges);
    for (const routeDefinition of routeDefinitions) {
      const resolvedPrefixes = prefixMap.get(routeDefinition.owner) ?? [];
      const prefixes = resolvedPrefixes.length > 0 ? resolvedPrefixes : [{ pathExpression: '', confidence: 'high' as EndpointConfidence, middlewareNodes: [] }];

      for (const prefix of prefixes) {
        const combined = joinPaths(prefix.pathExpression, routeDefinition.pathExpression);
        const confidence = combineConfidence(prefix.confidence, routeDefinition.confidence);
        const hasResolvedPath = Boolean(prefix.pathExpression || prefix.resolvedPath) && Boolean(routeDefinition.resolvedPath);

        // Extract path parameters from the combined path
        const pathParams = extractPathParameters(combined.pathExpression);
        const ownerNodes = ownerMiddlewareNodes.get(routeDefinition.owner) ?? [];
        const paramNodes = resolveParamCallbackNodes(routeDefinition.owner, mountEdges, ownerParamCallbacks, combined.pathExpression);
        const chainNodes = [
          ...prefix.middlewareNodes,
          ...ownerNodes,
          ...paramNodes,
          ...routeDefinition.middlewareNodes,
          routeDefinition.handlerNode
        ];
        const metadata = analyzeComponentChainMetadata(chainNodes, source, filePath, routeDefinition.method);
        metadata.parameters.unshift(...pathParams);

        endpoints.push({
          method: routeDefinition.method,
          framework: 'express',
          pathExpression: combined.pathExpression,
          resolvedPath: confidence === 'high' && hasResolvedPath ? combined.resolvedPath : undefined,
          confidence,
          handlerLocation: routeDefinition.handlerLocation,
          middleware: routeDefinition.middleware,
          parameters: metadata.parameters.length > 0 ? metadata.parameters : undefined,
          requestBody: metadata.requestBody,
          cookies: metadata.cookies.length > 0 ? metadata.cookies : undefined,
          responses: metadata.responses
        });
      }
    }

    return endpoints;
  }
}

function mapExpressMethod(value: string): string | undefined {
  const map: Record<string, string> = {
    get: 'GET',
    post: 'POST',
    put: 'PUT',
    delete: 'DELETE',
    patch: 'PATCH',
    options: 'OPTIONS',
    head: 'HEAD',
    all: 'ALL'
  };
  return map[value];
}

function extractExpressMiddleware(args: readonly ts.Expression[], source: ts.SourceFile) {
  if (args.length <= 1) {
    return [];
  }

  const middleware = [];
  for (const arg of args.slice(1, -1)) {
    middleware.push({ name: arg.getText(source) });
  }
  return middleware;
}

function buildPrefixMap(edges: MountEdge[]): Map<string, ResolvedPrefixState[]> {
  const adjacency = new Map<string, MountEdge[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.parent) ?? [];
    list.push(edge);
    adjacency.set(edge.parent, list);
  }

  const prefixMap = new Map<string, ResolvedPrefixState[]>();
  prefixMap.set('app', [{ pathExpression: '', resolvedPath: '', confidence: 'high', middlewareNodes: [] }]);
  const queue: string[] = ['app'];

  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentPrefixes = prefixMap.get(parent) ?? [];
    const children = adjacency.get(parent) ?? [];

    for (const edge of children) {
      const nextPrefixes = prefixMap.get(edge.child) ?? [];
      let updated = false;

      for (const parentPrefix of parentPrefixes) {
        const combined = joinPaths(parentPrefix.pathExpression, edge.prefix.pathExpression);
        const confidence = combineConfidence(parentPrefix.confidence, edge.prefix.confidence);
        const candidate: ResolvedPrefixState = {
          pathExpression: combined.pathExpression,
          resolvedPath: parentPrefix.resolvedPath && edge.prefix.resolvedPath ? combined.resolvedPath : undefined,
          confidence,
          middlewareNodes: [...parentPrefix.middlewareNodes, ...edge.middlewareNodes]
        };

        if (!nextPrefixes.some((item) => item.pathExpression === candidate.pathExpression && item.resolvedPath === candidate.resolvedPath)) {
          nextPrefixes.push(candidate);
          updated = true;
        }
      }

      if (updated) {
        prefixMap.set(edge.child, nextPrefixes);
        queue.push(edge.child);
      }
    }
  }

  return prefixMap;
}

function isPathArgument(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression)
  );
}

function getParamName(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

function resolveParamCallbackNodes(
  owner: string,
  mountEdges: MountEdge[],
  ownerParamCallbacks: Map<string, ParamCallback[]>,
  routePathExpression: string
): ts.Expression[] {
  const pathParamNames = new Set(extractPathParameters(routePathExpression).map((item) => item.name));
  if (pathParamNames.size === 0) {
    return [];
  }

  const ancestors = resolveOwnerAncestors(owner, mountEdges);
  const callbacks: ts.Expression[] = [];
  for (const item of ancestors) {
    const registered = ownerParamCallbacks.get(item) ?? [];
    for (const callback of registered) {
      if (pathParamNames.has(callback.paramName)) {
        callbacks.push(callback.node);
      }
    }
  }

  return callbacks;
}

function resolveOwnerAncestors(owner: string, mountEdges: MountEdge[]): string[] {
  const childToParents = new Map<string, string[]>();
  for (const edge of mountEdges) {
    const parents = childToParents.get(edge.child) ?? [];
    parents.push(edge.parent);
    childToParents.set(edge.child, parents);
  }

  const ordered: string[] = [];
  const visited = new Set<string>();

  const visit = (current: string): void => {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    for (const parent of childToParents.get(current) ?? []) {
      visit(parent);
    }
    ordered.push(current);
  };

  visit(owner);
  return ordered;
}
