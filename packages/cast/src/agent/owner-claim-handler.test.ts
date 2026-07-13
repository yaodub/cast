/**
 * Unit tests for the owner-claim handler.
 *
 * The handler is the host-side terminal for the `owner-claim` control packet:
 * redeem the bearer code, bind the redeemer as owner on success, ack either way.
 * `setOwner` (the acl.json write) is spied so these stay pure-unit (no disk).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth/acl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/acl.js')>()),
  setOwner: vi.fn(),
}));
import { setOwner } from '../auth/acl.js';

import { handleOwnerClaim, type OwnerClaimDeps } from './owner-claim-handler.js';

function makeDeps(redeemResult: boolean) {
  const routeMessage = vi.fn();
  const redeem = vi.fn(() => redeemResult);
  const deps = {
    agentId: 'a:self@iss',
    folder: 'self',
    bus: { routeMessage },
    agentDb: { ownerClaims: { redeem } },
  } as unknown as OwnerClaimDeps;
  return { deps, routeMessage, redeem };
}

const lastAck = (routeMessage: ReturnType<typeof vi.fn>): string =>
  routeMessage.mock.calls.at(-1)?.[2]?.pkt?.text ?? '';

describe('handleOwnerClaim', () => {
  beforeEach(() => vi.mocked(setOwner).mockClear());

  it('binds the redeemer as owner on a valid code and acks success', () => {
    const { deps, routeMessage, redeem } = makeDeps(true);
    handleOwnerClaim(deps, 'u:alice@iss', { code: 'abc123', channel: 'room' });
    expect(redeem).toHaveBeenCalledWith('abc123', 'u:alice@iss');
    expect(setOwner).toHaveBeenCalledWith('self', 'u:alice@iss', 'room');
    expect(routeMessage).toHaveBeenCalledWith(
      'a:self@iss', 'u:alice@iss',
      expect.objectContaining({ channel: 'room', pkt: expect.objectContaining({ text: expect.stringContaining('owner') }) }),
    );
    expect(lastAck(routeMessage)).toMatch(/You are now the owner/);
  });

  it('strips a compound handle suffix before binding the bare identity', () => {
    const { deps } = makeDeps(true);
    handleOwnerClaim(deps, 'u:alice@iss/tg:111', { code: 'abc123', channel: 'room' });
    expect(setOwner).toHaveBeenCalledWith('self', 'u:alice@iss', 'room');
  });

  it('defaults the approval channel to "default" when the claim carries none', () => {
    const { deps } = makeDeps(true);
    handleOwnerClaim(deps, 'u:alice@iss', { code: 'abc123' });
    expect(setOwner).toHaveBeenCalledWith('self', 'u:alice@iss', 'default');
  });

  it('does not bind an owner on an invalid/expired/replayed code, and acks failure', () => {
    const { deps, routeMessage } = makeDeps(false);
    handleOwnerClaim(deps, 'u:alice@iss', { code: 'nope', channel: 'room' });
    expect(setOwner).not.toHaveBeenCalled();
    expect(lastAck(routeMessage)).toMatch(/invalid or has expired/);
  });

  it('rejects a non-user claimer without touching the store (operator is already god-mode)', () => {
    const { deps, routeMessage, redeem } = makeDeps(true);
    handleOwnerClaim(deps, 'cli:operator', { code: 'abc123', channel: 'room' });
    expect(redeem).not.toHaveBeenCalled();
    expect(setOwner).not.toHaveBeenCalled();
    expect(lastAck(routeMessage)).toMatch(/invalid or has expired/);
  });

  it('rejects an agent claimer (only humans hold the owner role)', () => {
    const { deps, redeem } = makeDeps(true);
    handleOwnerClaim(deps, 'a:other@iss', { code: 'abc123', channel: 'room' });
    expect(redeem).not.toHaveBeenCalled();
    expect(setOwner).not.toHaveBeenCalled();
  });
});
