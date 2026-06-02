# Contributing to Cast

Thanks for considering a contribution. Cast's biggest leverage point is **extensions** — every new capability (Slack, GitHub, Notion, etc.) makes the whole framework more useful. But blueprints, transports, services, and core fixes are all welcome.

## Development setup

```bash
git clone https://github.com/yaodub/cast
cd cast
pnpm dev
```

That's the full setup. First run installs dependencies and builds the agent container image (~2 min). The web UI opens at `http://localhost:3000` with demo agents loaded.

Requirements:
- Node.js 20+
- pnpm
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com)

## What to work on

The harness, extensions, transports, and blueprints are stable. The in-Cast console agents (Design, Configure, Review, Guide) are an early preview and still being sharpened, so that surface churns more — coordinate on an issue before a large change there.

- **Open issues** — see the [issue tracker](https://github.com/yaodub/cast/issues)
- **Extensions** — the most natural and highest-leverage contribution. See [extension authoring guide](packages/extension-schema/AUTHORING.md)
- **Demo agents** — fix or improve agents in `mnt/agents/` and PR
- **Documentation** — manuals under `packages/cast/manuals/` and per-package READMEs
- **Bug fixes** — anything that doesn't work as documented
- **Console agents** (preview) — behavior in `packages/cast/src/console/`, manuals in `packages/cast/manuals/console/`

## Reporting bugs

A good Cast bug report doesn't just describe a symptom — it *proves* the bug by tracing its mechanism through the code, and Cast ships the tooling to produce one. From a host-side Claude Code session on the repo, run `/cast-debug` (optionally `/cast-debug <agent-folder>`). It reads the pipeline layer by layer — gateway DB, agent message log, host logs, agent-runner log, session transcripts — and once the root cause is a defect in Cast itself (not an agent's blueprint, not a misconfiguration), ask it to produce a bug report.

The report is a standardized, **redacted** artifact built for submission. It captures:

- **The mechanism** — a witnessed causal trace through the code and state, ending in the contract it violates, so a reader agrees it's a bug without running anything. This is the heart of the report; a symptom without a mechanism is an open lead, not a filed bug.
- **Evidence as re-queryable coordinates** — the gateway / agent.db rows, log lines, and transcript turns that witness each step, sanitized.
- **Environment** — Cast version + commit, Node/pnpm, OS/arch, resolved container runtime + version, and MCP transport mode (socket vs TCP). The skill gathers this for you.
- **Reproduction** only as far as the mechanism leaves steps unwitnessed — often unnecessary; when useful, via the headless admin-chat dogfood path so a maintainer can replay it.

Redaction matters: the report leaves your machine. It never includes `.env` secrets, transport credentials, or OAuth tokens, and it sanitizes private message bodies and paired-user PII while keeping the diagnostic shape (markers, tool names, error strings, counts, ids). The format and the redaction rules live in [packages/cast/manuals/dev/debugging.md](packages/cast/manuals/dev/debugging.md) § "Filing a Cast bug report".

Paste the report into a new [issue](https://github.com/yaodub/cast/issues). No Claude Code? File the issue by hand with the same sections — the headings above are the checklist.

## Code style

Strict TypeScript. Key rules:

- `import type` for type-only imports; type-only deps go in `devDependencies`
- No `any` unless escaping a third-party library boundary
- Prefer `function` declarations for exported functions, `const` for closures
- Validate at system boundaries (user input, external APIs); trust internal code
- No defensive programming for impossible states
- Comments only when *why* is non-obvious; never explain *what*

Run `pnpm format` before committing — Prettier handles formatting.

## Testing

- `pnpm typecheck` — type check (always before pushing a PR)
- `pnpm test` — unit tests via vitest

## Pull request process

1. Fork the repo, create a topic branch
2. Make your change with a focused commit history (one concept per commit)
3. Run `pnpm typecheck` and `pnpm test`
4. Open a PR with a clear description of what changed and why
5. We'll review within a week. If you don't hear back, ping the PR.

## Code of Conduct

Cast follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be excellent to each other.

## Architecture orientation

For new contributors finding their feet:

- [README.md](README.md) — what Cast is, how to run it
- [CLAUDE.md](CLAUDE.md) — root atlas pointing to the right docs by intent
- [packages/cast/manuals/dev/agent-architecture.md](packages/cast/manuals/dev/agent-architecture.md) — how agents work internally
- [packages/agent-schema/src/v1/SPEC.md](packages/agent-schema/src/v1/SPEC.md) — canonical agent folder spec

## Process boundaries

The codebase has two independent layers running as separate processes. **Don't import across these boundaries:**

- `packages/cast/` — the host server
- `packages/agent-runner/` — the in-container agent process

Duplicated utilities across boundaries (e.g. `escapeXml`, ID generation) are acceptable. Coupling is worse.
