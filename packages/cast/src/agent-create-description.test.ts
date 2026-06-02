/**
 * Tests for the optional `description` seed in `createAgentScratch` — the
 * create-time path Design Manager uses to populate the manifest one-liner.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-create-desc-test-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, AGENTS_DIR: TMP_ROOT };
});

import { createAgentScratch } from './admin/agent-create.js';

function readManifest(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TMP_ROOT, folder, 'manifest.json'), 'utf-8'));
}

describe('createAgentScratch description seed', () => {
  it('writes the description into the manifest when provided', () => {
    createAgentScratch('with-desc', 'Triages inbound mail');
    const m = readManifest('with-desc');
    expect(m.description).toBe('Triages inbound mail');
    expect(m.name).toBe('with-desc');
    expect(m.status).toBe('draft');
  });

  it('omits the description field entirely when not provided', () => {
    createAgentScratch('no-desc');
    const m = readManifest('no-desc');
    expect('description' in m).toBe(false);
    expect(m.status).toBe('draft');
  });
});
