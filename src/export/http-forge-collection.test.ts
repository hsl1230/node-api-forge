import { describe, expect, it } from 'vitest';
import { DiscoveryResult } from '../discovery/types';
import { buildHttpForgeCollection, serializeHttpForgeCollection } from './http-forge-collection';

const sampleResult: DiscoveryResult = {
  endpoints: [
    {
      framework: 'express',
      method: 'GET',
      pathExpression: '/users',
      resolvedPath: '/users',
      confidence: 'high',
      handlerLocation: { filePath: '/workspace/users.ts', line: 12 },
      middleware: []
    },
    {
      framework: 'nestjs',
      method: 'POST',
      pathExpression: '/api/v1/orders/:orderId',
      resolvedPath: '/api/v1/orders/:orderId',
      confidence: 'medium',
      handlerLocation: { filePath: '/workspace/orders.controller.ts', line: 42 },
      middleware: [{ name: 'AuthGuard' }]
    }
  ],
  warnings: [],
  stats: {
    frameworksDetected: ['express', 'nestjs'],
    providersRun: ['express-discovery', 'nestjs-discovery'],
    endpointCount: 2,
    unresolvedEndpointCount: 0,
    scanDurationMs: 10
  }
};

describe('buildHttpForgeCollection', () => {
  it('groups endpoints by project and framework and preserves resolved URLs', () => {
    const collection = buildHttpForgeCollection(sampleResult, {
      collectionName: 'Discovered APIs',
      baseUrl: 'http://localhost:8080',
      projectRoots: ['/workspace']
    });

    expect(collection.name).toBe('Discovered APIs');
    expect(collection.variables.BASE_URL).toBe('http://localhost:8080');
    expect(collection.items).toHaveLength(1);
    expect(collection.items[0].type).toBe('folder');

    const projectFolder = collection.items[0];
    if (projectFolder.type !== 'folder') {
      throw new Error('Expected project folder');
    }
    expect(projectFolder.name).toBe('workspace');
    expect(projectFolder.items).toHaveLength(2);

    const expressFolder = projectFolder.items[0];
    if (expressFolder.type !== 'folder') {
      throw new Error('Expected express framework folder');
    }
    expect(expressFolder.name).toBe('EXPRESS');
    expect(expressFolder.items[0].type).toBe('request');
    if (expressFolder.items[0].type !== 'request') {
      throw new Error('Expected request item');
    }
    expect(expressFolder.items[0].url).toBe('{{BASE_URL}}/users');

    const nestFolder = projectFolder.items[1];
    if (nestFolder.type !== 'folder') {
      throw new Error('Expected nest folder');
    }

    expect(nestFolder.items[0].type).toBe('request');
    if (nestFolder.items[0].type !== 'request') {
      throw new Error('Expected nest request item');
    }
    expect(nestFolder.items[0].url).toBe('{{BASE_URL}}/api/v1/orders/{{orderId}}');
    expect(nestFolder.items[0].headers.some((header) => header.key === 'Content-Type')).toBe(true);
    expect(nestFolder.items[0].body?.type).toBe('raw');
    expect(nestFolder.items[0].body?.format).toBe('json');
    expect(nestFolder.items[0].body?.content).toContain('Sample orders payload');
  });

  it('serializes to JSON that can be imported by HTTP Forge', () => {
    const serialized = serializeHttpForgeCollection(sampleResult);

    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).toContain('Node API Forge Discovery');
    expect(serialized).toContain('BASE_URL');
  });
});