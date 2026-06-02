/**
 * Source-side ACL helper for server-scope console outbound traffic.
 *
 * Two call sites in `server-scope.ts` had the same shape — `lookupDescriptorAcl`
 * on `CONSOLE_OUTBOUND_ACLS[selfAddr]` then `hasBit` — differing only in the
 * bit (`'p'` for push verbs, `'q'` for query requests). Bug #6.5 was a
 * copy-paste between two such sites that left a stray extra check; collapsing
 * to one helper makes that class of bug structurally impossible.
 *
 * Source-side check is defense-in-depth — receivers run their own ACL
 * (`'i'`/`'h'` for handleMessage; `'a'` for query receivers) when the bus
 * dispatches to them. This helper just answers "may *this* console initiate
 * outbound traffic of this kind to this target on this channel?".
 */
import { hasBit, lookupDescriptorAcl } from '../../auth/acl.js';
import { getConsoleOutboundAcls } from '../../auth/console-grants.js';

/**
 * Check whether a server-scope console is permitted to emit an outbound
 * `bit`-typed action toward `(target, channel)`. Returns false if no ACL
 * record exists for the source address (no grant table → no traffic).
 *
 * `bit` is constrained to the verbs server-scope consoles originate:
 *   - `'p'` — push (cross-agent message via `bus.routeMessage`).
 *   - `'q'` — query (cross-agent `<cast:query>` request, expects answer).
 *   - `'r'` — request (cross-agent `<cast:request>`, fire-and-forget).
 */
export function hasOutboundBit(
  selfAddr: string,
  target: string,
  channel: string,
  bit: 'p' | 'q' | 'r',
): boolean {
  const acl = getConsoleOutboundAcls()[selfAddr];
  if (!acl) return false;
  return hasBit(lookupDescriptorAcl(acl, target, channel), bit);
}
