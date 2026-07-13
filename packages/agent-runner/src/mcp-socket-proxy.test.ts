import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP Client so we can drive callTool/connect outcomes. Each ClientCtor
// call returns a fresh object (distinct identity → reconnect swaps are visible)
// whose methods are the shared mocks (so per-call sequencing works across clients).
// vi.hoisted so the mocks exist before the hoisted vi.mock factories run.
const { connectMock, listToolsMock, callToolMock, closeMock, ClientCtor } = vi.hoisted(() => {
  const connectMock = vi.fn();
  const listToolsMock = vi.fn();
  const callToolMock = vi.fn();
  const closeMock = vi.fn();
  // Regular function (not arrow) so `new Client()` constructs; it returns the
  // object, which `new` then yields.
  const ClientCtor = vi.fn(function () {
    return {
      connect: connectMock,
      listTools: listToolsMock,
      callTool: callToolMock,
      close: closeMock,
    };
  });
  return { connectMock, listToolsMock, callToolMock, closeMock, ClientCtor };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientCtor }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ createSdkMcpServer: vi.fn((c) => c) }));

import { ProxyConnection, classifyTransportError } from './mcp-socket-proxy.js';

const fakeTransport = () => ({}) as never;
const err = (code: string | number, msg = String(code)) => Object.assign(new Error(msg), { code });

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined);
  listToolsMock.mockReset().mockResolvedValue({ tools: [] });
  callToolMock.mockReset();
  closeMock.mockReset().mockResolvedValue(undefined);
  ClientCtor.mockClear();
});

describe('classifyTransportError', () => {
  it('connect-class failures (request never left) are unsent', () => {
    expect(classifyTransportError(err('ECONNREFUSED'))).toBe('unsent');
    expect(classifyTransportError(err('ENOENT'))).toBe('unsent');
    expect(classifyTransportError(new Error('Not connected'))).toBe('unsent');
  });

  it('in-flight / ambiguous failures are inflight', () => {
    expect(classifyTransportError(err('ECONNRESET'))).toBe('inflight');
    expect(classifyTransportError(err('EPIPE'))).toBe('inflight');
    expect(classifyTransportError(err(-32001, 'Request timed out'))).toBe('inflight');
    expect(classifyTransportError(new Error('something unexpected'))).toBe('inflight');
  });
});

describe('ProxyConnection.callTool', () => {
  it('returns the result on the happy path — no reconnect', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const conn = new ProxyConnection(fakeTransport, 'cast');
    await conn.connect();

    const res = await conn.callTool('read_tool', {});

    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(ClientCtor).toHaveBeenCalledTimes(1);
  });

  it('un-sent transport error → reconnects and retries once', async () => {
    callToolMock
      .mockRejectedValueOnce(err('ECONNREFUSED'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok-after-retry' }] });
    const conn = new ProxyConnection(fakeTransport, 'cast');
    await conn.connect();

    const res = await conn.callTool('read_tool', {});

    expect(res).toEqual({ content: [{ type: 'text', text: 'ok-after-retry' }] });
    expect(callToolMock).toHaveBeenCalledTimes(2); // original + retry
    expect(closeMock).toHaveBeenCalledTimes(1);    // dead client torn down
    expect(ClientCtor).toHaveBeenCalledTimes(2);   // reconnected
  });

  it('in-flight transport error → reconnects but does NOT re-send; returns a retryable isError', async () => {
    callToolMock.mockRejectedValue(err('ECONNRESET'));
    const conn = new ProxyConnection(fakeTransport, 'cast');
    await conn.connect();

    const res = await conn.callTool('write_tool', {});

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/transport.*reset/i);
    expect(callToolMock).toHaveBeenCalledTimes(1); // write never re-sent
    expect(ClientCtor).toHaveBeenCalledTimes(2);   // transport restored for next call
  });

  it('tool-level isError result is passed through — not a transport error, no reconnect', async () => {
    callToolMock.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'access denied' }] });
    const conn = new ProxyConnection(fakeTransport, 'cast');
    await conn.connect();

    const res = await conn.callTool('read_tool', {});

    expect(res).toEqual({ isError: true, content: [{ type: 'text', text: 'access denied' }] });
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(ClientCtor).toHaveBeenCalledTimes(1); // no reconnect
  });

  it('retry that also fails returns a retryable isError rather than throwing', async () => {
    callToolMock
      .mockRejectedValueOnce(err('ECONNREFUSED'))
      .mockRejectedValueOnce(err('ECONNREFUSED'));
    const conn = new ProxyConnection(fakeTransport, 'cast');
    await conn.connect();

    const res = await conn.callTool('read_tool', {});

    expect(res.isError).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(2);
  });
});
