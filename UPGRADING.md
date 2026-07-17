# Upgrading Cast

Cast releases are annotated git tags (`v0.2.0`, `v0.3.0`, `v0.3.1`, …). Each release that changes anything an existing install carries on disk ships a migration README at `scripts/migrations/<from>-to-<to>/` — including releases where the answer is "nothing to run," so the absence of steps is always a documented fact rather than a gap.

## Procedure

1. **Stop the server.**
2. **Check out the target release** (pull the tag, or unpack the release).
3. **Walk the migration READMEs in order** for every hop between your current version and the target — e.g. upgrading `0.2.0 → 0.3.1` means reading `scripts/migrations/0.2-to-0.3/README.md` and then `scripts/migrations/0.3-to-0.3.1/README.md`. Each README covers both halves of its hop:
   - the **mechanical half** — scripts to run, each idempotent and dry-run by default, applied with `--apply`;
   - the **manual half** — config or blueprint edits no script can make safely, and optional cleanups. A clean server start does not by itself mean this half is done.
4. **Rebuild what the release changed.** The hop README says which of these apply; when in doubt, all three are safe to redo:
   - server bundle (`pnpm bundle --outdir …`) for bundle deploys, or `pnpm install` for source installs;
   - web UI (`pnpm --filter @getcast/web-ui build`);
   - agent container image (`pnpm build:image`) — only when the release touched the runner.
5. **Restart and verify.** Each hop README ends with a short verify list for its changes; the server banner reports the running version.

## Ground rules

- **Never skip a hop's README.** Scripts assume the previous hop's shape; running a later migration against an earlier layout fails loudly at best.
- **Migrations run against stopped state.** Several stores (extension state, approval tables) are flushed by the running server; edits made while it runs can be silently overwritten.
- **Back up before major-version hops.** `agents/` and `config/` are the only stateful directories — a copy of both is a complete rollback point.

## Migration history

| Hop | Mechanical | Notes |
|---|---|---|
| [`0.1 → 0.2`](scripts/migrations/0.1-to-0.2/) | scripts | |
| [`0.2 → 0.3`](scripts/migrations/0.2-to-0.3/) | scripts + manual blueprint pass | access-model rework |
| [`0.3 → 0.3.1`](scripts/migrations/0.3-to-0.3.1/) | none | additive; optional re-bind of extension subscriptions |
