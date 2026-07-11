# Commands

Node API Forge contributes the following commands:

- `Node API Forge: Discover APIs`
- `Node API Forge: Open Endpoint in HTTP Forge`
- `Node API Forge: Open Endpoint Source`
- `Node API Forge: Copy Endpoint Request`
- `Node API Forge: Export Discovered Collection`
- `Node API Forge: Show Endpoint Flow`
- `Node API Forge: Search in Endpoint Files`
- `Node API Forge: Go to Test File`
- `Node API Forge: Export Project Collection`
- `Node API Forge: Export Framework Collection`
- `Node API Forge: Hard Refresh Workspace`

## Typical Workflow

1. Run `Node API Forge: Discover APIs`.
2. Select an endpoint in the API Explorer.
3. Use endpoint actions from the context menu.
4. Use `Hard Refresh Workspace` when major route changes are not reflected yet.

## Discovery Notes

- `Node API Forge: Discover APIs` performs a manual refresh and prints discovery diagnostics to the output channel.
- If no custom seed loader is configured and discovery returns very few endpoints, the extension shows an in-product warning with quick actions to open:
	- the custom seed loader guide
	- `.http-forge/node-api-forge.config.json`
- This behavior is intended to guide projects that register routes through wrappers, manifests, or runtime composition patterns that static analysis cannot fully reconstruct.

## Related Config Properties

- `customSeedLoaderModulePath`
- `contextProperties`
- `frameworks`
- `autoRefreshOnFileChanges`
- `searchComponentLibAllowlist`
- `externalCallLibraries`

## Performance Tuning

If a framework node contains a very large number of endpoints, tune pagination with:

- `apiExplorerFrameworkPageSize` in `.http-forge/node-api-forge.config.json` (default: `200`, supported range: `25` to `1000`)

Guidance:

- Lower values reduce expansion cost for very large trees.
- Higher values reduce the number of page groups (for example `Endpoints 1-200`, `201-400`).
