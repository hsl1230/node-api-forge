import * as fs from 'fs';
import * as path from 'path';

export type ExternalCallType = 'http' | 'database' | 'cache' | 'queue' | 'storage';

export interface ExternalCall {
  type: ExternalCallType;
  client: string;
  filePath: string;
  line: number;
  snippet: string;
}

/** A user-supplied entry from .http-forge/node-api-forge.config.json. */
export interface ExternalCallLibraryConfig {
  /** npm package name as it appears in import/require strings, e.g. "@company/db-client" */
  package: string;
  /** Short display name shown in the External Calls tab */
  client: string;
  type: ExternalCallType;
}

interface LibraryEntry {
  client: string;
  type: ExternalCallType;
}

/**
 * Maps npm package names → library metadata.
 * The key is what appears in the import/require string, not a variable name.
 */
const LIBRARY_REGISTRY: Record<string, LibraryEntry> = {
  // HTTP
  'axios':                  { client: 'axios',       type: 'http' },
  'got':                    { client: 'got',         type: 'http' },
  'node-fetch':             { client: 'node-fetch',  type: 'http' },
  'isomorphic-fetch':       { client: 'node-fetch',  type: 'http' },
  'cross-fetch':            { client: 'node-fetch',  type: 'http' },
  'undici':                 { client: 'undici',      type: 'http' },
  'ky':                     { client: 'ky',          type: 'http' },
  'needle':                 { client: 'needle',      type: 'http' },
  'superagent':             { client: 'superagent',  type: 'http' },
  'request':                { client: 'request',     type: 'http' },
  // Database
  'mongoose':               { client: 'mongoose',    type: 'database' },
  '@prisma/client':         { client: 'prisma',      type: 'database' },
  'knex':                   { client: 'knex',        type: 'database' },
  'sequelize':              { client: 'sequelize',   type: 'database' },
  'sequelize-typescript':   { client: 'sequelize',   type: 'database' },
  'pg':                     { client: 'pg',          type: 'database' },
  'mysql':                  { client: 'mysql',       type: 'database' },
  'mysql2':                 { client: 'mysql2',      type: 'database' },
  'sqlite3':                { client: 'sqlite3',     type: 'database' },
  'better-sqlite3':         { client: 'sqlite3',     type: 'database' },
  'typeorm':                { client: 'typeorm',     type: 'database' },
  '@mikro-orm/core':        { client: 'mikro-orm',   type: 'database' },
  'drizzle-orm':            { client: 'drizzle-orm', type: 'database' },
  // Cache
  'redis':                  { client: 'redis',       type: 'cache' },
  'ioredis':                { client: 'ioredis',     type: 'cache' },
  'node-cache':             { client: 'node-cache',  type: 'cache' },
  'memcached':              { client: 'memcached',   type: 'cache' },
  'memjs':                  { client: 'memcached',   type: 'cache' },
  // Queue
  'amqplib':                { client: 'amqplib',     type: 'queue' },
  'bull':                   { client: 'bull',        type: 'queue' },
  'bullmq':                 { client: 'bullmq',      type: 'queue' },
  'kafkajs':                { client: 'kafkajs',     type: 'queue' },
  // Storage
  'aws-sdk':                        { client: 's3',            type: 'storage' },
  '@aws-sdk/client-s3':             { client: 's3',            type: 'storage' },
  '@aws-sdk/lib-storage':           { client: 's3',            type: 'storage' },
  '@google-cloud/storage':          { client: 'gcs',           type: 'storage' },
  '@azure/storage-blob':            { client: 'azure-blob',    type: 'storage' },
  'cloudinary':                     { client: 'cloudinary',    type: 'storage' },
  // AWS SDK additional services
  '@aws-sdk/client-dynamodb':       { client: 'dynamodb',      type: 'database' },
  '@aws-sdk/client-sqs':            { client: 'sqs',           type: 'queue' },
  '@aws-sdk/client-sns':            { client: 'sns',           type: 'queue' },
  '@aws-sdk/client-ses':            { client: 'ses',           type: 'queue' },
  'dynamoose':                      { client: 'dynamodb',      type: 'database' },
  // Azure / GCP messaging
  '@azure/service-bus':             { client: 'azure-sb',      type: 'queue' },
  '@azure/cosmos':                  { client: 'cosmos-db',     type: 'database' },
  '@google-cloud/pubsub':           { client: 'pubsub',        type: 'queue' },
  // NATS
  'nats':                           { client: 'nats',          type: 'queue' },
  // NestJS service wrappers — injected class names resolve to the underlying lib
  '@nestjs/axios':                  { client: 'axios',         type: 'http' },
  '@nestjs/typeorm':                { client: 'typeorm',       type: 'database' },
  '@nestjs/mongoose':               { client: 'mongoose',      type: 'database' },
  '@nestjs/sequelize':              { client: 'sequelize',     type: 'database' },
  // Fastify plugins
  '@fastify/redis':                 { client: 'redis',         type: 'cache' },
  '@fastify/mysql':                 { client: 'mysql2',        type: 'database' },
  '@fastify/postgres':              { client: 'pg',            type: 'database' },
  '@fastify/mongodb':               { client: 'mongoose',      type: 'database' },
  // Additional DB drivers
  'mssql':                          { client: 'mssql',         type: 'database' },
  'couchdb-nano':                   { client: 'couchdb',       type: 'database' },
  'elasticsearch':                  { client: 'elasticsearch', type: 'database' },
  '@elastic/elasticsearch':         { client: 'elasticsearch', type: 'database' },
  '@opensearch-project/opensearch': { client: 'opensearch',    type: 'database' },
  // Additional cache
  '@redis/client':                  { client: 'redis',         type: 'cache' },
  'keyv':                           { client: 'keyv',          type: 'cache' },
  'lru-cache':                      { client: 'lru-cache',     type: 'cache' },
  // Additional HTTP clients
  'ofetch':                         { client: 'ofetch',        type: 'http' },
  'wretch':                         { client: 'wretch',        type: 'http' },
  '@hapi/wreck':                    { client: 'wreck',         type: 'http' },
};

// ─── Local proxy / transitive source detection ──────────────────────────────

/**
 * Build a map from absolute file path → LibraryEntry for every file that
 * imports a registered library, **directly or transitively**.
 *
 * This is intentionally pattern-agnostic: it doesn't care HOW the library is
 * re-exported (thin proxy, spread, named re-export, ES module `export *`, etc.).
 * Any file that contains an import from a registered package is marked as a
 * "source" of that library, and those sources propagate transitively:
 *
 *   @company/pkg  ←  utils/wrapper/dcq.js  ←  utils/api/service.js  ←  handler.js
 *
 * All four files end up in the map, so `require('./utils/wrapper/dcq')` in ANY
 * of them is resolved back to the registered library entry.
 *
 * Multi-level chains are handled by iterating until the map stabilises.
 * When a file imports multiple registered libraries the first one found is used
 * (a single file rarely proxies more than one client).
 */
function buildTransitiveSourceMap(
  filePaths: string[],
  extra: Record<string, LibraryEntry>
): { directMap: Map<string, LibraryEntry>; transitiveMap: Map<string, LibraryEntry> } {
  const transitiveMap = new Map<string, LibraryEntry>(); // filePath → LibraryEntry

  // Read all files once — avoid re-reading per pass.
  // Strip comments first so `from 'pkg'` inside JSDoc/block comments
  // doesn't pollute the source map with false library associations.
  const cache = new Map<string, string>();
  for (const fp of filePaths) {
    if (!fp || !/\.(js|ts|mjs|cjs|mts|cts)$/.test(fp)) continue;
    try { cache.set(fp, stripComments(fs.readFileSync(fp, 'utf8'))); } catch { /* unreadable */ }
  }

  // Matches BOTH  require('pkg')  and  from 'pkg' / from "pkg"
  // (covers CJS require, ESM import, dynamic import, re-export)
  const IMPORT_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\s)from\s+['"]([^'"]+)['"]/gm;

  const extractPkgs = (content: string): string[] => {
    const pkgs: string[] = [];
    for (const m of content.matchAll(IMPORT_RE)) {
      pkgs.push(m[1] ?? m[2]);
    }
    return pkgs;
  };

  // Pass 1 — files that directly import a registered package.
  // Only these go into the directMap used for alias resolution, so that
  // Phase-2 wrapper files (e.g. getRecordingList.js importing avs.js) do not
  // propagate further aliases into their own importers (e.g. index.js).
  // This prevents false positives like `getRecordingList.execute()` being
  // mistakenly flagged as an external call in index.js.
  const directMap = new Map<string, LibraryEntry>();
  for (const [fp, content] of cache) {
    for (const pkg of extractPkgs(content)) {
      if (!pkg.startsWith('.')) {
        const entry = lookupLibrary(pkg, extra);
        if (entry) { directMap.set(fp, entry); transitiveMap.set(fp, entry); break; }
      }
    }
  }

  // Pass 2+ — propagate transitively via relative imports.
  // Repeat until no new files are added (handles arbitrary chain depth).
  // transitiveMap is used only to determine which files to scan; alias
  // resolution in buildAliasMap uses directMap only.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fp, content] of cache) {
      if (transitiveMap.has(fp)) continue;
      const dir = path.dirname(fp);
      for (const pkg of extractPkgs(content)) {
        if (pkg.startsWith('.')) {
          const resolved = resolveRelativeImport(dir, pkg);
          if (resolved && transitiveMap.has(resolved)) {
            transitiveMap.set(fp, transitiveMap.get(resolved)!);
            changed = true;
            break;
          }
        }
      }
    }
  }

  return { directMap, transitiveMap };
}

/**
 * Resolve a relative require/import path to an absolute file path.
 * Follows Node.js module resolution:
 *   1. Exact path
 *   2. Path + known extension (.js, .ts, .cjs, …)
 *   3. Path as a directory  →  path/index.<ext>
 */
function resolveRelativeImport(
  importingFileDir: string,
  relativePkg: string
): string | undefined {
  const base = path.resolve(importingFileDir, relativePkg);
  const exts = ['.js', '.ts', '.cjs', '.mjs', '.cts', '.mts'];

  // 1. Exact path (already has extension)
  try { fs.accessSync(base); return base; } catch { /* next */ }

  // 2. Append known extensions
  for (const ext of exts) {
    try { fs.accessSync(base + ext); return base + ext; } catch { /* next */ }
  }

  // 3. Directory index  —  require('./utils')  →  utils/index.js
  for (const ext of exts) {
    const idx = path.join(base, 'index' + ext);
    try { fs.accessSync(idx); return idx; } catch { /* next */ }
  }

  return undefined;
}

/**
 * Remove single-line (//) and block (/* *\/) comments from source text.
 * Keeps line numbers intact so snippet line numbers remain accurate.
 * Not a full parser — good enough for static import scanning.
 */
function stripComments(src: string): string {
  // Block comments: replace content with spaces to preserve offsets
  let out = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  // Single-line comments
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

// ─── Import alias extraction ──────────────────────────────────────────────────

/**
 * First pass: scan for import/require statements and build a map of
 * `localName → LibraryEntry` for every name that resolves to a known library.
 *
 * Handles:
 *   import lib from 'pkg'
 *   import * as lib from 'pkg'
 *   import lib, { Named } from 'pkg'
 *   import { Client, Pool } from 'pkg'
 *   import { Client as Alias } from 'pkg'
 *   const/let/var lib = require('pkg')
 *   const/let/var { Client } = require('pkg')
 *   Relative imports resolved transitively via proxyFileMap
 */
function buildAliasMap(
  content: string,
  extra: Record<string, LibraryEntry>,
  currentFilePath?: string,
  proxyFileMap?: Map<string, LibraryEntry>
): Map<string, LibraryEntry> {
  const map = new Map<string, LibraryEntry>();
  const fileDir = currentFilePath ? path.dirname(currentFilePath) : undefined;

  const registerAlias = (localName: string, packageName: string): void => {
    const pkg = packageName.replace(/^['"]|['"]$/g, '');
    let entry = lookupLibrary(pkg, extra);
    // Relative import (e.g. '../../utils/wrapper/request/dcq') — check if the
    // target file is a known proxy for a registered package.
    if (!entry && pkg.startsWith('.') && fileDir && proxyFileMap?.size) {
      const resolved = resolveRelativeImport(fileDir, pkg);
      if (resolved) entry = proxyFileMap.get(resolved);
    }
    if (entry) map.set(localName.trim(), entry);
  };

  // import defaultExport from 'pkg'
  // import * as ns from 'pkg'
  for (const m of content.matchAll(/^import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+(['"][^'"]+['"])/gm)) {
    registerAlias(m[1], m[2]);
  }

  // import defaultExport, { Named } from 'pkg'  — combined default+named form
  for (const m of content.matchAll(/^import\s+(\w+)\s*,\s*\{[^}]*\}\s+from\s+(['"][^'"]+['"])/gm)) {
    registerAlias(m[1], m[2]);
  }

  // import { Name, Other as Alias } from 'pkg'
  // import defaultExport, { Name, Other as Alias } from 'pkg'  (named part)
  for (const m of content.matchAll(/^import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+(['"][^'"]+['"])/gm)) {
    const pkg = m[2];
    for (const spec of m[1].split(',')) {
      // "Client as alias" or just "Client"
      const parts = spec.trim().split(/\s+as\s+/);
      const localName = (parts[1] ?? parts[0]).trim();
      if (/^\w+$/.test(localName)) registerAlias(localName, pkg);
    }
  }

  // const/let/var lib = require('pkg')   or   = require('pkg').something
  for (const m of content.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*(['"][^'"]+['"])\s*\)/gm)) {
    registerAlias(m[1], m[2]);
  }

  // const/let/var { Client } = require('pkg')
  for (const m of content.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*(['"][^'"]+['"])\s*\)/gm)) {
    const pkg = m[2];
    for (const spec of m[1].split(',')) {
      const localName = spec.trim().split(/\s+as\s+/).pop()!.trim();
      if (/^\w+$/.test(localName)) registerAlias(localName, pkg);
    }
  }

  return map;
}

/**
 * Second pass: resolve secondary aliases that weren't visible from imports alone.
 *
 * Handles:
 *   const prisma   = new PrismaClient()          — constructor instantiation
 *   const pool     = mysql.createPool(...)        — factory method
 *   const client   = axios.create({...})          — derived client (axios, got, etc.)
 *   private http: HttpService                     — TypeScript constructor/property injection
 *   private readonly repo: Repository<User>       — TypeORM injected repository
 *   @Inject(TOKEN) private svc: SomeService       — NestJS @Inject decorator
 */
function resolveSecondaryAliases(content: string, aliasMap: Map<string, LibraryEntry>): void {
  // const x = new KnownClass()
  for (const m of content.matchAll(/\bconst\s+(\w+)\s*=\s*new\s+(\w+)\s*[(<]/gm)) {
    propagate(aliasMap, m[2], m[1]);
  }

  // const x = knownObj.createXxx(...)  or  knownObj.create(...)
  for (const m of content.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+)\s*\.\s*create\w*\s*\(/gm)) {
    propagate(aliasMap, m[2], m[1]);
  }

  // TypeScript typed declarations — catches all of:
  //   private http: HttpService
  //   private readonly db: PrismaClient
  //   constructor(..., private repo: Repository<User>, ...)
  //   @Inject(X) private svc: SomeService
  //   protected client: AxiosInstance
  for (const m of content.matchAll(
    /(?:private|protected|public|readonly)(?:\s+(?:private|protected|public|readonly))*\s+(\w+)\s*[?!]?:\s*(\w+)/gm
  )) {
    propagate(aliasMap, m[2], m[1]);
  }

  // Also track `this.x = new KnownClass()` (assignment in constructor body)
  for (const m of content.matchAll(/\bthis\.(\w+)\s*=\s*new\s+(\w+)\s*[(<]/gm)) {
    propagate(aliasMap, m[2], m[1]);
  }
}

/** If `sourceName` is a known alias, register `targetName` with the same entry. */
function propagate(aliasMap: Map<string, LibraryEntry>, sourceName: string, targetName: string): void {
  const entry = aliasMap.get(sourceName);
  if (entry && !aliasMap.has(targetName)) {
    aliasMap.set(targetName, entry);
  }
}

function lookupLibrary(packageName: string, extra: Record<string, LibraryEntry>): LibraryEntry | undefined {
  if (extra[packageName])            return extra[packageName];
  if (LIBRARY_REGISTRY[packageName]) return LIBRARY_REGISTRY[packageName];
  // Scoped package with sub-path: '@prisma/client/edge' → '@prisma/client'
  const slash = packageName.indexOf('/', packageName.startsWith('@') ? 1 : 0);
  if (slash > 0) {
    const base = packageName.slice(0, slash);
    if (extra[base])            return extra[base];
    if (LIBRARY_REGISTRY[base]) return LIBRARY_REGISTRY[base];
  }
  return undefined;
}

// ─── Call-site detection ──────────────────────────────────────────────────────

const IMPORT_LINE = /^(?:import\s|const\s+\w+\s*=\s*require)/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function detectCallsInContent(
  filePath: string,
  lines: string[],
  aliasMap: Map<string, LibraryEntry>
): ExternalCall[] {
  const results: ExternalCall[] = [];

  // Pre-build per-alias regex to avoid recompiling on every line
  const aliasPatterns: Array<{ re: RegExp; entry: LibraryEntry }> = [];
  for (const [alias, entry] of aliasMap) {
    // Match alias used as a callable: alias( or alias.method( or new alias(
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    aliasPatterns.push({ re: new RegExp(`\\b${escaped}\\s*[.(]|new\\s+${escaped}\\s*\\(`), entry });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || COMMENT_LINE.test(trimmed) || IMPORT_LINE.test(trimmed)) continue;

    for (const { re, entry } of aliasPatterns) {
      if (re.test(line)) {
        results.push({
          type: entry.type,
          client: entry.client,
          filePath,
          line: i + 1,
          snippet: trimmed.slice(0, 120),
        });
        break; // one match per line is enough
      }
    }
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a set of source files for external library calls.
 *
 * Strategy:
 *   1. Parse each file's import/require statements to discover what alias the
 *      developer actually gave to each library (e.g. `import ax from 'axios'`).
 *   2. Resolve secondary aliases from constructor assignments
 *      (e.g. `const prisma = new PrismaClient()`).
 *   3. Scan every non-import, non-comment line for uses of those aliases.
 *
 * This avoids false positives from generic method names and handles
 * any import alias the developer chooses.
 *
 * @param userLibraries  Extra entries from `.http-forge/node-api-forge.config.json`.
 */
export function detectExternalCalls(
  filePaths: string[],
  userLibraries: ExternalCallLibraryConfig[] = []
): ExternalCall[] {
  // Build extra lookup from user-supplied config
  const extra: Record<string, LibraryEntry> = {};
  for (const cfg of userLibraries) {
    if (cfg.package && cfg.client && cfg.type) {
      extra[cfg.package] = { client: cfg.client, type: cfg.type };
    }
  }

  // Pre-scan: build a transitive source map — any file that imports a registered
  // package (directly or via a chain of relative imports) is recorded so that
  // relative imports of it can be resolved back to the library entry.
  // directMap (Phase 1 only) is used for alias resolution to avoid false
  // positives where a business-logic module importing a wrapper gets
  // its own methods mistakenly flagged as external calls.
  const { directMap } = buildTransitiveSourceMap(filePaths, extra);

  const results: ExternalCall[] = [];

  for (const filePath of filePaths) {
    if (!filePath || !/\.(ts|js|mts|mjs|cts|cjs)$/.test(filePath)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const aliasMap = buildAliasMap(content, extra, filePath, directMap);
    if (aliasMap.size === 0) continue; // file doesn't import any known library

    resolveSecondaryAliases(content, aliasMap);

    const lines = content.split('\n');
    results.push(...detectCallsInContent(filePath, lines, aliasMap));
  }

  // Deduplicate: same file + line + client
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.filePath}:${r.line}:${r.client}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}
