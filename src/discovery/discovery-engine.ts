import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { analyzeHandlerMetadata, extractPathParameters } from './analyzer';
import { FrameworkDetector } from './framework-detector';
import { ApiDiscoveryProvider } from './provider';
import { loadHybridSeedEndpoints } from './seed-loader';
import { collectSourceFiles } from './source-files';
import { ApiEndpoint, ApiParameter, DiscoveryContext, DiscoveryResult, ParameterLocation, SourceLocation } from './types';

interface CachedComponentDependencies {
  mtimeMs: number;
  size: number;
  contextSignature: string;
  dependencies: string[];
  parameters: ApiParameter[];
}

interface DependencyCollectionResult {
  files: Set<string>;
  changedFiles: Set<string>;
  truncated: boolean;
}

const COMPONENT_DEPENDENCY_MAX_FILES = 400;

class ComponentDependencyGraph {
  private readonly componentCache = new Map<string, CachedComponentDependencies>();
  private readonly reverseDependencies = new Map<string, Set<string>>();

  public collectDependencyFiles(rootFiles: Set<string>): DependencyCollectionResult {
    const visited = new Set<string>();
    const changedFiles = new Set<string>();
    const queue: string[] = [];

    for (const rootFile of rootFiles) {
      const normalized = normalizeFilePath(rootFile);
      if (!normalized || visited.has(normalized) || !fs.existsSync(normalized)) {
        continue;
      }
      visited.add(normalized);
      queue.push(normalized);
    }

    while (queue.length > 0 && visited.size < COMPONENT_DEPENDENCY_MAX_FILES) {
      const filePath = queue.shift();
      if (!filePath) {
        continue;
      }

      const { dependencies, changed } = this.getDependencies(filePath);
      if (changed) {
        changedFiles.add(filePath);
      }

      for (const dependencyFile of dependencies) {
        const normalized = normalizeFilePath(dependencyFile);
        if (visited.has(normalized)) {
          continue;
        }

        visited.add(normalized);
        queue.push(normalized);
      }
    }

    return {
      files: visited,
      changedFiles,
      truncated: queue.length > 0
    };
  }

  public invalidate(projectRoots?: string[]): void {
    if (!projectRoots || projectRoots.length === 0) {
      this.componentCache.clear();
      return;
    }

    const normalizedRoots = projectRoots.map((root) => normalizeFilePath(root));
    for (const filePath of this.componentCache.keys()) {
      for (const root of normalizedRoots) {
        if (filePath === root || filePath.startsWith(`${root}/`)) {
          this.componentCache.delete(filePath);
          this.reverseDependencies.delete(filePath);
          break;
        }
      }
    }

    for (const dependency of Array.from(this.reverseDependencies.keys())) {
      for (const root of normalizedRoots) {
        if (dependency === root || dependency.startsWith(`${root}/`)) {
          this.reverseDependencies.delete(dependency);
          break;
        }
      }
    }
  }

  public getParameters(filePath: string, contextProperties: string[] = ['locals']): ApiParameter[] {
    const analysis = this.getComponentAnalysis(filePath, contextProperties).analysis;
    if (!analysis) {
      return [];
    }

    return analysis.parameters.map((parameter) => cloneApiParameter(parameter));
  }

  private getDependencies(filePath: string): { dependencies: string[]; changed: boolean } {
    const result = this.getComponentAnalysis(filePath);
    const analysis = result.analysis;
    if (!analysis) {
      return { dependencies: [], changed: false };
    }

    return {
      dependencies: analysis.dependencies,
      changed: result.changed
    };
  }

  private getComponentAnalysis(filePath: string, contextProperties: string[] = ['locals']): { analysis?: CachedComponentDependencies; changed: boolean } {
    const normalizedPath = normalizeFilePath(filePath);
    const normalizedContextProperties = normalizeContextProperties(contextProperties);
    const contextSignature = normalizedContextProperties.join('|');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(normalizedPath);
    } catch {
      this.componentCache.delete(normalizedPath);
      this.removeReverseEdgesForParent(normalizedPath);
      return { changed: false };
    }

    const cached = this.componentCache.get(normalizedPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.contextSignature === contextSignature) {
      return { analysis: cached, changed: false };
    }

    let content = '';
    try {
      content = fs.readFileSync(normalizedPath, 'utf-8');
    } catch {
      this.componentCache.delete(normalizedPath);
      this.removeReverseEdgesForParent(normalizedPath);
      return { changed: false };
    }

    const dependencies: string[] = [];
    for (const specifier of extractDependencySpecifiers(content)) {
      const resolved = resolveDependencyFile(specifier, normalizedPath);
      if (!resolved) {
        continue;
      }
      dependencies.push(normalizeFilePath(resolved));
    }

    const parameters = extractParametersFromComponentSource(content, normalizedPath, normalizedContextProperties);

    const analysis: CachedComponentDependencies = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      contextSignature,
      dependencies,
      parameters
    };
    this.componentCache.set(normalizedPath, analysis);
    this.updateReverseEdges(normalizedPath, dependencies);

    return { analysis, changed: true };
  }

  private updateReverseEdges(parent: string, dependencies: string[]): void {
    this.removeReverseEdgesForParent(parent);
    for (const dependency of dependencies) {
      const normalizedDependency = normalizeFilePath(dependency);
      if (!this.reverseDependencies.has(normalizedDependency)) {
        this.reverseDependencies.set(normalizedDependency, new Set());
      }
      this.reverseDependencies.get(normalizedDependency)?.add(parent);
    }
  }

  private removeReverseEdgesForParent(parent: string): void {
    for (const dependencySet of this.reverseDependencies.values()) {
      dependencySet.delete(parent);
    }
    for (const [dependency, dependencySet] of Array.from(this.reverseDependencies.entries())) {
      if (dependencySet.size === 0) {
        this.reverseDependencies.delete(dependency);
      }
    }
  }
}

export class ApiDiscoveryEngine {
  private readonly detector: FrameworkDetector;
  private readonly providers: ApiDiscoveryProvider[];
  private readonly componentDependencyGraph: ComponentDependencyGraph;
  private readonly endpointParameterCache = new Map<string, ApiParameter[]>();
  private readonly endpointComponentFilesCache = new Map<string, string[]>();

  constructor(providers: ApiDiscoveryProvider[], detector = new FrameworkDetector()) {
    this.providers = providers;
    this.detector = detector;
    this.componentDependencyGraph = new ComponentDependencyGraph();
  }

  public invalidateCaches(projectRoots?: string[]): void {
    this.componentDependencyGraph.invalidate(projectRoots);
    this.invalidateEndpointParameterCache(projectRoots);
    invalidateResolutionCache(projectRoots);

    for (const provider of this.providers) {
      if (typeof provider.clearCache !== 'function') {
        continue;
      }

      if (projectRoots && projectRoots.length > 0) {
        for (const projectRoot of projectRoots) {
          provider.clearCache(projectRoot);
        }
        continue;
      }

      provider.clearCache();
    }
  }

  /**
   * Run component dependency analysis for a single endpoint.
   * Call this on-demand (e.g. when opening the flow diagram) instead of during bulk discovery
   * when `skipComponentAnalysis: true` was used.
   */
  public enrichEndpoint(endpoint: ApiEndpoint, contextProperties?: string[]): void {
    this.enrichEndpointParametersFromComponents(endpoint, contextProperties);
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const startedAt = Date.now();
    const forceProviderAnalysis = Boolean(context.customSeedLoaderModulePath?.trim());
    const projectRoots = context.includeProjectRoots?.length
      ? context.includeProjectRoots
      : [context.workspaceFolder];

    const merged: DiscoveryResult = {
      endpoints: [],
      warnings: [],
      stats: {
        frameworksDetected: [],
        providersRun: [],
        endpointCount: 0,
        unresolvedEndpointCount: 0,
        scanDurationMs: 0
      }
    };
    let parameterCacheReusedEndpoints = 0;
    let parameterCacheRecomputedEndpoints = 0;
    let parameterTraversalTruncatedEndpoints = 0;

    for (const projectRoot of projectRoots) {
      const fingerprint = this.detector.buildFingerprint(projectRoot);
      // Pre-collect source files once for this project root and share across all providers.
      fingerprint.sourceFiles = collectSourceFiles(projectRoot);

      const frameworks = context.frameworksByProjectRoot?.[projectRoot]
        ?? this.detector.detectFrameworks(fingerprint);
      merged.stats.frameworksDetected.push(...frameworks);

      // Collect eligible providers and run them in parallel.
      const eligibleProviders = this.providers.filter(provider => {
        const providerFramework = this.providerFramework(provider.id);
        const frameworkMatch = providerFramework === 'unknown'
          || frameworks.includes('unknown')
          || frameworks.includes(providerFramework);
        if (!frameworkMatch) return false;
        const support = provider.supports(fingerprint);
        return support.supported || forceProviderAnalysis;
      });

      merged.stats.providersRun.push(...eligibleProviders.map(p => p.id));

      const providerResults = await Promise.all(
        eligibleProviders.map(async (provider) => {
          try {
            return await provider.discover(context, fingerprint);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const framework = this.providerFramework(provider.id);
            return {
              endpoints: [] as DiscoveryResult['endpoints'],
              warnings: [{ code: 'provider-failed' as const, framework, message: `Provider ${provider.id} failed: ${message}` }],
              stats: { frameworksDetected: [], providersRun: [], endpointCount: 0, unresolvedEndpointCount: 0, scanDurationMs: 0 }
            };
          }
        })
      );

      for (const result of providerResults) {
        for (const ep of result.endpoints) {
          if (!ep.projectRoot) ep.projectRoot = projectRoot;
        }
        merged.endpoints.push(...result.endpoints);
        merged.warnings.push(...result.warnings);
      }

      const seed = loadHybridSeedEndpoints(projectRoot, context);
      console.log('[discovery-engine] loadHybridSeedEndpoints returned', seed.endpoints.length, 'endpoints and', seed.warnings.length, 'warnings');
      merged.warnings.push(...seed.warnings);
      for (const seedEndpoint of seed.endpoints) {
        if (!seedEndpoint.projectRoot) seedEndpoint.projectRoot = projectRoot;
        const matched = merged.endpoints.find((autoEndpoint) => this.endpointKey(autoEndpoint) === this.endpointKey(seedEndpoint));
        if (!matched) {
          merged.endpoints.push(seedEndpoint);
          merged.warnings.push({
            code: 'seed-endpoint-unmatched',
            framework: seedEndpoint.framework,
            filePath: seedEndpoint.handlerLocation.filePath,
            message: `Seed endpoint ${seedEndpoint.method} ${seedEndpoint.pathExpression} was not matched by auto-discovery and was kept as seed.`
          });
          continue;
        }

        this.mergeSeedIntoEndpoint(matched, seedEndpoint);
      }
    }

    // Always extract path parameters from the route pattern (cheap — regex only, no file I/O).
    for (const endpoint of merged.endpoints) {
      enrichEndpointPathParameters(endpoint);
    }

    // Component analysis: BFS dependency traversal + TS parse per file.
    // Skip when skipComponentAnalysis is set — callers use enrichEndpoint() on demand.
    if (!context.skipComponentAnalysis) {
      for (const endpoint of merged.endpoints) {
        const enrichment = this.enrichEndpointParametersFromComponents(endpoint, context.contextProperties);
        if (enrichment.reused) {
          parameterCacheReusedEndpoints += 1;
        } else {
          parameterCacheRecomputedEndpoints += 1;
        }

        if (enrichment.truncated) {
          parameterTraversalTruncatedEndpoints += 1;
          merged.warnings.push({
            code: 'component-dependency-limit-reached',
            framework: endpoint.framework,
            filePath: endpoint.handlerLocation.filePath,
            message: `Parameter discovery stopped early for ${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression} after scanning ${COMPONENT_DEPENDENCY_MAX_FILES} dependent files. Some inferred parameters may be missing.`
          });
        }
      }
    }

    merged.stats.frameworksDetected = Array.from(new Set(merged.stats.frameworksDetected));
    merged.stats.providersRun = Array.from(new Set(merged.stats.providersRun));
    merged.stats.endpointCount = merged.endpoints.length;
    merged.stats.unresolvedEndpointCount = merged.endpoints.filter((endpoint) => !endpoint.resolvedPath).length;
    merged.stats.parameterCacheReusedEndpoints = parameterCacheReusedEndpoints;
    merged.stats.parameterCacheRecomputedEndpoints = parameterCacheRecomputedEndpoints;
    merged.stats.parameterTraversalTruncatedEndpoints = parameterTraversalTruncatedEndpoints;
    merged.stats.scanDurationMs = Date.now() - startedAt;
    return merged;
  }

  private providerFramework(providerId: string): 'express' | 'nestjs' | 'fastify' | 'lambda' | 'unknown' {
    if (providerId.includes('express')) {
      return 'express';
    }
    if (providerId.includes('nestjs')) {
      return 'nestjs';
    }
    if (providerId.includes('fastify')) {
      return 'fastify';
    }
    if (providerId.includes('lambda')) {
      return 'lambda';
    }
    return 'unknown';
  }

  private endpointKey(endpoint: { method: string; resolvedPath?: string; pathExpression: string }): string {
    const resolvedPath = endpoint.resolvedPath ?? endpoint.pathExpression;
    return `${endpoint.method.toUpperCase()}::${resolvedPath}`;
  }

  private mergeSeedIntoEndpoint(target: DiscoveryResult['endpoints'][number], seed: DiscoveryResult['endpoints'][number]): void {
    target.description = target.description ?? seed.description;

    if (!target.handlerLocation?.filePath && seed.handlerLocation?.filePath) {
      target.handlerLocation = seed.handlerLocation;
    }

    if (!target.middleware || target.middleware.length === 0) {
      target.middleware = seed.middleware;
      return;
    }

    const existing = new Set(target.middleware.map((item) => item.name));
    for (const middleware of seed.middleware) {
      if (!existing.has(middleware.name)) {
        target.middleware.push(middleware);
      }
    }
  }

  private enrichEndpointParametersFromComponents(endpoint: ApiEndpoint, contextProperties: string[] = ['locals']): { reused: boolean; truncated: boolean } {
    const byKey = new Map<string, ApiParameter>();
    for (const parameter of endpoint.parameters ?? []) {
      byKey.set(parameterKey(parameter.location, parameter.name), parameter);
    }

    const files = new Set<string>();
    if (endpoint.handlerLocation?.filePath) {
      files.add(endpoint.handlerLocation.filePath);
    }
    for (const middleware of endpoint.middleware ?? []) {
      if (middleware.location?.filePath) {
        files.add(middleware.location.filePath);
      }
    }

    const cacheKey = this.endpointParameterCacheKey(endpoint);
    const expanded = this.componentDependencyGraph.collectDependencyFiles(files);
    const expandedFiles = expanded.files;
    const expandedFilesList = Array.from(expandedFiles).sort();

    const cachedComponentFiles = this.endpointComponentFilesCache.get(cacheKey) ?? [];
    const cachedParameters = this.endpointParameterCache.get(cacheKey);
    const canReuseCache = expanded.changedFiles.size === 0
      && !!cachedParameters
      && arrayEquals(cachedComponentFiles, expandedFilesList);

    if (canReuseCache && cachedParameters) {
      for (const parameter of cachedParameters) {
        const key = parameterKey(parameter.location, parameter.name);
        const existing = byKey.get(key);
        if (existing) {
          mergeParameterEvidence(existing, parameter);
          continue;
        }
        byKey.set(key, cloneApiParameter(parameter));
      }

      endpoint.parameters = Array.from(byKey.values());
      return { reused: true, truncated: expanded.truncated };
    }

    for (const filePath of expandedFiles) {
      const parameters = this.componentDependencyGraph.getParameters(filePath, contextProperties);
      for (const parameter of parameters) {
        const key = parameterKey(parameter.location, parameter.name);
        const existing = byKey.get(key);
        if (existing) {
          mergeParameterEvidence(existing, parameter);
          continue;
        }

        byKey.set(key, cloneApiParameter(parameter));
      }
    }

    const mergedParameters = Array.from(byKey.values());
    endpoint.parameters = mergedParameters;
    this.endpointComponentFilesCache.set(cacheKey, expandedFilesList);
    this.endpointParameterCache.set(cacheKey, mergedParameters.map((parameter) => cloneApiParameter(parameter)));
    return { reused: false, truncated: expanded.truncated };
  }

  private endpointParameterCacheKey(endpoint: ApiEndpoint): string {
    const resolvedPath = endpoint.resolvedPath ?? endpoint.pathExpression;
    const handlerPath = normalizeFilePath(endpoint.handlerLocation?.filePath ?? 'unknown-handler');
    return `${endpoint.framework}:${endpoint.method.toUpperCase()}:${resolvedPath}:${handlerPath}`;
  }

  private invalidateEndpointParameterCache(projectRoots?: string[]): void {
    if (!projectRoots || projectRoots.length === 0) {
      this.endpointParameterCache.clear();
      this.endpointComponentFilesCache.clear();
      return;
    }

    const normalizedRoots = projectRoots.map((root) => normalizeFilePath(root));
    for (const [cacheKey, files] of Array.from(this.endpointComponentFilesCache.entries())) {
      const shouldRemove = files.some((filePath) =>
        normalizedRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`))
      );
      if (!shouldRemove) {
        continue;
      }
      this.endpointComponentFilesCache.delete(cacheKey);
      this.endpointParameterCache.delete(cacheKey);
    }
  }
}

function enrichEndpointPathParameters(endpoint: ApiEndpoint): void {
  const routePattern = endpoint.resolvedPath ?? endpoint.pathExpression;
  if (!routePattern) {
    return;
  }

  const existing = new Set<string>();
  for (const parameter of endpoint.parameters ?? []) {
    existing.add(parameterKey(parameter.location, parameter.name));
  }

  const fromRoute = extractPathParameters(routePattern);
  if (fromRoute.length === 0) {
    return;
  }

  const additions: ApiParameter[] = [];
  for (const parameter of fromRoute) {
    const key = parameterKey(parameter.location, parameter.name);
    if (existing.has(key)) {
      continue;
    }

    existing.add(key);
    additions.push(parameter);
  }

  if (additions.length > 0) {
    endpoint.parameters = [...(endpoint.parameters ?? []), ...additions];
  }
}

function extractParametersFromComponentSource(content: string, filePath: string, contextProperties: string[] = ['locals']): ApiParameter[] {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const byKey = new Map<string, ApiParameter>();

  const mergeParameter = (parameter: ApiParameter): void => {
    const key = parameterKey(parameter.location, parameter.name);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cloneApiParameter(parameter));
      return;
    }

    mergeParameterEvidence(existing, parameter);
    if (!existing.type && parameter.type) {
      existing.type = parameter.type;
    }
    if (parameter.required && !existing.required) {
      existing.required = true;
    }
  };

  const processMetadata = (methodLikeNode: ts.Node): void => {
    const metadata = analyzeHandlerMetadata(methodLikeNode, source, filePath, 'GET', undefined, undefined, normalizeContextProperties(contextProperties));

    for (const parameter of metadata.parameters) {
      mergeParameter(parameter);
    }

    for (const cookie of metadata.cookies) {
      if (cookie.type !== 'request') {
        continue;
      }

      mergeParameter({
        name: cookie.name,
        location: 'cookie',
        type: 'string',
        required: false,
        detectionLocation: cookie.detectionLocation ? { ...cookie.detectionLocation } : undefined,
        evidenceLocations: cookie.detectionLocation ? [{ ...cookie.detectionLocation }] : undefined,
        description: `Inferred from ${filePath}`
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      processMetadata(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  return Array.from(byKey.values());
}

function extractDependencySpecifiers(content: string): string[] {
  const specs = new Set<string>();
  const add = (value?: string): void => {
    if (!value) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    specs.add(trimmed);
  };

  const importExportPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const requirePattern = /require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  const dynamicImportPattern = /import\(\s*['"]([^'"\n]+)['"]\s*\)/g;

  for (const match of content.matchAll(importExportPattern)) {
    add(match[1]);
  }
  for (const match of content.matchAll(requirePattern)) {
    add(match[1]);
  }
  for (const match of content.matchAll(dynamicImportPattern)) {
    add(match[1]);
  }

  return Array.from(specs);
}

function resolveDependencyFile(specifier: string, fromFile: string): string | undefined {
  if (!specifier) {
    return undefined;
  }

  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) {
    return undefined;
  }

  return resolveLocalModule(specifier, path.dirname(fromFile));
}

/**
 * Module-level cache for resolved local module paths.
 * Key: `fromDir\0specifier` → resolved absolute path (or empty string = not found).
 * Entries that belong to a changed file are cleared in `invalidateResolutionCache`.
 */
const resolutionCache = new Map<string, string>();

function invalidateResolutionCache(projectRoots?: string[]): void {
  if (!projectRoots || projectRoots.length === 0) {
    resolutionCache.clear();
    return;
  }
  const normalizedRoots = projectRoots.map(r => normalizeFilePath(r));
  for (const key of resolutionCache.keys()) {
    const dir = key.split('\x00')[0];
    if (normalizedRoots.some(root => dir === root || dir.startsWith(`${root}/`))) {
      resolutionCache.delete(key);
    }
  }
}

function resolveLocalModule(specifierOrPath: string, fromDir: string): string | undefined {
  const cacheKey = `${fromDir}\x00${specifierOrPath}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached !== undefined) {
    return cached || undefined; // empty string = negative cache
  }

  const candidate = path.isAbsolute(specifierOrPath)
    ? specifierOrPath
    : path.resolve(fromDir, specifierOrPath);

  const ext = path.extname(candidate);
  // Prefer TypeScript sources first, then JavaScript, then index files
  const candidates = ext
    ? [candidate]
    : [
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.js`,
        `${candidate}.jsx`,
        `${candidate}.mts`,
        `${candidate}.cts`,
        `${candidate}.mjs`,
        `${candidate}.cjs`,
        candidate,
        path.join(candidate, 'index.ts'),
        path.join(candidate, 'index.tsx'),
        path.join(candidate, 'index.js'),
        path.join(candidate, 'index.jsx'),
        path.join(candidate, 'index.mts'),
        path.join(candidate, 'index.cts'),
        path.join(candidate, 'index.mjs'),
        path.join(candidate, 'index.cjs')
      ];

  for (const option of candidates) {
    try {
      const stat = fs.statSync(option);
      if (stat.isFile()) {
        resolutionCache.set(cacheKey, option);
        return option;
      }
    } catch {
      continue;
    }
  }

  resolutionCache.set(cacheKey, ''); // negative cache
  return undefined;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function cloneApiParameter(parameter: ApiParameter): ApiParameter {
  return {
    ...parameter,
    detectionLocation: parameter.detectionLocation
      ? { ...parameter.detectionLocation }
      : undefined,
    evidenceLocations: parameter.evidenceLocations
      ? parameter.evidenceLocations.map((location) => ({ ...location }))
      : undefined,
    conflictingTypes: parameter.conflictingTypes
      ? [...parameter.conflictingTypes]
      : undefined
  };
}

function mergeParameterEvidence(target: ApiParameter, incoming: ApiParameter): void {
  if (!target.detectionLocation && incoming.detectionLocation) {
    target.detectionLocation = { ...incoming.detectionLocation };
  }

  for (const location of incoming.evidenceLocations ?? []) {
    appendEvidenceLocation(target, { ...location });
  }

  if (!target.evidenceLocations && incoming.detectionLocation) {
    appendEvidenceLocation(target, { ...incoming.detectionLocation });
  }

  if (!target.description && incoming.description) {
    target.description = incoming.description;
  }
}

function arrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function appendEvidenceLocation(parameter: ApiParameter, location: SourceLocation): void {
  const existing = parameter.evidenceLocations ?? [];
  const key = `${location.filePath}:${location.line}:${location.accessMode ?? ''}`;
  const seen = new Set(existing.map((item) => `${item.filePath}:${item.line}:${item.accessMode ?? ''}`));

  if (!seen.has(key)) {
    existing.push(location);
    parameter.evidenceLocations = existing;
  }

  if (!parameter.detectionLocation) {
    parameter.detectionLocation = location;
  }
}

function parameterKey(location: ParameterLocation, name: string): string {
  return `${location}:${name.toLowerCase()}`;
}

function normalizeContextProperties(values: string[] | undefined): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : ['locals'];
}
