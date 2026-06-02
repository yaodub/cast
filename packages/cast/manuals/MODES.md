# Cast modes — console vs. advanced

Cast supports two authoring surfaces with different trust models. Knowing
which one a request belongs in is what determines what's safe and what's
not.

## Read this first if you're an AI agent

This manual is mounted at `/ref/manuals/` inside both console containers
*and* the host filesystem that Claude Code reads. The console manuals
under `/ref/manuals/console/*.md` describe what **console sessions** can
and can't do — those rules are console-local, not Cast-global. If you
are running in advanced mode (any of the `cast-*` skills:
`/cast-build`, `/cast-refine`, `/cast-debug`), **do not apply
console prohibitions to yourself**:

- "Inside this console, you can't write service code" — applies to
  console sessions; service-code authoring is exactly what advanced
  mode does.
- "No mutation of agent config from this surface" — applies to Design
  console; advanced mode edits config freely.
- "Out-of-envelope; redirect to Claude Code" — *you are Claude Code*;
  there is no further redirect.

The **extension manuals** at `/ref/manuals/extensions/<name>/` apply
to both modes. Their security surfaces, secret schemas, and known
limitations are real architectural facts about each extension —
respect them regardless of which mode you're in.

The distinction:

| Phrasing | Audience | Apply in advanced mode? |
|---|---|---|
| "Inside this console, X is out of scope" | Console-local | No |
| "Console agents don't write service code" | Console-local | No |
| "Cast agents have no inbound HTTP listener" | Cast architecture | Yes — true regardless of mode |
| "The bus rejects cross-agent infra push" | Cast architecture | Yes — that's the bus, not your envelope |
| "The `email` extension uses IMAP for inbound" | Extension architecture | Yes — extensions are mode-independent |

If a phrasing is ambiguous, prefer the architecture reading.

## Console isolation (server setting)

`consoleIsolation` in `server.json` gates inter-console push. In both
modes, each manager keeps its default reach to its category of agent
infra channel: **DM → any agent's `__design`**, **CM → any agent's
`__configure`**. Manager-to-per-agent handoff is always available.

What changes between modes is the **bridging** between the two
categories and between managers:

- **`normal`** (default) — opens three asymmetric bridges:
  - Same-agent `__design` → `__configure` (Design briefing its sibling
    Configure on the same agent).
  - DM → any agent's `__configure` (DM cross-category reach).
  - DM → CM (cross-manager).
- **`strict`** — none of those bridges. DM stays in `__design` lane;
  CM stays in `__configure` lane; the same-agent infra channels can't
  bridge directly (operator drives the handoff via tab-switch).

**Never opens in either mode:** Configure → Design (same agent), CM →
Design, CM → DM. These are the PII-exfil-carrier direction — Configure
holds state, Design has egress, so this bridge would carry secrets out.

Live — flips take effect on the next push without restart. Rejection
messages name the current mode.

## Console mode (default)

You are inside an in-Cast console — Design or Configure for one agent,
or Design Manager / Config Manager / Review (internally `security-manager`)
at server scope.

- **Vetted catalog.** Every extension that appears in your snapshot has
  a manual at `/ref/manuals/extensions/<name>/`. Tools, secrets schema,
  network needs, and security surface are named there. No surprises.
- **Bounded envelope.** Console sessions can't write `service/` code,
  can't widen the agent's network surface, can't see other agents'
  state, can't read secrets, can't reach off-allowlist hosts. Authoring
  happens against a sandboxed primitive set.
- **Auditable handoffs.** Tool calls land in the message log with
  rationale fields (`outcome_inference`, `handoff_brief`,
  `operator_takeaways`, etc.). What was decided and why is
  reconstructable.
- **Trust model: trust the catalog.** Bad output produces a bad
  blueprint — never a worse machine. The operator is paying for the
  envelope, not for the conversational fluency.

## Advanced mode

You are in Claude Code via one of the `cast-*` skills, running on the
operator's host. The three skills lane the work by activity:
`/cast-build` (authoring), `/cast-refine` (introspection-driven
refinement), `/cast-debug` (diagnosis). Each takes an optional
`<folder>` arg — present narrows scope to one agent, absent opens
server scope.

- **Full host access.** Read any file, write any file, install npm
  packages, hit any endpoint the operator's machine can reach.
- **Service code is in scope.** Anything in `service/`, agent-runner
  edits, gateway changes, custom extension authoring — all advanced-mode work.
- **Network surface is in scope.** When service code needs an endpoint
  the default `sdk-only` firewall blocks, the answer is to widen
  `containerNetwork` or `containerAllowedEndpoints` in the agent's
  config — knowing what the code does and why the egress is needed.
- **Trust model: trust yourself, line by line.** The operator reviews
  every diff; Claude Code's review-first ergonomics are the only
  safety property. Cast can't audit this layer — it lives outside the
  message log. The asymmetry to surface honestly when proposing this
  to a non-coding operator: *reviewing diffs you didn't write, in a
  language you don't work in, is closer to approving than reviewing*.
  Approving without catching is the failure mode the operator is
  taking on.

**Three activities, one envelope.** Advanced mode covers *authoring*
(`/cast-build` — the bullets above), *introspection* (`/cast-refine` —
the read-mode counterpart, where the operator and Claude Code together
examine an agent's runtime against its design and surface where it
could grow into more of itself; see
[`dev/agent-introspection.md`](dev/agent-introspection.md)), and
*diagnosis* (`/cast-debug` — reading gateway, agent state, runner log,
and session transcripts layer by layer to figure out what happened;
see [`dev/debugging.md`](dev/debugging.md)). All three share the same
trust model and read surface.

## Crossing over — when consoles route to advanced mode

Operators step into advanced mode when the console catalog can't reach
their goal. Common triggers: outbound HTTP POST to a third-party
service (Slack webhooks, Notion API), database clients, SSH, persistent
sockets, anything needing a non-Anthropic egress endpoint.

The handoff has three faces, all consequent to the same decision:

1. **Author** — write `service/` code in Claude Code via `/cast-build`
   (add `<folder>` to scope to one agent), supervised line-by-line by
   the operator.
2. **Widen** — flip `containerNetwork` to `full` in the agent's
   `config/agent.json`, or add specific entries to
   `containerAllowedEndpoints` under `sdk-only`. Done from per-agent
   Configure or from Config Manager.
3. **Enter credentials** — the values the new service code reads.
   Done from per-agent Configure, in the relevant ext or service env.

The console agent's job at the crossover is to **name the mode-shift
clearly** and hand off cleanly. It is not to silently improvise across
the line, nor to pretend the line isn't there.
