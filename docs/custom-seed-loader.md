# Custom Seed Loader

Node API Forge can load seed endpoints through a custom module configured by `nodeApiForge.customSeedLoaderModulePath`.

Expected export:

- named export: `loadSeedManifestEndpoints(projectRoot, discoveryContext)`
- or default export with the same signature

Return shape:

- `ApiEndpoint[]`
- or `{ endpoints: ApiEndpoint[]; warnings?: DiscoveryWarning[] }`

## Example

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

Set the loader in VS Code settings:

```json
{
  "nodeApiForge.customSeedLoaderModulePath": "seed-loader.js"
}
```
