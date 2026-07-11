import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '__tests__',
  '__mocks__',
  '__fixtures__'
]);

// Files that are never route definitions — skip them to reduce parsing cost
const SKIP_FILE_RE = /\.(?:test|spec|stories|min)\.[cm]?[tj]sx?$|\.d\.[cm]?ts$/;

export function collectSourceFiles(projectRoot: string): string[] {
  const srcFiles: string[] = [];
  const queue = [projectRoot];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (SKIP_FILE_RE.test(entry.name)) {
        continue;
      }

      if (fullPath.endsWith('.ts') || fullPath.endsWith('.js')) {
        srcFiles.push(fullPath);
      }
    }
  }

  return srcFiles;
}
