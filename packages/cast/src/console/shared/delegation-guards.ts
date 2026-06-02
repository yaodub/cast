/**
 * Shared push guards.
 *
 * The agent-side `conversation__push_to_channel` registration composes these
 * guards in `handlePushToChannel`; the set composed depends on the calling
 * actor (`PushActor`). Server-scope consoles (delegate.ts) use a different
 * evaluator (`evaluatePush`) but still rely on the pure predicates here for
 * symmetry — without sharing, a future change to one site can drift away
 * from the other and silently widen what a push can reach.
 *
 * Each guard is a pure predicate. The handler composes the guards
 * appropriate to the actor via `guardsForActor` and short-circuits on the
 * first `deny`.
 */
import { readServerConfig } from '../../config.js';
import type { PushActor } from '../../agent/push-actor.js';
import { isConsoleChannel } from '../index.js';

export type GuardResult = { deny: false } | { deny: true; reason: string };

export interface GuardArgs {
  sameAgent: boolean;
  sourceChannel?: string;
  targetChannel: string;
}

export type Guard = (args: GuardArgs) => GuardResult;

/**
 * Intra-agent infra guard — block same-agent pushes whose target is an
 * infrastructure channel (`__design`, `__configure`).
 *
 * Two cases:
 *
 *   __configure → __design — PERMANENT block, both isolation modes. This
 *     direction is the exfil carrier: per-agent Configure has read access
 *     to the agent's state mount (memory/sessions/PII), and per-agent
 *     Design has full network egress for blueprint authoring. A push from
 *     Configure to Design would hand PII to the egress carrier. The
 *     isolation knob never opens this direction.
 *
 *   __design → __configure — MODE-GATED. In strict mode, blocked
 *     (symmetric posture). In normal mode, allowed — Design holds no PII
 *     and Configure is the natural handoff target during agent setup,
 *     so the carrier risk doesn't apply in this direction.
 *
 * Does NOT gate cross-agent push to infra — that path is grant-gated by
 * `getConsoleOutboundAcls()` and only manager consoles (DM/CM) hold grants.
 */
export function intraAgentInfraGuard(args: GuardArgs): GuardResult {
  if (!args.sameAgent || !isConsoleChannel(args.targetChannel)) {
    return { deny: false };
  }

  // Permanent block: __configure → __design is the exfil carrier; isolation
  // mode never opens it. Rejection names the rule, not the current mode —
  // there's no operator action that changes the answer.
  if (args.sourceChannel === '__configure' && args.targetChannel === '__design') {
    return {
      deny: true,
      reason:
        'Same-agent push from `__configure` to `__design` is not supported — ' +
        'Configure holds PII state and Design has network egress, so this ' +
        'bridge is never opened. Route this handoff via the operator.',
    };
  }

  // Mode-gated: __design → __configure (and any other same-agent infra
  // target). Normal mode opens it; strict mode keeps it closed.
  const isolation = readServerConfig().consoleIsolation;
  if (isolation === 'normal') {
    return { deny: false };
  }

  return {
    deny: true,
    reason:
      `Console isolation is currently \`strict\`. Same-agent push to infrastructure channel ` +
      `\`${args.targetChannel}\` is blocked — route this handoff via the operator. The mode is ` +
      `operator-set and live; this rejection names the current setting.`,
  };
}

/**
 * Block same-agent push from a console channel (`__design` / `__configure`)
 * into the host agent's own user channel. Consoles author the agent's
 * blueprint and config; they don't speak on the operator's behalf in user
 * channels. This was previously enforced by the console-side push registration
 * in `delegate.ts`; with per-agent consoles now sharing the agent-side push
 * verb, the guard lives here so the agent-side handler can compose it.
 *
 * No-op when `sourceChannel` is itself a user channel — user-channel agents
 * pushing to their own infra channels (`__design`, `__configure`) is handled
 * by `intraAgentInfraGuard` instead.
 */
export function consoleSourceUserTargetGuard(args: GuardArgs): GuardResult {
  if (!args.sameAgent) return { deny: false };
  if (!args.sourceChannel || !isConsoleChannel(args.sourceChannel)) return { deny: false };
  if (isConsoleChannel(args.targetChannel)) return { deny: false };
  return {
    deny: true,
    reason: `Cannot push from a console channel to the agent's own user channel "${args.targetChannel}". Consoles author the agent's blueprint and config — they do not speak in user channels.`,
  };
}

/**
 * Self-loop guard — same agent + same channel = same conversation, no
 * legitimate push target. `conversation__push_to_channel` always uses the
 * caller's own participant as the target participant, so "same channel"
 * uniquely identifies the caller's own conversation. The downstream
 * `dispatchLocalPush` also catches this case as defense-in-depth, but
 * naming it as a handler-composed guard gives a clearer error message and
 * lets future actors that don't reach dispatch (e.g. server-scope) still
 * benefit from the same predicate.
 */
export function selfLoopGuard(args: GuardArgs): GuardResult {
  if (!args.sameAgent) return { deny: false };
  if (args.sourceChannel !== undefined && args.sourceChannel === args.targetChannel) {
    return {
      deny: true,
      reason:
        'Cannot push to your own active conversation. Output the text directly as your response — ' +
        'it will be delivered to the participant automatically.',
    };
  }
  return { deny: false };
}

/**
 * Guard set per actor. User-agent's regex already blocks `__*` so the
 * console-source / infra guards can't fire — the parser is the gate. Per-
 * agent consoles run the full set, since their operator-trust parser
 * accepts `__*` and the guards are what keep the trust boundary intact.
 * Server-scope consoles don't reach this composer (they go through
 * `evaluatePush` in delegate.ts).
 */
export function guardsForActor(actor: PushActor): readonly Guard[] {
  switch (actor.kind) {
    case 'user-agent':
      return [selfLoopGuard];
    case 'per-agent-console':
      return [selfLoopGuard, consoleSourceUserTargetGuard, intraAgentInfraGuard];
    case 'server-scope':
      return [];
  }
}
