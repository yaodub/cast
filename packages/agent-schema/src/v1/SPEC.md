# Cast Agent Specification v1

**Spec Version:** 1.0.0
**Compatibility Range:** >=1.0.0 <2.0.0

## 1. Overview

An agent is a directory. This specification defines the structure, files, and semantics of an agent folder. The server reads this folder to run the agent — assembling the system prompt, routing messages, managing conversations, spawning containers, and providing tools.

### Terminology

**Agent instance** — a directory tree conforming to this spec.

**Server** — the host process that manages agent instances, routes messages, and provides MCP tools.

**Agent runner** — the process that executes inside a container (or locally) and invokes the Claude Agent SDK.

**Participant** — an external entity identified by a compound address: `{identity}/{handle}` (e.g., `u:a7f3k/tg:12345`, `local/cli:alice`). The identity part is a server-issued GUID; the handle is the transport-specific address.

**Agent identity** — three distinct identifiers per agent:

- **Canonical address** `a:<guid>@<issuer>` (e.g., `a:6dfd7205d4@d9c1e2`) — key-derived and immutable. The GUID is IdP-minted on first registration from the Ed25519 pubkey fingerprint; used in all persisted runtime data (packets, tasks, conversations).
- **Alias** (`manifest.name`, e.g., `smith`) — operator-chosen (lowercase alphanumeric + hyphens), mutable. Used for bus registration (as label), ACL peer keys, `routes.json` addresses, and human-facing surfaces. Portable across servers.
- **Folder** — filesystem directory name. Used only for disk paths; never a key, label, or written into state.

The bus is the alias-resolution boundary: `bus.resolveByLabel(alias)` returns the canonical. Rename-safe by design — the signing key fingerprint is the proof of identity.

**Identity** — a user identity issued by the local identity provider: `u:xxx@issuer` (e.g., `u:a7f3k@d9c1e2`). The special identity `local` represents the CLI operator.

**Channel** — a named conversation configuration that determines idle timeout, lifecycle phases, tool availability, and message logging.

---

## 2. Folder Structure

```
{folder}/
  manifest.json                      Required
  blueprint/                         What the agent IS — portable, version-controllable
    identity/                        Required
      prompt.md                      Recommended
      whoami.md                      Optional
      skills.md                      Optional
      peers.md                       Optional
      onboarding.md                  Optional
      tools/                         Optional (scripts the agent can execute)
    channels/                        Optional
      {channel_name}/
        channel.json                 Required per channel
        prompt.md                    Optional
        bootstrap.md                 Optional
        cleanup.md                   Optional
    props/                           Optional
      settings.json                  Optional (includes profile field)
      sdk-settings.json              Optional
      capabilities.json              Optional
      schedule.txt                   Optional
    service/                         Optional — service build artifact
      index.js                       Bundled entrypoint
      index.js.map                   Source map
      package.json                   Native dependency declarations
      node_modules/                  Native modules only
      manifest.json                  Service metadata
      checksum.txt                   Bundle integrity hash
    assets/                          Optional — static reference data
  config/                            Optional
    agent.json                       Optional — runtime knobs (model, network, timezone)
    provisions.json                  Optional — deployment-specific values for capability slots
    acl.json                         Admin-managed access control
    ext/                             Optional — operator-editable extension config + secrets
      {ext-name}/
        config.json                  Operator overrides
        .env                         Operator secrets
  secrets/                           Per-install — never mounted, not console-readable
    agent.key                        Ed25519 private key (generated at init)
  ext/                               Optional — extension private runtime state (never mounted)
    {ext-name}/                      Per-extension runtime (DBs, caches, auth tokens)
    service/                         RESERVED — agent service private runtime
      credentials.json               OAuth tokens (service-written)
  shared/                            Optional — extension → agent publishing (mounted read-only at /shared)
    ext/
      {ext-name}/                    Extension-written data visible to the agent (mounted at /shared/{ext-name})
      service/                       Agent service output
        agent-context.md             Dynamic prompt contribution (Layer 9)
  state/                             Server-managed
    paired-users.json                Runtime-paired user grants (identity → channel → bits)
    pairing-codes.json               Pairing code state (generated, consumed, expiry)
    attachments/                     Content-addressed blob store
  home/                              Agent workspace
  memory/                            Agent-managed
  staging/                           Ephemeral — per-conversation outbox
  sessions/                          Ephemeral
  mcp/                               Ephemeral
  logs/                              Ephemeral
  .admin/                            Ephemeral — admin session staging
  .stamps/                           Auto-created (init restamp tarballs)
  .backups/                          Auto-created (runtime snapshots)
```

### Directory Zones

| Zone | Directories | Description |
|------|------------|-------------|
| **Blueprint** | `blueprint/identity`, `blueprint/channels`, `blueprint/props`, `blueprint/service`, `blueprint/assets` | Define the agent's behavior and capabilities. Portable. |
| **Config** | `config/` | Per-deployment decisions. Admin-managed. |
| **Secrets** | `secrets/` | Agent-held keypair (`agent.key`). Per-install, generated at init, never mounted into any container, not exposed to consoles. |
| **Extensions** | `config/ext/`, `ext/`, `shared/ext/` | Extension state across three namespaces: operator config + secrets (`config/ext/{name}/`), extension private runtime (`ext/{name}/`), and extension → agent publishing (`shared/ext/{name}/`, mounted read-only at `/shared/{name}`). Reserved name: `service` (agent service). |
| **Instance** | `state`, `home`, `memory` | Server state, agent workspace, persistent memory. |
| **Ephemeral** | `sessions`, `mcp`, `logs`, `staging`, `.admin` | Runtime-only. Not portable. |
| **System** | `.stamps`, `.backups` | Dot-prefixed meta directories. |

### Directory Ownership

| Directory | Writer | Reader | Mounted in container | Reload |
|-----------|--------|--------|---------------------|--------|
| `blueprint/identity/` | Definition author | Server, Agent (read-only) | `/identity` (read-only) | Hot-reload — per access |
| `blueprint/channels/` | Definition author | Server | Not mounted | Hot-reload — per access |
| `blueprint/props/` | Definition author | Server | Not mounted | Hot-reload — per access |
| `blueprint/service/` | Composer | Server (spawns) | Not mounted | Service restart (respawn the service process, full server restart also works) |
| `blueprint/assets/` | Definition author | Agent (read-only) | `/assets` (read-only) | Per spawn |
| `config/` | Operator | Server | Not mounted | Hot-reload — per access |
| `config/ext/{name}/` | Operator | Server, extension | Not mounted | Hot-reload — per access |
| `secrets/` | Server (init only) | Server | Not mounted | N/A |
| `ext/{name}/` | Extension (service or server) | Extension | Not mounted | N/A |
| `shared/ext/` | Extensions | Agent (read-only) | `/shared` (read-only) | Per spawn |
| `state/` | Server | Server | `state/attachments/` mounted at `/attachments` (read-only) | In-memory — disk is journal |
| `home/` | Agent | Agent | `/home/agent` (read-write) | N/A (agent-managed) |
| `memory/` | Agent | Agent | `/memory` (read-write) | N/A (agent-managed) |
| `staging/` | Agent | Server | `/staging` (read-write) | Ephemeral |
| `sessions/` | Server | Agent runner | Mounted as `/home/node/.claude` | Ephemeral |
| `mcp/` | Server, Service | Agent runner | `/mcp/*.sock` (individual files) | Ephemeral |
| `.admin/` | Server | Server | Not mounted | Ephemeral |

The **Reload** column describes how the server picks up changes to files in each directory. The directory's zone determines reload behavior: operator-editable directories (`blueprint/props/`, `config/`) always hot-reload via a filesystem-watched content cache (chokidar). Blueprint directories (`blueprint/identity/`, `blueprint/channels/`) are watched and re-read when their files change on disk. The exception is `blueprint/service/`: a running service process does not reload its own source, so service-code changes need a service restart. State directories use in-memory representations with disk as a persistence journal.

---

## 3. Manifest

Every agent instance requires a `manifest.json` at its root.

```json
{
  "spec": "1.0.0",
  "name": "smith",
  "pubkey": "a1b2c3d4e5f67890",
  "description": "Research assistant with deep knowledge base"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec` | `string` | Yes | Spec version. Must satisfy `>=1.0.0 <2.0.0`. |
| `name` | `string` | Yes | Agent alias. Lowercase alphanumeric + hyphens (`/^[a-z0-9][a-z0-9-]*$/`). Used as the bus label, in ACL peer keys, in `routes.json`, and for cross-agent references. Schema-required — parse fails if missing. |
| `pubkey` | `string` | Yes* | Public key fingerprint — truncated SHA-256 of the DER-encoded Ed25519 pubkey. *Schema-optional, but the server rejects agents without a registered pubkey and a matching `secrets/agent.key`. |
| `description` | `string` | No | Human-readable description for admin UI and bus advertisement. |
| `status` | `'draft'` | No | Lifecycle status. Absence = ready. `draft` = being composed; flipped to ready by Security Manager via the review path or by the admin Settings → Lifecycle override. |

The manifest is **open by design**. Cast's parser uses `.passthrough()` — any additional keys are accepted and preserved verbatim. Higher-level tools may write extra fields (for example, provenance metadata from a generator) and the server will round-trip them without validation or interpretation. The base spec defines only the fields above.

### 3.1 Draft mode behavior

When `status: 'draft'`, the agent is *composable* but *not externally responsive*. The runtime gate runs on every inbound bus payload (`agent-bus-handler`'s draft check), so flipping draft↔ready in the Design console takes effect on the next inbound message — no restart, no cache invalidation. The flag itself is read-through via the file-watcher cache on the agent root.

**Suppressed for non-authoring senders** (the draft bounce):
- `message` / `ingested` packets → bounced to sender with a generic `Target agent is in draft mode — not yet ready to respond.` conversation packet.
- `push` packets → routed back as a `rejection` carrying the original `requestId`.
- `request` packets → routed back to `returnToAgent` as a `rejection` carrying the `requestId`.

**Passes through unchanged**:
- `response` / `rejection` payloads — the agent issued the outbound request before drafting; cutting the return path mid-flight would orphan downstream agents waiting on the reply.
- Pairing flows (`pair_request`, `pair_response`, etc.) — pairing is composition-time, not user-facing traffic.
- Authoring-sender traffic (operator / console) — design and Configure consoles need to exercise the agent while drafting.

**Not affected by `status: 'draft'`**:
- The agent's own services (cron jobs, file-watch handlers, MCP tool implementations) continue to run. Services produce work *for* the agent; muting them on draft would break the in-development workflow.
- Outbound requests the agent makes via tools — they go out normally. Drafting only governs inbound surface.
- Existing conversations that were active before the draft flip — they finish their in-flight turn; the bounce gate only blocks *new* inbound traffic.

The asymmetry (drafted-on-inbound, normal-on-outbound) is intentional: the operator composes a draft agent by sending it test messages through the Design console and watching outputs. Bouncing those messages would defeat the workflow.

---

## 4. System Prompt Assembly

The server builds the system prompt from 10 layers, concatenated with double newlines. A layer is omitted if its source is empty.

| Layer | Source | XML Wrapper | Description |
|-------|--------|-------------|-------------|
| 1 | Server-generated | `<cast-protocol>` | Infrastructure: container directory layout, network access mode |
| 2 | Profile | `<agent-profile>` | Behavioral baseline from the selected profile (filesystem conventions, memory guidance) |
| 3 | Profile | `<agent-profile-skills>` | Profile-provided skill guidance (tool descriptions, tag usage) |
| 4 | `blueprint/identity/prompt.md` | None (raw) | Agent persona and behavior instructions |
| 5 | `blueprint/identity/whoami.md` | `<agent-identity>` | Structured identity facts |
| 6 | `blueprint/identity/peers.md` | `<agent-peers>` | Agent peer relationships (who to consult, on what channels, with domain context) |
| 7 | `blueprint/identity/skills.md` | `<agent-skills>` | Domain-specific skill and tool guidance |
| 8 | `blueprint/channels/{name}/prompt.md` | `<channel-instructions>` | Channel-specific instructions (active channel only) |
| 9 | `shared/ext/service/agent-context.md` | `<service-context>` | Dynamic context from the agent service |
| 10 | Server-generated | `<conversation-context>` | Participant, channel, agent name, current time, previous session summaries |

HTML comments (`<!-- ... -->`) are stripped from all files before inclusion.

### Layer 1: Infrastructure

Server-generated. Documents the container filesystem paths (`/home/agent`, `/identity`, `/memory`, `/assets`, `/shared`, `/staging`) and their access modes. Describes the effective network mode (`none`, `sdk-only`, or `full`).

### Layer 8: Channel instructions

Optional per-channel prompt file. If `blueprint/channels/{channelName}/prompt.md` exists, its content is injected wrapped in `<channel-instructions>`. This allows channels to carry behavioral instructions without polluting the global `blueprint/identity/skills.md`.

### Layer 10: Conversation Context

Server-generated XML containing participant identity, channel name, agent name, current time, and up to 3 previous session summaries (newest first, stopping after the first session with a summary). If no previous sessions exist, a `first-time="true"` marker is included.

---

## 5. Identity

All identity files are in `blueprint/identity/`, mounted read-only at `/identity` inside the container.

| File | XML Wrapper | Layer | Purpose |
|------|-------------|-------|---------|
| `prompt.md` | None | 4 | Core persona and behavior instructions |
| `whoami.md` | `<agent-identity>` | 5 | Structured identity facts (name, role, preferences) |
| `peers.md` | `<agent-peers>` | 6 | Agent peer relationships — who to consult, channels, domain context |
| `skills.md` | `<agent-skills>` | 7 | Tool usage guidance, domain skills, system descriptions |
| `onboarding.md` | — | Not assembled | Available for tooling use during initial setup |

The `blueprint/identity/` directory is registered as an additional directory for Claude Agent SDK, enabling CLAUDE.md discovery there.

An optional `blueprint/identity/tools/` directory may contain scripts the agent can execute but not modify (read-only mount).

---

## 6. Channels and Conversations

A **channel** is a named conversation configuration. Each channel defines how conversations behave — how long they last, what happens when they start and end, which tools are available, and whether messages are logged. An agent can have multiple channels for different purposes (e.g., a `default` channel for interactive conversation, a `summarize` channel for processing background notifications).

Messages are routed to a channel, which determines which conversation they belong to. Each participant gets their own conversation per channel.

### Conversation Lifecycle

Conversations have finite context windows. When a conversation ends and a new one begins, the agent starts fresh. Channels solve this through **lifecycle prompts** and **summaries**:

- **Bootstrap** — tells the agent what to read at conversation start to restore working state.
- **Cleanup** — tells the agent to persist what it learned before the conversation closes.
- **Summaries** — the agent writes a summary during cleanup (`conversation__write_summary` tool), and the server injects recent summaries into the next conversation's context (Layer 9).

The cycle: cleanup saves state → bootstrap restores state → summaries bridge the gap.

### Directory Structure

Each channel is a subdirectory under `blueprint/channels/`. If `blueprint/channels/` does not exist, a single implicit `default` channel is used. Subdirectories starting with `.` are ignored.

```
blueprint/channels/{channel_name}/
  channel.json      Required
  prompt.md         Optional
  bootstrap.md      Optional
  cleanup.md        Optional
```

### channel.json

`idle_timeout` is required (no field-level default — explicit `null` means single-shot, a positive integer means persistent). Other fields are optional with the defaults below. Unknown keys are rejected (`.strict()`), so a typo like `ttl:` surfaces at parse time instead of silently dropping.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `idle_timeout` | `integer \| null` | *required* | Conversation idle timeout in ms (max `2_147_483_647` ≈ 24.86 days, Node `setTimeout` ceiling). Resets on each user message. `null` = single-shot (new conversation per message, closes after one response). |
| `lifecycle` | `enum` | `"none"` | `none`, `bootstrap-only`, `cleanup-only`, or `full`. |
| `log_messages` | `boolean` | `true` | Record messages in the channel's message log. `false` disables the runner's message-log store injection — message + event log writes become no-ops and (on user channels) request/approval MCP tools are unavailable. User channels write to `agent.db`'s `message_log` bundle; console channels write to `console.db`'s `message_log` bundle. |
| `use_sharding` | `boolean` | `false` | Enable qualifier-based sub-conversations on this channel (see "Sharding and qualifiers" below). |
| `disabled_tools` | `string[]` | `[]` | Tool patterns to disable. Exact names, domain globs (`task__*`), or built-in SDK tool names (`WebFetch`). Merged with agent-wide disabled tools. See §Tool Disabling. |
| `show_co_participants` | `boolean` | `true` | Whether the agent is aware of other participants on this channel. `false` replaces the `<other-participants>` conversation-context element with an explicit disabled marker and makes `conversation__list_summaries` return only the caller's own conversations plus a static policy note (co-participant rows from any flag-off channel are filtered out). Visibility control only — conversation isolation (per-participant keying) is unconditional and unaffected. |

Implicit channel config (used only when no `channel.json` file exists at all — distinct from field-level defaults): `idle_timeout: 1800000` (30min), `lifecycle: "none"`, `log_messages: true`. User-channel and console-channel histories live in physically separate SQLite files (`agent.db` vs `console.db`) so console planning content never co-mingles with user-channel agent reasoning.

### Bootstrap and Cleanup

**`bootstrap.md`** — read at the start of a new conversation. The server runs a separate single-turn query with this prompt before the main conversation. Write tools are disabled. Output is injected into the main conversation as `<bootstrap-context>`. Profile bootstrap content (if any) is prepended.

**`cleanup.md`** — read at conversation end. On persistent channels (`idle_timeout > 0`) the trigger is idle-timeout expiry. On single-shot channels (`idle_timeout: null`) it fires immediately after the reply, piped as a `<cast:lifecycle>` turn into the same container. Either way, delivered wrapped in `<cast:lifecycle>` (the framework family of inbound stimulus tags), output is suppressed (not sent to the participant), and profile cleanup content (if any) is prepended.

Single-shot channels (`idle_timeout: null`) honor lifecycle the same way as persistent ones — bootstrap runs in topology-only mode (no prior session to re-immerse from); the cleanup trigger is described above. Note: `conversation__write_summary` is a silent no-op on single-shot, since single-shot conversations don't persist to the state store — single-shot cleanup should target `/memory/` side-effects, not summary state.

### Sharding and qualifiers

When `use_sharding: true`, the channel hosts multiple independent sub-conversations within the same channel configuration. Each sub-conversation is keyed by a **qualifier** — an opaque string carried in the routing metadata. A null qualifier (none provided) is itself a valid sub-conversation, distinct from any non-null qualifier.

**Composite addressing.** Senders address a sharded channel as `name~qualifier` (the `~` separator follows the address grammar). This form is parsed at the LLM-facing boundary in:
- `conversation__push_to_channel` and `conversation__push_to_participant` (the `channel` argument)
- `<cast:query channel="name~qualifier">…</cast:query>` (the channel attribute)

`schedule.txt` field 6 (`channel[/qualifier]`) carries a qualifier through a separate, older parser that uses `/`. Same routing outcome (qualifier lands in the conversation key), but a looser char-set check.

**Character set.** Both the base channel name and the qualifier must match `^[a-z][a-z0-9-]*$` — lowercase letter start, then lowercase letters, digits, or hyphens. The qualifier cannot contain `~`, so the composite form has exactly one `~`. Invalid input is rejected loudly at the boundary.

**Discovery.** `agent__list_peers` renders sharded peer channels as `name~*` so callers know a channel accepts qualifiers. Substitute your own qualifier in place of `*`.

**Missing qualifier on a sharded channel.** If the channel has `use_sharding: true` and the caller addresses it as `name` (no qualifier), the message lands in the **null-qualified sub-conversation** — a distinct, persistent slot from any qualified sub-conversation. Senders that need a specific shard must address it explicitly.

**Qualifier on an unsharded channel.** Throws — `name~qualifier` against a channel without `use_sharding: true` is a routing error, not a silent drop.

---

## 7. Props

Server-consumed configuration in `blueprint/props/`. Not mounted into containers.

The `settings.json` file now carries the `profile` field (default `'standard'`), which selects the behavioral profile for prompt assembly (see Section 14).

### settings.json

Agent settings including profile selection and environment variable overrides:

```json
{ "profile": "standard", "env": { "KEY": "VALUE" } }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `profile` | `string` | `"standard"` | Behavioral profile for prompt assembly (see Section 14). |
| `env` | `object` | `{}` | Environment variable overrides for the agent runner process. |

### sdk-settings.json

Claude Agent SDK-specific environment variables. Same schema as `settings.json`.

**Merge order** (later wins): server SDK defaults → `sdk-settings.json` → `settings.json`.

### capabilities.json

Agent-wide capability declarations, tool restrictions, resource slot definitions, and extension config. This file is **vendor-owned** — overwritten on restamp. The admin cannot modify it directly; deployment-specific values go in `config/provisions.json`.

```json
{
  "disabled_tools": ["task__*"],
  "additional_disabled_tools": { "unlocked": true, "value": [] },
  "pip": {
    "allowed_packages": ["duckdb", "pandas"],
    "extra_packages": { "unlocked": true, "value": [] }
  },
  "resources": {
    "codebase": { "description": "Source code repository", "access": "ro", "required": true },
    "data": { "description": "Shared dataset", "access": "rw", "required": false }
  },
  "extensions": {
    "web-fetch": {
      "enabled": true,
      "allowed_domains": ["*.example.com"],
      "blocked_domains": [],
      "allow_query_strings": true
    },
    "email": {
      "enabled": true,
      "send_mode": "draft",
      "allowed_recipients": { "unlocked": true, "value": [] },
      "read_window_days": 7
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `disabled_tools` | `string[]` | `[]` | Tool patterns disabled across all channels (Cast MCP tools and built-in SDK tools). Locked — admin cannot change. |
| `additional_disabled_tools` | `string[] \| UnlockableArray` | `[]` | Extra disabled tools. When `{ unlocked: true, value: [] }`, admin can add via provisions.json. |
| `pip` | `object` | off | Python package management. `allowed_packages` (locked base list), `extra_packages` (unlockable for admin additions). Registers `pip__install` and `pip__list` MCP tools. |
| `resources` | `Record<string, ResourceSlot>` | `{}` | Named resource slots. Each slot has `description`, `access` (`ro`/`rw`), `required` flag. Admin provisions paths in `config/provisions.json`. |
| `extensions` | `Record<string, object>` | `{}` | Extension declarations. Each key is a registered extension name. See Section 9A. |

**Locked-by-default pattern:** Bare values are locked (vendor wins). To allow admin override, wrap in `{ unlocked: true, value: <default> }`. This applies to `additional_disabled_tools`, `pip.extra_packages`, and extension config fields.

**Merge rules:** Final disabled tools = `disabled_tools` ∪ `additional_disabled_tools`. Final pip packages = `pip.allowed_packages` ∪ `pip.extra_packages`. The admin field only adds restrictions — admin cannot re-enable vendor-disabled tools or remove packages from the base list.

### schedule.txt

Declarative scheduled messages. One entry per line. Lines starting with `#` and blank lines are ignored.

```
<min> <hour> <dom> <mon> <dow>  <channel[/qualifier]>  <message text...>
```

The first 5 fields are a standard cron expression. Field 6 is the target channel (optionally with `/qualifier` for sharded channels). Fields 7+ are joined as the message text.

Scheduled messages are self-addressed: the agent receives its own message on the specified channel. Evaluated in the server's timezone.

---

## 8. Config

Instance-specific, operator-managed configuration in `config/`. Not mounted into containers.

### agent.json

Runtime knobs only — no blueprint dependency. The admin can configure any field without consulting the blueprint.

```json
{
  "model": "claude-sonnet-4-20250514",
  "modelOverrides": [
    { "channel": "email", "model": "claude-haiku-4-5" },
    { "channel": "default", "phase": "cleanup", "model": "claude-haiku-4-5" }
  ],
  "containerNetwork": "sdk-only",
  "containerAllowedEndpoints": [],
  "showSteps": true,
  "showConsoleSteps": true,
  "timezone": "America/New_York",
  "backup": { "retain": 7, "hour": 3 },
  "maxConversations": 10
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | SDK default | Claude model identifier |
| `modelOverrides` | `ModelOverrideEntry[]` | `[]` | Per-channel (and optionally per-phase) model overrides. See below. |
| `containerNetwork` | `enum` | `"sdk-only"` | Container network isolation: `sdk-only` (Anthropic API only), `full` (no firewall), `none` (all egress blocked) |
| `containerAllowedEndpoints` | `string[]` | `[]` | Additional endpoints the container can reach (`host:port`; host may be a domain or IP). Only effective in `sdk-only` mode. See §12 for reaching host-side services. |
| `showSteps` | `boolean` | `true` | When true, deliver intermediate assistant text (narration before tool calls) to the participant as it happens, rather than waiting for the final result. Governs production conversations (regular user-facing traffic). |
| `showConsoleSteps` | `boolean` | `true` | Same shape as `showSteps`, but governs only this agent's per-agent Design and Configure consoles. Independent from `showSteps` so production verbosity and authoring verbosity can be tuned separately. The server-scope manager consoles (DM/CM/SM) follow a separate server-level `showManagerSteps` toggle in `server.json`. |
| `timezone` | `string` | Server timezone | IANA timezone for the agent (e.g. `America/New_York`) |
| `backup` | `object` | off | Runtime snapshots: `retain` (max kept), `hour` (UTC hour to run, default 3). One snapshot per day. Omit to disable |
| `maxConversations` | `number` | `10` | Maximum concurrent conversations for this agent |

#### `modelOverrides` entries

Each entry is `{ channel: string, phase?: 'bootstrap' | 'cleanup', model: string }`:

| Field | Required | Notes |
|-------|----------|-------|
| `channel` | yes | Blueprint channel name. Console channels (`__`-prefixed) are rejected. |
| `phase` | no | Lifecycle phase. Omitted = matches all phases on the channel. `bootstrap` targets the bootstrap-phase `query()` call (separate from main conversation); `cleanup` targets the TTL-expiry cleanup spawn. |
| `model` | yes | Claude model identifier to use when this entry matches. |

**Resolution rule:** Walk `modelOverrides`; each entry must match every specified dimension of the spawn context. Among matching entries, the one with the highest specificity (count of specified dimensions) wins. If nothing matches, fall back to top-level `model`. If neither matches, the SDK default applies.

**Static duplicate detection:** Two entries with the same `(channel, phase)` pair (treating `undefined` as a value) are rejected at config parse time. Operators must spell out their intent — e.g. `{channel: 'email'}` and `{channel: 'email', phase: 'cleanup'}` coexist (different specificity), but two `{channel: 'email'}` entries do not.

### provisions.json

Admin's deployment-specific values — the "answer sheet" for capability slots declared in `capabilities.json`. Optional — omit when the blueprint has no provisionable fields.

```json
{
  "resources": {
    "codebase": "/data/repos/main",
    "data": { "path": "/data/shared", "access": "rw" }
  },
  "pip": {
    "extra_packages": ["scipy", "statsmodels"]
  },
  "additional_disabled_tools": ["delegate__*"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `resources` | `Record<string, string \| object>` | Path bindings for resource slots declared in capabilities. Bare string = path (inherits slot access). Object `{ path, access }` for explicit narrowing. Access can narrow (`rw`→`ro`) but not escalate (`ro`→`rw`). |
| `pip.extra_packages` | `string[]` | Additional pip packages. Only accepted if `capabilities.json` declares `pip.extra_packages` as unlocked. No wildcards — must be exact package names. |
| `additional_disabled_tools` | `string[]` | Additional tool patterns to disable. Only accepted if `capabilities.json` declares `additional_disabled_tools` as unlocked. |

### acl.json

Operator-managed access control. Defines agent peers and rejection messages. **Never modified by runtime.**

```json
{
  "owner": "local",
  "peers": {
    "bond": { "*": "ioaq" },
    "sales": { "query": "a" }
  },
  "reject_message": "Not authorized. Use /pair <code> to get access."
}
```

Agent peer keys are **aliases** (lowercase alphanumeric + hyphens, no `:` separator — matching `manifest.name`). At runtime, `checkAcl()` normalises each peer key through `bus.resolveAddress()` (exact match then alias fallback), so alias-keyed entries resolve to the canonical `a:<guid>@<issuer>` before the lookup — surviving alias rename at the *resolution* layer while the ACL file still expresses operator intent as a human-readable alias. Canonical-form peers also work (operator preference), but the alias form is preferred and portable across key rotations.

Peer keys also support prefix globs: `a:*` matches any agent identity, `console:*` matches any console identity. User globs (`u:*`) are rejected at schema-parse time — humans must pair explicitly, there is no bulk-grant primitive. Lookup order: exact identity match → prefix glob → deny.

Channels `__design` and `__configure` are system-owned infrastructure channels. Disk `acl.json` never authoritatively grants or denies them; entries mentioning these channels are silently ignored. Authority lives in code-declared tables (`auth/console-grants.ts`) keyed by console address. See §16 for the cross-agent flow.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `owner` | `string` | `"local"` | Identity with full access. Typically `"local"` (CLI operator) or a user identity. |
| `peers` | `object` | `{}` | Map of agent alias → channel permissions. Agent peers only — human users are managed via pairing in `state/paired-users.json`. |
| `reject_message` | `string \| null` | `null` | Custom message sent to denied human participants. |

### state/paired-users.json

Runtime-managed ACL grants for paired human users. Written by the pairing flow, never hand-edited. Same format as `acl.json` peers — flat record of identity → channel → bits.

```json
{
  "u:45f532a0@d9c1e2": { "*": "io" },
  "u:2e402b49@d9c1e2": { "default": "io" }
}
```

`checkAcl()` merges both sources at read time: agent peers from `config/acl.json` + paired users from `state/paired-users.json`.

### state/pairing-codes.json

Pairing code state. Codes are generated at runtime by the server — there are no admin-defined codes. Written by the pairing flow, never hand-edited.

```json
{
  "a8k2m1": { "generated": true, "for_handle": "tg:12345", "expires": "2026-04-02T12:00:00Z" },
  "b3x9q7": { "consumed": true, "generated": true }
}
```

All codes are single-use. A code entry without `consumed: true` is available; once used, `consumed` is set to `true`. Expired codes are cleaned up lazily.

**Peer permissions:** Each peer maps channel names to permission bit strings.

| Bit | Direction | What it authorizes |
|-----|-----------|-------------------|
| `i` | them → me | Conversation messages (persistent, bidirectional) |
| `o` | me → them | Conversation messages (push, outbound) |
| `q` | me → them | Query (expect an answer back) |
| `a` | them → me | Answer: accept inbound queries and requests |
| `r` | me → them | Request (fire-and-forget; receiver reuses `a`) |
| `p` | me → them | Push (cross-agent hand-off; sender's current participant becomes target's) |
| `h` | them → me | Host push (accept incoming push, host the conversation with sender's named user) |

Pairings: `q`↔`a` (query/answer), `r`↔`a` (request reuses `a`; intent distinguished at the `<cast:query>`/`<cast:request>` payload-tag level — the receiver sees whichever tag the sender chose), `p`↔`h` (push/host).

Bits are combined as strings per channel: `"io"`, `"aq"`, `"ioaq"`, `"a"`, `"ph"`, etc. `"*"` = wildcard (all channels not explicitly listed). Specific channel names override the wildcard. The channel wildcard `"*"` does NOT match infra channels (`__*`) — those always require an explicit channel grant.

The `owner` identity and `local` (CLI operator) always receive full access. Server-scope consoles (`console:*`) are authorized through code-declared grants in `auth/console-grants.ts` and do not appear in disk `acl.json`. See §16 for the full check matrix, safety model, and configuration examples.

---

## 9. Service

An agent may include a service — a persistent child process managed by the server. Services run on the host with full system access (not inside the container). They are trusted operator code — same trust model as installing a package.

### Entrypoint

The server resolves the entrypoint from `blueprint/service/manifest.json`:

1. If `manifest.json` has an `entry` field — resolve relative to `blueprint/service/`. Files ending in `.ts`/`.tsx` are run with `tsx`; others with `node`.
2. If no `entry` field — fall back to `blueprint/service/index.js` with `node`.
3. If `manifest.json` doesn't exist — no service.

This supports both bundled services (stamped from templates) and live-dev services (TypeScript source run via tsx).

### Environment Variables

The server passes a single JSON-encoded environment variable when spawning the service:

| Variable | Value |
|----------|-------|
| `CAST_SERVICE_CONFIG` | JSON object with service configuration (see below) |

**`CAST_SERVICE_CONFIG` fields:**

| Field | Value |
|-------|-------|
| `agentFolder` | Agent folder name |
| `agentDir` | Absolute path to the agent instance directory |
| `serviceDir` | Absolute path to `ext/service/` within the agent |
| `sharedDir` | Absolute path to `shared/ext/service/` within the agent |
| `webBaseUrl` | Base URL for the admin web server |
| `adminSocketPath` | Unix socket path for the admin HTTP server |
| `mcpSocketPath` | Unix socket path for the service's MCP server (`mcp/agent.sock`) |
| `serviceContextPath` | Absolute path to `shared/ext/service/agent-context.md` |

### IPC Protocol

Communication is via Node.js IPC (`process.send` / `process.on('message')`). Services typically use `@getcast/agent-service-base` which handles IPC, MCP, and lifecycle automatically — the raw protocol is documented here for reference.

**Service → Server:**

| Message | Description |
|---------|-------------|
| `{ type: "ready" }` | Service initialized. Server waits for this before considering startup complete. |
| `{ type: "route-message", id, channel, text, target? }` | Route a message to the agent on the specified channel. `id` is a correlation ID. |

**Server → Service:**

| Message | Description |
|---------|-------------|
| `{ type: "shutdown" }` | Graceful shutdown. Service should stop and exit within 5 seconds. |
| `{ type: "route-result", id, result, error }` | Response to a `route-message`. `id` matches the original request. |

### MCP Socket

The service may host an MCP server on a Unix domain socket at `mcp/agent.sock` within the agent directory. The agent runner discovers this socket automatically and makes its tools available to the agent.

### Service Prompt Contribution

Services contribute dynamic context to the agent's system prompt by writing `shared/ext/service/agent-context.md`. The server reads this file synchronously during prompt assembly and injects it as layer 9 (wrapped in `<service-context>`). The service controls when and how often it updates this file. The CWD for the service process is `ext/service/`.

### config/ext/service/.env

Service-specific secrets, loaded by the service process itself. Operator-owned, lives in the config namespace. Not committed to version control.

### blueprint/service/manifest.json

Service metadata and entrypoint configuration:

```json
{
  "name": "my-service",
  "version": "0.1.0",
  "entry": "src/index.ts"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Service name (informational) |
| `version` | No | Service version (informational) |
| `entry` | No | Entrypoint relative to `blueprint/service/`. If absent, defaults to `index.js`. `.ts`/`.tsx` entries are run with tsx. |

---

## 9A. Extensions

Extensions add external capabilities (web-fetch, email) to agents. Standard extensions ship with the server. Agent services (Section 9) access extension capabilities via typed IPC.

### Extension Directory Layout

Each extension's state is split across three namespaces:

```
config/
  ext/
    {name}/                 Operator-owned config + secrets (CM/SM-readable, Configure-writable)
      config.json           Operator overrides (optional)
      .env                  Credentials (not committed, not mounted)
ext/
  {name}/                   Per-extension private runtime (DBs, caches, auth tokens)
  service/                  Agent service private runtime (reserved, see Section 9)
    credentials.json
shared/
  ext/
    {name}/                 Per-extension shared output (mounted at /shared/{name})
    service/                Agent service output (reserved)
      agent-context.md      Dynamic prompt contribution (Layer 9)
```

The extension's private runtime (`ext/{name}/`) is never mounted anywhere. Operator config and secrets live under `config/ext/{name}/`. The shared directory (`shared/ext/{name}/`) is part of the `/shared` read-only mount, making extension output visible to the agent at `/shared/{name}/`.

Reserved name: `service` (agent service — see Section 9).

### Config Merge (Locked-by-Default)

Extension config flows from two sources:

1. **Author config** — `blueprint/props/capabilities.json` `extensions.{name}` block. Defines defaults and lock policy.
2. **Operator overrides** — `config/ext/{name}/config.json`. Operator-managed, per-deployment.

Merge rules:

- **Bare values are locked.** The author's value wins; operator overrides are ignored (with a warning).
- **`{ unlocked: true, value: <default> }` allows override.** If the operator provides a value, it wins. Otherwise the author's default is used.
- The `enabled` flag is stripped before merge (it is a framework concern, not extension config).
- Operator keys not declared by the author are ignored (with a warning).

Example — author declares `send_mode` as locked and `allowed_recipients` as unlocked:

```json
{
  "enabled": true,
  "send_mode": "draft",
  "allowed_recipients": { "unlocked": true, "value": [] }
}
```

Operator overrides in `config/ext/email/config.json`:

```json
{
  "send_mode": "send",
  "allowed_recipients": ["team@example.com"]
}
```

Merged result: `{ "send_mode": "draft", "allowed_recipients": ["team@example.com"] }`. The operator's `send_mode` override is rejected (locked); the `allowed_recipients` override is accepted (unlocked).

### Extension Lifecycle

| Phase | Scope | What happens |
|-------|-------|-------------|
| Server start | Per class | `onServerStart()` — shared resources (e.g. web-fetch subprocess) |
| Agent load | Per agent | Constructor called with `ExtensionContext` (merged config, parsed secrets, dirs) |
| Agent load | Per agent | `onAgentStart()` — per-agent background tasks (IMAP IDLE, timers) |
| Tool call | Per conversation | `handle(toolName, args, ToolCallContext)` — MCP tool handler |
| Agent/server stop | Per agent | `onAgentStop()` — cleanup per-agent resources |
| Server stop | Per class | `onServerStop()` — shared resource cleanup |

An extension is activated for an agent only when `enabled: true` in capabilities.json, the extension class is registered in the server, and both config and secrets validate successfully. Failed extensions are skipped (logged, non-fatal).

### Standard Extensions

#### web-fetch

Web page fetching with domain policy enforcement and SSRF protection. Manages a shared Playwright subprocess.

**Tools:** `web__fetch` — fetch a URL, process through cleaning pipelines (crawl4ai, markdown, raw), write output files to `/staging/in/`.

**Config schema** (`capabilities.json` → `extensions.web-fetch`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed_domains` | `string[]` | `[]` | Domain allowlist. `"*"` = open. Supports `*.example.com` wildcards. |
| `blocked_domains` | `string[]` | `[]` | Domain blocklist (checked after allowlist). |
| `allow_query_strings` | `boolean` | `true` | Strip query strings and fragments when false. |

**Secrets:** None required.

**Prompt contribution:** Injects web content usage guidance into the protocol layer (Layer 1).

#### email

Generic IMAP/SMTP email — works with any provider supporting app passwords (Gmail, iCloud, Fastmail, self-hosted). On-demand tools plus optional IMAP IDLE subscriptions.

**Tools:** `email__search`, `email__send`, `email__read`, `email__subscribe`, `email__unsubscribe`, `email__list_subscriptions`.

**Config schema** (`capabilities.json` → `extensions.email`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `send_mode` | `enum` | `"disabled"` | `disabled`, `draft`, `send`. |
| `allowed_recipients` | `string[]` | `[]` | Recipient allowlist for send mode. |
| `read_window_days` | `integer` | `7` | How far back email search looks. |
| `max_results` | `integer` | `25` | Maximum search results. |
| `max_source_bytes` | `integer` | `1000000` | Maximum email body size. |

**Secrets** (`config/ext/email/.env`):

| Variable | Description |
|----------|-------------|
| `EMAIL_ADDRESS` | Email address |
| `EMAIL_PASSWORD` | App password |
| `IMAP_HOST` | IMAP server hostname |
| `IMAP_PORT` | IMAP server port (default 993) |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP server port (default 465) |

**Subscriptions:** Persistent across conversations. Stored in `ext/email/data/subscriptions.json` (private runtime). Uses IMAP IDLE for realtime delivery or cron polling as fallback.

### Portable Extensions

Extensions are portable units defined via `defineExtension()` from `@getcast/extension-schema`. Services that need extension capabilities (e.g. email search, web fetch) import and instantiate them directly — no IPC bridge needed. Client methods apply security checks (SSRF) but not agent-level policy — services are trusted code.

---

## 10. MCP Tools

### Built-in Tools

The server provides these tools via MCP. Tool names use `domain__action` naming (double underscore).

| Tool | Description |
|------|-------------|
| `task__schedule` | Schedule a deferred or recurring task. Tasks always run on the current agent. |
| `task__list` | List scheduled tasks |
| `task__pause` | Pause a scheduled task |
| `task__resume` | Resume a paused task |
| `task__cancel` | Cancel a scheduled task |
| `task__list_runs` | View recent task dispatch history |
| `conversation__list_summaries` | List recent conversations and summaries |
| `conversation__write_summary` | Write a summary of the current conversation |
| `conversation__push_to_channel` | Push a turn into a different channel for the current participant, optionally on a different agent via `target_agent` (label, e.g. `"knowledge"`). Returns a correlation `id` in the result text; if the receiver later rejects the push (ACL revoked, draft mode, etc.) the rejection arrives as `<cast:rejection request="<id>">` on a subsequent turn |
| `conversation__push_to_participant` | Push a turn into another participant's conversation on this agent (intra-agent only; no `target_agent`). Returns a correlation `id` for receiver-rejection correlation, same as `push_to_channel` |
| `agent__list_participants` | List participants who have previously interacted with this agent (only available when no user participant in context) |
| `agent__list_peers` | List peer agents with per-channel permissions (query, answer, message directions) |
| `message_log__search` | Search past messages by keyword (requires message logging enabled) |
| `message_log__recent` | Browse recent messages without keyword search |
| `message_log__read` | Read a specific message by ID |
| `web__fetch` | Fetch and process a web page (provided by the web-fetch extension, see Section 9A) |
| `request__list` | List open requests for the current channel + participant context (inbound and outbound) |
| `request__close` | Close a request by ID. Closing an inbound request sends a rejection to the requester. |
| `request__close_all` | Close all open requests for the current channel + participant context |
| `pip__install` | Install a Python package (requires `pip` in `capabilities.json`) |
| `pip__list` | List installed Python packages (requires `pip` in `capabilities.json`) |

### Tool Disabling

Tools can be disabled at two levels:
- **Agent-wide** — `blueprint/props/capabilities.json` `disabled_tools`
- **Per-channel** — `blueprint/channels/{name}/channel.json` `disabled_tools`

Both are merged at runtime. Matching supports exact names and domain globs (`task__*` disables all `task__` tools).

`disabled_tools` gates **both** the Cast MCP tools above (at registration) **and** the SDK's built-in tools (`Bash`, `Read`, `Write`, `Edit`, `WebFetch`, …) — the latter are passed to the SDK's `disallowedTools`, which removes them from the model's context (and from `ToolSearch`). Separately, built-in `WebFetch` is gated by the host on network mode: kept on `full`-network spawns (e.g. the blueprint-authoring consoles, where the agent can reach any host anyway), disabled on `sdk-only`/`none` where Cast routes fetching through the web-fetch extension.

### Socket Discovery

The agent runner discovers MCP tools via Unix domain socket files in the `/mcp` directory inside the container. Each `.sock` file is registered as an MCP server named after the file (e.g., `agent.sock` → `agent`). The server's built-in tools are provided via `cast.sock`.

MCP sockets use the **Streamable HTTP** transport over Unix domain sockets.

---

## 11. Output Processing

### Internal Tags

The server supports `<cast:internal>…</cast:internal>` tags in agent output. Content wrapped in these tags is stripped before delivery to the participant. This is a platform-level mechanism — it is unconditionally applied to all outbound messages regardless of profile or channel.

**Behavior:**
- `<cast:internal>` blocks are removed from the text sent to the participant
- The stripped internal content is stored separately in the message log (`internal` column) for diagnostics
- If the entire output is wrapped in `<cast:internal>`, nothing is sent to the participant but the message is still logged (with `text` as null and `internal` populated)
- Multiple `<cast:internal>` blocks in a single response are supported

**Inbound messages:** `<cast:internal>` tags in participant input are stripped before storage to prevent injection of synthetic agent reasoning into the message log.

**Validation:** All agent output flows through `validateAgentOutput` which enforces three rules over `<cast:*>` tags only — balanced (every opener has a matching closer), no nesting (cast tags can't contain other cast tags), and size (user-visible bytes ≤ `agent.json::maxOutputBytes`, default 32 KB). Other markup (`<thinking>`, `<div>`, etc.) passes through unchanged. Final-output validation failures are blackholed and a `<system>` feedback message is delivered to the agent for self-correction; three consecutive failures close the runner. Intermediate failures are silently blackholed (logged but not fed back).

**Message log schema:**

| Column | Type | Description |
|--------|------|-------------|
| `text` | `TEXT` | User-visible output (null if entirely internal) |
| `internal` | `TEXT` | Internal reasoning content (null if none) |
| `attachments` | `TEXT` | JSON array of `{label, hash, mimeType, size}` (null if no attachments) |

The `message_log__search` MCP tool only searches and returns the `text` column — internal content is invisible to the agent's own search. Direct database queries are required to inspect internal content.

### Query, Request, and Answer Tags

The server supports `<cast:query>`, `<cast:request>`, and `<cast:answer>` tags in agent output for cross-agent calls. Like `<cast:internal>`, these tags are extracted before delivery to the participant.

`<cast:query>` and `<cast:request>` share the same wire shape, attribute set, and routing path. They differ only in whether a reply is expected: `<cast:query>` expects a `<cast:answer>` back (sender gated on `q`); `<cast:request>` is fire-and-forget (sender gated on `r`). The receiver renders the same tag the sender chose so the receiving agent sees the wire-format intent and behaves accordingly (a request handler does the work via tools without composing `<cast:answer>`).

**Agent writes (outbound):**
```
<cast:query target="sales" channel="sales-query">What are the Q2 numbers?</cast:query>
<cast:request target="reports" channel="weekly">Generate the weekly digest.</cast:request>
<cast:answer request="req:7f3a">Q2 pipeline: $2.3M, 15% growth.</cast:answer>
```

- `<cast:query>`: `target` (required, agent alias), `channel` (optional, defaults to `"default"`). Requires sender `q` on the target channel.
- `<cast:request>`: same attributes as `<cast:query>`. Requires sender `r`. No `<cast:answer>` is correlated back — the receiver does the work and emits no envelope reply.
- `<cast:answer>`: `request` attribute copied from the inbound query's ID — the only correlation the agent manages.

**Agent receives (inbound):**
```
<cast:query from="smith" request="req:7f3a">What are the Q2 numbers?</cast:query>
<cast:request from="boss" request="req:9c2d">Generate the weekly digest.</cast:request>
<cast:answer from="sales" request="req:7f3a">Q2 pipeline: $2.3M, 15% growth.</cast:answer>
<cast:rejection from="sales" request="req:7f3a">Target agent is in draft mode — not yet ready to respond.</cast:rejection>
```

Direction distinguished by attribute: `target` (outbound, agent-specified) vs. `from` (inbound, server-added).

Rejections arrive as `<cast:rejection>` with the same `request` attribute as the originating call; outbound state is recorded as `rejected` rather than `fulfilled`. The reason text is framework- or operator-controlled, never peer-LLM-authored. Two paths produce a `<cast:rejection>`:

- **Denied queries / requests** — the outbound `<cast:query>` or `<cast:request>` mint persists an `outbound_requests` row; a receiver-side deny routes a typed rejection back keyed on the call's `requestId`.
- **Denied pushes** — the `conversation__push_to_channel` / `conversation__push_to_participant` tools mint a correlation `id`, surface it in the tool result text, and persist an `outbound_pushes` row. If the receiver later denies (ACL revoked between dispatch and gate, draft mode, originating user lacking `i`), the rejection routes back keyed on the same `id`. The agent matches the `id` from the tool's earlier success to know which push the rejection refers to.

### Output Pipeline Order

1. `validateAgentOutput` parses cast tags and validates (balance, nesting, size). Failures blackholed with feedback to agent.
2. `<cast:internal>` blocks logged in `internal` column, removed from user-visible text.
3. `<cast:query>` and `<cast:request>` blocks routed to targets via §16 checks (the matching `q` or `r` bit gates emission).
4. `<cast:answer>` blocks system-routed to requesters.
5. Remaining text delivered to participant (ACL `o` bit checked, see §16).

---

## 12. Container Mounts

When running in container mode, the server mounts agent directories at fixed container paths. These mounts define the LLM's filesystem sandbox — the agent runner can only see what is listed here. Agent services and extensions are not subject to these restrictions (they run on the host).

| Host Source | Container Path | Access |
|-------------|---------------|--------|
| `blueprint/identity/` | `/identity` | Read-only |
| `blueprint/assets/` | `/assets` | Read-only |
| `shared/ext/` | `/shared` | Read-only |
| `memory/` | `/memory` | Read-write |
| `home/` | `/home/agent` | Read-write |
| `state/attachments/` | `/attachments` | Read-only |
| Per-conversation `staging/` | `/staging` | Read-write |
| Per-session `.claude/` | `/home/node/.claude` | Read-write |
| MCP socket files | `/mcp/*.sock` | Read-write |
| Provisioned resources | `/resources/{name}` | Per-resource (default read-only) |

MCP sockets are mounted as individual files, not directories. The socket must be listening before the container starts.

Resource mounts are external paths provisioned by the admin for capability slots declared in `capabilities.json`. Each resource is an independent bind mount with its own access mode. Missing host paths are skipped with a warning.

### Network Isolation

The container receives the network mode via the `CAST_NETWORK` environment variable. Additional allowed endpoints are passed via `CAST_ALLOWED_ENDPOINTS` as comma-separated `host:port` pairs (host may be a domain or IP).

**Reaching the host.** `127.0.0.1` inside the container is the container's own loopback, not the host. Reaching a host-side service requires (a) binding it to a non-loopback interface, (b) dialing the runtime's host-side address, and (c) allowlisting that address via `containerAllowedEndpoints` under `sdk-only`. See `manuals/console/configure.md` *Network surface* for operator guidance.

---

## 13. Runtime State

These directories are managed at runtime. Understanding their contents is useful when writing prompts that reference them, but they should not be created or modified by the definition author.

### state/

Server-managed persistent state. Contains conversation records (`conversations.jsonl`), scheduled tasks (`tasks.json`), the agent database (`agent.db` — message log with FTS5 search, participant registry), the attachment blob store (`attachments/`), and the identity roster (`identity-roster.json`). No other process should write here.

**`identity-roster.json`** — human-readable snapshot of every user identity that has successfully paired with this agent. Updated automatically after each successful pairing. Schema: `{ "<identity-id>": { "name": string, "handles": string[] } }`. Not used for runtime identity lookups (the IdP handles that) — serves as operator reference and disaster recovery aid. Portable with the agent folder.

**`attachments/`** — content-addressed file store for all inbound and outbound media. Blobs are stored at `{hash[0:2]}/{hash}.{ext}` (SHA-256 content hash with 2-character prefix directory). Deduplication is automatic — identical files produce the same hash. Mounted read-only at `/attachments` in the container. The agent accesses files via paths embedded in `[Attachment]` message tags. Attachment metadata (label, hash, MIME type, size) is stored in the `attachments` JSON column on `agent.db` message rows.

### memory/

Agent-writable persistent memory, mounted at `/memory`. Contents survive across conversations. The server does not read or write files here — it is entirely agent-managed.

Registered as an additional directory for Claude Agent SDK (CLAUDE.md discovery).

### home/

Agent's working directory, mounted at `/home/agent`. Persists across conversations.

### sessions/

Per-conversation session directories containing `.claude/` settings for the Claude Agent SDK.

### mcp/

Unix domain socket files for MCP communication. Contains two levels:

- `mcp/cast.sock` — agent-level, always-on socket providing server built-in tools.
- `mcp/agent.sock` — service-provided tools (if a service is running).
- `mcp/socket/` — per-conversation sockets. Each live conversation gets its own socket at `mcp/socket/{hash}.sock` (12-character SHA-256 prefix of the conversation key). Created before each container spawn, destroyed when the container exits. Stale sockets from prior crashes are cleaned up on agent startup.

### logs/

Container run logs. Timestamped log files with run metadata.

---

## 14. Profiles

A profile provides behavioral baseline content injected into the system prompt and lifecycle phases.

| Profile | Description |
|---------|-------------|
| `standard` | Full behavioral guidance: filesystem documentation, tool descriptions, memory management, bootstrap and cleanup prompts |
| `minimal` | Abbreviated guidance with reduced detail |

Selected via `blueprint/props/settings.json` `profile` field. Defaults to `standard`.

Each profile provides four content strings:

| Content | Used in | Purpose |
|---------|---------|---------|
| `prompt` | Layer 2 | Filesystem conventions, directory documentation |
| `skills` | Layer 3 | Tool descriptions, tag usage guidance |
| `bootstrap` | Bootstrap phase | Prepended to channel's `bootstrap.md` |
| `cleanup` | Cleanup phase | Prepended to channel's `cleanup.md` |

---

## 15. Scheduling

### Declarative (schedule.txt)

Cron-based scheduled messages defined in `blueprint/props/schedule.txt` (see Section 7). Evaluated on server startup. Overdue entries advance to the next future occurrence without retroactive dispatch.

### Dynamic (task__schedule)

Tasks created via the `task__schedule` MCP tool are stored in `state/tasks.json`. Supports `cron` (recurring, 5-field expression with optional timezone) and `once` (single execution at a UTC timestamp). Tasks persist across server restarts.

---

## 16. Cross-Agent Communication

Agents can consult each other through the server. The server enforces all policy — agents express intent via output tags, the server decides whether to act on it. All routing metadata (request IDs, return addresses, upstream sets) is generated and managed by the server.

Channels are the interface contract: when Agent A can reach Agent B's `sales-query` channel, the channel defines access, behavior, and disclosure. An agent's channels are its API surface.

**Agent addressing:** Agents have a canonical address `a:<guid>@<issuer>` (e.g. `a:6dfd7205d4@d9c1e2`) and an alias (`manifest.name`, e.g. `smith`). Aliases appear in ACL entries, `<cast:query>` tags, delegation targets, and `routes.json`; the bus resolves them to the canonical form via `bus.resolveAddress()` at each read site. Canonical form flows through persisted runtime data (packets, tasks) and is immutable once minted.

### Communication Patterns

| Pattern | Bits | Behavior |
|---------|------|----------|
| Conversation (`io`) | `i` + `o` | Persistent, bidirectional. Either side can message at any time. This is what humans have with agents today. |
| Request/Response (`qa`) | `q` + `a` | Transactional one-shot. One side initiates a query, the other responds once. Only the structured `<cast:answer>` tag routes back — bare text output is blocked. |
| Request (fire-and-forget) | `r` + `a` | Sender issues a `<cast:request>` with no response expected; receiver accepts via its existing `a` bit and sees the `<cast:request>` tag in its formatted inbound (so it knows not to compose `<cast:answer>`). Intent distinguished from query at the payload-tag level. |
| Push (`ph`) | `p` (sender) + `h` (target) | Cross-agent push via `conversation__push_to_channel`. The sender's current participant (typically the human) becomes the target's conversation participant; the target hosts the conversation with that human. Three-check model: receiver also requires the originating user to have `i` on the target channel. |

Conversation and request/response are distinct security surfaces. Giving an agent `q` on a channel means it can send bounded queries. Giving it `i` means it can have an ongoing conversation — a much larger surface.

### ACL Check Matrix

| Action | Sender's ACL check | Target's ACL check |
|--------|-------------------|--------------------|
| Agent A queries Agent B on channel X | A has `q` for B | B has `a` for A on X |
| Agent B responds to A's query | — (system-routed, requestId validated) | — |
| Agent A sends a fire-and-forget request to B on X | A has `r` for B | B has `a` for A on X |
| Agent A pushes to Agent B on X | A has `p` for B | B has `h` for A on X AND originating user has `i` on X (three-check) |
| Human messages agent on X | — | Agent has `i` for human on X |
| Agent messages human | Agent has `o` for human | — |
| Agent A messages Agent B on X | A has `o` for B | B has `i` for A on X |
| Rejection/error routes back | — (system message) | — |

Both sides must permit: the sender's ACL authorizes outbound (`q` or `o`), and the target's ACL authorizes inbound (`a` or `i`) on the specific channel.

### Request Lifecycle

Requests do not expire automatically. They remain open until responded to or manually closed via MCP tools (`request__list`, `request__close`, `request__close_all`).

Request tracking is scoped to **(channel, participant)** — the durable identity of a relationship, not a conversation instance. Conversations are ephemeral (they expire and restart); the relationship persists. Requests survive conversation boundaries.

Status values: `open` → `fulfilled` (responded), `rejected` (ACL denied or declined), `closed` (manually closed by either side).

### Safety

- **Bare text blocking:** query-only relationships (`q` without `o`) block bare text output — only `<cast:answer>` tags route back
- **1:1 enforcement:** each request authorizes exactly one response; second response rejected
- **System-routed bypasses:** responses and rejections bypass ACL, validated by requestId against request tables
- **DAG enforcement:** upstream set (agents with open inbound requests for a context) prevents cycles

### Configuration Example

Every cross-agent edge is two grants, one in each agent's `acl.json`: the sender records its outbound bit (`q`/`r`/`p`), the receiver records the matching inbound bit (`a`/`h`). Set only one side and the edge fails silently, with no error.

Three agents: Boss queries Sales and Research, and Sales also queries Research. Each `q` is paired with the receiver's `a`:

```
boss     →  "sales": { "sales-query": "q" }, "research": { "research-query": "q" }
sales    →  "boss": { "sales-query": "a" }, "research": { "research-query": "q" }
research →  "boss": { "research-query": "a" }, "sales": { "research-query": "a" }
```

No `i`/`o` between agents. They interact only through query/answer, and answers are system-routed (no `o` bit needed). See §8 for the full `acl.json` schema.
