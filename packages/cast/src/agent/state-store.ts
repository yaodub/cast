/**
 * AgentStateStore — per-agent persistent state backed by files in state/.
 *
 * Owns two backing files:
 * - state/conversations.jsonl — append-only JSONL, in-memory Map keyed by conversationKey.
 *   flush() compacts the file.
 * - state/tasks.json — atomic JSON snapshot { tasks: [...], runLogs: [...] }.
 *   Written via temp+rename on every mutation.
 *
 * This is the single source of truth for per-agent conversations and tasks.
 * No other module touches these files.
 */
import fs from 'fs';
import path from 'path';

import { isService } from '../auth/address.js';

import { z } from 'zod';

import { logger } from '../logger.js';
import type { ScheduledTask, TaskRunLog } from '../types.js';
import { writeAtomic } from '../lib/utils.js';

// In-memory cap for completedSessions. JSONL on disk remains the durable record;
// memory holds a working set big enough for getPreviousSessions (slice 0,3) and
// the 7-day window in getConversationsWithSummaries.
const MAX_COMPLETED_SESSIONS = 200;

// --- Types ---

const ConversationStateSchema = z.object({
  conversationKey: z.string(),
  channelName: z.string(),
  participant: z.string().nullable(),
  qualifier: z.string().nullable(),
  ccSessionId: z.string(),
  createdAt: z.string(),
  lastActive: z.string(),
  ttl: z.number().nullable(),
  /**
   * Conversation lifecycle status.
   * - `active`: live conversation. The runner may or may not be in memory —
   *   slot residency is orthogonal to this lifecycle phase.
   * - `expired`: cleanup ran, terminal state.
   *
   * Legacy `'swapped'` rows from prior versions are coerced to `'active'`
   * on load (paged-out conversations are just `'active'` records with no
   * resident runner now).
   */
  status: z.enum(['active', 'expired']),
  summary: z.string().nullable(),
});
type ConversationState = z.infer<typeof ConversationStateSchema>;

interface PreviousSessionInfo {
  lastActive: string;
  summary: string | null;
}

interface ConversationWithSummary {
  conversation_key: string;
  channel_name: string;
  participant: string | null;
  status: string;
  last_active: string;
  message_count: number;
  summary: string | null;
}

interface TaskRunRow {
  id: number;
  task_id: string;
  run_at: string;
  prompt: string | null;
  target_participant: string | null;
}

const TasksSnapshotSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    address: z.string(),
    prompt: z.string(),
    schedule_type: z.enum(['cron', 'once']),
    schedule_value: z.string(),
    timezone: z.string().nullable(),
    channel: z.string().nullable(),
    target_participant: z.string().nullable(),
    next_run: z.string().nullable(),
    last_run: z.string().nullable(),
    last_result: z.string().nullable(),
    status: z.enum(['active', 'running', 'paused', 'completed']),
    created_at: z.string(),
  })).default([]),
  runLogs: z.array(z.object({
    id: z.number(),
    task_id: z.string(),
    run_at: z.string(),
    prompt: z.string().nullable(),
    target_participant: z.string().nullable(),
  })).default([]),
});

interface TasksSnapshot {
  tasks: ScheduledTask[];
  runLogs: TaskRunRow[];
}

// --- Store ---

export class AgentStateStore {
  private stateDir: string;
  private conversationsPath: string;
  private tasksPath: string;

  // In-memory state — two structures serve different queries:
  //   conversations: current state per conversationKey (latest wins)
  //   completedSessions: historical sessions with summaries (append-only, capped)
  private conversations = new Map<string, ConversationState>();
  // Capped to MAX_COMPLETED_SESSIONS — consumers slice to top 3 (getPreviousSessions)
  // or filter by 7-day age window (getConversationsWithSummaries), so older entries
  // beyond the cap aren't observable. JSONL on disk remains the durable record.
  private completedSessions: ConversationState[] = [];
  private tasks: ScheduledTask[] = [];
  private runLogs: TaskRunRow[] = [];
  private runLogNextId = 1;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.conversationsPath = path.join(stateDir, 'conversations.jsonl');
    this.tasksPath = path.join(stateDir, 'tasks.json');

    fs.mkdirSync(stateDir, { recursive: true });
    this.loadConversations();
    this.flush();
    this.loadTasks();
  }

  // =========================================================================
  // Conversations
  // =========================================================================

  getActiveConversation(key: string): ConversationState | undefined {
    const conv = this.conversations.get(key);
    if (conv && conv.status === 'active') return conv;
    return undefined;
  }

  upsertConversation(key: string, state: Omit<ConversationState, 'conversationKey'>): ConversationState {
    const conv: ConversationState = { ...state, conversationKey: key };
    this.conversations.set(key, conv);
    this.appendConversation(conv);
    return conv;
  }

  touchConversation(key: string): void {
    const conv = this.conversations.get(key);
    if (!conv || conv.status !== 'active') return;
    conv.lastActive = new Date().toISOString();
    this.appendConversation(conv);
  }

  expireConversation(key: string): void {
    const conv = this.conversations.get(key);
    if (!conv || conv.status === 'expired') return;
    conv.status = 'expired';
    this.appendConversation(conv);
  }

  updateCcSessionId(key: string, ccSessionId: string): void {
    const conv = this.conversations.get(key);
    if (!conv || conv.status !== 'active') return;
    conv.ccSessionId = ccSessionId;
    this.appendConversation(conv);
  }

  updateSummary(key: string, summary: string): void {
    const conv = this.conversations.get(key);
    if (!conv) return;
    conv.summary = summary;
    this.appendConversation(conv);
    // Snapshot into completed sessions so getPreviousSessions can find it
    // even after the Map entry is overwritten by the next conversation.
    this.completedSessions.push({ ...conv });
    if (this.completedSessions.length > MAX_COMPLETED_SESSIONS) {
      this.completedSessions = this.completedSessions.slice(-MAX_COMPLETED_SESSIONS);
    }
  }

  getActiveConversations(): ConversationState[] {
    const result: ConversationState[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.status !== 'active') continue;
      result.push(conv);
    }
    return result;
  }

  /**
   * Get recent completed sessions for a specific channel+participant.
   * Returns up to 3 most recent, stopping after the first one with a summary.
   * Queries completedSessions (historical), not the current-state Map.
   */
  getPreviousSessions(channelName: string, participant: string): PreviousSessionInfo[] {
    const matching = this.completedSessions
      .filter((c) => c.channelName === channelName && c.participant === participant)
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
      .slice(0, 3);

    const result: PreviousSessionInfo[] = [];
    for (const conv of matching) {
      result.push({ lastActive: conv.lastActive, summary: conv.summary });
      if (conv.summary) break;
    }
    return result;
  }

  getConversationsWithSummaries(channels: string[] | undefined, maxAgeMs: number): ConversationWithSummary[] {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const channelSet = channels ? new Set(channels) : null;

    return this.completedSessions
      .filter((c) =>
        (!channelSet || channelSet.has(c.channelName)) &&
        c.lastActive >= cutoff &&
        (c.participant === null || !isService(c.participant)),
      )
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
      .map((c) => ({
        conversation_key: c.conversationKey,
        channel_name: c.channelName,
        participant: c.participant,
        status: c.status,
        last_active: c.lastActive,
        message_count: 0,
        summary: c.summary,
      }));
  }

  /** Compact the JSONL file — preserve completed sessions + current state. */
  flush(): void {
    // Write completed sessions first, then current state per key.
    // This preserves history through compaction cycles.
    const lines: string[] = [];
    const written = new Set<string>();
    for (const c of this.completedSessions) {
      lines.push(JSON.stringify(c));
      if (c.ccSessionId) written.add(c.ccSessionId);
    }
    for (const c of this.conversations.values()) {
      // Skip if this exact session is already in completedSessions
      if (c.ccSessionId && written.has(c.ccSessionId) && c.summary) continue;
      lines.push(JSON.stringify(c));
    }
    writeAtomic(this.conversationsPath, lines.join('\n') + '\n');
  }

  // =========================================================================
  // Tasks
  // =========================================================================

  createTask(task: ScheduledTask): void {
    this.tasks.push(task);
    this.saveTasks();
  }

  getTaskById(id: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  getTasksForAddress(address: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.address === address).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getAllTasks(): ScheduledTask[] {
    return [...this.tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  updateTask(
    id: string,
    updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>,
  ): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (updates.prompt !== undefined) task.prompt = updates.prompt;
    if (updates.schedule_type !== undefined) task.schedule_type = updates.schedule_type;
    if (updates.schedule_value !== undefined) task.schedule_value = updates.schedule_value;
    if (updates.next_run !== undefined) task.next_run = updates.next_run;
    if (updates.status !== undefined) task.status = updates.status;
    this.saveTasks();
  }

  deleteTask(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.runLogs = this.runLogs.filter((r) => r.task_id !== id);
    this.saveTasks();
  }

  getDueTasksForAgent(address: string): ScheduledTask[] {
    const now = new Date().toISOString();
    return this.tasks
      .filter((t) => t.status === 'active' && t.next_run !== null && t.next_run <= now && t.address === address)
      .sort((a, b) => (a.next_run ?? '').localeCompare(b.next_run ?? ''));
  }

  recoverStuckTasks(address: string): number {
    let count = 0;
    for (const task of this.tasks) {
      if (task.status === 'running' && task.address === address) {
        task.status = 'active';
        count++;
      }
    }
    if (count > 0) this.saveTasks();
    return count;
  }

  updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.next_run = nextRun;
    task.last_run = new Date().toISOString();
    task.last_result = lastResult;
    task.status = nextRun === null ? 'completed' : 'active';
    this.saveTasks();
  }

  logTaskRun(log: TaskRunLog): void {
    const task = this.tasks.find((t) => t.id === log.task_id);
    this.runLogs.push({
      id: this.runLogNextId++,
      task_id: log.task_id,
      run_at: log.run_at,
      prompt: task?.prompt ?? null,
      target_participant: task?.target_participant ?? null,
    });
    if (this.runLogs.length > 100) {
      this.runLogs = this.runLogs.slice(-100);
    }
    this.saveTasks();
  }

  getRecentTaskRuns(participant: string | null, limit: number): TaskRunRow[] {
    let logs = [...this.runLogs].sort((a, b) => b.run_at.localeCompare(a.run_at));
    if (participant) {
      logs = logs.filter((r) => r.target_participant === participant);
    }
    return logs.slice(0, limit);
  }

  // =========================================================================
  // File I/O — conversations (JSONL)
  // =========================================================================

  private loadConversations(): void {
    if (!fs.existsSync(this.conversationsPath)) return;
    const content = fs.readFileSync(this.conversationsPath, 'utf-8');
    const seen = new Set<string>(); // deduplicate completedSessions by ccSessionId
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        let raw: unknown;
        try { raw = JSON.parse(trimmed); } catch {
          logger.warn({ line: trimmed.slice(0, 80) }, 'Skipping non-JSON conversation JSONL line');
          continue;
        }
        // Coerce legacy `'swapped'` rows from prior versions to `'active'` —
        // paged-out conversations are just `'active'` records with no resident
        // runner under the post-refactor model.
        // TODO: remove after 2026-06-15 — pre-refactor JSONL rows should be
        // fully drained by then via natural ingestion + the dev agents
        // rebuild that runs ahead of any release.
        if (raw && typeof raw === 'object' && (raw as { status?: string }).status === 'swapped') {
          (raw as { status: string }).status = 'active';
        }
        const parsed = ConversationStateSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ error: parsed.error.message }, 'Skipping corrupt conversation JSONL line');
          continue;
        }
        const entry = parsed.data;
        this.conversations.set(entry.conversationKey, entry);
        // Build completed sessions index from entries that have summaries.
        // Later JSONL lines for the same session supersede earlier ones.
        if (entry.summary && entry.ccSessionId) {
          if (!seen.has(entry.ccSessionId)) {
            seen.add(entry.ccSessionId);
            this.completedSessions.push(entry);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Skipping unparseable JSON line in conversations.jsonl');
      }
    }
    // Cap on load too — large historical JSONLs would otherwise surface the leak
    // immediately at startup. Newest-wins is preserved by chronological JSONL order.
    if (this.completedSessions.length > MAX_COMPLETED_SESSIONS) {
      this.completedSessions = this.completedSessions.slice(-MAX_COMPLETED_SESSIONS);
    }
  }

  private appendCount = 0;
  private appendConversation(conv: ConversationState): void {
    fs.appendFileSync(this.conversationsPath, JSON.stringify(conv) + '\n');
    if (++this.appendCount % 50 === 0) this.flush();
  }

  // =========================================================================
  // File I/O — tasks (atomic JSON)
  // =========================================================================

  private loadTasks(): void {
    if (!fs.existsSync(this.tasksPath)) return;
    try {
      const content = fs.readFileSync(this.tasksPath, 'utf-8');
      const parsed = TasksSnapshotSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        logger.warn({ error: parsed.error.message }, 'Corrupt tasks.json — starting fresh');
        this.tasks = [];
        this.runLogs = [];
        return;
      }
      this.tasks = parsed.data.tasks;
      this.runLogs = parsed.data.runLogs;
      if (this.runLogs.length > 0) {
        this.runLogNextId = Math.max(...this.runLogs.map((r) => r.id)) + 1;
      }
    } catch {
      // Unparseable JSON — start fresh
      this.tasks = [];
      this.runLogs = [];
    }
  }

  private saveTasks(): void {
    const snapshot: TasksSnapshot = { tasks: this.tasks, runLogs: this.runLogs };
    writeAtomic(this.tasksPath, JSON.stringify(snapshot, null, 2));
  }
}
