/**
 * Bus payload schema for agent message handlers.
 *
 * Validated at the BusHandler boundary so handler bodies operate on a
 * discriminated union, not raw `unknown`. Producers that route to an agent
 * must shape their payload to match one of these variants.
 */
import { z } from 'zod';

import { AttachmentSchema } from '../types.js';

export const RoutingSchema = z.object({
  channel: z.string().optional(),
  qualifier: z.string().optional(),
  /**
   * Receiver-side conversation key contributor. For scheduler/watch/service
   * self-fires and similar intra-agent injections this is "the participant
   * whose cell this fire belongs to." Distinct from `returnTo*` on the push
   * and request variants — that's reply-routing metadata, not cell-key input.
   */
  targetParticipant: z.string().optional(),
});

/**
 * Routing as senders write it (pre-parse alias, kept for downstream
 * compatibility with function signatures that accept routing arguments).
 */
export type Routing = z.input<typeof RoutingSchema>;

/** Routing post-parse. */
export type ParsedRouting = z.output<typeof RoutingSchema>;

export const AgentBusPayloadSchema = z.discriminatedUnion('type', [
  /**
   * Plain bus-delivered message — used for vestigial paths that route
   * conversation text without ingest provenance (declaredName / attachments)
   * and without push semantics. Reserved for future use; today most
   * conversation traffic enters via `type: 'ingested'` (transport ingest) or
   * `type: 'push'` (cross-agent push).
   */
  z.object({
    type: z.literal('message'),
    text: z.string(),
    routing: RoutingSchema.optional(),
  }),
  /**
   * Transport-ingested message. The gateway resolves transport and produces
   * the structured fields; the receiver-side bus handler is the single
   * envelope authority — it runs `formatMessages` on these fields before
   * delivering to the runner. `text` is the raw body, not the formatted
   * envelope.
   */
  z.object({
    type: z.literal('ingested'),
    text: z.string(),
    declaredName: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    routing: RoutingSchema.optional(),
    /**
     * Per-turn source wire (`tg:12345`, `web:abc`) — gateway-stamped delivery
     * metadata, deliberately top-level (NOT in `RoutingSchema`, which feeds
     * `RouteContext`). Consumed only at the bus-handler boundary (pairing);
     * it must never enter conversation state, the prompt, or any tool result.
     */
    sourceHandle: z.string().optional(),
  }),
  /**
   * Cross-agent push. Carries the correlation `requestId` minted by the
   * sender's push MCP tool plus the sender's cell coordinates so a
   * receiver-side rejection can route back to the originating cell. Channel
   * and qualifier are separate fields per the documented internal-layer
   * policy at `conversations/parse-channel.ts:5-7`.
   */
  z.object({
    type: z.literal('push'),
    text: z.string(),
    requestId: z.string(),
    returnToParticipant: z.string(),
    returnToChannel: z.string(),
    returnToQualifier: z.string().optional(),
    routing: RoutingSchema.optional(),
  }),
  z.object({
    type: z.literal('request'),
    /** Wire-format kind the sender chose. `query` (q-bit, expects answer
     *  back) or `request` (r-bit, fire-and-forget). The receiver renders
     *  the matching `<cast:query>` / `<cast:request>` tag so the receiving
     *  agent sees the sender's intent — not a normalized substitute.
     *  Defaults to `query` so any callsite predating the kind field still
     *  validates and falls into the q/a path (the only path the system
     *  exercised before this field landed). */
    kind: z.enum(['query', 'request']).default('query'),
    text: z.string(),
    requestId: z.string(),
    channel: z.string(),
    /** Caller's source-conversation qualifier — hoisted to top-level. */
    qualifier: z.string().optional(),
    returnToAgent: z.string(),
    returnToChannel: z.string(),
    returnToParticipant: z.string(),
    /** Caller's source-conversation qualifier — echoed back as `originQualifier`
     *  on the response/rejection so the answer routes to the same qualified
     *  sub-conversation that issued the query. Absent when the caller's source
     *  conversation is un-qualified. */
    returnToQualifier: z.string().optional(),
    upstreamSet: z.array(z.string()),
  }),
  z.object({
    type: z.literal('response'),
    text: z.string(),
    requestId: z.string(),
    originChannel: z.string(),
    originParticipant: z.string(),
    /** Sender's source-conversation qualifier, echoed from the inbound
     *  request's `returnToQualifier`. Drives the qualifier in the reply
     *  routing so the answer lands in the caller's qualified sub-conversation. */
    originQualifier: z.string().optional(),
  }),
  z.object({
    type: z.literal('rejection'),
    requestId: z.string(),
    reason: z.string(),
    originChannel: z.string(),
    originParticipant: z.string(),
    originQualifier: z.string().optional(),
  }),
  z.object({
    type: z.literal('pairing'),
    code: z.string(),
    /** Source wire of the pairing message — what the code binds to. See `ingested.sourceHandle`. */
    sourceHandle: z.string().optional(),
  }),
  z.object({
    type: z.literal('pairing_request'),
    /** Source wire requesting a code. See `ingested.sourceHandle`. */
    sourceHandle: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval_response'),
    id: z.string(),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().optional(),
  }),
]);

export type AgentBusPayload = z.infer<typeof AgentBusPayloadSchema>;

export interface SiblingAgentInfo {
  /** Canonical bus address: `a:<guid>@<issuer>`. Stable across alias rename. */
  canonical: string;
  /** Human-facing alias (manifest.name). */
  alias: string;
  description?: string;
  /** Channels reachable from the caller's ACL perspective (`q` bit = queryable). Empty if no grant. */
  channels: { name: string; bits: string; sharded?: boolean }[];
}
