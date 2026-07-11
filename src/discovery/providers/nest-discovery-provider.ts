import * as fs from 'fs';
import * as ts from 'typescript';
import { createResolutionContext, joinPaths, toPathValue } from '../path-utils';
import { ApiDiscoveryProvider, ProviderSupport } from '../provider';
import { collectSourceFiles } from '../source-files';
import { ApiEndpoint, ApiMiddleware, DiscoveryContext, DiscoveryResult, DiscoveryWarning, EndpointConfidence, FrameworkFingerprint } from '../types';

interface CachedNestFileAnalysis {
  mtimeMs: number;
  size: number;
  endpoints: ApiEndpoint[];
  warnings: DiscoveryWarning[];
}

export class NestDiscoveryProvider implements ApiDiscoveryProvider {
  public readonly id = 'provider.nestjs';
  private readonly fileCache = new Map<string, CachedNestFileAnalysis>();
  private readonly projectFileIndex = new Map<string, Set<string>>();

  public clearCache(projectRoot?: string): void {
    if (!projectRoot) {
      this.fileCache.clear();
      this.projectFileIndex.clear();
      return;
    }

    for (const [indexedProjectRoot, indexedFiles] of this.projectFileIndex.entries()) {
      if (normalizePath(indexedProjectRoot) !== normalizePath(projectRoot)) {
        continue;
      }
      for (const indexedFile of indexedFiles) {
        this.fileCache.delete(indexedFile);
      }
      this.projectFileIndex.delete(indexedProjectRoot);
    }
  }

  public supports(fingerprint: FrameworkFingerprint): ProviderSupport {
    const deps = {
      ...fingerprint.packageJson?.dependencies,
      ...fingerprint.packageJson?.devDependencies
    };
    if (deps['@nestjs/common']) {
      return { supported: true, confidence: 0.98, reasons: ['@nestjs/common dependency detected'] };
    }
    return { supported: false, confidence: 0, reasons: ['@nestjs/common dependency not found'] };
  }

  public async discover(_context: DiscoveryContext, _fingerprint: FrameworkFingerprint): Promise<DiscoveryResult> {
    const startedAt = Date.now();
    const warnings: DiscoveryResult['warnings'] = [];
    const endpoints: ApiEndpoint[] = [];
    const files = _fingerprint.sourceFiles ?? collectSourceFiles(_fingerprint.projectRoot);

    this.pruneDeletedFiles(_fingerprint.projectRoot, files);

    for (const filePath of files) {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const cached = this.fileCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        endpoints.push(...cached.endpoints.map((endpoint) => structuredClone(endpoint)));
        warnings.push(...cached.warnings.map((warning) => ({ ...warning })));
        continue;
      }

      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const fileWarnings: DiscoveryWarning[] = [];
      const fileEndpoints: ApiEndpoint[] = [];

      const source = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
      );
      const resolutionContext = createResolutionContext(source, _fingerprint.projectRoot, _context.envOverrides);

      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) {
          const classDecorators = getDecorators(node);
          const controllerDecorator = classDecorators.find((decorator) => getDecoratorName(decorator, source) === 'Controller');
          if (controllerDecorator) {
            const controllerPath = toPathValue(getFirstDecoratorArg(controllerDecorator), source, resolutionContext);
            const classMiddleware = extractNestMiddleware(classDecorators, source);
            for (const member of node.members) {
              if (!ts.isMethodDeclaration(member)) {
                continue;
              }

              const memberDecorators = getDecorators(member);
              const methodDecorators = memberDecorators
                .map((decorator) => ({ decorator, name: getDecoratorName(decorator, source) }))
                .filter((item) => Boolean(item.name));

              for (const item of methodDecorators) {
                const method = mapNestMethod(item.name!);
                if (!method) {
                  continue;
                }

                const routePath = toPathValue(getFirstDecoratorArg(item.decorator), source, resolutionContext);
                const joined = joinPaths(controllerPath.pathExpression, routePath.pathExpression);
                const methodMiddleware = extractNestMiddleware(memberDecorators, source);
                const symbolName = member.name?.getText(source);
                const nameNode = member.name ?? member;
                const position = source.getLineAndCharacterOfPosition(nameNode.getStart(source));
                const confidence = combineConfidence(controllerPath.confidence, routePath.confidence);

                fileEndpoints.push({
                  method,
                  framework: 'nestjs',
                  pathExpression: joined.pathExpression,
                  resolvedPath: confidence === 'high' ? joined.resolvedPath : undefined,
                  confidence,
                  handlerLocation: {
                    filePath,
                    line: position.line + 1,
                    column: position.character + 1,
                    symbolName
                  },
                  middleware: [...classMiddleware, ...methodMiddleware]
                });

                if (confidence !== 'high') {
                  fileWarnings.push({
                    code: 'dynamic-path-unresolved',
                    framework: 'nestjs',
                    filePath,
                    message: `Dynamic NestJS route path unresolved at ${symbolName ?? 'unknown handler'} in ${filePath}`
                  });
                }
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
      endpoints.push(...fileEndpoints);
      warnings.push(...fileWarnings);

      this.fileCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        endpoints: fileEndpoints.map((endpoint) => structuredClone(endpoint)),
        warnings: fileWarnings.map((warning) => ({ ...warning }))
      });
    }

    return {
      endpoints,
      warnings,
      stats: {
        frameworksDetected: ['nestjs'],
        providersRun: [this.id],
        endpointCount: endpoints.length,
        unresolvedEndpointCount: endpoints.filter((endpoint) => !endpoint.resolvedPath).length,
        scanDurationMs: Date.now() - startedAt
      }
    };
  }

  private pruneDeletedFiles(projectRoot: string, files: string[]): void {
    const nextFiles = new Set(files);
    const previousFiles = this.projectFileIndex.get(projectRoot);

    if (previousFiles) {
      for (const previousFile of previousFiles) {
        if (!nextFiles.has(previousFile)) {
          this.fileCache.delete(previousFile);
        }
      }
    }

    this.projectFileIndex.set(projectRoot, nextFiles);
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function getDecoratorName(decorator: ts.Decorator, source: ts.SourceFile): string | undefined {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression)) {
      return expr.expression.text;
    }
    return expr.expression.getText(source);
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return undefined;
}

function getFirstDecoratorArg(decorator: ts.Decorator): ts.Expression | undefined {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) {
    return undefined;
  }
  return expr.arguments[0];
}

function mapNestMethod(name: string): string | undefined {
  const map: Record<string, string> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Delete: 'DELETE',
    Patch: 'PATCH',
    Options: 'OPTIONS',
    Head: 'HEAD',
    All: 'ALL'
  };
  return map[name];
}

function getDecorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function extractNestMiddleware(decorators: readonly ts.Decorator[] | undefined, source: ts.SourceFile): ApiMiddleware[] {
  if (!decorators || decorators.length === 0) {
    return [];
  }

  const middlewareDecorators = new Set(['UseGuards', 'UseInterceptors', 'UsePipes', 'UseFilters']);
  const result: ApiMiddleware[] = [];

  for (const decorator of decorators) {
    const name = getDecoratorName(decorator, source);
    if (!name || !middlewareDecorators.has(name)) {
      continue;
    }

    const call = decorator.expression;
    if (!ts.isCallExpression(call)) {
      result.push({ name });
      continue;
    }

    for (const arg of call.arguments) {
      result.push({ name: `${name}:${arg.getText(source)}` });
    }
  }

  return result;
}

function combineConfidence(a: EndpointConfidence, b: EndpointConfidence): EndpointConfidence {
  if (a === 'low' || b === 'low') {
    return 'low';
  }
  if (a === 'medium' || b === 'medium') {
    return 'medium';
  }
  return 'high';
}
