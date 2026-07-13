/**
 * Unit tests for the user↔user push grant store. The pushee's in-band
 * consent writes a directional, channel-scoped `(pusher → pushee)` grant straight
 * into config/user-push.json. Both branches per gate-test discipline: a granted
 * edge, a tombstoned edge, and the askable default.
 *
 * Real-fs against a throwaway agent folder (mirrors the acl-edge-writers tests).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

import { agentPath } from '../config.js';
import { userPushVerdict, grantUserPush, tombstoneUserPush } from './user-push-store.js';

const FOLDER = 'user-push-store-test-fixture';
const PUSHER = 'u:alice@iss';
const PUSHEE = 'u:bob@iss';

beforeEach(() => {
  fs.rmSync(agentPath(FOLDER, 'config', 'user-push.json'), { force: true });
});

describe('user-push store — verdict / grant / tombstone', () => {
  it('an undecided edge is askable (no file = the pushee can still be asked)', () => {
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('askable');
  });

  it('grantUserPush makes the edge granted', () => {
    grantUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('granted');
  });

  it('tombstoneUserPush makes the edge rejected', () => {
    tombstoneUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('rejected');
  });

  it('grant clears a prior tombstone, and tombstone clears a prior grant (one terminal state)', () => {
    tombstoneUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    grantUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('granted');
    tombstoneUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('rejected');
  });

  it('is directional — granting A→B does not grant B→A', () => {
    grantUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'default', PUSHEE, PUSHER)).toBe('askable');
  });

  it('is channel-scoped — a grant on one channel does not leak to another', () => {
    grantUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    expect(userPushVerdict(FOLDER, 'ops', PUSHER, PUSHEE)).toBe('askable');
  });

  it('normalizes transport suffixes — the grant keys on bare identity', () => {
    grantUserPush(FOLDER, 'default', `${PUSHER}/tg:1`, `${PUSHEE}/web:x`);
    expect(userPushVerdict(FOLDER, 'default', PUSHER, PUSHEE)).toBe('granted');
  });

  it('clearing the last edge prunes empty maps (store stays sparse)', () => {
    grantUserPush(FOLDER, 'default', PUSHER, PUSHEE);
    tombstoneUserPush(FOLDER, 'default', PUSHER, PUSHEE); // moves to rejected, clears approved
    const store = JSON.parse(fs.readFileSync(agentPath(FOLDER, 'config', 'user-push.json'), 'utf-8'));
    expect(store.approved).toEqual({}); // the approved side pruned to empty
    expect(store.rejected).toEqual({ default: { [PUSHER]: { [PUSHEE]: true } } });
  });
});
