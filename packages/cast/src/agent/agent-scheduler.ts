/**
 * AgentScheduler — per-agent scheduler for DB tasks and declarative schedule.txt entries.
 *
 * Extracted from AgentManager. Owns the polling loop, cron parsing, and
 * task dispatch. The only coupling to the rest of the system is via the
 * `route()` callback provided at construction.
 */
import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE, agentPath } from '../config.js';
import { readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';
import type { LogEventFn } from './agent-db.js';
import type { Routing } from './agent-bus-payload.js';
import type { AgentStateStore } from './state-store.js';
import type { RouteResult } from '../types.js';

// --- Types ---

interface ScheduledMessage {
  schedule: string;
  channel: string;
  qualifier?: string;
  message: string;
  timezone: string | null;
  nextRun: string;
}

type TzPrefixResult =
  | { kind: 'none' }
  | { kind: 'server' }
  | { kind: 'iana'; value: string }
  | { kind: 'invalid'; value: string };

function parseTzPrefix(token: string | undefined): TzPrefixResult {
  if (!token || !token.startsWith('TZ=')) return { kind: 'none' };
  const value = token.slice(3);
  if (value === 'server') return { kind: 'server' };
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return { kind: 'iana', value };
  } catch {
    return { kind: 'invalid', value };
  }
}

interface AgentSchedulerOpts {
  folder: string;
  agentId: string;
  store: AgentStateStore;
  route: (address: string, senderId: string, text: string, routing?: Routing) => Promise<RouteResult>;
  /** Draft-mode readiness check. Scheduler dispatches bypass the bus (where the
   *  draft check lives in `handleBusMessage`), so the gate is mirrored here so
   *  a draft agent's cron tasks and schedule.txt entries don't fire. */
  isDraft: () => boolean;
  onLogEvent?: LogEventFn;
}

function scheduleKey(msg: ScheduledMessage): string {
  return `${msg.schedule}|${msg.channel}|${msg.qualifier ?? ''}|${msg.message}|${msg.timezone ?? ''}`;
}

export class AgentScheduler {
  private folder: string;
  private address: string;
  private store: AgentStateStore;
  private route: AgentSchedulerOpts['route'];
  private isDraft: () => boolean;
  private logEvent: LogEventFn;

  private scheduledMessages: ScheduledMessage[] = [];
  private lastScheduleContent: string | null = null;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AgentSchedulerOpts) {
    this.folder = opts.folder;
    this.address = opts.agentId;
    this.store = opts.store;
    this.route = opts.route;
    this.isDraft = opts.isDraft;
    this.logEvent = opts.onLogEvent ?? (() => {});
  }

  start(): void {
    // Crash recovery: tasks stuck in 'running' from a previous crash
    const stuckCount = this.store.recoverStuckTasks(this.address);
    if (stuckCount > 0) {
      logger.info({ agentFolder: this.folder, count: stuckCount }, 'Reset stuck running tasks to active');
    }

    // Advance overdue cron tasks to next future occurrence (don't run retroactively)
    this.advanceOverdueCrons();

    // Load declarative scheduled messages
    this.lastScheduleContent = readText(agentPath(this.folder, 'blueprint', 'props', 'schedule.txt'));
    this.scheduledMessages = this.parseScheduleEntries(this.lastScheduleContent);
    if (this.scheduledMessages.length > 0) {
      logger.info({ agentFolder: this.folder, count: this.scheduledMessages.length }, 'Loaded scheduled messages');
    }

    const tick = () => {
      try {
        this.tick();
      } catch (err) {
        logger.error({ agentFolder: this.folder, err }, 'Error in scheduler tick');
        this.logEvent('error', 'scheduler', 'tick_crashed', `Scheduler tick threw: ${String(err)}`);
      }
      this.schedulerTimer = setTimeout(tick, SCHEDULER_POLL_INTERVAL);
      this.schedulerTimer.unref();
    };

    // First tick immediately
    tick();
  }

  stop(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /** Compute the next future cron occurrence. */
  private nextCronRun(cronExpr: string, timezone: string | null): string {
    const interval = CronExpressionParser.parse(cronExpr, { tz: timezone ?? 'UTC' });
    let next = interval.next();
    while (next.toDate().getTime() <= Date.now()) next = interval.next();
    return next.toISOString()!; // CronDate.toISOString() typed as string|null but always returns string
  }

  /** Advance overdue cron tasks to next future occurrence without dispatching. */
  private advanceOverdueCrons(): void {
    const now = new Date().toISOString();
    const tasks = this.store.getTasksForAddress(this.address);
    let advanced = 0;
    for (const task of tasks) {
      if (task.status !== 'active' || task.schedule_type !== 'cron') continue;
      if (!task.next_run || task.next_run >= now) continue;
      const nextRun = this.nextCronRun(task.schedule_value, task.timezone);
      this.store.updateTaskAfterRun(task.id, nextRun, task.last_result ?? '');
      advanced++;
    }
    if (advanced > 0) {
      logger.info({ agentFolder: this.folder, count: advanced }, 'Advanced overdue cron tasks');
    }
  }

  /**
   * Parse schedule.txt content into ScheduledMessage entries.
   * Pure function — takes content as parameter, no file I/O.
   *
   * Format: one entry per line, `[TZ=<iana>|TZ=server] <cron_5_fields>  <channel[~qualifier]>  <message_text>`
   * The TZ prefix is optional. When omitted or `TZ=server`, the server timezone is used.
   * Invalid IANA zones log a warning and skip the entry (same as invalid cron).
   */
  private parseScheduleEntries(content: string | null): ScheduledMessage[] {
    if (!content) return [];

    const messages: ScheduledMessage[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(/\s+/);

      let tz: string | null = null;
      let offset = 0;
      const prefix = parseTzPrefix(parts[0]);
      if (prefix.kind === 'invalid') {
        logger.warn({ agentFolder: this.folder, tz: prefix.value }, 'Invalid TZ in schedule.txt, skipping entry');
        this.logEvent('warn', 'scheduler', 'invalid_tz', `Invalid IANA timezone in schedule.txt: ${prefix.value}`, {
          context: { tz: prefix.value },
        });
        continue;
      }
      if (prefix.kind === 'iana') tz = prefix.value;
      if (prefix.kind !== 'none') offset = 1;

      if (parts.length - offset < 7) continue;

      const schedule = parts.slice(offset, offset + 5).join(' ');
      const channelField = parts[offset + 5]!;
      const message = parts.slice(offset + 6).join(' ');

      const qualifierIdx = channelField.indexOf('~');
      const channel = qualifierIdx === -1 ? channelField : channelField.slice(0, qualifierIdx);
      const qualifier = qualifierIdx === -1 ? undefined : channelField.slice(qualifierIdx + 1);

      try {
        const interval = CronExpressionParser.parse(schedule, { tz: tz ?? TIMEZONE });
        messages.push({
          schedule,
          channel,
          qualifier,
          message,
          timezone: tz,
          nextRun: interval.next().toISOString()!, // CronDate.toISOString() typed as string|null but always returns string
        });
      } catch (err) {
        logger.warn({ agentFolder: this.folder, schedule, err }, 'Invalid cron in schedule.txt');
        this.logEvent('warn', 'scheduler', 'invalid_cron', `Invalid cron expression in schedule.txt: ${schedule}`, {
          context: { schedule, error: String(err) },
        });
      }
    }

    return messages;
  }

  /** Called by AgentManager's watcher subscription when schedule.txt changes. */
  onScheduleChanged(): void {
    const content = readText(agentPath(this.folder, 'blueprint', 'props', 'schedule.txt'));
    if (content === this.lastScheduleContent) return;
    this.lastScheduleContent = content;

    const fresh = this.parseScheduleEntries(content);

    // Build lookup from current entries to preserve nextRun
    const currentByKey = new Map<string, ScheduledMessage>();
    for (const msg of this.scheduledMessages) {
      currentByKey.set(scheduleKey(msg), msg);
    }
    for (const msg of fresh) {
      const existing = currentByKey.get(scheduleKey(msg));
      if (existing) msg.nextRun = existing.nextRun;
    }

    if (fresh.length !== this.scheduledMessages.length) {
      logger.info({ agentFolder: this.folder, count: fresh.length }, 'Schedule.txt reloaded');
      this.logEvent('info', 'scheduler', 'schedule_reloaded', `schedule.txt reloaded (${fresh.length} entries)`, {
        context: { count: fresh.length },
      });
    }
    this.scheduledMessages = fresh;
  }

  private tick(): void {
    const agentAddress = this.address;
    const draft = this.isDraft();

    // --- Source 1: Scheduled tasks ---
    const dueTasks = this.store.getDueTasksForAgent(agentAddress);
    if (dueTasks.length > 0) {
      logger.info(
        { agentFolder: this.folder, count: dueTasks.length, tasks: dueTasks.map((t) => ({ id: t.id, type: t.schedule_type, nextRun: t.next_run })) },
        'Found due DB tasks',
      );
    }

    for (const task of dueTasks) {
      const currentTask = this.store.getTaskById(task.id);
      if (!currentTask || currentTask.status !== 'active') continue;

      if (!currentTask.target_participant) {
        logger.error({ taskId: currentTask.id }, 'Task has no target_participant, skipping');
        continue;
      }

      // Draft skip: cron tasks advance next_run so they don't burst on ready
      // flip; one-shot tasks stay due and fire when readied. Bus path's draft
      // bounce doesn't apply here — scheduler dispatches via route() directly.
      if (draft) {
        this.logEvent('info', 'scheduler', 'skipped_draft', `Scheduled task skipped (agent in draft): ${currentTask.id}`, {
          context: { taskId: currentTask.id, scheduleType: currentTask.schedule_type },
        });
        if (currentTask.schedule_type === 'cron') {
          try {
            const nextRun = this.nextCronRun(currentTask.schedule_value, currentTask.timezone);
            this.store.updateTaskAfterRun(currentTask.id, nextRun, 'Skipped (draft)');
          } catch (err) {
            logger.error({ agentFolder: this.folder, taskId: currentTask.id, err }, 'Failed to advance next_run on draft skip');
          }
        }
        continue;
      }

      logger.info(
        { taskId: currentTask.id, agentFolder: this.folder, scheduleType: currentTask.schedule_type },
        'Dispatching scheduled task',
      );
      this.logEvent('info', 'scheduler', 'fired', `Scheduled task fired: ${currentTask.id}`, {
        context: { taskId: currentTask.id, scheduleType: currentTask.schedule_type },
      });

      this.store.updateTask(currentTask.id, { status: 'running' });

      this.store.logTaskRun({
        task_id: currentTask.id,
        run_at: new Date().toISOString(),
      });

      // Self-addressed with replyTo for response routing.
      // updateTaskAfterRun lives in the callback so 'running' status persists
      // until dispatch completes — prevents double-fire on slow tasks.
      const taskId = currentTask.id;
      const scheduleType = currentTask.schedule_type;
      const scheduleValue = currentTask.schedule_value;
      const timezone = currentTask.timezone;

      this.route(agentAddress, agentAddress, currentTask.prompt, {
        targetParticipant: currentTask.target_participant,
        channel: currentTask.channel ?? undefined,
      }).then(
        () => 'Completed',
        (err) => {
          logger.error({ agentFolder: this.folder, taskId, err }, 'Scheduled task route failed');
          this.logEvent('error', 'scheduler', 'task_dispatch_failed', `Scheduled task route failed: ${taskId}`, {
            context: { taskId, error: String(err) },
          });
          return `Error: ${String(err)}`;
        },
      ).then((result) => {
        try {
          const nextRun = scheduleType === 'cron' ? this.nextCronRun(scheduleValue, timezone) : null;
          this.store.updateTaskAfterRun(taskId, nextRun, result);
        } catch (err) {
          logger.error({ agentFolder: this.folder, taskId, err }, 'Failed to update task after run');
          this.logEvent('error', 'scheduler', 'task_update_failed', `updateTaskAfterRun threw for ${taskId}`, {
            context: { taskId, error: String(err) },
          });
          // Best-effort: reset to active so the task isn't stuck in "running" forever
          try { this.store.updateTask(taskId, { status: 'active' }); } catch { /* give up */ }
        }
      });
    }

    // --- Source 2: Declarative scheduled messages (props/schedule.txt) ---
    const now = new Date().toISOString();
    const failed: ScheduledMessage[] = [];

    for (const msg of this.scheduledMessages) {
      if (msg.nextRun > now) continue;

      if (draft) {
        this.logEvent('info', 'scheduler', 'skipped_draft', `schedule.txt entry skipped (agent in draft) on channel ${msg.channel}`, {
          context: { channel: msg.channel, qualifier: msg.qualifier },
        });
        try {
          msg.nextRun = this.nextCronRun(msg.schedule, msg.timezone ?? TIMEZONE);
        } catch (err) {
          failed.push(msg);
          logger.warn({ agentFolder: this.folder, schedule: msg.schedule, err }, 'Failed to compute next cron run on draft skip, removing entry');
        }
        continue;
      }

      logger.info(
        { agentFolder: this.folder, channel: msg.channel, qualifier: msg.qualifier },
        'Dispatching schedule.txt entry',
      );
      this.logEvent('info', 'scheduler', 'fired', `schedule.txt entry fired on channel ${msg.channel}`, {
        context: { channel: msg.channel, qualifier: msg.qualifier },
      });

      // Self-addressed
      this.route(agentAddress, agentAddress, msg.message, { channel: msg.channel, qualifier: msg.qualifier })
        .catch((err) => {
          logger.error({ agentFolder: this.folder, channel: msg.channel, err }, 'Schedule.txt route failed');
        });

      try {
        msg.nextRun = this.nextCronRun(msg.schedule, msg.timezone ?? TIMEZONE);
      } catch (err) {
        // Remove broken entry — re-added on next reconcileSchedule if schedule.txt changes
        failed.push(msg);
        logger.warn({ agentFolder: this.folder, schedule: msg.schedule, err }, 'Failed to compute next cron run, removing entry');
      }
    }

    if (failed.length > 0) {
      this.scheduledMessages = this.scheduledMessages.filter((m) => !failed.includes(m));
    }
  }
}
