# Cast manuals — mount-root index

You are reading this file at `/ref/manuals/README.md` inside your
console container. It's a map of what's here and when to read it.

## What's already in your prompt

These are inlined into every turn — you don't need to Read them:

- `console/overview.md` — shared principles across all consoles
- `console/<your-console>.md` — your main console manual

Don't re-Read these. Reach for Read when you need something *not*
already in your prompt.

## Read this first if you're unsure which surface a request belongs in

- `MODES.md` — Cast supports two authoring surfaces (console mode,
  advanced mode) with different trust models. The same operator
  request lands differently depending on which mode answers it. The
  trigger to read: the operator is asking for something that *might*
  be off-envelope (custom service code, network widening, anything
  off-catalog), and you want to be honest about which side the work
  belongs on. Also names the manual-scoping rule for AI agents
  reading the console manuals from outside a console.

## When to look further

Use these pointers when you're about to make a choice that has a "right
way" locally — a wiring convention, a schedule format, an extension
configuration. Reading a manual you don't strictly need is cheap;
inventing a convention that conflicts with the codebase is expensive.

### Cross-console deep references

Shared on-demand manuals that apply across consoles. Only read when
the trigger condition matches:

- `console/what-is-an-agent.md` — authoring a blueprint or
  decomposing a system, and you want the conceptual grounding
  before the mechanics: characteristics of a well-designed agent,
  the dev-time / runtime split, and the aspirational ladder from
  utility surfaces to richer autonomy.
- `console/extension-gap.md` — the operator's ask exceeds what the
  registered extensions can do (Slack, Notion, database, SSH, any
  protocol not in the tool set). Decision tree between improvising
  with web-fetch, redirecting to Claude Code, or offering an
  alternative shape.

### Console-specific deep references

Per-console split files cover subtasks that don't apply to every
session. Only read when the trigger condition below matches what the
operator is asking for:

- `console/design/service-and-schedule.md` — editing `blueprint/service/`
  or `blueprint/props/schedule.txt`.
- `console/design/multi-agent-composition.md` — this agent peers with
  another (sends to or receives from a peer channel), or you were
  briefed as part of a multi-agent create batch. Channel-name
  alignment and shape choice (q/a, r/a, p/h).
- `console/cross-agent-acl.md` — you're a Configure surface authoring
  ACL grants for a cross-agent edge. Bit glossary, the directional
  rule, worked JSON. (Design and Design Manager do not author ACL.)
- `console/design/operator-values.md` — you need a value the operator
  hasn't given you (email address, URL, recipient list) and are
  tempted to placeholder it.

The main console manual's "Further reading" section is the authoritative
list; this one is a summary.

### Extension manuals

Every registered extension ships a manual at
`/ref/manuals/extensions/<name>/`:

- `README.md` — mechanical reference (config, secrets, storage,
  security). Read before wiring the extension into
  `blueprint/props/capabilities.json`.
- `SKILL.md` (when present) — behavioral patterns the agent should
  follow when using the extension. Read before composing a channel
  prompt that uses the extension.
- `skills/*.md` (when present) — deeper skill files referenced from
  SKILL.md.

Your dynamic snapshot (server-scope consoles) or capabilities
declaration (per-agent consoles) lists which extensions are present.
The directory name is the extension's canonical key — use it verbatim
in `capabilities.json`.

## Meta

- These manuals are read-only. Edits belong in the source tree on the
  host (`packages/cast/manuals/` for console manuals,
  `packages/ext-<name>/manual/` for extension manuals).
- Restart the Cast server to pick up manual edits.
- If a manual you expect to exist is missing, the server may have
  failed to aggregate it at startup — say so in your reply rather
  than inventing the content.
