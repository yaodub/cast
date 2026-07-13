/**
 * Agent creation for the admin UI.
 *
 * Writes the minimal file set an agent needs to discover, register, and boot —
 * then the caller (tRPC `agent.create`) triggers discovery+registration.
 *
 * The manifest carries the base spec fields (spec, name, pubkey, status) plus
 * an optional description when the caller seeds one. Tooling that generates
 * agents may add provenance metadata via the schema's passthrough; this path
 * does not.
 */
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AgentManifestSchema, BLUEPRINT_SUBDIRS, INSTANCE_LAYERS, EPHEMERAL_LAYERS, SPEC_VERSION,
} from '@getcast/agent-schema/v1';

import { AGENTS_DIR } from '../config.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../conversations/types.js';
import { writeAtomic } from '../lib/utils.js';

import { agentNameSchema } from './schemas.js';

export class AgentCreateError extends Error {
  constructor(message: string, readonly code: 'INVALID_NAME' | 'ALREADY_EXISTS') {
    super(message);
    this.name = 'AgentCreateError';
  }
}

/**
 * Create a minimal agent at `AGENTS_DIR/<name>` in draft status.
 * Returns the agent folder (== name). Throws `AgentCreateError` on caller-
 * correctable errors; anything else bubbles as an unexpected failure.
 *
 * An optional `description` is written into the manifest when provided (the
 * one human-readable manifest field a creator can seed up front — Design
 * Manager passes the per-agent one-liner here). Omitted leaves it unset, same
 * as before; per-agent Design can fill or refine it later.
 */
export function createAgentScratch(name: string, description?: string): string {
  const validated = agentNameSchema.safeParse(name);
  if (!validated.success) {
    throw new AgentCreateError(
      `Agent name "${name}" invalid: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      'INVALID_NAME',
    );
  }

  const agentDir = path.join(AGENTS_DIR, name);
  if (fs.existsSync(agentDir)) {
    throw new AgentCreateError(`Agent "${name}" already exists`, 'ALREADY_EXISTS');
  }

  for (const sub of BLUEPRINT_SUBDIRS) {
    fs.mkdirSync(path.join(agentDir, 'blueprint', sub), { recursive: true });
  }
  for (const layer of [...INSTANCE_LAYERS, ...EPHEMERAL_LAYERS]) {
    fs.mkdirSync(path.join(agentDir, layer), { recursive: true });
  }
  fs.mkdirSync(path.join(agentDir, 'ext', 'service'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'shared', 'ext', 'service'), { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const secretsDir = path.join(agentDir, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(secretsDir, 'agent.key');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pubkeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubkey = createHash('sha256').update(pubkeyDer).digest('hex').slice(0, 16);

  writeAtomic(
    path.join(agentDir, 'config', 'acl.json'),
    JSON.stringify({
      owner: 'operator',
      allowed: {},
    }, null, 2) + '\n',
  );

  writeAtomic(
    path.join(agentDir, 'config', 'agent.json'),
    JSON.stringify({ backup: { retain: 7, hour: 3 } }, null, 2) + '\n',
  );

  // Service secrets land in config/ext/service/secrets.json, written by the
  // admin router on first save — only the directory is seeded here.
  fs.mkdirSync(path.join(agentDir, 'config', 'ext', 'service'), { recursive: true });

  writeAtomic(
    path.join(agentDir, 'blueprint', 'identity', 'prompt.md'),
    '',
  );

  fs.mkdirSync(path.join(agentDir, 'blueprint', 'channels', 'default'), { recursive: true });
  writeAtomic(
    path.join(agentDir, 'blueprint', 'channels', 'default', 'channel.json'),
    JSON.stringify({
      idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
      lifecycle: 'none',
      log_messages: true,
      use_sharding: false,
      disabled_tools: [],
    }, null, 2) + '\n',
  );
  writeAtomic(path.join(agentDir, 'blueprint', 'channels', 'default', 'prompt.md'), '');

  writeAtomic(
    path.join(agentDir, 'blueprint', 'props', 'capabilities.json'),
    JSON.stringify({ disabled_tools: [], extensions: {} }, null, 2) + '\n',
  );

  const manifest = AgentManifestSchema.parse({
    spec: SPEC_VERSION,
    name,
    pubkey,
    ...(description !== undefined ? { description } : {}),
    status: 'draft',
  });
  writeAtomic(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Sanity check: round-trip the key we just wrote so a malformed ed25519
  // export fails here instead of later during discovery.
  const privKeyPem = fs.readFileSync(keyPath, 'utf-8');
  const priv = createPrivateKey({ key: privKeyPem, format: 'pem' });
  createPublicKey(priv);

  return name;
}
