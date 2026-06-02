/**
 * task__* tool registrar — extracted from mcp-server.ts.
 *
 * Tasks are deferred or recurring agent sessions stored in the per-agent
 * state store. Cron schedules are validated and previewed at create time;
 * one-shot timestamps without an explicit zone offset are interpreted in
 * the agent's timezone.
 */
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { textResult, type ToolResult } from '../extensions/registry.js';
import { attachZoneOffset, generateId, roughTimeAgo, toZonedIso } from '../lib/utils.js';
import { logger } from '../logger.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAgentContext, ToolCtx } from './mcp-server.js';

const TASK_SCHEDULE_DESC =
  `Schedule a deferred or recurring task. A task is an independent agent session that runs later — it spawns a full agent with all tools. Use tasks for things that need to happen at a future time or on a schedule. Do NOT use tasks for things you can do right now in the current conversation.

A task prompt can be high-level and involve multiple steps (e.g., "fetch the weather, summarize it, and send it to the user"). The task agent figures out how to execute it.

WHEN TO USE A TASK vs DOING IT NOW:
• "remind me in 1 hour" → task (deferred)
• "check the weather every morning" → task (recurring)
• "what's the weather?" → just do it now, no task needed

MESSAGING BEHAVIOR — The task agent's output is sent to the user. Wrap output in <cast:internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
• Always produce output (e.g., reminders, daily briefings)
• Only produce output when there's something to report (e.g., "notify me if...")
• Suppress output with <cast:internal> tags (background maintenance tasks)

SCHEDULE VALUE FORMAT:
• cron: Standard cron expression (e.g., "0 10 * * *" for daily at 10am). Interpreted in your timezone by default. Pass the timezone parameter only when scheduling for a different tz than your own.
• once: ISO-8601 timestamp. Bare values like "2026-02-01T15:30:00" are interpreted in your timezone. Use an explicit offset ("…-05:00") or "Z" only if you mean a specific UTC/offset value.`;

function handleTaskSchedule(
  args: { prompt: string; schedule_type: 'cron' | 'once'; schedule_value: string; timezone?: string },
  ctx: ToolCtx,
): ToolResult {
  let nextRun: string | null = null;

  if (args.schedule_type === 'cron') {
    const tz = args.timezone ?? ctx.agentTz;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return textResult(`Invalid timezone: "${tz}". Use IANA format like "America/New_York" or "Europe/London".`, true);
    }
    const fields = args.schedule_value.trim().split(/\s+/);
    if (fields.length !== 5) {
      return textResult(`Invalid cron: "${args.schedule_value}". Must be exactly 5 fields (minute hour day month weekday), e.g. "0 9 * * *".`, true);
    }
    try {
      const interval = CronExpressionParser.parse(args.schedule_value, { tz });
      nextRun = interval.next().toISOString();
    } catch {
      return textResult(`Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`, true);
    }
  } else if (args.schedule_type === 'once') {
    // Bare ISO (no Z, no offset) = agent-local. Explicit offset / Z = as written.
    const bare = !/[Zz]|[+-]\d{2}:\d{2}$/.test(args.schedule_value);
    const tz = args.timezone ?? ctx.agentTz;
    const normalized = bare ? attachZoneOffset(args.schedule_value, tz) : args.schedule_value;
    const scheduled = new Date(normalized ?? args.schedule_value);
    if (!normalized || isNaN(scheduled.getTime())) {
      return textResult(`Invalid timestamp: "${args.schedule_value}". Use ISO 8601 like "2026-02-01T15:30:00" (your timezone) or with explicit offset like "2026-02-01T15:30:00-05:00".`, true);
    }
    nextRun = scheduled.toISOString();
  }

  const taskId = generateId('task');
  ctx.store.createTask({
    id: taskId,
    address: ctx.agentId,
    prompt: args.prompt,
    schedule_type: args.schedule_type,
    schedule_value: args.schedule_value,
    timezone: args.timezone ?? null,
    channel: ctx.channelName,
    target_participant: ctx.participant,
    next_run: nextRun,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info({ taskId, agentFolder: ctx.agentFolder, scheduleType: args.schedule_type, nextRun }, 'Task created via MCP');
  return textResult(`Task scheduled (${taskId}): ${args.schedule_type} - ${args.schedule_value}`);
}

function handleTaskList(ctx: ToolCtx): ToolResult {
  const allTasks = ctx.store.getAllTasks() ?? [];
  const actionable = allTasks.filter((t) => t.status === 'active' || t.status === 'paused' || t.status === 'running');
  const tasks = ctx.participant
    ? actionable.filter((t) => t.target_participant === ctx.participant)
    : actionable.filter((t) => t.address === ctx.agentId);

  if (tasks.length === 0) return textResult('No scheduled tasks.');
  const formatted = tasks
    .map((t) => {
      const next = t.next_run ? toZonedIso(new Date(t.next_run), ctx.agentTz) : 'N/A';
      return `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${next}`;
    })
    .join('\n');
  return textResult(`Scheduled tasks:\n${formatted}`);
}

function handleTaskStatusChange(
  taskId: string,
  newStatus: 'paused' | 'active',
  ctx: ToolCtx,
): ToolResult {
  const task = ctx.store.getTaskById(taskId);
  if (!task) return textResult(`Task ${taskId} not found.`, true);
  if (ctx.participant && task.target_participant !== ctx.participant) {
    return textResult(`Unauthorized: cannot ${newStatus === 'paused' ? 'pause' : 'resume'} this task.`, true);
  }
  if (!ctx.participant && task.address !== ctx.agentId) {
    return textResult(`Unauthorized: cannot ${newStatus === 'paused' ? 'pause' : 'resume'} this task.`, true);
  }
  ctx.store.updateTask(taskId, { status: newStatus });
  // Recalculate next_run on resume so stale cron tasks don't fire immediately
  if (newStatus === 'active' && task.schedule_type === 'cron') {
    try {
      const nextRun = CronExpressionParser.parse(task.schedule_value, { tz: task.timezone ?? 'UTC' }).next().toISOString();
      ctx.store.updateTask(taskId, { next_run: nextRun });
    } catch { /* invalid cron — leave next_run as-is */ }
  }
  logger.info({ taskId, agentFolder: ctx.agentFolder }, `Task ${newStatus === 'paused' ? 'paused' : 'resumed'} via MCP`);
  return textResult(`Task ${taskId} ${newStatus === 'paused' ? 'paused' : 'resumed'}.`);
}

function handleTaskCancel(taskId: string, ctx: ToolCtx): ToolResult {
  const task = ctx.store.getTaskById(taskId);
  if (!task) return textResult(`Task ${taskId} not found.`, true);
  if (ctx.participant && task.target_participant !== ctx.participant) {
    return textResult('Unauthorized: cannot cancel this task.', true);
  }
  if (!ctx.participant && task.address !== ctx.agentId) {
    return textResult('Unauthorized: cannot cancel this task.', true);
  }
  ctx.store.deleteTask(taskId);
  logger.info({ taskId, agentFolder: ctx.agentFolder }, 'Task cancelled via MCP');
  return textResult(`Task ${taskId} cancelled.`);
}

function handleTaskListRuns(limit: number, ctx: ToolCtx): ToolResult {
  const runs = ctx.store.getRecentTaskRuns(ctx.participant, limit) ?? [];
  if (runs.length === 0) return textResult('No task runs found.');
  const formatted = runs.map((r) => {
    const prompt = r.prompt ? r.prompt.slice(0, 80) : '(unknown)';
    const when = toZonedIso(new Date(r.run_at), ctx.agentTz);
    return `- ${when} | ${prompt}`;
  }).join('\n');
  return textResult(`Recent task runs:\n${formatted}`);
}

export function registerTaskTools(server: McpServer, ctx: McpAgentContext, toolCtx: ToolCtx): void {
  const disabled = (name: string) => isToolDisabled(name, ctx.disabledTools ?? []);

  if (!disabled('task__schedule')) server.tool(
    'task__schedule', TASK_SCHEDULE_DESC,
    {
      prompt: z.string().describe('What the agent should do when the task runs. Include all necessary context in the prompt.'),
      schedule_type: z.enum(['cron', 'once']).describe('cron=recurring at specific times, once=run once at specific time'),
      schedule_value: z.string().describe('cron: "0 10 * * *" (10am local) | once: ISO-8601, bare values are agent-local (e.g. "2026-02-01T15:30:00")'),
      timezone: z.string().optional().describe('IANA timezone override (e.g. "America/New_York"). Defaults to your timezone. Specify only when scheduling for a different tz than your own.'),
    },
    async (args) => handleTaskSchedule(args, toolCtx),
  );

  if (!disabled('task__list')) server.tool(
    'task__list', 'List scheduled tasks (active and paused). Completed/cancelled tasks are not shown.',
    {},
    async () => handleTaskList(toolCtx),
  );

  if (!disabled('task__pause')) server.tool(
    'task__pause', 'Pause a scheduled task. It will not run until resumed.',
    { task_id: z.string().describe('The task ID to pause') },
    async (args) => handleTaskStatusChange(args.task_id, 'paused', toolCtx),
  );

  if (!disabled('task__resume')) server.tool(
    'task__resume', 'Resume a paused task.',
    { task_id: z.string().describe('The task ID to resume') },
    async (args) => handleTaskStatusChange(args.task_id, 'active', toolCtx),
  );

  if (!disabled('task__cancel')) server.tool(
    'task__cancel', 'Cancel and delete a scheduled task.',
    { task_id: z.string().describe('The task ID to cancel') },
    async (args) => handleTaskCancel(args.task_id, toolCtx),
  );

  if (!disabled('task__list_runs')) server.tool(
    'task__list_runs', 'View recent task dispatch history. Shows when tasks were fired and what they were.',
    { limit: z.number().int().positive().max(100).default(20).describe('Number of recent runs to return (default 20, max 100)') },
    async (args) => handleTaskListRuns(args.limit, toolCtx),
  );
}
