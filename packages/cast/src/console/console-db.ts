/**
 * ConsoleDb — SQLite store for console-scope conversation history.
 *
 * One class, two instantiation sites:
 *   - Per-agent: `mnt/agents/<agent>/state/console.db` — Design and Configure
 *     sessions on that agent both write here (discriminated by `channel` on
 *     the row). Lifecycle: opened/closed by the per-agent `ConsoleManager`.
 *   - Server-scope: `<CONFIG_DIR>/server-console.db` — DM, CM, SM all share
 *     this file (discriminated by `channel`). Lifecycle: opened once at
 *     server startup, closed at shutdown.
 *
 * Isolation rationale (Task: extract-message-log + console-history): console
 * planning content must NOT co-mingle with user-channel agent reasoning. A
 * shared `agent.db` table with filter-gated reads is too weak; physical
 * separation by file is the load-bearing guarantee. ConsoleDb is the wrapper
 * for that separate file. Today it installs only the message log bundle —
 * a wrapper class (rather than just a `MessageLogStore` factory) gives us a
 * stable extension point for future console-scope schemas (audit, decisions)
 * without restructuring call sites.
 *
 * Bundle composition: ConsoleDb owns the SQLite handle; bundle modules
 * (`installMessageLogSchema` + `MessageLogStore`) install their schema and
 * provide their operations against that handle. See `lib/message-log-store.ts`
 * for the bundle naming convention.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { installMessageLogSchema, MessageLogStore } from '../lib/message-log-store.js';

export class ConsoleDb {
  private db: Database.Database;
  readonly messages: MessageLogStore;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    installMessageLogSchema(this.db);
    this.messages = new MessageLogStore(this.db);
  }

  close(): void {
    this.db.close();
  }
}
