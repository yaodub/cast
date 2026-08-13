---
description: Google Messages (SMS/RCS) — read conversations, send texts, and watch threads via the web protocol
---

# gmessages

**Preview.** This extension is new and still maturing: the protocol surface is complete and send
policy is conservative by default, but expect rough edges in the admin pairing flow and watch
notifications while it soaks.

Connects an agent to a Google account's Messages (SMS/RCS) through the Google Messages for web
protocol, using the MIT [`gmessages`](https://github.com/yaodub/gmessages) client. The account is
paired with its phone once; the phone remains the message transport, so the agent sees exactly the
conversations that account's handset sees.

## USAGE

**Workflow: chats → messages → act.** `gmessages__chats` lists conversations; each line carries the
display name, a `group` tag where applicable, the SMS/RCS kind, and the conversation id. Google
renders saved-contact names into the listing itself, so a thread shows "Alice Chen" rather than a
number — but that means the listing is *display text*, and the conversation id is the only stable
key. Config, watches, and anything durable key on the id.

`gmessages__messages` reads a thread by name, operator label, or id. An ambiguous name returns the
matches rather than guessing; the agent should ask which one. Media renders as a placeholder
carrying the message id: `[media: image/jpeg] (id: …)`.

`gmessages__download` takes that message id plus its conversation and writes the attachment to
`/staging/in/`, where the agent reads it with the Read tool. There is no local message store, so the
id is resolved by re-reading the thread — a message older than the last ~100 in the conversation
cannot be resolved.

A message can carry more than one attachment; each is listed with its own `index`, and
`gmessages__download` takes that index (default 0) to pick between them.

Attachments arrive without a download handle until their media has been **resolved** on Google's
side; the tool issues that resolve itself (`GET_FULL_SIZE_MEDIA`) and then downloads, so the two-step
is invisible to the agent. It is the same request Google's own client makes when a person opens an
image full-screen, and its effect persists — a later read of the same thread carries the handle.

`gmessages__send` sends into an **existing** conversation: text, or a file staged in `/staging/out/`
(pass the bare filename). File types are restricted to those Google's own format table carries —
common image, audio, video, and document formats — and an unrecognised extension is refused rather
than sent as an unknown type. On an SMS thread an attachment goes as MMS, which is size-limited and
may be recompressed by the carrier.

There is no way to message a number for the first time — resolution is restricted to threads that
already exist, and a bare number with no thread returns an error saying so. An agent asked to text
someone new should say it cannot rather than trying.

Two behavioural nuances the tool descriptions cannot carry:

- **SMS threads never report delivery** past `accepted`. Only RCS reports delivered/read. An agent
  waiting for a receipt on an SMS thread waits forever.
- **In group threads the sender is a raw participant id**, not a name. Mapping it to a person needs
  a read this extension does not perform, so the id is shown rather than a guess.

A send is confirmed by reading the thread back, not from the tool result: the relay echoes no id for
a send, so "Sent." means the relay accepted it, not that it arrived.

**Watches.** `gmessages__watch` monitors a conversation; each new message returns to the
conversation that created the watch, carrying the `instructions` given at watch time. Those
instructions run without the creating conversation's history, so they must read standalone.
`gmessages__list_watches` and `gmessages__unwatch` are scoped to the calling conversation.

A watch fires **only on messages from the other party, and once each.** Two facts about the relay
make that non-trivial and worth knowing: it re-pushes a message at every step of its delivery
progression (a send is pushed roughly three times — sending, handed off, delivered), and messages the
account sends from the *handset* appear on the same stream. Direction is read from the message
status, so anything this account sent is excluded regardless of which device sent it, and repeats are
collapsed on message id. An unrecognised status is treated as not-inbound: a watch stays quiet on
something it cannot classify rather than announcing a message the user may have sent themselves.

## CONFIG

| Field | Type | Default | Controls | Lockable |
|---|---|---|---|---|
| `read_mode` | `disabled` \| `approval` \| `open` | `approval` | Default for conversations with no override. `approval` prompts the user per read; `open` allows silently; `disabled` blocks. | yes |
| `send_mode` | `disabled` \| `approval` \| `direct` | `disabled` | Default for sending. `approval` prompts per message; `direct` sends without prompting; `disabled` blocks. | yes |
| `chats` | `Record<conversationId, {read?, send?}>` | `{}` | Per-conversation overrides, `allow` or `deny` per axis. Covers groups. Absent axis inherits the global mode. | yes |
| `contacts` | `Record<E.164, {read?, send?}>` | `{}` | Per-number overrides. 1:1 only (a group has no number). Authorises first contact — see below. | yes |
| `labels` | `Record<conversationId, string>` | `{}` | Operator names for threads Google's contact sync cannot label (unsaved numbers, nicknames). Used in display and name resolution. | yes |

Two asymmetries an authoring actor should understand, because they change what the agent can do:

- **`send_mode: 'disabled'` is a master switch.** No `chats` or `contacts` allow overrides it.
  Sending ships off, and turning it on is an explicit mode change — never something an allowlist
  entry implies. For reads the opposite holds: an explicit `allow` *does* beat `read_mode:
  'disabled'`, which makes "read only this one thread" expressible.
- **First contact always asks.** A send to a number with no existing thread requires approval in
  every mode including `direct`, unless that number carries an explicit `contacts` allow. (v1 does
  not implement cold send at all, so this currently manifests as a refusal; the policy is in place
  for when it does.)

## SECRETS

None. `secretsSchema` is empty.

Pairing consumes a signed-in browser's Google cookie export once, through the admin page — it is
never written to `config/ext/gmessages/.env` and never persisted. The durable credential is the
session file described under STORAGE.

## CHANNEL

Optional. Setting `"channel": "<name>"` in `capabilities.json` gives watch deliveries a default
landing channel, used as a fallback for bindings stored without one. Watches otherwise return to the
conversation that created them, so the extension is fully usable with no channel configured.

A channel prompt receiving watch fires should expect a message of the form: a header naming the
conversation, the rendered message line, and the watch's own `instructions`. It should treat the
instructions as the task and the message as its input.

## STORAGE

`ext/gmessages/` (private runtime, never mounted):

| Asset | Format | Lifecycle |
|---|---|---|
| `session.json` | Opaque serialized session blob | Written at pairing. Rewritten in place as cookies and tokens rotate — the extension is its sole writer. Account-wide credential; treat as a secret. |
| `watches.json` | JSON array of watch records | Written when watches change; reloaded at agent start. Invalid entries are skipped rather than failing startup. |

Nothing is written to `shared/ext/gmessages/`.

## SECURITY

**Input surface.** Every SMS and RCS conversation on the paired account — message text, sender,
attachments metadata, reactions, delivery state — plus the contact names Google renders into the
listing. `read_mode` bounds this; `chats` denies narrow it further.

**Output surface.** Text messages and file attachments to existing conversations. Sends are
**irreversible**: SMS cannot be unsent. Note that an attachment leaves the host — anything the agent
can place in `/staging/out/` can be sent to a real person, so `send_mode` bounds data egress as well
as messaging. (Uploading alone is not outward-visible: it parks encrypted bytes on Google's server
and notifies nobody until a send references them, which is why the gate sits on the send.) Connecting also subscribes to the account's update stream, which is what opening
messages.google.com does and emits nothing another person can observe. Reactions, typing
indicators, mark-read, delete, and archive are deliberately not exposed — several are visible to
the other party, and none were needed.

**Config risk levels.**

| Setting | Risk | Notes |
|---|---|---|
| `send_mode: 'disabled'` | safe | Default. No outbound messages possible. |
| `send_mode: 'approval'` | safe | Every send shown to a human, with the exact message, before it goes out. |
| `send_mode: 'direct'` | **dangerous** | The agent texts real people with no confirmation, irreversibly. First contact still asks, but replies into existing threads do not. |
| `read_mode: 'open'` | unsafe | The agent reads every conversation on a personal account without prompting. |
| `chats: {id: {send: 'allow'}}` | unsafe | Bypasses per-message approval for that thread. Deliberate per-thread trust. |
| `contacts: {number: {send: 'allow'}}` | unsafe | Authorises first contact to that number without a prompt. |

**Revocation.** Clearing the session from the admin page removes the local credential only. Real
revocation is on the handset: Google Messages → device list → unpair, which kills the session
whatever state the files are in.

## ADMIN

The admin page is implemented at `packages/web-ui/src/admin/pages/extensions/gmessages.tsx` with its
tRPC router at `packages/cast/src/admin/routers/extension/gmessages.ts`.

**Fields.** `read_mode` and `send_mode` as dropdowns; `chats`, `contacts`, and `labels` as editable
row lists. Each override row offers Allow / Deny / Inherit per axis, where Inherit is the absence of
an entry. Contact rows expose only the send axis — a number with no thread has nothing to read.
Lock state comes from the config read helper; locked fields render read-only with a note.

**Discovery.** Conversation lists come from the **live extension instance**
(`refreshConversations()`), never from a second connection — the session store has one writer, and a
competing client clobbers cookie rotation. `getConfig` returns only the cached listing so it stays
synchronous and side-effect free; the page offers an explicit Refresh action that requires the agent
to be running.

**Pairing flow.** Not OAuth, not a QR code:

1. The operator pastes a cookie export from a browser signed in to the Google account. Netscape
   `cookies.txt` and the JSON most extensions produce are both accepted. **The export should come
   from an incognito window that is then closed** — see "Session longevity" below; the page says so
   at the paste box, because it decides whether the pairing lasts hours or weeks.
2. `pair` starts the handshake and returns a verification code (an emoji, plus a numeric form).
3. **The handset only displays its pairing request after the finish message goes out**, and finish
   goes out as soon as the code is known. So the code must be returned and rendered immediately —
   a flow that waits for the operator's tap before returning is waiting for a prompt its own
   waiting prevents, and the attempt expires unseen.
4. The operator approves the matching code in Google Messages on the phone.
5. The page polls `getConfig` until `paired` flips. The relay holds an attempt about five minutes.

**Browser choice — avoid Chrome.** A device-bound (DBSC) cookie jar cannot be used: DBSC ties the
login to a hardware key on the exporting machine, so no external client can rotate it, and the
session would authenticate once then die. A jar containing `__Secure-1PSIDRTS` is refused up front
with that explanation. DBSC went GA in Chrome 146, so Chrome is where operators will hit it —
Firefox or Safari avoid it entirely.

**The verification code may be numeric only.** `VerificationPrompt.emoji` is nullable: the emoji comes
from a versioned table, and if Google ships a revision the library has not captured it declines to
render a possibly-wrong glyph rather than making a legitimate pairing look like an attack. The numeric
code needs no table and stays correct across revisions. The admin page must therefore handle a null
emoji and show the numeric code instead — never treat null as a failure.

**Session longevity — where the cookies came from matters.** `__Secure-1PSIDTS` is a rotating
freshness token on a single `__Secure-1PSID` login. Every consumer that rotates it invalidates the
value the others hold, so a login shared by two consumers is a race whose loser is refused with
`SESSION_COOKIE_INVALID`. If the operator exports from the browser they keep using, that browser goes
on rotating the login underneath the agent and the pairing dies within hours. Exporting from an
incognito window (a separate cookie space) and **closing it** leaves the agent as the only consumer,
which holds a session coherent for weeks. This is the same one-writer rule that governs the session
file, applied one level up to the login itself.

## SERVICE API

Public methods on `GmessagesExtension` beyond `ExtensionInstance`:

| Method | Signature | Purpose |
|---|---|---|
| `pair` | `(cookies: string, onVerification: (prompt) => void \| Promise<void>) => Promise<VerificationPrompt>` | Run the pairing handshake. `onVerification` must display the code and **return promptly** (see ADMIN step 3). |
| `isPaired` | `() => boolean` | Whether a session file exists. |
| `isConnected` | `() => boolean` | Whether the stream is currently open. |
| `refreshConversations` | `(limit?: number) => Promise<Array<{conversationId, label, kind}>>` | Live fetch; refreshes the cache. Returns `[]` when not connected. |
| `listConversationsResolved` | `() => Array<{conversationId, label, kind}>` | Last cached listing, synchronous. |
