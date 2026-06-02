/**
 * MCP servers admin router — list declarations and provision env secrets.
 *
 * Reads MCP server declarations from capabilities.json (blueprint-owned).
 * Reads/writes operator env values from config/mcp-servers.json.
 */
import fs from 'fs';
import { z } from 'zod';

import { McpServerSecretsSchema } from '@getcast/agent-schema/v1';
import { agentPath, readCapabilities, readMcpServerSecrets } from '../../config.js';
import { readParsed } from '../../lib/config-reader.js';
import { mcpServerSetEnvInput } from '../schemas.js';
import { aliasToFolder, adminProcedure, maskSecret, router } from '../trpc.js';

const aliasInput = z.object({ alias: z.string() });

export const mcpServersRouter = router({
  /** List declared MCP servers with env slot metadata and provisioned status. */
  list: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const caps = readCapabilities(folder);
    const secrets = readMcpServerSecrets(folder);

    return Object.entries(caps.mcp_servers).map(([name, decl]) => {
      const operatorEnv = secrets[name] ?? {};
      const envSlots = Object.entries(decl.env).map(([key, slot]) => {
        if (typeof slot === 'string') {
          return { key, locked: true, value: slot, required: false, description: undefined, set: true };
        }
        const operatorValue = operatorEnv[key];
        return {
          key,
          locked: false,
          value: operatorValue ? maskSecret(operatorValue) : (slot.value || ''),
          required: slot.required,
          description: slot.description,
          set: !!operatorValue,
        };
      });

      return {
        name,
        transport: decl.transport,
        command: decl.command,
        args: decl.args,
        url: decl.url,
        envSlots,
      };
    });
  }),

  /** Set env values for a specific MCP server. Only writes unlocked slots. */
  setEnv: adminProcedure
    .input(mcpServerSetEnvInput)
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const caps = readCapabilities(folder);
      const decl = caps.mcp_servers[input.server];
      if (!decl) {
        throw new Error(`MCP server "${input.server}" not declared in capabilities.json`);
      }

      // Only allow writing to unlocked env slots
      for (const key of Object.keys(input.env)) {
        const slot = decl.env[key];
        if (typeof slot === 'string') {
          throw new Error(`Env var "${key}" is locked by the blueprint author`);
        }
        if (!slot) {
          throw new Error(`Env var "${key}" is not declared for MCP server "${input.server}"`);
        }
      }

      const secretsPath = agentPath(folder, 'config', 'mcp-servers.json');
      const allSecrets = readParsed(secretsPath, McpServerSecretsSchema, {});

      allSecrets[input.server] = { ...(allSecrets[input.server] ?? {}), ...input.env };
      fs.mkdirSync(agentPath(folder, 'config'), { recursive: true });
      fs.writeFileSync(secretsPath, JSON.stringify(allSecrets, null, 2));
      return { ok: true };
    }),
});
