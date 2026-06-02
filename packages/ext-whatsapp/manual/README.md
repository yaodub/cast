---
description: WhatsApp messaging extension — read, send, download media, and watch chats via Baileys linked-device protocol
---

# whatsapp

Access WhatsApp as a data source and action surface. The agent reads and writes WhatsApp messages as a capability — it does not converse via WhatsApp. Connects via the Baileys library using the WhatsApp Web linked-device protocol.

## USAGE

### Core workflow

1. **`whatsapp__chats`** — List recent chats with names, previews, unread counts. The entry point for orienting.
2. **`whatsapp__messages`** — Read a conversation by name, phone number, or JID. Returns timestamps, sender names, text, and media placeholders.
3. **Act** — Send a reply, download media, or set up a watch.

### Contact resolution

Tools accept a contact name, phone number, or JID. Resolution is fuzzy (case-insensitive substring on saved name, push name, and phone number).

When multiple contacts match, the tool returns the list — the agent should ask the user to clarify, then record the mapping in a WhatsApp context file in memory (`memory/whatsapp-context.md`). This avoids repeated ambiguity resolution. Example entries:

```
Alice = wife, +1234567890, 1234567890@s.whatsapp.net
Family Group = reunion planning group, 120363012345@g.us
```

**Build context before acting.** Don't just execute tool calls — first check memory for known JIDs and user preferences. When a user says "message Alice," the agent should already know which Alice.

### Media

Messages show media as placeholders: `[image]`, `[voice note]`, `[document: invoice.pdf]`. Each media message includes a message ID in the tool output. Use `whatsapp__download` with that ID to save the file to `/staging/in/`, then use the Read tool to view it.

To send media, write the file to `/staging/out/` first, then pass the filename to `whatsapp__send`.

### History

Messages are persisted to a local SQLite database (`messages.db`) as they arrive. The database accumulates messages from the initial history sync at pairing time and from real-time events while connected. Messages survive restarts — the agent can look up past conversations at any time.

WhatsApp delivers history only once, at initial device pairing (typically ~3 months for web clients). After that, only real-time messages are captured. There is no way to fetch older messages on demand — if the extension wasn't running when a message arrived, it won't be in the database.

### Watches

When a processing channel is configured, `whatsapp__watch` monitors a chat for new messages in real-time. Messages are forwarded to the processing channel with the specified instructions. Watches are always real-time (no cron schedules). Watches persist across restarts.

## CONFIG

| Field | Type | Default | Lockable | Description |
|-------|------|---------|----------|-------------|
| `read_mode` | `'disabled' \| 'approval' \| 'open'` | `'approval'` | yes | Global default for reads. `approval` prompts the user; `open` allows all; `disabled` blocks all. Applies to `whatsapp__messages`, `whatsapp__download`, `whatsapp__watch`. |
| `send_mode` | `'disabled' \| 'approval' \| 'direct'` | `'disabled'` | yes | Global default for sends. `approval` prompts the user; `direct` sends immediately; `disabled` blocks all. |
| `chats` | `Record<jid, { read?: 'allow'\|'deny'; send?: 'allow'\|'deny' }>` | `{}` | yes | Per-JID overrides. Each axis is independent. `allow` = always allow (skip approval); `deny` = always block; missing = inherit the global mode. |
| `pairing_history_depth` | `'standard' \| 'extended'` | `'standard'` | yes | Pair-time parameter. How much message history WhatsApp delivers during initial pairing. Standard = ~3 months (web client). Extended = ~1 year (desktop client). Only takes effect at pairing time — changing after pairing has no effect until unpair + re-pair. |

**Approval trust inheritance:** `whatsapp__download` has no approval prompt of its own. When `read_mode: 'approval'` is active and the user just approved `whatsapp__messages` or `whatsapp__watch` for a JID, any subsequent download for that JID within the approval TTL (1h) auto-inherits the approval without asking again.

**Locked-down config example:** `{ "read_mode": "approval", "send_mode": "disabled", "chats": { "spouse-jid@s.whatsapp.net": { "read": "allow", "send": "allow" } } }`

## SECRETS

No credentials. Authentication uses the WhatsApp Web linked-device pairing flow, which produces session files stored in `ext/whatsapp/auth/`. See ADMIN for pairing instructions.

## CHANNEL

**Receives:** Formatted new message notifications with watch instructions. Format:

```
New WhatsApp messages in "Family Group":

[2026-04-05 10:30] Alice: Are we doing dinner Friday?
[2026-04-05 10:32] Bob: I'm in

Watch instructions: Notify me when they discuss the reunion
```

**Channel prompt should instruct the agent to:** Process the messages according to the watch instructions. Respond to the user if action is needed. Use WhatsApp tools for follow-up (e.g., reading more context, replying).

**Without a channel:** Watch tools (`whatsapp__watch`, `whatsapp__unwatch`, `whatsapp__list_watches`) are hidden. All on-demand tools (chats, messages, send, download) work normally.

## STORAGE

| Path | Format | Lifecycle |
|------|--------|-----------|
| `ext/whatsapp/auth/` | Baileys multi-file auth state | Private runtime. Created on first pairing. Survives restarts. Deleted on logout. |
| `ext/whatsapp/messages.db` | SQLite (WAL mode) | Private runtime. Created on first connection. Contains chats, contacts, and messages. Persists across restarts. |
| `ext/whatsapp/watches.json` | JSON array of watch entries | Private runtime. Created on first watch. Updated on watch/unwatch. |

Media message references are kept in-memory only (LRU cache, up to 500 entries) for `whatsapp__download`. If the extension restarts, media references are lost — the agent can still see media placeholders in message text but cannot download until the media message arrives again via a live event.

## SECURITY

**Input surface:** All WhatsApp messages and chat metadata within the read policy scope. Includes message text, sender identity, timestamps, media metadata. Media content is only accessed when explicitly downloaded.

**Output surface:** `whatsapp__send` sends messages and media as the user's linked WhatsApp device. Recipients see messages as coming from the user's phone number.

**Config risk levels:**

| Setting | Risk | Notes |
|---------|------|-------|
| `read_mode: 'open'` | Medium | Agent reads any chat without per-chat `read: 'deny'` |
| `read_mode: 'approval'` | Safer | Unclassified chats require user consent per call |
| `read_mode: 'disabled'` | Safe | No reading unless a per-chat `read: 'allow'` override exists |
| `send_mode: 'direct'` | Dangerous | Agent sends autonomously as the user |
| `send_mode: 'approval'` | Safer | Unclassified sends require user consent |
| `send_mode: 'disabled'` | Safe | No sending unless a per-chat `send: 'allow'` override exists |
| Per-chat `read: 'allow'` | Trust decision | Auto-allows reads from that JID regardless of mode |
| Per-chat `read: 'deny'` | Safe | Hard blocks reads from that JID regardless of mode |
| Per-chat `send: 'allow'` | Trust decision | Auto-sends to that JID regardless of mode |
| Per-chat `send: 'deny'` | Safe | Hard blocks sends to that JID regardless of mode |

## ADMIN

### Design principles

**Single socket.** The extension maintains one Baileys WebSocket per agent. The admin never creates its own socket — all operations go through the live extension instance via `AgentManager.getExtension('whatsapp')`. WhatsApp kicks out competing connections with a 440 conflict. A second socket (e.g. for "test connection") would kill the agent's live connection.

**Pairing is the critical moment.** WhatsApp delivers message history exactly once, at initial pairing. After that, only real-time messages are captured. The pairing socket must be the extension's own socket (not a throwaway), so history sync flows into the database. The admin calls `ext.pair()` on the live instance — same socket that runs afterward.

**JIDs are the only stable identifier.** Chat and contact names change (group renames, push name changes). JIDs (`120363012345@g.us`, `1234567890@s.whatsapp.net`) never change. Config stores JIDs as keys. The admin resolves names for display but always writes JIDs to config.

**The admin UI is a view, not the source of truth.** Config files can be edited directly. Pair-time parameters like `pairing_history_depth` only take effect at pairing — changing them after pairing does nothing until unpair + re-pair. The UI communicates this by making them read-only when paired.

### Data source: `getConfig`

All admin page data comes from a single query. No separate "test connection" or "discover chats" step.

```typescript
extension.whatsapp.getConfig({ folder }) → {
  config: { ... },              // merged config with locked flags
  paired: boolean,              // auth session exists and registered
  connected: boolean,           // live WebSocket is open
  chats: Array<{                // from ext.listChatsResolved(), sorted by recent activity
    jid: string,                //   e.g. "120363012345@g.us"
    name: string,               //   resolved display name (see resolution order below)
    isGroup: boolean,           //   true for @g.us, false for @s.whatsapp.net
  }>
}
```

**Name resolution order:** group chat name → contact name (address book) → contact notify (push name from contact record) → push_name from recent inbound messages → raw JID as fallback.

### Page sections

#### 1. Pairing Status

Green/red dot with status text.

**When not paired**, show the pairing form:
- `pairing_history_depth` selector (if unlocked): "Standard (~3 months)" / "Extended (~1 year)". This is a pair-time parameter — it controls how much message history WhatsApp delivers during the initial sync. Cannot be changed after pairing without unpair + re-pair.
- Phone number text input (with country code).
- "Pair Device" button. On click: save `pairing_history_depth` to config, then call `extension.whatsapp.pair` mutation. Returns `{ ok, code, message }`.
- Show the 6-digit code large and monospace, formatted as `XXXX-XXXX`. Include instructions: "Enter this code in WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number."
- Poll `getConfig` every 5s for up to 2 minutes. When `paired` flips to `true`, pairing succeeded — stop polling, refresh. History sync populates the database during this window.
- **Known quirk:** Baileys returns a 515 stream error after pairing succeeds. This is normal — the ConnectionManager reconnects automatically. The UI should not treat it as failure; just keep polling.

**When paired**, show read-only status:
- History depth label: "Standard history (~3 months)" or "Extended history (~1 year)". Not editable — display only.
- Sync stats: "{N} chats synced" (from `chats.length`).
- "Unpair Device" button (red, with confirmation dialog). Calls `extension.whatsapp.unpair`.

#### 2. Access Modes

| Field | Input | Description |
|-------|-------|-------------|
| `read_mode` | Dropdown: disabled / approval / open | How the agent reads unclassified chats |
| `send_mode` | Dropdown: disabled / approval / direct | How the agent sends to unclassified chats |

Respect `locked` flag from capabilities.json — disable inputs when locked.

#### 3. Per-Chat Overrides

Each entry shows the resolved display name (from the synced chats list) plus a truncated JID suffix, with two dropdowns — read and send — each offering `Inherit (mode)` / `Allow` / `Deny`.

Manual JID text input + "Add" button as fallback for chats not in the synced list. Disable entire section when `config.chats.locked`.

#### 4. Synced Chats

The main interface for building per-chat policy. Loaded automatically from `getConfig` on page load — no button click needed.

- **Search box** — filter by name or JID substring. Essential since there can be hundreds of chats.
- **Scrollable list** with max height — each row shows:
  - Group/user badge: "G" (blue) for `@g.us`, "U" (gray) for `@s.whatsapp.net`
  - Resolved display name (truncated)
  - Shortened JID (number only, without the `@` domain)
- **Click to add** — clicking a chat adds it as a per-chat override with default policy (read: true, send: confirm). Already-added chats are visually dimmed and not clickable.

### Validation

Auth files: `ext/whatsapp/auth/`. Message database: `ext/whatsapp/messages.db`. Extension status: `ext.isConnected()` / `ext.isPaired()`.

## SERVICE API

Public methods on `WhatsAppExtension` beyond the `ExtensionInstance` interface:

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `pair(phoneNumber)` | `string` | `Promise<string>` | Start pairing, return 6-digit code |
| `listChatsResolved(limit?)` | `number?` | `Array<{ jid, name, isGroup }>` | Chats with resolved display names |
| `isConnected()` | — | `boolean` | Connection state |
| `isPaired()` | — | `boolean` | Whether auth state exists |

Reading, sending, and downloading messages are not service methods — they live behind the `whatsapp__*` tools.
