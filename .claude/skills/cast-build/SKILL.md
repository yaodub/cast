---
name: cast-build
description: Author Cast agent code in advanced mode — blueprint files (identity, channels, props, assets) and per-agent service code under blueprint/service/. Use when the operator wants to write or change something inside one or more agent folders that the in-Cast consoles can't reach (custom service code, scripted blueprint edits, cross-agent folder ops like rename/restore/bulk-delete). Pair with /cast-refine for introspection-first improvement and /cast-debug for diagnosing misbehavior.
---

# Cast — advanced-mode authoring (agent-folder scope)

You are Claude Code in Cast's authoring lane. The operator wants you to write or change code inside one or more agent folders. Every diff you propose is reviewed line-by-line; that review is the only safety property.

## Scope

Argument: `<folder>` (optional).

- **With folder** → anchor at `$CAST_AGENTS_DIR/<folder>/` (default `~/.cast/agents/<folder>/`). Treat the cast repo as read-only context.
- **Without folder** → cross-agent folder operations across `$CAST_AGENTS_DIR/` (rename, restore from backup, bulk delete, etc.).

If neither `$CAST_AGENTS_DIR` nor a folder hint is present, ask the operator before guessing.

## What you author

| Layer | Examples | Reload after edit |
|---|---|---|
| Blueprint identity | `blueprint/identity/{prompt,whoami,peers,skills}.md` | `agent__expire_conversations` |
| Channels | `blueprint/channels/<name>/{channel.json,prompt.md,bootstrap.md,cleanup.md}` | `agent__expire_conversations` |
| Capabilities (extension wiring) | `blueprint/props/capabilities.json` — toggling extensions on/off, configuring already-registered extensions | `configure__restart_agent_service` for tool-list changes; `agent__expire_conversations` for config-only |
| Schedules | `blueprint/props/schedule.txt`, `blueprint/props/settings.json` | Auto hot-reload |
| Assets | `blueprint/assets/*` (static files mounted at `/assets`) | None |
| Per-agent service code | `blueprint/service/*` (the host process for this one agent) | `configure__restart_agent_service` (interrupts in-flight conversations) |
| Operator config | `config/agent.json`, `config/acl.json`, `config/provisions.json`, `config/transport.json` | File-watched (most fields); restart for model changes |
| Extension operator config | `config/ext/<name>/.env`, `config/ext/<name>/config.json` | `configure__restart_agent_service` on secret rotation |
| Cross-agent folder ops | rename, restore from backup, bulk delete under `$CAST_AGENTS_DIR/` | n/a |

## Reading order

Don't read everything up front — read what the task points at. But know what each doc holds so you fetch the right one.

1. **`packages/cast/manuals/MODES.md`** — the trust model. Read first if you're unsure whether the work belongs in a console or in advanced mode.
2. **`packages/cast/manuals/dev/agent-architecture.md`** — agent folder anatomy: authoring surface vs. runtime state, mount table, system prompt assembly layers, the agent contract.
3. **`packages/cast/manuals/console/design/primitives.md`** + **`economics.md`** — the design vocabulary (shape layer vs. verb layer: channels, lifecycle, ACL bits, mounts, push/watch/schedule/recall/memory) and what each choice *costs* per turn and per fire. Foundation reading for any non-trivial blueprint work.
4. **`packages/cast/manuals/console/design/recipes/`** — worked compositions. Patterns *and* exemplars of the spec discipline.
5. **For per-agent service code** (`blueprint/service/`): `packages/cast/manuals/dev/service-development.md`.
6. **Multi-agent wiring**: `packages/cast/manuals/console/design/multi-agent-composition.md` + `cross-agent-acl.md`.
7. **Routing decisions** when the operator's ask exceeds what registered extensions can do: `packages/cast/manuals/console/extension-gap.md`.
8. **Ground truth** when the framing docs leave you unsure: `packages/agent-schema/src/v1/SPEC.md`.

## Posture

- **Name the gap before improvising.** When the operator asks for something registered extensions don't cover, the three shapes in `extension-gap.md` (improvise / advanced mode / decline-with-alternative) are the menu. The "advanced mode" shape, in your hands, means writing per-agent service code.
- **Pair widening with the code that needs it.** Flip `containerNetwork: full` or add `containerAllowedEndpoints` together with the service code that uses the endpoint.
- **Back up before mutating.** Before the first write to any agent's files, snapshot that agent so the change is reversible: `python3 scripts/agent-snapshot.py <CAST_AGENTS_DIR>/<name>` (from the cast repo root). Whole-agent capture (blueprint + runtime), bounded rotation — keeps the newest 5 in a `pre-edit-*` lane under the agent's `.backups/`, self-pruning, independent of the server's daily snapshots. Scope it to what you'll touch: in single-folder scope, run once up front for the target; in cross-agent ops, snapshot each agent immediately before you modify it (for a rename, snapshot under the current name first).
- **Diff discipline.** Read before editing. Propose the change, wait for the go, then write. The operator's review is the only audit layer Cast has for this work.
- **Validate after blueprint edits.** Run any available validation script (`design__validate`-equivalent host-side checks) and address gaps before declaring the work done.
- **Stratify directives correctly.** Agent-wide things (`identity/*.md`) vs. channel-specific things (`channels/<name>/prompt.md`). Keep layers separate. See `primitives.md` § Stratification.

## Sibling skills

- **`/cast-refine <folder>`** — introspection-driven refinement. Reach for it when the question is *what should change* (look at runtime against intent, surface proposals), not *how do I change this thing*.
- **`/cast-debug [folder]`** — layer-by-layer diagnosis. Reach for it when the question is *why did this happen* or *why isn't this arriving*.
