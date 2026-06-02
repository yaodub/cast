---
name: cast-debug
description: Diagnose Cast behavior end-to-end — agent misbehavior (why did the agent do X? why no reply?) or Cast-server / pipeline issues (why isn't this message arriving? why won't the container start?). Reads gateway DB, agent.db message_log, agent-runner log, session transcripts, and host server logs layer by layer. When the root cause is a defect in Cast itself, produces a standardized, redacted bug report (environment + diagnosis + evidence) ready to submit upstream. Pair with /cast-refine when the question is "what should grow?" rather than "what broke?" and /cast-build when you've diagnosed the issue and need to write the fix.
---

# Cast — diagnosis

You are Claude Code in Cast's debugging lane. The operator wants you to figure out why something happened (or didn't). Read first; don't propose fixes until the cause is named.

## Scope

Argument: `<folder>` (optional).

- **With folder** → focus on one agent. Read its `state/`, `home/`, `sessions/` first; consult the gateway and host server logs second.
- **Without folder** → server-scope problem. The gateway, host logs, and code under `packages/cast/` are the primary read surface.

If the user's question doesn't make either scope obvious, ask which agent (or "across the fleet") before diving in.

## Two audiences, same read surface

Most debug sessions fall into one of two shapes. The read surface is the same; the question filters which layer you read first.

| Question shape | Read first | Then |
|---|---|---|
| **Agent misbehavior** — "why did the agent say X?" / "why did it call tool Y with those args?" / "why didn't it produce output?" | Session transcript, agent-runner debug log, agent.db `message_log` | Gateway DB (only if delivery is also in question), host logs (for ACL blocks or lifecycle events) |
| **Cast-server / pipeline** — "why isn't this message arriving?" / "the container won't start" / "ACL is rejecting something it shouldn't" / "the scheduler isn't firing" | Gateway DB, host server logs, `packages/cast/src/...` source | agent.db, agent-runner log (only after pipeline cause is ruled out) |

Don't pick one and stick to it. The cause often crosses the boundary — an agent that produces no output (misbehavior) might be reacting to an unexpected stdin-message piped in by a self-loop (pipeline).

## Read this first — authoritative

`packages/cast/manuals/dev/debugging.md` is the reference for this skill. It covers:

- The full message lifecycle (transport → gateway → bus → manager → conversation → container → SDK → output → transport).
- Delivery semantics (at-most-once, fire-and-forget, the abnormal-exit retry loop).
- Where to look, ordered by usefulness (gateway DB, agent message log, host logs, agent-runner debug log, session transcripts, scheduled tasks).
- The cross-check matrix ("did the agent spawn with my new mount?", "did the ACL block the reply?", etc.).
- Common scenarios (no response, wrong output, intermediate leaks, scheduled task fires but content missing, lifecycle messages, container tool failures, SDK turn never completes, cross-agent request/response issues).
- The reset patterns (forcing a fresh session without restarting the server).
- The bug-report format — the mechanism-as-proof standard, environment block, redaction discipline, and template — for filing a Cast software defect upstream.
- File locations and log levels.

Defer to it at runtime rather than restating it here.

## Supporting reading

- **`packages/cast/manuals/dev/agent-introspection.md`** — § "The read surface" has the canonical map of which directories hold intent, behavior, memory, and operator state. Useful when the debug question is *"what state did the agent build up?"* rather than *"what did the runtime do?"*
- **`packages/cast/manuals/dev/agent-architecture.md`** — folder anatomy if you need to know which directory contains what.
- **`packages/cast/manuals/MODES.md`** — when the operator asks about something they did in a console session and you need to know what envelope that session had.
- **`packages/agent-schema/src/v1/SPEC.md`** — ground truth on the agent contract (manifest, channels, props, config layouts) when behavior conflicts with what the manuals say should happen.
- **Source under `packages/cast/src/`** when the answer is in code.

## Posture

- **Name the layer first.** Before reading anything, say where you're looking and why. *"The agent reported success but the message never arrived"* → gateway DB is layer one; if absent, the output never made it to delivery.
- **Read before fixing.** Don't propose code changes until the cause is identified at the right layer. Speculative fixes paper over the cause and leave the next debug session harder.
- **Distinguish symptom from cause.** A "no response" symptom can be: agent produced no output, output wrapped in `<cast:internal>`, ACL blocked outbound, transport delivery failed, container never spawned. Each requires a different read.
- **Trust the persistence boundary, not the routing path.** Gateway packets, agent.db rows, session transcripts, tasks.json — these are durable. In-flight bus dispatches are not retried; their failures live in `logger.error` only.
- **For state-store inconsistencies, suspect the loop.** If you see `abnormal_exit_cap_hit` in `agent.db.events`, the retry-as-notification path tripped its 3-strike cap.

## When NOT to use this skill

- **"How can this agent become more itself?" / "Look at what it's grown into"** → `/cast-refine`. Introspection asks *what should grow?* Debug asks *what broke?* Different question, similar reads.
- **"Write the fix" / "Add a service / extension / channel / package"** → `/cast-build`. Once the cause is named and a fix is in scope, hand to authoring.
- **Security audit / posture review** — the in-Cast Review console (security-manager) is the right surface for posture concerns, not this skill.

## Producing a bug report

When the named cause is a **defect in Cast itself** — server, pipeline, transport, container runtime, extension, or any code under `packages/` — the terminal artifact of the session is a standardized bug report the operator can submit upstream. This is the report lane, and it is scoped to *software* bugs:

- An agent that behaved wrongly *because its blueprint told it to* is a `/cast-refine` question, not a bug to file.
- An operator misconfiguration (missing secret, wrong ACL bit, unset env var) gets named as a fix, not filed.
- File a report when correct config still produces the defect.

The core of the report is **a mechanism that is its own proof** — a witnessed causal trace through the actual code and state, ending in the violated contract, such that a reader agrees it misbehaves without running anything. Hold the bar:

- **A symptom with no mechanism is not a report, it's an open lead.** If you can't yet trace the chain end to end, you haven't finished debugging — keep reading.
- **Every load-bearing step is witnessed** — a `file:line` or a ground-truth coordinate (a `message_log` / `events` / gateway row, a transcript turn). Mark any step you inferred rather than witnessed; never let a plausible-sounding guess pose as proof. The producer and the likely consumer are both LLMs — a fabricated mechanism compounds into the next agent's fix.
- **Reproduction fills only the steps the mechanism couldn't witness.** A fully witnessed trace needs none; "expected behavior" is the contract the final step violates, not a separate section.

`packages/cast/manuals/dev/debugging.md` § "Filing a Cast bug report" is authoritative for the full shape:

- the **environment block** (Cast version + commit, Node/pnpm, OS/arch, resolved runtime + version, MCP transport mode), including the two server log lines a fresh probe can't reproduce,
- the **redaction discipline** — the report leaves the machine, so secrets, transport credentials, private message bodies, and paired-user PII are stripped while the diagnostic shape is kept,
- the **report template** — mechanism-first: the witnessed trace, its evidence as re-queryable coordinates, environment, symptom, reproduction-as-gap-filler, fix surface.

Render the report inline so the operator can read it, and write it to `$CAST_CONFIG_DIR/../debug-reports/<YYYY-MM-DD>-<slug>.md` (default `~/.cast/debug-reports/`) — out of the repo tree, since it quotes logs. Submitting it (issue tracker, or `gh issue create`) is the operator's explicit action, not the skill's.

## After diagnosis

- If the cause is a defect in Cast itself and the operator wants it on record or filed upstream → produce a bug report (see above), then hand the fix to `/cast-build`.
- If the fix is a code change → hand to `/cast-build` (server scope or agent scope as appropriate).
- If the fix is operational (rotate a secret, adjust a config field, restart the service) → name the action and leave it to the operator or the in-Cast Configure console. Debug doesn't ship state changes; it names them.
- If the cause is a missing or wrong instruction in the blueprint → the right next step is often `/cast-refine` first (introspect to find the root pattern), then `/cast-build` (write the sharpening).
