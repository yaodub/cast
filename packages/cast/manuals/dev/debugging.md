# Debugging Cast — message pipeline reference

End-to-end guide for diagnosing agent behavior — from inbound user message to outbound delivery. Use this when the question is "why did the agent do X?" or "why didn't the message arrive?" to identify whether the issue is plumbing (routing, delivery), prompting (system prompt, task prompt), or agent behavior (tool calls, model decisions).

This is the host-side debug surface. For *aspirational* introspection ("how can this agent become more itself?"), see [`agent-introspection.md`](agent-introspection.md) — different question, different discipline. Debug asks *what broke?*; introspection asks *what should grow?*

## Message lifecycle

```
User message (via any configured transport)
  ↓
Transport → Gateway (packet persisted) → Bus → AgentManager.handleMessage()
  ↓
AgentManager.route() → resolveConversation() → ConversationRunner.deliver()
  ↓  (queued if idle, piped via IPC if running)
ConversationRunner.spawn() → container-runner → Apple Container / Docker
  ↓
agent-runner (init → MCP connect → bootstrap → query())
  ↓
Claude Agent SDK → Claude API (tool calls, responses)
  ↓
agent-runner writeOutput() → stdout markers → container-runner parser
  ↓
ConversationRunner.handleContainerOutput() → splitInternal/splitQueries/splitAnswers
  ↓
AgentManager.handleOutboundOutput() → ACL check → Bus.routeMessage()
  ↓
Gateway (packet persisted) → Transport.deliver() → recipient
```

## Delivery semantics

Cast guarantees **at-most-once** delivery within a process lifetime. Implications for debugging:

- **Fire-and-forget paths** (`bus.routeMessage`, `bus.routeEvent`, `void this.route(...)` in MCP tools and console verbs) return after queueing the dispatch — they do not await downstream handler completion. Failures are surfaced via `logger.error`, not via the calling tool's return value.
- **No retries.** A transient failure in a downstream handler (DB busy, target unregistered, transport down) drops the message. The caller has already returned `{ ok: true }` to its LLM.
- **Best-effort shutdown.** Graceful shutdown does not flush in-flight bus dispatches before `process.exit`. Messages mid-flight at SIGTERM may be lost. Operator-initiated shutdown is best-effort by design.
- **The persistence boundary is durable state**, not routing packets — `agent.db`, `gateway.db`, `conversations.jsonl`, `tasks.json`, `config/acl.json`, `config/user-push.json`. Any data the system must not lose lives there.

When debugging *"the agent reported success but the message never arrived"*, check `logger.error` for the dispatch site — that's where fire-and-forget failures surface.

**Framework-injected retries are a separate mechanism.** The at-most-once guarantee covers the *gateway dispatch path* (downstream of `bus.routeMessage`). It does *not* cover the *upstream re-injection path*: when a framework-generated outbound (e.g. `emitFallback`'s *"Agent stopped without producing a response"*, or any `<cast:query>` that ACL-denies on the source side) is rejected, `deliverSystem` writes the rejection text back into the same conversation's mailbox as a `<cast:system>` notice. The next spawn cycle drains it, the agent re-emits, the rejection fires again — a retry mechanism wearing the costume of a one-shot notification. This loop is bounded by `MAX_ABNORMAL_EXITS = 3` (`packages/cast/src/conversations/conversation.ts`), but without that cap there's no structural break. If you see `abnormal_exit_cap_hit` in `agent.db.events`, that's this guard firing.

## Path conventions

All paths below are relative to the **config and agents roots**:

| Root | Env var (default) |
|------|-------------------|
| Agents | `$CAST_AGENTS_DIR` (default `~/.cast/agents/`) |
| Config + gateway | `$CAST_CONFIG_DIR` (default `~/.cast/config/`) |
| Dev override | When running `pnpm dev` in the repo, the defaults shift to `mnt/agents/` and `mnt/config/` |

Examples below show `~/.cast/...`; substitute your `$CAST_AGENTS_DIR` / `$CAST_CONFIG_DIR` if you've overridden them.

## Driving an agent from the command line

Send a prompt directly via the admin chat HTTP route — same gateway + routing the admin UI uses, no browser. Localhost-only.

```bash
# Default Cast port is 5051; override via CAST_PORT
TOKEN=$(curl -s http://127.0.0.1:5051/api/auth/session \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Send — returns 204, reply arrives async
curl -sS -X POST http://127.0.0.1:5051/api/admin/agents/<folder>/chat/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"__configure","text":"your prompt"}'
```

**Channels:** `__design` (blueprint, full internet), `__configure` (ops, `sdk-only`), or any user channel (`default`, custom names from `blueprint/channels/`).

**Use it for** dogfooding prompt / mount / MCP-tool changes, reproducing a reported bug headlessly, or smoke-testing prompt injection (ask a question whose answer depends on the new data).

**Reading replies.** The send returns 204; the reply lands asynchronously in one of two places:

```bash
# Server-side ground truth — agent.db message_log table, scoped to the agent + channel.
# Wait briefly for the container to spawn + reply (first spawn is slow; subsequent messages reply in seconds).
sleep 20
sqlite3 ~/.cast/agents/<folder>/state/agent.db \
  "SELECT direction, substr(text, 1, 200) FROM message_log
     WHERE channel = '__configure' ORDER BY id DESC LIMIT 6;"
```

Note: console channels (`__design`, `__configure`, server-scope managers) **do not write to the per-agent `agent.db.message_log`** — they go through `ConsoleManager` and persist transcripts to a separate `console.db` (per-agent at `state/console.db`, server-scope at `$CAST_CONFIG_DIR/server-console.db`). For console-channel reads, query that file or watch the `/api/admin/events` SSE stream live.

**Poll-until-done pattern** for the per-agent user channel (`default` or any non-console channel that lands in `agent.db`):

```bash
BEFORE=$(sqlite3 ~/.cast/agents/<folder>/state/agent.db \
  "SELECT count(*) FROM message_log WHERE channel = 'default';")
until [ "$(sqlite3 ~/.cast/agents/<folder>/state/agent.db \
  "SELECT count(*) FROM message_log WHERE channel = 'default';")" -gt "$((BEFORE + 1))" ]; do
  sleep 3
done
sqlite3 ~/.cast/agents/<folder>/state/agent.db \
  "SELECT direction, substr(text, 1, 300) FROM message_log
     WHERE channel = 'default' ORDER BY id DESC LIMIT 4;"
```

For *live* events — typing indicators, message_received, lifecycle phases, push deliveries — subscribe to `GET /api/admin/events` (SSE, multiplexed across all agents and managers). The first event is `event: ready` carrying the agent + manager roster; subsequent events are scoped per-agent.

**Gotchas with the dogfood path:**

- `/history` shows post-`validateAgentOutput` text only — `<cast:internal>...</cast:internal>` wrapped output lands in `message_log.internal` or the session JSONL, not here.
- The operator resolves as an operator-tier surface (a bare `admin:`/`cli:` handle, full bits); this path bypasses user-ACL checks you might otherwise see. To exercise real user-ACL paths, use the CLI WebSocket transport (`/cli`) or a configured external transport with a real granted user.
- SSE-only transports (browser `ui_directive` navigations, transport-specific rendering) aren't exercised — confirm those fired via host logs instead.

## Where to look (ordered by usefulness)

### 1. Gateway DB — what the user actually received

**Location:** `$CAST_CONFIG_DIR/gateway.db`

The single source of truth for what was delivered. Every outbound message becomes a packet here.

```sql
-- What did user X receive from agent Y today?
SELECT id, substr(text, 1, 120), timestamp, delivered_at
FROM packets
WHERE from_addr LIKE '%<agent>%'
  AND timestamp > '2026-04-05T00:00:00'
ORDER BY timestamp;

-- Undelivered packets (transport failure)
SELECT * FROM packets WHERE delivered_at IS NULL;
```

If the message isn't in the gateway, the problem is upstream (agent didn't produce output, or output was filtered).

### 2. Agent message log — full conversation record

**Location:** `~/.cast/agents/<folder>/state/agent.db`, table `message_log` (FTS5 index: `message_log_fts`). The same bundle is installed on console DBs — per-agent `state/console.db` and server-scope `$CAST_CONFIG_DIR/server-console.db` — so the same query shape works against console history.

**Gating:** writes are conditional on `channel.log_messages: true` (default). Channels with `log_messages: false` skip the store injection at runner construction, so `logInbound` / `logOutbound` / `logEvent` are no-ops for that channel. Empty `message_log` results when you expected rows? Check the channel's `log_messages` setting first.

Logs both inbound (user → agent) and outbound (agent → user) messages with full text. Inbound is logged when `deliver()` is called on the `ConversationRunner`; outbound is logged when non-intermediate output is processed.

```sql
-- Recent messages in a conversation
SELECT id, direction, substr(text, 1, 150), timestamp
FROM message_log
WHERE timestamp > '2026-04-05T13:00:00'
ORDER BY timestamp;

-- Full-text search across history
SELECT m.id, m.direction, m.timestamp, snippet(message_log_fts, 0, '[', ']', '…', 16)
FROM message_log m
JOIN message_log_fts ON message_log_fts.rowid = m.id
WHERE message_log_fts MATCH 'your search term';
```

Key observations:

- **Inbound messages you didn't send** → something else is routing to this conversation (scheduled task, cross-agent request, self-push loop).
- **No outbound messages** → agent produced no non-intermediate output.
- **Outbound text doesn't match gateway** → output was filtered by `validateAgentOutput` (wrapped in `<cast:internal>` tags).
- **Console planning content showing up in user-channel reasoning** → architectural bug. Console history is supposed to live in a separate file (`console.db` or `server-console.db`), never in `agent.db`. Check the agent didn't query `console_log__*` tools from a user-channel runner.

### 3. Host server logs — routing and lifecycle events

**Location:** depends on your supervisor — `pm2 logs cast`, `journalctl -u cast` (systemd), the dev process's stdout (`pnpm dev`), or wherever you piped output. The Cast server emits structured JSON (pino).

**Key log messages to search for:**

| Message | What it means | Source file |
|---------|--------------|-------------|
| `Session opened` | New conversation created | `agent-manager.ts` |
| `Message queued in conversation` | Queued for next spawn (container not running) | `conversation-runner.ts` |
| `Piped message to active container` | Delivered via IPC to running container | `conversation-runner.ts` |
| `Spawning container for conversation` | Container launch (shows `isNew`, `singleShot`, `mountCount`) | `conversation-runner.ts` |
| `Container output received` | Output parsed from container stdout (shows `isIntermediate`, `hasResult`) | `conversation-runner.ts` |
| `Agent output` | Final text being routed to user (first 80 chars) | `conversation-runner.ts` |
| `Outbound message blocked` | ACL check failed (no `o` bit) | `agent-manager.ts` |
| `Container completed` | Container exited (shows `duration`, `newSessionId`) | `container-runner.ts` |
| `Dispatching scheduled task` | Scheduler firing a DB task | `agent-scheduler.ts` |
| `Output marker parsed` | Sentinel markers found in container stdout (`type`: lifecycle/message) | `container-runner.ts` |

**Tracing a specific message** (substitute your log location):

```bash
# Find when a message was ingested
grep '"Message ingested"' <log-file> | grep '<agent>' | tail -5

# Find what happened after container output
grep '<agent>' <log-file> | grep -E '"Agent output"|Container output' | tail -10

# Check for lifecycle events sent to a transport
grep '<agent>' <log-file> | grep 'lifecycle' | tail -10
```

Set `LOG_LEVEL=debug` for additional verbosity (container stderr, stdout parsing, MCP details, container output received).

### 4. Agent-runner debug log — SDK message flow

**Location:** `~/.cast/agents/<folder>/home/.agent-runner.log`

Persistent file written inside the container. Shows the agent-runner's view of the SDK conversation: every message type, result events, and output writes. Survives container restarts.

```
[HH:MM:SS.mmm] [query-start] session=... resumeAt=...      ← new query() call
[HH:MM:SS.mmm] [session-init] <session-id>                  ← SDK initialized turn
[HH:MM:SS.mmm] [stdin-message] <first 80 chars>             ← message piped mid-session
[HH:MM:SS.mmm] [msg #N] type=assistant|result|system/...    ← SDK message received
[HH:MM:SS.mmm] [result #N] subtype=success hasText=true     ← SDK result event
[HH:MM:SS.mmm] [writeOutput] type=message hasResult=true    ← output written to stdout
[HH:MM:SS.mmm] [for-await-exit] messages=N results=N        ← query() loop exited
```

**What to look for:**

- `[for-await-exit]` never appears → SDK stuck (never yielded `done: true`).
- `[result #N]` with `hasText=false` → agent turn produced no text (tool-only, or empty response).
- `[writeOutput]` appears but nothing in gateway → problem is host-side (output routing, ACL, transport).
- `[stdin-message]` appearing unexpectedly → something piped a message you didn't send (push loop, cross-agent).
- Gap >60s between `[stdin-message]` and next `[msg]` → SDK processing or stuck.

### 5. Session transcript — full API-level conversation

**Location:** `~/.cast/agents/<folder>/sessions/<conv-key>/.claude/projects/-home-agent/<session-id>.jsonl`

The raw Claude Agent SDK JSONL transcript. Shows every message, tool call, and tool result exchanged with the API. This is the definitive record of what the agent did and why.

**Finding the right file:**

```bash
# Session ID is in the agent-runner log [session-init] entry,
# or in host logs "Container completed" → newSessionId
ls -lt ~/.cast/agents/<folder>/sessions/<conv-key>/.claude/projects/-home-agent/*.jsonl | head -3
```

**Parsing tool calls:**

```bash
python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for i, line in enumerate(f, 1):
        d = json.loads(line)
        if d.get('type') != 'assistant': continue
        for c in d.get('message', {}).get('content', []):
            if not isinstance(c, dict): continue
            if c.get('type') == 'tool_use':
                print(f'[{i}] {c[\"name\"]}: {json.dumps(c.get(\"input\",{}))[:200]}')
            elif c.get('type') == 'text' and c.get('text','').strip():
                print(f'[{i}] text: {c[\"text\"][:200]}')
" <path-to-session.jsonl>
```

**Parsing tool results:**

```bash
python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for i, line in enumerate(f, 1):
        d = json.loads(line)
        if d.get('type') != 'user': continue
        for c in d.get('message', {}).get('content', []):
            if isinstance(c, dict) and c.get('type') == 'tool_result':
                rc = c.get('content', '')
                if isinstance(rc, list):
                    rc = ' '.join(x.get('text','')[:100] for x in rc if isinstance(x, dict))
                print(f'[{i}] result: {str(rc)[:200]}')
" <path-to-session.jsonl>
```

### 6. Scheduled tasks — task state and dispatch history

**Location:** `~/.cast/agents/<folder>/state/tasks.json`

Contains task definitions (prompt, schedule, target participant) and run logs.

```bash
python3 -c "
import json
data = json.load(open('$HOME/.cast/agents/<folder>/state/tasks.json'))
for t in data['tasks']:
    print(f'{t[\"id\"]} [{t[\"status\"]}] next={t.get(\"next_run\")} last={t.get(\"last_run\")}')
    print(f'  {t[\"prompt\"][:100]}')
"
```

Check host logs for `"Dispatching scheduled task"` to see when/if the scheduler fired.

## Cross-check at the right layer

The chat history shows what the user would see after `validateAgentOutput` stripped `<cast:internal>` wrapping. Reality-check against the layer that matches your question:

| Question | Check |
|----------|-------|
| Did the agent actually spawn with my new mount config? | Host log: `"Spawning container"` has a `mountCount` field. Compare against expected. |
| Did the agent pick up my prompt edit? | First reply after `tsx watch` reload. If the agent is in the middle of a session, the old prompt persists — call `agent__expire_conversations` or wait for TTL. |
| Was the session fresh, expired, or invalidated? | Host log: `"...session opened"` has a `reason:` field — `fresh`, `expired`, or `invalidated`. `invalidated` means an `agent-registry.changed` event fired and the runner respawned. |
| Did SDK session continuity survive a respawn? | After an invalidation-triggered respawn, ask the agent something from earlier turns. If it recalls verbatim, `sessionIdOverride` threading worked. If it says "new conversation," the `.claude/` dir mount or resume logic is broken. |
| Did the model invoke my new MCP tool? | Session transcript at `sessions/<key>/.claude/projects/-home-agent/*.jsonl` — look for `tool_use` entries. |
| Did the ACL block the reply? | Host log: `"Outbound message blocked"`. |
| Did the packet reach the gateway? | `sqlite3 ~/.cast/config/gateway.db 'SELECT * FROM packets ORDER BY id DESC LIMIT 5'`. |

## Common debugging scenarios

### Agent received a message but user got no response

1. **Gateway DB** — is there an outbound packet? If not, the output never made it to delivery.
2. **Agent message log** — is there an outbound message? If not, the agent produced no output (or wrapped it in `<cast:internal>`).
3. **Host logs** — search for `"Agent output"`. If present, check for `"Outbound message blocked"` (ACL). If absent, the container produced no output.
4. **Agent-runner log** — does `[writeOutput]` appear? If not, the SDK turn never completed (check `[for-await-exit]`).
5. **Session transcript** — what was the last assistant message? Did the agent use tool calls but produce no text?

### Agent produced wrong/unexpected output

1. **Session transcript** — read the full tool call sequence. The issue is usually:
   - Agent read the wrong files (check `Read` tool inputs).
   - Agent misinterpreted the prompt (check the system prompt and user message).
   - Agent used the wrong MCP tool (check `tool_use` names and inputs).
   - Agent's tool call returned unexpected results (check `tool_result` entries).

2. **Agent-runner log** — check `[stdin-message]` entries. Were unexpected messages piped in mid-session? Messages piped to a running container appear as user messages in the SDK conversation and can redirect the agent's behavior.

### Intermediate/internal messages leaking to user

Intermediate messages (agent text before a tool call) are delivered to the user when `intermediateMessages: true` (the default). These appear as `isIntermediate: true` in `"Container output received"` host logs.

The `<cast:internal>` tag mechanism is separate: `validateAgentOutput()` strips `<cast:internal>...</cast:internal>` wrapped text from any output (intermediate or final). The stripped text is logged in the agent DB `internal` column but never sent to the user. Malformed cast tags (unclosed, nested, oversized) are blackholed entirely — final-output failures are fed back to the agent via a `<system>` message and counted toward a 3-strike close.

### Scheduled task fires but briefing content missing

Check if the agent used `conversation__push_to_channel` to send the output. If it pushes to the **same channel + participant** as its own running conversation, the message gets piped back to itself (self-referential loop). Cast's self-loop guard catches this in the routing layer (`deliverToChannel` in `agent-mcp-deps.ts`); if you see this in flight, the guard surfaced an error. The session transcript will show:

- `tool_use: mcp__cast__conversation__push_to_channel` with matching channel.
- `tool_result: "Cannot push to your own active conversation. ..."` (error response).
- For loops that bypass the guard (e.g. via the bus path): the pushed text appears as a subsequent `stdin-message` in the agent-runner log.

The gateway will only show the agent's final summary text (e.g., "Briefing delivered"), not the actual briefing content.

### Lifecycle messages appearing on a transport

Some transports surface lifecycle events as user-visible messages:

- `"_Refreshing context…_"` → bootstrap phase started (new conversation).
- `"_Waiting for a free slot…_"` → concurrency gate queued.
- `"_Compressing conversation history…_"` → context compaction in progress.

These are cosmetic — the conversation is working. If you only see the lifecycle message and no response, the issue is upstream (agent produced no output).

### Container starts but the agent has no `mcp__*` tools

The container spawns and the conversation runs, but the agent only ever uses `Bash`, `Read`, `ToolSearch` — it never calls an `mcp__cast__*` tool, and may visibly hunt for tools that never loaded. The MCP transport (`config.ts` `MCP_TRANSPORT`) failed to connect, so the runner started with zero MCP tools.

Which transport is in play depends on the OS + container runtime, and the failure mode differs:

- **Socket mode** (Apple Container, native docker on bare Linux) — check the agent-runner log for `Connecting to MCP socket:` and `Failed to connect to MCP socket`. A missing `$CAST_AGENTS_DIR/<folder>/mcp/*.sock`, or a socket that didn't survive the bind-mount, points here. VM-backed and network filesystems can strip the socket inode so it never appears as a socket inside the container.
- **TCP mode** (Docker Desktop macOS/Windows, and — currently — native docker inside WSL2) — the runner logs `Connecting to MCP via TCP:` and `Failed to connect to MCP TCP …`. On native docker (bare Linux or in a WSL2 distro), the host MCP server binds `127.0.0.1`, which a container on the docker0 bridge can't reach → `ECONNREFUSED` → no tools.

To pin down which behavior is biting on a given host, reproduce the two by hand. For socket mode: have the host create a unix socket, bind-mount it into a throwaway container, and connect to it — if the connect fails or the path isn't a socket inside the container, the file-sharing layer can't carry sockets and the host needs TCP. For TCP mode: bind a trivial listener on the host and reach it from a throwaway container via `host.docker.internal` — if `127.0.0.1` is refused but the bridge-gateway IP (or `0.0.0.0`) answers, the loopback bind is the cause and that host should bind the gateway IP (or use socket mode where viable).

### Container tool fails silently

The agent container image is minimal — Node.js, Git, and Claude Agent SDK. Scripts requiring Python, pip, or other runtimes will fail from the agent's perspective (`Bash` tool returns an error, agent may or may not report it).

Check the session transcript for `Bash` tool calls and their results to see what the agent tried and what failed.

### SDK turn never completes

The `for await` loop in `runQuery` is stuck — the SDK's async generator hasn't yielded `done: true`.

1. **Agent-runner log** — is `[for-await-exit]` missing?
2. Look for `[msg #N]` entries — is the SDK still receiving messages? (Subagent or background task running.)
3. **Session transcript** — what was the last message? Is there a `stop_reason`?
4. Container may need restart if the SDK subprocess died silently.

### Cross-agent request/response issues

The cross-agent pipeline has many stages. Isolate which stage failed:

```
Source agent output → splitQueries() → onRequest hook → ACL check → bus.routeMessage
  → Target handleMessage → ACL check → format → route → deliver/pipe
  → Target processes → Target output → splitAnswers() → onResponse hook
  → bus.routeMessage → Source handleMessage → format → route → deliver/pipe
  → Source processes → Source output → onOutput → bus → transport → user
```

Search host logs for `requestId` to trace the full lifecycle.

**Held (askable) edges and `<cast:pending>`.** When the target's receiver-side edge is askable — no grant, no tombstone, the owner simply hasn't decided yet — the request is held and the source gets a non-terminal `<cast:pending>` keyed on the `requestId`, *not* a `<cast:rejection>`. The source's `outbound_requests` row stays `open` throughout; it resolves only on the real outcome (`fulfilled` on the owner-approved answer, `rejected` on a deny or TTL expiry). A row stuck at `open` alongside a raised owner approval is the normal pending state, not a leak. If you instead see the row flip to `rejected` the moment the request is held — before the owner decides — that is the q/a-answer-orphaned regression: the pending notice must ride the `pending` packet, never the terminal `rejection` packet that closes the row and orphans the eventual answer.

## Reset a session without restarting the server

Sessions live ~30min by default (channel's `idle_timeout`). To force a fresh container with the current prompt/mount config:

- **Per-agent user channel:** `/expire` (system command) on the target channel, or call `agent__expire_conversations` via any tool.
- **Console session:** call `agent__expire_conversations`, or delete the conversation's session dir: `rm -rf ~/.cast/agents/<folder>/sessions/<conv-key>/.claude`.
- **Server-scope managers (DM / CM / SM):** delete `~/.cast/agents/.<console>/sessions/<conv-key>/`.

Caveat: MCP tool schemas cache per-session on the Claude SDK side. A change to a tool's args Zod schema requires a **new session** — edits alone don't propagate to a running container.

## Filing a Cast bug report

When a debug session lands on a **defect in Cast itself** — a wrong result, crash, leak, or stuck pipeline whose root cause is code under `packages/`, not an agent's blueprint or the operator's config — the terminal artifact is a standardized report a maintainer can act on without re-deriving what you already found. Two boundaries keep this lane clean:

- **Not an alignment issue.** An agent that behaved wrongly *because its blueprint told it to* is a `/cast-refine` question, not a bug. File a report only when the runtime did something its code shouldn't.
- **Not a misconfiguration.** A missing secret, a wrong ACL bit, an unset env var — name the fix; don't file it. File a report when correct config still produces the defect.

### The mechanism is the proof

A Cast bug report is **a mechanism that is its own proof** — a witnessed causal trace, through the actual code and state, ending in a violated contract. Reproduction is not the evidence; the mechanism is. A reader who knows the codebase should follow the trace and agree it misbehaves *without running anything*.

This is a deductive standard, not an inductive one. Repro shows *that* the bug occurs; the mechanism shows *why it must* — and the "why" is what the fix needs. So:

- **A symptom with no mechanism is not a report** — it's an open lead. *"The agent gave no reply"* is where debugging starts, not where it ends. Keep reading until you can trace the chain.
- **Reproduction fills only the steps the mechanism couldn't witness.** A fully witnessed trace needs no repro; one inferred step is closed by a targeted probe or a repro of *that step*. Repro's necessity is exactly the mechanism's incompleteness.
- **"Expected behavior" is not a separate wish** — it's the contract the final step violates. The trace *ends* on it: this step requires invariant X; an earlier step established ¬X; therefore the outcome is wrong.

The discipline that makes this hold — non-negotiable, because an LLM writes the report and an LLM may act on it — is that **every load-bearing step is witnessed**: by a code reference (`format.ts:NN` does this) or by ground-truth state (`message_log id=4823` proves this). A confident-sounding step you couldn't witness is a hypothesis wearing the costume of a proof — mark it as inferred, don't smuggle it in as fact. A fabricated mechanism doesn't just mislead a skeptical human triager; it compounds into the next agent's fix.

### Environment block

Gather it from the host, at the repo root:

```bash
# Cast bug report — environment (safe to share: reads no secrets)
{
  echo "Cast:      $(node -p 'require("./package.json").version') @ $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain 2>/dev/null)" ] && echo ' (dirty)' )"
  echo "Node:      $(node --version)   pnpm $(pnpm --version)"
  echo "OS:        $(uname -srm)$( [ "$(uname)" = Darwin ] && printf ' / macOS %s' "$(sw_vers -productVersion)" )"
  if command -v container >/dev/null 2>&1; then echo "container: $(container --version 2>&1 | head -1)"; fi
  if command -v docker    >/dev/null 2>&1; then echo "docker:    $(docker --version 2>&1 | head -1)"; fi
}
```

Then add the **resolved** runtime + transport from the *running* server — a fresh probe can disagree with what the live process cached at startup. Copy two lines from the host logs:

- the startup banner `Cast <version> ready`, and
- the structured `Container runtime ready` line — it carries `runtime`, `runtimeVersion`, `capAdd`, and `mcpTransport` (socket vs TCP). The transport mode is the single most useful field for any "agent has no `mcp__*` tools" or container-networking bug.

If the defect involves an extension or transport, name it and its non-secret config shape here too — version, mode, which capability fired.

### Redaction — the report leaves the machine

Build the report from non-secret sources only, and sanitize evidence before pasting it. The diagnostic *shape* is what the fixer needs; the contents usually aren't.

- **Never include:** values from `.env` (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, auth tokens), transport credentials from `routes.json`, OAuth material from `auth.json`. The environment block above reads none of these — keep it that way.
- **Sanitize:** private message bodies (`message_log.text`, gateway `packets.text`, transcript user/assistant content) — quote only the fragment that shows the defect, replace the rest with `[…]`. User PII — real names, emails, phone numbers, Telegram/email chat IDs. A home path only when the username in it isn't relevant.
- **Keep — useful and non-identifying:** markers and cast tags, tool names and arg *shapes*, error strings, row/byte/turn counts, timestamps and durations, session ids, conversation keys, `requestId`s.

### Report template

```markdown
# Cast bug: <one-line summary>

**Severity:** crash | data-loss | wrong-behavior | cosmetic
**Scope:** one agent | fleet | server

## Mechanism — the proof
<The causal chain, traced through the actual code and state, ending in the
 violated contract. Number the steps; each load-bearing step cites its witness
 in [brackets]; mark any step you inferred rather than witnessed. Done right, a
 reader who knows the codebase agrees it misbehaves without running anything.

 1. Agent emits a final output containing an unclosed `<cast:internal>`.
 2. `validateAgentOutput` (format.ts:NN) classifies it malformed and blackholes
    the *whole* output — writes it to message_log.internal, never to the gateway.
    [message_log id=4823 has the text in `internal`; gateway has no packet for
     this turn]
 3. The malformed-final path re-feeds the rejection as a `<cast:system>` notice;
    the next spawn re-emits; the rejection re-fires, counting toward the close.
    [agent.db events row `abnormal_exit_cap_hit`]
 4. Contract violated: one malformed tag must degrade to *delivering the stripped
    text*, not silently drop the turn and arm the 3-strike close.
    ⟹ user gets no reply though the agent produced one.>

## Evidence
<The witnesses cited above, coordinates first so they can be re-queried, snippet
 second: gateway.db packet ids, agent.db `message_log` / `events` ids, transcript
 path + turn index, host log line + timestamp. Sanitized per the redaction rules.>

## Environment
<the env block + the two server log lines>

## Symptom
<what the operator or user actually saw — one or two lines. The mechanism above
 is the substance; this is just the surface it produced.>

## Reproduction
<Only as far as the mechanism has unwitnessed steps — repro closes exactly those
 gaps. A fully witnessed mechanism needs none. When useful, prefer the headless
 admin-chat dogfood path above so a maintainer or agent can replay it.>

## Fix surface
<where the diverging step lives, the blast radius through it, and an explicit
 don't-paper-over-the-symptom note so the fix targets the contract. Workaround
 if any.>
```

Render the report inline, and write it to `$CAST_CONFIG_DIR/../debug-reports/<YYYY-MM-DD>-<slug>.md` (default `~/.cast/debug-reports/`) — out of the repo tree, since it quotes logs. Submitting it upstream (the issue tracker, or `gh issue create`) is the operator's explicit action.

## Gotchas

- **First container spawn is 20–60s.** Subsequent sessions on the same agent reuse the image. If you're timing out on a first spawn, raise the timeout, don't blame the code.
- **`tsx watch` reload doesn't restart active containers.** A code change on the host takes effect for the *next* session; already-running containers keep their old snapshot.
- **MCP tool schemas cache per-session.** Tool arg changes require a new session. Tool *handler body* changes apply immediately within the next tool call.
- **Admin-chat session resolves operator to `local`.** Real user-ACL paths aren't exercised here — use the CLI WebSocket transport (`/cli`) or a real transport for that.
- **Console sessions don't skip `validateAgentOutput`.** Same pipeline. Anything wrapped in `<cast:internal>...</cast:internal>` won't reach history. If you're debugging "why didn't the text land," check the session transcript instead.
- **Per-agent file watches** (`agent.json`, `acl.json`) reload instantly; **blueprint changes** (prompt, channels) need a new session.
- **Shell state doesn't persist across separate command invocations.** `TOKEN=$(curl ...)` in one shell call is gone in the next. Either inline the token literal in each call, write it to `/tmp/...`, or chain everything in one shell with `&&`. This failure is silent — `curl` with `Authorization: Bearer` and an empty token just returns auth-required JSON, which looks like a missing-reply bug.
- **tRPC mutations work via curl:** `curl -X POST http://127.0.0.1:5051/api/trpc/<procedure>` with `-d '{"alias":"name"}'`. Response shape is `{"result":{"data":...}}` — unwrap `.result.data`. Useful for `agent.create`, `agent.archive`, etc. without hitting the web UI.

## File locations

| Artifact | Path |
|----------|------|
| Gateway DB (delivered packets) | `$CAST_CONFIG_DIR/gateway.db` |
| Agent message log (user channels) | `$CAST_AGENTS_DIR/<folder>/state/agent.db`, table `message_log` |
| Per-agent console history (Design, Configure) | `$CAST_AGENTS_DIR/<folder>/state/console.db`, table `message_log` |
| Server-scope console history (DM, CM, SM) | `$CAST_CONFIG_DIR/server-console.db`, table `message_log` (rows discriminated by `channel`) |
| Agent-runner debug log | `$CAST_AGENTS_DIR/<folder>/home/.agent-runner.log` |
| Session transcripts | `$CAST_AGENTS_DIR/<folder>/sessions/<conv-key>/.claude/projects/-home-agent/*.jsonl` |
| Scheduled tasks | `$CAST_AGENTS_DIR/<folder>/state/tasks.json` |
| Host server logs | Depends on supervisor — `pm2 logs cast`, `journalctl -u cast`, dev process stdout |
| MCP sockets | `$CAST_AGENTS_DIR/<folder>/mcp/*.sock` |

## Log level reference

| Level | Pino value | What you see |
|-------|-----------|-------------|
| info | 30 | Agent output, routing decisions, ACL blocks, session lifecycle, scheduled dispatches |
| debug | 20 | Container stderr (agent-runner), stdout parsing, MCP details, container output received |

Set via `LOG_LEVEL=debug` environment variable. Debug logs land in the same destination as info-level (filtered by pino level on the receiving side).

## See also

- [`agent-introspection.md`](agent-introspection.md) — the read-side counterpart for non-debug questions ("how can this agent grow?"). Shares the same read surface but with different discipline.
- [`agent-architecture.md`](agent-architecture.md) — folder layout reference. Useful when you need to know which directory contains what.
- [`packages/agent-schema/src/v1/SPEC.md`](../../../agent-schema/src/v1/SPEC.md) — ground truth on the agent contract when the manuals leave you unsure.
