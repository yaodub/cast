/**
 * Container I/O schemas — wire format crossing the host ↔ container seam.
 *
 * Both sides import these to keep the contract in one place. The host
 * (packages/cast) stamps payloads; the runner (packages/agent-runner) parses
 * inbound. ContainerOutputSchema flows the other direction.
 *
 * Pure schema definitions — no logic. Lives in agent-schema because the
 * package's charter IS schemas; both packages import from it without
 * importing each other.
 */
import { z } from 'zod';

/**
 * Stdin attachment metadata — container-side paths + metadata, no binary.
 * Binary content lives in mounted dirs; this just points to them.
 */
export const StdinAttachmentSchema = z.object({
  path: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  filesize: z.number(),
});

/**
 * Init payload sent on stdin's first line. The host's full ContainerInput
 * extends this with spawn-only fields (mcpPorts, overrideMounts, workdir,
 * containerNetwork) that configure the spawn but never reach the runner via
 * stdin — those become container args. This schema is the runtime payload
 * only.
 */
const ContainerInputFields = {
  prompt: z.string(),
  sessionId: z.string().optional(),
  bootstrap: z.string().optional(),
  /** Fully assembled system prompt (all layers). When set, the runner uses this directly instead of reading files. */
  systemPrompt: z.string().optional(),
  /** Agent's resolved capability disabled-tools list, forwarded to the SDK's
   *  `disallowedTools` so it also gates built-in SDK tools (`WebFetch`, `Bash`,
   *  …), not just Cast MCP tools. */
  disabledTools: z.array(z.string()).optional(),
  conversationKey: z.string().optional(),
  agentFolder: z.string(),
  address: z.string(),
  isScheduledTask: z.boolean().optional(),
  /** True when this spawn exists solely to run a conversation's cleanup turn
   *  (cold-path expiry: no warm container to pipe into, so cleanup is the init
   *  prompt of a fresh resumed query). Lets the runner tag the init turn's
   *  usage as the `cleanup` phase. The warm path carries this signal per-turn
   *  via the `message` frame's `kind` instead. */
  isCleanup: z.boolean().optional(),
  model: z.string().optional(),
  /** Pre-resolved model for the bootstrap query, when bootstrap is present.
   *  Host-side resolves `modelOverrides` with `phase: 'bootstrap'` and sets this;
   *  if absent, the runner falls back to `model` (and then the SDK default). */
  bootstrapModel: z.string().optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  attachments: z.array(StdinAttachmentSchema).optional(),
};

export const ContainerInputSchema = z.object(ContainerInputFields);

/**
 * Discriminated union for stdin protocol messages. The init message is sent
 * once (on the first line); the others can flow at any time during the
 * conversation lifetime.
 *
 * Init is inlined as a flat object (not `z.object({type:'init'}).and(...)`)
 * so TypeScript narrows correctly on `switch (msg.type)`.
 */
export const StdinMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), ...ContainerInputFields }),
  z.object({
    type: z.literal('message'),
    text: z.string(),
    attachments: z.array(StdinAttachmentSchema).optional(),
    /** Framework stimulus kind. The host stamps `'lifecycle'` for a cleanup
     *  turn so the runner tags its usage as the `cleanup` phase; absent (the
     *  common case) is treated as `participant`. */
    kind: z.string().optional(),
    /** When set, the runner switches the live query to this model (via the
     *  SDK's `setModel`) before processing this turn. Used to run a cleanup
     *  turn on a cleanup-phase model without tearing down the warm session. */
    model: z.string().optional(),
  }),
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('secrets'), data: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('close') }),
]);

/**
 * Discriminated union for container → host IPC. Each variant carries only
 * the fields it needs; the host parses with this on every line of stdout.
 */
export const ContainerOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    result: z.string(),
    intermediate: z.boolean().optional(),
    newSessionId: z.string().optional(),
    /** Present only on the SDK's final success-result emission. Lets the host
     *  distinguish "SDK turn completed cleanly" from intermediate / between-query
     *  pings (both lack this field). Suppresses false-positive fallback when the
     *  agent finished successfully with empty text and the container later
     *  exits non-zero for unrelated reasons. */
    subtype: z.literal('success').optional(),
    /** When set, this message is the seal for preview stream `streamId`. */
    streamId: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    newSessionId: z.string().optional(),
    /** Host-synthesized exit cause for fallback message routing. The container
     *  never emits this field — only the host's container close handler tags
     *  errors so the fallback path can pick differentiated user copy
     *  (`external_kill` = host runtime killed us, likely resource pressure;
     *  `agent_error` = process crashed; `timeout` / `spawn_failure` = host
     *  timeouts / spawn syscall failures). */
    cause: z.enum(['external_kill', 'agent_error', 'timeout', 'spawn_failure']).optional(),
  }),
  /** Claude reachability failure detected from the SDK's error text. `reason`
   *  drives differentiated user copy on the host (`invalid-credentials` =
   *  401, `quota-exhausted` = 429 / max_budget, `claude-unavailable` = 5xx /
   *  network / model-not-found). Pre-existing emit sites without a `reason`
   *  field are interpreted as `invalid-credentials` for backward compat. */
  z.object({
    type: z.literal('auth_error'),
    reason: z.enum(['invalid-credentials', 'quota-exhausted', 'claude-unavailable']).optional(),
  }),
  z.object({
    type: z.literal('lifecycle'),
    /**
     * `idle` fires when an SDK turn completes and the runner is about to
     * block on stdin for the next message — i.e. the container is alive but
     * quiescent. Host treats `idle` runners as swap-eligible. Not emitted for
     * single-shot or close-imminent paths (container exits there instead).
     */
    phase: z.enum(['bootstrap', 'compacting', 'idle']),
    active: z.boolean(),
    preTokens: z.number().optional(),
    trigger: z.enum(['manual', 'auto']).optional(),
  }),
  /** Ephemeral in-progress assistant text. Not persisted host-side; the
   *  matching `message` variant (same streamId) is the persisted seal. */
  z.object({
    type: z.literal('preview'),
    kind: z.literal('text'),
    streamId: z.string(),
    text: z.string(),
  }),
  /** Token usage + list-price cost reported by the SDK on each `result` — one
   *  frame per turn (one user message → one usage frame). Token counts are the
   *  delta for that turn. `phase` distinguishes the main turns from the
   *  bootstrap query some channels run first and the cleanup turn on expiry;
   *  `model` is the model actually active for the turn (may differ from the
   *  spawn model after a mid-session switch). `cost_usd` is this turn's cost in
   *  Anthropic API list prices (the runner converts the SDK's cumulative
   *  `total_cost_usd` into a per-turn delta) — informational, not the actual bill. */
  z.object({
    type: z.literal('usage'),
    phase: z.enum(['main', 'bootstrap', 'cleanup']),
    model: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    num_turns: z.number().int().nonnegative(),
  }),
]);

export type StdinAttachment = z.infer<typeof StdinAttachmentSchema>;
export type ContainerInput = z.infer<typeof ContainerInputSchema>;
export type StdinMessage = z.infer<typeof StdinMessageSchema>;
export type ContainerOutput = z.infer<typeof ContainerOutputSchema>;
