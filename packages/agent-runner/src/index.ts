/**
 * Cast Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol (newline-delimited JSON on stdin):
 *   Line 1: {"type":"init","prompt":"...","sessionId":"...","secrets":{...},...}
 *   Subsequent: {"type":"message","text":"follow-up from user"}
 *               {"type":"secrets","data":{"CLAUDE_CODE_OAUTH_TOKEN":"..."}}
 *               {"type":"close"}
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, McpServerConfig, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createMcpSocketProxy, createMcpTcpProxy, type CallMeta } from './mcp-socket-proxy.js';
import { createTurnTextStreamer, type TurnTextStreamer, type PipeMessageKind } from './turn-text-streamer.js';

import { createInterface } from 'readline';

/** Held at module scope so the SIGTERM/SIGINT handler can abort cleanly. */
let currentStreamer: TurnTextStreamer | null = null;

/** Kind of the most recent stdin message piped to the SDK. Read by the
 *  runQuery's `system/init` handler to decide whether to rotate streamId, and
 *  at the usage-emit site to tag the turn's phase (`lifecycle` → `cleanup`). */
let lastInboundKind: PipeMessageKind = 'participant';

/** SIDE EFFECT: per-spawn call context, set from the init payload (runQuery)
 *  and read by the service MCP proxy to stamp `_meta` on tool calls. The runner
 *  is single-conversation-per-spawn, so the participant is constant for the
 *  spawn — a module ref is sufficient, and resetting it on a fresh spawn is
 *  correct. Host-attested (comes from the host's stdin payload), so the agent
 *  cannot forge it. */
let currentCallMeta: CallMeta | undefined;

/** The service socket's MCP name — only it receives the attested call context. */
const SERVICE_MCP_NAME = 'agent';

/** The live SDK query handle for the current runQuery — captured so a piped
 *  turn can switch the model mid-session via `setModel` (cleanup-phase model). */
let currentQuery: ReturnType<typeof query> | undefined;

/** Model currently active for the query. Initialized to the spawn model;
 *  updated on a mid-session `setModel`. Stamped onto each usage frame so the
 *  recorded model reflects the model that actually ran the turn. */
let currentModel: string | undefined;

/** Previous-snapshot of the SDK's `result.modelUsage`, used to compute per-turn
 *  per-model deltas. Both token counts and `costUSD` accumulate cumulatively
 *  inside a single query() lifetime, so each new result we diff against this
 *  snapshot then update it. Resets per runQuery (each `query()` starts fresh). */
let prevModelUsage: Record<string, SdkModelUsageEntry> = {};

function generatePreviewStreamId(): string {
  return `strm-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Stdin protocol Zod schemas. Canonical definition lives in
 * `packages/agent-schema/src/v1/container-io.ts` (used host-side); these
 * mirror that shape locally because agent-runner is built into a standalone
 * Docker image and cannot import workspace packages. CLAUDE.md endorses this
 * duplication pattern: "Duplicated utilities across boundaries are acceptable
 * — coupling is worse." If these drift from agent-schema, host stamps an
 * invalid payload and runner-side parse fails loud at startup.
 */
const StdinAttachmentSchema = z.object({
  path: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  filesize: z.number(),
});

const ContainerInputFields = {
  prompt: z.string(),
  sessionId: z.string().optional(),
  bootstrap: z.string().optional(),
  systemPrompt: z.string().optional(),
  /** Agent's resolved capability disabled-tools list. Unioned with the built-in
   *  disallowed floor and fed to the SDK's `disallowedTools`. (Duplicated from
   *  agent-schema's container-io.ts — process boundary, no cross-import.) */
  disabledTools: z.array(z.string()).optional(),
  conversationKey: z.string().optional(),
  /** Conversation participant + channel, stamped host-side so the runner can
   *  attest them onto service tool calls (MCP `_meta`) for participant-routed
   *  approval. Absent for rooms / self turns. (Mirrored from agent-schema's
   *  container-io.ts — process boundary, no cross-import.) */
  participant: z.string().optional(),
  channelName: z.string().optional(),
  agentFolder: z.string(),
  address: z.string(),
  isScheduledTask: z.boolean().optional(),
  /** True when this spawn runs a cold-path cleanup turn as its init prompt;
   *  tags the init turn's usage as the `cleanup` phase. */
  isCleanup: z.boolean().optional(),
  model: z.string().optional(),
  /** Pre-resolved model for the bootstrap query — host-side `modelOverrides`
   *  with `phase: 'bootstrap'`. Falls back to `model` if unset. */
  bootstrapModel: z.string().optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  attachments: z.array(StdinAttachmentSchema).optional(),
};

const ContainerInputSchema = z.object(ContainerInputFields);
const InitStdinMessageSchema = z.object({ type: z.literal('init'), ...ContainerInputFields });
const StdinMessageSchema = z.discriminatedUnion('type', [
  InitStdinMessageSchema,
  z.object({
    type: z.literal('message'),
    text: z.string(),
    attachments: z.array(StdinAttachmentSchema).optional(),
    /** Framework stimulus kind; `'lifecycle'` marks a cleanup turn. */
    kind: z.string().optional(),
    /** When set, switch the live query to this model before this turn. */
    model: z.string().optional(),
  }),
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('secrets'), data: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('close') }),
]);

type StdinAttachment = z.infer<typeof StdinAttachmentSchema>;
type ContainerInput = z.infer<typeof ContainerInputSchema>;
type StdinMessage = z.infer<typeof StdinMessageSchema>;

// Discriminated union for container→host IPC (must match host-side ContainerOutputSchema).
type ContainerOutput =
  | { type: 'message'; result: string; intermediate?: boolean; newSessionId?: string; subtype?: 'success'; streamId?: string }
  | { type: 'error'; error: string; newSessionId?: string }
  | { type: 'auth_error'; reason?: 'invalid-credentials' | 'quota-exhausted' | 'claude-unavailable' }
  | { type: 'lifecycle'; phase: 'bootstrap' | 'compacting' | 'idle'; active: boolean; preTokens?: number; trigger?: 'manual' | 'auto' }
  // Preview frame — ephemeral assistant-text snapshot. Emitted by TurnTextStreamer
  // at ~500ms intervals while the SDK is generating. Host's deliverOutbound
  // skips persistence (isPersistablePacket=false). Discriminated `kind` field
  // reserves space for future flavors; v1 ships only `'text'`.
  | { type: 'preview'; kind: 'text'; streamId: string; text: string }
  // Token usage + list-price cost from the SDK's `result` message. One frame
  // per result (one frame per user message → response cycle). `cost_usd` is
  // `total_cost_usd` at Anthropic API list prices — informational, not the
  // operator's actual bill.
  | { type: 'usage'; phase: 'main' | 'bootstrap' | 'cleanup'; model: string;
      input_tokens: number; output_tokens: number;
      cache_creation_input_tokens: number; cache_read_input_tokens: number;
      cost_usd: number; num_turns: number };


interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Container volume mount paths — fixed layout, see SPEC.md §12.
const WORKSPACE_HOME = '/home/agent';
const WORKSPACE_IDENTITY = '/identity';
const WORKSPACE_MEMORY = '/memory';
const WORKSPACE_ASSETS = '/assets';
const WORKSPACE_SHARED = '/shared';
const WORKSPACE_ATTACHMENTS = '/attachments';

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

/**
 * Persistent stdin line reader.
 * Reads newline-delimited JSON from stdin and dispatches to callbacks.
 * Replaces file-based IPC polling — ordered pipe, guaranteed delivery, no races.
 */
class StdinReader {
  private rl: ReturnType<typeof createInterface>;
  private lineQueue: string[] = [];
  private lineWaiter: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor() {
    process.stdin.setEncoding('utf8');
    this.rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (this.lineWaiter) {
        const waiter = this.lineWaiter;
        this.lineWaiter = null;
        waiter(line);
      } else {
        this.lineQueue.push(line);
      }
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.lineWaiter) {
        const waiter = this.lineWaiter;
        this.lineWaiter = null;
        waiter(null);
      }
    });
  }

  /** Close the readline interface so the event loop can drain. */
  close(): void {
    this.rl.close();
  }

  /** Read the next line. Returns null on EOF. */
  nextLine(): Promise<string | null> {
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift()!);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => { this.lineWaiter = resolve; });
  }

  /**
   * Read lines continuously, dispatching to the stream and sdkEnv.
   * Runs until close or EOF. Returns reason for stopping.
   */
  async pumpInto(
    stream: MessageStream,
    sdkEnv: Record<string, string | undefined>,
  ): Promise<'close' | 'eof'> {
    while (true) {
      const line = await this.nextLine();
      if (line === null) {
        log('Stdin EOF, ending stream');
        stream.end();
        return 'eof';
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log(`Ignoring malformed stdin line: ${line.slice(0, 100)}`);
        continue;
      }
      const stdinParse = StdinMessageSchema.safeParse(parsed);
      if (!stdinParse.success) {
        log(`Ignoring invalid stdin message: ${line.slice(0, 100)}`);
        continue;
      }
      const msg = stdinParse.data;

      switch (msg.type) {
        case 'message': {
          let fullText = msg.text;
          if (msg.attachments?.length) {
            const refs = msg.attachments.map((a) =>
              `[Attachment: ${a.filename} | ${a.path} | ${a.mimeType} | ${a.filesize} bytes]`,
            ).join('\n');
            fullText = fullText ? `${fullText}\n\n${refs}` : refs;
          }
          log(`Stdin message received (${fullText.length} chars, ${msg.attachments?.length ?? 0} attachments)`);
          debugLog(`[stdin-message] ${fullText.slice(0, 80)}`); // DEBUG_LOG
          // Mid-session model switch (cleanup-phase model). Skip the SDK call
          // when it would be a no-op so a no-cleanup-override pipe stays cheap.
          if (msg.model && msg.model !== currentModel) {
            log(`Switching model: ${currentModel ?? '(spawn default)'} -> ${msg.model}`);
            currentModel = msg.model;
            try {
              await currentQuery?.setModel(msg.model);
            } catch (e) {
              log(`setModel failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          lastInboundKind = (msg.kind as PipeMessageKind | undefined) ?? 'participant';
          stream.push(fullText);
          break;
        }
        case 'system':
          log(`System message received (${msg.text.length} chars)`);
          lastInboundKind = 'system';
          stream.push(`[SYSTEM] ${msg.text}`);
          break;
        case 'secrets':
          // SIDE EFFECT: Mutates sdkEnv to refresh auth tokens.
          // Required because the SDK reads env at query time, and OAuth tokens
          // expire during long-running sessions.
          for (const [key, value] of Object.entries(msg.data)) {
            sdkEnv[key] = value;
          }
          log('Secrets refreshed via stdin');
          break;
        case 'close':
          log('Close received via stdin, ending stream');
          stream.end();
          return 'close';
        default:
          log(`Ignoring unknown stdin message type: ${(msg as { type: string }).type}`);
      }
    }
  }
}

const OUTPUT_START_MARKER = '---CAST_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAST_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
  debugLog(`[writeOutput] type=${output.type}${output.type === 'message' ? ` hasResult=${!!output.result} newSession=${!!output.newSessionId}` : ''}`);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// DEBUG_LOG: Persistent file logger for diagnosing SDK message drops.
// Writes to a file in the mounted home dir so it survives host log level
// filtering. Grep for DEBUG_LOG to find all related additions for rollback.
const DEBUG_LOG_PATH = path.join(WORKSPACE_HOME, '.agent-runner.log');
function debugLog(message: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${message}\n`);
  } catch { /* best effort */ }
}


/**
 * Detect Claude-unreachable errors in SDK result text and classify them.
 *
 * SDK error formats:
 *   `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error",...},...}` → invalid-credentials
 *   `API Error: 429 ...` (rate limit) → quota-exhausted
 *   `API Error: 5xx ...` (server errors, including 529 overloaded) → claude-unavailable
 *
 * Returns the reason when the text matches a known Claude-unreachable
 * pattern, or `null` if it's some other SDK error (falls through to the
 * generic container_error fallback host-side).
 *
 * Host uses the reason to pick differentiated user copy and to decide
 * whether to retry (invalid-credentials retries up to MAX_AUTH_RETRIES;
 * the other reasons fail immediately — no point retrying a quota error).
 */
const AUTH_ERROR_RE = /^Failed to authenticate\. API Error: 401 \{.*"type"\s*:\s*"authentication_error"/;
const RATE_LIMIT_RE = /API Error: 429\b/;
const OVERLOADED_RE = /API Error: 5\d\d\b/;

export type ClaudeFailureReason = 'invalid-credentials' | 'quota-exhausted' | 'claude-unavailable';

export function classifyClaudeError(resultText: string): ClaudeFailureReason | null {
  if (AUTH_ERROR_RE.test(resultText)) return 'invalid-credentials';
  if (RATE_LIMIT_RE.test(resultText)) return 'quota-exhausted';
  if (OVERLOADED_RE.test(resultText)) return 'claude-unavailable';
  return null;
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Built-in SDK tools removed from the model's context for every spawn.
// disallowedTools is the only real availability lever under bypassPermissions:
// it's enforced regardless of permissionMode and hides the tool from ToolSearch,
// whereas allowedTools only pre-approves — it never restricts, so we don't set it.
// - AskUserQuestion: no interactive user in the container path — replies go through the gateway.
// - Config: mutates SDK runtime settings including permission mode.
// This floor holds only the runner's own contract invariants. SDK-feature policy
// (cron tools, RemoteTrigger, plan mode, the Task* checklist, …) is decided
// host-side — see cast's container/sdk-surface.ts — and arrives on the init
// wire's disabledTools (tool names) and container env (feature flags), so
// policy changes apply on the next spawn without an image rebuild. Merge
// happens in resolveDisallowedTools().
const DISALLOWED_TOOLS = ['AskUserQuestion', 'Config'];

// Merge the built-in floor with the agent's per-spawn disabled-tools list (from
// the init wire), so disabled_tools also gates built-in SDK tools. Deduped.
function resolveDisallowedTools(agentDisabledTools: string[] | undefined): string[] {
  return [...new Set([...DISALLOWED_TOOLS, ...(agentDisabledTools ?? [])])];
}


function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput; // SDK hook types require cast — input is typed as Record<string, unknown>
    const command = (preInput.tool_input as { command?: string })?.command; // tool_input is Record<string, unknown> in SDK types
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>), // SDK types tool_input as Record<string, unknown>
          command: unsetPrefix + command,
        },
      },
    };
  };
}


/**
 * Pull token counters + list-price cost from an SDK `result` message.
 * Returns null if the SDK didn't include a usage block. The `usage` field is
 * per-turn; `total_cost_usd` is cumulative since the query() started.
 */
function extractUsage(msg: Record<string, unknown>): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  num_turns: number;
} | null {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    cache_creation_input_tokens: n(usage.cache_creation_input_tokens),
    cache_read_input_tokens: n(usage.cache_read_input_tokens),
    cost_usd: n(msg.total_cost_usd),
    num_turns: n(msg.num_turns),
  };
}

interface SdkModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

const ZERO_MODEL_USAGE: SdkModelUsageEntry = {
  inputTokens: 0, outputTokens: 0,
  cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  costUSD: 0,
};

function readModelUsage(msg: Record<string, unknown>): Record<string, SdkModelUsageEntry> {
  const mu = msg.modelUsage;
  if (!mu || typeof mu !== 'object') return {};
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const out: Record<string, SdkModelUsageEntry> = {};
  for (const [k, v] of Object.entries(mu as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    out[k] = {
      inputTokens: n(e.inputTokens),
      outputTokens: n(e.outputTokens),
      cacheReadInputTokens: n(e.cacheReadInputTokens),
      cacheCreationInputTokens: n(e.cacheCreationInputTokens),
      costUSD: n(e.costUSD),
    };
  }
  return out;
}

/**
 * Emit one `usage` frame per model that did work this turn. The SDK reports
 * `modelUsage` cumulatively across results within a single query(), so we
 * subtract the previous snapshot per-model to get this turn's delta. Mutates
 * `prev` in place to the new snapshot.
 *
 * Fallback path (modelUsage missing/empty — e.g. SDK error before any API
 * call): emit a single frame from the per-turn aggregate tagged with the
 * best model name we have.
 */
function emitUsageFrames(
  msg: Record<string, unknown>,
  phase: 'main' | 'bootstrap' | 'cleanup',
  prev: Record<string, SdkModelUsageEntry>,
  fallbackModel: string,
): void {
  const current = readModelUsage(msg);
  const keys = Object.keys(current);
  if (keys.length === 0) {
    const usage = extractUsage(msg);
    if (usage) writeOutput({ type: 'usage', phase, model: fallbackModel, ...usage });
    return;
  }
  for (const key of keys) {
    const cur = current[key];
    const old = prev[key] ?? ZERO_MODEL_USAGE;
    const dIn = cur.inputTokens - old.inputTokens;
    const dOut = cur.outputTokens - old.outputTokens;
    const dCr = cur.cacheReadInputTokens - old.cacheReadInputTokens;
    const dCc = cur.cacheCreationInputTokens - old.cacheCreationInputTokens;
    const dCost = cur.costUSD - old.costUSD;
    prev[key] = cur;
    if (dIn === 0 && dOut === 0 && dCr === 0 && dCc === 0 && dCost === 0) continue;
    writeOutput({
      type: 'usage',
      phase,
      model: key,
      input_tokens: Math.max(0, dIn),
      output_tokens: Math.max(0, dOut),
      cache_creation_input_tokens: Math.max(0, dCc),
      cache_read_input_tokens: Math.max(0, dCr),
      cost_usd: Math.max(0, dCost),
      num_turns: 1,
    });
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Stdin messages are pumped into the stream concurrently.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServers: Record<string, McpServerConfig>,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  stdinReader: StdinReader,
  resumeAt?: string,
  bootstrapContext?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; stopReason: 'close' | 'eof' | 'auth_error' | 'query_ended' }> {
  const stream = new MessageStream();
  // Cold-path cleanup spawns run the cleanup turn as the init prompt; tag it so
  // its usage is attributed to the `cleanup` phase. Otherwise the init turn is
  // a normal participant turn.
  lastInboundKind = containerInput.isCleanup ? 'lifecycle' : 'participant';
  // SIDE EFFECT: capture the spawn's conversation context so the service MCP
  // proxy can attest it onto tool calls. Constant per spawn (single conversation).
  currentCallMeta = {
    participant: containerInput.participant,
    channelName: containerInput.channelName,
    conversationKey: containerInput.conversationKey,
  };
  // currentModel persists across runQuery restarts (a mid-session setModel
  // should survive a between-queries query rebuild); seed it from the spawn
  // model on first use. prevModelUsage resets — each query() process is a
  // fresh SDK lifetime with its own cumulative counters starting at zero.
  currentModel ??= containerInput.model;
  prevModelUsage = {};
  stream.push(prompt);

  // Pump stdin messages into the stream concurrently with the query.
  // The pump runs until close/EOF; if the query finishes first, pumpResult
  // stays undefined and the main loop reads the next stdin line directly.
  let pumpResult: 'close' | 'eof' | undefined;
  stdinReader.pumpInto(stream, sdkEnv).then(
    (reason) => { pumpResult = reason; },
    (err) => { console.error('stdin pump error:', err); pumpResult = 'close'; },
  );

  currentStreamer = createTurnTextStreamer({
    write: writeOutput,
    generateStreamId: generatePreviewStreamId,
  });

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let authError = false;

  // Collect assistant text for the current turn.
  // When the agent uses tools, the final `result.result` can be null even though
  // the agent emitted text in earlier `assistant` messages. We track this so we
  // can emit the text when the result comes back empty.
  let pendingAssistantText: string[] = [];

  // Activity heartbeat for typing indicators.
  // Fires [sdk-activity] every ACTIVITY_INTERVAL while a turn is in flight so
  // the host can re-pulse typing to transports (Telegram expires after ~5s).
  // Independent of the SDK token stream — bridges long Bash/MCP tool calls
  // where no stream events flow. Suspends if no SDK message arrives within
  // DEADLOCK_THRESHOLD_MS so a hung iterator doesn't keep the indicator lit.
  // turnActive is toggled by system/init and result; lastSdkMessageAt is
  // updated on every message (including stream events) for liveness.
  const ACTIVITY_INTERVAL = 4000;
  const DEADLOCK_THRESHOLD_MS = 90_000;
  let turnActive = false;
  let lastSdkMessageAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!turnActive) return;
    if (Date.now() - lastSdkMessageAt > DEADLOCK_THRESHOLD_MS) return;
    log('[sdk-activity]');
  }, ACTIVITY_INTERVAL);

  // Resolve system prompt: prefer pre-assembled prompt from host, fall back to file-based loading
  let identitySystemPrompt: string | undefined = containerInput.systemPrompt;
  if (!identitySystemPrompt) {
    // Fallback: read identity/system-prompt.md directly
    const systemPromptPath = path.join(WORKSPACE_IDENTITY, 'system-prompt.md');
    if (fs.existsSync(systemPromptPath)) {
      identitySystemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');
    }
  }

  // Append bootstrap artifact to system prompt (regardless of source)
  if (bootstrapContext) {
    const artifact = `\n\n<bootstrap-context>\n${bootstrapContext}\n</bootstrap-context>`;
    identitySystemPrompt = identitySystemPrompt
      ? identitySystemPrompt + artifact
      : artifact;
  }

  // Collect additional directories for SDK (Read/Glob/Grep access)
  const additionalDirs: string[] = [];
  if (fs.existsSync(WORKSPACE_IDENTITY)) additionalDirs.push(WORKSPACE_IDENTITY);
  if (fs.existsSync(WORKSPACE_MEMORY)) additionalDirs.push(WORKSPACE_MEMORY);
  if (fs.existsSync(WORKSPACE_ASSETS)) additionalDirs.push(WORKSPACE_ASSETS);
  if (fs.existsSync(WORKSPACE_SHARED)) additionalDirs.push(WORKSPACE_SHARED);
  if (additionalDirs.length > 0) {
    log(`Additional directories: ${additionalDirs.join(', ')}`);
  }

  try {
  const q = query({
    prompt: stream,
    options: {
      cwd: WORKSPACE_HOME,
      ...(currentModel ? { model: currentModel } : {}),
      additionalDirectories: additionalDirs.length > 0 ? additionalDirs : undefined,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      systemPrompt: identitySystemPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: identitySystemPrompt }
        : undefined,
      includePartialMessages: true,
      disallowedTools: resolveDisallowedTools(containerInput.disabledTools),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      mcpServers,
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  });
  currentQuery = q;
  for await (const message of q) {
    // Any SDK message — including stream events — ticks the liveness clock.
    lastSdkMessageAt = Date.now();
    // Stream events are skipped from messageCount/log path; the heartbeat
    // interval (not this branch) is what emits [sdk-activity].
    // DEBUG_LOG: Removed verbose per-token logging (was causing ~99% of stderr volume).
    if (message.type === 'stream_event') {
      const ev = message.event;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        currentStreamer?.feedDelta(ev.delta.text);
      }
      continue;
    }

    messageCount++;
    // SDK message types are incomplete — cast to access undocumented fields
    const msg = message as Record<string, unknown>;
    const msgType = message.type === 'system' ? `system/${msg.subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);
    // DEBUG_LOG: Duplicate to persistent file for post-mortem analysis
    debugLog(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant') {
      if ('uuid' in msg) lastAssistantUuid = msg.uuid as string;
      // Extract text from assistant message content blocks.
      // When the agent uses tools, the result.result may be null but
      // the assistant messages contain the actual text response.
      const content = msg.message && typeof msg.message === 'object'
        ? (msg.message as { content?: unknown }).content
        : undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type: string }).type === 'text') {
            const t = (block as { text?: string }).text;
            if (t) {
              pendingAssistantText.push(t);
              currentStreamer?.commitBlock(t);
            }
          }
        }

        const hasToolUse = content.some(
          (b: Record<string, unknown>) => b && typeof b === 'object' && b.type === 'tool_use',
        );
        if (hasToolUse && pendingAssistantText.length > 0) {
          currentStreamer?.flushIntermediate(pendingAssistantText.join('\n'), newSessionId);
          pendingAssistantText = [];
        }
      }
    }

    if (message.type === 'system' && msg.subtype === 'init') {
      newSessionId = message.session_id;
      // New turn starting — reset pending text
      pendingAssistantText = [];
      turnActive = true;
      currentStreamer?.nextTurn(lastInboundKind);
      log(`Session initialized: ${newSessionId} (pipeKind=${lastInboundKind})`);
      debugLog(`[session-init] ${newSessionId} pipeKind=${lastInboundKind}`);
      // Seed currentModel from the SDK's init when the host didn't declare one
      // and no mid-session setModel has fired yet. Lets us tag the SDK-default
      // case with the real model the SDK picked, instead of 'unknown'. Does not
      // override a host-set model or a setModel'd value.
      const initModel = (msg as { model?: unknown }).model;
      if (!currentModel && typeof initModel === 'string') currentModel = initModel;
    }

    if (message.type === 'system' && msg.subtype === 'task_notification') {
      log(`Task notification: task=${msg.task_id} status=${msg.status} summary=${msg.summary}`);
    }

    // Compaction lifecycle events
    if (message.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') {
      writeOutput({ type: 'lifecycle', phase: 'compacting', active: true });
    }
    if (message.type === 'system' && msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata as { trigger: 'manual' | 'auto'; pre_tokens: number } | undefined;
      writeOutput({ type: 'lifecycle', phase: 'compacting', active: false,
        trigger: meta?.trigger, preTokens: meta?.pre_tokens });
    }

    if (message.type === 'result') {
      turnActive = false;
      resultCount++;
      let textResult = 'result' in msg ? (msg.result as string | null) : null;
      // Fall back to collected assistant text when result.result is null.
      // This happens when the agent's last action was a tool call —
      // the actual text response is in earlier assistant messages.
      if (!textResult && pendingAssistantText.length > 0) {
        textResult = pendingAssistantText.join('\n');
        log(`Result #${resultCount}: using ${pendingAssistantText.length} pending assistant text(s) (result was null)`);
      }
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      debugLog(`[result #${resultCount}] subtype=${message.subtype} hasText=${!!textResult} pendingTexts=${pendingAssistantText.length}`);
      pendingAssistantText = [];

      emitUsageFrames(
        msg,
        lastInboundKind === 'lifecycle' ? 'cleanup' : 'main',
        prevModelUsage,
        currentModel ?? 'unknown',
      );

      // Classify Claude-unreachable errors first, regardless of subtype.
      // The SDK historically routes 401s with subtype='success' + the error
      // text in the result, so we can't gate this on subtype === 'error'.
      const classifiedReason = textResult ? classifyClaudeError(textResult) : null;
      if (classifiedReason) {
        log(`Claude error detected (${classifiedReason}) in result #${resultCount}, aborting query`);
        currentStreamer?.abort('container_error');
        writeOutput({ type: 'auth_error', reason: classifiedReason });
        // Break out of the for-await loop — further messages will fail too.
        // Host picks differentiated user copy and decides whether to retry
        // (invalid-credentials only; quota/unavailable fail fast).
        authError = true;
        break;
      } else if (message.subtype === 'success') {
        currentStreamer?.flushFinal(textResult || '', newSessionId, 'success');
        // Quiescent signal — the SDK stream stays open after `result` waiting
        // for the next turn (the pump blocks on stdin). Emitting `lifecycle/
        // idle` here, INSIDE the for-await, is the only reachable place: the
        // outer-loop emit (post-for-await) is dead code in multi-turn mode
        // because the for-await doesn't return between turns. Host marks
        // _state='idle' on receipt; new stdin input flips it back to 'running'
        // via the host's deliver path.
        writeOutput({ type: 'lifecycle', phase: 'idle', active: true });
      } else if (message.subtype === 'error_max_budget_usd') {
        // SDK ran the user's budget cap to zero — same user-facing semantics
        // as a 429 (out of credits), so surface as quota-exhausted instead
        // of the generic container_error fallback.
        log(`SDK budget exhausted, mapping to quota-exhausted`);
        currentStreamer?.abort('container_error');
        writeOutput({ type: 'auth_error', reason: 'quota-exhausted' });
        authError = true;
        break;
      } else {
        // Other SDK error subtypes (`error_during_execution`, `error_max_turns`,
        // `error_max_structured_output_retries`). Deliver any partial text
        // first, then signal the error so the host's existing error path
        // sets `firstError` and the generic container_error fallback fires.
        if (textResult) {
          currentStreamer?.flushFinal(textResult, newSessionId);
        } else {
          currentStreamer?.abort('container_error');
        }
        writeOutput({
          type: 'error',
          error: `SDK turn ended: ${message.subtype}`,
          newSessionId,
        });
      }
    }
  }
  } finally {
    clearInterval(heartbeat);
    currentStreamer?.dispose();
    currentStreamer = null;
    // Drop the handle so a between-queries stdin message can't setModel on a
    // dead query; the next runQuery rebinds it.
    currentQuery = undefined;
  }

  // Query finished. Determine why.
  // DEBUG_LOG: This line confirms the for-await loop exited (not stuck).
  // If this never appears in the log file, the loop is still suspended.
  const stopReason = authError ? 'auth_error' as const : pumpResult ?? 'query_ended';
  log(`Query done (${messageCount} messages, ${resultCount} results, stopReason: ${stopReason})`);
  debugLog(`[for-await-exit] messages=${messageCount} results=${resultCount} stopReason=${stopReason}`);

  // If the query ended before the pump (no close/EOF), the pump is still blocking
  // on the next stdin line — that's fine, the main loop will continue reading.
  // We do NOT await pumpDone here to avoid deadlock; the pump will resolve
  // when the next stdin message arrives or on EOF/close.

  return { newSessionId, lastAssistantUuid, stopReason };
}

/**
 * Run a single-turn bootstrap query to gather context before the main conversation.
 * The user message is embedded in the system prompt as reference material (not as a
 * direct request), so the bootstrap focuses on context gathering rather than acting.
 * Returns the concatenated result text (the bootstrap artifact).
 */
async function runBootstrap(
  bootstrapPrompt: string,
  userMessage: string,
  mcpServers: Record<string, McpServerConfig>,
  sdkEnv: Record<string, string | undefined>,
  model: string | undefined,
  agentDisabledTools: string[] | undefined,
): Promise<string> {
  // Embed the user message into the system prompt — bootstrap sees it as
  // reference material, not a direct request to act on.
  const fullPrompt = `${bootstrapPrompt}\n\n<incoming-message>\n${userMessage}\n</incoming-message>`;

  const stream = new MessageStream();
  stream.push('Gather context per the instructions above.');
  stream.end(); // Single-turn: end immediately after pushing the prompt

  const results: string[] = [];
  // Fresh SDK lifetime — bootstrap has its own cumulative counters.
  const bootstrapPrev: Record<string, SdkModelUsageEntry> = {};
  // Captured from the SDK's init message; used as fallback model name if
  // the host didn't pass one in.
  let sdkInitModel: string | undefined;

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: WORKSPACE_HOME,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: fullPrompt },
      disallowedTools: resolveDisallowedTools(agentDisabledTools),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers,
      ...(model ? { model } : {}),
    }
  })) {
    const msg = message as Record<string, unknown>;
    if (message.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const initModel = (msg as { model?: unknown }).model;
      if (typeof initModel === 'string') sdkInitModel = initModel;
    }
    if (message.type === 'result') {
      const textResult = 'result' in msg ? (msg.result as string | null) : null;
      if (textResult) results.push(textResult);
      emitUsageFrames(msg, 'bootstrap', bootstrapPrev, model ?? sdkInitModel ?? 'unknown');
    }
  }

  return results.join('\n');
}

async function main(): Promise<void> {
  const stdinReader = new StdinReader();

  // Read init message (first line)
  let containerInput: ContainerInput;
  try {
    const initLine = await stdinReader.nextLine();
    if (initLine === null) {
      writeOutput({ type: 'error', error: 'Stdin closed before init message' });
      process.exit(1);
    }
    const initMsg: unknown = JSON.parse(initLine);
    const initParse = InitStdinMessageSchema.safeParse(initMsg);
    if (!initParse.success) {
      writeOutput({ type: 'error', error: `Invalid init message: ${initParse.error.message}` });
      process.exit(1);
    }
    containerInput = initParse.data;
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received init for agent: ${containerInput.agentFolder}`);
  } catch (err) {
    writeOutput({
      type: 'error',
      error: `Failed to parse init: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }
  // SDK feature kill-switches (DISABLE_CRON, ENABLE_TASKS=0, DISABLE_AUTO_MEMORY)
  // are NOT set here — the host injects them as container env from its fleet
  // policy table (cast's container/sdk-surface.ts), and the process.env spread
  // above carries them into the SDK. Policy lives host-side; this file only
  // asserts the runner's own contract.

  // Connect to MCP servers.
  // CAST_MCP_PORTS: TCP transport (Docker Desktop macOS) — "cast=54321,agent=54322"
  // MCP_SOCKET_PATH: single socket file, registered as "cast".
  // MCP_SOCKET_DIR: directory of .sock files (name derived from filename: cast.sock → "cast").
  // Container default: /mcp (directory scan).
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpCleanups: Array<() => Promise<void>> = [];

  const mcpPortsEnv = process.env.CAST_MCP_PORTS;
  if (mcpPortsEnv) {
    // TCP transport: connect to host MCP servers via host.docker.internal
    for (const entry of mcpPortsEnv.split(',')) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) continue;
      const name = entry.slice(0, eqIdx);
      const port = parseInt(entry.slice(eqIdx + 1), 10);
      if (!name || isNaN(port)) continue;
      const mcpHost = process.env.CAST_MCP_HOST || 'host.docker.internal';
      const url = `http://${mcpHost}:${port}/mcp`;
      log(`Connecting to MCP via TCP: ${url} (name: ${name})`);
      try {
        const { sdkServer, close } = await createMcpTcpProxy(url, name, name === SERVICE_MCP_NAME ? () => currentCallMeta : undefined);
        mcpServers[name] = sdkServer;
        mcpCleanups.push(close);
      } catch (err) {
        log(`Failed to connect to MCP TCP ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    // Socket transport: scan /mcp/*.sock or use MCP_SOCKET_PATH
    const mcpSocketPath = process.env.MCP_SOCKET_PATH;
    if (mcpSocketPath) {
      log(`Connecting to MCP socket: ${mcpSocketPath} (name: cast)`);
      try {
        const { sdkServer, close } = await createMcpSocketProxy(mcpSocketPath, 'cast');
        mcpServers['cast'] = sdkServer;
        mcpCleanups.push(close);
      } catch (err) {
        log(`Failed to connect to MCP socket ${mcpSocketPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const mcpSocketDir = process.env.MCP_SOCKET_DIR || '/mcp';
      if (fs.existsSync(mcpSocketDir)) {
        const sockFiles = fs.readdirSync(mcpSocketDir).filter((f) => f.endsWith('.sock'));
        for (const sockFile of sockFiles) {
          const sockPath = path.join(mcpSocketDir, sockFile);
          const serverName = sockFile.replace(/\.sock$/, '');
          log(`Connecting to MCP socket: ${sockPath} (name: ${serverName})`);
          try {
            const { sdkServer, close } = await createMcpSocketProxy(sockPath, serverName, serverName === SERVICE_MCP_NAME ? () => currentCallMeta : undefined);
            mcpServers[serverName] = sdkServer;
            mcpCleanups.push(close);
          } catch (err) {
            log(`Failed to connect to MCP socket ${sockPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        log(`MCP socket directory not found at ${mcpSocketDir}, running without MCP tools`);
      }
    }
  }

  /** Close MCP socket connections so the event loop can drain. */
  async function closeMcpConnections(): Promise<void> {
    await Promise.allSettled(mcpCleanups.map(close => close()));
  }

  let sessionId = containerInput.sessionId;

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]\n\n${prompt}`;
  }
  if (containerInput.attachments?.length) {
    const refs = containerInput.attachments.map((a) =>
      `[Attachment: ${a.filename} | ${a.path} | ${a.mimeType} | ${a.filesize} bytes]`,
    ).join('\n');
    prompt = prompt ? `${prompt}\n\n${refs}` : refs;
  }

  // Bootstrap phase: gather context before the main conversation.
  // Runs a separate single-turn query with the bootstrap prompt as system prompt.
  // The artifact is appended to the identity system prompt for the main query.
  let bootstrapContext: string | undefined;
  if (containerInput.bootstrap) {
    log('Running bootstrap phase...');
    writeOutput({ type: 'lifecycle', phase: 'bootstrap', active: true });
    try {
      const artifact = await runBootstrap(
        containerInput.bootstrap,
        containerInput.prompt,
        mcpServers,
        sdkEnv,
        containerInput.bootstrapModel ?? containerInput.model,
        containerInput.disabledTools,
      );
      if (artifact) {
        log(`Bootstrap complete (${artifact.length} chars)`);
        bootstrapContext = artifact;
      } else {
        log('Bootstrap returned empty result');
      }
    } catch (err) {
      log(`Bootstrap failed, proceeding without artifact: ${err instanceof Error ? err.message : String(err)}`);
    }
    writeOutput({ type: 'lifecycle', phase: 'bootstrap', active: false });
  }

  // Query loop: run query → if query ends before close/EOF, wait for next stdin message → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
      debugLog(`[query-start] session=${sessionId || 'new'} resumeAt=${resumeAt || 'latest'}`); // DEBUG_LOG

      let queryResult: Awaited<ReturnType<typeof runQuery>>;
      try {
        queryResult = await runQuery(prompt, sessionId, mcpServers, containerInput, sdkEnv, stdinReader, resumeAt, bootstrapContext);
      } catch (resumeErr) {
        // If we were trying to resume a session and it failed (e.g. stale session
        // from a different mode, deleted transcript, corruption), retry fresh.
        if (sessionId) {
          const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
          log(`Session resume failed (${msg}), retrying with fresh session`);
          sessionId = undefined;
          resumeAt = undefined;
          queryResult = await runQuery(prompt, sessionId, mcpServers, containerInput, sdkEnv, stdinReader, resumeAt, bootstrapContext);
        } else {
          throw resumeErr;
        }
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If close, EOF, or auth error was received during the query, exit.
      // Auth error: token is dead — host will refresh and respawn.
      if (queryResult.stopReason === 'close' || queryResult.stopReason === 'eof' || queryResult.stopReason === 'auth_error') {
        log(`${queryResult.stopReason} during query, exiting`);
        break;
      }

      // lifecycle/idle was already emitted inside runQuery's for-await right
      // after the `result: success` message — this is where the runner is
      // actually quiescent. Reaching the outer-loop "between queries" point
      // is rare (only when the SDK stream itself returns end-of-iteration,
      // not after every turn); no extra emit needed here.

      log('Query ended, waiting for next stdin message...');

      // Wait for the next message from stdin
      const nextLine = await stdinReader.nextLine();
      if (nextLine === null) {
        log('Stdin EOF while waiting, exiting');
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(nextLine);
      } catch {
        log(`Ignoring malformed stdin line between queries: ${nextLine.slice(0, 100)}`);
        continue;
      }
      const interParse = StdinMessageSchema.safeParse(parsed);
      if (!interParse.success) {
        log(`Ignoring invalid stdin message between queries: ${nextLine.slice(0, 100)}`);
        continue;
      }
      const msg = interParse.data;

      if (msg.type === 'close') {
        log('Close received between queries, exiting');
        break;
      }

      if (msg.type === 'secrets') {
        // SIDE EFFECT: Mutates sdkEnv (see StdinReader.pumpInto for rationale)
        for (const [key, value] of Object.entries(msg.data)) {
          sdkEnv[key] = value;
        }
        log('Secrets refreshed between queries');
        continue;
      }

      if (msg.type === 'message') {
        log(`Got message between queries (${msg.text.length} chars), starting new query`);
        // Track kind for the next runQuery's system/init handler.
        lastInboundKind = 'participant';
        // A model carried between queries persists into the rebuilt query
        // (runQuery seeds its model from currentModel). No live query to
        // setModel here — the next query() is constructed with it directly.
        if (msg.model) currentModel = msg.model;
        prompt = msg.text;
        continue;
      }

      if (msg.type === 'system') {
        log(`Got system message between queries (${msg.text.length} chars), starting new query`);
        lastInboundKind = 'system';
        prompt = `[SYSTEM] ${msg.text}`;
        continue;
      }

      log(`Ignoring unexpected message type between queries: ${msg.type}`);
    }

    // Normal exit: close handles we own, then force-exit.
    // The SDK spawns a claude CLI subprocess that may outlive the query()
    // generator — we can't close third-party handles, so process.exit()
    // is required (same pattern as the error path below).
    stdinReader.close();
    await closeMcpConnections();
    process.exit(0);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(`Agent error: ${errorMessage}`);
    if (errorStack) log(`Stack: ${errorStack}`);
    currentStreamer?.abort('container_error');
    writeOutput({
      type: 'error',
      error: errorMessage,
      newSessionId: sessionId,
    });
    process.exit(1);
  }
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    try { currentStreamer?.abort('container_error'); } catch { /* best-effort */ }
    // Flush the final frame — Node's default non-blocking stdout drops it otherwise.
    const stdoutHandle = (process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
    if (stdoutHandle?.setBlocking) stdoutHandle.setBlocking(true);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

main();
