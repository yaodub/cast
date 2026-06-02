// ---------------------------------------------------------------------------
// Built-in MCP Tools
// ---------------------------------------------------------------------------

/** Canonical registry of built-in MCP tools. domain__verb_object naming convention. */
export const BUILT_IN_TOOLS = {
  'task__schedule': 'Schedule a deferred or recurring task',
  'task__list': 'List scheduled tasks',
  'task__pause': 'Pause a scheduled task',
  'task__resume': 'Resume a paused task',
  'task__cancel': 'Cancel a scheduled task',
  'task__list_runs': 'View recent task dispatch history',
  'conversation__list_summaries': 'List recent conversations and summaries',
  'conversation__write_summary': 'Write a summary of the current conversation',
  'conversation__end': 'End the current conversation after a cooldown period',
  'conversation__push_to_channel': 'Push a turn into a different channel for the current participant (optionally on another agent)',
  'conversation__push_to_participant': 'Push a turn into another participant\'s conversation on this agent',
  'message_log__search': 'Search past messages by keyword',
  'time__now': 'Get the current time in a given timezone',
  'time__convert': 'Convert a time between timezones',
  'pip__install': 'Install a Python package',
  'pip__list': 'List installed Python packages',
} as const;

export type BuiltInToolName = keyof typeof BUILT_IN_TOOLS;

export const TOOL_DOMAINS = ['task', 'conversation', 'message_log', 'time', 'pip'] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

/**
 * Check whether a tool is disabled by a disabled_tools list.
 * Supports exact match and domain globs (e.g. "task__*").
 */
export function isToolDisabled(toolName: string, disabledTools: string[]): boolean {
  for (const pattern of disabledTools) {
    if (pattern === toolName) return true;
    if (pattern.endsWith('__*')) {
      const prefix = pattern.slice(0, -1); // "task__*" → "task__"
      if (toolName.startsWith(prefix)) return true;
    }
  }
  return false;
}
