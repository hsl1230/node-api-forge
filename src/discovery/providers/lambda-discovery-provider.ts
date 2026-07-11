import * as fs from 'fs';
import * as path from 'path';
import { LambdaComponentAnalyzer } from '../analyzer/lambda-component-analyzer';
import { ApiDiscoveryProvider, ProviderSupport } from '../provider';
import { collectSourceFiles } from '../source-files';
import { ApiEndpoint, ApiMiddleware, DiscoveryContext, DiscoveryResult, DiscoveryWarning, FrameworkFingerprint } from '../types';

interface CachedLambdaFileAnalysis {
  mtimeMs: number;
  size: number;
  endpoints: ApiEndpoint[];
  warnings: DiscoveryWarning[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class LambdaDiscoveryProvider implements ApiDiscoveryProvider {
  public readonly id = 'provider.lambda';
  private readonly analyzer = new LambdaComponentAnalyzer();
  private readonly fileCache = new Map<string, CachedLambdaFileAnalysis>();
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

    // Defer to Express/Fastify providers when those frameworks are present
    if (deps.express || deps.fastify) {
      return {
        supported: false,
        confidence: 0,
        reasons: ['express or fastify detected — deferring to existing provider']
      };
    }

    const hasLambdaDep = Boolean(
      deps['@types/aws-lambda'] || deps['aws-lambda'] || deps['serverless']
    );

    const hasConfigFile =
      fs.existsSync(path.join(fingerprint.projectRoot, 'serverless.yml')) ||
      fs.existsSync(path.join(fingerprint.projectRoot, 'serverless.yaml')) ||
      fs.existsSync(path.join(fingerprint.projectRoot, 'template.yaml')) ||
      fs.existsSync(path.join(fingerprint.projectRoot, 'template.json'));

    if (hasLambdaDep) {
      return { supported: true, confidence: 0.95, reasons: ['lambda-related dependency detected'] };
    }
    if (hasConfigFile) {
      return { supported: true, confidence: 0.75, reasons: ['serverless/SAM config file detected'] };
    }
    return { supported: false, confidence: 0, reasons: ['no lambda indicators found'] };
  }

  public async discover(context: DiscoveryContext, fingerprint: FrameworkFingerprint): Promise<DiscoveryResult> {
    const startedAt = Date.now();
    const warnings: DiscoveryWarning[] = [];
    const endpoints: ApiEndpoint[] = [];
    const projectRoot = fingerprint.projectRoot;

    // Strategy 1: Serverless Framework config
    for (const candidate of ['serverless.yml', 'serverless.yaml']) {
      const configPath = path.join(projectRoot, candidate);
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          const parsed = parseServerlessConfig(content);
          const fromConfig = resolveServerlessEndpoints(parsed, projectRoot, warnings);
          endpoints.push(...fromConfig);
        } catch {
          warnings.push({
            code: 'provider-failed',
            framework: 'lambda',
            filePath: configPath,
            message: `Failed to parse Serverless Framework config: ${configPath}`
          });
        }
        break;
      }
    }

    // Strategy 2: AWS SAM config
    if (endpoints.length === 0) {
      const samYaml = path.join(projectRoot, 'template.yaml');
      const samJson = path.join(projectRoot, 'template.json');

      if (fs.existsSync(samJson)) {
        try {
          const content = fs.readFileSync(samJson, 'utf-8');
          const parsed = JSON.parse(content) as Record<string, unknown>;
          const fromSam = resolveSamEndpoints(parsed, projectRoot, warnings);
          endpoints.push(...fromSam);
        } catch {
          warnings.push({
            code: 'provider-failed',
            framework: 'lambda',
            filePath: samJson,
            message: `Failed to parse SAM template: ${samJson}`
          });
        }
      } else if (fs.existsSync(samYaml)) {
        try {
          const content = fs.readFileSync(samYaml, 'utf-8');
          const parsed = parseYamlToObject(content);
          const fromSam = resolveSamEndpoints(parsed, projectRoot, warnings);
          endpoints.push(...fromSam);
        } catch {
          warnings.push({
            code: 'provider-failed',
            framework: 'lambda',
            filePath: samYaml,
            message: `Failed to parse SAM template: ${samYaml}`
          });
        }
      }
    }

    // Strategy 3: Handler-scan fallback when no config routes found
    if (endpoints.length === 0) {
      const files = fingerprint.sourceFiles ?? collectSourceFiles(projectRoot);
      this.pruneDeletedFiles(projectRoot, files);

      for (const filePath of files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }

        const cached = this.fileCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          endpoints.push(...cached.endpoints.map((ep) => structuredClone(ep)));
          warnings.push(...cached.warnings.map((w) => ({ ...w })));
          continue;
        }

        let content = '';
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }

        const fileEndpoints = await this.analyzer.analyzeFile(filePath, content, fingerprint, context);
        const fileWarnings: DiscoveryWarning[] = fileEndpoints.map((ep) => ({
          code: 'seed-endpoint-unmatched',
          framework: 'lambda' as const,
          filePath: ep.handlerLocation.filePath,
          message: `Lambda handler '${ep.handlerLocation.symbolName}' found without a config-file route definition. Path is unknown.`
        }));

        endpoints.push(...fileEndpoints);
        warnings.push(...fileWarnings);

        this.fileCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          endpoints: fileEndpoints.map((ep) => structuredClone(ep)),
          warnings: fileWarnings.map((w) => ({ ...w }))
        });
      }
    }

    return {
      endpoints,
      warnings,
      stats: {
        frameworksDetected: ['lambda'],
        providersRun: [this.id],
        endpointCount: endpoints.length,
        unresolvedEndpointCount: endpoints.filter((ep) => !ep.resolvedPath).length,
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

// ---------------------------------------------------------------------------
// Serverless Framework config resolver
// ---------------------------------------------------------------------------

function resolveServerlessEndpoints(
  config: Record<string, unknown>,
  projectRoot: string,
  warnings: DiscoveryWarning[]
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const functions = config.functions as Record<string, unknown> | undefined;
  if (!functions || typeof functions !== 'object') {
    return endpoints;
  }

  for (const [fnName, fnConfig] of Object.entries(functions)) {
    if (!fnConfig || typeof fnConfig !== 'object') {
      continue;
    }
    const fn = fnConfig as Record<string, unknown>;
    const handlerRef = fn.handler as string | undefined;
    if (!handlerRef || typeof handlerRef !== 'string') {
      continue;
    }

    const { filePath: handlerFile, exportName } = splitHandlerRef(handlerRef, projectRoot);
    const resolvedHandlerPath = resolveHandlerFile(handlerFile, projectRoot);

    if (!resolvedHandlerPath) {
      warnings.push({
        code: 'dynamic-path-unresolved',
        framework: 'lambda',
        message: `Lambda handler file not found for function '${fnName}': ${handlerRef}`
      });
    }

    const events = fn.events as unknown[] | undefined;
    if (!Array.isArray(events)) {
      continue;
    }

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        continue;
      }
      const http = (event as Record<string, unknown>).http as Record<string, unknown> | undefined;
      if (!http || typeof http !== 'object') {
        continue;
      }

      const httpPath = http.path as string | undefined;
      const httpMethod = http.method as string | undefined;
      if (!httpPath || !httpMethod) {
        continue;
      }

      const normalizedPath = normalizeLambdaPath(httpPath);
      const middleware: ApiMiddleware[] = [];
      if (http.authorizer) {
        const authName = typeof http.authorizer === 'string' ? http.authorizer : 'authorizer';
        middleware.push({ name: authName });
      }

      endpoints.push({
        method: httpMethod.toUpperCase(),
        framework: 'lambda',
        pathExpression: normalizedPath,
        resolvedPath: normalizedPath,
        confidence: 'high',
        handlerLocation: {
          filePath: resolvedHandlerPath ?? handlerFile,
          line: 1,
          column: 1,
          symbolName: exportName
        },
        middleware
      });
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// AWS SAM config resolver
// ---------------------------------------------------------------------------

function resolveSamEndpoints(
  template: Record<string, unknown>,
  projectRoot: string,
  warnings: DiscoveryWarning[]
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const resources = template.Resources as Record<string, unknown> | undefined;
  if (!resources || typeof resources !== 'object') {
    return endpoints;
  }

  for (const [resourceName, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object') {
      continue;
    }
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::Serverless::Function') {
      continue;
    }

    const properties = res.Properties as Record<string, unknown> | undefined;
    if (!properties) {
      continue;
    }

    const handlerRef = properties.Handler as string | undefined;
    if (!handlerRef || typeof handlerRef !== 'string') {
      continue;
    }

    const { filePath: handlerFile, exportName } = splitHandlerRef(handlerRef, projectRoot);
    const resolvedHandlerPath = resolveHandlerFile(handlerFile, projectRoot);

    if (!resolvedHandlerPath) {
      warnings.push({
        code: 'dynamic-path-unresolved',
        framework: 'lambda',
        message: `Lambda handler file not found for SAM resource '${resourceName}': ${handlerRef}`
      });
    }

    const events = properties.Events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object') {
      continue;
    }

    for (const [, eventConfig] of Object.entries(events)) {
      if (!eventConfig || typeof eventConfig !== 'object') {
        continue;
      }
      const ev = eventConfig as Record<string, unknown>;
      if (ev.Type !== 'Api' && ev.Type !== 'HttpApi') {
        continue;
      }

      const evProps = ev.Properties as Record<string, unknown> | undefined;
      if (!evProps) {
        continue;
      }

      const httpPath = evProps.Path as string | undefined;
      const httpMethod = evProps.Method as string | undefined;
      if (!httpPath || !httpMethod) {
        continue;
      }

      const normalizedPath = normalizeLambdaPath(httpPath);
      const auth = evProps.Auth as Record<string, unknown> | undefined;
      const middleware: ApiMiddleware[] = [];
      if (auth?.Authorizer) {
        middleware.push({ name: String(auth.Authorizer) });
      }

      endpoints.push({
        method: httpMethod.toUpperCase(),
        framework: 'lambda',
        pathExpression: normalizedPath,
        resolvedPath: normalizedPath,
        confidence: 'high',
        handlerLocation: {
          filePath: resolvedHandlerPath ?? handlerFile,
          line: 1,
          column: 1,
          symbolName: exportName
        },
        middleware
      });
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Handler reference resolution
// ---------------------------------------------------------------------------

/**
 * Split a Lambda handler reference into file path and export name.
 * e.g. "src/handlers/user.getUser" → { filePath: "src/handlers/user", exportName: "getUser" }
 * e.g. "handler.main" → { filePath: "handler", exportName: "main" }
 */
function splitHandlerRef(handlerRef: string, _projectRoot: string): { filePath: string; exportName: string } {
  const lastDot = handlerRef.lastIndexOf('.');
  if (lastDot === -1) {
    return { filePath: handlerRef, exportName: 'handler' };
  }
  return {
    filePath: handlerRef.slice(0, lastDot),
    exportName: handlerRef.slice(lastDot + 1)
  };
}

/**
 * Try to find a handler source file on disk by trying common extensions.
 * Returns the absolute path if found, undefined otherwise.
 */
function resolveHandlerFile(handlerFilePath: string, projectRoot: string): string | undefined {
  const candidates = [
    path.join(projectRoot, `${handlerFilePath}.ts`),
    path.join(projectRoot, `${handlerFilePath}.js`),
    path.join(projectRoot, handlerFilePath, 'index.ts'),
    path.join(projectRoot, handlerFilePath, 'index.js')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Normalize an API Gateway / SAM path to a consistent format.
 * API Gateway uses {id}, which we keep as-is.
 */
function normalizeLambdaPath(httpPath: string): string {
  // Ensure leading slash
  return httpPath.startsWith('/') ? httpPath : `/${httpPath}`;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (handles serverless.yml and SAM template.yaml structures)
// ---------------------------------------------------------------------------

/**
 * Parse a subset of YAML into a plain JS object tree.
 * Supports: string scalars, objects (indented key:value), arrays (- item),
 * multi-line values are not supported — sufficient for serverless/SAM configs.
 */
export function parseYamlToObject(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  const result = parseYamlBlock(lines, 0, -1);
  return result.value as Record<string, unknown>;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function parseYamlBlock(lines: string[], startLine: number, parentIndent: number): ParseResult {
  const obj: Record<string, unknown> = {};
  const arr: unknown[] = [];
  let isArray = false;
  let i = startLine;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    // Skip empty lines and comments
    if (trimmed.trim() === '' || trimmed.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    const indent = getIndent(raw);

    // If we've dedented past what this block owns, return
    if (indent <= parentIndent) {
      break;
    }

    const content = trimmed.trimStart();

    // Array item
    if (content.startsWith('- ')) {
      isArray = true;
      const valueStr = content.slice(2).trim();

      if (valueStr === '' || valueStr.endsWith(':')) {
        // Nested object or empty inline value
        if (valueStr.endsWith(':')) {
          const key = valueStr.slice(0, -1).trim();
          const nested = parseYamlBlock(lines, i + 1, indent);
          const itemObj: Record<string, unknown> = {};
          itemObj[key] = nested.value;
          arr.push(itemObj);
          i = nested.nextLine;
        } else {
          const nested = parseYamlBlock(lines, i + 1, indent);
          arr.push(nested.value);
          i = nested.nextLine;
        }
      } else if (valueStr.includes(': ') || valueStr.endsWith(':')) {
        // Inline object on array item line: "- http:"
        const itemObj: Record<string, unknown> = {};
        const colIdx = valueStr.indexOf(':');
        const k = valueStr.slice(0, colIdx).trim();
        const v = valueStr.slice(colIdx + 1).trim();
        if (v === '') {
          // object value on next lines
          const nested = parseYamlBlock(lines, i + 1, indent);
          itemObj[k] = nested.value;
          arr.push(itemObj);
          i = nested.nextLine;
        } else {
          itemObj[k] = parseScalar(v);
          arr.push(itemObj);
          i++;
        }
      } else {
        arr.push(parseScalar(valueStr));
        i++;
      }
      continue;
    }

    // Key: value line
    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = content.slice(0, colonIdx).trim();
    const rest = content.slice(colonIdx + 1).trim();

    if (rest === '' || rest.startsWith('#')) {
      // Value is on following lines (nested block)
      const nested = parseYamlBlock(lines, i + 1, indent);
      obj[key] = nested.value;
      i = nested.nextLine;
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }

  if (isArray) {
    return { value: arr, nextLine: i };
  }

  return { value: obj, nextLine: i };
}

function getIndent(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count++;
    else if (ch === '\t') count += 2;
    else break;
  }
  return count;
}

function parseScalar(value: string): unknown {
  // Remove inline comments
  const commentIdx = value.indexOf(' #');
  const clean = commentIdx !== -1 ? value.slice(0, commentIdx).trim() : value.trim();

  // Quoted strings
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }
  // Booleans
  if (clean === 'true') return true;
  if (clean === 'false') return false;
  // Null
  if (clean === 'null' || clean === '~') return null;
  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(clean)) return Number(clean);

  return clean;
}

/**
 * Parse a Serverless Framework YAML config. Alias for parseYamlToObject.
 */
function parseServerlessConfig(content: string): Record<string, unknown> {
  return parseYamlToObject(content);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}
