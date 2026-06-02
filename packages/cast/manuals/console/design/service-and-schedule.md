# Design — service and schedule

Read this only when the owner asks you to touch `blueprint/service/` or
`blueprint/props/schedule.txt`.

## Service

A Cast agent's service is an optional long-running Node.js process
spawned alongside the agent. Typical uses: an IMAP poller for an email
agent, a calendar sync daemon, a WebSocket client.

### Layout

```
blueprint/service/
  package.json            — dependencies, entry point, build script
  src/                    — TypeScript source
  dist/                   — compiled output (gitignored; built before run)
  README.md               — purpose, config surface, env vars
```

### Rules

- **Service source is yours to edit.** Write, refactor, add files, install
  npm packages. `npm install` runs in the container because Design has
  full network.
- **Build outputs.** After editing source, run the build (typically
  `npm run build`). Don't commit `dist/` to source control — but do
  ensure it exists on disk before the server tries to launch the service.
- **Restart is an admin-UI action.** A source edit doesn't take effect
  until the running service process respawns. There's no console tool for
  it — tell the owner to open the agent's ⋯ menu in the admin UI and click
  **Restart Agent Service**. (Config and secrets hot-reload on their own;
  only new *source* needs the restart.)
- **No config, no secrets.** The service reads config from the agent's
  `config/agent.json` and secrets via environment variables injected by
  Cast at launch. You can't see either. Document the env-var contract
  in `blueprint/service/README.md` so the owner knows what to set.
- **No direct DB writes from Design.** If your service needs persistent
  state, document a schema and let the service own the database at
  runtime. Don't pre-create tables from Design.

### MCP exposure

If the service exposes an MCP server for the agent to use, declare it
in `blueprint/props/capabilities.json`. The Cast server stands up a
proxy that routes tool calls into the service. See the root schema
docs for the exact shape.

## Schedule

`blueprint/props/schedule.txt` is a cron-flavored task file. Each line
declares a scheduled message or task for the agent.

### Format

```
# Lines starting with # are comments.
# Blank lines are ignored.

# Every weekday at 09:00 local time, tell the agent to run its morning routine.
0 9 * * 1-5  default   morning check-in

# Every hour, refresh a cache via a specific channel.
0 * * * *    housekeeping   refresh cache

# Timezone override: run at 08:00 Tokyo time regardless of the agent's tz.
TZ=Asia/Tokyo  0 8 * * *  reports  generate daily

# Sharded channels: append `~<qualifier>` to target a specific shard
# (channel must declare `use_sharding: true` in its channel.json).
# Same `channel~qualifier` form as the rest of Cast's address grammar.
0 7 * * *    reviews~daily   summarize yesterday's reviews

# Fields: cron-expr  channel[~qualifier]  message...
```

### Rules

- **A fire is self-addressed.** A `schedule.txt` fire lands in the agent's
  *own* cell `(agent, agent, channel)` — it prompts the agent to act, not
  a user. To reach a person the agent crosses to *their* cell:
  `conversation__push_to_participant` to someone it enumerates via
  `agent__list_participants`, or bind the user up front with `task__schedule`
  (fires into their cell directly), or step off the grid via a transport.
  `push_to_channel` won't do it — it holds the participant fixed, so from a
  self-fire it only reaches another agent-addressed cell. Cells and crossing
  verbs: `primitives.md` § The verb layer. The blueprint still names no user
  (`what-is-an-agent.md`).
- **One line = one task.** No multiline messages.
- **Channel must exist.** If you reference `reports`, make sure
  `blueprint/channels/reports/` exists with a `channel.json`.
- **Timezone.** The agent's runtime timezone is set in `config/agent.json`
  (which you can't see). By default, cron expressions resolve in that
  timezone. Use `TZ=<IANA>` as a line prefix to override per task.
- **Hot reload.** Changes to `schedule.txt` take effect automatically —
  no tool call, no restart. The scheduler re-reads the file when it changes on disk.
- **Authoring in isolation.** You can't see what tz the agent is
  configured in. Write schedules that express intent (the `TZ=` prefix
  when the task is tied to a specific wall-clock locale) rather than
  assuming a runtime setting.

### Common patterns

**Morning self-cue:** `0 9 * * 1-5  default  run the morning routine`

**Hourly sync:** `0 * * * *  sync  poll mailbox`

**End-of-day self-cue with explicit tz:**
`TZ=America/New_York  0 17 * * 1-5  default  run the end-of-day routine`
