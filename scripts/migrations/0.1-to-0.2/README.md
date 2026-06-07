# Migrating from 0.1.x to 0.2

Cast 0.2 changes how persisted state is keyed, how pairing grants confer channel membership, and how undelivered outbound packets are tracked. If you ran 0.1.x and paired users or accumulated conversations, run these scripts once before starting the 0.2 server. A fresh install skips this folder entirely.

## What changed

1. **Bare participant addresses.** Persisted addresses drop their transport grain: `u:guid@iss/tg:123` becomes `u:guid@iss`, and operator addresses drop the `local/` prefix. The `local` identity retires, and `owner: "local"` in `acl.json` becomes the inert label `"operator"`.
2. **Per-channel membership.** A wildcard pairing grant (`{"*": "io"}`) still authorizes conversation, but no longer places the user in any channel. Co-participant visibility and cross-conversation push read concrete placement only.
3. **Outbound delivery verdicts.** Failed outbound sends now retry in-process and expire past a TTL into a terminal failed state, recorded in a new `failed_at` column on `gateway.db`'s `packets` table. 0.1.x databases need the column added; without it the 0.2 server's pending-packet queries fail on startup.

## Procedure

Stop the server first. All scripts are idempotent and print a dry-run plan by default. Nothing mutates until you pass `--apply`.

```bash
# 1. Re-grain persisted addresses (state files, agent.db, gateway.db, session dirs)
pnpm exec tsx scripts/migrations/0.1-to-0.2/1-bare-addresses.ts          # dry run
pnpm exec tsx scripts/migrations/0.1-to-0.2/1-bare-addresses.ts --apply --backup

# 2. Replace wildcard pairing grants with per-channel placement
pnpm exec tsx scripts/migrations/0.1-to-0.2/2-narrow-pairing-grants.ts ~/.cast/agents          # dry run
pnpm exec tsx scripts/migrations/0.1-to-0.2/2-narrow-pairing-grants.ts ~/.cast/agents --apply

# 3. Add the failed_at delivery-verdict column to gateway.db
pnpm exec tsx scripts/migrations/0.1-to-0.2/3-packets-failed-at.ts          # dry run
pnpm exec tsx scripts/migrations/0.1-to-0.2/3-packets-failed-at.ts --apply
```

Restart the server when all report done.

The scripts locate your data the way the server does. Run them from the repo root and they read `CAST_AGENTS_DIR` and `CAST_CONFIG_DIR` from your environment or the repo-root `.env`. Pass `--agents-dir` and `--config-dir` (step 1), the agents path (step 2), or the config path (step 3) to point somewhere else.

## Restore points

- Step 1 with `--backup` snapshots your agents and config directories to `cast-migration-backup-<timestamp>` next to the config directory.
- Step 2 copies each rewritten `paired-users.json` to `paired-users.json.pre-narrow-grants` beside the original. That is the only file it touches.
- Step 3 is additive — one nullable column and an index rebuild, no rows modified — so it has no backup step.

## How step 2 decides placement

Each user with a wildcard grant gets `io` on exactly the channels where they have `message_log` activity, with `default` always included as a floor. Active users keep every channel they actually used. The script lists any user granted more than `default` so you can prune by hand if a grant looks stale.
