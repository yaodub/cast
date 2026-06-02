/**
 * Calendar extension — main class.
 *
 * Orchestrates tools, prompt, handle dispatch, and CalDAV client.
 * Two provider modes: Google (OAuth bearer) and generic CalDAV (basic auth).
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import type {
  ExtensionContext,
  ExtensionInstance,
  Logger,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from '@getcast/extension-schema';
import { noopLogger, textResult } from '@getcast/extension-schema';

import type { CalendarConfig, CalendarSecrets, CalendarEvent, CreateEventInput, ChangeRecord } from './schemas.js';
import { writeDecision } from './schemas.js';
import { CalendarClient, appendChange, listChanges, formatEvents, formatChanges } from './caldav.js';
import { createGoogleTokenRefresher } from './google.js';

const GOOGLE_CALDAV_URL = 'https://apidata.googleusercontent.com/caldav/v2/';

/**
 * Resolve the agent's IANA timezone, mirroring `agent-manager.effectiveTimezone`:
 * agent.json `timezone` → `TZ` env var → host's resolved IANA tz.
 *
 * Loose JSON read avoids pulling `@getcast/agent-schema` into this extension's deps
 * (process-boundary discipline per CLAUDE.md).
 */
function resolveAgentTimezone(agentFolder: string): string {
  let fromConfig: string | undefined;
  try {
    const raw = fs.readFileSync(path.join(agentFolder, 'config', 'agent.json'), 'utf-8');
    const tz = (JSON.parse(raw) as { timezone?: unknown }).timezone;
    if (typeof tz === 'string' && tz.length > 0) fromConfig = tz;
  } catch { /* file missing or unparseable */ }
  return fromConfig || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ---------------------------------------------------------------------------
// Extension class
// ---------------------------------------------------------------------------

export class CalendarExtension implements ExtensionInstance {
  readonly name = 'calendar';
  private config: CalendarConfig;
  private log: Logger;
  private client: CalendarClient;
  private changelogPath: string;

  constructor(ctx: ExtensionContext<CalendarConfig, CalendarSecrets>) {
    this.config = ctx.config;
    this.log = ctx.log ?? noopLogger;
    this.changelogPath = path.join(ctx.privateDir, 'changelog.jsonl');

    const timezone = resolveAgentTimezone(ctx.agentFolder);
    const secrets = ctx.secrets;

    if (secrets.PROVIDER === 'google') {
      const refresher = createGoogleTokenRefresher({
        clientId: secrets.GOOGLE_CLIENT_ID,
        clientSecret: secrets.GOOGLE_CLIENT_SECRET,
        refreshToken: secrets.GOOGLE_REFRESH_TOKEN,
        privateDir: ctx.privateDir,
        log: this.log,
      });

      this.client = new CalendarClient({
        serverUrl: GOOGLE_CALDAV_URL,
        auth: {
          method: 'bearer',
          username: secrets.GOOGLE_EMAIL,
          getAccessToken: () => refresher.getAccessToken(),
        },
        config: ctx.config,
        changelogPath: this.changelogPath,
        log: this.log,
        timezone,
      });
    } else {
      this.client = new CalendarClient({
        serverUrl: secrets.CALDAV_URL,
        auth: {
          method: 'basic',
          username: secrets.CALDAV_USERNAME,
          password: secrets.CALDAV_PASSWORD,
        },
        config: ctx.config,
        changelogPath: this.changelogPath,
        log: this.log,
        timezone,
      });
    }
  }

  // =========================================================================
  // Tools + prompt
  // =========================================================================

  get tools(): ToolDefinition[] {
    const mode = this.config.write_mode;
    const writesEnabled = mode !== 'disabled';
    const writableNote = writesEnabled ? ` Write mode: ${mode}.` : '';

    const writeFilter = (args: Record<string, unknown>): 'skip' | 'approve' | 'block' => {
      const attendees = (args as { attendees?: string[] }).attendees;
      const hasAttendees = Array.isArray(attendees) && attendees.length > 0;
      return writeDecision(mode, hasAttendees);
    };

    const tools: ToolDefinition[] = [
      {
        name: 'calendar__list',
        description: `List calendar events in a time range. Returns event summaries sorted by start time.${writableNote}`,
        schema: {
          after: z.string().optional().describe('ISO date — only events after this'),
          before: z.string().optional().describe('ISO date — only events before this'),
        },
      },
      {
        name: 'calendar__get',
        description: 'Get a single calendar event by UID. Returns full event details.',
        schema: {
          uid: z.string().describe('Event UID'),
        },
      },
      {
        name: 'calendar__changes',
        description: 'List recent calendar changes (create, update, delete) from the audit log.',
        schema: {
          limit: z.number().optional().describe('Max entries to return (default: 50)'),
        },
      },
    ];

    if (!writesEnabled) return tools;

    tools.push(
      {
        name: 'calendar__create',
        description: `Create a calendar event.${writableNote}`,
        schema: {
          title: z.string().describe('Event title'),
          start: z.string().describe('ISO datetime (or YYYY-MM-DD for all-day events)'),
          end: z.string().describe('ISO datetime (or YYYY-MM-DD for all-day events)'),
          allDay: z.boolean().optional().describe('All-day event (default: false)'),
          location: z.string().optional().describe('Event location'),
          description: z.string().optional().describe('Event description'),
          attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
        },
        approval: {
          enabled: true,
          preview: (args) => {
            const a = args as { title?: string; start?: string; attendees?: string[] };
            const who = Array.isArray(a.attendees) && a.attendees.length > 0
              ? ` with ${a.attendees.join(', ')}`
              : '';
            return {
              summary: `Create event: ${a.title ?? '(no title)'}${who}`,
              details: a.start ? `Start: ${a.start}` : undefined,
            };
          },
          filter: writeFilter,
        },
      },
      {
        name: 'calendar__update',
        description: `Update a calendar event. Only specified fields are changed.${writableNote}`,
        schema: {
          uid: z.string().describe('Event UID'),
          title: z.string().optional().describe('New title'),
          start: z.string().optional().describe('New start (ISO datetime or YYYY-MM-DD)'),
          end: z.string().optional().describe('New end (ISO datetime or YYYY-MM-DD)'),
          allDay: z.boolean().optional().describe('All-day event'),
          location: z.string().optional().describe('New location'),
          description: z.string().optional().describe('New description'),
          attendees: z.array(z.string()).optional().describe('New attendee list (replaces existing)'),
        },
        approval: {
          enabled: true,
          preview: (args) => {
            const a = args as { uid?: string; title?: string; attendees?: string[] };
            const who = Array.isArray(a.attendees) && a.attendees.length > 0
              ? ` (attendees: ${a.attendees.join(', ')})`
              : '';
            return {
              summary: `Update event ${a.uid ?? ''}${a.title ? `: ${a.title}` : ''}${who}`,
            };
          },
          filter: writeFilter,
        },
      },
      {
        name: 'calendar__delete',
        description: `Delete a calendar event by UID.${writableNote}`,
        schema: {
          uid: z.string().describe('Event UID'),
        },
        approval: {
          enabled: true,
          preview: (args) => ({
            summary: `Delete event ${(args as { uid?: string }).uid ?? ''}`,
          }),
          filter: writeFilter,
        },
      },
    );

    return tools;
  }

  get promptSection(): string {
    const lines = [
      '## Calendar',
      '',
      'Use `calendar__list` to query events and `calendar__get` for full details.',
      `- View window: ${this.config.view_past} past, ${this.config.view_future} future.`,
    ];

    switch (this.config.write_mode) {
      case 'disabled':
        lines.push('- Calendar writes are **disabled** (read-only).');
        break;
      case 'approval':
        lines.push('- Write mode: **approval** — every create/update/delete requires user approval.');
        break;
      case 'personal':
        lines.push('- Write mode: **personal** — personal events execute without prompt; adding attendees requires user approval (sends real invitations).');
        break;
      case 'full':
        lines.push('- Write mode: **full** — all writes, including attendee invitations, execute without prompt.');
        break;
    }

    lines.push('- Use `calendar__changes` to review the audit log of recent modifications.');
    return lines.join('\n');
  }

  // =========================================================================
  // MCP tool handler
  // =========================================================================

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    _call: ToolCallContext,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'calendar__list':
        return this.handleList(args);
      case 'calendar__get':
        return this.handleGet(args);
      case 'calendar__create':
        return this.handleCreate(args);
      case 'calendar__update':
        return this.handleUpdate(args);
      case 'calendar__delete':
        return this.handleDelete(args);
      case 'calendar__changes':
        return this.handleChanges(args);
      default:
        return textResult(`Unknown tool: ${toolName}`, true);
    }
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  private async handleList(args: Record<string, unknown>): Promise<ToolResult> {
    const after = typeof args.after === 'string' ? args.after : undefined;
    const before = typeof args.before === 'string' ? args.before : undefined;

    try {
      const events = await this.client.listEvents({ after, before });
      return textResult(formatEvents(events));
    } catch (err) {
      this.log.warn({ err }, 'calendar__list failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async handleGet(args: Record<string, unknown>): Promise<ToolResult> {
    const uid = typeof args.uid === 'string' ? args.uid : '';
    if (!uid) return textResult('Missing required argument: uid', true);

    try {
      const event = await this.client.getEvent(uid);
      return textResult(event ? formatEvents([event]) : 'Event not found.');
    } catch (err) {
      this.log.warn({ err }, 'calendar__get failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async handleCreate(args: Record<string, unknown>): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title : '';
    const start = typeof args.start === 'string' ? args.start : '';
    const end = typeof args.end === 'string' ? args.end : '';
    if (!title || !start || !end) return textResult('Missing required arguments: title, start, end', true);

    const input: CreateEventInput = {
      title,
      start,
      end,
      allDay: typeof args.allDay === 'boolean' ? args.allDay : undefined,
      location: typeof args.location === 'string' ? args.location : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      attendees: Array.isArray(args.attendees) ? args.attendees as string[] : undefined,
    };

    try {
      const { event, change } = await this.client.createEvent(input);
      appendChange(this.changelogPath, change);
      return textResult(`Created: ${event.title} (${event.start} — ${event.end})\nUID: ${event.uid}`);
    } catch (err) {
      this.log.warn({ err }, 'calendar__create failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async handleUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    const uid = typeof args.uid === 'string' ? args.uid : '';
    if (!uid) return textResult('Missing required argument: uid', true);

    const fields: Partial<CreateEventInput> = {};
    if (typeof args.title === 'string') fields.title = args.title;
    if (typeof args.start === 'string') fields.start = args.start;
    if (typeof args.end === 'string') fields.end = args.end;
    if (typeof args.allDay === 'boolean') fields.allDay = args.allDay;
    if (typeof args.location === 'string') fields.location = args.location;
    if (typeof args.description === 'string') fields.description = args.description;
    if (Array.isArray(args.attendees)) fields.attendees = args.attendees as string[];

    try {
      const { event, change } = await this.client.updateEvent(uid, fields);
      appendChange(this.changelogPath, change);
      return textResult(`Updated: ${event.title} (${event.start} — ${event.end})`);
    } catch (err) {
      this.log.warn({ err }, 'calendar__update failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async handleDelete(args: Record<string, unknown>): Promise<ToolResult> {
    const uid = typeof args.uid === 'string' ? args.uid : '';
    if (!uid) return textResult('Missing required argument: uid', true);

    try {
      const { change } = await this.client.deleteEvent(uid);
      appendChange(this.changelogPath, change);
      return textResult(`Deleted event: ${change.eventUid}`);
    } catch (err) {
      this.log.warn({ err }, 'calendar__delete failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private handleChanges(args: Record<string, unknown>): ToolResult {
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    try {
      const changes = listChanges(this.changelogPath, limit);
      return textResult(formatChanges(changes));
    } catch (err) {
      this.log.warn({ err }, 'calendar__changes failed');
      return textResult(`Calendar error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  // =========================================================================
  // Public client methods (for direct service-side use)
  // =========================================================================

  listEvents(opts?: { after?: string; before?: string; calendarId?: string }): Promise<CalendarEvent[]> {
    return this.client.listEvents(opts);
  }

  getEvent(uid: string): Promise<CalendarEvent | null> {
    return this.client.getEvent(uid);
  }

  createEvent(event: CreateEventInput): Promise<{ event: CalendarEvent; change: ChangeRecord }> {
    return this.client.createEvent(event);
  }

  updateEvent(uid: string, fields: Partial<CreateEventInput>): Promise<{ event: CalendarEvent; change: ChangeRecord }> {
    return this.client.updateEvent(uid, fields);
  }

  deleteEvent(uid: string): Promise<{ change: ChangeRecord }> {
    return this.client.deleteEvent(uid);
  }
}
