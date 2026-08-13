/**
 * Standalone read-only live check for ext-gmessages — no Cast agent, no server.
 *
 * Instantiates the extension directly (the documented service-side path) against
 * a real paired session and exercises the read tools. This is the Phase-1 live
 * checkpoint: it validates connection.ts + the read tools together, end to end,
 * without any Cast integration.
 *
 * SAFETY — read-only by construction:
 *   - Calls only gmessages__chats / gmessages__messages (listConversations,
 *     listMessages). Sends nothing; no react/mark-read/typing.
 *   - Connecting subscribes to the update stream — observe-only, exactly what
 *     opening messages.google.com does, and explicitly NOT gated (gm-oracle
 *     CLAUDE.md rule 5). send_mode is forced 'disabled' regardless.
 *
 * OPERATIONAL — one active rotator per account:
 *   The session used here becomes the live one and rotates the account cookies.
 *   PAUSE any harness/sustainer first, or two rotators clobber each other's
 *   cookies (same "one writer per session" rule the pairing flow enforces).
 *
 * Usage — reuse an existing paired session (fast path):
 *   cp /path/to/session.json "$GM_PRIVATE_DIR/session.json"
 *   GM_PRIVATE_DIR=/tmp/gm-live pnpm --dir packages/ext-gmessages exec \
 *     tsx scripts/live-check.ts "Alice"
 *
 * Usage — pair fresh via the extension (needs the phone):
 *   GM_PRIVATE_DIR=/tmp/gm-live GM_COOKIES=/path/to/cookies.txt \
 *     pnpm --dir packages/ext-gmessages exec tsx scripts/live-check.ts "Alice"
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { GmessagesExtension } from '../src/extension.js';
import { GmessagesConfigSchema } from '../src/schemas.js';
import type { ExtensionContext, Logger, ToolCallContext } from '@getcast/extension-schema';
import type { GmessagesConfig, GmessagesSecrets } from '../src/schemas.js';

const privateDir = process.env.GM_PRIVATE_DIR;
if (!privateDir) {
  console.error('Set GM_PRIVATE_DIR to a directory that holds (or will hold) session.json.');
  process.exit(1);
}
fs.mkdirSync(privateDir, { recursive: true });

const log: Logger = {
  info: (...a: unknown[]) => console.error('[info]', ...a),
  warn: (...a: unknown[]) => console.error('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
  debug: () => {},
};

const ctx: ExtensionContext<GmessagesConfig, GmessagesSecrets> = {
  agentFolder: 'live-check',
  config: GmessagesConfigSchema.parse({ read_mode: 'open', send_mode: 'disabled' }),
  secrets: {},
  privateDir,
  sharedDir: path.join(privateDir, 'shared'),
  deliver: async () => ({ ok: true, result: null }),
  log,
};

const ext = new GmessagesExtension(ctx);
const call = { stagingDir: path.join(privateDir, 'in'), stagingOutDir: path.join(privateDir, 'out') } as ToolCallContext;

async function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await rl.question(message);
  rl.close();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Rewrite a Netscape cookies.txt in place with an advanced jar.
 *
 * Keeps the DOMAIN column from the existing file (it is correct and the jar does
 * not carry it) and substitutes fresh values — the same shuffle
 * gm-oracle/harness/reseed-cookies.mjs performs. Written 0600; cookie NAMES are
 * logged, values never.
 */
function persistJar(cookiesPath: string, jar: Readonly<Record<string, string>>): void {
  const domains: Record<string, string> = {};
  for (const line of fs.readFileSync(cookiesPath, 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const p = line.split('\t');
    if (p.length >= 7) domains[p[5]!.trim()] = p[0]!.trim();
  }
  const names = Object.keys(jar);
  const out = ['# Netscape HTTP Cookie File'];
  for (const name of names) {
    out.push(`${domains[name] ?? '.google.com'}\tTRUE\t/\tTRUE\t2000000000\t${name}\t${jar[name]}`);
  }
  fs.writeFileSync(cookiesPath, `${out.join('\n')}\n`, { mode: 0o600 });
  console.error(`[jar] persisted ${names.length} rotated cookies (${names.join(', ')})`);
}

/**
 * Non-interactive confirmation window, for driving this without a TTY.
 *
 * The finish request must FOLLOW the human's confirmation on the handset (the
 * library awaits `onVerification` precisely so it cannot race it), and the relay
 * holds the attempt ~5 minutes. So: print the code, then wait for a sentinel
 * file to appear (immediate proceed) or for the window to elapse (proceed
 * anyway, on the assumption the tap happened).
 */
async function waitForSentinel(sentinel: string, maxSeconds: number): Promise<void> {
  for (let i = 0; i < maxSeconds; i++) {
    if (fs.existsSync(sentinel)) {
      console.error(`[verify] sentinel seen after ${i}s — sending finish now`);
      return;
    }
    await sleep(1000);
  }
  console.error(`[verify] window elapsed (${maxSeconds}s) — sending finish`);
}

async function main(): Promise<void> {
  // Pair only if there is no session and cookies were provided.
  if (!fs.existsSync(path.join(privateDir!, 'session.json'))) {
    const cookiesPath = process.env.GM_COOKIES;
    if (!cookiesPath) {
      console.error(
        'No session.json in GM_PRIVATE_DIR. Either copy one in, or set GM_COOKIES to pair fresh.',
      );
      process.exit(1);
    }
    const cookies = fs.readFileSync(cookiesPath, 'utf8');
    const sentinel = process.env.GM_VERIFY_SENTINEL;
    const windowSeconds = Number(process.env.GM_VERIFY_WAIT ?? '240');

    // ORDER MATTERS (docs/QUICKSTART.md §2): the handset can only display the
    // pairing request AFTER the finish request goes out, and finish follows this
    // callback resolving. So show the code and RETURN — do not wait for the tap
    // here, or the phone has nothing to show and the attempt expires unseen.
    console.error('Pairing — noting the code, then the phone will show a matching request.');
    await ext.pair(
      cookies,
      (prompt) => {
        const banner =
          `\n=== PAIRING CODE ===\n` +
          `  code:    ${prompt.emoji}\n` +
          `  numeric: ${prompt.numeric}\n` +
          `  (code version ${prompt.codeVersion})\n` +
          `  Your phone will now show a request with THIS code — approve it there.\n` +
          `====================\n`;
        console.log(banner);
        console.error(banner);
      },
      // Rotations absorbed during the flow, written back so an abandoned attempt
      // cannot strand cookies.txt behind the account's real jar.
      (jar) => persistJar(cookiesPath, jar),
    );
    console.error('Finish sent; session written. Approve the request on the handset now.');

    // The session is only usable once the handset approves, so wait here.
    if (sentinel) {
      console.error(`[approve] waiting up to ${windowSeconds}s for ${sentinel} (or the window to elapse)`);
      await waitForSentinel(sentinel, windowSeconds);
    } else {
      await waitForEnter('  Press Enter AFTER approving on the handset… ');
    }
  } else {
    await ext.onAgentStart();
  }

  console.log('=== gmessages__chats ===');
  const chats = await ext.handle('gmessages__chats', { limit: 20 }, call);
  console.log(chats.content[0]?.text ?? '(no output)');

  const query = process.argv[2];
  if (query) {
    console.log(`\n=== gmessages__messages "${query}" ===`);
    const msgs = await ext.handle('gmessages__messages', { chat: query, count: 15 }, call);
    console.log(msgs.content[0]?.text ?? '(no output)');
  }

  await ext.onAgentStop();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('live-check failed:', err);
    process.exit(1);
  },
);
