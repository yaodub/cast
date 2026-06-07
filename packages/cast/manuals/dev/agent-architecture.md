# Agent Architecture Reference

> This document is a developer-oriented guide to agent folders. `@getcast/agent-schema` `src/v1/SPEC.md` is the canonical specification — this document adds framing and guidance for authors working on the authoring surface.

An agent is a folder. This document describes which parts are yours to modify, which are hands-off, and how the pieces connect.

## Agent Folder

An agent folder has two zones: the **authoring surface** (files you create and modify to define the agent) and the **runtime state** (files managed by the server, the agent, or the service process at runtime). Modifying runtime state directly will break things — the server and agent expect to be the sole writers.

### Authoring Surface

These are the directories you work in. They define what the agent is, how it behaves, and how it connects to the world.

| Directory | Role | Agent access | Purpose |
|-----------|------|--------------|---------|
| `blueprint/identity/` | Developer | Read-only | System prompt, skills, supporting files. |
| `blueprint/channels/` | Developer | No access | Channel definitions: config, lifecycle prompts. Server reads these, agent never sees them. |
| `blueprint/props/` | Developer | No access | Server settings: env vars, schedules, tool policies. |
| `blueprint/service/` | Developer | No access | Agent service source: jobs, MCP tools. Compiled when the service is built, runs as a separate process. |
| `manifest.json` | Developer | No access | Metadata: spec version, origin, timestamps. |
| `config/` | Operator | No access | Deployment config: model, API keys, transport tokens. |

**Developer** — builds and configures the agent. Authors identity, channels, props, service code, and metadata. This is the role you play when editing an agent folder via Claude Code; the in-Cast Design console plays the same role for iterative per-agent edits within the console envelope.

**Operator** — deploys the agent. Sets the model, API keys, and transport tokens. May be the same person as the developer, but the concerns are separated: `config/` contains secrets and deployment choices that aren't part of the agent's definition.

### Runtime State

These directories are managed automatically. You should understand what they contain (especially when writing prompts that reference them), but you should not create or modify files here.

| Directory | Managed by | Agent access | Purpose |
|-----------|------------|--------------|---------|
| `memory/` | Agent | Read-write | Persistent storage the agent reads and writes freely. Survives across conversations. |
| `home/` | Agent | Read-write | Working directory (CWD at runtime). |
| `blueprint/assets/` | Developer | Read-only | Static data files for the agent to read at runtime. |
| `shared/ext/service/` | Service | Read-only (at `/shared/service`) | Agent-visible output written by service jobs. |
| `shared/ext/{ext-name}/` | Extensions | Read-only (at `/shared/{ext-name}`) | Agent-visible output written by extensions. |
| `ext/{ext-name}/`, `ext/service/` | Extension / service | No access | Extension private runtime — DBs, caches, auth tokens. Never mounted. |
| `config/ext/{ext-name}/` | Operator | No access | Extension operator config + secrets. Managed via admin UI or hand-edited. |
| `state/` | Server | No access | Conversation logs, task schedules, message database. |
| `sessions/` | Server | Ephemeral | Per-session runtime state. |
| `mcp/` | Server | Ephemeral | MCP socket files for IPC. |

For the full directory structure, ownership table, and container mount paths, see SPEC.md §2 and §11.

## The Agent Contract

The server reads specific files from the authoring surface to assemble the system prompt and configure behavior. These files are the **contract** — the interface between what you write and how the server runs the agent.

### System Prompt Assembly

The server builds the system prompt from 10 layers, in order. Later layers appear later in the prompt.

| # | Source | Wrap | Description |
|---|--------|------|-------------|
| 1 | Server-generated | `<cast-protocol>` | Infrastructure: directory layout, network policy |
| 2 | Profile | `<agent-profile>` | Base behavioral profile (default: `"standard"`) |
| 3 | Profile | `<agent-profile-skills>` | Profile-level skill instructions |
| 4 | **`blueprint/identity/prompt.md`** | *(raw, no wrapper)* | **Agent personality and behavior** |
| 5 | **`blueprint/identity/whoami.md`** | `<agent-identity>` | **Structured identity: name, location, role** |
| 6 | **`blueprint/identity/peers.md`** | `<agent-peers>` | **Agent peer relationships: who to consult, channels, context** |
| 7 | **`blueprint/identity/skills.md`** | `<agent-skills>` | **Operational skills and systems** |
| 8 | **`blueprint/channels/{name}/prompt.md`** | `<channel-instructions>` | **Channel-specific instructions (active channel only)** |
| 9 | **`shared/ext/service/agent-context.md`** | `<service-context>` | Dynamic context written by the agent service |
| 10 | Server-generated | `<conversation-context>` | Participant, channel, time, previous session summaries |

Layers 1-3 and 10 are server-managed. **Layers 4-8 are your primary authoring surface** — this is where the agent's voice, identity, capabilities, peer relationships, and channel-specific behavior are defined. Layer 9 is written by the service. All layers are optional — missing files are silently skipped.

> **Data directories:** Static data the agent reads goes in `blueprint/assets/` (mounted read-only at `/assets`). Dynamic data written by the service goes in `shared/ext/service/` (mounted read-only at `/shared/service`). Service-local databases stay in `ext/service/` (service CWD, not mounted).

### Identity is runtime, not authored

A blueprint names no user. Who the agent is talking to is resolved at the routing layer and injected every turn in Layer 10's `<conversation-context>`:

```xml
<participant id="u:a7f3k@d9c1e2" declared-name="Alice" />
```

`id` is the bare server-issued identity (operator surfaces carry their bare surface, e.g. `cli:alice`). The transport handle (`tg:12345`) is gateway-local and never reaches the agent. `declared-name` is the name that participant chose, via `/set-name`, pairing, or the transport. To address someone by name, read `declared-name`. Never write a name into `prompt.md`. The same prompt serves every participant, and the agent tells them apart from this element, not from baked-in text.

Treat all participants uniformly. There is no privileged "operator" persona in the blueprint. Operator surfaces (`cli:`/`admin:` handles) hold full bits at the ACL layer, and a hosted multi-user deployment may have no operator participant at all. To tell a human apart from a peer agent, read the inbound source tags: a peer agent's turn arrives wrapped (e.g. `<cast:push fromAgent=...>` / a query envelope) and should be validated before acting on, while a participant's own turn has no such wrapper.

Hardcoding a recipient, an address, or a specific person's name collapses three roles (author, operator, runtime user) into one and yields an agent that can only ever serve one person. Operator-supplied values belong in config (Configure's lane) or a resource slot. Runtime recipients are acquired at runtime: the message being answered, pairing, or discovery (`agent__list_channels` / `agent__list_participants` — scoped to the rooms the calling cell is placed in, so relay cells discover their co-members without any baked address). See `console/what-is-an-agent.md` and `console/design/anti-patterns.md` (Principle 6).

### blueprint/identity/

The four contract files the server reads (all live inside `blueprint/identity/`):

**`prompt.md`** — Who the agent is and how it behaves. Personality, conversational style, what to do and what not to do. This is the agent's voice. Injected as raw text (no XML wrapper), so it reads naturally in the prompt.

**`whoami.md`** — Structured identity facts. Name, location, role. Wrapped in `<agent-identity>` tags. Often ships as a stub and gets populated by the agent during its first conversation.

**`peers.md`** — Agent peer relationships. Describes other agents this agent works with: what they do, which channels to query, when to consult them, and any constraints. Wrapped in `<agent-peers>` tags. Only for agent-to-agent relationships — human contacts are runtime-discovered via the participant system.

**`skills.md`** — Operational systems the agent uses. Data formats, storage conventions, validation rules. Think of this as reference material — how things work, not who you are. Wrapped in `<agent-skills>` tags.

Anything else in `blueprint/identity/` (e.g., `onboarding.md`, `tools/validate.py`) is not read by the server. These are supplementary files the agent can access at runtime because `blueprint/identity/` is mounted read-only in the container. Your prompt can tell the agent to read them, but the server doesn't inject them into the system prompt.

### channels/

Each subdirectory of `channels/` defines a channel — a named conversation configuration that controls idle timeout, lifecycle, tool availability, and message logging. A `default` channel always exists; when no `channel.json` file is present, the implicit fallback is `idle_timeout: 1800000` (30min), `lifecycle: "none"`, `log_messages: true`. When a `channel.json` *is* present, `idle_timeout` is required (use `null` for single-shot; a positive integer in milliseconds otherwise). User-channel logging writes to the agent's `agent.db`; console-channel logging writes to a separate `console.db` — set `log_messages: false` to opt the channel out of both message and event log persistence.

A channel directory contains `channel.json` (configuration), an optional `prompt.md` (channel-specific instructions injected into the system prompt as layer 7), and when lifecycle is enabled, `bootstrap.md` and/or `cleanup.md` (lifecycle prompts).

For the full channel concept, configuration schema, and lifecycle mechanics, see SPEC.md §6.

### props/

Settings the server reads but the agent never sees. Not mounted in the container.

- **`settings.json`** — Environment variables passed to the agent process: `{ "env": { "KEY": "value" } }`
- **`sdk-settings.json`** — Claude SDK-specific env vars. Merge order: server defaults → sdk-settings → settings (later wins).
- **`capabilities.json`** — Agent capability declarations: extension config, tool policies (`disabled_tools`, `additional_disabled_tools`), `pip` package management, and `resources` slot definitions. Author-controlled. Admin provisions deployment-specific values (resource paths, extra packages) in `config/provisions.json`. See "Extensions" section below.
- **`schedule.txt`** — Declarative cron schedules: `<cron_5_fields>  <channel>  <message text>`. Server routes these as self-addressed messages.

For field-level details, see SPEC.md §7.

### config/

Operator-managed deployment settings. Separated from `props/` because these contain secrets and deployment choices — not part of the agent's definition. Never mounted in the container.

- **`agent.json`** — Runtime knobs: model, per-channel/per-phase `modelOverrides`, network isolation mode, timezone, backup, max conversations. No blueprint dependency.
- **`provisions.json`** — Admin's deployment-specific values for capability slots: resource paths, extra pip packages, additional disabled tools. Optional — omit when not needed.
- **`transport.json`** — Transport bindings (e.g., Telegram bot token and channel routing).
- **`acl.json`** — Access control: `peers.<peer>.<channel> = "<bits>"` per-peer-per-channel grants. Each entry holds this agent's permissions toward that peer on that channel — both inbound-accept bits (`i`, `a`, `h`) and outbound bits (`o`, `q`, `r`, `p`). For any cross-agent edge, both sides write entries in their own `acl.json` — the sender's file records its outbound bit, the receiver's records its inbound bit. Peer identifiers are agent aliases (matching `manifest.name`) or canonical `u:<guid>@<issuer>` for humans; channel is whatever the receiver named it (same name on both sides of an edge). See SPEC.md §8 for the bit table and §16 for the cross-agent check matrix.

For field-level details, see SPEC.md §8.

## Channels and Conversations

A **channel** is a named conversation type — a main chat channel, a scheduled-task channel, a notification channel, etc. Each channel configures how its conversations behave: how long they last, what happens when they start and end, and what tools are available.

Each participant gets their own independent conversation per channel. Conversations have finite context windows — when one ends and a new one begins, the agent starts fresh unless lifecycle prompts and summaries bridge the gap.

Channels also serve as the interface for cross-agent queries. For `main` to query a `sales-query` channel on another agent: the receiving agent's `acl.json` has `a` for `main` on `sales-query` (inbound gate); `main`'s own `acl.json` has `q` for that agent on `sales-query` (outbound gate). Both entries are required. See SPEC.md §16.

### Lifecycle

Lifecycle prompts solve the continuity problem:

- **`bootstrap.md`** — Injected on the first message of a new conversation. Tells the agent what to read to restore its working state.
- **`cleanup.md`** — Delivered wrapped in `<cast:lifecycle>` when the conversation expires via idle timeout. Tells the agent to persist what it learned and write a conversation summary.
- **Summaries** — The server automatically injects recent conversation summaries into Layer 10.

The full cycle: **cleanup** saves state → **bootstrap** restores state → **summaries** bridge the gap.

Lifecycle modes: `"none"`, `"bootstrap-only"`, `"cleanup-only"`, `"full"`. Lifecycle prompts fire on persistent and single-shot channels alike — on single-shot, bootstrap runs in topology-only mode (no prior session to re-immerse from) and cleanup fires as a piped `<cast:lifecycle>` turn immediately after the reply rather than at idle expiry. Single-shot cleanup writes should target `/memory/` rather than `conversation__write_summary` (a silent no-op on single-shot, since single-shot conversations don't persist to state store).

## Agent Service

An optional long-running process that provides external capabilities to the agent. It runs as a separate process with its own `package.json` and dependencies — it cannot import from the server or agent runner.

From the developer's perspective, a service does three things:

1. **Provides MCP tools** the agent can call during conversation
2. **Populates `shared/ext/service/`** with data the agent can read (mounted at `/shared/service`)
3. **Injects dynamic context** via `shared/ext/service/agent-context.md` (prompt assembly layer 9)

Service databases stay in `ext/service/` (the service CWD), not in any agent-visible directory. Operator-owned service files live in `config/ext/service/` — `secrets.json` (credentials) and `config.json` (settings), declared in the service manifest's `secrets`/`config` fields and edited from the admin UI; the server restarts the service when either changes. A service can also render its own admin page (manifest `admin: true`, proxied at `/agents/{folder}/admin/`). For the mechanical service contract (entrypoint resolution, env vars, IPC messages), see SPEC.md §9.

## Server Tools

The server provides MCP tools to every agent conversation. These are the base tools available to all agents — service-provided MCP tools are additional. Any tool can be disabled via `disabled_tools` in `channel.json` or `props/capabilities.json` using exact names or domain globs (e.g., `task__*`). This also covers the SDK's built-in tools (`WebFetch`, `Bash`, …), which are forwarded to the SDK's `disallowedTools`. Separately, built-in `WebFetch` is gated by the host on network mode: kept on `full`-network spawns (e.g. the blueprint-authoring consoles), disabled on `sdk-only`/`none` — Cast routes fetching through the web-fetch extension there.

Understanding these tools matters when writing prompts — your `bootstrap.md`, `cleanup.md`, and `skills.md` can instruct the agent to use them.

### Task tools

Tasks are independent agent sessions that run later. A task spawns a full agent with all tools — the task prompt can be high-level and multi-step.

| Tool | Description |
|------|-------------|
| `task__schedule` | Create a deferred or recurring task. |
| `task__list` | List active and paused tasks. Each user sees only their own. |
| `task__pause` | Pause a task (it won't run until resumed). |
| `task__resume` | Resume a paused task. |
| `task__cancel` | Cancel and delete a task. |
| `task__list_runs` | View recent task dispatch history. |

`task__schedule` parameters:
- `prompt` — what the agent should do when the task runs. Include all context in the prompt.
- `schedule_type` — `"cron"` (recurring) or `"once"` (one-time).
- `schedule_value` — cron: 5-field expression (e.g., `"0 10 * * *"`). once: UTC timestamp (e.g., `"2026-02-01T15:30:00Z"`).
- `timezone` (optional) — IANA timezone for cron (e.g., `"America/New_York"`). Omit for UTC.

Task output is sent to the user. The prompt can instruct the task agent to wrap output in `<cast:internal>` tags to suppress delivery (useful for background maintenance).

### Conversation tools

| Tool | Description |
|------|-------------|
| `conversation__write_summary` | Save a summary of the current conversation. Used during cleanup. |
| `conversation__list_summaries` | List recent conversations with summaries, status, and last activity. |
| `conversation__push_to_channel` | Push a turn into a different channel for the current participant; optionally onto a different agent via `target_agent` (cross-agent requires `p` bit + receiver `h` bit + originating user `i` bit on the target channel). Returns a correlation `id` in the result text — if the receiver later denies the push, a `<cast:rejection request="<id>">` arrives on a future turn so the sender can recognize the failure. The receiving channel's agent has full autonomy (can suppress with `<cast:internal>` tags). |
| `conversation__push_to_participant` | Push a turn into another participant's conversation on this agent (intra-agent only — no `target_agent`). Returns a correlation `id` for receiver-rejection correlation, same as `push_to_channel`. |

### Agent tools

| Tool | Description |
|------|-------------|
| `agent__list_peers` | List peer agents with per-channel permissions (who you can query, who can query you, messaging directions). Peers are other agents — not users. |
| `agent__list_channels` | List the channels where the calling cell's participant is placed, with sharding and visibility markers. The agent itself and operator surfaces see every configured channel. |
| `agent__list_participants` | List the members of a channel the caller is placed in, as push-target identities with day-level recency (optional `channel` param, defaults to the current channel). Scoped to the caller's own rooms — a cell can list exactly what the push gate would let it reach. The agent itself and operator surfaces get unfiltered views; with no channel in context they get the agent-wide registry with exact timestamps. |

### Message log tools (conditional on `log_messages: true`)

Available when the channel has `log_messages: true` and the corresponding store is wired. User-channel runners get the `message_log__*` family backed by the per-agent `agent.db`. Console runners (Design, Configure, DM, CM, SM) get the `console_log__*` family backed by the console DB (per-agent `console.db` for Design/Configure, server-scope `server-console.db` for DM/CM/SM) — the two families never co-exist on a single runner, and the two stores live in separate SQLite files.

| Tool | Description |
|------|-------------|
| `message_log__search` / `console_log__search` | Full-text search across past messages. Returns matching messages with timestamps and participants. |
| `message_log__recent` / `console_log__recent` | Recent messages, newest first. |
| `message_log__read` / `console_log__read` | Fetch full text of a specific message by ID. |

### Request tools

Manage cross-agent request lifecycle. Available when channel and participant context exist.

| Tool | Description |
|------|-------------|
| `request__list` | List open requests (inbound + outbound) for the current channel + participant context. |
| `request__close` | Close a request by ID. Closing an inbound request sends a rejection to the requester. |
| `request__close_all` | Close all open requests for the current context. |

## Scheduled Tasks

Two mechanisms for scheduling:

**Declarative** (`props/schedule.txt`) — defined by the developer. The agent cannot modify these. Parsed at startup.

**Programmatic** (`state/tasks.json`) — created by the agent via `task__schedule` during conversation. The agent can create, pause, resume, and cancel these.

Both mechanisms route messages to the agent as self-addressed conversations at the scheduled time. For scheduling details, see SPEC.md §14.

## Skills

Skills are behavioral guidance — prompt fragments, bootstrap hooks, and cleanup routines that teach the agent how to use a capability. They are the semantic counterpart to extensions' mechanical tools and config. Extension-bundled skills live in the extension's `manual/SKILL.md` and are read by authoring actors. Freestanding skills (memory patterns, conversational habits, etc.) are user/community content — not bundled in Cast — and can be installed into an agent by copying skill files into the agent's blueprint.

## Extensions

Extensions are self-contained capability packages that the server activates declaratively. They provide tools, prompt sections, and lifecycle hooks — no service code needed.

| Package | Name | What it does |
|---------|------|-------------|
| `@getcast/ext-email` | `email` | IMAP search, SMTP send/draft, subscriptions |
| `@getcast/ext-web-fetch` | `web-fetch` | Fetch and extract web page content |
| `@getcast/ext-calendar` | `calendar` | CalDAV calendar CRUD (Google, Apple, Fastmail, any CalDAV) |
| `@getcast/ext-whatsapp` | `whatsapp` | WhatsApp Web via Baileys, chat discovery, send/read |

Extensions are enabled in `props/capabilities.json` with a locked-by-default config merge. Each extension reads secrets from `config/ext/{name}/.env` and can optionally pair with a dedicated channel for notifications.

Each extension package contains:
- `manual/README.md` — mechanical reference (tools, config, secrets, security, admin)
- `manual/SKILL.md` — behavioral skill (prompt, bootstrap, cleanup)

Read the manual before enabling an extension. The SECURITY section informs the mandatory security assessment (see INSTRUCTIONS.md rule 11).

For authoring extensions, see `packages/extension-schema/AUTHORING.md`. For manual format, see each extension's `manual/README.md`.
