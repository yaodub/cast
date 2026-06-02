/**
 * Configure strategy — operator-facing ops console.
 *
 * Runs with `sdk-only` network (Anthropic API only) so secrets and user
 * data can't leak to the internet. Mounts `config/` rw, `blueprint/` ro,
 * `state/` ro, `logs/` ro. `agent.key` lives at `secrets/agent.key`
 * (outside `config/`) and is never mounted.
 */
import { DEFAULT_IDLE_TIMEOUT_MS, type AgentChannel } from '../../conversations/types.js';
import type { ConsoleStrategy } from '../strategy.js';

import { CONFIGURE_HEADER } from './prompt.js';
import { buildConfigureMountAdditions } from './mounts.js';
import { registerConfigureTools } from './tools.js';

const CONFIGURE_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
};

export const configureStrategy: ConsoleStrategy = {
  name: 'configure',
  channelName: '__configure',
  channel: CONFIGURE_CHANNEL,
  workdir: '/agent',
  containerNetwork: 'sdk-only',
  promptHeader: CONFIGURE_HEADER,
  buildMountAdditions: buildConfigureMountAdditions,
  registerTools: registerConfigureTools,
};
