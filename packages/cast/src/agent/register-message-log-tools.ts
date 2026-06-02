/**
 * Message-log tool registrar.
 *
 * Parametrized by `toolPrefix` so the same registrar wires either the agent-
 * scope `message_log__*` tools (backed by `agentDb.messages`) or the console-
 * scope `console_log__*` tools (backed by `consoleDb.messages`). Search/recent
 * return truncated previews + IDs; read returns the full body. All three are
 * gated on the participant: a caller can only read messages addressed to
 * themselves.
 */
import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { textResult, type ToolResult } from '../extensions/registry.js';
import { truncateToTokens } from '../lib/tokenizer.js';
import { toZonedIso } from '../lib/utils.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageLogStore } from '../lib/message-log-store.js';

function handleMessageLogSearch(
  args: { query: string; limit: number; channel?: string; before?: string; after?: string; max_tokens?: number },
  store: MessageLogStore,
  participant: string | null,
  agentTz: string,
): ToolResult {
  const maxTokens = args.max_tokens ?? 200;
  const results = store.search(args.query, {
    limit: args.limit,
    channel: args.channel,
    participant: participant ?? undefined,
    before: args.before,
    after: args.after,
  });

  if (results.length === 0) return textResult('No messages found.');
  const visible = results.filter((r) => r.text);
  if (visible.length === 0) return textResult('No messages found.');

  const hasMore = visible.length === args.limit;
  const nextCursor = hasMore ? visible[visible.length - 1]!.timestamp : null;

  const formatted = visible.map((r) => {
    const role = r.direction === 'inbound' ? 'user' : 'assistant';
    const { text } = truncateToTokens(r.text!, maxTokens);
    return `[${r.id}] [${toZonedIso(new Date(r.timestamp), agentTz)}] ${role}: ${text}`;
  }).join('\n');

  const meta = `${visible.length}${hasMore ? `, has_more=true, next_cursor=${nextCursor}` : ''}`;
  return textResult(`Messages (${meta}):\n${formatted}`);
}

function handleMessageLogRecent(
  args: { limit: number; max_tokens?: number; before?: string; after?: string },
  store: MessageLogStore,
  participant: string | null,
  agentTz: string,
): ToolResult {
  const maxTokens = args.max_tokens ?? 200;
  const results = store.recent({
    limit: args.limit,
    before: args.before,
    after: args.after,
    participant: participant ?? undefined,
  });

  if (results.length === 0) return textResult('No messages found.');

  const hasMore = results.length === args.limit;
  const nextCursor = hasMore ? results[results.length - 1]!.timestamp : null;

  const formatted = results.map((r) => {
    const role = r.direction === 'inbound' ? 'user' : 'assistant';
    const preview = r.text ? truncateToTokens(r.text, maxTokens).text : '(no text)';
    return `[${r.id}] [${toZonedIso(new Date(r.timestamp), agentTz)}] ${role}: ${preview}`;
  }).join('\n');

  const meta = `${results.length}${hasMore ? `, has_more=true, next_cursor=${nextCursor}` : ''}`;
  return textResult(`Messages (${meta}):\n${formatted}`);
}

function handleMessageLogRead(
  args: { id: number; max_tokens?: number },
  store: MessageLogStore,
  participant: string | null,
  agentTz: string,
): ToolResult {
  const maxTokens = args.max_tokens ?? 2000;
  const msg = store.read(args.id);
  if (!msg) return textResult(`Message ${args.id} not found.`, true);

  if (participant && msg.participant !== participant) {
    return textResult('Access denied: message belongs to a different participant.', true);
  }

  const role = msg.direction === 'inbound' ? 'user' : 'assistant';
  const text = msg.text ? truncateToTokens(msg.text, maxTokens).text : '(no text)';
  return textResult(`[${msg.id}] [${toZonedIso(new Date(msg.timestamp), agentTz)}] ${role} (${msg.channel}):\n${text}`);
}

export interface MessageLogToolsOpts {
  /** Message log bundle backing the tools. */
  store: MessageLogStore;
  /** Participant address — used for read-access gating and search/recent filtering. */
  participant: string | null;
  /** Tool name prefix — `message_log__` for agent scope, `console_log__` for console scope. */
  toolPrefix: 'message_log__' | 'console_log__';
  /** Effective agent timezone for ISO rendering. */
  agentTz: string;
  /** Tools to suppress (agent-config disabledTools, merged with channel-level). */
  disabledTools?: string[];
}

export function registerMessageLogTools(server: McpServer, opts: MessageLogToolsOpts): void {
  const { store, participant, toolPrefix, agentTz } = opts;
  const disabled = (name: string) => isToolDisabled(name, opts.disabledTools ?? []);

  const searchName = `${toolPrefix}search` as const;
  const recentName = `${toolPrefix}recent` as const;
  const readName = `${toolPrefix}read` as const;

  if (!disabled(searchName)) {
    server.tool(
      searchName,
      `Search past messages by keyword. Returns previews with IDs — use ${readName} for full text.`,
      {
        query: z.string().describe('Search query (full-text search)'),
        limit: z.number().int().positive().max(50).default(20).describe('Max results (default 20)'),
        channel: z.string().optional().describe('Filter by channel name'),
        before: z.string().optional().describe('ISO timestamp — only return messages before this time (pagination cursor)'),
        after: z.string().optional().describe('ISO timestamp — only return messages after this time (time range filter)'),
        max_tokens: z.number().int().positive().max(1000).default(200).describe('Max tokens per message preview (default 200)'),
      },
      async (args) => handleMessageLogSearch(args, store, participant, agentTz),
    );
  }

  if (!disabled(recentName)) {
    server.tool(
      recentName,
      'Browse recent messages without keyword search. Returns newest first. Use \'before\' for pagination.',
      {
        limit: z.number().int().positive().max(50).describe('Number of messages to return (1-50)'),
        max_tokens: z.number().int().positive().max(1000).default(200).describe('Max tokens per message preview (default 200)'),
        before: z.string().optional().describe('ISO timestamp cursor — only return messages before this time (for pagination)'),
        after: z.string().optional().describe('ISO timestamp — only return messages after this time (time range filter)'),
      },
      async (args) => handleMessageLogRecent(args, store, participant, agentTz),
    );
  }

  if (!disabled(readName)) {
    server.tool(
      readName,
      `Read the full text of a specific message by ID. Use after browsing with ${recentName} or ${searchName}.`,
      {
        id: z.number().int().positive().describe('Message ID from search or recent results'),
        max_tokens: z.number().int().positive().max(10000).default(2000).describe('Max tokens for message text (default 2000)'),
      },
      async (args) => handleMessageLogRead(args, store, participant, agentTz),
    );
  }
}
