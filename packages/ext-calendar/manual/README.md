---
description: CalDAV calendar extension — event queries, CRUD, changelog, multi-provider
---

# calendar

CalDAV-based calendar access with event listing, creation, modification, deletion, and an append-only audit changelog. Provider-agnostic — works with Google Calendar (OAuth), Apple iCloud, Fastmail, Nextcloud, and any standard CalDAV server.

## USAGE

The extension provides six tools.

**Read workflow: list → get.**
1. `calendar__list` returns events in a time range, sorted by start time. Supports `after` and `before` date filters.
2. `calendar__get` fetches full details for a single event by UID.

**Write workflow: create / update / delete.**
3. `calendar__create` creates a new event on the first resolved calendar.
4. `calendar__update` modifies an existing event. Only specified fields change.
5. `calendar__delete` removes an event by UID.

All write operations are gated by `write_mode` and append to the audit changelog.

6. `calendar__changes` lists recent changelog entries (create, update, delete) with timestamps and before/after snapshots.

**Config affects behavior:** `write_mode` is an approval ladder — `disabled` (read-only), `approval` (every write prompts), `personal` (only attendee writes prompt), `full` (no prompts). `view_past` and `view_future` limit the query window.

## CONFIG

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `write_mode` | `disabled \| approval \| personal \| full` | `disabled` | Approval ladder for create/update/delete. See table below. |
| `calendars` | `string[]` | `[]` | Calendar display names — resolved via CalDAV PROPFIND. Use for CalDAV providers (iCloud, Fastmail). |
| `calendar_urls` | `string[]` | `[]` | Pre-resolved CalDAV URLs. Bypasses PROPFIND. **Required for Google** — PROPFIND only returns owned calendars, not shared ones. Takes priority over `calendars`. |
| `view_past` | `string` | `30d` | How far back queries can look. Duration format: `7d`, `4w`, `3m`, `1y`. |
| `view_future` | `string` | `365d` | How far forward queries can look. Same format. |

### Write mode semantics

Each tier auto-approves a wider class of operations:

| `write_mode` | Personal writes (no attendees) | Attendee writes |
|------|-------------------|-------------------|
| `disabled` | create/update/delete not registered | create/update/delete not registered |
| `approval` | prompt user | prompt user |
| `personal` | execute without prompt | prompt user (attendees trigger real invitations) |
| `full` | execute without prompt | execute without prompt |

Reads (`calendar__list`, `calendar__get`, `calendar__changes`) never prompt — the view window + configured calendar are the read-side policy.

## SECRETS

Stored in `config/ext/calendar/secrets.json`. Two provider modes, selected by `PROVIDER`.

### Google provider (`PROVIDER=google`)

| Field | Description |
|-------|-------------|
| `PROVIDER` | `google` |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID (from Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token (obtained via consent flow) |
| `GOOGLE_EMAIL` | Google account email (used as CalDAV username) |

Requires a Google Cloud Console project with the Google Calendar API enabled. Setup:

1. Create an OAuth 2.0 Client ID (type: Web application) at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
2. Add the authorized redirect URI shown on the admin Calendar page (`/api/oauth/google-calendar/callback` on the Cast server's base URL)
3. Copy the Client ID and Client Secret into the admin UI or `config/ext/calendar/secrets.json`
4. Run the OAuth consent flow from the admin UI — this obtains the refresh token automatically

OAuth scope: `https://www.googleapis.com/auth/calendar`.

By default the OAuth app is in **Testing** mode and refresh tokens expire after 7 days, forcing weekly re-authorization. To avoid this, publish the app under **OAuth consent screen > Audience > Publish app**. Production apps using the Calendar (sensitive) scope work without verification for up to 100 users — sufficient for personal/single-tenant deployments.

The extension refreshes the access token automatically using the refresh token. Cached token state is stored in `ext/calendar/credentials.json` (private runtime).

### CalDAV provider (`PROVIDER=caldav`)

| Field | Description |
|-------|-------------|
| `PROVIDER` | `caldav` |
| `CALDAV_URL` | CalDAV server URL |
| `CALDAV_USERNAME` | Account username or email |
| `CALDAV_PASSWORD` | Account password or app-specific password |

**Common CalDAV URLs:**
- Apple iCloud: `https://caldav.icloud.com`
- Fastmail: `https://caldav.fastmail.com/dav/calendars`
- Nextcloud: `https://{host}/remote.php/dav`

## STORAGE

| Asset | Location | Format | Purpose |
|-------|----------|--------|---------|
| Changelog | `ext/calendar/changelog.jsonl` | JSONL | Append-only audit log of all write operations (private runtime) |
| Token cache | `ext/calendar/credentials.json` | JSON | Google OAuth access token + expiry (private runtime, auto-managed) |

The extension does not maintain a local event cache. Each query hits the CalDAV server directly.

## SECURITY

### Input surface

The agent can read any event within the configured view window on the selected calendars. Calendar events may contain sensitive meeting details, locations, attendee lists, and descriptions.

### Output surface

Write operations (create, update, delete) modify the actual calendar. `calendar__create` with attendees sends invitation emails from the calendar provider. This is the primary risk vector.

### Config risk levels

| Setting | Safe | Moderate | Dangerous |
|---------|------|----------|-----------|
| `write_mode` | `disabled` (default) or `approval` | `personal` — agent can create/modify personal events without prompting | `full` — agent can send meeting invitations without prompting |
| `view_past` | `7d` | `30d` | `365d` — agent sees a year of calendar history |
| `view_future` | `90d` | `365d` | Large windows expose upcoming sensitive meetings |
| `calendars` | Single personal calendar | — | Shared team calendar with broad visibility |

### Composer guidance

Start with `write_mode: disabled`. Step up to `approval` when the agent is actively used for scheduling. Only move to `personal` or `full` with intent — `personal` auto-confirms solo events but still gates attendee invitations; `full` lets the agent send invitation emails without asking.

## ADMIN

### Display rules

- **Secrets masking:** Only passwords and tokens are masked (`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `CALDAV_PASSWORD`). Public identifiers (`GOOGLE_CLIENT_ID`, `GOOGLE_EMAIL`, `CALDAV_URL`, `CALDAV_USERNAME`) are returned unmasked and pre-filled as input values, not placeholders.
- **Calendar display:** If a calendar is already configured (saved in `calendar_urls` or `calendars`), show it immediately as a text field — don't require clicking Discover first. After discovery, replace the text field with a dropdown of all available calendars.

### Secrets fields

Group by provider with a provider selector.

**Google provider:**

| Field | Input type | Help text |
|-------|-----------|-----------|
| `GOOGLE_CLIENT_ID` | text (pre-filled) | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | password | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | (obtained via OAuth flow) | Not manually editable — set via OAuth consent |
| `GOOGLE_EMAIL` | text (pre-filled) | Google account email |

Google setup uses the admin UI's OAuth flow (see `packages/cast/src/admin/routers/extension/calendar.ts`). The redirect URI registered in Google Cloud Console must match the one shown on the admin Calendar page — `/api/oauth/google-calendar/callback` on `CAST_WEB_BASE_URL` (else `http://127.0.0.1:<CAST_PORT>`, default 5050).

The admin UI's "Start OAuth" button triggers the consent flow. On success, the refresh token and account email are written to `config/ext/calendar/secrets.json` automatically.

After OAuth, use the "Discover Calendars" button or `discoverGoogleCalendars(accessToken)` from `@getcast/ext-calendar` to list available calendars. Google CalDAV PROPFIND does not return shared calendars — the REST API discovery is required.

**CalDAV provider:**

| Field | Input type | Help text |
|-------|-----------|-----------|
| `CALDAV_URL` | text (with presets) | CalDAV server URL. Pre-fill for known providers: Apple (`caldav.icloud.com`), Fastmail (`caldav.fastmail.com/dav/calendars`) |
| `CALDAV_USERNAME` | text | Account username or email |
| `CALDAV_PASSWORD` | password | Account or app-specific password |

### Config fields

| Field | Input type | Help text |
|-------|-----------|-----------|
| `write_mode` | dropdown (`disabled`, `approval`, `personal`, `full`) | Approval ladder — see write mode semantics above. |
| `calendars` / `calendar_urls` | single-select dropdown (populated after auth) | Which calendar the agent uses. Google saves as `calendar_urls`; CalDAV saves as `calendars` (display name). |
| `view_past` | text | How far back the agent can query (e.g. `30d`, `4w`, `3m`) |
| `view_future` | text | How far forward the agent can query |

**Single calendar:** The extension operates on one calendar at a time. The `calendars` config field is an array for schema compatibility, but the admin UI presents it as a single-select dropdown. All reads and writes go to this calendar.

### Connect state

The extension's `connect` hook authenticates and discovers available calendars. Returns `CalendarAdminState`:

```typescript
{ provider: 'google' | 'caldav'; calendars: Array<{ id: string; name: string; primary?: boolean }> }
```

Exported from `@getcast/ext-calendar/schemas`. Parse with `CalendarAdminState.parse(result.state)` in the admin UI.

The admin UI renders the discovered calendars as a single-select dropdown. For Google, the selected calendar ID is converted to a CalDAV URL and saved to `calendar_urls` (bypasses PROPFIND). For CalDAV providers, the display name is saved to `calendars`.

### Validation

After saving credentials, use the "Connect" button. On success, it returns the calendar list for selection. On failure, display the error before writing `config/ext/calendar/secrets.json`.

Calendar discovery details (handled internally by the `connect` hook):
- **Google:** Refreshes access token, calls Google Calendar REST API (includes shared calendars — CalDAV PROPFIND doesn't return these on Google)
- **CalDAV:** PROPFIND with basic auth via tsdav

## SERVICE API

Public methods on `CalendarExtension` for direct service-side use:

| Method | Signature | Description |
|--------|-----------|-------------|
| `listEvents` | `(opts?: { after?, before?, calendarId? }) => Promise<CalendarEvent[]>` | List events in range |
| `getEvent` | `(uid: string) => Promise<CalendarEvent \| null>` | Get single event |
| `createEvent` | `(event: CreateEventInput) => Promise<{ event, change }>` | Create event (no policy enforcement) |
| `updateEvent` | `(uid: string, fields: Partial<CreateEventInput>) => Promise<{ event, change }>` | Update event |
| `deleteEvent` | `(uid: string) => Promise<{ change }>` | Delete event |

These bypass MCP policy (no `write_mode` approval check). `write_mode: disabled` is still enforced at the client level, but `approval`/`personal`/`full` decisions are MCP-layer only — services are trusted and responsible for their own policy when calling directly.

## PROVIDER NOTES

### Google

- CalDAV server: `https://apidata.googleusercontent.com/caldav/v2/`
- Auth: OAuth 2.0 bearer token (auto-refreshed by the extension)
- Primary calendar name matches the account email address
- **Shared calendars require `calendar_urls`** — Google CalDAV PROPFIND only returns owned calendars, not shared ones. Use `calendar_urls` with the full CalDAV URL instead of `calendars` with display names.
- Requires: Google Calendar API enabled in Cloud Console project

**Constructing Google CalDAV URLs:** The URL format is `https://apidata.googleusercontent.com/caldav/v2/{calendarId}/events/` where `{calendarId}` is URL-encoded. The admin UI does this automatically from the calendar discovery dropdown. For manual config:

```json
{
  "calendar_urls": [
    "https://apidata.googleusercontent.com/caldav/v2/my-calendar-id%40group.calendar.google.com/events/"
  ]
}
```

To find your calendar ID: Google Calendar web → Settings → calendar → "Integrate calendar" → Calendar ID.

### Apple iCloud

- CalDAV server: `https://caldav.icloud.com`
- Auth: Apple ID + app-specific password (generate at appleid.apple.com)

### Fastmail

- CalDAV server: `https://caldav.fastmail.com/dav/calendars`
- Auth: email + app password
