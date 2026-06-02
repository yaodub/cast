/**
 * WhatsApp extension — Baileys socket lifecycle.
 *
 * Manages auth state, connection, reconnection, and event wiring to the store.
 * One socket per extension instance.
 */
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessageKey } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import type { Logger } from '@getcast/extension-schema';
import type { WhatsAppStore } from './store.js';
import { isRegistered } from './helpers.js';
import { WA_VERSION, baileysLogger } from './constants.js';

// ---------------------------------------------------------------------------
// Connection state (discriminated union)
// ---------------------------------------------------------------------------

type ConnectionStatus =
  | { status: 'unpaired' }
  | { status: 'connecting'; attempt: number }
  | { status: 'open' }
  | { status: 'disconnected'; attempt: number };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECONNECT_DELAY_MS = 60_000;
const CHATS_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export interface ConnectionManagerOpts {
  privateDir: string;
  store: WhatsAppStore;
  log: Logger;
  getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  /** 'standard' (~3 months, Chrome) or 'extended' (~1 year, Desktop). */
  pairingHistoryDepth: 'standard' | 'extended';
}

export class ConnectionManager {
  private sock: WASocket | null = null;
  private state: ConnectionStatus = { status: 'unpaired' };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private chatsReceived = false;

  // Ready state — resolves when connected + initial chats received (or grace period expires)
  private readyResolve!: () => void;
  private readyPromise: Promise<void>;

  private readonly authDir: string;

  constructor(private opts: ConnectionManagerOpts) {
    this.authDir = path.join(opts.privateDir, 'auth');
    this.readyPromise = new Promise<void>(r => { this.readyResolve = r; });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  get socket(): WASocket | null { return this.sock; }

  get ready(): Promise<void> { return this.readyPromise; }

  isPaired(): boolean {
    if (this.state.status === 'unpaired') return false;
    return isRegistered(this.authDir);
  }

  isConnected(): boolean {
    return this.state.status === 'open';
  }

  async connect(): Promise<void> {
    if (!isRegistered(this.authDir)) {
      this.state = { status: 'unpaired' };
      return;
    }

    this.state = { status: 'connecting', attempt: 0 };
    await this.initSocket();
  }

  /**
   * Start pairing flow using the extension's own socket. Creates auth dir,
   * connects, requests a 6-digit code. The socket stays alive — all events
   * (history sync, chats, contacts) flow into the store via the normal
   * wireEvents path. Returns the pairing code.
   */
  async pair(phoneNumber: string): Promise<string> {
    // Clean slate: disconnect any existing socket
    this.disconnect();

    fs.mkdirSync(this.authDir, { recursive: true });
    this.state = { status: 'connecting', attempt: 0 };
    await this.initSocket();

    // Wait for WS handshake before requesting pairing code
    const sock = this.sock!;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connect timeout')), 15_000);
      const handler = ({ connection }: { connection?: string }) => {
        if (connection === 'connecting') {
          clearTimeout(timeout);
          // Brief delay for socket to stabilize
          setTimeout(resolve, 1500);
        }
      };
      sock.ev.on('connection.update', handler);
    });

    const digits = phoneNumber.replace(/\D/g, '');
    return sock.requestPairingCode(digits);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.sock) {
      this.sock.ev.removeAllListeners('connection.update');
      this.sock.ev.removeAllListeners('creds.update');
      this.sock.ev.removeAllListeners('messages.upsert');
      this.sock.ev.removeAllListeners('messaging-history.set');
      this.sock.ev.removeAllListeners('chats.upsert');
      this.sock.ev.removeAllListeners('chats.update');
      this.sock.ev.removeAllListeners('contacts.upsert');
      this.sock.ev.removeAllListeners('contacts.update');
      this.sock.ev.removeAllListeners('groups.upsert');
      this.sock.ev.removeAllListeners('group-participants.update');
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  // =========================================================================
  // Internal — socket init + event wiring
  // =========================================================================

  private async initSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);

    const extended = this.opts.pairingHistoryDepth === 'extended';
    const sock = makeWASocket({
      version: WA_VERSION,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, baileysLogger),
      },
      browser: extended ? Browsers.macOS('Desktop') : Browsers.macOS('Chrome'),
      syncFullHistory: extended,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true,
      logger: baileysLogger,
      getMessage: this.opts.getMessage,
    });

    this.sock = sock;
    this.wireEvents(sock, saveCreds);
  }

  private wireEvents(sock: WASocket, saveCreds: () => Promise<void>): void {
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.opts.log.info('WhatsApp connected');
        this.state = { status: 'open' };

        if (this.chatsReceived) {
          this.readyResolve();
        } else {
          // Grace period: wait for chats.upsert before resolving ready
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            this.readyResolve();
          }, CHATS_GRACE_MS);
        }
      }

      if (update.connection === 'close') {
        const err = update.lastDisconnect?.error;
        this.handleDisconnect(err);
      }
    });

    sock.ev.on('creds.update', () => {
      saveCreds().catch(e => this.opts.log.warn({ err: e }, 'saveCreds failed'));
    });

    sock.ev.on('messages.upsert', (data) => {
      this.opts.store.ingestMessages(data.messages, data.type);
    });

    sock.ev.on('messaging-history.set', (data) => {
      this.opts.store.ingestHistoryMessages(data);
    });

    sock.ev.on('chats.upsert', (chats) => {
      this.opts.store.ingestChats(chats);
      this.chatsReceived = true;
      // If connected and within grace period, resolve ready immediately
      if (this.state.status === 'open') {
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.readyResolve();
      }
    });

    sock.ev.on('chats.update', (updates) => {
      this.opts.store.updateChats(updates);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      this.opts.store.ingestContacts(contacts);
    });

    sock.ev.on('contacts.update', (updates) => {
      this.opts.store.updateContacts(updates);
    });

    // Group events carry per-participant `{id, phoneNumber, lid}` pairs —
    // an authoritative pair source for every group member.
    sock.ev.on('groups.upsert', (groups) => {
      this.opts.store.ingestGroupMetadata(groups);
    });

    sock.ev.on('group-participants.update', (update) => {
      this.opts.store.ingestGroupParticipantsUpdate(update);
    });
  }

  // =========================================================================
  // Internal — disconnect + reconnect
  // =========================================================================

  private handleDisconnect(error: Error | undefined): void {
    // Baileys wraps disconnect errors as @hapi/boom — check output.statusCode structurally
    const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.opts.log.error('WhatsApp logged out — session invalidated');
      this.disconnect();
      this.state = { status: 'unpaired' };
      return;
    }

    // Any other disconnect (including 515 restartRequired) — reconnect
    const prevAttempt = this.state.status === 'disconnected' ? this.state.attempt : 0;
    this.opts.log.warn(
      { statusCode, attempt: prevAttempt },
      'WhatsApp disconnected, reconnecting',
    );

    this.sock = null;
    this.rearmReady();
    this.scheduleReconnect(prevAttempt);
  }

  private scheduleReconnect(attempt: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
    this.state = { status: 'disconnected', attempt: attempt + 1 };

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initSocket().catch(err => {
        this.opts.log.error({ err }, 'WhatsApp reconnect failed');
        this.scheduleReconnect(attempt + 1);
      });
    }, delay);
  }

  /** Replace the ready Promise so tools block again until reconnection completes. */
  private rearmReady(): void {
    this.chatsReceived = false;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.readyPromise = new Promise<void>(r => { this.readyResolve = r; });
  }
}
