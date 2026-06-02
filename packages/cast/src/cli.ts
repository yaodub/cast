/**
 * Cast CLI — simple readline client for debugging.
 * Connects to the running server via WebSocket.
 *
 * Usage: pnpm cli <agent[/channel[/qualifier]]> [--as <key>]
 *
 * SIDE EFFECTS: Module-level CLI state (`rl` readline interface, `typingTimeout`
 *   for the in-place typing indicator). Required because the WebSocket client
 *   delivers events via callbacks that need to mutate the shared prompt/indicator
 *   state — passing the state through every callback would make the file unreadable
 *   for the small set of locals involved.
 */
import readline from 'readline';

import { createClient } from './cli/client.js';
import { parseCliArgs } from './cli/parse-args.js';
import { TYPING_TIMEOUT_MS } from './config.js';

const { agent, channel, qualifier, handle, port } = parseCliArgs(process.argv.slice(2));
const sendOpts = channel || qualifier ? { channel, qualifier } : undefined;
const client = createClient(agent, { reconnect: false, handle, port });

let rl: readline.Interface | undefined;

function startPrompt(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    const text = line.trim();
    if (text) client.send(text, sendOpts);
    rl!.prompt();
  });

  rl.on('close', () => {
    client.close();
    process.exit(0);
  });
}

client.on('status', (status) => {
  if (status === 'connected') {
    console.log(`Connected to Cast (agent: ${agent})`);
    console.log('Type a message and press Enter. Ctrl-C to quit.\n');
    if (!rl) startPrompt();
  } else if (status === 'refused') {
    const castPort = port || process.env.CAST_PORT || '5050';
    console.error(`Cannot connect to Cast at ws://${process.env.WS_HOST || 'localhost'}:${castPort}`);
    console.error('Is the server running? Start it with: pnpm dev');
    process.exit(1);
  } else if (status === 'disconnected') {
    console.log('\nDisconnected from Cast.');
    process.exit(0);
  }
});

client.on('message', (text) => {
  process.stdout.write('\r\x1b[K');
  console.log(`\x1b[36m${text}\x1b[0m\n`);
  rl?.prompt();
});

let typingTimeout: ReturnType<typeof setTimeout> | undefined;
const clearTyping = () => {
  clearTimeout(typingTimeout);
  process.stdout.write('\r\x1b[K');
};

client.on('typing', () => {
  clearTimeout(typingTimeout);
  process.stdout.write('\r\x1b[K\x1b[2m...\x1b[0m');
  typingTimeout = setTimeout(clearTyping, TYPING_TIMEOUT_MS);
});

client.on('typingStopped', clearTyping);

client.on('error', (text) => {
  process.stdout.write('\r\x1b[K');
  console.error(`\x1b[31mError: ${text}\x1b[0m`);
  rl?.prompt();
});
