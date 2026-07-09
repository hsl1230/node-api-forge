import * as fs from 'fs';

export type ExternalCallType = 'http' | 'database' | 'cache' | 'queue' | 'storage';

export interface ExternalCall {
  type: ExternalCallType;
  client: string;
  filePath: string;
  line: number;
  snippet: string;
}

/**
 * Patterns keyed by client name → { type, patterns[] }
 * Patterns are matched as substrings of trimmed source lines.
 */
const CLIENT_PATTERNS: Array<{ client: string; type: ExternalCallType; patterns: RegExp[] }> = [
  // HTTP clients
  { client: 'axios',      type: 'http',     patterns: [/axios\.(get|post|put|patch|delete|head|request)\s*\(/] },
  { client: 'fetch',      type: 'http',     patterns: [/\bfetch\s*\(/] },
  { client: 'got',        type: 'http',     patterns: [/\bgot\.(get|post|put|patch|delete|head|stream)\s*\(/] },
  { client: 'superagent', type: 'http',     patterns: [/superagent\.(get|post|put|patch|del)\s*\(/] },
  { client: 'node-fetch', type: 'http',     patterns: [/nodeFetch\s*\(|node_fetch\s*\(|require.*node-fetch/] },
  { client: 'undici',     type: 'http',     patterns: [/undici\.(fetch|request|stream|pipeline)\s*\(/] },
  { client: 'ky',         type: 'http',     patterns: [/\bky\.(get|post|put|patch|delete|head)\s*\(/] },
  { client: 'needle',     type: 'http',     patterns: [/needle\.(get|post|put|delete|request)\s*\(/] },
  { client: 'request',    type: 'http',     patterns: [/\brequest\s*\(\s*['"`{]/, /request\.(get|post|put|patch|delete)\s*\(/] },
  // Database clients
  { client: 'mongoose',   type: 'database', patterns: [/\.(find|findOne|findById|save|create|updateOne|updateMany|deleteOne|deleteMany|aggregate|lean)\s*\(/] },
  { client: 'prisma',     type: 'database', patterns: [/prisma\.\w+\.(findMany|findUnique|create|update|delete|upsert|aggregate|count)\s*\(/] },
  { client: 'knex',       type: 'database', patterns: [/knex\s*\(|db\s*\(|\.from\s*\(\s*['"`]|\.where\s*\(|\.select\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/] },
  { client: 'sequelize',  type: 'database', patterns: [/\.(findAll|findOne|findByPk|create|upsert|bulkCreate|update|destroy)\s*\(|sequelize\.query\s*\(/] },
  { client: 'pg',         type: 'database', patterns: [/\.(query|connect|end)\s*\(\s*['"`]/] },
  { client: 'mysql2',     type: 'database', patterns: [/connection\.(query|execute)\s*\(/] },
  { client: 'sqlite3',    type: 'database', patterns: [/db\.(run|get|all|each|exec)\s*\(/] },
  { client: 'typeorm',    type: 'database', patterns: [/repository\.(find|findOne|save|delete|update)\s*\(/] },
  // Cache
  { client: 'redis',      type: 'cache',    patterns: [/redis\.(get|set|del|hget|hset|lpush|rpop|expire)\s*\(/] },
  { client: 'ioredis',    type: 'cache',    patterns: [/ioredis\.(get|set|del|hget|hset|expire)\s*\(|\bclient\.(get|set|del)\s*\(/] },
  { client: 'memcached',  type: 'cache',    patterns: [/memcached\.(get|set|del|add|replace)\s*\(/] },
  { client: 'node-cache', type: 'cache',    patterns: [/cache\.(get|set|del|take|has)\s*\(/] },
  // Message queues
  { client: 'amqplib',    type: 'queue',    patterns: [/channel\.(sendToQueue|publish|consume|ack|nack)\s*\(/] },
  { client: 'bull',       type: 'queue',    patterns: [/queue\.(add|process|getJob)\s*\(|new Bull\s*\(/] },
  { client: 'kafkajs',    type: 'queue',    patterns: [/producer\.send\s*\(|consumer\.run\s*\(/] },
  // Cloud storage
  { client: 's3',         type: 'storage',  patterns: [/s3\.(putObject|getObject|deleteObject|listObjectsV2|upload)\s*\(/] },
  { client: 'gcs',        type: 'storage',  patterns: [/bucket\.(file|upload|download)\s*\(/] },
];

/**
 * Scan a set of source files for external call patterns.
 * Returns deduplicated findings sorted by file path + line.
 */
export function detectExternalCalls(filePaths: string[]): ExternalCall[] {
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

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // Skip comment-only lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }

      for (const entry of CLIENT_PATTERNS) {
        for (const pattern of entry.patterns) {
          if (pattern.test(line)) {
            results.push({
              type: entry.type,
              client: entry.client,
              filePath,
              line: i + 1,
              snippet: trimmed.slice(0, 120),
            });
            break; // Only record first matching pattern per client per line
          }
        }
      }
    }
  }

  // Deduplicate: same file + line may match multiple clients
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.filePath}:${r.line}:${r.client}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}
