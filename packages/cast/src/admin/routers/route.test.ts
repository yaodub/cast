/**
 * Route admin router — masked-secret resolution across a reordered, extended
 * or shortened submission.
 *
 * The admin page posts the whole route list on every save, and every secret
 * the operator didn't retype comes back masked. Pairing a submitted row with
 * its stored entry by array index used to hand each row its neighbour's
 * credential and destroy the last route's outright (see
 * `reproduces the production rotation` below). Pairing is by
 * identity now, so these tests drive the router the way the page does: read
 * through `list`, reproject, mutate one row, submit through `update`, with the
 * masks the server itself minted.
 *
 * Both-branches discipline for the mask gate: a mask backed by a stored entry
 * resolves to that entry's own secret AND a mask with nothing behind it (a new
 * route, a re-addressed one, a second row claiming a single stored entry) is
 * rejected with the file left untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { CONFIG_DIR } from '../../config.js';
import { _setMockWatcher, type WatcherLike } from '../../lib/config-reader.js';
import { registerTransport } from '../../transports/registry.js';
import { defineTransport } from '../../transports/schema.js';
import { telegram } from '../../transports/telegram.js';
import type { AdminDeps } from '../trpc.js';
import { routeRouter } from './route.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A transport with a nested secret path and a field the form never exposes —
 *  covers the lensing + carry-over half of the resolution that Telegram's
 *  single flat token doesn't. Shaped like email, without the IMAP client. */
const MailRouteSchema = z.object({
  address: z.string(),
  channel: z.string().optional(),
  imap: z.object({ host: z.string(), pass: z.string() }),
  whitelist: z.array(z.string()).default([]),
});

const testmail = defineTransport({
  name: 'testmail',
  addressPrefix: 'tm',
  configSchema: z.array(MailRouteSchema).default([]),
  admin: {
    displayLabel: 'Test Mail',
    fields: [
      { key: 'imapHost', path: 'imap.host', type: 'text', label: 'Host' },
      { key: 'imapPass', path: 'imap.pass', type: 'password', label: 'Password', secret: true },
    ],
    summarize: () => '',
  },
  create: () => null,
});

registerTransport(telegram);
registerTransport(testmail);

const ROUTES_PATH = path.join(CONFIG_DIR, 'routes.json');

const TOKEN_A = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAaaa1';
const TOKEN_B = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBbbb2';
const TOKEN_C = '333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCccc3';
const NEW_TOKEN = '444444:DDDDDDDDDDDDDDDDDDDDDDDDDDDDnew4';

/** Reads through to disk — `update` writes the file, and multi-step flows read
 *  back what the previous save left. Matches FileWatcher's missing-file null. */
class DiskWatcher implements WatcherLike {
  get(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

function makeCaller() {
  const deps = { getTransports: () => [] } as unknown as AdminDeps;
  return routeRouter.createCaller({ session: { token: 'test' }, deps, res: {} as never });
}

function seed(routes: Record<string, unknown[]>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ROUTES_PATH, JSON.stringify(routes, null, 2));
}

function tg(address: string, token: string, channel?: string): Record<string, unknown> {
  return channel ? { address, channel, token } : { address, token };
}

function storedRaw(): Record<string, Array<Record<string, unknown>>> {
  return JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf-8'));
}

/** [address, token] per stored telegram entry, in file order. */
function storedTokens(): Array<[string, unknown]> {
  return (storedRaw().telegram ?? []).map((e) => [String(e.address), e.token]);
}

type FormRow = { address: string; channel?: string; fields: Record<string, unknown> };
type Payload = { byType: Record<string, FormRow[]> };

/** Reproject `list` output into an update payload — what the admin page's
 *  `buildBasePayload` hands the mutation before the operator's one edit is
 *  applied on top. Secrets are the server's own masks. */
async function currentPayload(): Promise<Payload> {
  const listed = await makeCaller().list();
  const byType: Record<string, FormRow[]> = {};
  for (const [type, entries] of Object.entries(listed.byType)) {
    byType[type] = entries.map((e) => ({
      address: e.address,
      channel: e.channel ?? undefined,
      fields: { ...e.fields },
    }));
  }
  return { byType };
}

beforeEach(() => {
  _setMockWatcher(new DiskWatcher());
  fs.rmSync(ROUTES_PATH, { force: true });
});

// ---------------------------------------------------------------------------
// The production defect
// ---------------------------------------------------------------------------

describe('update — the row an operator edits', () => {
  beforeEach(() => {
    seed({ telegram: [tg('agent-a', TOKEN_A), tg('agent-b', TOKEN_B), tg('agent-c', TOKEN_C)] });
  });

  it('reproduces the production rotation: first of three edited, list submitted reordered', async () => {
    // The page used to splice the edited row out and append it, so the server
    // saw [agent-b, agent-c, agent-a-with-new-token]. By index, agent-b
    // inherited agent-a's stale token, agent-c inherited agent-b's, and
    // agent-c's own token had no row left to land in and was lost.
    const payload = await currentPayload();
    const rows = payload.byType.telegram!;
    const [edited] = rows.splice(0, 1);
    rows.push({ ...edited!, fields: { token: NEW_TOKEN } });

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['agent-b', TOKEN_B],
      ['agent-c', TOKEN_C],
      ['agent-a', NEW_TOKEN],
    ]);
  });

  it('takes the new secret and leaves the other two alone (edit in place)', async () => {
    const payload = await currentPayload();
    payload.byType.telegram![0]!.fields.token = NEW_TOKEN;

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['agent-a', NEW_TOKEN],
      ['agent-b', TOKEN_B],
      ['agent-c', TOKEN_C],
    ]);
  });

  it('keeps every secret when nothing is edited at all', async () => {
    await makeCaller().update(await currentPayload());

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-b', TOKEN_B],
      ['agent-c', TOKEN_C],
    ]);
  });

  it('keeps every secret when the list comes back reordered', async () => {
    const payload = await currentPayload();
    payload.byType.telegram!.reverse();

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['agent-c', TOKEN_C],
      ['agent-b', TOKEN_B],
      ['agent-a', TOKEN_A],
    ]);
  });

  it('leaves the survivors their own secrets when a middle route is removed', async () => {
    const payload = await currentPayload();
    payload.byType.telegram!.splice(1, 1);

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-c', TOKEN_C],
    ]);
  });

  it('leaves the existing routes untouched when one is added', async () => {
    const payload = await currentPayload();
    payload.byType.telegram!.push({ address: 'new-agent', fields: { token: NEW_TOKEN } });

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-b', TOKEN_B],
      ['agent-c', TOKEN_C],
      ['new-agent', NEW_TOKEN],
    ]);
  });

  it('clears the slice only when the payload says so, not when it omits the transport', async () => {
    await makeCaller().update({ byType: {} });
    expect(storedTokens()).toHaveLength(3);

    await makeCaller().update({ byType: { telegram: [] } });
    expect(storedRaw().telegram).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Channel is part of the identity
// ---------------------------------------------------------------------------

describe('update — same address on different channels', () => {
  it('resolves each channel against its own stored entry', async () => {
    seed({ telegram: [tg('agent-a', TOKEN_A, 'work'), tg('agent-a', TOKEN_B, 'home')] });

    const payload = await currentPayload();
    payload.byType.telegram!.reverse();

    await makeCaller().update(payload);

    expect(storedRaw().telegram).toMatchObject([
      { address: 'agent-a', channel: 'home', token: TOKEN_B },
      { address: 'agent-a', channel: 'work', token: TOKEN_A },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Nested secret paths + fields the form never sees
// ---------------------------------------------------------------------------

describe('update — nested paths and un-exposed fields', () => {
  it('keeps each mailbox its own password and carries un-exposed fields through', async () => {
    seed({
      testmail: [
        { address: 'alice', imap: { host: 'imap.one', pass: 'alice-secret-pw' }, whitelist: ['a@example.com'] },
        { address: 'bob', imap: { host: 'imap.two', pass: 'bob-secret-pw' }, whitelist: ['b@example.com'] },
      ],
    });

    const payload = await currentPayload();
    const [alice] = payload.byType.testmail!.splice(0, 1);
    payload.byType.testmail!.push({ ...alice!, fields: { ...alice!.fields, imapHost: 'imap.moved' } });

    await makeCaller().update(payload);

    expect(storedRaw().testmail).toEqual([
      { address: 'bob', imap: { host: 'imap.two', pass: 'bob-secret-pw' }, whitelist: ['b@example.com'] },
      { address: 'alice', imap: { host: 'imap.moved', pass: 'alice-secret-pw' }, whitelist: ['a@example.com'] },
    ]);
  });

  it('leaves a second transport\'s slice alone', async () => {
    seed({
      telegram: [tg('agent-a', TOKEN_A)],
      testmail: [{ address: 'alice', imap: { host: 'imap.one', pass: 'alice-secret-pw' }, whitelist: [] }],
    });

    const payload = await currentPayload();
    payload.byType.telegram![0]!.fields.token = NEW_TOKEN;

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([['agent-a', NEW_TOKEN]]);
    expect(storedRaw().testmail).toEqual([
      { address: 'alice', imap: { host: 'imap.one', pass: 'alice-secret-pw' }, whitelist: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reject branch — a mask with nothing behind it
// ---------------------------------------------------------------------------

describe('update — unresolvable masks', () => {
  beforeEach(() => {
    seed({ telegram: [tg('agent-a', TOKEN_A), tg('agent-b', TOKEN_B)] });
  });

  it('rejects a new route whose secret arrives masked, writing nothing', async () => {
    const payload = await currentPayload();
    payload.byType.telegram!.push({ address: 'new-agent', fields: { token: '••••aaa1' } });

    await expect(makeCaller().update(payload)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('new-agent'),
    });

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-b', TOKEN_B],
    ]);
  });

  it('rejects a re-addressed route that keeps its mask (the credential moved out of reach)', async () => {
    const payload = await currentPayload();
    payload.byType.telegram![0]!.address = 'renamed-agent';

    await expect(makeCaller().update(payload)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-b', TOKEN_B],
    ]);
  });

  it('accepts the same re-addressing once the operator retypes the credential', async () => {
    const payload = await currentPayload();
    payload.byType.telegram![0]!.address = 'renamed-agent';
    payload.byType.telegram![0]!.fields.token = NEW_TOKEN;

    await makeCaller().update(payload);

    expect(storedTokens()).toEqual([
      ['renamed-agent', NEW_TOKEN],
      ['agent-b', TOKEN_B],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate identities
// ---------------------------------------------------------------------------

describe('update — duplicate address+channel pairs', () => {
  it('pairs duplicates in file order, one stored entry each', async () => {
    // Two bots feeding the same agent+channel are indistinguishable to the
    // form, so the pairing is positional *within* the duplicate group. Both
    // tokens survive; which of the two identical rows carries which is not
    // meaningful.
    seed({ telegram: [tg('agent-a', TOKEN_A), tg('agent-a', TOKEN_B)] });

    await makeCaller().update(await currentPayload());

    expect(storedTokens()).toEqual([
      ['agent-a', TOKEN_A],
      ['agent-a', TOKEN_B],
    ]);
  });

  it('refuses to clone one route\'s secret into a duplicate of it', async () => {
    seed({ telegram: [tg('agent-a', TOKEN_A)] });

    const payload = await currentPayload();
    payload.byType.telegram!.push({ ...payload.byType.telegram![0]! });

    await expect(makeCaller().update(payload)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(storedTokens()).toEqual([['agent-a', TOKEN_A]]);
  });
});
