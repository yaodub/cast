# Specialist agent behind a query-only door

**Use case.** Your private agent has your email and calendar. Your
public agent — the one strangers message — has neither. The public
agent asks the private one for filtered answers and relays them
back. The container is the wall.

Also applies whenever some capability is sensitive — an external API
costs money, a database holds private data, a tool requires elevated
permissions. You don't want every agent that needs an answer to hold
those credentials. You want one agent that has them, accessible by
question-and-answer only.

**The shape.** A peer agent with the sensitive access, configured
with a single channel named `ask`. Single-shot (`idle_timeout: null`)
so each query is a fresh session — no state bleed between calls.
The channel's `disabled_tools` blocks everything outbound or
initiative-driven: no `task__*`, no `conversation__push_to_channel`,
no extension write tools, and `file__append_feed` (a feed write is a
side-channel output) — the channel's only output is its
`<cast:answer>`. (The watch tools aren't registered on single-shot
channels at all, so the only `file__*` surface to gate is
`file__append_feed`.) Set `show_co_participants: false` so callers stay
invisible to each other: with many callers each granted `q`, the
flag stops one caller's existence and activity from surfacing in
another's session, closing the `<other-participants>` prompt layer
and the channel's member rows in `agent__list_participants` (callers'
summary reads are already scoped to their own conversations).
The flag also closes cross-conversation push between co-members,
not visibility alone, so the isolation is structural (see
`primitives.md` § Co-participant visibility). Disabling
`list_summaries` via `disabled_tools` alone closes only the tool, not
the prompt layer; the flag is the complete control. The specialist
may still record per-query audit notes to
`/memory/queries/<date>-<request-id>.md` using the SDK `Write`
tool, creating one file per query — private to the specialist's
container, never visible to callers.

ACL is wired in two places: each caller's own `acl.json` grants
`q` toward the specialist on the `ask` channel (sender-side
outbound), and the specialist's `acl.json` grants `a` toward each
caller on the same channel (receiver-side inbound). Callers emit
`<cast:query target="<specialist>" channel="ask">`; the specialist
responds with `<cast:answer request="...">`.

**What this enables.** Isolation by structure. The specialist's
session never holds the caller's history; the caller never holds
the specialist's state or credentials. Each query is a fresh
session — no leakage between calls. Replacing or upgrading the
specialist doesn't touch caller blueprints — they speak to the
channel name, not to the implementation. If the specialist is
compromised, the blast radius is bounded by what its `disabled_tools`
allows it to do.

**Where it doesn't fit.** Workflows requiring multi-turn negotiation
between caller and specialist (use a regular peer-to-peer
conversation channel instead). Cases where the caller does need the
specialist's history (consider giving the caller direct access
instead — the recipe's value is the isolation, and removing it
simplifies the topology). Real-time data the caller polls
constantly — query/answer makes a session per call, which has
overhead; an event-stream shape (log + watch) fits better.

**Variants.** Multiple callers (each granted `q` independently) vs
single caller. Multiple specialists (one per resource, each with
their own channel and grants). Cached layer in front: callers query
a cache agent first, which falls through to the specialist on miss
— same shape, two layers.

*Public front-door variant.* The "caller" is your own multi-user
public-facing agent rather than another internal agent. The public
agent has no credentials, lives in the net-exposed zone, and serves
strangers (Telegram bot, web URL); the specialist holds your real
data and credentials, accessible only via the public agent's `q`
grant. The public agent is *persona + filtering*; the specialist is
the actual intelligence. The specialist's prompt enforces what
shape of answer is permitted to leave: *"answer availability,
never raw content."* If the public agent is jailbroken via prompt
injection, blast radius is bounded by what the Q&A door allows —
the credentials live in a different container, behind a structural
wall. Composes with [Degrees of zone safety](../zone-safety.md):
the front-door is your "outer" zone, the specialist is your
"inner" zone, and the Q&A door is the only edge between them.

*Subtraction-only role (auditor / observer).* Push the
`disabled_tools` discipline further: block *all* outbound action
across every channel — no `push_to_channel`, no
`push_to_participant`, no `task__schedule`, no
`file__append_feed`, no extension write tools. Pair with RO mounts
of multiple peer agents' surfaces. The agent's tool surface is
genuinely just *read* — file reads, recall verbs, read-only
extensions. Useful for review, security, compliance, health-check
roles where the structural inability to act *is* the feature:
operators can grant broad observation rights without the risk that
broad access also means broad blast radius. The worst this agent
can do is observe and report (via its own user channel back to the
operator), by design. Each tool re-enabled is an explicit
exception you have to argue for.

**Composes.** Single-shot channel, `disabled_tools`, ACL `q`/`a`
bits, `<cast:query>` / `<cast:answer>`, `peers.md` declaration on
caller side.
