import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ApiCookie, ApiEndpoint, ApiMiddleware, ApiParameter, ApiRequestBody, ApiResponse, DiscoveryContext, EndpointConfidence, FrameworkFingerprint, SourceLocation } from '../types';

/**
 * Shared interface for framework-specific component analyzers.
 *
 * Each framework (Express, Fastify, NestJS) implements this interface
 * to provide consistent route discovery while handling framework-specific logic.
 */
export interface ComponentAnalyzer {
  /**
   * Analyze a source file and extract API endpoints.
   *
   * @param filePath - absolute path to the source file
   * @param content - file contents
   * @param fingerprint - framework fingerprint
   * @param context - discovery context with environment overrides
   * @returns array of discovered endpoints, may be empty
   */
  analyzeFile(
    filePath: string,
    content: string,
    fingerprint: FrameworkFingerprint,
    context: DiscoveryContext
  ): Promise<ApiEndpoint[]>;
}

export interface RouteDefinitionBase {
  method: string;
  pathExpression: string;
  resolvedPath?: string;
  confidence: EndpointConfidence;
  handlerLocation: ApiEndpoint['handlerLocation'];
  middleware: ApiMiddleware[];
}

export interface PrefixState {
  pathExpression: string;
  resolvedPath?: string;
  confidence: EndpointConfidence;
}

export interface EndpointMetadata {
  parameters: ApiParameter[];
  requestBody: ApiRequestBody | undefined;
  cookies: ApiCookie[];
  responses: ApiResponse[];
}

type AccessTarget = 'query' | 'params' | 'headers' | 'cookies' | 'body' | (string & {});

interface ImportedFunctionTarget {
  node: ts.FunctionLikeDeclaration;
  sourceFile: ts.SourceFile;
  filePath: string;
  symbolKey: string;
}

interface TraversalState {
  visitedSymbols: Set<string>;
}

interface RootAliasHints {
  requestAliases?: Set<string>;
  responseAliases?: Set<string>;
}

export function combineConfidence(a: EndpointConfidence, b: EndpointConfidence): EndpointConfidence {
  if (a === 'high' && b === 'high') return 'high';
  if (a === 'low' || b === 'low') return 'low';
  return 'medium';
}

/**
 * Extract path parameters from a route pattern.
 * Supports Express (`:id`) and Fastify (`{id}`) style parameters.
 */
export function extractPathParameters(pathPattern: string, source?: ts.SourceFile, location?: any): ApiParameter[] {
  const params: ApiParameter[] = [];
  const expressParamRegex = /:([a-zA-Z_]\w*)/g;
  const fastifyParamRegex = /\{([a-zA-Z_]\w*)\}/g;

  let match;
  // Match Express style
  while ((match = expressParamRegex.exec(pathPattern)) !== null) {
    params.push({
      name: match[1],
      location: 'path',
      required: true,
      type: 'string' // Could infer type from usage
    });
  }

  // Match Fastify style
  while ((match = fastifyParamRegex.exec(pathPattern)) !== null) {
    params.push({
      name: match[1],
      location: 'path',
      required: true,
      type: 'string'
    });
  }

  return params;
}

/**
 * Analyze handler function to extract request/response metadata.
 * Detects usage of req.query, req.body, req.headers, req.cookies, res.locals, res.header(), res.cookie().
 */
export function analyzeHandlerMetadata(
  handlerNode: ts.Node,
  source: ts.SourceFile,
  filePath: string,
  method: string,
  traversalState: TraversalState = { visitedSymbols: new Set<string>() },
  rootAliasHints?: RootAliasHints,
  contextProperties: string[] = ['locals']
): EndpointMetadata {
  const parameters: ApiParameter[] = [];
  const cookies: ApiCookie[] = [];
  const responses: ApiResponse[] = [];
  let requestBody: ApiRequestBody | undefined;
  const aliasPaths = new Map<string, { target: AccessTarget; path: string }>();
  const contextTargets = getContextTargets(contextProperties);
  const requestRootAliases = collectRequestRootAliases(handlerNode, source, contextTargets);
  const responseRootAliases = collectResponseRootAliases(handlerNode, source, contextTargets);
  if (rootAliasHints?.requestAliases) {
    for (const alias of rootAliasHints.requestAliases) {
      requestRootAliases.add(alias);
    }
  }
  if (rootAliasHints?.responseAliases) {
    for (const alias of rootAliasHints.responseAliases) {
      responseRootAliases.add(alias);
    }
  }
  const functionIndex = createFunctionIndex(source);
  const importedFunctionIndex = createImportedFunctionIndex(source, filePath);

  // Pre-scan: collect union of root hints across ALL call sites for each function,
  // so that helper(req, res) and helper(res, req) both contribute to its hint set.
  const unionHintsMap = prescanCallSiteHints(handlerNode, filePath, functionIndex, importedFunctionIndex, requestRootAliases, responseRootAliases);

  const upsertResponse = (statusCode: number, bodyType?: string): ApiResponse => {
    let response = responses.find((item) => item.statusCode === statusCode);
    if (!response) {
      response = { statusCode };
      responses.push(response);
    }

    if (bodyType) {
      response.body = {
        type: bodyType,
        schema: response.body?.schema
      };
    }

    return response;
  };

  if (ts.isFunctionLike(handlerNode)) {
    captureFunctionParameterAliases(handlerNode, source, aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
  }

  const visitFunctionByName = (name: string, callExpression?: ts.CallExpression): void => {
    const localTarget = functionIndex.get(name);
    if (localTarget) {
      const localKey = `${filePath}:${name}`;
      if (traversalState.visitedSymbols.has(localKey)) {
        return;
      }
      traversalState.visitedSymbols.add(localKey);

      // Use pre-scanned union hints (covers all call sites) merged with any
      // per-call-site hints available at this specific invocation point.
      const unionHints = unionHintsMap.get(localKey);
      const callHints = callExpression
        ? deriveRootAliasHintsForCall(callExpression, localTarget, requestRootAliases, responseRootAliases)
        : undefined;
      const localRootHints = mergeRootAliasHints(unionHints, callHints);
      const localMetadata = analyzeHandlerMetadata(localTarget, source, filePath, method, traversalState, localRootHints, contextProperties);
      mergeEndpointMetadata(
        { parameters, requestBody, cookies, responses },
        localMetadata
      );
      if (!requestBody && localMetadata.requestBody) {
        requestBody = localMetadata.requestBody;
      }
      return;
    }

    const importedTarget = importedFunctionIndex.get(name);
    if (!importedTarget || traversalState.visitedSymbols.has(importedTarget.symbolKey)) {
      return;
    }

    traversalState.visitedSymbols.add(importedTarget.symbolKey);
    const unionHints = unionHintsMap.get(importedTarget.symbolKey);
    const callHints = callExpression
      ? deriveRootAliasHintsForCall(callExpression, importedTarget.node, requestRootAliases, responseRootAliases)
      : undefined;
    const importedRootHints = mergeRootAliasHints(unionHints, callHints);
    const externalMetadata = analyzeHandlerMetadata(
      importedTarget.node,
      importedTarget.sourceFile,
      importedTarget.filePath,
      method,
      traversalState,
      importedRootHints,
      contextProperties
    );
    mergeEndpointMetadata(
      { parameters, requestBody, cookies, responses },
      externalMetadata
    );
    if (!requestBody && externalMetadata.requestBody) {
      requestBody = externalMetadata.requestBody;
    }
  };

  // Check if this is a write method (expects body)
  const hasRequestBody = ['POST', 'PUT', 'PATCH'].includes(method);

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      captureAliases(node, source, aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    }

    if (ts.isIdentifier(node)) {
      const isDirectCallCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!isDirectCallCallee) {
        visitFunctionByName(node.text);
      }
    }

    const queryAccess = extractReqAccessPath(node, source, 'query', aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    if (queryAccess) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      parameters.push({
        name: queryAccess.path,
        location: 'query',
        type: inferTypeFromUsage(node, source),
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });
    }

    const paramsAccess = extractReqAccessPath(node, source, 'params', aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    if (paramsAccess) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      parameters.push({
        name: paramsAccess.path,
        location: 'path',
        required: true,
        type: inferTypeFromUsage(node, source),
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });
    }

    // Detect req.body access
    if (isDirectReqBody(node, source, requestRootAliases)) {
      if (!requestBody) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        requestBody = {
          type: 'json',
          required: hasRequestBody,
          detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
        };
      }
    }

    const bodyAccess = extractReqAccessPath(node, source, 'body', aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    if (bodyAccess) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      parameters.push({
        name: bodyAccess.path,
        location: 'body',
        type: inferTypeFromUsage(node, source),
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });

      if (!requestBody) {
        requestBody = { type: 'json', required: hasRequestBody };
      }
    }

    const headersAccess = extractReqAccessPath(node, source, 'headers', aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    if (headersAccess) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      parameters.push({
        name: headersAccess.path,
        location: 'header',
        type: 'string',
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });
    }

    const cookieAccess = extractReqAccessPath(node, source, 'cookies', aliasPaths, requestRootAliases, responseRootAliases, contextTargets);
    if (cookieAccess) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      cookies.push({
        name: cookieAccess.path,
        type: 'request',
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });
    }

    for (const contextTarget of contextTargets) {
      const contextAccess = extractReqAccessPath(
        node,
        source,
        contextTarget,
        aliasPaths,
        requestRootAliases,
        responseRootAliases,
        contextTargets
      );
      if (!contextAccess) {
        continue;
      }

      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      parameters.push({
        name: contextAccess.path,
        location: contextTarget,
        type: inferTypeFromUsage(node, source),
        detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'read' }
      });
    }

    // Detect status-aware response bodies from Express/Fastify patterns.
    // Examples: res.status(201).json(...), reply.code(202).send(...)
    if (ts.isCallExpression(node)) {
      const responseBodyMetadata = extractResponseBodyMetadata(node, source, responseRootAliases);
      if (responseBodyMetadata) {
        upsertResponse(responseBodyMetadata.statusCode, responseBodyMetadata.bodyType);
      }
    }

    // Detect status-aware header writes from Express/Fastify patterns.
    // Examples: res.status(201).set('x-id', '...'), reply.code(202).header('x-id', '...')
    if (ts.isCallExpression(node)) {
      const responseHeaderMetadata = extractResponseHeaderMetadata(node, responseRootAliases);
      if (responseHeaderMetadata) {
        const response = upsertResponse(responseHeaderMetadata.statusCode);
        if (!response.headers?.some((h) => h.name === responseHeaderMetadata.headerName)) {
          const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
          response.headers = response.headers ?? [];
          response.headers.push({
            name: responseHeaderMetadata.headerName,
            location: 'header',
            type: 'string',
            detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'write' }
          });
        }
      }
    }

    // Detect response cookie() calls
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isResponseLikeExpression(node.expression.expression, responseRootAliases) &&
      node.expression.name.text === 'cookie' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const cookieName = node.arguments[0].text;
      if (cookieName && !cookies.some((c) => c.name === cookieName && c.type === 'response')) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        cookies.push({
          name: cookieName,
          type: 'response',
          httpOnly: true, // Default assumption
          detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1, accessMode: 'write' }
        });
      }
    }

    // Follow local function calls for transitive metadata discovery.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      visitFunctionByName(node.expression.text, node);
    }

    ts.forEachChild(node, visit);
  };

  if (handlerNode) {
    visit(handlerNode);
  }

  return {
    parameters,
    requestBody: hasRequestBody ? requestBody || { type: 'json', required: true } : undefined,
    cookies,
    responses: responses.length > 0 ? responses : [{ statusCode: 200 }]
  };
}

export function analyzeComponentChainMetadata(
  componentNodes: ts.Node[],
  source: ts.SourceFile,
  filePath: string,
  method: string,
  contextProperties: string[] = ['locals']
): EndpointMetadata {
  const merged: EndpointMetadata = {
    parameters: [],
    requestBody: undefined,
    cookies: [],
    responses: []
  };

  for (const node of componentNodes) {
    const metadata = analyzeHandlerMetadata(node, source, filePath, method, undefined, undefined, contextProperties);
    mergeEndpointMetadata(merged, metadata);
  }

  merged.parameters = dedupeApiParameters(merged.parameters);
  merged.cookies = dedupeCookies(merged.cookies);

  if (!merged.requestBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
    merged.requestBody = { type: 'json', required: true };
  }

  if (merged.responses.length === 0) {
    merged.responses = [{ statusCode: 200 }];
  }

  return merged;
}

function createFunctionIndex(source: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
  const index = new Map<string, ts.FunctionLikeDeclaration>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      index.set(node.name.text, node);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        index.set(node.name.text, node.initializer);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return index;
}

function createImportedFunctionIndex(source: ts.SourceFile, importingFilePath: string): Map<string, ImportedFunctionTarget> {
  const index = new Map<string, ImportedFunctionTarget>();

  const processModuleImport = (importPath: string, bindings: Array<{ localName: string; importedName: string }>): void => {
    if (!importPath.startsWith('.')) {
      return;
    }

    const resolvedPath = resolveModuleFile(importingFilePath, importPath);
    if (!resolvedPath) {
      return;
    }

    const importedSource = parseSourceFile(resolvedPath);
    if (!importedSource) {
      return;
    }

    const exportsMap = buildModuleExportMap(importedSource, resolvedPath);
    for (const binding of bindings) {
      const target = exportsMap.get(binding.importedName);
      if (!target) {
        continue;
      }
      index.set(binding.localName, {
        node: target,
        sourceFile: importedSource,
        filePath: resolvedPath,
        symbolKey: `${resolvedPath}:${binding.importedName}`
      });
    }
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
      const importPath = statement.moduleSpecifier.text;
      const bindings: Array<{ localName: string; importedName: string }> = [];

      if (statement.importClause.name) {
        bindings.push({ localName: statement.importClause.name.text, importedName: 'default' });
      }

      const namedBindings = statement.importClause.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          bindings.push({
            localName: element.name.text,
            importedName: element.propertyName ? element.propertyName.text : element.name.text
          });
        }
      }

      processModuleImport(importPath, bindings);
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) {
        continue;
      }
      if (!ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require') {
        continue;
      }
      const requireArg = declaration.initializer.arguments[0];
      if (!requireArg || !ts.isStringLiteral(requireArg)) {
        continue;
      }

      const importPath = requireArg.text;
      const bindings: Array<{ localName: string; importedName: string }> = [];

      if (ts.isIdentifier(declaration.name)) {
        bindings.push({ localName: declaration.name.text, importedName: 'default' });
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) {
            continue;
          }
          const importedName = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
            ? element.propertyName.text
            : element.name.text;
          bindings.push({ localName: element.name.text, importedName });
        }
      }

      processModuleImport(importPath, bindings);
    }
  }

  return index;
}

function parseSourceFile(filePath: string): ts.SourceFile | undefined {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
}

function resolveModuleFile(importingFilePath: string, importPath: string): string | undefined {
  const base = path.resolve(path.dirname(importingFilePath), importPath);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js')
  ];

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function buildModuleExportMap(source: ts.SourceFile, moduleFilePath: string): Map<string, ts.FunctionLikeDeclaration> {
  const exportsMap = new Map<string, ts.FunctionLikeDeclaration>();
  const localFunctions = createFunctionIndex(source);

  const registerExport = (name: string, node: ts.FunctionLikeDeclaration): void => {
    exportsMap.set(name, node);
  };

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      registerExport(statement.name.text, statement);
      if (hasDefaultModifier(statement)) {
        registerExport('default', statement);
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
          registerExport(declaration.name.text, declaration.initializer);
          if (hasDefaultModifier(statement)) {
            registerExport('default', declaration.initializer);
          }
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const expr = statement.expression;
      if (ts.isIdentifier(expr)) {
        const local = localFunctions.get(expr.text);
        if (local) {
          registerExport('default', local);
        }
      } else if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        registerExport('default', expr);
      }
      continue;
    }

    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      continue;
    }

    const left = statement.expression.left;
    const right = statement.expression.right;

    if (ts.isPropertyAccessExpression(left) && left.expression.getText(source) === 'module.exports') {
      const exportName = left.name.text;
      const resolved = resolveExportedFunction(right, localFunctions);
      if (resolved) {
        registerExport(exportName, resolved);
      }
      continue;
    }

    if (left.getText(source) === 'module.exports') {
      const resolved = resolveExportedFunction(right, localFunctions);
      if (resolved) {
        registerExport('default', resolved);
      }
      continue;
    }

    if (ts.isPropertyAccessExpression(left) && left.expression.getText(source) === 'exports') {
      const resolved = resolveExportedFunction(right, localFunctions);
      if (resolved) {
        registerExport(left.name.text, resolved);
      }
    }
  }

  return exportsMap;
}

function resolveExportedFunction(
  expression: ts.Expression,
  localFunctions: Map<string, ts.FunctionLikeDeclaration>
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return expression;
  }
  if (ts.isIdentifier(expression)) {
    return localFunctions.get(expression.text);
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function mergeEndpointMetadata(target: EndpointMetadata, incoming: EndpointMetadata): void {
  target.parameters.push(...incoming.parameters);
  target.cookies.push(...incoming.cookies);
  if (!target.requestBody && incoming.requestBody) {
    target.requestBody = incoming.requestBody;
  }

  for (const response of incoming.responses) {
    const existing = target.responses.find((item) => item.statusCode === response.statusCode);
    if (!existing) {
      target.responses.push({
        statusCode: response.statusCode,
        headers: response.headers ? [...response.headers] : undefined,
        body: response.body
      });
      continue;
    }

    const existingHeaders = existing.headers ?? [];
    const nextHeaders = response.headers ?? [];
    existing.headers = dedupeApiParameters([...existingHeaders, ...nextHeaders]);
  }
}

export function dedupeApiParameters(parameters: ApiParameter[]): ApiParameter[] {
  const merged = new Map<string, ApiParameter>();

  for (const parameter of parameters) {
    const key = `${parameter.location}:${parameter.name}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...parameter,
        evidenceLocations: mergeEvidence([], parameter)
      });
      continue;
    }

    existing.required = Boolean(existing.required || parameter.required);
    existing.evidenceLocations = mergeEvidence(existing.evidenceLocations ?? [], parameter);

    if (!existing.detectionLocation && parameter.detectionLocation) {
      existing.detectionLocation = parameter.detectionLocation;
    }

    if (!existing.type && parameter.type) {
      existing.type = parameter.type;
      continue;
    }

    if (!parameter.type || !existing.type || existing.type === parameter.type) {
      continue;
    }

    const conflicts = new Set<string>(existing.conflictingTypes ?? []);
    conflicts.add(existing.type);
    conflicts.add(parameter.type);
    existing.conflictingTypes = Array.from(conflicts);

    if (existing.location === 'body' && (existing.type === 'object' || parameter.type === 'object')) {
      existing.type = 'object';
    }
  }

  const deduped = Array.from(merged.values()).map((parameter) => normalizeParameterLocations(parameter));

  const bodyParams = deduped.filter((item) => item.location === 'body');
  const bodyByName = new Map(bodyParams.map((item) => [item.name, item]));

  // Materialize missing ancestor paths so nested body fields imply parent objects.
  for (const bodyParam of [...bodyParams]) {
    let ancestor = getParentPath(bodyParam.name);
    while (ancestor) {
      if (!bodyByName.has(ancestor)) {
        const synthesized: ApiParameter = {
          name: ancestor,
          location: 'body',
          type: 'object'
        };
        bodyByName.set(ancestor, synthesized);
        deduped.push(synthesized);
      }
      ancestor = getParentPath(ancestor);
    }
  }

  // If ancestor and descendant body paths both exist (e.g. user, user.order, user.order.orderId),
  // force every ancestor in the existing chain to object.
  for (const bodyParam of bodyByName.values()) {
    let ancestor = getParentPath(bodyParam.name);
    while (ancestor) {
      const parent = bodyByName.get(ancestor);
      if (parent) {
        parent.type = 'object';
      }
      ancestor = getParentPath(ancestor);
    }
  }

  return deduped;
}

function mergeEvidence(existing: ApiParameter['evidenceLocations'], parameter: ApiParameter): ApiParameter['evidenceLocations'] {
  const merged = [...(existing ?? [])];
  if (parameter.detectionLocation) {
    merged.push(parameter.detectionLocation);
  }
  if (parameter.evidenceLocations) {
    merged.push(...parameter.evidenceLocations);
  }

  const seen = new Set<string>();
  const deduped = [];
  for (const item of merged) {
    const key = `${item.filePath}:${item.line}:${item.column ?? 0}:${item.symbolName ?? ''}:${item.accessMode ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeParameterLocations(parameter: ApiParameter): ApiParameter {
  const allLocations = dedupeSourceLocations([
    ...(parameter.detectionLocation ? [parameter.detectionLocation] : []),
    ...(parameter.evidenceLocations ?? [])
  ]);

  if (allLocations.length === 0) {
    return {
      ...parameter,
      detectionLocation: undefined,
      evidenceLocations: undefined
    };
  }

  const detectionLocation = pickBestDetectionLocation(allLocations);
  const evidenceLocations = allLocations.filter((location) => !isSameSourceLocation(location, detectionLocation));

  return {
    ...parameter,
    detectionLocation,
    evidenceLocations: evidenceLocations.length > 0 ? evidenceLocations : undefined
  };
}

function pickBestDetectionLocation(locations: SourceLocation[]): SourceLocation {
  return [...locations].sort(compareSourceLocations)[0];
}

function compareSourceLocations(a: SourceLocation, b: SourceLocation): number {
  const scoreA = sourceLocationScore(a);
  const scoreB = sourceLocationScore(b);
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }

  if (a.line !== b.line) {
    return a.line - b.line;
  }

  const aColumn = a.column ?? 0;
  const bColumn = b.column ?? 0;
  if (aColumn !== bColumn) {
    return aColumn - bColumn;
  }

  return a.filePath.localeCompare(b.filePath);
}

function sourceLocationScore(location: SourceLocation): number {
  let score = 0;
  if (location.accessMode) {
    score += 8;
  }
  if (location.symbolName) {
    score += 4;
  }
  if (typeof location.column === 'number') {
    score += 2;
  }
  return score;
}

function dedupeSourceLocations(locations: SourceLocation[]): SourceLocation[] {
  const deduped: SourceLocation[] = [];
  const seen = new Set<string>();

  for (const location of locations) {
    const key = `${location.filePath}:${location.line}:${location.column ?? 0}:${location.symbolName ?? ''}:${location.accessMode ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(location);
  }

  return deduped;
}

function isSameSourceLocation(a: SourceLocation, b: SourceLocation): boolean {
  return (
    a.filePath === b.filePath &&
    a.line === b.line &&
    (a.column ?? 0) === (b.column ?? 0) &&
    (a.symbolName ?? '') === (b.symbolName ?? '') &&
    (a.accessMode ?? '') === (b.accessMode ?? '')
  );
}

function dedupeCookies(cookies: ApiCookie[]): ApiCookie[] {
  const seen = new Set<string>();
  const deduped: ApiCookie[] = [];

  for (const cookie of cookies) {
    const key = `${cookie.type ?? 'unknown'}:${cookie.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(cookie);
  }

  return deduped;
}

function isDirectReqBody(
  node: ts.Node,
  source: ts.SourceFile,
  requestRootAliases: Set<string>
): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    requestRootAliases.has(node.expression.text) &&
    node.name.text === 'body'
  );
}

function extractReqAccessPath(
  node: ts.Node,
  source: ts.SourceFile,
  target: AccessTarget,
  aliasPaths?: Map<string, { target: AccessTarget; path: string }>,
  requestRootAliases?: Set<string>,
  responseRootAliases?: Set<string>,
  contextTargets?: Set<string>
): { path: string } | undefined {
  return extractReqAccessPathWithAliases(node, source, target, aliasPaths, false, requestRootAliases, responseRootAliases, contextTargets);
}

function extractReqAccessPathWithAliases(
  node: ts.Node,
  source: ts.SourceFile,
  target: AccessTarget,
  aliasPaths: Map<string, { target: AccessTarget; path: string }> | undefined,
  includeEmptyPath: boolean,
  requestRootAliases?: Set<string>,
  responseRootAliases?: Set<string>,
  contextTargets?: Set<string>
): { path: string } | undefined {
  const segments: string[] = [];
  let current: ts.Node | undefined = node;

  while (
    current &&
    (ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isPropertyAccessChain(current) ||
      ts.isElementAccessChain(current))
  ) {
    if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
      segments.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
      const arg = current.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg))) {
        const text = arg.text;
        if (ts.isNumericLiteral(arg) || /^\d+$/.test(text)) {
          segments.unshift('[]');
        } else {
          segments.unshift(text);
        }
      } else {
        return undefined;
      }
      current = current.expression;
    }
  }

  const targetIndex = segments.indexOf(target);
  const isContextTarget = contextTargets?.has(target) ?? false;
  const matchesRoot =
    isContextTarget
      ? current && ts.isIdentifier(current) && ((responseRootAliases?.has(current.text) ?? false) || (requestRootAliases?.has(current.text) ?? false))
      : current && ts.isIdentifier(current) && requestRootAliases?.has(current.text) === true;
  if (targetIndex !== -1 && matchesRoot) {
    const pathSegments = segments.slice(targetIndex + 1);
    if (pathSegments.length === 0) {
      return includeEmptyPath ? { path: '' } : undefined;
    }

    return { path: normalizeAccessPath(pathSegments) };
  }

  if (!current || !ts.isIdentifier(current) || !aliasPaths) {
    return undefined;
  }

  const alias = aliasPaths.get(current.text);
  if (!alias || alias.target !== target) {
    return undefined;
  }

  const suffix = normalizeAccessPath(segments);
  if (!alias.path) {
    if (suffix) {
      return { path: suffix };
    }
    return includeEmptyPath ? { path: '' } : undefined;
  }
  if (!suffix) {
    return { path: alias.path };
  }

  return { path: `${alias.path}.${suffix}` };
}

function captureAliases(
  declaration: ts.VariableDeclaration,
  source: ts.SourceFile,
  aliasPaths: Map<string, { target: AccessTarget; path: string }>,
  requestRootAliases: Set<string>,
  responseRootAliases: Set<string>,
  contextTargets: Set<string>
): void {
  const initializer = declaration.initializer;
  if (!initializer) {
    return;
  }

  if (ts.isIdentifier(initializer) && requestRootAliases.has(initializer.text) && ts.isIdentifier(declaration.name)) {
    requestRootAliases.add(declaration.name.text);
  }

  if (ts.isIdentifier(initializer) && responseRootAliases.has(initializer.text) && ts.isIdentifier(declaration.name)) {
    responseRootAliases.add(declaration.name.text);
  }

  const supportedTargets: AccessTarget[] = ['body', 'query', 'params', 'headers', 'cookies', ...contextTargets];
  let matchedTarget: AccessTarget | undefined;
  let matchedPath = '';
  for (const target of supportedTargets) {
    const matched = extractReqAccessPathWithAliases(initializer, source, target, aliasPaths, true, requestRootAliases, responseRootAliases, contextTargets);
    if (matched) {
      matchedTarget = target;
      matchedPath = matched.path;
      break;
    }
  }

  if (!matchedTarget) {
    return;
  }

  if (ts.isIdentifier(declaration.name)) {
    aliasPaths.set(declaration.name.text, { target: matchedTarget, path: matchedPath });
    return;
  }

  if (ts.isObjectBindingPattern(declaration.name) || ts.isArrayBindingPattern(declaration.name)) {
    captureBindingPatternAliases(declaration.name, matchedTarget, matchedPath, aliasPaths);
  }
}

function captureFunctionParameterAliases(
  functionNode: ts.SignatureDeclarationBase,
  source: ts.SourceFile,
  aliasPaths: Map<string, { target: AccessTarget; path: string }>,
  requestRootAliases: Set<string>,
  responseRootAliases: Set<string>,
  contextTargets: Set<string>
): void {
  const supportedTargets: AccessTarget[] = ['body', 'query', 'params', 'headers', 'cookies', ...contextTargets];

  for (const parameter of functionNode.parameters) {
    if ((ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) && !parameter.initializer) {
      captureRootRequestParameterPattern(parameter.name, aliasPaths, contextTargets);
      continue;
    }

    const initializer = parameter.initializer;
    if (!initializer) {
      continue;
    }

    let matchedTarget: AccessTarget | undefined;
    let matchedPath = '';
    for (const target of supportedTargets) {
      const matched = extractReqAccessPathWithAliases(initializer, source, target, aliasPaths, true, requestRootAliases, responseRootAliases, contextTargets);
      if (matched) {
        matchedTarget = target;
        matchedPath = matched.path;
        break;
      }
    }

    if (!matchedTarget) {
      continue;
    }

    if (ts.isIdentifier(parameter.name)) {
      aliasPaths.set(parameter.name.text, { target: matchedTarget, path: matchedPath });
      continue;
    }

    if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
      captureBindingPatternAliases(parameter.name, matchedTarget, matchedPath, aliasPaths);
    }
  }
}

function captureRootRequestParameterPattern(
  pattern: ts.BindingPattern,
  aliasPaths: Map<string, { target: AccessTarget; path: string }>,
  contextTargets: Set<string>
): void {
  if (!ts.isObjectBindingPattern(pattern)) {
    return;
  }

  const supportedTargets = new Set<AccessTarget>(['body', 'query', 'params', 'headers', 'cookies', ...contextTargets]);
  for (const element of pattern.elements) {
    const key = getBindingElementKey(element);
    if (!key || !supportedTargets.has(key as AccessTarget)) {
      continue;
    }

    const target = key as AccessTarget;
    if (ts.isIdentifier(element.name)) {
      aliasPaths.set(element.name.text, { target, path: '' });
      continue;
    }

    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      captureBindingPatternAliases(element.name, target, '', aliasPaths);
    }
  }
}

function collectRequestRootAliases(handlerNode: ts.Node, source: ts.SourceFile, contextTargets: Set<string>): Set<string> {
  const aliases = new Set<string>();
  const requestProperties = new Set(['query', 'params', 'body', 'headers', 'cookies', ...contextTargets]);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      const propertyName = node.name.text;
      if (requestProperties.has(propertyName)) {
        const root = getRootIdentifierText(node.expression);
        if (root) {
          aliases.add(root);
        }
      }
    }

    if (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
      const arg = node.argumentExpression;
      if (arg && ts.isStringLiteral(arg) && requestProperties.has(arg.text)) {
        const root = getRootIdentifierText(node.expression);
        if (root) {
          aliases.add(root);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)) {
        aliases.add(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(handlerNode);
  return aliases;
}

function captureBindingPatternAliases(
  pattern: ts.BindingPattern,
  target: AccessTarget,
  basePath: string,
  aliasPaths: Map<string, { target: AccessTarget; path: string }>
): void {
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      const key = getBindingElementKey(element);
      if (!key) {
        continue;
      }

      const fullPath = joinAccessPath(basePath, key);
      if (ts.isIdentifier(element.name)) {
        aliasPaths.set(element.name.text, { target, path: fullPath });
        continue;
      }

      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        captureBindingPatternAliases(element.name, target, fullPath, aliasPaths);
      }
    }
    return;
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }

    const key = getBindingElementKey(element) ?? '[]';
    const fullPath = joinAccessPath(basePath, /^\d+$/.test(key) ? '[]' : key);

    if (ts.isIdentifier(element.name)) {
      aliasPaths.set(element.name.text, { target, path: fullPath });
      continue;
    }

    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      captureBindingPatternAliases(element.name, target, fullPath, aliasPaths);
    }
  }
}

function getBindingElementKey(element: ts.BindingElement): string | undefined {
  const propertyName = element.propertyName;
  if (!propertyName) {
    return ts.isIdentifier(element.name) ? element.name.text : undefined;
  }
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  return undefined;
}

function joinAccessPath(basePath: string, segment: string): string {
  if (!basePath) {
    return normalizeAccessPath([segment]);
  }
  return normalizeAccessPath(`${basePath}.${segment}`.split('.'));
}


function normalizeAccessPath(segments: string[]): string {
  if (segments.length === 0) {
    return '';
  }

  let result = '';
  for (const segment of segments) {
    if (!segment) {
      continue;
    }

    if (segment === '[]') {
      if (!result.endsWith('[]')) {
        result += '[]';
      }
      continue;
    }

    result += result ? `.${segment}` : segment;
  }

  return result;
}

function getParentPath(path: string): string | undefined {
  const index = path.lastIndexOf('.');
  if (index <= 0) {
    return undefined;
  }
  return path.slice(0, index);
}

/**
 * Walk the entire handler body once and collect the UNION of root-alias hints
 * across every call site for each reachable function.
 *
 * Map key: the same symbol key used in traversalState ("filePath:name" for
 * local functions, "resolvedPath:exportedName" for imported ones).
 * Map value: merged RootAliasHints from all call sites seen for that function.
 *
 * This lets the analysis pass use the full picture even when the same function
 * is called from two different places with different argument orderings.
 */
function prescanCallSiteHints(
  handlerNode: ts.Node,
  filePath: string,
  functionIndex: Map<string, ts.FunctionLikeDeclaration>,
  importedFunctionIndex: Map<string, { node: ts.FunctionLikeDeclaration; filePath: string; symbolKey: string }>,
  requestRootAliases: Set<string>,
  responseRootAliases: Set<string>
): Map<string, RootAliasHints> {
  const result = new Map<string, RootAliasHints>();

  const merge = (key: string, hints: RootAliasHints): void => {
    const existing = result.get(key);
    if (!existing) {
      result.set(key, {
        requestAliases: hints.requestAliases ? new Set(hints.requestAliases) : undefined,
        responseAliases: hints.responseAliases ? new Set(hints.responseAliases) : undefined
      });
      return;
    }

    if (hints.requestAliases) {
      if (!existing.requestAliases) {
        existing.requestAliases = new Set(hints.requestAliases);
      } else {
        for (const alias of hints.requestAliases) {
          existing.requestAliases.add(alias);
        }
      }
    }

    if (hints.responseAliases) {
      if (!existing.responseAliases) {
        existing.responseAliases = new Set(hints.responseAliases);
      } else {
        for (const alias of hints.responseAliases) {
          existing.responseAliases.add(alias);
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;

      const localTarget = functionIndex.get(name);
      if (localTarget) {
        const hints = deriveRootAliasHintsForCall(node, localTarget, requestRootAliases, responseRootAliases);
        if (hints) {
          merge(`${filePath}:${name}`, hints);
        }
      }

      const importedTarget = importedFunctionIndex.get(name);
      if (importedTarget) {
        const hints = deriveRootAliasHintsForCall(node, importedTarget.node, requestRootAliases, responseRootAliases);
        if (hints) {
          merge(importedTarget.symbolKey, hints);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(handlerNode);
  return result;
}

function mergeRootAliasHints(a: RootAliasHints | undefined, b: RootAliasHints | undefined): RootAliasHints | undefined {
  if (!a && !b) {
    return undefined;
  }

  const requestAliases = new Set<string>([...(a?.requestAliases ?? []), ...(b?.requestAliases ?? [])]);
  const responseAliases = new Set<string>([...(a?.responseAliases ?? []), ...(b?.responseAliases ?? [])]);

  return {
    requestAliases: requestAliases.size > 0 ? requestAliases : undefined,
    responseAliases: responseAliases.size > 0 ? responseAliases : undefined
  };
}

function getContextTargets(contextProperties: string[]): Set<string> {
  const targets = new Set<string>();
  const reserved = new Set(['query', 'params', 'body', 'headers', 'cookies']);

  for (const value of contextProperties) {
    const trimmed = value.trim();
    if (!trimmed || reserved.has(trimmed)) {
      continue;
    }
    targets.add(trimmed);
  }

  if (targets.size === 0) {
    targets.add('locals');
  }

  return targets;
}

function deriveRootAliasHintsForCall(
  callExpression: ts.CallExpression,
  targetNode: ts.FunctionLikeDeclaration,
  requestRootAliases: Set<string>,
  responseRootAliases: Set<string>
): RootAliasHints | undefined {
  const requestAliases = new Set<string>();
  const responseAliases = new Set<string>();
  const count = Math.min(callExpression.arguments.length, targetNode.parameters.length);

  for (let index = 0; index < count; index += 1) {
    const parameter = targetNode.parameters[index];
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }

    const arg = callExpression.arguments[index];
    const root = getRootIdentifierText(arg);
    if (!root) {
      continue;
    }

    if (requestRootAliases.has(root)) {
      requestAliases.add(parameter.name.text);
    }
    if (responseRootAliases.has(root)) {
      responseAliases.add(parameter.name.text);
    }
  }

  if (requestAliases.size === 0 && responseAliases.size === 0) {
    return undefined;
  }

  return {
    requestAliases: requestAliases.size > 0 ? requestAliases : undefined,
    responseAliases: responseAliases.size > 0 ? responseAliases : undefined
  };
}

/**
 * Infer type from how the value is used.
 */
function inferTypeFromUsage(node: ts.Node | undefined, source: ts.SourceFile): string {
  if (!node || !node.parent) return 'string';

  // Check for parseInt, parseFloat
  if (
    ts.isCallExpression(node.parent) &&
    ts.isIdentifier(node.parent.expression)
  ) {
    const funcName = node.parent.expression.text;
    if (funcName === 'parseInt') return 'number';
    if (funcName === 'parseFloat') return 'number';
  }

  // Check for comparison with number
  if (
    ts.isBinaryExpression(node.parent) &&
    (node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
  ) {
    const other = node.parent.left === node ? node.parent.right : node.parent.left;
    if (ts.isNumericLiteral(other)) return 'number';
  }

  return 'string';
}

function extractResponseBodyMetadata(
  node: ts.CallExpression,
  source: ts.SourceFile,
  responseRootAliases: Set<string>
): { statusCode: number; bodyType: string } | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const methodName = callee.name.text;
  if (methodName !== 'json' && methodName !== 'send') {
    return undefined;
  }

  const context = resolveResponseCallContext(node, responseRootAliases);
  if (!context) {
    return undefined;
  }

  return {
    statusCode: context.statusCode,
    bodyType: methodName === 'json' ? 'json' : inferSendBodyType(node.arguments[0])
  };
}

function extractResponseHeaderMetadata(
  node: ts.CallExpression,
  responseRootAliases: Set<string>
): { statusCode: number; headerName: string } | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const methodName = callee.name.text;
  if (methodName !== 'header' && methodName !== 'set') {
    return undefined;
  }

  const headerArg = node.arguments[0];
  if (!headerArg || !ts.isStringLiteral(headerArg)) {
    return undefined;
  }

  const context = resolveResponseCallContext(node, responseRootAliases);
  if (!context) {
    return undefined;
  }

  return {
    statusCode: context.statusCode,
    headerName: headerArg.text
  };
}

function resolveResponseCallContext(
  node: ts.CallExpression,
  responseRootAliases: Set<string>
): { receiver: string; statusCode: number } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }

  let statusCode = 200;
  let current: ts.Expression = node.expression.expression;

  while (true) {
    if (ts.isIdentifier(current) && responseRootAliases.has(current.text)) {
      return { receiver: current.text, statusCode };
    }

    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
      return undefined;
    }

    const chainMethod = current.expression.name.text;
    if (chainMethod === 'status' || chainMethod === 'code') {
      const statusArg = current.arguments[0];
      if (statusArg && ts.isNumericLiteral(statusArg)) {
        statusCode = Number(statusArg.text);
      }
    }

    current = current.expression.expression;
  }
}

function inferSendBodyType(argument: ts.Expression | undefined): string {
  if (!argument) {
    return 'text';
  }
  if (ts.isObjectLiteralExpression(argument) || ts.isArrayLiteralExpression(argument)) {
    return 'json';
  }
  return 'text';
}

function collectResponseRootAliases(handlerNode: ts.Node, source: ts.SourceFile, contextTargets: Set<string>): Set<string> {
  const aliases = new Set<string>();
  const responseMethods = new Set(['status', 'code', 'json', 'send', 'header', 'set', 'cookie']);
  const responseProperties = new Set(contextTargets);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      const propertyName = node.name.text;
      if (responseProperties.has(propertyName)) {
        const root = getRootIdentifierText(node.expression);
        if (root) {
          aliases.add(root);
        }
      }
    }

    if (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
      const arg = node.argumentExpression;
      if (arg && ts.isStringLiteral(arg) && responseProperties.has(arg.text)) {
        const root = getRootIdentifierText(node.expression);
        if (root) {
          aliases.add(root);
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (responseMethods.has(methodName)) {
        const root = getRootIdentifierText(node.expression.expression);
        if (root) {
          aliases.add(root);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)) {
        aliases.add(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(handlerNode);
  return aliases;
}

function isKnownResponseRoot(name: string, responseRootAliases: Set<string> | undefined): boolean {
  return responseRootAliases ? responseRootAliases.has(name) : false;
}

function isResponseLikeExpression(expression: ts.Expression, responseRootAliases: Set<string>): boolean {
  const root = getRootIdentifierText(expression);
  return root ? responseRootAliases.has(root) : false;
}

function getRootIdentifierText(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;

  while (true) {
    if (ts.isIdentifier(current)) {
      return current.text;
    }

    if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      current = current.expression.expression;
      continue;
    }

    return undefined;
  }
}
