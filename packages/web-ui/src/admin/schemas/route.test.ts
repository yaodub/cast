/**
 * Route payload transformer — the list the mutation receives.
 *
 * The server pairs each submitted row with its stored entry by address +
 * channel, so a payload that moves rows around is no longer a correctness
 * problem. Order is still operator-visible (it is the table), and an edit that
 * teleports its row to the bottom of the list on every save is not what anyone
 * asked for. These pin add / edit / remove against the row positions.
 */
import { describe, expect, it } from 'vitest';

import { routesFormToPayload, routesRemovePayload, type RoutesServerData, type RouteDraft } from './route';

const entry = (address: string, token: string) => ({
  address,
  channel: null,
  online: true,
  summary: token,
  fields: { token },
});

const DATA: RoutesServerData = {
  byType: {
    telegram: [entry('agent-a', '••••aaa1'), entry('agent-b', '••••bbb2'), entry('agent-c', '••••ccc3')],
    testmail: [{ address: 'alice', channel: 'inbox', online: false, summary: '', fields: { imapPass: '••••e-pw' } }],
  },
};

const draft = (type: string, address: string, fields: Record<string, string>): RouteDraft => ({
  type, address, channel: '', fields,
});

const addressesOf = (payload: { byType: Record<string, Array<{ address: string }>> }, type: string) =>
  (payload.byType[type] ?? []).map((e) => e.address);

describe('routesFormToPayload', () => {
  it('replaces the edited row where it sits', () => {
    const payload = routesFormToPayload(DATA, draft('telegram', 'agent-a', { token: 'fresh-token' }), { type: 'telegram', idx: 0 });

    expect(addressesOf(payload, 'telegram')).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(payload.byType.telegram![0]!.fields).toEqual({ token: 'fresh-token' });
    // The rows nobody touched go back exactly as they came, masks and all.
    expect(payload.byType.telegram!.slice(1).map((e) => e.fields)).toEqual([{ token: '••••bbb2' }, { token: '••••ccc3' }]);
  });

  it('carries a re-addressed row at its own position', () => {
    const payload = routesFormToPayload(DATA, draft('telegram', 'renamed', { token: 'fresh-token' }), { type: 'telegram', idx: 1 });

    expect(addressesOf(payload, 'telegram')).toEqual(['agent-a', 'renamed', 'agent-c']);
  });

  it('appends a new row and leaves every existing one in place', () => {
    const payload = routesFormToPayload(DATA, draft('telegram', 'new-agent', { token: 'fresh-token' }), null);

    expect(addressesOf(payload, 'telegram')).toEqual(['agent-a', 'agent-b', 'agent-c', 'new-agent']);
  });

  it('seeds the list for a transport with no routes yet', () => {
    const payload = routesFormToPayload({ byType: {} }, draft('telegram', 'first-agent', { token: 'fresh-token' }), null);

    expect(addressesOf(payload, 'telegram')).toEqual(['first-agent']);
  });

  it('moves the row between transports when the type changes under an edit', () => {
    const payload = routesFormToPayload(DATA, draft('testmail', 'agent-a', { imapPass: 'pw' }), { type: 'telegram', idx: 0 });

    expect(addressesOf(payload, 'telegram')).toEqual(['agent-b', 'agent-c']);
    expect(addressesOf(payload, 'testmail')).toEqual(['alice', 'agent-a']);
  });

  it('leaves the other transports untouched', () => {
    const payload = routesFormToPayload(DATA, draft('telegram', 'agent-a', { token: 'fresh-token' }), { type: 'telegram', idx: 0 });

    expect(payload.byType.testmail).toEqual([{ address: 'alice', channel: 'inbox', fields: { imapPass: '••••e-pw' } }]);
  });
});

describe('routesRemovePayload', () => {
  it('drops one row and keeps the rest in order', () => {
    const payload = routesRemovePayload(DATA, 'telegram', 1);

    expect(addressesOf(payload, 'telegram')).toEqual(['agent-a', 'agent-c']);
    expect(payload.byType.telegram!.map((e) => e.fields)).toEqual([{ token: '••••aaa1' }, { token: '••••ccc3' }]);
  });
});
