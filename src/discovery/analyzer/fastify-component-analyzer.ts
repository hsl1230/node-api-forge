import * as ts from 'typescript';
import { createResolutionContext, joinPaths, toPathValue } from '../path-utils';
import { ApiEndpoint, ApiParameter, DiscoveryContext, FrameworkFingerprint } from '../types';
import { ComponentAnalyzer, EndpointMetadata, PrefixState, RouteDefinitionBase, analyzeComponentChainMetadata, combineConfidence, dedupeApiParameters, extractPathParameters } from './component-analyzer';

interface RouteDefinition extends RouteDefinitionBase {
  owner: string;
  handlerNode: ts.Expression;
  middlewareNodes: ts.Expression[];
  schemaMetadata?: EndpointMetadata;
}

/**
 * Analyzes Fastify applications for API endpoints.
 *
 * Handles:
 * - fastify.get/post/put/delete/patch routes
 * - nested plugins via fastify.register()
 * - route() config objects
 * - preHandler middleware
 */
export class FastifyComponentAnalyzer implements ComponentAnalyzer {
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

    const rootOwners = new Set<string>(['fastify']);
    const prefixStates: PrefixState[] = [{ pathExpression: '', resolvedPath: '', confidence: 'high' }];
    const routeDefinitions: RouteDefinition[] = [];
    const ownerHookNodes = new Map<string, ts.Expression[]>();
    const ownerParent = new Map<string, string>();
    const resolutionContext = createResolutionContext(source, fingerprint.projectRoot, context.envOverrides);

    const visit = (node: ts.Node, owners: Set<string>, prefixes: PrefixState[]): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initText = node.initializer.getText(source);
        if (initText.includes('fastify(') || initText.includes('Fastify(')) {
          owners.add(node.name.text);
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const objectText = node.expression.expression.getText(source);
        const methodName = node.expression.name.text;

        if (methodName === 'register') {
          const childOwner = getPluginOwnerName(node.arguments[0]);
          if (childOwner) {
            ownerParent.set(childOwner, objectText);
          }
          handleFastifyRegister(node, source, owners, prefixes, visit, resolutionContext);
        }

        if (methodName === 'addHook' && owners.has(objectText) && node.arguments.length >= 2 && isPreRequestHook(node.arguments[0], source)) {
          const hooks = ownerHookNodes.get(objectText) ?? [];
          hooks.push(node.arguments[1]);
          ownerHookNodes.set(objectText, hooks);
        }

        const routeMethod = mapFastifyMethod(methodName);
        if (routeMethod && owners.has(objectText) && node.arguments[0]) {
          const pathValue = toPathValue(node.arguments[0], source, resolutionContext);
          const optionsArg = node.arguments.length >= 2 && ts.isObjectLiteralExpression(node.arguments[1]) ? node.arguments[1] : undefined;
          const handler = optionsArg && node.arguments[2] ? node.arguments[2] : node.arguments[node.arguments.length - 1];
          const handlerPos = source.getLineAndCharacterOfPosition(handler.getStart(source));
          const preHandlerProp = optionsArg ? getObjectProperty(optionsArg, 'preHandler') : undefined;
          const middleware = extractFastifyMiddleware(preHandlerProp, source);
          const middlewareNodes = extractFastifyMiddlewareNodes(preHandlerProp);
          const schemaMetadata = optionsArg ? extractFastifySchemaMetadata(getObjectProperty(optionsArg, 'schema'), source, routeMethod) : undefined;

          for (const prefix of prefixes) {
            const combined = joinPaths(prefix.pathExpression, pathValue.pathExpression);
            const confidence = combineConfidence(prefix.confidence, pathValue.confidence);
            routeDefinitions.push({
              owner: objectText,
              method: routeMethod,
              pathExpression: combined.pathExpression,
              resolvedPath: confidence === 'high' && prefix.resolvedPath && pathValue.resolvedPath ? combined.resolvedPath : undefined,
              confidence,
              handlerNode: handler,
              middlewareNodes,
              schemaMetadata,
              handlerLocation: {
                filePath,
                line: handlerPos.line + 1,
                column: handlerPos.character + 1,
                symbolName: handler.getText(source)
              },
              middleware
            });
          }
        }

        if (methodName === 'route' && owners.has(objectText) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          const routeConfig = node.arguments[0];
          const methodProp = getObjectProperty(routeConfig, 'method');
          const urlProp = getObjectProperty(routeConfig, 'url') ?? getObjectProperty(routeConfig, 'path');
          const handlerProp = getObjectProperty(routeConfig, 'handler');
          const preHandlerProp = getObjectProperty(routeConfig, 'preHandler');
          const schemaProp = getObjectProperty(routeConfig, 'schema');

          const pathValue = toPathValue(urlProp, source, resolutionContext);
          const methods = extractFastifyMethods(methodProp, source);
          const middleware = extractFastifyMiddleware(preHandlerProp, source);

          for (const resolvedMethod of methods) {
            const handlerPos = handlerProp
              ? source.getLineAndCharacterOfPosition(handlerProp.getStart(source))
              : source.getLineAndCharacterOfPosition(routeConfig.getStart(source));

            for (const prefix of prefixes) {
              const combined = joinPaths(prefix.pathExpression, pathValue.pathExpression);
              const confidence = combineConfidence(prefix.confidence, pathValue.confidence);
              routeDefinitions.push({
                owner: objectText,
                method: resolvedMethod,
                pathExpression: combined.pathExpression,
                resolvedPath: confidence === 'high' && prefix.resolvedPath && pathValue.resolvedPath ? combined.resolvedPath : undefined,
                confidence,
                handlerNode: handlerProp ?? routeConfig,
                middlewareNodes: extractFastifyMiddlewareNodes(preHandlerProp),
                schemaMetadata: extractFastifySchemaMetadata(schemaProp, source, resolvedMethod),
                handlerLocation: {
                  filePath,
                  line: handlerPos.line + 1,
                  column: handlerPos.character + 1,
                  symbolName: handlerProp?.getText(source)
                },
                middleware
              });
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, owners, prefixes));
    };

    visit(source, rootOwners, prefixStates);

    const endpoints: ApiEndpoint[] = [];
    for (const routeDefinition of routeDefinitions) {
      // Extract path parameters from the path expression
      const pathParams = extractPathParameters(routeDefinition.pathExpression);

      const inheritedHooks = resolveInheritedHooks(routeDefinition.owner, ownerHookNodes, ownerParent);
      const chainNodes = [...inheritedHooks, ...routeDefinition.middlewareNodes, routeDefinition.handlerNode];
      const metadata = analyzeComponentChainMetadata(chainNodes, source, filePath, routeDefinition.method);
      metadata.parameters.unshift(...pathParams);
      const mergedMetadata = mergeSchemaFirstMetadata(metadata, routeDefinition.schemaMetadata);

      endpoints.push({
        method: routeDefinition.method,
        framework: 'fastify',
        pathExpression: routeDefinition.pathExpression,
        resolvedPath: routeDefinition.resolvedPath,
        confidence: routeDefinition.confidence,
        handlerLocation: routeDefinition.handlerLocation,
        middleware: routeDefinition.middleware,
        parameters: mergedMetadata.parameters.length > 0 ? mergedMetadata.parameters : undefined,
        requestBody: mergedMetadata.requestBody,
        cookies: mergedMetadata.cookies.length > 0 ? mergedMetadata.cookies : undefined,
        responses: mergedMetadata.responses
      });
    }

    return endpoints;
  }
}

function handleFastifyRegister(
  node: ts.CallExpression,
  source: ts.SourceFile,
  owners: Set<string>,
  prefixes: PrefixState[],
  visit: (node: ts.Node, owners: Set<string>, prefixes: PrefixState[]) => void,
  resolutionContext: ReturnType<typeof createResolutionContext>
): void {
  const plugin = node.arguments[0];
  const options = node.arguments[1];
  const prefixValue = getRegisterPrefix(options, source, resolutionContext);
  const nextPrefixes = prefixValue
    ? prefixes.map((prefix) => {
        const combined = joinPaths(prefix.pathExpression, prefixValue.pathExpression);
        return {
          pathExpression: combined.pathExpression,
          resolvedPath: prefix.resolvedPath && prefixValue.resolvedPath ? combined.resolvedPath : undefined,
          confidence: combineConfidence(prefix.confidence, prefixValue.confidence)
        } satisfies PrefixState;
      })
    : prefixes;

  if (ts.isArrowFunction(plugin) || ts.isFunctionExpression(plugin)) {
    const nextOwners = new Set(owners);
    const firstParam = plugin.parameters[0];
    if (firstParam && ts.isIdentifier(firstParam.name)) {
      nextOwners.add(firstParam.name.text);
    }
    if (plugin.body) {
      ts.forEachChild(plugin.body, (child) => visit(child, nextOwners, nextPrefixes));
    }
  }
}

function getRegisterPrefix(
  options: ts.Expression | undefined,
  source: ts.SourceFile,
  resolutionContext: ReturnType<typeof createResolutionContext>
): PrefixState | undefined {
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }

  const prop = getObjectProperty(options, 'prefix');
  if (!prop) {
    return undefined;
  }

  const pathValue = toPathValue(prop, source, resolutionContext);
  return {
    pathExpression: pathValue.pathExpression,
    resolvedPath: pathValue.resolvedPath,
    confidence: pathValue.confidence
  };
}

function mapFastifyMethod(value: string): string | undefined {
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

function getObjectProperty(objectLiteral: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | undefined {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const name = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (name === propertyName) {
      return prop.initializer;
    }
  }
  return undefined;
}

function extractFastifyMethods(methodExpr: ts.Expression | undefined, source: ts.SourceFile): string[] {
  if (!methodExpr) {
    return ['GET'];
  }
  if (ts.isStringLiteral(methodExpr) || ts.isNoSubstitutionTemplateLiteral(methodExpr)) {
    return [methodExpr.text.toUpperCase()];
  }
  if (ts.isArrayLiteralExpression(methodExpr)) {
    return methodExpr.elements
      .map((element) => {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
          return element.text.toUpperCase();
        }
        return element.getText(source).toUpperCase();
      })
      .filter(Boolean);
  }
  return [methodExpr.getText(source).toUpperCase()];
}

function extractFastifyMiddleware(expr: ts.Expression | undefined, source: ts.SourceFile) {
  if (!expr) {
    return [];
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => ({ name: `preHandler:${element.getText(source)}` }));
  }
  return [{ name: `preHandler:${expr.getText(source)}` }];
}

function extractFastifyMiddlewareNodes(expr: ts.Expression | undefined): ts.Expression[] {
  if (!expr) {
    return [];
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.filter((element): element is ts.Expression => ts.isExpression(element));
  }
  return [expr];
}

function getPluginOwnerName(pluginArg: ts.Expression | undefined): string | undefined {
  if (!pluginArg) {
    return undefined;
  }

  if ((ts.isArrowFunction(pluginArg) || ts.isFunctionExpression(pluginArg)) && pluginArg.parameters[0] && ts.isIdentifier(pluginArg.parameters[0].name)) {
    return pluginArg.parameters[0].name.text;
  }

  return undefined;
}

function isPreRequestHook(hookArg: ts.Expression | undefined, source: ts.SourceFile): boolean {
  if (!hookArg || !ts.isStringLiteral(hookArg)) {
    return false;
  }
  const hookName = hookArg.text;
  return hookName === 'onRequest' || hookName === 'preParsing' || hookName === 'preValidation' || hookName === 'preHandler';
}

function resolveInheritedHooks(
  owner: string,
  ownerHooks: Map<string, ts.Expression[]>,
  ownerParent: Map<string, string>
): ts.Expression[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = owner;

  while (current && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = ownerParent.get(current);
  }

  const nodes: ts.Expression[] = [];
  for (const item of chain) {
    const hooks = ownerHooks.get(item) ?? [];
    nodes.push(...hooks);
  }
  return nodes;
}

function mergeSchemaFirstMetadata(inferred: EndpointMetadata, schema?: EndpointMetadata): EndpointMetadata {
  if (!schema) {
    return inferred;
  }

  return {
    parameters: dedupeApiParameters([...schema.parameters, ...inferred.parameters]),
    requestBody: schema.requestBody ?? inferred.requestBody,
    cookies: inferred.cookies,
    responses: inferred.responses
  };
}

function extractFastifySchemaMetadata(schemaExpr: ts.Expression | undefined, source: ts.SourceFile, method: string): EndpointMetadata | undefined {
  if (!schemaExpr || !ts.isObjectLiteralExpression(schemaExpr)) {
    return undefined;
  }

  const params: ApiParameter[] = [];
  const paramsSchema = getObjectProperty(schemaExpr, 'params');
  if (paramsSchema) {
    params.push(...extractSchemaProperties(paramsSchema, 'path', ''));
  }

  const querySchema = getObjectProperty(schemaExpr, 'querystring') ?? getObjectProperty(schemaExpr, 'query');
  if (querySchema) {
    params.push(...extractSchemaProperties(querySchema, 'query', ''));
  }

  const headersSchema = getObjectProperty(schemaExpr, 'headers');
  if (headersSchema) {
    params.push(...extractSchemaProperties(headersSchema, 'header', ''));
  }

  const bodySchema = getObjectProperty(schemaExpr, 'body');
  if (bodySchema) {
    params.push(...extractSchemaProperties(bodySchema, 'body', ''));
  }

  const requestBody = bodySchema
    ? {
        type: 'json',
        required: ['POST', 'PUT', 'PATCH'].includes(method),
        schema: bodySchema.getText(source)
      }
    : undefined;

  return {
    parameters: params,
    requestBody,
    cookies: [],
    responses: []
  };
}

function extractSchemaProperties(
  schemaExpr: ts.Expression,
  location: 'path' | 'query' | 'header' | 'body',
  prefix: string
): ApiParameter[] {
  if (!ts.isObjectLiteralExpression(schemaExpr)) {
    return [];
  }

  const propertiesExpr = getObjectProperty(schemaExpr, 'properties');
  if (!propertiesExpr || !ts.isObjectLiteralExpression(propertiesExpr)) {
    return [];
  }

  const requiredExpr = getObjectProperty(schemaExpr, 'required');
  const required = new Set<string>();
  if (requiredExpr && ts.isArrayLiteralExpression(requiredExpr)) {
    for (const item of requiredExpr.elements) {
      if (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)) {
        required.add(item.text);
      }
    }
  }

  const result: ApiParameter[] = [];
  for (const prop of propertiesExpr.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }

    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name) ? prop.name.text : undefined;
    if (!key) {
      continue;
    }

    const fullName = prefix ? `${prefix}.${key}` : key;
    const type = inferSchemaType(prop.initializer);
    result.push({
      name: fullName,
      location,
      type,
      required: required.has(key)
    });

    result.push(...extractSchemaProperties(prop.initializer, location, fullName));
  }

  return result;
}

function inferSchemaType(expr: ts.Expression): string | undefined {
  if (!ts.isObjectLiteralExpression(expr)) {
    return undefined;
  }

  const typeExpr = getObjectProperty(expr, 'type');
  if (typeExpr && (ts.isStringLiteral(typeExpr) || ts.isNoSubstitutionTemplateLiteral(typeExpr))) {
    return typeExpr.text;
  }

  const propertiesExpr = getObjectProperty(expr, 'properties');
  if (propertiesExpr && ts.isObjectLiteralExpression(propertiesExpr)) {
    return 'object';
  }

  return undefined;
}
