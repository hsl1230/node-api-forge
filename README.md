<div align="center">

<p style="display: flex; align-items: center; justify-content: center; gap: 12px;">
	<img src="https://raw.githubusercontent.com/hsl1230/node-api-forge/main/resources/icon.png" alt="Node API Forge" width="120"/>
	<strong>works with</strong>
	<a href="https://marketplace.visualstudio.com/items?itemName=henry-huang.http-forge">
		<img src="https://raw.githubusercontent.com/hsl1230/http-forge/main/resources/http-forge-icon.png" alt="HTTP Forge" width="72"/>
	</a>
</p>

# Node API Forge

**Discover, test, and document Node APIs without Swagger.**

No app integration. No production risk. No Swagger dependencies. Just source-to-API in seconds with full testing workflows.

[![HTTP Forge](https://img.shields.io/badge/uses-HTTP%20Forge-blue)](https://marketplace.visualstudio.com/items?itemName=henry-huang.http-forge)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/henry-huang.node-api-forge?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=henry-huang.node-api-forge)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node APIs](https://img.shields.io/badge/scope-Node%20APIs-43853d)](https://nodejs.org/)

</div>

Node API Forge eliminates Swagger UI integration overhead by discovering endpoints directly from your Node.js source code and generating organized [HTTP Forge](https://marketplace.visualstudio.com/items?itemName=henry-huang.http-forge) workflows for testing, documentation, and automation—without adding app dependencies or production security risks.

Supported frameworks: Express, NestJS, and Fastify.

## Start In 60 Seconds

1. Open a Node.js workspace.
2. Run **Node API Forge: Discover APIs**.
3. Open the **Node API Forge** sidebar and pick an endpoint.
4. Use **Open Endpoint in HTTP Forge** or **Show Endpoint Flow**.

## Why Node API Forge (vs. Swagger UI)

| Feature | Swagger UI | Node API Forge |
|---------|-----------|----------------|
| **App Integration** | Requires dependency + config | None—reads source and seed loaders |
| **Production Risk** | Easy to expose accidentally | Zero app-level exposure |
| **Request History** | Limited/none | Full—persisted in workspace HTTP Forge collections |
| **Saved Inputs** | Not supported | Full—stored in collections, shareable via git |
| **Request Organization** | By tag only | By project + framework, auto-grouped |
| **Testing Workflows** | Basic | Full (pre/post scripts, assertions, CI) |
| **Endpoint Flow** | Not available | 5-tab flow analyzer: diagram, middleware chain, component tree, data flow, docs |
| **Auto Refresh** | Not applicable | Incremental—only changed files re-analyzed on save |

## Why Teams Use It

- Discover Express, NestJS, and Fastify endpoints directly from source instead of manually curating requests.
- Open endpoints in HTTP Forge with method, path, params, headers, and body context already mapped.
- Browse APIs in a scalable explorer hierarchy (project -> framework -> endpoint), with automatic framework paging for very large endpoint sets.
- Trace endpoint flow across 5 tabs: Mermaid flow diagram, ordered middleware chain, component tree, parameter data flow with click-to-source navigation, and a documentation/HTTP snippet view.
- Export discovered endpoints as organized HTTP Forge collections grouped by project and framework.
- Support multi-project workspaces and custom seed loaders for routes that cannot be auto-discovered from source.
- Keep the explorer current with incremental auto-refresh—only changed files are re-analyzed on save.

## Commands

| Command | When To Use It | Result |
|---|---|---|
| `Node API Forge: Discover APIs` | After opening a workspace or changing routing code | Refreshes endpoint discovery from source and configured seed loaders |
| `Node API Forge: Open Endpoint in HTTP Forge` | You want to test a discovered endpoint immediately | Opens a request context in HTTP Forge |
| `Node API Forge: Open Endpoint Source` | You need to inspect the handler implementation | Opens source file at handler location |
| `Node API Forge: Copy Endpoint Request` | You need a quick portable request snippet | Copies an HTTP request template to clipboard |
| `Node API Forge: Export Discovered Collection` | You want reusable request assets | Exports discovered endpoints as HTTP Forge collection JSON |
| `Node API Forge: Show Endpoint Flow` | You want middleware/handler analysis | Opens flow analyzer webview for the endpoint |
| `Node API Forge: Hard Refresh Workspace` | Discovery cache is stale after major changes | Clears caches and re-runs discovery |

## Example Setup

```jsonc
{
	"nodeApiForge.frameworks": ["auto"],
	"nodeApiForge.customSeedLoaderModulePath": "./node-api-forge-generic-loader.js",
	"nodeApiForge.autoRefreshOnFileChanges": true,
	"nodeApiForge.searchComponentLibAllowlist": [],
	"nodeApiForge.apiExplorerFrameworkPageSize": 200
}
```

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `nodeApiForge.frameworks` | `string[]` | `["auto"]` | Framework hints for discovery in mixed projects (`auto`, `express`, `fastify`, `nestjs`). |
| `nodeApiForge.customSeedLoaderModulePath` | `string` | `""` | Optional JS module that exports `loadSeedManifestEndpoints(projectRoot, context)`. |
| `nodeApiForge.autoRefreshOnFileChanges` | `boolean` | `true` | Automatically reruns discovery on relevant source/config changes. |
| `nodeApiForge.searchComponentLibAllowlist` | `string[]` | `[]` | External/internal library packages Flow Search is allowed to traverse. |
| `nodeApiForge.apiExplorerFrameworkPageSize` | `number` | `200` | Endpoints per framework page in API Explorer for large endpoint sets (range `25` to `1000`). |

## Docs

- [Analyzer Architecture](docs/analyzer-architecture.md)
- [Commands](docs/commands.md)
- [Custom Seed Loader](docs/custom-seed-loader.md)

## Related Links

- [HTTP Forge](https://marketplace.visualstudio.com/items?itemName=henry-huang.http-forge)
- [HTTP Forge README](https://github.com/hsl1230/http-forge/blob/main/README.md)
- [HTTP Forge MCP Server Guide](https://github.com/hsl1230/http-forge/blob/main/docs/user-guide/mcp-server.md)
