import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { ToolDoc, M } from '../../../components/docs/ToolDoc';

export function ApiTools() {
  return (
    <DocsLayout
      url="/docs/runtime/tools"
      crumbs={['docs', 'runtime', 'tools']}
      title="Tools"
      lede="Every tool the agent can call, with signatures and parameters. Cast built-ins, Claude Code SDK tools, peer-dialogue wire tags, and a per-extension index."
      toc={[
        { label: 'Conversation memory' },
        { label: 'Conversation lifecycle' },
        { label: 'Cross-conversation push' },
        { label: 'Peer dialogue' },
        { label: 'Peer awareness' },
        { label: 'Request tracking' },
        { label: 'Scheduling' },
        { label: 'Time' },
        { label: 'Filesystem watches' },
        { label: 'Python (when configured)' },
        { label: 'Claude Code SDK tools' },
        { label: 'Extension tools' },
      ]}
    >
      <p style={proseP}>
        Tools come from three places: Cast injects the framework MCP tools
        below, the Claude Code SDK contributes a fixed set of general-purpose
        tools, and each active extension contributes its own. Peer dialogue
        uses <DocsLink href="/docs/runtime/wire-format">wire tags</DocsLink>{' '}
        instead of MCP tools — visually, MCP tools carry a coral left rule,
        wire tags carry amber.
      </p>

      <H2>Conversation memory</H2>

      <ToolDoc
        name="message_log__search"
        summary="Search past messages by keyword. Returns previews with IDs — use message_log__read for full text."
        params={[
          { name: 'query', type: 'string', required: true, desc: 'Full-text search query.' },
          { name: 'limit', type: 'integer 1–50', default: '20', desc: 'Max results to return.' },
          { name: 'channel', type: 'string', desc: 'Filter to a specific channel.' },
          { name: 'before', type: 'ISO timestamp', desc: 'Only messages before this timestamp — pagination cursor.' },
          { name: 'after', type: 'ISO timestamp', desc: 'Only messages after this timestamp — time-range filter.' },
          { name: 'max_tokens', type: 'integer 1–1000', default: '200', desc: 'Max tokens per preview snippet.' },
        ]}
        returns={[
          { value: 'Messages (N[, has_more=true, next_cursor=ISO_TIMESTAMP]):', when: 'header line for non-empty results' },
          { value: '[ID] [ISO_TIMESTAMP] ROLE: PREVIEW', when: 'one per match; role is "user" or "assistant"' },
          { value: 'No messages found.', when: 'no matches' },
        ]}
        notes="Scoped to the current participant on this agent. A caller can only see messages addressed to themselves — never crosses identities."
      />

      <ToolDoc
        name="message_log__recent"
        summary="Browse recent messages newest-first without a keyword. Same scope as message_log__search."
        params={[
          { name: 'limit', type: 'integer 1–50', required: true, desc: 'Number of messages to return.' },
          { name: 'max_tokens', type: 'integer 1–1000', default: '200', desc: 'Max tokens per preview snippet.' },
          { name: 'before', type: 'ISO timestamp', desc: 'Pagination cursor — only messages before this timestamp.' },
          { name: 'after', type: 'ISO timestamp', desc: 'Time-range filter — only messages after this timestamp.' },
        ]}
        returns={[
          { value: 'Messages (N[, has_more=true, next_cursor=ISO_TIMESTAMP]):', when: 'header line' },
          { value: '[ID] [ISO_TIMESTAMP] ROLE: PREVIEW', when: 'one per row, newest first' },
          { value: 'No messages found.', when: 'no rows' },
        ]}
      />

      <ToolDoc
        name="message_log__read"
        summary="Read the full text of a specific message by ID."
        params={[
          { name: 'id', type: 'integer', required: true, desc: 'Message ID from a search or recent result.' },
          { name: 'max_tokens', type: 'integer 1–10000', default: '2000', desc: 'Max tokens of body text to return.' },
        ]}
        returns={[
          { value: '[ID] [ISO_TIMESTAMP] ROLE (CHANNEL):\nFULL_TEXT', when: 'found' },
          { value: 'Message ID not found.', when: 'unknown id' },
          { value: 'Access denied: message belongs to a different participant.', when: 'cross-participant read attempt' },
        ]}
        notes="Reads are denied if the message belongs to a different participant."
      />

      <ToolDoc
        name="conversation__list_summaries"
        summary="List recent conversations across channels. Shows participant, status, last activity, and summary when available."
        params={[
          { name: 'channel', type: 'string', desc: 'Filter to one channel.' },
        ]}
        returns={[
          { value: '- participant: ID, channel: NAME, status: STATUS, last_activity: DURATION[, summary: SUMMARY]', when: 'one per conversation from the past 7 days' },
          { value: 'No recent conversations.', when: 'no rows' },
        ]}
        notes="May prepend a co-participant visibility note when the current channel hides them, and a privacy reminder when results include other participants' conversations."
      />

      <ToolDoc
        name="conversation__write_summary"
        summary="Submit a summary of the current conversation. Stored and visible via conversation__list_summaries."
        params={[
          { name: 'summary', type: 'string', required: true, desc: 'Concise summary — decisions, action items, outcomes.' },
        ]}
        returns={[
          { value: 'Summary saved.', when: 'success' },
          { value: 'Cannot submit summary: no conversation context.', when: 'no active conversation' },
        ]}
      />

      <H2>Conversation lifecycle</H2>

      <ToolDoc
        name="conversation__end"
        summary="End the current conversation after a cooldown. Cleanup and summary run as usual. If the participant sends a message before the cooldown elapses, the end is cancelled and the agent is notified."
        params={[
          { name: 'cooldown_seconds', type: 'integer 60–86400', default: '300', desc: 'Seconds before the conversation expires. Clamped to the channel\'s idle_timeout.' },
        ]}
        returns={[
          { value: 'Conversation will end in N seconds. If the participant sends a message, the end will be cancelled.', when: 'always' },
        ]}
        notes="Persistent channels only — single-shot conversations end automatically and have nothing to release."
      />

      <H2>Cross-conversation push</H2>
      <p style={proseP}>
        All pushes are fire-and-forget. If the receiver later rejects the push
        (ACL revoked, target in draft, etc.) the agent sees a{' '}
        <M>&lt;cast:rejection request="ID"&gt;</M> on a later turn —
        full details on{' '}
        <DocsLink href="/docs/runtime/wire-format">Runtime › Wire format</DocsLink>.
      </p>

      <ToolDoc
        name="conversation__push_to_channel"
        summary="Push a turn into another channel. Opens cold or continues an active conversation. Without target_agent the push stays on this agent; with target_agent it crosses to a peer."
        params={[
          { name: 'channel', type: 'string', required: true, desc: 'Target channel name. For sharded channels, use "name~qualifier" to address a specific sub-conversation.' },
          { name: 'text', type: 'string', required: true, desc: 'Message content delivered to the target channel.' },
          { name: 'target_agent', type: 'string', desc: 'Peer agent alias (e.g. "knowledge"). Omit for a same-agent push.' },
        ]}
        returns={[
          { value: 'Pushed to CHANNEL for PARTICIPANT. id: REQUEST_ID.', when: 'same-agent success' },
          { value: 'Pushed to CHANNEL for PARTICIPANT via ALIAS. id: REQUEST_ID.', when: 'cross-agent success' },
          { value: 'Push failed: REASON', when: 'sync validation fails' },
          { value: '<cast:rejection request="ID">REASON</cast:rejection>', when: 'delivery rejected asynchronously; arrives on a later turn' },
        ]}
        notes="Cross-agent pushes hand the originating user to a peer agent and land only if the receiving peer has granted that user access. Passing your own alias is equivalent to omitting."
      />

      <ToolDoc
        name="conversation__push_to_participant"
        summary="Push a turn into a different participant's conversation on this agent. The target participant's runner sees it as a new turn."
        params={[
          { name: 'target_participant', type: 'string', required: true, desc: 'Target participant address. Use agent__list_participants to enumerate.' },
          { name: 'channel', type: 'string', required: true, desc: 'Target channel for that participant. Sharded as "name~qualifier".' },
          { name: 'text', type: 'string', required: true, desc: 'Message content.' },
        ]}
        returns={[
          { value: 'Pushed to CHANNEL for TARGET_PARTICIPANT. id: REQUEST_ID.', when: 'success' },
          { value: 'Push failed: REASON', when: 'sync validation fails' },
          { value: '<cast:rejection request="ID">REASON</cast:rejection>', when: 'delivery rejected asynchronously' },
        ]}
        notes="Intra-agent only, no target_agent option. The target must be a user who has access to the target channel, and the channel must let co-participants reach each other."
      />

      <H2>Peer dialogue</H2>
      <p style={proseP}>
        Peer-to-peer messaging uses wire tags rather than MCP tools — the
        agent writes them inline in its response and the framework routes
        them. Validation rules and full attribute schema on{' '}
        <DocsLink href="/docs/runtime/wire-format">Runtime › Wire format</DocsLink>.
      </p>

      <ToolDoc
        name='<cast:query target="@PEER">'
        signature={'<cast:query target="@PEER">\n  QUESTION\n</cast:query>'}
        kind="tag"
        summary={<>Ask a peer agent a question and wait for its answer. The body of the tag is the question; the answer arrives on a later turn as <M>&lt;cast:answer request="ID"&gt;</M>.</>}
        params={[
          { name: 'target', type: 'string', required: true, desc: 'Peer alias prefixed with @.' },
        ]}
        returns={[
          { value: '<cast:answer request="ID">BODY</cast:answer>', when: 'peer replies; arrives as inbound stimulus on a later turn' },
          { value: '<cast:pending request="ID">REASON</cast:pending>', when: "peer's owner has not granted the reach yet; the query is parked, answer or rejection follows" },
          { value: '<cast:rejection request="ID">REASON</cast:rejection>', when: 'delivery fails (peer offline, ACL denied)' },
        ]}
        notes="Gated by the peer's q ACL bit toward this agent."
      />

      <ToolDoc
        name='<cast:request target="@PEER">'
        signature={'<cast:request target="@PEER">\n  MESSAGE_BODY\n</cast:request>'}
        kind="tag"
        summary="Fire-and-forget message to a peer agent. No reply expected. Returns an id; if delivery is rejected later, a rejection tag carrying that id arrives."
        params={[
          { name: 'target', type: 'string', required: true, desc: 'Peer alias prefixed with @.' },
        ]}
        returns={[
          { value: '(nothing inline)', when: 'always — fire-and-forget' },
          { value: '<cast:rejection request="ID">REASON</cast:rejection>', when: 'delivery fails; arrives on a later turn' },
        ]}
        notes="Gated by the peer's r ACL bit."
      />

      <ToolDoc
        name='<cast:answer request="ID">'
        signature={'<cast:answer request="ID">\n  ANSWER_BODY\n</cast:answer>'}
        kind="tag"
        summary={<>Reply to an inbound peer query. The request id is the one carried on the inbound <M>&lt;cast:query&gt;</M>.</>}
        params={[
          { name: 'request', type: 'string', required: true, desc: 'The id from the inbound query.' },
        ]}
        returns={[
          { value: '(nothing inline)', when: 'always — answer is routed to the original querier and the request closes server-side' },
        ]}
      />

      <H2>Peer awareness</H2>

      <ToolDoc
        name="agent__list_peers"
        summary="List peer agents and your relationship with each — who you can query, who can message you, per-channel capability summary. Sharded channels render as name~* — substitute your own qualifier to address a sub-conversation."
        returns={[
          { value: '- ALIAS (CANONICAL_ADDRESS)[: DESCRIPTION]', when: 'one block header per peer' },
          { value: '  on CHANNEL|CHANNEL~*: CAPABILITIES', when: 'one indented line per channel under each peer' },
          { value: 'No peer agents configured.', when: 'no peers' },
        ]}
      />

      <ToolDoc
        name="agent__list_channels"
        summary="List the channels where this conversation's participant is placed — the rooms conversation__push_to_participant can land in. The agent itself and operator surfaces see every configured channel. Sharded channels render as name~*."
        returns={[
          { value: '- CHANNEL[~*] — your access: BITS', when: 'one per placed channel; markers for visibility-off and missing config' },
          { value: 'No channels to list.', when: 'caller is placed nowhere' },
        ]}
      />

      <ToolDoc
        name="agent__list_participants"
        summary="List the members of a channel you are placed in, as identities in the exact form push_to_participant accepts, with day-level recency. Scoped by caller standing: a cell can list exactly what the push gate would let it reach, and a query outside its rooms is denied without revealing whether the channel exists. The agent itself and operator surfaces get unfiltered views — and the agent-wide registry when no channel is in play."
        params={[
          { name: 'channel', type: 'string', desc: 'Optional. Accepts name~qualifier (qualifier ignored — shards share membership). Omitted: the current channel for members, the registry for the agent itself and operator surfaces.' },
        ]}
        returns={[
          { value: 'Members of "CHANNEL":', when: 'room view header' },
          { value: '- IDENTITY (last active: YYYY-MM-DD | no session yet)', when: 'one per user member' },
          { value: '- IDENTITY — peer agent (request counterparty, not a push target)', when: 'one per placed peer agent' },
          { value: '- IDENTITY (last active: ISO_TIMESTAMP)', when: 'registry view rows (under a Participants: header)' },
          { value: 'You are not authorized on channel "CHANNEL".', when: 'caller not placed there — same wording whether or not the channel exists' },
        ]}
      />

      <H2>Request tracking</H2>

      <ToolDoc
        name="request__list"
        summary="List open requests for the current channel and participant. Shows both inbound (queries you received) and outbound (queries you sent), with status and age."
        returns={[
          { value: '## Outbound (queries you sent)', when: 'section header — present if any outbound rows' },
          { value: '- [STATUS] REQUEST_ID → TARGET_AGENT (TARGET_CHANNEL) — AGE', when: 'one per outbound row' },
          { value: '## Inbound (queries you received)', when: 'section header — present if any inbound rows' },
          { value: '- [STATUS] REQUEST_ID from FROM_AGENT — AGE', when: 'one per inbound row' },
          { value: 'No requests found for this context.', when: 'no rows in either direction' },
        ]}
      />

      <ToolDoc
        name="request__close"
        summary="Close a request by ID. Closing an outbound request means 'I no longer need this answer.' Closing an inbound request means 'I am declining this' and sends a rejection back to the requester."
        params={[
          { name: 'request_id', type: 'string', required: true, desc: 'The request ID to close.' },
        ]}
        returns={[
          { value: 'Closed outbound request ID.', when: 'closing your own outbound request' },
          { value: 'Closed inbound request ID and sent rejection.', when: 'declining an inbound request' },
          { value: 'Request ID not found or already closed.', when: 'unknown or already-closed id' },
          { value: 'Request ID belongs to a different context.', when: 'wrong channel or participant scope' },
        ]}
      />

      <ToolDoc
        name="request__close_all"
        summary="Close all open requests for the current channel and participant. Sends rejections for every inbound request."
        returns={[
          { value: 'Closed N inbound + M outbound requests.', when: 'success' },
          { value: 'No open requests to close.', when: 'nothing was open' },
        ]}
      />

      <H2>Scheduling</H2>
      <p style={proseP}>
        A task is an independent agent session that runs later — it spawns a
        full agent with all tools. Use tasks for things that need to happen at
        a future time or on a schedule, not for things you can do now.
      </p>

      <ToolDoc
        name="task__schedule"
        summary={<>Schedule a deferred or recurring task. Cron schedules use the agent's timezone by default. Bare ISO timestamps (no Z, no offset) are interpreted as agent-local.</>}
        params={[
          { name: 'prompt', type: 'string', required: true, desc: <>What the agent should do when the task runs. Include all necessary context — wrap output in <M>&lt;cast:internal&gt;</M> to suppress delivery.</> },
          { name: 'schedule_type', type: "'cron' | 'once'", required: true, desc: 'cron = recurring at specific times; once = run once at a specific time.' },
          { name: 'schedule_value', type: 'string', required: true, desc: 'cron: "0 10 * * *" (10am local). once: ISO-8601, e.g. "2026-02-01T15:30:00" (agent-local) or with offset "…-05:00".' },
          { name: 'timezone', type: 'IANA timezone', desc: 'Override agent\'s default timezone. Specify only when scheduling for a different tz.' },
        ]}
        returns={[
          { value: 'Task scheduled (ID): SCHEDULE_TYPE - SCHEDULE_VALUE', when: 'success' },
          { value: 'Invalid cron: "VALUE". …', when: 'cron parse failure' },
          { value: 'Invalid timestamp: "VALUE". …', when: 'once-mode timestamp parse failure' },
          { value: 'Invalid timezone: "TIMEZONE". Use IANA format like "America/New_York" or "Europe/London".', when: 'invalid timezone' },
        ]}
      />

      <ToolDoc
        name="task__list"
        summary="List scheduled tasks (active and paused). Completed and cancelled tasks are not shown."
        returns={[
          { value: 'Scheduled tasks:', when: 'header line' },
          { value: '- [ID] PROMPT_PREVIEW... (SCHEDULE_TYPE: SCHEDULE_VALUE) - STATUS, next: ISO_TIMESTAMP', when: 'one per task' },
          { value: 'No scheduled tasks.', when: 'no tasks' },
        ]}
      />

      <ToolDoc
        name="task__pause"
        summary="Pause a scheduled task. It will not run until resumed."
        params={[
          { name: 'task_id', type: 'string', required: true, desc: 'The task ID to pause.' },
        ]}
        returns={[
          { value: 'Task ID paused.', when: 'success' },
          { value: 'Task ID not found.', when: 'unknown id' },
          { value: 'Unauthorized: cannot pause this task.', when: 'task belongs to a different scope' },
        ]}
      />

      <ToolDoc
        name="task__resume"
        summary="Resume a paused task. The next_run is recomputed for cron tasks so stale schedules don't fire immediately."
        params={[
          { name: 'task_id', type: 'string', required: true, desc: 'The task ID to resume.' },
        ]}
        returns={[
          { value: 'Task ID resumed.', when: 'success' },
          { value: 'Task ID not found.', when: 'unknown id' },
          { value: 'Unauthorized: cannot resume this task.', when: 'task belongs to a different scope' },
        ]}
      />

      <ToolDoc
        name="task__cancel"
        summary="Cancel and delete a scheduled task."
        params={[
          { name: 'task_id', type: 'string', required: true, desc: 'The task ID to cancel.' },
        ]}
        returns={[
          { value: 'Task ID cancelled.', when: 'success' },
          { value: 'Task ID not found.', when: 'unknown id' },
          { value: 'Unauthorized: cannot cancel this task.', when: 'task belongs to a different scope' },
        ]}
      />

      <ToolDoc
        name="task__list_runs"
        summary="View recent task dispatch history. Shows when tasks fired and what they were."
        params={[
          { name: 'limit', type: 'integer 1–100', default: '20', desc: 'Number of recent runs to return.' },
        ]}
        returns={[
          { value: 'Recent task runs:', when: 'header line' },
          { value: '- ISO_TIMESTAMP | PROMPT_PREVIEW', when: 'one per dispatch' },
          { value: 'No task runs found.', when: 'no history' },
        ]}
      />

      <H2>Time</H2>

      <ToolDoc
        name="time__now"
        summary="Get the current time as a human-readable string with day of week, date, time, and timezone. Defaults to the agent's timezone."
        params={[
          { name: 'timezone', type: 'IANA timezone', desc: 'Override the default, e.g. "America/New_York", "Asia/Tokyo".' },
        ]}
        returns={[
          { value: 'WEEKDAY ISO_TIMESTAMP_WITH_OFFSET', when: 'success' },
          { value: 'Invalid timezone: "TIMEZONE". …', when: 'tz not recognised' },
        ]}
        notes="Use rather than guessing — the agent's wall clock isn't carried in the conversation context past the system-prompt assembly time."
      />

      <ToolDoc
        name="time__convert"
        summary="Convert a time between timezones. Returns formatted times in both. Use for cross-timezone scheduling — never compute offsets yourself (DST and historical offsets aren't safe to derive)."
        params={[
          { name: 'time', type: 'ISO 8601 string', required: true, desc: 'Time to convert.' },
          { name: 'from_tz', type: 'IANA timezone', required: true, desc: 'Source timezone.' },
          { name: 'to_tz', type: 'IANA timezone', required: true, desc: 'Target timezone.' },
        ]}
        returns={[
          { value: 'FROM_TZ: WEEKDAY ISO_WITH_OFFSET\nTO_TZ: WEEKDAY ISO_WITH_OFFSET', when: 'success' },
          { value: 'Invalid timezone: "TIMEZONE". …', when: 'tz not recognised' },
          { value: 'Invalid time: "TIME". …', when: 'time parse failure' },
        ]}
      />

      <H2>Filesystem watches</H2>
      <p style={proseP}>
        A feed is an ordered, append-only JSONL stream that peers can observe.
        The framework assigns a monotonic id starting at 1 so watchers can
        cursor through rows. Use feeds for coordination — meeting points
        between channels or agents, not as journals or audit logs.
      </p>

      <ToolDoc
        name="file__append_feed"
        summary="Append a row to a feed at the given container path. Creates the file if missing; the parent directory must already exist on a writable mount."
        params={[
          { name: 'path', type: 'string', required: true, desc: 'Container-side path, e.g. /memory/letter.jsonl.' },
          { name: 'data', type: 'JSON value', required: true, desc: 'Row content — any JSON-serializable value. Surfaced to humans/transports by convention.' },
          { name: 'meta', type: 'JSON value', desc: 'Coordination metadata — agents-only convention, not surfaced to humans.' },
        ]}
        returns={[
          { value: 'Appended row id=N to PATH.', when: 'success' },
          { value: 'Feed corruption detected at row offset N: REASON. Refusing to append. Operator must repair.', when: 'feed file is corrupted' },
          { value: 'Parent directory does not exist: HOST_PATH. …', when: 'missing parent dir' },
          { value: 'No writable mount matches parent of PATH.', when: 'path not on a writable mount' },
          { value: 'Parent directory is a symlink (rejected for security): HOST_PATH.', when: 'parent resolves to symlink' },
          { value: 'Parent directory is read-only; cannot append.', when: 'mount is read-only' },
        ]}
        notes="Best-effort, not transactional. Fails closed on corruption (bad parse, missing id, non-monotonic) — operator must repair. Not a journaling tool — for plain JSONL diaries, use Write/Edit directly."
      />

      <ToolDoc
        name="file__watch_feed"
        summary={<>Register a watch on a feed. The framework fires <M>&lt;cast:watch&gt;</M> tags into the conversation when peers append rows. Your own appends are auto-suppressed.</>}
        params={[
          { name: 'path', type: 'string', required: true, desc: 'Path to the feed — must already exist. Call file__append_feed first to create.' },
          { name: 'expiresIn', type: 'duration string', desc: 'Format: number + s|m|h|d. Max 30d. Stored but not enforced — watches persist until removed.' },
        ]}
        returns={[
          { value: 'Watch registered on PATH (lastSeenId=N[, expires ISO_TIMESTAMP]).', when: 'success' },
          { value: 'Watch limit reached (CURRENT/CAP). Use file__unwatch to free a slot, or raise fileWatch.maxWatchesPerChannel via Configure.', when: 'per-conversation cap hit' },
          { value: 'Invalid duration: "VALUE". Use format like Ns/Nm/Nh/Nd.', when: 'malformed expiresIn' },
        ]}
        notes="Watches anchor at the feed's current end at registration time — historical rows are not delivered. Per-conversation cap defaults to 3 (configurable via fileWatch.maxWatchesPerChannel)."
      />

      <ToolDoc
        name="file__unwatch"
        summary="Drop a previously registered watch on a feed. Errors if the path is not currently watched in this conversation."
        params={[
          { name: 'path', type: 'string', required: true, desc: 'Container path matching the original file__watch_feed call.' },
        ]}
        returns={[
          { value: 'Watch on PATH removed.', when: 'success' },
          { value: 'No watch on PATH for this conversation.', when: 'no such watch' },
        ]}
      />

      <ToolDoc
        name="file__list_watches"
        summary="List watches active in this conversation. Each entry shows the feed path, the last id observed, when it was registered, and (if set) when it expires."
        returns={[
          { value: 'Watches:', when: 'header line' },
          { value: '- PATH — last id N, registered ISO_TIMESTAMP[, expires ISO_TIMESTAMP]', when: 'one per watch' },
          { value: 'No watches in this conversation.', when: 'no watches' },
        ]}
      />

      <H2>Python (when configured)</H2>
      <p style={proseP}>
        Registered only when the agent has pip.allowed_packages declared in
        its manifest. There is no pip binary in the container — these tools
        install into the agent's persistent venv at
        /home/agent/.python-packages; PYTHONPATH is preconfigured.
      </p>

      <ToolDoc
        name="pip__install"
        summary="Install a Python package. Becomes available to all Python scripts in current and future conversations via standard import."
        params={[
          { name: 'package', type: 'string', required: true, desc: 'Package name, e.g. "duckdb", "pandas". Must be on the agent\'s allowed_packages list.' },
          { name: 'version', type: 'string', desc: 'Version constraint, e.g. "1.2.0", ">=2.0", "<3.0,>=2.1".' },
          { name: 'upgrade', type: 'boolean', default: 'false', desc: 'Upgrade to the latest version if already installed.' },
        ]}
        returns={[
          { value: 'Installed PACKAGE VERSION. Available via `import PACKAGE` in Python scripts.', when: 'fresh install or upgrade' },
          { value: 'PACKAGE is already installed (version VERSION). Use upgrade: true to update.', when: 'package already present and upgrade=false' },
          { value: 'Package "PACKAGE" is not in the allowed list. Allowed: ALLOWED_LIST', when: 'package outside allowed_packages' },
          { value: 'pip install failed: STDERR_TAIL', when: 'pip itself errored' },
        ]}
        notes="Runs pip inside a throwaway container built from the agent image — never on the host. Cross-platform safe (wheels match the container, not the host)."
      />

      <ToolDoc
        name="pip__list"
        summary="List Python packages installed for this agent."
        returns={[
          { value: 'PACKAGE VERSION', when: 'one per installed package' },
          { value: 'No Python packages installed. Use pip__install to add packages.', when: 'venv is empty' },
        ]}
      />

      <H2>Claude Code SDK tools</H2>
      <p style={proseP}>
        These come from the Claude Code SDK and are always present. They
        operate inside the container — no host reach. Cast doesn't define
        their signatures; see the{' '}
        <a href="https://docs.claude.com/en/docs/claude-code/sdk">SDK docs</a>{' '}
        for parameter details.
      </p>
      <p style={proseP}>
        <strong>Filesystem:</strong> Read, Write, Edit, Glob, Grep, NotebookEdit.
        Confined to the container's mounts.
        <br />
        <strong>Shell:</strong> Bash. Host secrets are stripped from
        subprocess environments before each call.
        <br />
        <strong>Web:</strong> WebSearch. Runs server-side via the SDK — works
        even when the container's network is sdk-only.
        <br />
        <strong>Sub-agents:</strong> Task, TaskOutput, TaskStop. Spawn and
        manage child Claude sessions inside the same container.
        <br />
        <strong>Planning:</strong> TodoWrite, Skill, ToolSearch. In-session
        scratch planning, skill invocation, deferred-tool lookup.
      </p>
      <p style={proseP}>
        <strong>Disabled by Cast:</strong> WebFetch (use the{' '}
        <DocsLink href="/docs/extensions/web-fetch">web-fetch extension</DocsLink>{' '}
        instead — it runs host-side with domain policy, SSRF protection, and
        cleaned-markdown output), AskUserQuestion (conversations are async —
        no interactive prompt), and Config (mutates SDK runtime including
        permission mode).
      </p>

      <H2>Extension tools</H2>
      <p style={proseP}>
        Each active extension contributes its own tools. Full per-extension
        signatures live on the extension's own page; this is the index.
      </p>
      <p style={proseP}>
        <DocsLink href="/docs/extensions/calendar">calendar</DocsLink> —
        calendar__list, calendar__get, calendar__changes, calendar__create,
        calendar__update, calendar__delete.
        <br />
        <DocsLink href="/docs/extensions/email">email</DocsLink> —
        email__search, email__fetch, email__send, email__list_folders,
        email__subscribe, email__unsubscribe, email__list_subscriptions.
        <br />
        <DocsLink href="/docs/extensions/web-fetch">web-fetch</DocsLink> —
        web__fetch.
        <br />
        <DocsLink href="/docs/extensions/whatsapp">whatsapp</DocsLink> —
        whatsapp__chats, whatsapp__messages, whatsapp__download,
        whatsapp__send, whatsapp__watch, whatsapp__unwatch,
        whatsapp__list_watches.
      </p>
    </DocsLayout>
  );
}
