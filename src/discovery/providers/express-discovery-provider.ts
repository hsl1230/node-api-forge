import * as fs from 'fs';
import { ExpressComponentAnalyzer } from '../analyzer';
import { ApiDiscoveryProvider, ProviderSupport } from '../provider';
import { collectSourceFiles } from '../source-files';
import { ApiEndpoint, DiscoveryContext, DiscoveryResult, DiscoveryWarning, FrameworkFingerprint } from '../types';

interface CachedExpressFileAnalysis {
  mtimeMs: number;
  size: number;
  endpoints: ApiEndpoint[];
  warnings: DiscoveryWarning[];
}

export class ExpressDiscoveryProvider implements ApiDiscoveryProvider {
  public readonly id = 'provider.express';
  private analyzer = new ExpressComponentAnalyzer();
  private readonly fileCache = new Map<string, CachedExpressFileAnalysis>();
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
    if (deps.express) {
      return { supported: true, confidence: 0.95, reasons: ['express dependency detected'] };
    }
    return { supported: false, confidence: 0, reasons: ['express dependency not found'] };
  }

  public async discover(_context: DiscoveryContext, fingerprint: FrameworkFingerprint): Promise<DiscoveryResult> {
    const startedAt = Date.now();
    const warnings: DiscoveryResult['warnings'] = [];
    const endpoints: ApiEndpoint[] = [];
    const files = collectSourceFiles(fingerprint.projectRoot);

    this.pruneDeletedFiles(fingerprint.projectRoot, files);

    for (const filePath of files) {
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

      const fileEndpoints = await this.analyzer.analyzeFile(filePath, content, fingerprint, _context);
      const fileWarnings = buildExpressWarnings(fileEndpoints);
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
        frameworksDetected: ['express'],
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

function buildExpressWarnings(endpoints: ApiEndpoint[]): DiscoveryWarning[] {
  const warnings: DiscoveryWarning[] = [];

  for (const endpoint of endpoints) {
    if (!endpoint.resolvedPath) {
      warnings.push({
        code: 'dynamic-path-unresolved',
        framework: 'express',
        filePath: endpoint.handlerLocation.filePath,
        message: `Express route path unresolved for ${endpoint.method} ${endpoint.pathExpression}`
      });
    }

    for (const parameter of endpoint.parameters ?? []) {
      if (!parameter.conflictingTypes || parameter.conflictingTypes.length < 2) {
        continue;
      }

      const evidenceFile = parameter.detectionLocation?.filePath ?? parameter.evidenceLocations?.[0]?.filePath;
      warnings.push({
        code: 'parameter-type-conflict',
        framework: 'express',
        filePath: evidenceFile,
        message: `Conflicting inferred types for ${parameter.location} parameter '${parameter.name}' on ${endpoint.method} ${endpoint.pathExpression}: ${parameter.conflictingTypes.join(', ')}`
      });
    }
  }

  return warnings;
}
