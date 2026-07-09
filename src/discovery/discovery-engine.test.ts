import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiDiscoveryEngine } from './discovery-engine';
import { ApiDiscoveryProvider, ProviderSupport } from './provider';
import { DiscoveryContext, DiscoveryResult, FrameworkFingerprint } from './types';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('ApiDiscoveryEngine custom seed loader', () => {
  it('invalidates provider cache for the provided project root', () => {
    const provider = new CountingProvider('provider.express');
    const engine = new ApiDiscoveryEngine([provider]);

    engine.invalidateCaches(['/tmp/project-a']);

    expect(provider.clearedRoots).toEqual(['/tmp/project-a']);
  });

  it('runs only providers matching configured frameworks for a project root', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0', '@nestjs/common': '^10.0.0' } });
    const expressProvider = new CountingProvider('provider.express');
    const nestProvider = new CountingProvider('provider.nestjs');
    const engine = new ApiDiscoveryEngine([expressProvider, nestProvider]);

    const result = await engine.discover({
      workspaceFolder: root,
      frameworksByProjectRoot: {
        [root]: ['express']
      }
    });

    expect(expressProvider.calls).toBe(1);
    expect(nestProvider.calls).toBe(0);
    expect(result.stats.providersRun).toEqual(['provider.express']);
  });

  it('loads no seed endpoints when no custom loader is configured', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    const engine = new ApiDiscoveryEngine([new MockProvider(emptyResult())]);
    const result = await engine.discover({ workspaceFolder: root });
    expect(result.endpoints).toHaveLength(0);
    expect(result.warnings.some((item) => item.code === 'seed-loader-failed')).toBe(false);
  });

  it('emits seed-loader-failed warning when custom loader module is missing', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    const engine = new ApiDiscoveryEngine([new MockProvider(emptyResult())]);
    const result = await engine.discover({
      workspaceFolder: root,
      customSeedLoaderModulePath: 'does-not-exist.js'
    });
    expect(result.warnings.some((item) => item.code === 'seed-loader-failed')).toBe(true);
  });

  it('loads endpoints returned by a custom loader module', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    fs.writeFileSync(
      path.join(root, 'seed-loader.js'),
      [
        'exports.loadSeedManifestEndpoints = function(projectRoot) {',
        '  return {',
        '    endpoints: [{',
        "      method: 'GET', framework: 'express',",
        "      pathExpression: '/from-loader', resolvedPath: '/from-loader',",
        "      confidence: 'high',",
        '      handlerLocation: { filePath: projectRoot + "/src/app.ts", line: 1 },',
        '      middleware: []',
        '    }],',
        '    warnings: []',
        '  };',
        '};'
      ].join('\n')
    );

    const engine = new ApiDiscoveryEngine([new MockProvider(emptyResult())]);
    const result = await engine.discover({
      workspaceFolder: root,
      customSeedLoaderModulePath: 'seed-loader.js'
    });

    expect(result.endpoints.some((e) => (e.resolvedPath ?? e.pathExpression) === '/from-loader')).toBe(true);
  });

  it('merges custom loader endpoints with auto-discovered endpoints', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    fs.writeFileSync(
      path.join(root, 'seed-loader.js'),
      [
        'exports.loadSeedManifestEndpoints = function(projectRoot) {',
        '  return {',
        '    endpoints: [{',
        "      method: 'GET', framework: 'express',",
        "      pathExpression: '/health', resolvedPath: '/health',",
        "      confidence: 'medium',",
        '      handlerLocation: { filePath: projectRoot + "/src/app.ts", line: 1 },',
        "      middleware: [{ name: 'seedAuth' }],",
        "      description: 'seeded description'",
        '    }],',
        '    warnings: []',
        '  };',
        '};'
      ].join('\n')
    );

    const provider = new MockProvider({
      endpoints: [{
        method: 'GET', framework: 'express',
        pathExpression: '/health', resolvedPath: '/health',
        confidence: 'high',
        handlerLocation: { filePath: path.join(root, 'src', 'app.ts'), line: 1 },
        middleware: [{ name: 'autoAuth' }]
      }],
      warnings: [],
      stats: { frameworksDetected: ['express'], providersRun: ['provider.mock'], endpointCount: 1, unresolvedEndpointCount: 0, scanDurationMs: 1 }
    });

    const engine = new ApiDiscoveryEngine([provider]);
    const result = await engine.discover({ workspaceFolder: root, customSeedLoaderModulePath: 'seed-loader.js' });

    const endpoint = result.endpoints.find((e) => (e.resolvedPath ?? e.pathExpression) === '/health');
    expect(endpoint).toBeDefined();
    expect(endpoint?.description).toBe('seeded description');
    expect(endpoint?.middleware.some((m) => m.name === 'autoAuth')).toBe(true);
    expect(endpoint?.middleware.some((m) => m.name === 'seedAuth')).toBe(true);
  });

  it('keeps unmatched seed endpoints and emits seed-endpoint-unmatched warning', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    fs.writeFileSync(
      path.join(root, 'seed-loader.js'),
      [
        'exports.loadSeedManifestEndpoints = function(projectRoot) {',
        '  return {',
        '    endpoints: [{',
        "      method: 'POST', framework: 'express',",
        "      pathExpression: '/seed-only', resolvedPath: '/seed-only',",
        "      confidence: 'medium',",
        '      handlerLocation: { filePath: projectRoot + "/src/seed.ts", line: 5 },',
        '      middleware: []',
        '    }],',
        '    warnings: []',
        '  };',
        '};'
      ].join('\n')
    );

    const engine = new ApiDiscoveryEngine([new MockProvider(emptyResult())]);
    const result = await engine.discover({ workspaceFolder: root, customSeedLoaderModulePath: 'seed-loader.js' });

    expect(result.endpoints.some((e) => (e.resolvedPath ?? e.pathExpression) === '/seed-only')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'seed-endpoint-unmatched')).toBe(true);
  });

  it('extracts query params from deeper imported helper files', async () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      [
        "import { handle } from './handler';",
        '',
        'export function route(req, res) {',
        '  return handle(req, res);',
        '}'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(root, 'src', 'handler.ts'),
      [
        "import { parse } from './query-utils';",
        '',
        'export function handle(req, res) {',
        '  parse(req);',
        "  return res.json({ ok: true });",
        '}'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(root, 'src', 'query-utils.ts'),
      [
        'export function parse(req) {',
        '  const traceId = req.query.traceId;',
        '  return traceId;',
        '}'
      ].join('\n')
    );

    const provider = new MockProvider({
      endpoints: [{
        method: 'GET',
        framework: 'express',
        pathExpression: '/status',
        resolvedPath: '/status',
        confidence: 'high',
        handlerLocation: { filePath: path.join(root, 'src', 'app.ts'), line: 1 },
        middleware: []
      }],
      warnings: [],
      stats: { frameworksDetected: ['express'], providersRun: ['provider.mock'], endpointCount: 1, unresolvedEndpointCount: 0, scanDurationMs: 1 }
    });

    const engine = new ApiDiscoveryEngine([provider]);
    const result = await engine.discover({ workspaceFolder: root });
    const endpoint = result.endpoints.find((e) => (e.resolvedPath ?? e.pathExpression) === '/status');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'traceId')).toBe(true);
  });
});

class MockProvider implements ApiDiscoveryProvider {
  public readonly id = 'provider.mock';

  constructor(private readonly result: DiscoveryResult) {}

  supports(_fingerprint: FrameworkFingerprint): ProviderSupport {
    return { supported: true, confidence: 1, reasons: ['test provider'] };
  }

  async discover(_context: DiscoveryContext, _fingerprint: FrameworkFingerprint): Promise<DiscoveryResult> {
    return this.result;
  }
}

class CountingProvider implements ApiDiscoveryProvider {
  public calls = 0;
  public clearedRoots: Array<string | undefined> = [];

  constructor(public readonly id: string) {}

  supports(_fingerprint: FrameworkFingerprint): ProviderSupport {
    return { supported: true, confidence: 1, reasons: ['test provider'] };
  }

  async discover(_context: DiscoveryContext, _fingerprint: FrameworkFingerprint): Promise<DiscoveryResult> {
    this.calls += 1;
    return emptyResult();
  }

  clearCache(projectRoot?: string): void {
    this.clearedRoots.push(projectRoot);
  }
}

function emptyResult(): DiscoveryResult {
  return {
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
}

function makeProject(packageJson: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-api-forge-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const ok = true;\n');
  return root;
}
