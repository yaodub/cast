/**
 * Tests for the shared lifecycle writer at `console/shared/lifecycle.ts`.
 * Covers the bit-flip in both directions, idempotency, audit metadata, and
 * the SM review-request primed-message template.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-lifecycle-test-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
  };
});

import {
  buildReviewRequestMessage,
  setLifecycle,
} from './console/shared/lifecycle.js';

function seedAgent(folder: string, manifest: Record<string, unknown>): void {
  const dir = path.join(TMP_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function readManifest(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TMP_ROOT, folder, 'manifest.json'), 'utf-8'));
}

function readChangelog(folder: string): Record<string, unknown>[] {
  const p = path.join(TMP_ROOT, folder, 'state', 'admin-changelog.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('setLifecycle', () => {
  it('flips draft → ready by removing the status field', () => {
    const folder = 'flip-fwd';
    seedAgent(folder, { spec: '1.0.0', name: 'flip-fwd', status: 'draft' });

    const result = setLifecycle(folder, 'ready', {
      actor: 'security-manager',
      via: 'sm_review',
      requested_by: 'local',
      posture_summary: 'No findings; one paired user noted.',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.from).toBe('draft');
    expect(result.to).toBe('ready');
    expect(result.noop).toBe(false);

    const manifest = readManifest(folder);
    expect(manifest.status).toBeUndefined();
    expect(manifest.name).toBe('flip-fwd');

    const log = readChangelog(folder);
    expect(log).toHaveLength(1);
    expect(log[0].actor).toBe('security-manager');
    expect(log[0].action).toBe('set_lifecycle');
    expect(log[0].from).toBe('draft');
    expect(log[0].to).toBe('ready');
    expect(log[0].via).toBe('sm_review');
    expect(log[0].requested_by).toBe('local');
    expect(log[0].posture_summary).toBe('No findings; one paired user noted.');
  });

  it('flips ready → draft by adding status: draft', () => {
    const folder = 'flip-rev';
    seedAgent(folder, { spec: '1.0.0', name: 'flip-rev' });

    const result = setLifecycle(folder, 'draft', {
      actor: 'console',
      via: 'design_revert',
      reason: 'major rewrite incoming',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.from).toBe('ready');
    expect(result.to).toBe('draft');
    expect(result.noop).toBe(false);

    const manifest = readManifest(folder);
    expect(manifest.status).toBe('draft');

    const log = readChangelog(folder);
    expect(log).toHaveLength(1);
    expect(log[0].via).toBe('design_revert');
    expect(log[0].reason).toBe('major rewrite incoming');
    expect(log[0].requested_by).toBeUndefined();
    expect(log[0].posture_summary).toBeUndefined();
  });

  it('is idempotent — no manifest write, no changelog entry on noop', () => {
    const folder = 'noop';
    seedAgent(folder, { spec: '1.0.0', name: 'noop', status: 'draft' });

    const result = setLifecycle(folder, 'draft', {
      actor: 'local',
      via: 'manual_override',
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.noop).toBe(true);
    expect(result.from).toBe('draft');
    expect(result.to).toBe('draft');

    expect(readChangelog(folder)).toHaveLength(0);
  });

  it('returns an error when manifest.json is missing', () => {
    const result = setLifecycle('nonexistent-agent', 'ready', {
      actor: 'local',
      via: 'manual_override',
    });
    expect('error' in result).toBe(true);
  });

  it('tags via: manual_override correctly', () => {
    const folder = 'override';
    seedAgent(folder, { spec: '1.0.0', name: 'override', status: 'draft' });

    setLifecycle(folder, 'ready', { actor: 'local', via: 'manual_override' });
    const log = readChangelog(folder);
    expect(log[0].via).toBe('manual_override');
    expect(log[0].actor).toBe('local');
  });
});

describe('buildReviewRequestMessage', () => {
  it('is exactly the trigger header — folder + change_id, no procedural body', () => {
    const msg = buildReviewRequestMessage('my-agent', 'review-123');
    expect(msg).toBe('[Review request — agent: my-agent, change_id: review-123]');
  });
});
