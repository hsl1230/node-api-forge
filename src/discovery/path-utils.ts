import * as ts from 'typescript';
import { EndpointConfidence } from './types';

export interface ResolutionContext {
  variables?: Record<string, string>;
  env?: Record<string, string>;
}

export interface PathValue {
  pathExpression: string;
  resolvedPath?: string;
  confidence: EndpointConfidence;
}

export function createResolutionContext(sourceFile: ts.SourceFile, projectRoot?: string, envOverrides?: Record<string, string>): ResolutionContext {
  const variables: Record<string, string> = {};

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const literal = getStaticString(node.initializer, sourceFile, { variables });
      if (literal !== undefined) {
        variables[node.name.text] = literal;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const env: Record<string, string> = {
    ...loadDotEnv(projectRoot),
    ...envOverrides
  };

  return { variables, env };
}

export function toPathValue(expr: ts.Expression | undefined, sourceFile: ts.SourceFile, resolutionContext?: ResolutionContext): PathValue {
  if (!expr) {
    return { pathExpression: '/', resolvedPath: '/', confidence: 'high' };
  }

  const resolvedStatic = getStaticString(expr, sourceFile, resolutionContext);
  if (resolvedStatic !== undefined) {
    return {
      pathExpression: resolvedStatic,
      resolvedPath: resolvedStatic,
      confidence: 'high'
    };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    const value = expr.text || '/';
    return { pathExpression: value, resolvedPath: value, confidence: 'high' };
  }

  if (ts.isTemplateExpression(expr)) {
    const interpolated = interpolateTemplateExpression(expr, sourceFile, resolutionContext);
    if (interpolated.resolvedPath) {
      return interpolated;
    }

    const head = expr.head.text;
    return {
      pathExpression: expr.getText(sourceFile),
      resolvedPath: head || undefined,
      confidence: head ? 'medium' : 'low'
    };
  }

  if (ts.isIdentifier(expr)) {
    return {
      pathExpression: expr.getText(sourceFile),
      confidence: 'low'
    };
  }

  return {
    pathExpression: expr.getText(sourceFile),
    confidence: 'low'
  };
}

export function joinPaths(prefix?: string, route?: string): { pathExpression: string; resolvedPath?: string } {
  const normalizedPrefix = normalizePathSegment(prefix ?? '');
  const normalizedRoute = normalizePathSegment(route ?? '');
  const expression = normalizeCombinedPath(`${normalizedPrefix}/${normalizedRoute}`);

  const hasDynamic = (prefix ?? '').includes('${') || (route ?? '').includes('${');
  if (hasDynamic) {
    return { pathExpression: expression };
  }
  return { pathExpression: expression, resolvedPath: expression };
}

function normalizePathSegment(value: string): string {
  if (!value) {
    return '';
  }
  return value.replace(/^['"`]/, '').replace(/['"`]$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeCombinedPath(value: string): string {
  const compact = value.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!compact || compact === '/') {
    return '/';
  }
  return compact.startsWith('/') ? compact : `/${compact}`;
}

function getStaticString(expr: ts.Expression, sourceFile: ts.SourceFile, resolutionContext?: ResolutionContext): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  if (ts.isParenthesizedExpression(expr)) {
    return getStaticString(expr.expression, sourceFile, resolutionContext);
  }

  if (ts.isIdentifier(expr)) {
    return resolutionContext?.variables?.[expr.text];
  }

  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = getStaticString(expr.left, sourceFile, resolutionContext);
    const right = getStaticString(expr.right, sourceFile, resolutionContext);
    if (left !== undefined && right !== undefined) {
      return `${left}${right}`;
    }
  }

  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return getStaticString(expr.left, sourceFile, resolutionContext) ?? getStaticString(expr.right, sourceFile, resolutionContext);
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const text = expr.getText(sourceFile);
    if (text.startsWith('process.env.')) {
      const key = text.substring('process.env.'.length);
      return resolutionContext?.env?.[key];
    }
  }

  return undefined;
}

function interpolateTemplateExpression(
  expr: ts.TemplateExpression,
  sourceFile: ts.SourceFile,
  resolutionContext?: ResolutionContext
): PathValue {
  const parts: string[] = [expr.head.text];
  let fullyResolved = true;

  for (const span of expr.templateSpans) {
    const spanValue = getStaticString(span.expression, sourceFile, resolutionContext);
    if (spanValue === undefined) {
      fullyResolved = false;
      parts.push('${...}');
    } else {
      parts.push(spanValue);
    }
    parts.push(span.literal.text);
  }

  const resolvedPath = fullyResolved ? normalizeCombinedPath(parts.join('')) : undefined;
  return {
    pathExpression: expr.getText(sourceFile),
    resolvedPath,
    confidence: fullyResolved ? 'high' : 'medium'
  };
}

function loadDotEnv(projectRoot?: string): Record<string, string> {
  if (!projectRoot) {
    return {};
  }

  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];
  const result: Record<string, string> = {};

  for (const fileName of envFiles) {
    const filePath = `${projectRoot}/${fileName}`;
    try {
      const content = require('fs').readFileSync(filePath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        result[key] = value;
      }
    } catch {
      continue;
    }
  }

  return result;
}
