/**
 * Tests for loadSecrets / loadSettings — the service snapshot reads. Both
 * branches: a well-formed file loads, every degraded shape (missing, invalid
 * JSON, non-object, wrongly-typed values) degrades to a safe partial/empty
 * record so a service can always start before the operator has configured it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSecrets, loadSettings, parseCallMeta } from './service.js';

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-secrets-'));
  fs.mkdirSync(path.join(agentDir, 'config', 'ext', 'service'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

function writeSecrets(content: string): void {
  fs.writeFileSync(path.join(agentDir, 'config', 'ext', 'service', 'secrets.json'), content);
}

describe('loadSecrets — load branch', () => {
  it('loads a flat string map from config/ext/service/secrets.json', () => {
    writeSecrets(JSON.stringify({ HN_USERNAME: 'alice', HN_PASSWORD: 'test-secret' }));
    expect(loadSecrets(agentDir)).toEqual({ HN_USERNAME: 'alice', HN_PASSWORD: 'test-secret' });
  });

  it('keeps string values and drops non-string ones from a mixed file', () => {
    writeSecrets(JSON.stringify({ GOOD: 'value', PORT: 993, NESTED: { a: 1 }, FLAG: true }));
    expect(loadSecrets(agentDir)).toEqual({ GOOD: 'value' });
  });
});

describe('loadSecrets — degraded branch', () => {
  it('returns {} when the file is missing', () => {
    expect(loadSecrets(agentDir)).toEqual({});
  });

  it('returns {} when the agent dir itself is missing', () => {
    expect(loadSecrets(path.join(agentDir, 'no-such-agent'))).toEqual({});
  });

  it('returns {} on invalid JSON (mid-edit save)', () => {
    writeSecrets('{ "HN_USERNAME": "ali');
    expect(loadSecrets(agentDir)).toEqual({});
  });

  it('returns {} on a non-object root (array, string)', () => {
    writeSecrets('["not", "a", "map"]');
    expect(loadSecrets(agentDir)).toEqual({});
    writeSecrets('"just a string"');
    expect(loadSecrets(agentDir)).toEqual({});
  });
});

describe('loadSettings', () => {
  function writeSettings(content: string): void {
    fs.writeFileSync(path.join(agentDir, 'config', 'ext', 'service', 'config.json'), content);
  }

  it('loads string, number, and boolean values from config/ext/service/config.json', () => {
    writeSettings(JSON.stringify({ MODE: 'fast', INTERVAL: 30, DRY_RUN: true }));
    expect(loadSettings(agentDir)).toEqual({ MODE: 'fast', INTERVAL: 30, DRY_RUN: true });
  });

  it('drops objects, arrays, and nulls from a mixed file', () => {
    writeSettings(JSON.stringify({ GOOD: 1, NESTED: { a: 1 }, LIST: [1], NOPE: null }));
    expect(loadSettings(agentDir)).toEqual({ GOOD: 1 });
  });

  it('returns {} when the file is missing or invalid', () => {
    expect(loadSettings(agentDir)).toEqual({});
    writeSettings('{ broken');
    expect(loadSettings(agentDir)).toEqual({});
  });
});

describe('parseCallMeta — host-attested _meta extraction', () => {
  it('reads the canonical wire keys (participant, channelName, conversationKey)', () => {
    const extra = { _meta: { participant: 'user@host', channelName: 'telegram', conversationKey: 'k1' } };
    expect(parseCallMeta(extra)).toEqual({ participant: 'user@host', channelName: 'telegram', conversationKey: 'k1' });
  });

  it('uses channelName, not the host-side `channel` key — a `channel`-only _meta yields no channelName', () => {
    // The runner stamps `channelName`; a stray `channel` is an unknown key and is ignored.
    expect(parseCallMeta({ _meta: { participant: 'p', channel: 'should-be-ignored' } }))
      .toEqual({ participant: 'p' });
  });

  it('degrades to {} when _meta is absent or malformed (no participant ⇒ approval fails closed)', () => {
    expect(parseCallMeta(undefined)).toEqual({});
    expect(parseCallMeta({})).toEqual({});
    expect(parseCallMeta({ _meta: { participant: 42 } })).toEqual({});
  });
});
