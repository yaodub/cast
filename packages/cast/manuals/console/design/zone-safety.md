# Degrees of zone safety — air gap to anonymizer

*This recipe is meta-architectural. The other recipes show concrete
per-channel context-flow specs — paths, channel names, trigger
verbs end-to-end. This one shows the structural primitives that
bound where context can flow at all (across zones), and the tiers
of cross-zone safety those primitives can compose. Treat the
"shape" sections of other recipes as your spec exemplars; treat
this one as the architecture the spec sits inside.*

**Use case.** You're separating a Cast server into a net-exposed
zone (agents with internet) and a private zone (agents holding PII
or internal context). The honest question isn't *"how do I prevent
all leakage?"* — once any cross-zone channel exists, the request
body itself is a leak vector — but *"how much do I allow to flow,
and which parts of that flow are structurally enforced versus
operationally disciplined?"*

**The fundamental observation.** Cast's structural primitives —
`network: sdk-only`, ACL bits, mount mode — give you **directional
control**. These are honest enforcement: an sdk-only agent
literally cannot HTTP out; an RO mount cannot be written to; a
channel without an ACL grant cannot be reached. Beyond directional
control, every "safety pattern" (broker vocabularies, parameter
shaping, etc.) is operational discipline — useful, but
prompt-level, and the LLM can be wrong or compromised. Pick your
tier deliberately and don't pretend operational discipline is
structural.

## The tiers

**Tier 1 — Full air gap.** No cross-zone channel exists. Outer has
internet; inner has PII; they don't talk to each other at all. The
human (operator/user) is the only shared address — each zone is
reachable only by the human directly. *Enforcement:* structural —
no edge to leak through. *Tradeoff:* nothing automated crosses;
the human's manual juggling is the integration. *This is what
Cast's own Design and Configure consoles do for themselves —
they're separate surfaces the operator switches between.*

**Tier 2 — Inbound only, human as messenger pigeon.** Outer can
push events inward (daily news scraping, periodic API polls
ferried into inner); inner cannot push or query outward at all.
The clever part: when the operator wants to *tweak* the outer's
behavior, they talk to the outer *directly* in their own chat —
the human is already paired to both zones, so they're a working
cross-zone communication channel without any structural edge
between the agents. The outer takes operator instruction (*"start
also pulling from this source"*) and continues its inbound-flow
job. *Enforcement:* structural — inner has no outbound bits, no
RW mount that outer can read. *Tradeoff:* automated outbound from
inner doesn't exist; everything outbound goes through the human
acting as the bridge.

**Tier 3 — Outbound with human approval gate.** Inner can request
outbound, but each request first surfaces to the human as a
proposal. Human approves; outer acts. *Enforcement:* directional
structural + human is the gate. *Tradeoff:* slow; doesn't scale to
high-frequency actions. But it's the only "real" inner-initiated
outbound that doesn't collapse into operational discipline — the
human's approval is a structural gate (no approval, no action),
not a vocabulary check.

**Tier 4 — Anonymized intermediary.** Inner→outer goes through a
third agent (the *anonymizer*) that strips originator information.
Outer sees only the anonymizer; it doesn't know which inner agent
— or even *that* it's an inner agent — is asking. *Different
security property:* this doesn't reduce *exfiltration bandwidth*
(the request body still flows through), but it does close
**targeted-attack vectors** — an outer compromised by adversarial
input can't direct a response at a specific inner agent because
it doesn't know who's on the other end. *How do you attack who you
don't know.* *Tradeoff:* more topology; the anonymizer becomes a
critical trust boundary; prompt-injection through anonymized
responses can still attack inner indirectly.

**Tier 5 — Free outbound.** No structural separation. Not really
a tier of safety — it's the absence of zone safety. Acceptable
only when inner's data isn't actually sensitive.

## Picking per channel, not per server

Real systems mix tiers. The same inner agent can be Tier 1 for
sensitive operations (no cross-zone edge at all), Tier 2 for
routine inbound (outer ferries facts in, human tweaks outer
directly), Tier 3 for occasional high-stakes outbound (operator
approves one-offs). The structural primitives are scoped per
channel × per identity, so tiering follows that grain — one
agent's blueprint can host multiple tiers across its channels.

## Where this doesn't help

- *Operator compromise.* The human is the trust root in every
  tier above 1. If they're tricked, the tiers fall.
- *LLM behavior at the gate.* Tier 2's human-as-messenger pattern
  depends on outer not autonomously deciding to fetch
  `attacker.com` on the operator's behalf — which, as an LLM,
  outer can be tricked into. Tiers reduce risk; they don't
  eliminate it.
- *Bandwidth of any allowed channel.* Even Tier 4's anonymizer
  pattern doesn't reduce the leak bandwidth of a single request
  — it reduces *who* can target the leak, not *how much* can
  flow through it.

**Composes.** `network` mode (`sdk-only` vs `full` is the strongest
structural gate), ACL bits per channel × per identity, mount mode
(RO/RW per directory), channel-scoped `disabled_tools` (narrows the
cross-zone surface), source attribution branching for inner
channels that receive outer pushes.

**Cross-link.** The Tier 4 anonymizer pattern is structurally close
to [Specialist agent behind a query-only door](recipes/specialist-behind-query.md)
in reverse — instead of one specialist many callers, one
anonymizer many inner clients. Compose the two when the inner
zone needs both isolation *and* targeted-attack resistance.
