import * as fs from 'fs';
import { extractPathParameters } from './analyzer';
import { FrameworkDetector } from './framework-detector';
import { ApiDiscoveryProvider } from './provider';
import { loadHybridSeedEndpoints } from './seed-loader';
import { ApiEndpoint, ApiParameter, DiscoveryContext, DiscoveryResult, ParameterLocation, SourceLocation } from './types';

export class ApiDiscoveryEngine {
  private readonly detector: FrameworkDetector;
  private readonly providers: ApiDiscoveryProvider[];

  constructor(providers: ApiDiscoveryProvider[], detector = new FrameworkDetector()) {
    this.providers = providers;
    this.detector = detector;
  }

  public invalidateCaches(projectRoots?: string[]): void {
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

    for (const projectRoot of projectRoots) {
      const fingerprint = this.detector.buildFingerprint(projectRoot);
      const frameworks = context.frameworksByProjectRoot?.[projectRoot]
        ?? this.detector.detectFrameworks(fingerprint);
      merged.stats.frameworksDetected.push(...frameworks);

      for (const provider of this.providers) {
        const providerFramework = this.providerFramework(provider.id);
        const shouldRunProvider = providerFramework === 'unknown'
          || frameworks.includes('unknown')
          || frameworks.includes(providerFramework);
        if (!shouldRunProvider) {
          continue;
        }

        const support = provider.supports(fingerprint);
        if (!support.supported && !forceProviderAnalysis) {
          continue;
        }

        merged.stats.providersRun.push(provider.id);
        try {
          const result = await provider.discover(context, fingerprint);
          merged.endpoints.push(...result.endpoints);
          merged.warnings.push(...result.warnings);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          merged.warnings.push({
            code: 'provider-failed',
            framework: providerFramework,
            message: `Provider ${provider.id} failed: ${message}`
          });
        }
      }

      const seed = loadHybridSeedEndpoints(projectRoot, context);
      console.log('[discovery-engine] loadHybridSeedEndpoints returned', seed.endpoints.length, 'endpoints and', seed.warnings.length, 'warnings');
      merged.warnings.push(...seed.warnings);
      for (const seedEndpoint of seed.endpoints) {
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

    for (const endpoint of merged.endpoints) {
      enrichEndpointPathParameters(endpoint);
      enrichEndpointParametersFromComponents(endpoint);
    }

    merged.stats.frameworksDetected = Array.from(new Set(merged.stats.frameworksDetected));
    merged.stats.providersRun = Array.from(new Set(merged.stats.providersRun));
    merged.stats.endpointCount = merged.endpoints.length;
    merged.stats.unresolvedEndpointCount = merged.endpoints.filter((endpoint) => !endpoint.resolvedPath).length;
    merged.stats.scanDurationMs = Date.now() - startedAt;
    return merged;
  }

  private providerFramework(providerId: string): 'express' | 'nestjs' | 'fastify' | 'unknown' {
    if (providerId.includes('express')) {
      return 'express';
    }
    if (providerId.includes('nestjs')) {
      return 'nestjs';
    }
    if (providerId.includes('fastify')) {
      return 'fastify';
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

const PARAM_PATTERNS: Array<{ location: ParameterLocation; regex: RegExp; accessMode: 'read' | 'write' }> = [
  { location: 'query', regex: /req\.query\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g, accessMode: 'write' },
  { location: 'path', regex: /req\.params\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g, accessMode: 'write' },
  { location: 'body', regex: /req\.body\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g, accessMode: 'write' },
  { location: 'cookie', regex: /req\.cookies\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g, accessMode: 'write' },
  { location: 'header', regex: /req\.headers\.([A-Za-z_][A-Za-z0-9_-]*)\s*=(?!=)/g, accessMode: 'write' },
  { location: 'header', regex: /req\.headers\[['"`]([^'"`]+)['"`]\]\s*=(?!=)/g, accessMode: 'write' },
  { location: 'query', regex: /req\.query\.([A-Za-z_][A-Za-z0-9_]*)/g, accessMode: 'read' },
  { location: 'path', regex: /req\.params\.([A-Za-z_][A-Za-z0-9_]*)/g, accessMode: 'read' },
  { location: 'body', regex: /req\.body\.([A-Za-z_][A-Za-z0-9_]*)/g, accessMode: 'read' },
  { location: 'cookie', regex: /req\.cookies\.([A-Za-z_][A-Za-z0-9_]*)/g, accessMode: 'read' },
  { location: 'header', regex: /req\.headers\.([A-Za-z_][A-Za-z0-9_-]*)/g, accessMode: 'read' },
  { location: 'header', regex: /req\.headers\[['"`]([^'"`]+)['"`]\]/g, accessMode: 'read' },
  { location: 'header', regex: /req\.get\(['"`]([^'"`]+)['"`]\)/g, accessMode: 'read' },
  { location: 'header', regex: /req\.header\(['"`]([^'"`]+)['"`]\)/g, accessMode: 'read' }
];

function enrichEndpointParametersFromComponents(endpoint: ApiEndpoint): void {
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

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const pattern of PARAM_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const name = match[1];
        const key = parameterKey(pattern.location, name);
        const location: SourceLocation = {
          filePath,
          line: estimateLine(content, match.index),
          accessMode: pattern.accessMode
        };

        const existing = byKey.get(key);
        if (existing) {
          appendEvidenceLocation(existing, location);
          continue;
        }

        byKey.set(key, {
          name,
          location: pattern.location,
          type: 'string',
          required: false,
          description: `Inferred from ${filePath}`,
          detectionLocation: location,
          evidenceLocations: [location]
        });
      }
    }
  }

  endpoint.parameters = Array.from(byKey.values());
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

function estimateLine(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function parameterKey(location: ParameterLocation, name: string): string {
  return `${location}:${name.toLowerCase()}`;
}
