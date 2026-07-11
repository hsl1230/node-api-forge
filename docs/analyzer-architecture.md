# Node API Forge Analyzer Architecture

## Overview

Node API Forge uses framework-specific providers for Express, NestJS, Fastify, and AWS Lambda with a shared discovery engine. The architecture already separates route discovery from cross-cutting concerns such as endpoint grouping, parameter enrichment, export shaping, and incremental cache reuse.

The core responsibilities are split across:

- route and component discovery
- project-aware endpoint grouping
- parameter extraction and merge from dependency trees
- cache invalidation and incremental recomputation
- UI-facing tree shaping for large endpoint sets

## Current Module Split

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Node API Forge UI                               │
│                    Explorer, commands, export                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ApiDiscoveryEngine                             │
│      Orchestrates providers, seed merge, enrichment, and caches       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Framework Discovery Providers                        │
│                                                                         │
│  ┌──────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ ExpressDiscoveryProvider │  │ FastifyDiscoveryProvider            │ │
│  │ - router traversal        │  │ - plugin/register traversal         │ │
│  │ - route extraction        │  │ - route extraction                  │ │
│  │ - middleware capture      │  │ - middleware/hook capture           │ │
│  └──────────────────────────┘  └─────────────────────────────────────┘ │
│                                                                         │
│  ┌──────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ NestDiscoveryProvider    │  │ Shared AST / Path Utilities         │ │
│  │ - decorators             │  │ - source collection                 │ │
│  │ - controller + method    │  │ - path joining / placeholder logic  │ │
│  │ - route normalization     │  │ - handler location resolution       │ │
│  └──────────────────────────┘  └─────────────────────────────────────┘ │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ LambdaDiscoveryProvider (last-resort — activates only when       │  │
│  │ Express and Fastify are absent)                                  │  │
│  │ - serverless.yml / SAM template.yaml config parsing             │  │
│  │ - handler file resolution from config references                │  │
│  │ - event.* parameter extraction (path/query/header/body)         │  │
│  │ - Middy middleware unwrapping                                   │  │
│  │ - handler-scan fallback when no config file found               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                       ┌────────────────────────────┐
                       │  DiscoveryResult           │
                       │  endpoints + warnings      │
                       └────────────────────────────┘
```

## Discovery Engine Responsibilities

The discovery engine layers shared behavior on top of provider output:

- merges provider endpoints with custom seed loader endpoints
- keeps project-aware grouping information for tree and export
- enriches endpoint parameters from component/dependency scans
- tracks and reuses cached parameter results for unchanged endpoints
- invalidates affected caches on file changes or hard refresh

This keeps framework traversal logic inside providers while preserving consistent output behavior across frameworks.

## Request and Response Inference Model

Parameter extraction does not depend on hardcoded variable names like `req`/`res`.

The analyzer uses AST-based root inference and call-site propagation to follow request/response-like objects across:

- middleware and handlers
- local helper calls
- imported helper calls

Context-style property tracking is configurable through `.http-forge/node-api-forge.config.json` using `contextProperties` (default: `['locals']`).
This allows the same extraction pipeline to capture values from chains such as:

- `response.locals.userId`
- `ctx.context.tenantId`
- other project-specific context properties configured by the user

## Incremental Caching Model

Node API Forge uses layered caches to keep refreshes fast on large workspaces:

- provider-level file signature checks (mtime and size)
- component dependency graph cache by project root
- per-file component analysis cache (dependencies + extracted parameters)
- reverse dependency map to find affected endpoints quickly
- endpoint parameter cache to reuse merged parameter output

On each run, only changed or affected components are recomputed when possible.

## API Explorer Rendering Model

The API Explorer tree is intentionally hierarchical and lazy:

- root: projects
- project node: frameworks
- framework node: endpoints or paged endpoint buckets for large sets

When a framework has many endpoints, the UI renders page nodes such as Endpoints 1-200 before individual endpoint nodes. Page size is configurable through `apiExplorerFrameworkPageSize` in `.http-forge/node-api-forge.config.json`.

## How This Relates to the Code

Current implementation entry points:

- [Discovery engine](../src/discovery/discovery-engine.ts)
- [Explorer tree provider](../src/discovery/api-explorer-tree-provider.ts)
- [Express provider](../src/discovery/providers/express-discovery-provider.ts)
- [Fastify provider](../src/discovery/providers/fastify-discovery-provider.ts)
- [Nest provider](../src/discovery/providers/nest-discovery-provider.ts)
- [Lambda provider](../src/discovery/providers/lambda-discovery-provider.ts)

## Extension Points

The architecture is designed so future improvements can be added without changing extension command flow:

- deeper framework-specific analyzers where needed
- richer parameter and schema inference
- additional endpoint grouping or filtering strategies
- extra diagnostics based on existing cache stats
