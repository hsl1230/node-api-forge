# Node API Forge Analyzer Architecture

## Overview

Node API Forge already has framework-specific discovery providers for Express, NestJS, and Fastify. The next step is to make the Express and Fastify parts behave like real component analyzers, similar to the analyzer split used in AGL Essentials.

The goal is to separate the concerns that are currently mixed inside the providers:

- route and component discovery
- nested prefix propagation
- path resolution and placeholder handling
- middleware extraction
- framework-specific normalization

## Proposed Module Split

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Node API Forge UI                               │
│                    Explorer, commands, export                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ApiDiscoveryEngine                              │
│                  Orchestrates providers and results                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Framework Component Analyzers                        │
│                                                                         │
│  ┌──────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ ExpressComponentAnalyzer  │  │ FastifyComponentAnalyzer            │ │
│  │ - router graph building   │  │ - plugin graph building             │ │
│  │ - app.use/router.use      │  │ - register() prefix propagation     │ │
│  │ - route() handler lookup  │  │ - route() object route extraction   │ │
│  │ - middleware capture      │  │ - middleware capture                │ │
│  └──────────────────────────┘  └─────────────────────────────────────┘ │
│                                                                         │
│  ┌──────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ NestControllerAnalyzer    │  │ Shared AST / Path Utilities         │ │
│  │ - decorators              │  │ - source collection                 │ │
│  │ - controller prefixes     │  │ - resolution context                │ │
│  │ - method decorators       │  │ - path joining / placeholder logic  │ │
│  └──────────────────────────┘  └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                       ┌────────────────────────────┐
                       │  DiscoveryResult           │
                       │  endpoints + warnings      │
                       └────────────────────────────┘
```

## Why This Split

Express and Fastify do not map to the same analysis model:

- Express is router-heavy and usually needs mount graph traversal.
- Fastify is plugin-heavy and usually needs register-tree traversal.
- NestJS is decorator-driven and should remain its own path.

If the logic stays inside the providers, the code becomes harder to test because route detection, graph traversal, and output shaping are coupled together. A dedicated analyzer layer keeps the providers thin and makes each framework easier to evolve.

## Responsibilities

### ExpressComponentAnalyzer

Owns Express-specific component analysis.

Core tasks:

- detect `express()` apps and `express.Router()` instances
- collect nested router aliases
- follow `app.use()` and `router.use()` mount edges
- resolve nested prefixes across router graphs
- extract route handlers from `get`, `post`, `put`, `delete`, `patch`, `all`, and `route()` chains
- collect middleware attached before the terminal handler

This analyzer should produce normalized endpoint records that already include:

- `method`
- `pathExpression`
- `resolvedPath` when possible
- `middleware[]`
- handler source location

### FastifyComponentAnalyzer

Owns Fastify-specific component analysis.

Core tasks:

- detect root Fastify instances and plugin instances
- follow nested `register()` calls
- propagate prefix state through plugin trees
- extract routes from direct method calls and route config objects
- read `preHandler` middleware and similar hooks
- normalize object-style route definitions into the shared endpoint model

### NestControllerAnalyzer

Keeps NestJS as a separate decorator-based analyzer.

Core tasks:

- parse `@Controller()` prefixes
- parse HTTP method decorators such as `@Get()`, `@Post()`, `@Patch()`, and `@Delete()`
- collect class-level and method-level middleware decorators
- merge controller prefix + method path into a shared route value

### Shared Utilities

The following utilities should stay framework-agnostic:

- source file collection
- AST helper functions
- path joining
- environment/local-constant resolution
- placeholder normalization for export

## How This Relates to the Current Code

The current providers already contain the beginnings of this split:

- [Express discovery provider](../src/discovery/providers/express-discovery-provider.ts)
- [Fastify discovery provider](../src/discovery/providers/fastify-discovery-provider.ts)
- [Nest discovery provider](../src/discovery/providers/nest-discovery-provider.ts)

At the moment those providers combine detection and analysis in one place. The next refactor should move the graph traversal and path resolution logic into dedicated analyzer classes, leaving the providers responsible mainly for:

- framework support checks
- file enumeration
- analyzer orchestration
- warning aggregation

## Recommended File Layout

```
src/discovery/
├── analyzer/
│   ├── analyzer-utils.ts
│   ├── path-resolver.ts
│   ├── express-component-analyzer.ts
│   ├── fastify-component-analyzer.ts
│   └── nest-controller-analyzer.ts
├── providers/
│   ├── express-discovery-provider.ts
│   ├── fastify-discovery-provider.ts
│   └── nest-discovery-provider.ts
└── discovery-engine.ts
```

## Practical Rollout

1. Extract shared AST and path utilities.
2. Move Express router graph traversal into `ExpressComponentAnalyzer`.
3. Move Fastify plugin tree traversal into `FastifyComponentAnalyzer`.
4. Keep NestJS on its own decorator analyzer path.
5. Add tests for nested routers, nested plugins, and placeholder resolution.

## Expected Outcome

This structure gives Node API Forge the same advantage AGL Essentials got from component analysis:

- narrower responsibilities
- easier test coverage
- simpler framework-specific extension points
- clearer route graph reasoning for nested Express and Fastify projects