/**
 * time tool registrar — extracted from mcp-server.ts.
 *
 * Always registered. Defaults to the agent's resolved timezone (the same
 * value used elsewhere in tool output rendering) when callers don't pass
 * an explicit IANA tz.
 */
import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { textResult, type ToolResult } from '../extensions/registry.js';
import { toZonedIso } from '../lib/utils.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAgentContext } from './mcp-server.js';

function validateTimezone(tz: string): string | null {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `Invalid timezone: "${tz}". Use IANA format like "America/New_York" or "Asia/Tokyo".`;
  }
}

function handleTimeNow(timezone: string | undefined, agentTz: string): ToolResult {
  const tz = timezone || agentTz;
  const err = validateTimezone(tz);
  if (err) return textResult(err, true);
  return textResult(toZonedIso(new Date(), tz, { weekday: true }));
}

function handleTimeConvert(args: { time: string; from_tz: string; to_tz: string }): ToolResult {
  for (const tz of [args.from_tz, args.to_tz]) {
    const err = validateTimezone(tz);
    if (err) return textResult(err, true);
  }
  const parsed = new Date(args.time);
  if (isNaN(parsed.getTime())) {
    return textResult(`Invalid time: "${args.time}". Use ISO 8601 format (e.g. "2026-04-03T14:30:00Z").`, true);
  }
  return textResult(
    `${args.from_tz}: ${toZonedIso(parsed, args.from_tz, { weekday: true })}\n` +
    `${args.to_tz}: ${toZonedIso(parsed, args.to_tz, { weekday: true })}`,
  );
}

export function registerTimeTools(server: McpServer, ctx: McpAgentContext, agentTz: string): void {
  const disabled = (name: string) => isToolDisabled(name, ctx.disabledTools ?? []);

  if (!disabled('time__now')) server.tool(
    'time__now',
    `Get the current time. Returns a formatted human-readable string with day of week, date, time, and timezone. Defaults to agent timezone (${agentTz}) if no timezone specified. Use this instead of guessing the current time.`,
    {
      timezone: z.string().optional().describe('IANA timezone (e.g. "America/New_York", "Asia/Tokyo"). Defaults to agent timezone.'),
    },
    async (args) => handleTimeNow(args.timezone, agentTz),
  );

  if (!disabled('time__convert')) server.tool(
    'time__convert',
    'Convert a time between timezones. Returns human-readable formatted times in both timezones. Use this for cross-timezone scheduling — never compute timezone offsets yourself.',
    {
      time: z.string().describe('Time to convert (ISO 8601, e.g. "2026-04-03T14:30:00Z" or "2026-04-03T10:30:00-04:00")'),
      from_tz: z.string().describe('Source IANA timezone (e.g. "America/New_York")'),
      to_tz: z.string().describe('Target IANA timezone (e.g. "Asia/Tokyo")'),
    },
    async (args) => handleTimeConvert(args),
  );
}
