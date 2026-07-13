/**
 * Discovery tools — `agent__list_channels` / `agent__list_participants`:
 * registration + handler matrix at the real boundary.
 *
 * Both tools register capability-wide (every conversation cell including peer
 * cells, plus owner-context sockets); SCOPING lives in the deps
 * (`agent-mcp-deps.ts`), which read the same merged-peers substrate as the
 * push verdict. So the tests run the real `buildAgentMcpDeps` over a real
 * `Bus` + real `AgentDb` + real acl.json / channel.json fixtures on disk —
 * what they assert is the dep's verdict-mirrored scoping, which a handler-level
 * stub could never prove.
 *
 * Matrix (README scoping table + DESIGN §7):
 *   read tier (self / operator)  × all channels, unfiltered rooms, registry view
 *   user-member                  × own rooms only; posture-off ⇒ own rows + note
 *   agent-member (peer cell)     × own rooms only; M1 adversarial row
 *   non-member / configured u: owner × uniform deny (write ⊄ read)
 *   deny pair                    × unauthorized == nonexistent (byte-identical)
 *   two switches                 × cell-side disabled_tools vs room-side posture
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { _setMockWatcher } from './lib/config-reader.js';
import { Bus, type BusHandler } from './gateway/bus.js';
import { AgentDb } from './agent/agent-db.js';
import { buildAgentMcpDeps, type AgentMcpDepsContext } from './agent/agent-mcp-deps.js';
import { registerTools } from './agent/mcp-server.js';
import { channelAuthDenial } from './auth/conversation-context.js';
import { agentPath } from './config.js';
import { makeTestCtx } from './test-helpers.js';

// Real-fs watcher so acl.json and channel.json fixtures are read from disk.
_setMockWatcher({
  get: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const AGENT_ID = 'a:self@srv';
const AGENT_FOLDER = 'list-tools-test-agent';
const PEER = 'a:peer@srv';
const ALICE = 'u:alice@srv';
const BOB = 'u:bob@srv';
const OWNER = 'u:owner@srv';
const STRANGER = 'u:mallory@srv';

// Channels: `relay` (open, sharded), `quiet` (posture off), `ghost` (ACL
// placement with NO config dir), `default` (auto-injected by loadChannelsConfig).
const ACL = {
  owner: OWNER,
  allowed: {
    [PEER]: { relay: 'a' },
    [ALICE]: { relay: 'i', quiet: 'io', ghost: 'io' },
    [BOB]: { relay: 'io', quiet: 'i' },
  },
};

function writeFixtures(): void {
  fs.rmSync(agentPath(AGENT_FOLDER), { recursive: true, force: true });
  fs.mkdirSync(agentPath(AGENT_FOLDER, 'config'), { recursive: true });
  fs.writeFileSync(agentPath(AGENT_FOLDER, 'config', 'acl.json'), JSON.stringify(ACL));
  const channel = (name: string, json: object) => {
    const dir = agentPath(AGENT_FOLDER, 'blueprint', 'channels', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify(json));
  };
  channel('relay', { idle_timeout: null, use_sharding: true });
  channel('quiet', { idle_timeout: null, show_co_participants: false });
}

interface Harness {
  agentDb: AgentDb;
  cleanup: () => void;
  clientFor: (
    participant: string | null,
    channelName: string | null,
    disabledTools?: string[],
  ) => Promise<Client>;
}

function buildHarness(): Harness {
  writeFixtures();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-tools-test-'));
  const agentDb = new AgentDb(path.join(tmpDir, 'agent.db'));
  const bus = new Bus();
  const noop: BusHandler = { handleMessage: async () => {}, handleEvent: async () => {} };
  bus.register(AGENT_ID, noop, 'exact', { label: AGENT_FOLDER, type: 'agent', folderPath: AGENT_FOLDER });
  bus.register(PEER, noop, 'exact', { label: 'peer', type: 'agent', folderPath: 'peer' });

  const depsCtx: AgentMcpDepsContext = {
    agentId: AGENT_ID,
    folder: AGENT_FOLDER,
    bus,
    agentDb,
    route: async () => ({ ok: true as const, result: null }),
    getApprovals: () => { throw new Error('approvals not wired in test'); },
    listSiblingAgents: undefined,
    requestConversationEnd: () => ({ accepted: false, cooldownSeconds: 0 }),
    getFileWatchService: () => { throw new Error('file-watch not wired in test'); },
  };
  const deps = buildAgentMcpDeps({}, depsCtx);

  return {
    agentDb,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(agentPath(AGENT_FOLDER), { recursive: true, force: true });
    },
    clientFor: async (participant, channelName, disabledTools) => {
      const ctx = makeTestCtx({
        agentFolder: AGENT_FOLDER,
        agentId: AGENT_ID,
        participant,
        channelName,
        ...(disabledTools ? { disabledTools } : {}),
      });
      const server = new McpServer({ name: 'cast-test', version: '1.0.0' });
      registerTools(server, ctx, deps);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);
      return client;
    },
  };
}

function resultText(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as Array<{ type: string; text: string }>)[0].text;
}

let h: Harness;
beforeEach(() => {
  h = buildHarness();
  // Alice has interacted (registry recency); Bob is placed via ACL only.
  h.agentDb.upsertParticipant(`${ALICE}/tg:1`);
});
afterEach(() => {
  h.cleanup();
});

// ----------------------------------------------------------------------------
// Registration — capability-wide; cell-side disabled_tools is the off switch
// ----------------------------------------------------------------------------

describe('discovery tools — registration', () => {
  it('a peer cell registers both tools (M1 closure is scope, not absence)', async () => {
    const client = await h.clientFor(PEER, 'relay');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('agent__list_channels');
    expect(names).toContain('agent__list_participants');
  });

  it('an owner-context socket (no participant) registers both tools', async () => {
    const client = await h.clientFor(null, null);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('agent__list_channels');
    expect(names).toContain('agent__list_participants');
  });

  it('cell-side disabled_tools disarms per tool, per cell — the room is untouched', async () => {
    const client = await h.clientFor(ALICE, 'relay', ['agent__list_participants']);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('agent__list_participants');
    expect(names).toContain('agent__list_channels');
    // Same room, different cell: the tool is live — the switch is cell-side.
    const other = await h.clientFor(BOB, 'relay');
    const otherNames = (await other.listTools()).tools.map((t) => t.name);
    expect(otherNames).toContain('agent__list_participants');
  });
});

// ----------------------------------------------------------------------------
// agent__list_channels — placements per caller class
// ----------------------------------------------------------------------------

describe('agent__list_channels', () => {
  async function channelsText(participant: string | null, channelName: string | null): Promise<string> {
    const client = await h.clientFor(participant, channelName);
    const r = await client.callTool({ name: 'agent__list_channels', arguments: {} });
    expect(r.isError).toBeFalsy();
    return resultText(r);
  }

  it('peer cell sees exactly its placed rooms, sharded rendering intact', async () => {
    const text = await channelsText(PEER, 'relay');
    expect(text).toContain('relay~*');
    expect(text).toContain('your access: a');
    expect(text).not.toContain('quiet');
    expect(text).not.toContain('default');
  });

  it('user member sees its placed rooms with posture and missing-config markers', async () => {
    const text = await channelsText(ALICE, 'relay');
    expect(text).toContain('relay~*');
    expect(text).toContain('quiet');
    expect(text).toContain('[co-participant visibility off]');
    expect(text).toContain('- ghost — your access: io [no channel config]');
    expect(text).not.toContain('default');
  });

  it('read tier sees every configured channel without placement bits', async () => {
    const text = await channelsText('cli:operator', 'default');
    expect(text).toContain('relay~*');
    expect(text).toContain('quiet');
    expect(text).toContain('default');
    // Config keys, not ACL placements: ghost has no config dir.
    expect(text).not.toContain('ghost');
    expect(text).not.toContain('your access:');
  });

  it('a stranger gets an empty list', async () => {
    const text = await channelsText(STRANGER, 'relay');
    expect(text).toBe('No channels to list.');
  });

  it('the configured u: owner gets an empty list — write tier does not widen reads', async () => {
    const text = await channelsText(`${OWNER}/tg:9`, 'relay');
    expect(text).toBe('No channels to list.');
  });
});

// ----------------------------------------------------------------------------
// agent__list_participants — room membership per caller class
// ----------------------------------------------------------------------------

describe('agent__list_participants', () => {
  async function callList(
    participant: string | null,
    channelName: string | null,
    channelArg?: string,
  ): Promise<{ isError: boolean; text: string }> {
    const client = await h.clientFor(participant, channelName);
    const r = await client.callTool({
      name: 'agent__list_participants',
      arguments: channelArg === undefined ? {} : { channel: channelArg },
    });
    return { isError: !!r.isError, text: resultText(r) };
  }

  it('peer cell lists its current room: users as push targets, itself as counterparty', async () => {
    const { isError, text } = await callList(PEER, 'relay');
    expect(isError).toBe(false);
    // Alice has a registry row → day-granularity recency; Bob is ACL-only.
    expect(text).toMatch(new RegExp(`${ALICE} \\(last active: \\d{4}-\\d{2}-\\d{2}\\)`));
    expect(text).toContain(`${BOB} (no session yet)`);
    expect(text).toContain(`${PEER} — peer agent (request counterparty, not a push target)`);
    // Day-granular recency only — no exact timestamp (no `T`) leaks into room scope.
    expect(text).not.toMatch(/last active: [^)]*T/);
  });

  it('M1 adversarial row: a peer with one room\'s `a` gets zero rows from every other channel and no registry view', async () => {
    for (const channel of ['quiet', 'default', 'ghost']) {
      const { isError, text } = await callList(PEER, 'relay', channel);
      expect(isError).toBe(true);
      expect(text).toBe(channelAuthDenial(channel));
    }
    // Channel omitted resolves to the CURRENT channel, never the registry.
    const { text: scoped } = await callList(PEER, 'relay');
    expect(scoped).not.toContain('Participants:');
  });

  it('deny pair: unauthorized channel and nonexistent channel are byte-identical', async () => {
    const unauthorized = await callList(STRANGER, 'relay', 'quiet');
    const nonexistent = await callList(STRANGER, 'relay', 'no-such-channel');
    expect(unauthorized.isError).toBe(true);
    expect(nonexistent.isError).toBe(true);
    expect(unauthorized.text).toBe(channelAuthDenial('quiet'));
    expect(nonexistent.text).toBe(channelAuthDenial('no-such-channel'));
    // Same wording as the push verdict — the chokepoint guarantee.
    expect(unauthorized.text.replace('quiet', 'X')).toBe(nonexistent.text.replace('no-such-channel', 'X'));
  });

  it('room-side posture: a member sees only its own row + population-blind note', async () => {
    const { isError, text } = await callList(ALICE, 'quiet');
    expect(isError).toBe(false);
    expect(text).toContain(ALICE);
    expect(text).not.toContain(BOB);
    expect(text).toContain('Co-participant visibility is disabled on this channel');
  });

  it('room-side posture hides members from member-tier callers from ANY room', async () => {
    // Alice asks about `quiet` from her `relay` cell — posture still applies.
    const { text } = await callList(ALICE, 'relay', 'quiet');
    expect(text).not.toContain(BOB);
    expect(text).toContain('Co-participant visibility is disabled on this channel');
  });

  it('read tier sees a posture-off room unfiltered, with a marker note', async () => {
    const { isError, text } = await callList('cli:operator', 'default', 'quiet');
    expect(isError).toBe(false);
    expect(text).toContain(ALICE);
    expect(text).toContain(BOB);
    expect(text).toContain('disabled on this channel for member-tier callers');
  });

  it('sharded qualifier is accepted and stripped — shards share the room membership', async () => {
    const base = await callList(ALICE, 'quiet', 'relay');
    const sharded = await callList(ALICE, 'quiet', 'relay~daily');
    expect(sharded.isError).toBe(false);
    expect(sharded.text).toBe(base.text);
  });

  it('read tier with channel omitted gets the registry view — exact timestamps, today\'s rendering', async () => {
    const { isError, text } = await callList(null, null);
    expect(isError).toBe(false);
    expect(text).toContain('Participants:');
    // Identity-keyed registry row with the full ISO timestamp.
    expect(text).toMatch(new RegExp(`- ${ALICE} \\(last active: \\d{4}-\\d{2}-\\d{2}T`));
  });

  it('read tier in a conversation cell with channel omitted STILL gets the registry (scheduler back-compat)', async () => {
    // A self-fire / operator cell carries a channel; "omitted = current"
    // would blind the scheduler's notify flows. Naming the channel opts
    // into the room view instead.
    const cell = await callList(AGENT_ID, 'relay');
    expect(cell.isError).toBe(false);
    expect(cell.text).toContain('Participants:');
    const named = await callList(AGENT_ID, 'relay', 'relay');
    expect(named.text).toContain('Members of "relay"');
  });

  it('the configured u: owner is denied on rooms it is not placed in (write ⊄ read)', async () => {
    const { isError, text } = await callList(`${OWNER}/tg:9`, 'relay', 'relay');
    expect(isError).toBe(true);
    expect(text).toBe(channelAuthDenial('relay'));
  });
});
