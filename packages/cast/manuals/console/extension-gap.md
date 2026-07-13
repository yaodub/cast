# When the tool set doesn't fit

Read this when the operator is asking for something the extensions
registered on this server don't cover, or cover only partially. Before
committing to a workaround, work through the decision tree below — and
check what each extension can actually do.

## What the standard extensions actually do

Extensions are tools the agent uses to act on external services —
not how anyone reaches the agent (that's transports, a separate
concept; see `console/overview.md` § *Extensions vs. transports*).
Before you improvise, be concrete about the primitive each one
exposes:

- **`web-fetch`** — GET-only page fetcher (Playwright renders JS,
  cleaning pipelines produce markdown). The single tool is `web__fetch`,
  which takes a URL and writes the rendered result to `/staging/in/`.
  **It cannot POST, PUT, or call APIs with custom headers.** It reads
  pages; it doesn't push.
- **`email`** — IMAP in, SMTP out. Two-way: the agent receives email
  addressed to a user it serves and can send email in reply. Good for
  notifications and human-in-the-loop approvals.
- **Built-in `WebSearch`** — query the web, get result snippets. Not a
  page fetcher; pair with `web-fetch` when you need full content.

Any primitive not on this list (arbitrary HTTP POST, Slack webhooks,
database clients, SSH, OAuth flows, persistent sockets) is **not
available** through extensions and belongs in Shape 2 below.

## Why this matters

The operator trusts the output system to do what you said it would. If
you commit to a workaround without naming its fragility, week-2
failures look like Cast broke — not like the integration was always
brittle. Gaps in the tool set are real; pretending they aren't is the
specific failure mode this manual is written to prevent.

Three failure patterns to avoid:

- **Capability invention.** DM proposes "web-fetch POSTing to a Slack
  webhook" — a primitive the extension does not expose. The blueprint
  materializes, but at first run the tool isn't there. Always map the
  ask to a primitive that actually exists.
- **Silent improvisation.** DM reaches for a workaround without
  flagging that it *is* one. Operator discovers in week 2 that the
  scheme depends on a token that rotates and has no place to be
  re-entered.
- **Over-eager redirect.** Operator has a read-only fetch need that
  `web__fetch` covers directly. DM sends them to Claude Code for a
  service they didn't need to write.
- **Decline without alternatives.** Operator leaves empty-handed when
  their underlying goal had a different-shape solution the existing
  extensions could cover.

## Three response shapes

Every gap-ask lands in one of three buckets. Pick consciously, name
the choice, let the operator confirm.

### Shape 1 — Improvise with existing extensions

A workaround composed from primitives that actually exist: `web__fetch`
reading a page, `WebSearch` finding URLs, email carrying a notification
or standing in for a missing outbound channel.

**Good fit when:**
- The ask is read-only — pull data from a public page, feed it to the
  agent for summarization or alerting.
- Email can stand in for the notification surface (alert-to-self,
  digest-to-team, human approval-by-reply).
- The extension capabilities match the shape of the ask — no POST, no
  custom protocols, no persistent connections required.
- The operator knows it's a workaround and accepts the tradeoff.

**Poor fit when:**
- The ask needs to **push** to an external service (Slack webhook, REST
  POST, Notion API write). `web__fetch` does not POST — this is
  Shape 2, not Shape 1.
- Stateful protocols (WebSocket, IMAP IDLE, MQTT).
- OAuth refresh flows, short-lived tokens.
- Two-way conversations with an external service.

**How to propose:**

> *"There's no <thing> extension here. The read side — pulling
> <thing>'s public pages for the agent to summarize — fits `web__fetch`
> cleanly. The notification side goes to your email instead of
> <thing>; that keeps the loop closed with what's registered. If you
> need the agent to push *into* <thing>, that's Claude Code territory
> — see Shape 2."*

Name the shape of the workaround up front. An operator who picks
email-as-notification with eyes open is different from one who
discovers in week 2 that the Slack integration they thought existed
never could.

### Shape 2 — Advanced mode (code + network + credentials)

For asks the console catalog can't reach: outbound HTTP POST, custom
protocols, persistent connections, anything requiring an endpoint the
default `sdk-only` firewall doesn't allow. The honest framing isn't
"redirect" — it's *"open the supervised coding loop."* The operator
steps from the bounded console envelope into Claude Code, where they
review every diff. See `/ref/manuals/MODES.md` for the trust model.

**Indicators:**
- Outbound HTTP POST (Slack webhooks, Notion API writes, arbitrary
  REST calls, GitHub API with auth). `web__fetch` is GET-only.
- Database clients (Postgres, MySQL, MongoDB, Redis).
- SSH, SFTP, SCP.
- Message queues (RabbitMQ, NATS, MQTT).
- SMS (Twilio), phone calls, fax.
- Anything requiring a long-lived daemon with state.
- Anything where the service needs to receive unsolicited inbound
  traffic (webhook server, TCP listener, websocket server).
- Anything that needs to talk to a non-Anthropic host. The default
  `sdk-only` firewall blocks third-party API hosts; widening egress
  is part of advanced mode, not a Configure-side standalone choice.

**Three faces, in operator-execution order:**

1. **Author** the service code in Claude Code via `/cast-build` (add
   `<folder>` to scope to one agent). The operator reviews each
   change.
2. **Widen** the agent's network surface — flip `containerNetwork` to
   `full` in `config/agent.json`, or add specific entries to
   `containerAllowedEndpoints` under `sdk-only`. Done from per-agent
   Configure once the operator knows what host the service code needs.
3. **Enter credentials** the new service code reads —
   `config/ext/<name>/secrets.json` or service-specific env. Per-agent
   Configure again.

**How to propose:**

> *"This is advanced-mode territory: the code goes in `service/` via
> `/cast-build` in Claude Code (you'll review each diff), the
> network egress to `<host>` flips on in Configure
> (`containerNetwork` or `containerAllowedEndpoints`), and the
> credentials enter in Configure too. I can sketch the channel shape
> and what triggers what — schedule, peer wiring, what lands in
> `/memory/` — and you handle the code and the network knob. Want
> the sketch?"*

Don't just send them away. The scaffolding you can do — channel
topology, memory layout, schedule wiring — is valuable and survives
the mode-shift. Partial-scope offers ("I handle the alerting side;
you handle the Postgres side via advanced mode") often land better
than a full redirect.

**Trade to name:** advanced mode means the operator is reviewing
code; Cast can't promise the same survive-the-week durability as a
catalog wiring without their eyes on the diff. That's the explicit
trust they're picking up.

### Shape 3 — Decline + propose an alternative shape

Sometimes the operator's surface ask has an alternative shape that
*does* fit the tool set, and the underlying goal is the same. Check
before improvising.

**When this applies:**
- Operator wants Slack alerts for a 1-person project. Email-to-self
  is the same UX without the webhook fragility.
- Operator wants to "auto-post to our Notion page." Notion's API
  needs OAuth refresh. The underlying "weekly team update visible to
  everyone" could be an email digest the team subscribes to instead.
- Operator wants to "sync Linear tickets." The goal is "give the
  agent awareness of current tickets" — could be a manual paste into
  a Configure field, or a periodic email export.

**How to propose:**

> *"Slack isn't in our extension set, and there's no way to POST to
> its webhook from the tools we have. For a team of one,
> email-to-yourself is the same user experience and fits the existing
> extensions cleanly. Want to go that route?"*

The alternative should preserve the underlying goal, not just be a
different mechanism.

## Decision tree

Work through in order. Stop at the first yes:

1. **Does the ask require outbound HTTP POST, a persistent connection,
   a custom protocol library, or inbound traffic reception?**
   → Shape 2 (Claude Code). `web__fetch` reads pages; it does not push.

2. **Is the ask a read-only pull — fetching a public page, scraping
   content the agent will summarize or alert on?**
   → Shape 1 (improvise with `web__fetch`), with rate-limit caveats
   named.

3. **Does the underlying goal have an alternative shape the existing
   extensions can support — usually email standing in for a missing
   outbound channel?**
   → Shape 3 (propose alternative).

4. **None of the above?**
   → Decline, point at Claude Code as a catch-all, be honest that you
   don't have a shape for this. Better an honest "I don't have a
   shape for this" than a brittle improvisation.

## The "name the gap" pattern

Before any of the three shapes, one explicit move: name the gap.

> *"There's no <thing> extension here."*

Six words. Then propose the response shape. The operator needs to know
a choice is being made on their behalf before they evaluate the
proposal. Skipping this step — silently improvising — is the specific
failure pattern the simulation runs surfaced.

## Examples

**Operator wants Slack alerts.**
Check first whether their workspace has Slack's *Email* app enabled
— it gives every channel a per-channel email address. If yes, the
agent can SMTP-send straight into the channel via the standard
`email` extension. That's a Shape 1 path with no webhook, no token
rotation, and no Shape 2 escalation; it's the right default when
available. If the workspace doesn't have it, outbound POST to
Slack's incoming webhook — `web__fetch` doesn't cover this, and the
default `sdk-only` firewall blocks `hooks.slack.com` anyway. Fall
back to Shape 3 (email-to-self) for solo ops, or Shape 2 (advanced
mode) when Slack-native delivery is non-negotiable.

**Operator wants to monitor an internal Postgres database.**
Needs persistent connection + protocol library: Shape 2. Offer to
sketch the alerting side ("I'll handle the schedule + notifications;
you handle the connection + query logic in service code").

**Operator wants to sync with Notion.**
OAuth + rate-limited write API: Shape 2 for robust integration, or
Shape 3 if the underlying goal ("team sees digest weekly") fits a
lighter-weight email-based form.

**Operator wants their agent to listen for inbound webhooks.**
Requires an HTTP listener on the agent side. Cast doesn't support
inbound HTTP on agents: Shape 2 (Claude Code + service code).

**Operator wants SMS alerts.**
Needs Twilio (or similar) + credentials + a sending client: Shape 2.
Alternative: email, which many phones forward as SMS or push
notifications anyway.

**Operator wants to read public GitHub repo issues.**
`web__fetch` against the public HTML page (`github.com/<org>/<repo>/issues`)
works cleanly — Shape 1. The agent gets rendered issues as markdown.

**Operator wants to read private GitHub repo issues or write via the
API.**
GitHub's API needs auth headers, which `web__fetch` doesn't send. And
anything write-side (opening/commenting on issues) is outbound POST.
Shape 2 (Claude Code + `@octokit/rest`).

## When you're unsure which shape applies

Ask. One question — *"Before I wire this, I want to check: how
frequently is this likely to run, and would you be OK manually
updating a token if it rotates?"* — is enough to disambiguate Shape 1
vs. Shape 2 for most borderline cases. The decision tree is a heuristic;
the operator's tolerance for fragility is the real deciding factor.
