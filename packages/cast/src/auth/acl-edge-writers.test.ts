/**
 * Unit tests for the single-store acl-edge writers — grantAclEdge / tombstoneAclEdge
 * (single ACL store). The owner-approved acl-edge approval writes its outcome
 * straight into config/acl.json (allowed / rejected); there is no separate reactive
 * store. Replaces the deleted reactive-acl store tests.
 *
 * Real-fs against a throwaway agent folder (mirrors the old reactive-acl tests).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

import { agentPath } from '../config.js';
import { grantAclEdge, tombstoneAclEdge, revokeAclEdge } from './acl.js';

const FOLDER = 'acl-edge-writers-test-fixture';

function readAcl(): { owner: string; allowed: Record<string, Record<string, string>>; rejected: Record<string, Record<string, string>>; approval_channel: string | null } {
  return JSON.parse(fs.readFileSync(agentPath(FOLDER, 'config', 'acl.json'), 'utf-8'));
}

beforeEach(() => {
  // Fresh acl.json per test — remove any file a prior test wrote.
  fs.rmSync(agentPath(FOLDER, 'config', 'acl.json'), { force: true });
});

describe('acl-edge writers — grantAclEdge / tombstoneAclEdge (single store)', () => {
  it('grantAclEdge creates acl.json and adds the bit to allowed', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    expect(readAcl().allowed).toEqual({ 'u:alice@iss': { default: 'a' } });
  });

  it('accumulates bits and channels for a peer', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'q');
    grantAclEdge(FOLDER, 'u:alice@iss', 'ops', 'a');
    expect(readAcl().allowed).toEqual({ 'u:alice@iss': { default: 'aq', ops: 'a' } });
  });

  it('is idempotent — granting the same bit twice does not duplicate it', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    expect(readAcl().allowed['u:alice@iss'].default).toBe('a');
  });

  it('grant and tombstone are mutually exclusive per edge', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    tombstoneAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    const acl = readAcl();
    expect(acl.rejected).toEqual({ 'u:alice@iss': { default: 'a' } });
    expect(acl.allowed).toEqual({});

    // Granting again withdraws the tombstone.
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    const acl2 = readAcl();
    expect(acl2.allowed).toEqual({ 'u:alice@iss': { default: 'a' } });
    expect(acl2.rejected).toEqual({});
  });

  it('revokeAclEdge plain-removes the (peer, channel) edge from allowed, leaving rejected untouched', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'io');
    grantAclEdge(FOLDER, 'u:alice@iss', 'ops', 'a');
    tombstoneAclEdge(FOLDER, 'u:bob@iss', 'default', 'a');

    revokeAclEdge(FOLDER, 'u:alice@iss', 'default');
    const acl = readAcl();
    // Only the default edge is gone; the ops grant and bob's tombstone survive.
    expect(acl.allowed).toEqual({ 'u:alice@iss': { ops: 'a' } });
    expect(acl.rejected).toEqual({ 'u:bob@iss': { default: 'a' } });

    // Removing the peer's last channel prunes the peer entirely.
    revokeAclEdge(FOLDER, 'u:alice@iss', 'ops');
    expect(readAcl().allowed).toEqual({});
  });

  it('revokeAclEdge is a no-op for a missing edge', () => {
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    revokeAclEdge(FOLDER, 'u:alice@iss', 'nonexistent');
    revokeAclEdge(FOLDER, 'u:ghost@iss', 'default');
    expect(readAcl().allowed).toEqual({ 'u:alice@iss': { default: 'a' } });
  });

  it('preserves owner, approval_channel, and unrelated edges already in the file', () => {
    fs.mkdirSync(agentPath(FOLDER, 'config'), { recursive: true });
    fs.writeFileSync(
      agentPath(FOLDER, 'config', 'acl.json'),
      JSON.stringify({ owner: 'u:owner@iss', approval_channel: 'ops', allowed: { 'u:bob@iss': { default: 'io' } } }),
    );
    grantAclEdge(FOLDER, 'u:alice@iss', 'default', 'a');
    const acl = readAcl();
    expect(acl.owner).toBe('u:owner@iss');
    expect(acl.approval_channel).toBe('ops');
    expect(acl.allowed['u:bob@iss']).toEqual({ default: 'io' });
    expect(acl.allowed['u:alice@iss']).toEqual({ default: 'a' });
  });
});
