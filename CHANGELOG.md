# Changelog

All notable changes to this project are documented in this file.

## 0.0.4 2026-07-09

### Added

- AWS Lambda (raw handler) support as a new `lambda` framework. Endpoints are discovered from Serverless Framework (`serverless.yml`) and AWS SAM (`template.yaml` / `template.json`) config files. Projects using `express`+`serverless-http` or `fastify`+`@fastify/aws-lambda` continue to be handled by the existing Express and Fastify providers unchanged.
- Lambda component analyzer: extracts parameters from `event.pathParameters`, `event.queryStringParameters`, `event.headers`, and `event.body` accesses inside handler bodies.
- Middy middleware detection: `.use()` plugin chains are captured as endpoint middleware.
- Handler-scan fallback: when no config file is present, exported Lambda handlers are discovered with `confidence: low` and an unknown-path warning.
- `"lambda"` added to the `nodeApiForge.frameworks` setting enum.

## 0.0.3 2026-07-08

### Added

- Extension package icon and Marketplace metadata polish.
- Discovery stats for parameter traversal truncation when very large dependency graphs are capped.

### Changed

- HTTP Forge request export now uses a safe environment variable name for project base URLs, with `baseUrl` fallback when project name is unavailable.
- Redundant manual `activationEvents` were removed from `package.json` in favor of VS Code's auto-generated activation based on contributions.

### Fixed

- Opening a discovered endpoint in HTTP Forge no longer generates invalid `{{undefinedBaseUrl}}` variables for endpoints without resolved project names.
- Deep dependency parameter analysis now warns when the traversal cap is reached instead of failing silently.

## 0.0.2 2026-07-08

### Added

- API Explorer hierarchical rendering with lazy expansion: project -> framework -> endpoint.
- Framework endpoint paging in API Explorer for large endpoint sets.
- New setting `nodeApiForge.apiExplorerFrameworkPageSize` to tune explorer paging (default 200, supported range 25 to 1000).
- Lightweight tree redraw when the API Explorer page-size setting changes.
- Project-aware grouping for discovered endpoint export.

### Changed

- Endpoint grouping now consistently uses project + framework structure across tree and export.
- Discovery and parameter-enrichment pipeline now favors incremental recomputation and cache reuse for faster refreshes.

### Fixed

- Query parameter extraction now includes deeper imported helper functions used by handlers.
- Duplicated project-name resolution logic was centralized to reduce drift.

## 0.0.1 2026-07-07

### Added

- Initial Node API Forge release for VS Code.
- Source-based endpoint discovery for Express, NestJS, and Fastify.
- HTTP Forge integration for opening discovered endpoints.
- API Explorer view and command set.
