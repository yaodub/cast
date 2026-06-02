/**
 * Tests for `.husky/pre-commit` — Layer 4 of the console security policy.
 * Exercises the real hook script against a throwaway git repo so regressions
 * are caught in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK_PATH = path.resolve(__dirname, '../../../.husky/pre-commit');

describe('.husky/pre-commit', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hook-test-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    // Local identity so git commit --dry-run equivalents don't nag.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    // Seed a commit so diff --cached is meaningful.
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed');
    execFileSync('git', ['add', 'seed.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function runHook(env: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
    const result = spawnSync(HOOK_PATH, [], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  it('passes when no service/ files are staged', () => {
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# hi');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir });

    const result = runHook();
    expect(result.status).toBe(0);
  });

  it('fails when a service/ file is staged', () => {
    const serviceDir = path.join(repoDir, 'mnt/agents/foo/service/src');
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'index.ts'), 'export {};');
    execFileSync('git', ['add', '.'], { cwd: repoDir });

    const result = runHook();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mnt/agents/foo/service/src/index.ts');
    expect(result.stderr).toContain('CAST_ALLOW_SERVICE');
  });

  it('passes when CAST_ALLOW_SERVICE=1 is set', () => {
    const serviceDir = path.join(repoDir, 'mnt/agents/foo/service');
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'package.json'), '{}');
    execFileSync('git', ['add', '.'], { cwd: repoDir });

    const result = runHook({ CAST_ALLOW_SERVICE: '1' });
    expect(result.status).toBe(0);
  });

  it('ignores blueprint/ and config/ changes outside service/', () => {
    const dirs = ['mnt/agents/foo/blueprint', 'mnt/agents/foo/config'];
    for (const d of dirs) {
      const full = path.join(repoDir, d);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, 'x.json'), '{}');
    }
    execFileSync('git', ['add', '.'], { cwd: repoDir });

    const result = runHook();
    expect(result.status).toBe(0);
  });
});
