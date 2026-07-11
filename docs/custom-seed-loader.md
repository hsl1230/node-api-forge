# Custom Seed Loader

Node API Forge can load seed endpoints through a custom module configured in `.http-forge/node-api-forge.config.json` via `customSeedLoaderModulePath`.

Use a custom seed loader when endpoint discovery from source is incomplete, for example when:

- routes are registered indirectly through framework wrappers
- route definitions come from generated files, manifests, or database-backed config
- runtime composition hides final paths from static analysis
- some endpoints exist but are intentionally not reachable from the code patterns Node API Forge currently scans

The custom seed loader does not replace normal source discovery. Its output is merged with auto-discovered endpoints, so it is best used to fill gaps rather than duplicate everything.

## How It Is Resolved

`customSeedLoaderModulePath` can be either:

- an absolute path
- or a path relative to the workspace root (from `.http-forge/node-api-forge.config.json`)

If you set:

```json
{
  "customSeedLoaderModulePath": "seed-loader.js"
}
```

and your workspace root is `/workspace`, Node API Forge resolves this to:

```text
/workspace/seed-loader.js
```

In a multi-project workspace, this still works as a shared loader because the same resolved module is called for each discovered `projectRoot`.

## Export Contract

Your module must export either:

- named export: `loadSeedManifestEndpoints(projectRoot, discoveryContext)`
- or default export with the same signature

Signature:

```ts
(projectRoot: string, discoveryContext: DiscoveryContext) => ApiEndpoint[] | {
  endpoints?: ApiEndpoint[];
  warnings?: DiscoveryWarning[];
}
```

Return shape:

- `ApiEndpoint[]`
- or `{ endpoints: ApiEndpoint[]; warnings?: DiscoveryWarning[] }`

## Parameters

### `projectRoot`

Absolute path of the current project being discovered.

Use this when building `handlerLocation.filePath` values or when reading project-local manifests/config files.

### `discoveryContext`

The same discovery context used by Node API Forge. Useful fields include:

- `workspaceFolder`
- `includeProjectRoots`
- `frameworksByProjectRoot`
- `customSeedLoaderModulePath`
- `envOverrides`
- `contextProperties`

You usually only need `projectRoot`, but `discoveryContext` is available if your loader needs environment or workspace-level context.

## Minimal Example

```js
// seed-loader.js
exports.loadSeedManifestEndpoints = function (projectRoot, discoveryContext) {
  return {
    endpoints: [
      {
        method: 'GET',
        framework: 'express',
        pathExpression: '/health',
        resolvedPath: '/health',
        confidence: 'medium',
        handlerLocation: {
          filePath: projectRoot + '/src/health.js',
          line: 1
        },
        middleware: []
      }
    ],
    warnings: []
  };
};
```

## Manifest Example

This pattern is useful when routes are defined in JSON, YAML, or another registry that static source analysis cannot fully reconstruct.

```js
// seed-loader.js
const fs = require('fs');
const path = require('path');

exports.loadSeedManifestEndpoints = function (projectRoot, discoveryContext) {
  const manifestPath = path.join(projectRoot, 'api-routes.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      endpoints: [],
      warnings: [
        {
          code: 'seed-manifest-invalid',
          filePath: manifestPath,
          message: 'api-routes.json was not found for custom seed loading.'
        }
      ]
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  return {
    endpoints: manifest.routes.map((route) => ({
      method: route.method,
      framework: 'express',
      pathExpression: route.path,
      resolvedPath: route.path,
      confidence: 'medium',
      handlerLocation: {
        filePath: path.join(projectRoot, route.handlerFile),
        line: route.line ?? 1
      },
      middleware: []
    })),
    warnings: []
  };
};
```

## Supported Endpoint Fields

The seed loader can return the same `ApiEndpoint` shape used internally by Node API Forge.

### Top-level endpoint fields

#### `method: string`

HTTP method for the endpoint, for example `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.

#### `framework: 'express' | 'fastify' | 'nestjs' | 'lambda' | 'unknown'`

Framework associated with the endpoint.

Use `unknown` only when the endpoint does not map cleanly to a supported framework.

#### `projectName?: string`

Optional display/project grouping name.

Usually this can be omitted because Node API Forge can derive project grouping from the workspace, but you may set it when you want explicit grouping behavior.

#### `pathExpression: string`

The source route pattern.

Examples:

- `/users/:id`
- `/orders/{id}`
- `/health`

This field is required.

#### `resolvedPath?: string`

The final resolved route path when known exactly.

If your route is fully concrete, set this to the same value as `pathExpression`. If the route is partially dynamic or approximate, omit it and keep only `pathExpression`.

#### `displayName?: string`

Optional short label used in UI displays such as diagrams or endpoint lists.

Useful when the full path is technically correct but too long or noisy for presentation.

#### `operationId?: string`

Optional stable identifier for the endpoint.

Useful if your source manifest or upstream system already has operation identifiers.

#### `confidence: 'high' | 'medium' | 'low'`

How certain the seed loader is that this endpoint definition is correct.

- `high`: exact route and method are known
- `medium`: route is known but derived from indirect config or convention
- `low`: route is approximate and should be reviewed

This field is required.

#### `handlerLocation: SourceLocation`

Location used by the extension to navigate back to source.

Required nested fields:

- `filePath: string` — absolute file path to the source file
- `line: number` — 1-based line number

Optional nested fields:

- `column?: number` — 1-based column number
- `symbolName?: string` — function/class/symbol label
- `accessMode?: 'read' | 'write'` — mostly useful for evidence-style metadata, not usually needed for the main handler location

#### `middleware: ApiMiddleware[]`

List of middleware attached to the endpoint.

This field is required, but it can be an empty array.

Each middleware entry supports:

- `name: string` — middleware identifier or function name
- `location?: SourceLocation` — optional file/line link for the middleware

#### `parameters?: ApiParameter[]`

Optional parameter definitions for path/query/header/cookie/body/context-style fields.

Each parameter supports:

- `name: string` — parameter name or nested path like `user.id`
- `location: string` — commonly `path`, `query`, `header`, `cookie`, `body`, `locals`, or a custom configured context location such as `context`
- `type?: string` — for example `string`, `number`, `boolean`, `object`
- `required?: boolean`
- `description?: string`
- `example?: string`
- `detectionLocation?: SourceLocation`
- `evidenceLocations?: SourceLocation[]`
- `conflictingTypes?: string[]`

#### `requestBody?: ApiRequestBody`

Optional request body metadata.

Supported fields:

- `type?: string` — for example `json`, `form`, `text`, `multipart`
- `schema?: string` — inferred or external schema hint
- `required?: boolean`
- `example?: unknown`
- `detectionLocation?: SourceLocation`

#### `responses?: ApiResponse[]`

Optional response metadata.

Each response entry supports:

- `statusCode?: number`
- `headers?: ApiParameter[]` — usually header-style parameters
- `body?: { type?: string; schema?: string }`

#### `cookies?: ApiCookie[]`

Optional cookie metadata.

Each cookie supports:

- `name: string`
- `type?: 'request' | 'response'`
- `secure?: boolean`
- `httpOnly?: boolean`
- `sameSite?: string`
- `detectionLocation?: SourceLocation`

#### `description?: string`

Optional human-readable description shown in exported or UI surfaces.

### Smallest practical endpoint object

At minimum, a seed endpoint should usually contain:

```js
{
  method: 'GET',
  framework: 'express',
  pathExpression: '/health',
  confidence: 'medium',
  handlerLocation: {
    filePath: projectRoot + '/src/health.js',
    line: 1
  },
  middleware: []
}
```

Everything else is optional, but the more metadata you provide, the richer the Node API Forge experience becomes.

## Confidence Guidance

Use:

- `high` when the final path/method is exact
- `medium` when the route is known but derived from partial config or convention
- `low` when the endpoint is approximate and may need user review

## Config Example

Set the loader in `.http-forge/node-api-forge.config.json`:

```json
{
  "customSeedLoaderModulePath": "seed-loader.js"
}
```

Example with other related config properties:

```json
{
  "frameworks": ["auto"],
  "customSeedLoaderModulePath": "seed-loader.js",
  "contextProperties": ["locals"]
}
```

## Merge Behavior

Seed endpoints are merged with auto-discovered endpoints.

- if a seed endpoint matches an auto-discovered endpoint, Node API Forge merges seed metadata into the discovered endpoint
- if a seed endpoint does not match any discovered endpoint, it is still kept and surfaced with a warning indicating it was unmatched

This makes the seed loader safe to use as a supplement rather than an all-or-nothing replacement.

## Troubleshooting

If your seed loader is not working, check these common cases:

### Module not found

Make sure the configured path is correct relative to the project root, or use an absolute path.

### Wrong export name

Your module must export either:

- `loadSeedManifestEndpoints`
- or a default function

### Runtime exception in loader

Any thrown error becomes a `seed-loader-failed` warning in discovery output.

### No endpoints returned

Return either:

- a plain `ApiEndpoint[]`
- or `{ endpoints: [...], warnings: [...] }`

## Best Practices

- keep the loader deterministic and fast
- prefer reading local manifest/config files over performing network calls
- always use absolute handler paths built from `projectRoot`
- emit warnings when the manifest is malformed instead of silently swallowing issues
- keep generated endpoint objects minimal, then let auto-discovery enrich what it can

## Related

- [README](../README.md)
- [Analyzer Architecture](./analyzer-architecture.md)
