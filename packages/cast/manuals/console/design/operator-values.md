# Design — collecting operator-specific values

Read this only if you're about to write a blueprint file that needs a
value only the operator can supply — a recipient address, a channel
name, a URL, a domain — and you don't have it. Operator PII routes to
Configure, never chat (kernel invariant — overview.md § Invariants);
this manual is the decision tree for where each value belongs.

## The temptation to placeholder

A natural move when composing a prompt is:

```markdown
## CONFIGURATION

ALERT_RECIPIENT: operator@example.com  <!-- operator, replace this -->
```

Don't do this. The operator just watched you build a blueprint and
handed off to Configure for credentials. Now you're asking them to open
`blueprint/identity/prompt.md` and hand-edit a line. That contradicts
the "you can't break anything from the Design chat" story and turns the
blueprint into a surface they have to edit manually — which is
approximately the thing Cast exists to avoid.

Two better options, in order of preference.

## Option A — ask the operator directly (non-PII values only)

**Check the kernel invariant first.** Operator PII — recipient
addresses, account handles, phone numbers, names — never enters through
chat. If the value identifies a person, skip to Option B; it goes to
Configure. A recipient address is PII, so it is *not* an Option-A value.

For a non-PII value that's small and needed to finish the blueprint,
pause composing and ask the operator directly in this chat:

> *"Before I finish the prompt: which day should the digest run —
> Monday, or later in the week?"*

Design is a conversation with the operator. Ask the targeted question,
get the answer, and continue composing with the real value baked in.

**When to use this:** the value is a single non-PII field, you're
mid-compose, and the blueprint reads naturally with it hardcoded. A
preferred schedule day, a public search term, a non-personal domain —
these fit.

## Option B — route to Configure

If the value is operator PII (a recipient address, handle, phone,
name), sensitive (secret, token, password), structured (a JSON blob, a
list of domains), or expected to change over the agent's life, it
belongs in Configure, not in the blueprint:

- Write the blueprint assuming the value is read from an environment
  variable or config field.
- Hand the request off to Configure via `conversation__push_to_channel({
  channel: "__configure", … })` — Configure can navigate the operator
  to the right form and walk them through it. At the end of your
  summary, name the next step in plain language:

> *"To finish: open this agent's Configure pill — Configure will walk
> you through entering `ALERT_RECIPIENT` under the email extension's
> settings. (You can also reach the form directly under the agent's
> Extensions tab.)"*

Cast's config system already separates these — a prompt that bakes in
`alice@example.com` is a prompt that needs editing every time the
operator rotates email addresses. Configure handles that.

**When to use this:**

- The value is operator PII — a recipient address, handle, phone, or
  name (always Configure; kernel invariant).
- The value is a credential or secret (always Configure).
- The value is tied to an extension that has a config field for it
  (check the extension's README under `/ref/manuals/extensions/<name>/`
  for the field schema).
- The operator is likely to change it over time.
- The value is structured or has a known schema.

**Host paths are a sub-shape of Option B.** When the value is a
directory on the operator's machine the agent should read or watch
(notes folder, repo, externally-written log), don't bake it into the
prompt — declare a resource slot in `blueprint/props/capabilities.json::resources`
here, then hand the binding ask to Configure with the slot name.
Cast bind-mounts the path at `/resources/<slot>`; the prompt
references that path, never the host path. See
`console/design/primitives.md` § "The mount table".

## When neither option works

If you genuinely can't get the value (operator didn't reply, Configure
doesn't have a field for it, the value is blueprint-intrinsic) — only
then placeholder, with a clear marker:

```markdown
<!-- TODO(operator): replace with recipient email before first run -->
ALERT_RECIPIENT: TODO_OPERATOR
```

And mention it at the top of your completion summary as a blocker:

> *"One open item: I couldn't fit `ALERT_RECIPIENT` into Configure
> because the email extension doesn't expose a recipient field. You'll
> need to edit `blueprint/identity/prompt.md` line 12 before the first
> run."*

A blocker surfaced loudly is much better than a placeholder the
operator discovers on day 3 when alerts don't fire.

## The decision tree, compressed

1. Is the value a secret, credential, or operator PII (recipient
   address, handle, phone, name)? → Configure. PII never enters chat.
2. Does the relevant extension have a config field for it, or is it a
   host path the agent should read? → Configure (resource slot for the
   path case — declare here, bind there).
3. Is it a single short *non-PII* value the operator answers in one
   line? → Ask them in chat, bake the real value into the blueprint.
4. None of the above? → TODO placeholder + surface as a blocker.

Never pick option 4 silently.

## Field authority — locked vs unlocked

Routing a value to Configure (Option B) is half the decision. The other
half is whether the operator gets to override your value, or whether
your value stands as the contract.

Two roles meet on this surface — the **author** (writes the blueprint,
owns the locked spine) and the **operator** (supplies install values in
Configure, overrides where unlocked). A third never appears here: the
**runtime user**, who shows up only at runtime, through their own first
contact, and is unknowable at design or config time. No field configures them and no
value names them — a recipient address or user list written into a
blueprint is the *agent-with-no-users* mistake
(`/ref/manuals/console/design/anti-patterns.md`).

Specific fields in `blueprint/props/capabilities.json` are
**locked-by-default**; wrapping the value as
`{ unlocked: true, value: <default> }` opts the operator in to override:

```jsonc
"additional_disabled_tools": ["Bash"]                                 // locked
"additional_disabled_tools": { "unlocked": true, "value": ["Bash"] }  // unlocked (safe default; operator may open)
```

The pattern applies to `additional_disabled_tools`, `pip.extra_packages`,
MCP-server env slots, and **the top-level keys of an `extensions.<name>`
block** — the wrapper is honored only at the top level. Nesting it on a
leaf (e.g. `outbound.recipients`) is unsupported and breaks at runtime; to
make a field inside a section overridable, unlock the **whole section**,
which exposes every field in it together. Per-leaf unlock is not a feature
today. Operator writes against a locked field are rejected by the admin UI
and by Configure — no override path short of a blueprint edit here.

**The default: lean unlock, lock the spine.** Unlocking is what makes a
blueprint portable — a downstream operator adapts it to their install
without editing it. So for any field outside the agent's **spine**, lean
toward unlocking *with a sane default*: an adaptable agent at near-zero
cost, since the default makes unlocking an option, not an obligation.

The spine stays locked by conviction — identity, safety, correctness, a
dependency the code needs, an isolation boundary. The test: *if the
operator set this badly, would the agent stop being itself, become unsafe,
or break — or just serve that operator less well?* First three → lock;
last → unlock. Locking is what *enforces* the spine: an unlocked safety
value isn't a guarantee, it's a default any operator can silently undo.

**Unlock to a safe default — assume it's never overridden.** An unlocked
field still ships a value, and many operators never touch it, so the
default *is* the value for them. Make it the secure, closed position; the
unlock is permission to *open* it, not license to ship it open.
(`additional_disabled_tools` defaults to the risky tools *disabled*, not
`[]`; an allowlist defaults to empty, not `*`.)

**Lock examples.**
- A customer-support agent locks `additional_disabled_tools: ["Bash"]`.
  The safety story is "this agent can never run shell"; unlocked,
  any operator could silently re-enable it.
- A research-summarizer locks `pip.extra_packages: ["playwright"]` —
  the service code imports it at startup and removing it crashes the
  agent.
- A multi-caller specialist locks `show_co_participants: false` on its
  `ask` channel — callers not learning about each other is part of the
  isolation boundary, not a deployment preference.

**Unlock examples.**
- A Notion-integration agent unlocks `NOTION_WORKSPACE_ID` with a
  `"REPLACE_ME"` default. There is no universal workspace.
- A general-purpose assistant ships `additional_disabled_tools: ["Bash"]`
  **unlocked** — shell off by default (the safe resting value), but an
  operator who needs it can lift the restriction. Contrast the locked
  case above: there no-shell is the safety contract; here it's a safe
  default the operator may override.

**"More adaptable," not "more jobs."** Unlock widens what an operator tunes
on their install, not what the agent is *for* — broadening the mandate is
an identity/channels call, and a bounded *what* is the point
(`/ref/manuals/console/what-is-an-agent.md`).

**Run the test on the whole section.** Since unlocking exposes every field
under the key together, if a section mixes a knob with a spine field, the
spine wins — it stays locked, and the knob waits for per-leaf unlock.

**When you can't tell, default locked and say so** — locking is reversible
by a later blueprint edit; an unlocked guarantee that gets undone is not.
The lock posture *is* the operator's entire configurability surface once a
blueprint ships to someone who only has Configure — author for that
downstream operator; it's what the lever is for.
