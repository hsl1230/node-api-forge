import * as fs from 'fs';
import * as path from 'path';
import { ApiFramework, FrameworkFingerprint } from './types';

const FINGERPRINT_FILES = [
  'package.json',
  'src/main.ts',
  'src/main.js',
  'src/app.ts',
  'src/app.js'
];

const DETECTION_HINTS: Record<ApiFramework, string[]> = {
  express: ['express', 'router.', 'app.use(', 'app.get(', 'express.Router'],
  nestjs: ['@nestjs/common', '@Controller(', '@Get(', '@Post('],
  fastify: ['fastify', 'fastify.route(', 'fastify.get(', 'register('],
  lambda: ['exports.handler', 'event.pathParameters', 'APIGatewayProxyEvent', 'aws-lambda'],
  unknown: []
};

export class FrameworkDetector {
  public buildFingerprint(projectRoot: string): FrameworkFingerprint {
    const evidenceFiles: string[] = [];
    const packageJsonPath = path.join(projectRoot, 'package.json');
    let packageJson: FrameworkFingerprint['packageJson'];

    for (const relative of FINGERPRINT_FILES) {
      const candidate = path.join(projectRoot, relative);
      if (fs.existsSync(candidate)) {
        evidenceFiles.push(candidate);
      }
    }

    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        packageJson = {
          dependencies: parsed.dependencies,
          devDependencies: parsed.devDependencies,
          scripts: parsed.scripts
        };
      } catch {
        // Keep fingerprint usable even if package.json cannot be parsed.
      }
    }

    return {
      projectRoot,
      packageJsonPath: fs.existsSync(packageJsonPath) ? packageJsonPath : undefined,
      packageJson,
      evidenceFiles
    };
  }

  public detectFrameworks(fingerprint: FrameworkFingerprint): ApiFramework[] {
    const found: ApiFramework[] = [];

    if (this.hasDependency(fingerprint, 'express') || this.hasSourceHint(fingerprint, 'express')) {
      found.push('express');
    }
    if (this.hasDependency(fingerprint, '@nestjs/common') || this.hasSourceHint(fingerprint, 'nestjs')) {
      found.push('nestjs');
    }
    if (this.hasDependency(fingerprint, 'fastify') || this.hasSourceHint(fingerprint, 'fastify')) {
      found.push('fastify');
    }

    const hasExpressOrFastify = found.includes('express') || found.includes('fastify');
    if (!hasExpressOrFastify) {
      const isLambdaDep =
        this.hasDependency(fingerprint, '@types/aws-lambda') ||
        this.hasDependency(fingerprint, 'aws-lambda') ||
        this.hasDependency(fingerprint, 'serverless');
      if (isLambdaDep || this.hasSourceHint(fingerprint, 'lambda')) {
        found.push('lambda');
      }
    }

    return found.length > 0 ? found : ['unknown'];
  }

  private hasDependency(fingerprint: FrameworkFingerprint, packageName: string): boolean {
    const deps = fingerprint.packageJson?.dependencies ?? {};
    const devDeps = fingerprint.packageJson?.devDependencies ?? {};
    return Boolean(deps[packageName] || devDeps[packageName]);
  }

  private hasSourceHint(fingerprint: FrameworkFingerprint, framework: Exclude<ApiFramework, 'unknown'>): boolean {
    const srcPath = path.join(fingerprint.projectRoot, 'src');
    if (!fs.existsSync(srcPath)) {
      return false;
    }

    const hints = DETECTION_HINTS[framework];
    const queue = [srcPath];
    let inspectedFiles = 0;
    const maxFiles = 120;

    while (queue.length > 0 && inspectedFiles < maxFiles) {
      const current = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || (!fullPath.endsWith('.ts') && !fullPath.endsWith('.js'))) {
          continue;
        }

        inspectedFiles += 1;
        let content = '';
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }

        if (hints.some((hint) => content.includes(hint))) {
          return true;
        }
      }
    }

    return false;
  }
}
