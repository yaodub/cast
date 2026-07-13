/**
 * User↔user push grant store.
 *
 * The reactive grant for one user pushing into ANOTHER user's conversation with
 * this agent (`conversation__push_to_participant`). Keyed per `(channel, pusher,
 * pushee)` — a directional, channel-scoped consent the PUSHEE gives in-band. It
 * cannot live in `acl.json`: that file is `peer → channel → bits` ("who may reach
 * this agent"); this is a `(pusher, pushee, channel)` triple ("who may push to
 * whom, here"), a different shape. So it gets its own per-agent sibling file.
 *
 * Reads go straight to disk (not the file-watcher cache) so a grant written during
 * an approval resolution is visible to the very next push — the same freshness the
 * cache-lag addendum (2B io-race) wanted, without the watch plumbing. The store is
 * small and sparse: it holds only terminal consent (approved / rejected); a
 * one-shot ("once") push delivers without persisting anything.
 */
import fs from 'fs';
import { z } from 'zod';

import { agentPath } from '../config.js';
import { extractIdentity } from './address.js';
import { writeAtomic } from '../lib/utils.js';

/** pushee identity → consent marker. */
const PusheeMapSchema = z.record(z.string(), z.literal(true));
/** pusher identity → { pushee → true }. */
const PusherMapSchema = z.record(z.string(), PusheeMapSchema);
/** channel → { pusher → { pushee → true } }. */
const ChannelMapSchema = z.record(z.string(), PusherMapSchema);

const UserPushStoreSchema = z
  .object({
    approved: ChannelMapSchema.default({}),
    rejected: ChannelMapSchema.default({}),
  })
  .strict();
type UserPushStore = z.infer<typeof UserPushStoreSchema>;

/** Three-state, mirroring `aclVerdict`: an approved edge → `granted`; a rejected
 *  tombstone → `rejected`; an edge never decided → `askable` (the pushee can be
 *  asked). No file / unparseable file → `askable` (nothing has been rejected, so
 *  the pushee may still consent) — distinct from acl.json's deny-by-default, since
 *  here the absence of a record means "not yet asked", not "denied". */
export type UserPushVerdict = 'granted' | 'askable' | 'rejected';

function storePath(agentFolder: string): string {
  return agentPath(agentFolder, 'config', 'user-push.json');
}

function readStore(agentFolder: string): UserPushStore {
  try {
    return UserPushStoreSchema.parse(JSON.parse(fs.readFileSync(storePath(agentFolder), 'utf-8')));
  } catch {
    return UserPushStoreSchema.parse({});
  }
}

function hasEdge(map: UserPushStore['approved'], channel: string, pusher: string, pushee: string): boolean {
  return map[channel]?.[pusher]?.[pushee] === true;
}

export function userPushVerdict(
  agentFolder: string,
  channel: string,
  pusher: string,
  pushee: string,
): UserPushVerdict {
  const store = readStore(agentFolder);
  const p = extractIdentity(pusher);
  const t = extractIdentity(pushee);
  if (hasEdge(store.approved, channel, p, t)) return 'granted';
  if (hasEdge(store.rejected, channel, p, t)) return 'rejected';
  return 'askable';
}

/** Read-modify-write the store. A missing / unparseable file starts from defaults. */
function mutateStore(agentFolder: string, fn: (store: UserPushStore) => void): void {
  const store = readStore(agentFolder);
  fn(store);
  fs.mkdirSync(agentPath(agentFolder, 'config'), { recursive: true });
  writeAtomic(storePath(agentFolder), JSON.stringify(store, null, 2) + '\n');
}

function setEdge(map: UserPushStore['approved'], channel: string, pusher: string, pushee: string): void {
  ((map[channel] ??= {})[pusher] ??= {})[pushee] = true;
}

function clearEdge(map: UserPushStore['approved'], channel: string, pusher: string, pushee: string): void {
  const pushers = map[channel];
  const pushees = pushers?.[pusher];
  if (!pushers || !pushees || !(pushee in pushees)) return;
  delete pushees[pushee];
  if (Object.keys(pushees).length === 0) delete pushers[pusher];
  if (Object.keys(pushers).length === 0) delete map[channel];
}

/** Persist a pushee-approved edge: `pusher` may push to `pushee` on `channel`.
 *  Clears any prior tombstone for the same edge. */
export function grantUserPush(agentFolder: string, channel: string, pusher: string, pushee: string): void {
  const p = extractIdentity(pusher);
  const t = extractIdentity(pushee);
  mutateStore(agentFolder, (store) => {
    setEdge(store.approved, channel, p, t);
    clearEdge(store.rejected, channel, p, t);
  });
}

/** Persist a pushee-rejected edge (tombstone): `pusher` is denied push to `pushee`
 *  on `channel`, and is never asked again. Clears any prior grant. */
export function tombstoneUserPush(agentFolder: string, channel: string, pusher: string, pushee: string): void {
  const p = extractIdentity(pusher);
  const t = extractIdentity(pushee);
  mutateStore(agentFolder, (store) => {
    setEdge(store.rejected, channel, p, t);
    clearEdge(store.approved, channel, p, t);
  });
}
