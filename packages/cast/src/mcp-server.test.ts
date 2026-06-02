import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { McpServerDeps, McpAgentContext } from './agent/mcp-server.js';
import { registerTools } from './agent/mcp-server.js';
import { makeTestCtx, makeTestDeps } from './test-helpers.js';
import { feedAppendEvents, type FeedAppendEvent } from './lib/feed-format.js';
import { DEFAULT_CHANNEL, type AgentChannel } from './conversations/types.js';
import { agentPath } from './config.js';
import { _setMockWatcher } from './lib/config-reader.js';
import { FileWatchService } from './agent/file-watch-service.js';

// Real-fs mock watcher for resolveCapabilities() and other config reads. Reads
// directly from disk without caching — fine for tests, since tests always set
// up the agent folder layout before invoking tools.
_setMockWatcher({
  get: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
});

// --- Helpers ---

async function createTestClient(ctx: McpAgentContext, deps: McpServerDeps): Promise<Client> {
  const server = new McpServer({ name: 'cast-test', version: '1.0.0' });
  registerTools(server, ctx, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

function resultText(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as Array<{ type: string; text: string }>)[0].text;
}

// --- Tests ---


describe('task__schedule', () => {
  it('creates a task with valid cron', async () => {
    const client = await createTestClient(makeTestCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'task__schedule',
      arguments: { prompt: 'Check emails', schedule_type: 'cron', schedule_value: '0 9 * * *' },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('Task scheduled');
  });

  it('rejects invalid cron expression', async () => {
    const client = await createTestClient(makeTestCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'task__schedule',
      arguments: { prompt: 'Check emails', schedule_type: 'cron', schedule_value: 'not a cron' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid cron');
  });

  it('creates a one-time task with valid timestamp', async () => {
    const client = await createTestClient(
      makeTestCtx({ agentFolder: 'other', agentId: 'a:other@test' }),
      makeTestDeps(),
    );
    const result = await client.callTool({
      name: 'task__schedule',
      arguments: { prompt: 'Send reminder', schedule_type: 'once', schedule_value: '2026-06-01T00:00:00Z' },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('Task scheduled');
  });
});

// `conversation__push_to_channel` end-to-end coverage lives in
// `agent-push.test.ts`, which exercises the real `buildAgentMcpDeps` over a
// stub bus + stub agent DB. Both-branches discipline
// for tests of security gates: `participantExists`, `gateInbound`, and the
// guard composers are gates that must be tested at the real boundary; mocking
// them at the handler level let the Task-69-era `participantExists` bug
// (and our own variant of it) ship. The old test cases here mocked
// `deliverToChannel`/`deliverToAgent` and thus exercised zero coverage of
// those gates.

// --- file__append_feed tests ---

const TEST_AGENT_FOLDER = 'cast-test-fileappend';

function setupAgentMounts(folder: string): void {
  const agentRoot = agentPath(folder);
  fs.rmSync(agentRoot, { recursive: true, force: true });
  fs.mkdirSync(agentPath(folder, 'memory'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'home'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'blueprint', 'identity'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'blueprint', 'assets'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'shared', 'ext'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'state', 'attachments'), { recursive: true });
  fs.mkdirSync(agentPath(folder, 'sessions', 'testhash', '.claude'), { recursive: true });
}

function makeFileAppendCtx(overrides?: Partial<McpAgentContext>): McpAgentContext {
  const channel: AgentChannel = { ...DEFAULT_CHANNEL, idle_timeout: 60000 };
  return makeTestCtx({
    agentFolder: TEST_AGENT_FOLDER,
    host: { name: TEST_AGENT_FOLDER, folder: TEST_AGENT_FOLDER },
    channel,
    getConversationKey: () => 'default|cli:user',
    ...overrides,
  });
}

describe('file__append_feed', () => {
  beforeEach(() => {
    setupAgentMounts(TEST_AGENT_FOLDER);
    feedAppendEvents.removeAllListeners('append');
  });

  afterEach(() => {
    fs.rmSync(agentPath(TEST_AGENT_FOLDER), { recursive: true, force: true });
    feedAppendEvents.removeAllListeners('append');
  });

  it('appends a row and returns id=1 on first call', async () => {
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/letter.jsonl', data: { msg: 'hello' } },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('id=1');
    expect(events).toHaveLength(1);
    expect(events[0].convKey).toBe('default|cli:user');
    expect(events[0].id).toBe(1);

    const fileContent = fs.readFileSync(agentPath(TEST_AGENT_FOLDER, 'memory', 'letter.jsonl'), 'utf-8');
    expect(fileContent).toBe('{"id":1,"data":{"msg":"hello"}}\n');
  });

  it('persists meta when provided', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/letter.jsonl', data: { msg: 'hi' }, meta: { by: 'alice' } },
    });
    const fileContent = fs.readFileSync(agentPath(TEST_AGENT_FOLDER, 'memory', 'letter.jsonl'), 'utf-8');
    expect(fileContent).toBe('{"id":1,"data":{"msg":"hi"},"meta":{"by":"alice"}}\n');
  });

  it('registered on single-shot channels (idle_timeout: null) — append is fire-and-forget', async () => {
    const singleShotChannel: AgentChannel = { ...DEFAULT_CHANNEL, idle_timeout: null };
    const client = await createTestClient(
      makeFileAppendCtx({ channel: singleShotChannel }),
      makeTestDeps(),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('file__append_feed');

    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/letter.jsonl', data: { msg: 'single-shot' } },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('id=1');
  });

  it.each([
    { label: 'host', overrides: { host: undefined } },
    { label: 'channel', overrides: { channel: undefined } },
  ])('NOT registered when $label is missing', async ({ overrides }) => {
    const client = await createTestClient(
      makeFileAppendCtx(overrides),
      makeTestDeps(),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('file__append_feed');
  });

  it('rejects writes to read-only mount', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/identity/skill-log.jsonl', data: { x: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('read-only');
  });

  it('rejects unmounted parent paths', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/random/foo.jsonl', data: { x: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('No writable mount');
  });

  it('rejects nested parent that does not exist', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/nested/dir/log.jsonl', data: { x: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('does not exist');
  });

  it('refuses to append when existing file is corrupt', async () => {
    fs.writeFileSync(
      agentPath(TEST_AGENT_FOLDER, 'memory', 'corrupt.jsonl'),
      '{"id":1,"data":{}}\nnot json\n',
    );
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/corrupt.jsonl', data: { x: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('corruption');
    expect(events).toHaveLength(0);
  });

  it('emits event with the calling conversation key', async () => {
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const client = await createTestClient(
      makeFileAppendCtx({ getConversationKey: () => 'channel-x|alice' }),
      makeTestDeps(),
    );
    await client.callTool({
      name: 'file__append_feed',
      arguments: { path: '/memory/log.jsonl', data: { x: 1 } },
    });
    expect(events).toHaveLength(1);
    expect(events[0].convKey).toBe('channel-x|alice');
  });

  it('rejects relative path', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const result = await client.callTool({
      name: 'file__append_feed',
      arguments: { path: 'memory/log.jsonl', data: { x: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid');
  });
});

// --- file__watch_feed / file__unwatch / file__list_watches tests ---

describe('file__watch_feed / file__unwatch / file__list_watches', () => {
  const FOLDER = TEST_AGENT_FOLDER;
  let service: FileWatchService;

  beforeEach(async () => {
    setupAgentMounts(FOLDER);
    feedAppendEvents.removeAllListeners('append');
    // Touch a log file so registration's path-must-exist check passes.
    fs.writeFileSync(agentPath(FOLDER, 'memory', 'letter.jsonl'), '');
    service = new FileWatchService({
      folder: FOLDER,
      host: { name: FOLDER, folder: FOLDER },
      agentId: 'a:test@srv',
      route: async () => ({ ok: true, result: null }),
    });
    await service.start();
  });

  afterEach(async () => {
    await service.shutdown();
    fs.rmSync(agentPath(FOLDER), { recursive: true, force: true });
    feedAppendEvents.removeAllListeners('append');
  });

  function watchDeps() {
    return makeTestDeps({ getFileWatchService: () => service });
  }

  it('file__watch_feed registers and reports lastSeenId', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/letter.jsonl' },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('Watch registered on /memory/letter.jsonl');
    expect(service.list('default|cli:user')).toHaveLength(1);
  });

  it('file__watch_feed rejects ENOENT path', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/missing.jsonl' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('does not exist');
  });

  it('file__watch_feed enforces maxWatchesPerChannel cap', async () => {
    // Default cap is 3. Create three log files and register; 4th should fail.
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']) {
      fs.writeFileSync(agentPath(FOLDER, 'memory', name), '');
    }
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());

    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
      const ok = await client.callTool({
        name: 'file__watch_feed',
        arguments: { path: `/memory/${name}` },
      });
      expect(ok.isError).toBeFalsy();
    }

    const overCap = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/d.jsonl' },
    });
    expect(overCap.isError).toBe(true);
    expect(resultText(overCap)).toContain('Watch limit reached (3/3)');
  });

  it('file__watch_feed accepts valid expiresIn', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const before = Date.now();
    const result = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/letter.jsonl', expiresIn: '5m' },
    });
    expect(result.isError).toBeFalsy();
    const entries = service.list('default|cli:user');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.expiresAt).toBeDefined();
    const expiresMs = new Date(entries[0]!.expiresAt!).getTime();
    expect(expiresMs - before).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(expiresMs - before).toBeLessThanOrEqual(5 * 60_000 + 5000);
  });

  it('file__watch_feed rejects invalid expiresIn format', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/letter.jsonl', expiresIn: 'forever' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid duration');
  });

  it('file__watch_feed rejects expiresIn over 30-day cap', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({
      name: 'file__watch_feed',
      arguments: { path: '/memory/letter.jsonl', expiresIn: '90d' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('30-day cap');
  });

  it('file__unwatch removes a registered watch', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    await client.callTool({ name: 'file__watch_feed', arguments: { path: '/memory/letter.jsonl' } });
    expect(service.list('default|cli:user')).toHaveLength(1);

    const result = await client.callTool({
      name: 'file__unwatch',
      arguments: { path: '/memory/letter.jsonl' },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('removed');
    expect(service.list('default|cli:user')).toHaveLength(0);
  });

  it('file__unwatch errors when path is not registered', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({
      name: 'file__unwatch',
      arguments: { path: '/memory/letter.jsonl' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('No watch on /memory/letter.jsonl');
  });

  it('file__list_watches renders empty when none registered', async () => {
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    const result = await client.callTool({ name: 'file__list_watches', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('No watches');
  });

  it('file__list_watches renders both entries with metadata', async () => {
    fs.writeFileSync(agentPath(FOLDER, 'memory', 'second.jsonl'), '');
    const client = await createTestClient(makeFileAppendCtx(), watchDeps());
    await client.callTool({ name: 'file__watch_feed', arguments: { path: '/memory/letter.jsonl' } });
    await client.callTool({ name: 'file__watch_feed', arguments: { path: '/memory/second.jsonl', expiresIn: '1h' } });

    const result = await client.callTool({ name: 'file__list_watches', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain('/memory/letter.jsonl');
    expect(text).toContain('/memory/second.jsonl');
    expect(text).toContain('expires');
  });

  it('all three watch tools NOT registered on single-shot channels', async () => {
    const singleShot: AgentChannel = { ...DEFAULT_CHANNEL, idle_timeout: null };
    const client = await createTestClient(
      makeFileAppendCtx({ channel: singleShot }),
      watchDeps(),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('file__watch_feed');
    expect(names).not.toContain('file__unwatch');
    expect(names).not.toContain('file__list_watches');
  });

  it('all three watch tools NOT registered when getFileWatchService is missing', async () => {
    const client = await createTestClient(makeFileAppendCtx(), makeTestDeps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('file__watch_feed');
    expect(names).not.toContain('file__unwatch');
    expect(names).not.toContain('file__list_watches');
    // file__append_feed stays — it doesn't depend on FileWatchService.
    expect(names).toContain('file__append_feed');
  });
});
