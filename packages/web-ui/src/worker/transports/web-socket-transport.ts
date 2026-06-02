/**
 * WebSocket transport — generic JSON+binary WS client. Used by chat (one
 * instance per identity, connecting to `/web`) and admin (singleton,
 * connecting to `/api/admin/events?token=...`).
 *
 * Reconnect with exponential backoff. Server-side `WebTransport.drainUndelivered`
 * (`packages/cast/src/transports/web.ts:613`) replays missed packets after
 * reconnect for the chat path; the worker dedups them via the per-identity
 * `processedIds` LRU. Admin has no replay path — gaps surface as
 * `connectionState === 'reconnecting'` in the UI.
 */

import type { CastTransport } from '../interfaces';
import type { ConnectionState as ProtoConnectionState } from '../protocol';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const RECONNECT_FACTOR = 1.5;

export class WebSocketTransport implements CastTransport {
  private readonly url: string;

  private ws: WebSocket | null = null;
  private currentState: ProtoConnectionState = 'disconnected';
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;

  private readonly packetHandlers = new Set<(packet: unknown) => void>();
  private readonly binaryHandlers = new Set<(header: unknown, bytes: Uint8Array) => void>();
  private readonly stateHandlers = new Set<(state: ProtoConnectionState) => void>();

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.ws || this.closed) return;
    this.openSocket();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
    this.setState('disconnected');
  }

  send(envelope: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(envelope));
  }

  sendBinary(header: Record<string, string>, bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const headerBuf = new TextEncoder().encode(JSON.stringify(header));
    const frame = new Uint8Array(4 + headerBuf.length + bytes.length);
    new DataView(frame.buffer).setUint32(0, headerBuf.length);
    frame.set(headerBuf, 4);
    frame.set(bytes, 4 + headerBuf.length);
    this.ws.send(frame);
  }

  onPacket(handler: (packet: unknown) => void): () => void {
    this.packetHandlers.add(handler);
    return () => { this.packetHandlers.delete(handler); };
  }

  onBinary(handler: (header: unknown, bytes: Uint8Array) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => { this.binaryHandlers.delete(handler); };
  }

  onState(handler: (state: ProtoConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => { this.stateHandlers.delete(handler); };
  }

  state(): ProtoConnectionState {
    return this.currentState;
  }

  private openSocket(): void {
    if (this.closed) return;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.setState('connected');
    });

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.parseBinary(new Uint8Array(event.data));
      } else {
        this.parseText(event.data as string);
      }
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.setState('disconnected');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'error' fires before 'close'; let close drive reconnect.
    });
  }

  private parseText(str: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch {
      return;
    }
    for (const h of this.packetHandlers) h(parsed);
  }

  private parseBinary(buf: Uint8Array): void {
    if (buf.length < 4) return;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const headerLen = view.getUint32(0);
    if (4 + headerLen > buf.length) return;
    let header: unknown;
    try {
      header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + headerLen)));
    } catch {
      return;
    }
    const bytes = buf.slice(4 + headerLen);
    for (const h of this.binaryHandlers) h(header, bytes);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
      this.openSocket();
    }, this.reconnectDelay);
  }

  private setState(state: ProtoConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const h of this.stateHandlers) h(state);
  }
}
