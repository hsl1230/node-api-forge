import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createResolutionContext, joinPaths, toPathValue } from './path-utils';

describe('path-utils', () => {
  it('resolves string literals as high confidence paths', () => {
    const source = ts.createSourceFile('sample.ts', "app.get('/users', handler)", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const call = source.statements[0];
    if (!ts.isExpressionStatement(call) || !ts.isCallExpression(call.expression)) {
      throw new Error('expected call expression');
    }

    const value = toPathValue(call.expression.arguments[0], source);
    expect(value.pathExpression).toBe('/users');
    expect(value.resolvedPath).toBe('/users');
    expect(value.confidence).toBe('high');
  });

  it('keeps dynamic paths unresolved', () => {
    const source = ts.createSourceFile('sample.ts', 'app.use(apiPrefix, router)', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const call = source.statements[0];
    if (!ts.isExpressionStatement(call) || !ts.isCallExpression(call.expression)) {
      throw new Error('expected call expression');
    }

    const value = toPathValue(call.expression.arguments[0], source);
    expect(value.pathExpression).toBe('apiPrefix');
    expect(value.resolvedPath).toBeUndefined();
    expect(value.confidence).toBe('low');
  });

  it('joins static prefixes and routes', () => {
    const joined = joinPaths('/api', '/users');
    expect(joined.pathExpression).toBe('/api/users');
    expect(joined.resolvedPath).toBe('/api/users');
  });

  it('resolves local constants and env overrides', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-api-forge-path-'));
    try {
      fs.writeFileSync(path.join(root, '.env'), 'API_PREFIX=/api/v2\n');
      const source = ts.createSourceFile(
        'sample.ts',
        `const apiPrefix = process.env.API_PREFIX || '/api';\nconst routeBase = '/users';\napp.use(apiPrefix, router);\napp.get(routeBase, handler);`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const resolutionContext = createResolutionContext(source, root, { API_PREFIX: '/api/v3' });

      const declarations = source.statements.filter(ts.isVariableStatement);
      const apiPrefixDecl = declarations[0].declarationList.declarations[0].initializer as ts.Expression;
      const routeBaseDecl = declarations[1].declarationList.declarations[0].initializer as ts.Expression;

      const apiPrefixValue = toPathValue(apiPrefixDecl, source, resolutionContext);
      const routeBaseValue = toPathValue(routeBaseDecl, source, resolutionContext);

      expect(apiPrefixValue.resolvedPath).toBe('/api/v3');
      expect(routeBaseValue.resolvedPath).toBe('/users');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
