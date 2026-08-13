/**
 * Google Messages extension — session + stream lifecycle.
 *
 * Wraps the `gmessages` library's `connect()` with the four things a long-lived
 * agent connection needs that the protocol layer deliberately does not provide
 * (docs/AGENTS.md): a durable single-writer session store, deliberate reconnect
 * keyed on WHY the stream died, pairing from cookies, and pairing-status gating.
 *
 * The library is a trusted dependency — its protocol is oracle-verified. What
 * this file adds is glue, and the glue is what the tests exercise. Every library
 * entry point used here is injected through `ConnectionDeps` so the reconnect
 * state machine, backoff, and pairing plumbing are testable with no socket, no
 * filesystem, and no account.
 *
 * Session-store discipline (docs/AGENTS.md checklist): one writer per session.
 * The running agent owns `session.json`; the admin hook only reads presence.
 */
import fs from 'fs';
import path from 'path';

import {
  connect as realConnect,
  nodeFileStore,
  pairFromCookies,
  sessionFromPairing,
  serializeSessionFile,
  parseCookieJar,
  GOOGLE_ENDPOINTS,
  GOOGLE_WEB_API_KEY,
} from 'gmessages';
import type {
  Client,
  ClientEvent,
  ConnectOptions,
  DeathReason,
  Endpoints,
  VerificationPrompt,
} from 'gmessages';

import type { Logger } from '@getcast/extension-schema';
import { noopLogger } from '@getcast/extension-schema';

import { SESSION_FILE, isPaired } from './connect.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
/**
 * How long a connection must stay open before its death resets the backoff.
 *
 * Resetting on every open would let a flapping stream (opens, dies immediately,
 * repeat) retry at the 1s floor forever. Only a connection that held for this
 * long counts as "stable" and earns a fresh fast retry; a fast flap keeps
 * escalating toward the 60s cap.
 */
const MIN_STABLE_MS = 30_000;

// ---------------------------------------------------------------------------
// Connection state (discriminated union)
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | { status: 'idle' }
  | { status: 'unpaired' }
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting'; attempt: number }
  /** Non-retryable death (jar exhausted, auth rejected). Requires a re-pair. */
  | { status: 'dead'; reason: DeathReason }
  | { status: 'stopped' };

/**
 * Is a stream death worth reconnecting for?
 *
 * - `jar-dead` — the cookies stopped advancing; the session is spent and no
 *   reconnect revives it. Re-pair.
 * - `stream-fatal` 401/403 — the token/session was rejected. Re-pair.
 * - everything else (`stream-error`, `refresh-failed`, other fatal statuses) —
 *   plausibly transient (network, a relay hiccup). Back off and retry.
 *
 * Fails toward retry: an unclassified reason reconnects rather than parking a
 * live account as dead over something a retry would have cleared.
 */
export function isRetryable(reason: DeathReason): boolean {
  switch (reason.kind) {
    case 'jar-dead':
      return false;
    case 'stream-fatal':
      return reason.status !== 401 && reason.status !== 403;
    default:
      return true;
  }
}

/**
 * Codes `connect()` THROWS (as opposed to reporting through `finished()`) that
 * no amount of retrying fixes. A stale session hits this on the very first
 * attempt — the relay 401s the jar and the library throws `JarDeadError` before
 * a stream ever exists, so `isRetryable` never sees it.
 *
 * Matched on `code`, the library's stable discriminant, which holds where
 * `instanceof` does not (two copies of the package in one tree).
 */
const FATAL_CONNECT_CODES = new Set([
  // Cookies no longer authenticate; the jar is spent. Re-pair.
  'JarDeadError',
  // Thrown before any network use when the session carries no pairing, or the
  // signing/payload keys cannot be read. A retry re-reads the same bad session.
  'EndpointError',
  'SessionImportError',
  'PairingError',
]);

/**
 * Classify an error thrown out of `connect()`. Returns the equivalent
 * `DeathReason` when it is terminal, or null when a retry is worth attempting
 * (transport blips, DNS, a relay hiccup).
 */
export function fatalConnectReason(error: unknown): DeathReason | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !FATAL_CONNECT_CODES.has(code)) return null;
  return code === 'JarDeadError'
    ? { kind: 'jar-dead' }
    : { kind: 'refresh-failed', error };
}

// ---------------------------------------------------------------------------
// Injectable dependencies (all default to the real library)
// ---------------------------------------------------------------------------

/** Input to the pairing composition, minus the transport wiring the deps supply. */
export interface PairInput {
  readonly cookies: string;
  readonly endpoints: Endpoints;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly onVerification: (prompt: VerificationPrompt) => void | Promise<void>;
  /**
   * Cookie rotations absorbed DURING the flow.
   *
   * Pairing advances the jar as it goes, and those rotations exist only in
   * memory until someone persists them. A caller whose cookies came from a
   * durable store (a file, a KV row) must write them back — otherwise an
   * ABANDONED attempt leaves that store behind the account's real jar, and the
   * next use of it authenticates against cookies Google has already superseded.
   * Cast itself consumes cookies once and keeps the session instead, so it has
   * no store to update and leaves this unset.
   */
  readonly onJarUpdate?: (jar: Readonly<Record<string, string>>) => void;
}

export interface ConnectionDeps {
  /** The library's `connect`. The primary test seam. */
  connect: (options: ConnectOptions) => Promise<Client>;
  /** Load the durable session blob + its single-writer persist sink. */
  loadStore: (
    filePath: string,
  ) => Promise<{ session?: string; onSessionUpdate: (blob: string) => void | Promise<void> }>;
  /** Cookies → completed-pairing session blob + the prompt shown en route. */
  pair: (input: PairInput) => Promise<{ blob: string; prompt: VerificationPrompt }>;
  /** Persist the initial session blob (0600). */
  writeSession: (filePath: string, blob: string) => Promise<void>;
  fetchImpl: typeof fetch;
  endpoints: Endpoints;
  apiKey: string;
  /** Backoff sleep. Injected so tests advance time without waiting. */
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since epoch, for the stability threshold. Injected for tests. */
  now: () => number;
}

async function defaultPair(input: PairInput): Promise<{ blob: string; prompt: VerificationPrompt }> {
  let captured: VerificationPrompt | undefined;
  const result = await pairFromCookies({
    endpoints: input.endpoints,
    cookies: parseCookieJar(input.cookies),
    fetchImpl: input.fetchImpl,
    apiKey: input.apiKey,
    ...(input.onJarUpdate ? { onJarUpdate: input.onJarUpdate } : {}),
    onVerification: async (prompt) => {
      captured = prompt;
      await input.onVerification(prompt);
    },
  });
  const blob = serializeSessionFile(sessionFromPairing(result));
  // `onVerification` runs before the flow resolves, so `captured` is always set here.
  return { blob, prompt: captured! };
}

async function defaultWriteSession(filePath: string, blob: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, blob, { mode: 0o600 });
}

export function defaultDeps(): ConnectionDeps {
  return {
    connect: realConnect,
    loadStore: nodeFileStore,
    pair: defaultPair,
    writeSession: defaultWriteSession,
    fetchImpl: fetch,
    endpoints: GOOGLE_ENDPOINTS,
    apiKey: GOOGLE_WEB_API_KEY,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

/** The subset of ConnectionManager the extension depends on (test seam). */
export interface ConnectionLike {
  start(): void;
  stop(): Promise<void>;
  pair(
    cookies: string,
    onVerification: (prompt: VerificationPrompt) => void | Promise<void>,
  ): Promise<VerificationPrompt>;
  isPaired(): boolean;
  isConnected(): boolean;
  ownParticipantId(): string;
  deadReason(): string | null;
  readonly ready: Promise<void>;
  readonly socket: Client | null;
}

export interface ConnectionManagerOpts {
  privateDir: string;
  log?: Logger;
  /** Decoded stream events, forwarded to the watch manager. */
  onEvent?: (event: ClientEvent) => void;
  /** Partial dependency override; unspecified members fall back to the real library. */
  deps?: Partial<ConnectionDeps>;
}

export class ConnectionManager {
  private readonly privateDir: string;
  private readonly sessionPath: string;
  private readonly log: Logger;
  private readonly onEvent: (event: ClientEvent) => void;
  private readonly deps: ConnectionDeps;

  private client: Client | null = null;
  private state: ConnectionStatus = { status: 'idle' };
  private stopped = false;
  private running = false;

  private resolveReady!: () => void;
  private readyPromise: Promise<void>;

  constructor(opts: ConnectionManagerOpts) {
    this.privateDir = opts.privateDir;
    this.sessionPath = path.join(opts.privateDir, SESSION_FILE);
    this.log = opts.log ?? noopLogger;
    this.onEvent = opts.onEvent ?? (() => {});
    this.deps = { ...defaultDeps(), ...opts.deps };
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  // =========================================================================
  // Public surface
  // =========================================================================

  /** The live gmessages client, or null when not open. */
  get socket(): Client | null {
    return this.client;
  }

  /**
   * Why the connection is unusable, phrased for a tool result — or null when it
   * is fine (or merely still connecting). A dead session must say "re-pair"
   * rather than time out silently.
   */
  deadReason(): string | null {
    if (this.state.status !== 'dead') return null;
    return this.state.reason.kind === 'jar-dead'
      ? 'Google Messages session expired (cookies no longer authenticate). Re-pair in the admin panel.'
      : 'Google Messages connection failed terminally. Re-pair in the admin panel.';
  }

  /** Resolves on the first successful open. Handlers race this against a timeout. */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get status(): ConnectionStatus {
    return this.state;
  }

  isPaired(): boolean {
    return isPaired(this.privateDir);
  }

  isConnected(): boolean {
    return this.state.status === 'open';
  }

  /**
   * This account's own participant id — the paired device's source id, which is
   * what an echoed own-send carries as its participant. Empty when not paired.
   */
  ownParticipantId(): string {
    return this.client?.store.state.pairing?.device?.sourceId ?? '';
  }

  /**
   * Start the connect/reconnect loop. Returns immediately; the loop runs in the
   * background. A no-op if already running or if unpaired (nothing to connect
   * with until `pair()` writes a session).
   */
  start(): void {
    if (this.running) return;
    if (!this.isPaired()) {
      this.state = { status: 'unpaired' };
      this.log.info('gmessages: not paired; idle until pairing');
      return;
    }
    this.running = true;
    this.stopped = false;
    void this.run();
  }

  /** Stop the loop and tear down the current stream. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    this.state = { status: 'stopped' };
    if (client) {
      try {
        await client.stop();
      } catch (err) {
        this.log.warn({ err }, 'gmessages: error during stop');
      }
    }
  }

  /**
   * Pair from a signed-in account's cookies. `onVerification` is shown the code
   * and must resolve once the human has confirmed it on the handset — the finish
   * request follows that confirmation. On success the session is written and the
   * loop is (re)started. Returns the prompt for logging; the live display is via
   * the callback.
   */
  async pair(
    cookies: string,
    onVerification: (prompt: VerificationPrompt) => void | Promise<void>,
    onJarUpdate?: (jar: Readonly<Record<string, string>>) => void,
  ): Promise<VerificationPrompt> {
    const { blob, prompt } = await this.deps.pair({
      cookies,
      endpoints: this.deps.endpoints,
      apiKey: this.deps.apiKey,
      fetchImpl: this.deps.fetchImpl,
      onVerification,
      ...(onJarUpdate ? { onJarUpdate } : {}),
    });
    await this.deps.writeSession(this.sessionPath, blob);
    this.log.info('gmessages: paired; session written');
    this.start();
    return prompt;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.state = { status: 'connecting' };
        const store = await this.deps.loadStore(this.sessionPath);
        const client = await this.deps.connect({
          endpoints: this.deps.endpoints,
          apiKey: this.deps.apiKey,
          fetchImpl: this.deps.fetchImpl,
          ...(store.session !== undefined ? { session: store.session } : {}),
          onSessionUpdate: store.onSessionUpdate,
          onEvent: (event) => this.forward(event),
          onSessionError: (err) =>
            this.log.warn({ err }, 'gmessages: session persist failed (running on memory)'),
        });
        this.client = client;
        this.state = { status: 'open' };
        this.resolveReady();
        const openedAt = this.deps.now();
        // Logged because "is it actually connected?" is otherwise unanswerable after the fact: the
        // failure paths all speak up and success said nothing, so a healthy stream and a stalled one
        // looked identical in the log.
        this.log.info({ attempt }, 'gmessages: stream open');

        const reason = await client.finished();
        this.client = null;
        if (this.stopped || reason === null) break; // clean stop
        if (!isRetryable(reason)) {
          this.state = { status: 'dead', reason };
          this.log.error({ reason }, 'gmessages: connection dead — re-pair required');
          break;
        }
        // Only a connection that held long enough resets the backoff; a fast
        // flap keeps escalating.
        if (this.deps.now() - openedAt >= MIN_STABLE_MS) attempt = 0;
        this.log.warn({ reason }, 'gmessages: stream died, reconnecting');
      } catch (err) {
        this.client = null;
        // connect()/loadStore threw before the stream opened. If the session is
        // gone (unpaired), there is nothing to retry against.
        if (!this.isPaired()) {
          this.state = { status: 'unpaired' };
          break;
        }
        // A terminal credential failure throws here rather than arriving via
        // finished(), so it must be classified on this path too — otherwise a
        // stale session retries forever instead of asking for a re-pair.
        const fatal = fatalConnectReason(err);
        if (fatal) {
          this.state = { status: 'dead', reason: fatal };
          this.log.error({ err }, 'gmessages: connect failed terminally — re-pair required');
          break;
        }
        this.log.warn({ err }, 'gmessages: connect failed, retrying');
      }

      attempt++;
      this.state = { status: 'reconnecting', attempt };
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
      await this.deps.sleep(delay);
    }
    this.running = false;
  }

  private forward(event: ClientEvent): void {
    try {
      this.onEvent(event);
    } catch (err) {
      // A watch handler's failure must not kill the connection loop.
      this.log.warn({ err }, 'gmessages: onEvent handler threw');
    }
  }
}
