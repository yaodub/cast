/**
 * Cast's stance toward the bundled Claude Code SDK surface inside agent
 * containers — the single file to touch when an SDK bump ships new tools or
 * features.
 *
 * Layering rule: mechanism in the image, policy on the wire.
 *  - The agent-runner image hard-codes only its own contract invariants
 *    (AskUserQuestion, Config — see DISALLOWED_TOOLS in agent-runner).
 *  - Everything that is a *decision about what agents may do* lives here and
 *    reaches the container per spawn: tool names via the init wire's
 *    disabledTools (merged in applyBuiltinToolPolicy), feature flags via
 *    container env (SDK_ENV_FLAGS, injected in buildContainerArgs). Changes
 *    apply on the next spawn — no image rebuild.
 *  - Per-agent and per-channel disabled_tools merge upstream of this module
 *    (capability resolution, channel config); this table is the fleet-wide
 *    base of that chain. Blueprint config can only add blocks, never subtract
 *    these — the only conditionality (WebFetch by network mode) lives here.
 *
 * Scope: this table feeds the spawn wire ONLY — never mcp-server's
 * disabledTools gating. isToolDisabled() pattern-matches, and fleet-level SDK
 * blocks must not accidentally gate Cast's own MCP tools.
 *
 * Migration ordering: a runner image built before these flags moved host-side
 * sets them redundantly — harmless. The unsafe order is a NEW image with an
 * OLD host (flags silently lost): land host changes before or with image
 * rebuilds.
 */

/**
 * Built-in SDK tools removed on every spawn, regardless of agent config.
 * Two reasons to be on this list:
 *  - envelope-impossible: the container has no interactive user and no desktop;
 *  - Cast sovereignty: the SDK ships a single-user feature Cast replaces with a
 *    gateway-mediated, multi-user equivalent.
 *
 *  - CronCreate/CronList/CronDelete/ScheduleWakeup: the bundled CLI's
 *    session-scoped scheduler competes with Cast's task__* scheduling tools
 *    and its tasks die with the conversation. SDK_ENV_FLAGS kills the
 *    scheduler itself as the suspenders.
 *  - RemoteTrigger: creates persistent Routines on claude.ai cloud infra
 *    (backs /schedule) — scheduling outside Cast entirely; NOT covered by
 *    DISABLE_CRON.
 *  - PushNotification: desktop/phone push via Anthropic infra — reaching the
 *    user is the gateway's job, and there's no desktop in the container.
 *  - ShareOnboardingGuide: uploads files to a claude.ai share link — external
 *    publish surface with no container use case.
 *  - EnterPlanMode/ExitPlanMode: plan approval is interactive — no interactive
 *    user in the container path.
 *  - TaskCreate/TaskGet/TaskList/TaskUpdate: the SDK's session-checklist tools
 *    (TodoWrite successor) collide in name with Cast's task__* scheduling
 *    tools — "list my tasks" must mean the scheduler. SDK_ENV_FLAGS reverts
 *    the checklist to the distinctly-named TodoWrite. (TaskOutput/TaskStop are
 *    unrelated background-task tools — kept.)
 */
const BUILTIN_DISALLOWED_TOOLS = [
  'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'ShareOnboardingGuide',
  'EnterPlanMode', 'ExitPlanMode',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
];

/**
 * SDK feature kill-switches for features that aren't tools. Injected as
 * container env by buildContainerArgs; the runner's `sdkEnv = {...process.env}`
 * carries them into the SDK without any runner-side knowledge.
 */
export const SDK_ENV_FLAGS: Record<string, string> = {
  // Kill the bundled CLI's session-scoped cron scheduler outright. Cast owns
  // scheduling (task__* tools + schedule.txt). Reaches past tool blocking:
  // nothing fires between turns, /loop unavailable.
  CLAUDE_CODE_DISABLE_CRON: '1',
  // Revert the session checklist from TaskCreate/TaskGet/TaskList/TaskUpdate
  // back to TodoWrite (see BUILTIN_DISALLOWED_TOOLS on the name collision).
  // Polarity mismatch with DISABLE_CRON is upstream's naming — Task* shipped
  // behind an ENABLE_* rollout flag; there is no CLAUDE_CODE_DISABLE_TASKS.
  CLAUDE_CODE_ENABLE_TASKS: '0',
  // Disable the bundled CLI's auto-memory. It injects MEMORY.md guidance into
  // the system prompt and writes to ~/.claude/projects/<hash>/memory/ — Cast
  // owns memory (the agent's /memory volume).
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

/**
 * Built-in tool policy for a spawn: the unconditional BUILTIN_DISALLOWED_TOOLS
 * plus WebFetch, gated on network egress. WebFetch fetches client-side from
 * the container, so network mode is its boundary:
 *  - `full`: keep it — the agent can already reach any host (Bash, any MCP
 *    tool), and it's the only fetch path for full-net authoring consoles.
 *  - else: remove it — Cast routes fetching through the host-side web-fetch
 *    extension; under the firewall the built-in only fails or bypasses the gate.
 * Returns the disabled-tools list to send to the runner.
 */
export function applyBuiltinToolPolicy(
  disabledTools: readonly string[],
  containerNetwork: string | undefined,
): string[] {
  const tools = [...disabledTools, ...BUILTIN_DISALLOWED_TOOLS];
  if (containerNetwork !== 'full') tools.push('WebFetch');
  return tools;
}
