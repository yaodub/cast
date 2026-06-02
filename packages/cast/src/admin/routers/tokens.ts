/**
 * Tokens router — per-agent token-usage telemetry.
 *
 * Reads from the per-agent `state/agent.db` token_usage bundle. Returns raw
 * counters and the SDK's list-price `cost_usd` alongside them — no rates
 * computation host-side.
 */
import fs from 'fs';
import { z } from 'zod';

import { AgentDb } from '../../agent/agent-db.js';
import { agentPath } from '../../config.js';
import { aliasToFolder, adminProcedure, router } from '../trpc.js';

const aliasAndRange = z.object({
  alias: z.string(),
  sinceDays: z.number().int().positive().max(365).optional(),
});

export const tokensRouter = router({
  /** Totals + date span across all rows in range. */
  summary: adminProcedure
    .input(aliasAndRange)
    .query(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const dbPath = agentPath(folder, 'state', 'agent.db');
      if (!fs.existsSync(dbPath)) {
        return {
          totals: {
            input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            cost_usd: 0, result_count: 0,
          },
          firstDate: null, lastDate: null,
        };
      }
      const db = new AgentDb(dbPath);
      try {
        return db.tokens.summary({ sinceDays: input.sinceDays });
      } finally {
        db.close();
      }
    }),

  /** Per-day rollup, newest first. */
  byDay: adminProcedure
    .input(aliasAndRange)
    .query(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const dbPath = agentPath(folder, 'state', 'agent.db');
      if (!fs.existsSync(dbPath)) return [];
      const db = new AgentDb(dbPath);
      try {
        return db.tokens.byDay({ sinceDays: input.sinceDays });
      } finally {
        db.close();
      }
    }),

  /** Per (conversation, channel, phase, model) rollup, most-recent first. */
  byConversation: adminProcedure
    .input(aliasAndRange.extend({
      limit: z.number().int().positive().max(500).optional(),
    }))
    .query(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const dbPath = agentPath(folder, 'state', 'agent.db');
      if (!fs.existsSync(dbPath)) return [];
      const db = new AgentDb(dbPath);
      try {
        return db.tokens.byConversation({ sinceDays: input.sinceDays, limit: input.limit });
      } finally {
        db.close();
      }
    }),
});
