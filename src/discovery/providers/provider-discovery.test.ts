import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameworkDetector } from '../framework-detector';
import { ExpressDiscoveryProvider } from './express-discovery-provider';
import { FastifyDiscoveryProvider } from './fastify-discovery-provider';
import { NestDiscoveryProvider } from './nest-discovery-provider';

const detector = new FrameworkDetector();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('provider discovery', () => {
  it('discovers NestJS controller routes', async () => {
    const root = makeProject(
      { dependencies: { '@nestjs/common': '^10.0.0' } },
      `import { Controller, Get, Post, UseGuards } from '@nestjs/common';

@Controller('/users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get('/:id')
  findOne() {}

  @Post()
  create() {}
}
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new NestDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('GET /users/:id');
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('POST /users');
  });

  it('discovers Fastify direct routes', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();
fastify.get('/health', async function healthHandler() {});
fastify.post('/users', async function createUserHandler() {});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('GET /health');
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('POST /users');
  });

  it('discovers nested Fastify plugin prefixes', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.register(function (instance, opts, done) {
  instance.register(function child(childInstance, childOpts, childDone) {
    childInstance.get('/users', async function listUsersHandler() {});
    childDone();
  }, { prefix: '/v1' });
  done();
}, { prefix: '/api' });
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('GET /api/v1/users');
  });

  it('discovers basic Express routes', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();
app.get('/health', healthHandler);
app.post('/users', createUserHandler);
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('GET /health');
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('POST /users');
  });

  it('discovers nested Express mounted routers', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();
const apiRouter = express.Router();
const userRouter = express.Router();

userRouter.get('/users', listUsersHandler);
apiRouter.use('/v1', userRouter);
app.use('/api', apiRouter);
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.resolvedPath ?? endpoint.pathExpression}`)).toContain('GET /api/v1/users');
  });

  it('extracts nested metadata from Express middleware and handler aliases', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

function enrich(req, res, next) {
  const body = req.body;
  const { user } = body;
  const orderId = user.order['orderId'];
  const firstSku = req.body.items[0].sku;
  const page = req.query['page'];
  const id = req.params['id'];
  next();
}

app.post('/users/:id', enrich, function create(req, res) {
  const order = req.body.user.order;
  res.set('x-request-id', 'abc');
  res.json({ ok: true, order, orderId: req.body.user.order.orderId });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/users/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'id')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);

    const bodyUser = endpoint?.parameters?.find((item) => item.location === 'body' && item.name === 'user');
    const bodyOrder = endpoint?.parameters?.find((item) => item.location === 'body' && item.name === 'user.order');
    const bodyOrderId = endpoint?.parameters?.find((item) => item.location === 'body' && item.name === 'user.order.orderId');
    const bodySku = endpoint?.parameters?.find((item) => item.location === 'body' && item.name === 'items[].sku');

    expect(bodyUser).toBeDefined();
    expect(bodyOrder).toBeDefined();
    expect(bodyOrderId).toBeDefined();
    expect(bodySku).toBeDefined();
    expect(bodyUser?.type).toBe('object');
    expect(bodyOrder?.type).toBe('object');
  });

  it('extracts nested metadata from Fastify hooks and handler aliases', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.addHook('preHandler', function pre(req, reply, done) {
  const body = req.body;
  const { user } = body;
  const id = req.params['id'];
  const page = req.query['page'];
  user.order.orderId;
  done();
});

fastify.post('/orders/:id', function create(req, reply) {
  const sku = req.body.items[0].sku;
  reply.header('x-order-id', req.body.user.order.orderId);
  return { ok: true, sku };
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/orders/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'id')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user.order.orderId')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'items[].sku')).toBe(true);
  });

  it('prefers Fastify schema metadata over inferred usage for overlapping fields', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.post('/products/:id', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' }
      }
    },
    querystring: {
      type: 'object',
      properties: {
        page: { type: 'integer' }
      }
    },
    body: {
      type: 'object',
      required: ['user'],
      properties: {
        user: {
          type: 'object',
          properties: {
            order: {
              type: 'object',
              properties: {
                orderId: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  }
}, function create(req, reply) {
  req.params.id;
  req.query.page;
  req.body.user.order.orderId;
  return { ok: true };
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/products/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.find((item) => item.location === 'path' && item.name === 'id')?.type).toBe('integer');
    expect(endpoint?.parameters?.find((item) => item.location === 'query' && item.name === 'page')?.type).toBe('integer');
    expect(endpoint?.parameters?.find((item) => item.location === 'body' && item.name === 'user.order.orderId')?.type).toBe('integer');
    expect(endpoint?.requestBody?.type).toBe('json');
  });

  it('extracts metadata from Express imported middleware helpers', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const { enrich } = require('./helpers');
const app = express();

app.post('/users/:id', enrich, function create(req, res) {
  res.json({ ok: true });
});
`,
      {
        'helpers.ts': `export function enrich(req, res, next) {
  const page = req.query['page'];
  const orderId = req.body.user.order.orderId;
  next();
}
`
      }
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/users/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user.order.orderId')).toBe(true);
  });

  it('extracts metadata from Fastify imported preHandler helpers', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();
const { enrich } = require('./hooks');

fastify.post('/orders/:id', { preHandler: enrich }, function create(req, reply) {
  return { ok: true };
});
`,
      {
        'hooks.ts': `export const enrich = (req, reply, done) => {
  req.query['page'];
  req.body.user.order.orderId;
  done();
};
`
      }
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/orders/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user.order.orderId')).toBe(true);
  });

  it('extracts metadata from function parameter destructuring aliases and optional chaining', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

app.post('/checkout/:id', function create({ body, query, params }, res) {
  const orderId = body?.user?.order?.orderId;
  const page = query?.page;
  const id = params?.id;
  res.json({ ok: true, orderId, page, id });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/checkout/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'id')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user.order.orderId')).toBe(true);
  });

  it('includes Express router.param callbacks in component chain metadata', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();
const router = express.Router();

router.param('id', function attach(req, res, next, id) {
  req.query.traceId;
  next();
});

router.get('/users/:id', function handler(req, res) {
  res.json({ id: req.params.id });
});

app.use('/api', router);
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/api/users/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'id')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'traceId')).toBe(true);
  });

  it('extracts metadata from nested destructuring aliases in Fastify handlers', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.post('/invoices/:id', function create(req, reply) {
  const { user: { order } } = req.body;
  const { page } = req.query;
  const { id } = req.params;
  const orderId = order?.orderId;
  return { ok: true, id, page, orderId };
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/invoices/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'id')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user.order.orderId')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'user')).toBe(true);
  });

  it('tracks conflicting inferred types with evidence locations for same parameter', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

app.get('/report', function handler(req, res) {
  const a = parseInt(req.query.page, 10);
  const b = req.query.page;
  res.json({ a, b });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/report');

    expect(endpoint).toBeDefined();
    const page = endpoint?.parameters?.find((item) => item.location === 'query' && item.name === 'page');
    expect(page).toBeDefined();
    expect(page?.conflictingTypes?.includes('number')).toBe(true);
    expect(page?.conflictingTypes?.includes('string')).toBe(true);
    expect(page?.detectionLocation?.accessMode).toBe('read');
    expect((page?.evidenceLocations?.length ?? 0) >= 2).toBe(true);
    expect(
      page?.evidenceLocations?.some(
        (location) =>
          location.filePath === page.detectionLocation?.filePath &&
          location.line === page.detectionLocation?.line &&
          (location.column ?? 0) === (page.detectionLocation?.column ?? 0) &&
          location.accessMode === page.detectionLocation?.accessMode
      )
    ).toBe(false);
    expect(result.warnings.some((warning) => warning.code === 'parameter-type-conflict' && warning.framework === 'express')).toBe(true);
  });

  it('emits Fastify parameter-type-conflict warnings for incompatible inferred types', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.get('/report', function handler(req, reply) {
  const pageNumber = parseInt(req.query.page, 10);
  const pageString = req.query.page;
  return { pageNumber, pageString };
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/report');

    expect(endpoint).toBeDefined();
    const page = endpoint?.parameters?.find((item) => item.location === 'query' && item.name === 'page');
    expect(page).toBeDefined();
    expect(page?.conflictingTypes?.includes('number')).toBe(true);
    expect(page?.conflictingTypes?.includes('string')).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'parameter-type-conflict' && warning.framework === 'fastify')).toBe(true);
  });

  it('extracts Express response metadata per status code', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

app.get('/status', function handler(req, res) {
  res.status(201).json({ created: true });
  res.status(422).send('invalid');
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/status');

    expect(endpoint).toBeDefined();
    const created = endpoint?.responses?.find((item) => item.statusCode === 201);
    const invalid = endpoint?.responses?.find((item) => item.statusCode === 422);
    expect(created?.body?.type).toBe('json');
    expect(invalid?.body?.type).toBe('text');
  });

  it('extracts Fastify response metadata per status code', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.get('/status', function handler(req, reply) {
  reply.code(202).send({ accepted: true });
  reply.code(500).send('boom');
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/status');

    expect(endpoint).toBeDefined();
    const accepted = endpoint?.responses?.find((item) => item.statusCode === 202);
    const failed = endpoint?.responses?.find((item) => item.statusCode === 500);
    expect(accepted?.body?.type).toBe('json');
    expect(failed?.body?.type).toBe('text');
  });

  it('propagates request/response roots transitively across 3 levels of local helpers with renamed params each level', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

// Level 3 — deepest, calls level 2 function with its own names
function extract(httpReq, httpRes) {
  const sku = httpReq.body.items[0].sku;
  httpRes.locals.sku = sku;
}

// Level 2 — calls level 3 with swapped param order
function transform(outbound, inbound) {
  const token = inbound.headers['x-token'];
  extract(inbound, outbound);  // inbound is request, outbound is response
}

// Level 1 — called from route handler
function enrich(mid, ctx) {
  const page = ctx.query.page;
  transform(mid, ctx);  // mid is response, ctx is request
}

app.post('/items/:id', function handler(req, res) {
  enrich(res, req);   // res first, req second
  res.json({ ok: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find(
      (item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/items/:id'
    );

    expect(endpoint).toBeDefined();
    // detected at level 2
    expect(endpoint?.parameters?.some((item) => item.location === 'header' && item.name === 'x-token')).toBe(true);
    // detected at level 1
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    // detected at level 3
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'items[].sku')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'locals' && item.name === 'sku')).toBe(true);
  });

  it('propagates request/response roots transitively across 3 levels of cross-file helpers with renamed params each level', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const { enrich } = require('./level1');
const app = express();

app.post('/items/:id', function handler(req, res) {
  enrich(res, req);   // res first, req second
  res.json({ ok: true });
});
`,
      {
        'level1.ts': `import { transform } from './level2';
export function enrich(mid, ctx) {
  const page = ctx.query.page;
  transform(mid, ctx);  // mid=response, ctx=request
}
`,
        'level2.ts': `import { extract } from './level3';
export function transform(outbound, inbound) {
  const token = inbound.headers['x-token'];
  extract(inbound, outbound);  // inbound=request, outbound=response
}
`,
        'level3.ts': `export function extract(httpReq, httpRes) {
  const sku = httpReq.body.items[0].sku;
  httpRes.locals.sku = sku;
}
`
      }
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find(
      (item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/items/:id'
    );

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'header' && item.name === 'x-token')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'items[].sku')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'locals' && item.name === 'sku')).toBe(true);
  });

  it('infers request/response roots from call-site arguments when helper uses non-standard parameter order', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

// Note: enrich takes (response, request) — reversed from convention
function enrich(outbound, inbound) {
  const page = inbound.query.page;
  const userId = inbound.params.userId;
  outbound.locals.enriched = true;
}

app.get('/users/:userId', function handler(req, res) {
  enrich(res, req);   // res is passed first, req second
  res.json({ ok: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find(
      (item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/users/:userId'
    );

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'userId')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'locals' && item.name === 'enriched')).toBe(true);
  });

  it('infers request/response roots when passing to a cross-file helper with non-standard parameter order', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const { enrich } = require('./enricher');
const app = express();

app.post('/orders/:orderId', function handler(req, res) {
  enrich(res, req);  // response first, request second
  res.json({ ok: true });
});
`,
      {
        'enricher.ts': `export function enrich(httpResponse, httpRequest) {
  const orderId = httpRequest.params.orderId;
  const token = httpRequest.headers['x-auth-token'];
  const body = httpRequest.body;
  const sku = body.items[0].sku;
  httpResponse.locals.orderId = orderId;
}
`
      }
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find(
      (item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/orders/:orderId'
    );

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'path' && item.name === 'orderId')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'header' && item.name === 'x-auth-token')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'body' && item.name === 'items[].sku')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'locals' && item.name === 'orderId')).toBe(true);
  });

  it('infers correct roots when the same local helper is called from two sites with opposite argument order', async () => {
    // Both call sites must contribute to the hint set so the helper
    // correctly identifies both request and response roots regardless of order.
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

// Called as: logAccess(req, res) AND logAccess(res, req) from two routes
function logAccess(first, second) {
  const page = first.query?.page ?? second.query?.page;
  second.locals.logged = true;
}

app.get('/a', function handlerA(req, res) {
  logAccess(req, res);   // first=request, second=response
  res.json({ ok: true });
});

app.get('/b', function handlerB(req, res) {
  logAccess(res, req);   // first=response, second=request — opposite order
  res.json({ ok: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    for (const path of ['/a', '/b']) {
      const endpoint = result.endpoints.find(
        (item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === path
      );
      expect(endpoint, `endpoint ${path}`).toBeDefined();
      expect(
        endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page'),
        `${path} should detect query.page`
      ).toBe(true);
      expect(
        endpoint?.parameters?.some((item) => item.location === 'locals' && item.name === 'logged'),
        `${path} should detect locals.logged`
      ).toBe(true);
    }
  });

  it('correctly analyses a shared cross-file helper called with opposite argument order from two different routes', async () => {
    // This is the scenario described as the "remaining bound":
    // helper.ts is imported by two routes that each pass (req,res) in a different order.
    // Because each route's traversal is independent (fresh visitedSymbols), each gets
    // its own correctly-scoped analysis of the helper — so both should work.
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const { process: processRequest } = require('./processor');
const app = express();

// Route A: passes (req, res) — first=request, second=response
app.get('/a', function handlerA(req, res) {
  processRequest(req, res);
  res.json({ ok: true });
});

// Route B: passes (res, req) — first=response, second=request (opposite order)
app.get('/b', function handlerB(req, res) {
  processRequest(res, req);
  res.json({ ok: true });
});
`,
      {
        'processor.ts': `export function process(first, second) {
  // first could be req or res depending on the caller
  const page = first.query?.page ?? second.query?.page;
  const token = first.headers?.['x-token'] ?? second.headers?.['x-token'];
  first.locals = first.locals ?? {};
  first.locals.processed = true;
  second.locals = second.locals ?? {};
  second.locals.processed = true;
}
`
      }
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);

    for (const routePath of ['/a', '/b']) {
      const endpoint = result.endpoints.find(
        (item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === routePath
      );
      expect(endpoint, `endpoint ${routePath}`).toBeDefined();
      expect(
        endpoint?.parameters?.some((item) => item.location === 'query' && item.name === 'page'),
        `${routePath} should detect query.page`
      ).toBe(true);
      expect(
        endpoint?.parameters?.some((item) => item.location === 'header' && item.name === 'x-token'),
        `${routePath} should detect header x-token`
      ).toBe(true);
    }
  });

  it('detects custom context property when contextProperties is configured', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

app.post('/ctx/:id', function handler(requestLike, responseLike) {
  const userId = requestLike.context.userId;
  responseLike.context.auditId = userId;
  responseLike.json({ ok: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root, contextProperties: ['context'] }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'POST' && (item.resolvedPath ?? item.pathExpression) === '/ctx/:id');

    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.some((item) => item.location === 'context' && item.name === 'userId')).toBe(true);
    expect(endpoint?.parameters?.some((item) => item.location === 'context' && item.name === 'auditId')).toBe(true);
  });

  it('extracts Express response headers on chained status and set calls', async () => {
    const root = makeProject(
      { dependencies: { express: '^4.0.0' } },
      `const express = require('express');
const app = express();

app.get('/status-headers', function handler(req, res) {
  res.status(201).set('x-created-id', 'abc').json({ created: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new ExpressDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/status-headers');

    expect(endpoint).toBeDefined();
    const created = endpoint?.responses?.find((item) => item.statusCode === 201);
    expect(created?.body?.type).toBe('json');
    expect(created?.headers?.some((item) => item.name === 'x-created-id')).toBe(true);
  });

  it('extracts Fastify response headers on chained code and header calls', async () => {
    const root = makeProject(
      { dependencies: { fastify: '^4.0.0' } },
      `const fastify = require('fastify')();

fastify.get('/status-headers', function handler(req, reply) {
  reply.code(202).header('x-accepted-id', 'ok').send({ accepted: true });
});
`
    );

    const fingerprint = detector.buildFingerprint(root);
    const provider = new FastifyDiscoveryProvider();
    const result = await provider.discover({ workspaceFolder: root }, fingerprint);
    const endpoint = result.endpoints.find((item) => item.method === 'GET' && (item.resolvedPath ?? item.pathExpression) === '/status-headers');

    expect(endpoint).toBeDefined();
    const accepted = endpoint?.responses?.find((item) => item.statusCode === 202);
    expect(accepted?.body?.type).toBe('json');
    expect(accepted?.headers?.some((item) => item.name === 'x-accepted-id')).toBe(true);
  });
});

function makeProject(packageJson: Record<string, any>, srcContent = '', additionalSrcFiles: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-api-forge-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), srcContent);

  for (const [relativePath, content] of Object.entries(additionalSrcFiles)) {
    const fullPath = path.join(root, 'src', relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  return root;
}
