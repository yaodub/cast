/**
 * PushActor — the discriminated union that describes who is invoking the
 * `conversation__push_to_channel` MCP verb. Three actors map onto two axes:
 *
 *                   │ implicit container (host agent)   │ free-floating (`console:*`)
 *   ────────────────┼───────────────────────────────────┼────────────────────────────
 *   user trust     │ user-agent                         │ — (doesn't exist)
 *   operator trust │ per-agent-console                  │ server-scope
 *
 * Identity decides the addressing model (whether `target_agent` is implicit).
 * Trust decides the input-validation envelope (whether the channel-name regex
 * blocks `__*`, whether `participantExists` and the per-channel inbound ACL
 * gate run). Conflating the axes was the architectural mistake that shipped
 * four regressions in the previous attempt; this type makes both axes
 * inspectable at the call site.
 *
 * Variants carry only the fields that exist for them — no optional `null`
 * branches downstream. Consumers `switch` on `kind` and the compiler enforces
 * exhaustiveness.
 *
 * `agentId` on the per-agent-console variant is the host agent's bus address
 * (same shape as `user-agent.agentId`). `address` on server-scope is the
 * console's own bus address (e.g. `console:design-manager`).
 *
 * `participant` on user-agent is the user's resolved address; on
 * per-agent-console it is the operator's session handle (`local/admin:*`),
 * which resolves to the `local` identity sentinel.
 */
export type PushActor =
  | {
      kind: 'user-agent';
      agentId: string;
      channel: string;
      participant: string;
      callerQualifier?: string;
    }
  | {
      kind: 'per-agent-console';
      agentId: string;
      /** Always one of the per-agent console channel names. */
      channel: '__design' | '__configure';
      participant: string;
    }
  | {
      kind: 'server-scope';
      /** Console bus address (e.g. `console:design-manager`). */
      address: string;
      channel: string;
    };

/** Actors that source a `dispatchLocalPush` call — server-scope routes via
 *  bus only and never reaches local dispatch, so its kind is excluded here. */
export type LocalPushActor = Exclude<PushActor, { kind: 'server-scope' }>;
