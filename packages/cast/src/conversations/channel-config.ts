import fs from 'fs';
import path from 'path';

import { agentPath } from '../config.js';
import { readText, readParsed } from '../lib/config-reader.js';
import { logger } from '../logger.js';

import { CHANNEL_NAME_RE } from './parse-channel.js';
import type { AgentChannel, ChannelsConfig } from './types.js';
import {
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_NAME,
  ChannelJsonSchema,
} from './types.js';

/**
 * Load channel config for an agent. Reads from `channels/` directory —
 * each subdirectory is a channel with `channel.json` + optional `bootstrap.md`
 * and `cleanup.md`.
 *
 * Individual files are cached via readCached (mtime-based).
 *
 * Always ensures a `default` channel exists.
 */
export function loadChannelsConfig(agentFolder: string): ChannelsConfig {
  const channelsDir = agentPath(agentFolder, 'blueprint', 'channels');

  const config: ChannelsConfig = {};
  try {
    const entries = fs.readdirSync(channelsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      // User channels must be lowercase alphanumeric + hyphens; __ prefix reserved for infrastructure
      if (!CHANNEL_NAME_RE.test(entry.name)) {
        logger.warn({ agentFolder, channel: entry.name }, 'Invalid channel name, skipping');
        continue;
      }
      const channelDir = path.join(channelsDir, entry.name);
      const channel = loadSingleChannel(channelDir, entry.name, agentFolder);
      if (channel) config[entry.name] = channel;
    }
  } catch {
    // No channels dir or read error — use default only
  }

  // Ensure default channel always exists
  if (!config[DEFAULT_CHANNEL_NAME]) {
    config[DEFAULT_CHANNEL_NAME] = DEFAULT_CHANNEL;
  }

  return config;
}

/** Load a single channel from its directory. */
function loadSingleChannel(channelDir: string, name: string, agentFolder: string): AgentChannel | null {
  const jsonPath = path.join(channelDir, 'channel.json');
  try {
    const rawStr = readText(jsonPath);
    if (!rawStr) return null;
    const parsed = ChannelJsonSchema.parse(JSON.parse(rawStr));

    // Derive lifecycle phases from enum
    const bootstrapEnabled = parsed.lifecycle === 'bootstrap-only' || parsed.lifecycle === 'full';
    const cleanupEnabled = parsed.lifecycle === 'cleanup-only' || parsed.lifecycle === 'full';
    const bootstrap = bootstrapEnabled ? readOptionalFile(path.join(channelDir, 'bootstrap.md')) : undefined;
    const cleanup = cleanupEnabled ? readOptionalFile(path.join(channelDir, 'cleanup.md')) : undefined;

    return {
      idle_timeout: parsed.idle_timeout,
      bootstrapEnabled,
      cleanupEnabled,
      log_messages: parsed.log_messages,
      use_sharding: parsed.use_sharding,
      disabled_tools: parsed.disabled_tools,
      show_co_participants: parsed.show_co_participants,
      sealed: parsed.sealed,
      description: parsed.description,
      bootstrap,
      cleanup,
    };
  } catch (err) {
    logger.warn({ err, agentFolder, channel: name }, 'Invalid channel config, skipping');
    return null;
  }
}

/** Read a file if it exists, return undefined otherwise. */
function readOptionalFile(filePath: string): string | undefined {
  const content = readText(filePath);
  if (!content) return undefined;
  const trimmed = content.trim();
  return trimmed || undefined;
}

/** Get a specific channel config, or undefined if it doesn't exist. */
export function getChannel(
  config: ChannelsConfig,
  channelName: string,
): AgentChannel | undefined {
  return config[channelName];
}
