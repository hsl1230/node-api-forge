import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameworkDetector } from './framework-detector';

const detector = new FrameworkDetector();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('FrameworkDetector', () => {
  it('detects express from dependencies', () => {
    const root = makeProject({ dependencies: { express: '^4.0.0' } });
    const fingerprint = detector.buildFingerprint(root);
    expect(detector.detectFrameworks(fingerprint)).toContain('express');
  });

  it('detects nestjs from source hints', () => {
    const root = makeProject({ dependencies: {} }, 'import { Controller, Get } from "@nestjs/common";\n@Controller()\nexport class UsersController {}');
    const fingerprint = detector.buildFingerprint(root);
    expect(detector.detectFrameworks(fingerprint)).toContain('nestjs');
  });

  it('detects fastify from source hints', () => {
    const root = makeProject({ dependencies: {} }, 'fastify.get("/users", handler)');
    const fingerprint = detector.buildFingerprint(root);
    expect(detector.detectFrameworks(fingerprint)).toContain('fastify');
  });
});

function makeProject(packageJson: Record<string, any>, srcContent = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-api-forge-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), srcContent);
  return root;
}
