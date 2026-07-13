# Migrating from 0.2 to 0.3

Cast 0.3 introduces the access model: the ACL grant map is renamed and the per-agent approvals table is generalized. The runtime no longer carries backward-compat shims for the old shapes (no tolerant `peers` loader, no parse-time column defaults), so run these scripts once before starting the 0.3 server. A fresh install skips this folder entirely.

The scripts are only the mechanical half. The blueprint-cleanup pass at the end of this document is the manual half, and because nothing in it is enforced by a parse error, a clean server start does not mean your agents are correct on 0.3.

## What changed

1. **`acl.json` grant map `peers` → `allowed`.** The grant map was renamed for the `allowed` / `rejected` polarity pair. The runtime no longer accepts the legacy `peers` key, and `AclSchema` is `.strict()`, so an un-migrated `acl.json` fails to parse (the agent denies all access).
2. **Generalized `approvals` table.** The per-agent `agent.db` `approvals` table gains `type`, `controller`, `tier`, `principal`, `destination`, `provenance`, and `payload` (the approval-model substrate), and `tool`/`args` relax to nullable so a tool-less `acl-edge` approval is representable. Fresh databases get this shape from the table definition; existing ones are rebuilt to it (relaxing NOT NULL is not an in-place ALTER in SQLite), or approval reads fail (the runtime carries no parse-time defaults).
3. **Single ACL store — `paired-users.json` folds into `acl.json`.** Pairing is removed (access is now requested at runtime and granted by the agent's owner, which writes the grant straight into `acl.json`). The separate per-agent `state/paired-users.json` grant store is retired; this step folds each agent's paired-user grants into its `acl.json` `allowed` map so previously-paired users keep access, with `acl.json`'s `allowed` winning per identity.
4. **The removed `h` bit is dropped.** The old `host` (`h`) bit is gone — a cross-agent push now rides the carried user's own `io` grant on the target, so the separate host grant is redundant. `AclSchema` rejects `h` at parse (allowlist `ioaqrp`), so an un-migrated grant carrying it fails to load. This step removes `h` from every grant in both `allowed` and `rejected`, dropping channels and peers left empty. `p` is kept: 0.3 reinstates it as the reactive push-containment edge (framework-written, valid on user and agent peers alike). Typically a no-op — `h` was only granted by the code-declared console tables, never on disk — so it runs as a safety net.
5. **`outbound_requests` gains `kind`.** The cross-agent reply rail became a capability model: the open `outbound_requests` row is the round-trip authorization the query was emitted under, and the answer redeems it — fixing allow-once queries whose answer was previously blackholed by a standing-edge re-check. The row records `kind` ('query' | 'request') so the reply handler keeps the r-bit promise (a fire-and-forget `request` redeems only a bounce, never an answer). A plain additive ALTER (`NOT NULL DEFAULT 'query'`); existing in-flight rows default to 'query'. The runtime carries no parse-time default, so an un-migrated `agent.db` fails to read outbound requests.

## Procedure

Stop the server first. Every script is idempotent and prints a dry-run plan by default. Nothing mutates until you pass `--apply`.

```bash
# 1. Rename the acl.json grant map: peers → allowed
pnpm exec tsx scripts/migrations/0.2-to-0.3/1-acl-peers-to-allowed.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.2-to-0.3/1-acl-peers-to-allowed.ts ~/.cast/agents --apply

# 2. Rebuild each agent.db approvals table to the 0.3 shape
pnpm exec tsx scripts/migrations/0.2-to-0.3/2-approvals-generalized-columns.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.2-to-0.3/2-approvals-generalized-columns.ts ~/.cast/agents --apply

# 3. Fold paired-users.json into acl.json (single ACL store)
pnpm exec tsx scripts/migrations/0.2-to-0.3/3-paired-users-to-acl.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.2-to-0.3/3-paired-users-to-acl.ts ~/.cast/agents --apply

# 4. Drop the removed h bit
pnpm exec tsx scripts/migrations/0.2-to-0.3/4-ph-to-io.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.2-to-0.3/4-ph-to-io.ts ~/.cast/agents --apply

# 5. Add the kind column to each agent.db outbound_requests table
pnpm exec tsx scripts/migrations/0.2-to-0.3/5-outbound-request-kind.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.2-to-0.3/5-outbound-request-kind.ts ~/.cast/agents --apply
```

Restart the server when all five report done.

The scripts locate your data the way the server does: run them from the repo root and they read `CAST_AGENTS_DIR` from your environment or the repo-root `.env`, or pass the agents directory as the first argument.

## Extension-stored reply targets (manual, per agent)

Extensions that deliver on a schedule persist a reply target at creation time — email subscriptions (`ext/email/subscriptions.json`) and whatsapp watches (`ext/whatsapp/watches.json`). Under 0.2 that target could be captured in the transport-qualified compound form (`u:<id>@<issuer>/tg:<handle>`). The 0.3 conversation layer is transport-blind: `resolveConversation` accepts bare identities only, and the gateway recovers the transport at delivery.

The five scripts above don't touch extension-private stores (their formats are extension-owned), so an un-migrated compound target fails on every fire — and this failure is **silent to the user**: the delivery throws host-side (`Invalid participant address: "u:…/tg:…"` in the server log), the subscription simply stops producing notifications, and nothing tells the subscriber. Check for it explicitly:

```bash
grep -rl '"u:[^"]*/' $CAST_AGENTS_DIR/*/ext/*/*.json
```

For each hit, edit the `target` field down to the bare identity (everything before the `/`): `"u:abc123@d9c1e2/tg:12345"` → `"u:abc123@d9c1e2"`. Targets created on 0.3 are already bare — this only affects stores written under 0.2.

**Stop the server before editing.** These stores are owned by live extension state: the email subscription manager persists its in-memory subscriptions back to disk on watermark updates *and on shutdown*, so an edit made while the server runs is silently overwritten — by the next poll, or by the shutdown flush of the very restart you do to apply it. The order that sticks: stop the server, edit the file, start the server.

## If you run the web-fetch extension, reinstall its browser

This is not a database step, but it is part of the 0.2 → 0.3 upgrade. Upgrading floats the `playwright` dependency (web-fetch declares `^1.60.0`), and a newer playwright expects a newer chromium build than your machine has cached. After `pnpm install` or rebuilding the server bundle, run:

```bash
npx playwright install chromium
```

Skip it and the web-fetch service exits before ready with `Playwright chromium not installed`, which leaves the `web__fetch` tool unavailable to every agent (the rest of the server starts normally). Agents that do not use web-fetch are unaffected.

## Blueprint cleanup (manual, per agent)

The five scripts get the server running on 0.3. They are content-blind: they never open a blueprint, so they do not make your agents *correct* on 0.3. Nothing in this section is enforced by a parse error, which is exactly what makes it easy to skip. The scripts fail loud (denied access, unreadable approvals). The items here fail silent: dropped prompt content, a self-description that still explains a removed feature, a reject message naming a deleted command. They are ranked by how universally they apply.

If you run Claude Code on your Cast host, the `/cast-refine <agent>` skill automates the discovery below. It reads across an agent's blueprint, runtime state, and memory, then proposes the edits as a dated artifact. Run it per agent with the 0.2 to 0.3 changes as the lens. The checklist below is the same work by hand, and the reference for what the pass is looking for.

### 1. Delete peers.md, set descriptions instead (do this on every server)

0.3 stopped reading `blueprint/identity/peers.md`. Peer reach is computed from the ACL now, and each reachable peer surfaces automatically with its description and channel contract (prompt Layer 6, and the `agent__list_peers` tool). An agent still carrying a `peers.md` has that content silently dropped.

```bash
find "$CAST_AGENTS_DIR" -name peers.md
```

For each one: delete the file, then set the agent's one-line `description` in its `manifest.json` and each channel's `description` in its `channel.json`. Those descriptions power the discovery that replaced `peers.md` — and discovery replaces **addressing and protocol**, not just the peer list. Sort each line of the old file by what it was doing:

- **Addressing** (which peers exist, how to reach them): delete. The ACL computes reach; discovery renders it.
- **Payload shape / protocol** ("send this channel items shaped like…"): move into the *receiving channel's* `description`. That is the one place every sender discovers it. Rescued into a sender's prompt instead, the shape is invisible to every other sender and drifts from the channel's real contract as the channel evolves.
- **Stance / voice** (the sending agent's own posture when contacting peers): the only content that belongs in the sender's `prompt.md` or channel prompt.

Deleting without setting descriptions does not migrate the agent, it blanks it: the computed peer list has nothing to show. Verify with `agent__list_peers` (or the agent's Layer 6) listing the expected peers with their descriptions — and for channels that expect a payload shape, that the shape reads back in the channel's contract, not in some sender's prompt.

### 2. Fix reject_message strings that name /pair (most servers)

Pairing is gone, so an `acl.json` `reject_message` that references `/pair` now points at a deleted command. In 0.3 an unknown user is not bounced at all: their first message is held for the owner's approval. The string only fires on a hard reject, and is wrong when it does.

```bash
grep -rl reject_message "$CAST_AGENTS_DIR"/*/config/acl.json | xargs grep -il pair
```

Drop the field (the held-for-approval flow needs no bounce text) or rewrite it as plain text with no command reference.

### 3. Reword blueprint text that documents removed internals (conditional)

Any blueprint file (identity, skills, channel prompts) that explains Cast's access model using removed primitives, such as pairing codes, the `h` bit, or `paired-users.json`, is now stale. Reword it to the reactive owner-approval model and the current vocabulary (`i`/`o`/`a`/`q`/`r`, plus the framework-written push bit `p`).

```bash
grep -rilE 'paired-users|/pair|pairing|\bp/h\b' "$CAST_AGENTS_DIR"/*/blueprint
```

Applies only to agents whose blueprints describe Cast internals.

### 4. Check service code and schedule.txt (conditional, can break at runtime)

The scripts never open `blueprint/service/` or `schedule.txt`. A service that reads the retired `paired-users.json`, or a scheduled message telling users to send `/pair`, is stale. Unlike the items above, this one can fail at runtime rather than just read wrong, the moment the service or schedule fires.

```bash
grep -rilE 'paired-users|/pair|pairing' "$CAST_AGENTS_DIR"/*/blueprint/service "$CAST_AGENTS_DIR"/*/blueprint/schedule.txt 2>/dev/null
```

Rewrite to the 0.3 model. A service that read `paired-users.json` should read grants from `acl.json` instead.

### 5. Correct agent memory through the agent, never by hand (conditional, special handling)

An agent may have written the old model into its own `memory/`. Do not hand-edit it. Memory is the agent's own authorship, and editing it behind the agent's back desyncs the agent from its notes. Route the correction through the agent: brief it on the change as ordinary input and let its reflection cadence rewrite its own notes, or run a one-shot pass acting as that agent.

This is the one item that self-heals over time instead of needing a point fix. Urgency is higher for any agent that publishes externally: if its memory encodes a removed feature and it writes about Cast, that becomes externally visible wrong output. There is no find command for this one, it follows from which agents reason or publish about Cast itself.

### When is this pass done

There is no clean done signal the way the scripts have one. The scripted half is verifiable: every `acl.json` has `allowed`, no `paired-users.json` remains, the server starts. This pass is spot-checked: no `peers.md` remains, descriptions are set, no blueprint or service file references a removed primitive, and the agent describes access correctly when asked. Keep it scoped to what 0.3 removed. The migration is the trigger, not a license to redesign the agent.

## Restore points

- Step 1 copies each rewritten `acl.json` to `acl.json.pre-allowed-rename` beside the original. If a file carries both `peers` and `allowed`, `allowed` wins per peer key (matching the retired coalescing) and `peers` is dropped.
- Step 2 copies each modified `agent.db` to `agent.db.pre-approvals-columns` before rebuilding the table. A database already at the 0.3 shape is skipped; one with no `approvals` table is left untouched (the runtime creates it fresh, with all columns, on next open).
- Step 3 copies each rewritten `acl.json` to `acl.json.pre-paired-fold`, then renames `paired-users.json` to `paired-users.json.pre-acl-fold` (backing it up and removing it from the live path in one step). An agent with no `paired-users.json` is skipped.
- Step 4 copies each rewritten `acl.json` to `acl.json.pre-ph-fold` before dropping `h`. An agent whose grants carry no `h` is skipped (the common case).
- Step 5 copies each modified `agent.db` to `agent.db.pre-outbound-kind` before adding the `kind` column. A database already carrying the column is skipped; one with no `outbound_requests` table is left untouched (the runtime creates it fresh, with the column, on next open).
