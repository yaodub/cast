import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./config.js', () => ({
  agentPath: (folder: string, ...segments: string[]) =>
    path.join('/tmp/test-agents', folder, ...segments),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => { throw new Error('not found'); }),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

import fs from 'fs';
import { readRoster, updateRoster } from './lib/identity-roster.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

beforeEach(() => {
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
  mockWriteFileSync.mockReset();
});

describe('readRoster', () => {
  it('returns empty object when file missing', () => {
    expect(readRoster('test')).toEqual({});
  });

  it('parses existing roster file', () => {
    const roster = { 'u:abc@srv': { name: 'Alice', handles: ['tg:12345'] } };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('identity-roster.json')) return JSON.stringify(roster);
      throw new Error('not found');
    });
    expect(readRoster('test')).toEqual(roster);
  });
});

describe('updateRoster', () => {
  it('creates new entry for unknown identity', () => {
    updateRoster('test', { id: 'u:abc@srv', declaredName: 'Alice', handle: 'tg:12345' });

    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
    expect(written['u:abc@srv']).toEqual({ name: 'Alice', handles: ['tg:12345'] });
  });

  it('updates existing entry, merges handles', () => {
    const existing = { 'u:abc@srv': { name: 'Alice', handles: ['tg:12345'] } };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('identity-roster.json')) return JSON.stringify(existing);
      throw new Error('not found');
    });

    updateRoster('test', { id: 'u:abc@srv', declaredName: 'Alicia', handle: 'tg:67890' });

    const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
    expect(written['u:abc@srv'].name).toBe('Alicia');
    expect(written['u:abc@srv'].handles).toContain('tg:12345');
    expect(written['u:abc@srv'].handles).toContain('tg:67890');
  });

  it('does not duplicate existing handles', () => {
    const existing = { 'u:abc@srv': { name: 'Alice', handles: ['tg:12345'] } };
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('identity-roster.json')) return JSON.stringify(existing);
      throw new Error('not found');
    });

    updateRoster('test', { id: 'u:abc@srv', declaredName: 'Alice', handle: 'tg:12345' });

    const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1] as string);
    expect(written['u:abc@srv'].handles).toEqual(['tg:12345']);
  });
});
