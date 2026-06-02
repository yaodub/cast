/**
 * Design strategy — blueprint authoring with full internet.
 *
 * The Design console lives in the blueprint directory and gets unrestricted
 * network so Claude can `npm install`, search docs, and call third-party
 * APIs while authoring service code. Config and secrets are not mounted.
 */
import { DEFAULT_IDLE_TIMEOUT_MS, type AgentChannel } from '../../conversations/types.js';
import { createSnapshot, cleanupSnapshot, sweepOrphanSnapshots } from '../snapshot.js';
import type { ConsoleStrategy } from '../strategy.js';

import { DESIGN_HEADER } from './prompt.js';
import { buildDesignMountAdditions } from './mounts.js';
import { registerDesignTools } from './tools.js';

const DESIGN_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
};

export const designStrategy: ConsoleStrategy = {
  name: 'design',
  channelName: '__design',
  channel: DESIGN_CHANNEL,
  workdir: '/agent/blueprint',
  containerNetwork: 'full',
  promptHeader: DESIGN_HEADER,
  buildMountAdditions: buildDesignMountAdditions,
  onSessionOpen: createSnapshot,
  onRunnerRemoved: cleanupSnapshot,
  sweepOrphanArtifacts: sweepOrphanSnapshots,
  registerTools: registerDesignTools,
  omitAdminNavigate: true,
};
