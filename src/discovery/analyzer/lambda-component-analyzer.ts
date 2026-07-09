import * as ts from 'typescript';
import { ApiEndpoint, ApiMiddleware, ApiParameter, DiscoveryContext, FrameworkFingerprint, SourceLocation } from '../types';
import { ComponentAnalyzer } from './component-analyzer';

interface LambdaHandlerInfo {
  exportName: string;
  handlerNode: ts.Node;
  middlewareNodes: ts.Expression[];
  location: SourceLocation;
}

/**
 * Analyzes AWS Lambda handler files for exported handler functions.
 *
 * Handles:
 * - exports.handler / exports.<name> = async (event) => { ... }
 * - module.exports = async (event) => { ... }
 * - export const handler: APIGatewayProxyHandler = async (event) => { ... }
 * - export async function handler(event: APIGatewayProxyEvent) { ... }
 * - Middy: exports.handler = middy(baseHandler).use(plugin)
 *
 * Extracts parameters from event.pathParameters, event.queryStringParameters,
 * event.headers, event.body, event.multiValueQueryStringParameters.
 */
export class LambdaComponentAnalyzer implements ComponentAnalyzer {
  public async analyzeFile(
    filePath: string,
    content: string,
    _fingerprint: FrameworkFingerprint,
    _context: DiscoveryContext
  ): Promise<ApiEndpoint[]> {
    const source = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );

    const handlers: LambdaHandlerInfo[] = [];
    collectLambdaHandlers(source, handlers);

    if (handlers.length === 0) {
      return [];
    }

    return handlers.map((handler) => {
      const parameters = extractEventParameters(handler.handlerNode, source, filePath);
      const middleware = resolveMiddleware(handler.middlewareNodes, source, filePath);

      return {
        method: 'ANY',
        framework: 'lambda',
        pathExpression: '<unknown-lambda>',
        resolvedPath: undefined,
        confidence: 'low',
        handlerLocation: handler.location,
        middleware,
        parameters: parameters.length > 0 ? parameters : undefined
      } satisfies ApiEndpoint;
    });
  }
}

// ---------------------------------------------------------------------------
// Handler collection
// ---------------------------------------------------------------------------

function collectLambdaHandlers(source: ts.SourceFile, handlers: LambdaHandlerInfo[]): void {
  ts.forEachChild(source, (node) => visitTopLevel(node, source, handlers));
}

function visitTopLevel(node: ts.Node, source: ts.SourceFile, handlers: LambdaHandlerInfo[]): void {
  // exports.handler = ... / exports.<name> = ...
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.expression.left;
    const right = node.expression.right;

    if (ts.isPropertyAccessExpression(left)) {
      const obj = left.expression.getText(source);
      const prop = left.name.text;

      if (obj === 'exports' && isLambdaHandlerExpression(right, source)) {
        const pos = source.getLineAndCharacterOfPosition(right.getStart(source));
        const { handlerNode, middlewareNodes } = unwrapMiddy(right, source);
        handlers.push({
          exportName: prop,
          handlerNode,
          middlewareNodes,
          location: { filePath: source.fileName, line: pos.line + 1, column: pos.character + 1, symbolName: prop }
        });
        return;
      }

      // module.exports = ...
      if (obj === 'module' && prop === 'exports' && isLambdaHandlerExpression(right, source)) {
        const pos = source.getLineAndCharacterOfPosition(right.getStart(source));
        const { handlerNode, middlewareNodes } = unwrapMiddy(right, source);
        handlers.push({
          exportName: 'handler',
          handlerNode,
          middlewareNodes,
          location: { filePath: source.fileName, line: pos.line + 1, column: pos.character + 1, symbolName: 'handler' }
        });
        return;
      }
    }
  }

  // export const handler: APIGatewayProxyHandler = async (event) => { ... }
  if (
    ts.isVariableStatement(node) &&
    hasExportModifier(node) &&
    node.declarationList.declarations.length > 0
  ) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) {
        continue;
      }
      if (isLambdaHandlerExpression(decl.initializer, source)) {
        const exportName = decl.name.text;
        const pos = source.getLineAndCharacterOfPosition(decl.initializer.getStart(source));
        const { handlerNode, middlewareNodes } = unwrapMiddy(decl.initializer, source);
        handlers.push({
          exportName,
          handlerNode,
          middlewareNodes,
          location: { filePath: source.fileName, line: pos.line + 1, column: pos.character + 1, symbolName: exportName }
        });
      }
    }
    return;
  }

  // export async function handler(event: APIGatewayProxyEvent) { ... }
  if (
    ts.isFunctionDeclaration(node) &&
    hasExportModifier(node) &&
    node.name &&
    isLambdaFunctionDeclaration(node)
  ) {
    const exportName = node.name.text;
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    handlers.push({
      exportName,
      handlerNode: node,
      middlewareNodes: [],
      location: { filePath: source.fileName, line: pos.line + 1, column: pos.character + 1, symbolName: exportName }
    });
  }
}

function isLambdaHandlerExpression(node: ts.Expression, source: ts.SourceFile): boolean {
  // Arrow function or function expression
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return hasEventParameter(node);
  }
  // middy(handler) call
  if (ts.isCallExpression(node)) {
    const text = node.expression.getText(source);
    if (text === 'middy' || text.endsWith('.middy')) {
      return true;
    }
    // middy(baseHandler).use(...).use(...) chains
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use') {
      return isLambdaHandlerExpression(node.expression.expression, source);
    }
  }
  // Identifier reference — treat as lambda handler if name contains 'handler'
  if (ts.isIdentifier(node)) {
    return /handler/i.test(node.text);
  }
  return false;
}

function isLambdaFunctionDeclaration(node: ts.FunctionDeclaration): boolean {
  return node.parameters.length >= 1 && /^(event|evt)$/i.test(node.parameters[0].name.getText());
}

function hasEventParameter(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return (
    node.parameters.length >= 1 &&
    /^(event|evt)$/i.test(node.parameters[0].name.getText())
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  );
}

// ---------------------------------------------------------------------------
// Middy unwrapping: middy(baseHandler).use(plugin1).use(plugin2)
// ---------------------------------------------------------------------------

function unwrapMiddy(
  node: ts.Expression,
  source: ts.SourceFile
): { handlerNode: ts.Node; middlewareNodes: ts.Expression[] } {
  const middlewareNodes: ts.Expression[] = [];

  // Walk .use() chain collecting plugin arguments
  let current: ts.Expression = node;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === 'use'
  ) {
    middlewareNodes.unshift(...current.arguments);
    current = current.expression.expression;
  }

  // Now current should be middy(baseHandler) or the handler itself
  if (
    ts.isCallExpression(current) &&
    (current.expression.getText(source) === 'middy' || current.expression.getText(source).endsWith('.middy'))
  ) {
    const baseHandler = current.arguments[0] ?? current;
    return { handlerNode: baseHandler, middlewareNodes };
  }

  return { handlerNode: node, middlewareNodes: [] };
}

// ---------------------------------------------------------------------------
// Middleware resolution from Middy .use() plugins
// ---------------------------------------------------------------------------

function resolveMiddleware(middlewareNodes: ts.Expression[], source: ts.SourceFile, filePath: string): ApiMiddleware[] {
  return middlewareNodes.map((node) => {
    const name = resolveMiddlewareName(node, source);
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    return {
      name,
      location: { filePath, line: pos.line + 1, column: pos.character + 1, symbolName: name }
    };
  });
}

function resolveMiddlewareName(node: ts.Expression, source: ts.SourceFile): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return node.getText(source).slice(0, 40).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Parameter extraction from event.* accesses
// ---------------------------------------------------------------------------

const EVENT_PARAM_SOURCES: Record<string, 'path' | 'query' | 'header' | 'body'> = {
  pathParameters: 'path',
  queryStringParameters: 'query',
  multiValueQueryStringParameters: 'query',
  headers: 'header',
  multiValueHeaders: 'header',
  body: 'body'
};

function extractEventParameters(handlerNode: ts.Node, source: ts.SourceFile, filePath: string): ApiParameter[] {
  // Find the event parameter name inside the handler
  const eventParamName = resolveEventParamName(handlerNode);
  if (!eventParamName) {
    return [];
  }

  const byKey = new Map<string, ApiParameter>();

  const visit = (node: ts.Node): void => {
    // event.pathParameters.X  or  event.pathParameters?.X
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const chain = parsePropertyChain(node, source);
      if (chain.length >= 2 && chain[0] === eventParamName) {
        const sourceKey = chain[1];
        const location = EVENT_PARAM_SOURCES[sourceKey];

        if (location === 'body') {
          const key = 'body::body';
          if (!byKey.has(key)) {
            const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
            byKey.set(key, {
              name: 'body',
              location: 'body',
              detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1 }
            });
          }
        } else if (location && chain.length >= 3) {
          const paramName = chain[2];
          const key = `${location}::${paramName}`;
          if (!byKey.has(key)) {
            const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
            byKey.set(key, {
              name: paramName,
              location,
              detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1 }
            });
          }
        }
      }
    }

    // JSON.parse(event.body) → body param
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'JSON' &&
      node.expression.name.text === 'parse' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      const chain = parsePropertyChain(arg, source);
      if (chain.length === 2 && chain[0] === eventParamName && chain[1] === 'body') {
        const key = 'body::body';
        if (!byKey.has(key)) {
          const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
          byKey.set(key, {
            name: 'body',
            location: 'body',
            type: 'json',
            detectionLocation: { filePath, line: pos.line + 1, column: pos.character + 1 }
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(handlerNode);
  return Array.from(byKey.values());
}

/**
 * Resolve the first parameter name of the lambda handler (event / evt / etc.)
 */
function resolveEventParamName(handlerNode: ts.Node): string | undefined {
  if (ts.isArrowFunction(handlerNode) || ts.isFunctionExpression(handlerNode) || ts.isFunctionDeclaration(handlerNode)) {
    const first = handlerNode.parameters[0];
    if (first && ts.isIdentifier(first.name)) {
      return first.name.text;
    }
  }
  // For an identifier reference (not the actual function), we can't know without
  // resolving the symbol — default to common names
  if (ts.isIdentifier(handlerNode)) {
    return 'event';
  }
  return 'event';
}

/**
 * Parse a (possibly optional-chained) property access expression into a string array.
 * e.g. `event?.pathParameters?.userId` → ['event', 'pathParameters', 'userId']
 */
function parsePropertyChain(node: ts.Node, source: ts.SourceFile): string[] {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }

  if (ts.isPropertyAccessExpression(node)) {
    const left = parsePropertyChain(node.expression, source);
    return [...left, node.name.text];
  }

  // Optional chaining: a?.b
  if (
    (node as ts.Node & { kind: number }).kind === ts.SyntaxKind.PropertyAccessExpression ||
    ts.isNonNullExpression(node)
  ) {
    return parsePropertyChain((node as ts.NonNullExpression).expression, source);
  }

  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const left = parsePropertyChain(node.expression, source);
    return [...left, node.argumentExpression.text];
  }

  // Fallback: get raw text and split
  const text = node.getText(source).replace(/\?/g, '').replace(/\s/g, '');
  return text.split('.');
}
