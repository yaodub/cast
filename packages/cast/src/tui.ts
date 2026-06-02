/**
 * Cast TUI — rich terminal UI with markdown rendering.
 * Connects to the running server via WebSocket. Message history is loaded
 * from the database on connect so the TUI shows system truth, not local state.
 *
 * Usage: pnpm tui <agent[/channel[/qualifier]]> [--as <key>]
 *
 * SIDE EFFECTS: Module-level TUI state (loader, waiting flag, editor submit lock)
 * is mutated by event handlers. This is inherent to imperative TUI rendering —
 * pi-tui components are stateful objects managed via direct mutation.
 */
import { Chalk } from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import type { EditorTheme, MarkdownTheme } from '@mariozechner/pi-tui';
import {
  Editor,
  Key,
  Loader,
  Markdown,
  ProcessTerminal,
  Spacer,
  TUI,
  Text,
  matchesKey,
} from '@mariozechner/pi-tui';

import type { HistoryEntry } from './cli/client.js';
import { createClient } from './cli/client.js';
import { parseCliArgs } from './cli/parse-args.js';
import { TYPING_TIMEOUT_MS } from './config.js';

const chalk = new Chalk({ level: 3 });

// --- Config ---

const { agent, channel, qualifier, handle, port } = parseCliArgs(process.argv.slice(2));
const sendOpts = channel || qualifier ? { channel, qualifier } : undefined;

// --- Themes ---

const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.blue(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.green(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode: (code, lang) => {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    return highlight(code, { language }).split('\n');
  },
};

const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: {
    selectedPrefix: (s) => chalk.blue(s),
    selectedText: (s) => chalk.bold(s),
    description: (s) => chalk.dim(s),
    scrollInfo: (s) => chalk.dim(s),
    noMatch: (s) => chalk.dim(s),
  },
};

// --- TUI Layout ---

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const headerLabel = channel
  ? `${chalk.bold(agent)}${chalk.dim('/')}${chalk.yellow(channel)}`
  : chalk.bold(agent);
const header = new Text(
  `${headerLabel} ${chalk.dim('connecting...')}`,
  1,
  0,
);
tui.addChild(header);
tui.addChild(new Spacer(1));

const editor = new Editor(tui, editorTheme);
tui.addChild(editor);
tui.setFocus(editor);

let loader: Loader | undefined;
let loaderTimeout: ReturnType<typeof setTimeout> | undefined;
let waiting = false;
let historyLoaded = false;

function setStatus(label: string): void {
  header.setText(`${headerLabel} ${label}`);
  tui.requestRender();
}

function appendMessage(component: Text | Markdown): void {
  const children = tui.children;
  children.splice(children.length - 1, 0, new Spacer(1), component);
  tui.requestRender();
}

function showLoader(): void {
  // Reset auto-clear timer on every typing heartbeat
  clearTimeout(loaderTimeout);
  loaderTimeout = setTimeout(hideLoader, TYPING_TIMEOUT_MS);

  if (loader) return;
  loader = new Loader(
    tui,
    (s) => chalk.cyan(s),
    (s) => chalk.dim(s),
    'Thinking...',
  );
  const children = tui.children;
  children.splice(children.length - 1, 0, loader);
  tui.requestRender();
}

function hideLoader(): void {
  clearTimeout(loaderTimeout);
  if (!loader) return;
  tui.removeChild(loader);
  loader = undefined;
  tui.requestRender();
}

// Track conversation boundaries across history + live messages.
// Only track non-null IDs — inbound packets have null session_hash by design.
let lastSeenConversationId: string | undefined;

function renderHistory(entries: HistoryEntry[]): void {
  for (const entry of entries) {
    // Separator when a new non-null session_hash appears that differs from the last one seen
    if (
      entry.session_hash
      && lastSeenConversationId !== undefined
      && entry.session_hash !== lastSeenConversationId
    ) {
      appendMessage(new Text(chalk.dim('new conversation'), 1, 0));
    }
    if (entry.session_hash) lastSeenConversationId = entry.session_hash;

    // Detect direction: agent: prefix = bot, else = user
    if (entry.from_addr.startsWith('agent:')) {
      appendMessage(new Markdown(entry.text, 1, 0, markdownTheme));
    } else {
      appendMessage(new Text(`${chalk.blue('>')} ${entry.text}`, 1, 0));
    }
  }
}

// --- Client ---

const client = createClient(agent, { handle, port });

editor.onSubmit = (value: string) => {
  const text = value.trim();
  if (!text || waiting) return;

  appendMessage(new Text(`${chalk.blue('>')} ${text}`, 1, 0));
  client.send(text, sendOpts);

  // Block further sends until response
  waiting = true;
  editor.disableSubmit = true;
};

// --- Keyboard ---

const DOUBLE_CTRL_C_MS = 2000;
let lastCtrlC = 0;

tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl('d'))) {
    client.close();
    tui.stop();
    process.exit(0);
  }

  if (matchesKey(data, Key.ctrl('c'))) {
    const now = Date.now();
    if (now - lastCtrlC < DOUBLE_CTRL_C_MS) {
      client.close();
      tui.stop();
      process.exit(0);
    }
    lastCtrlC = now;

    // First Ctrl+C: clear editor text
    editor.setText('');
    tui.requestRender();
    return { consume: true };
  }


  return undefined;
});

client.on('status', (status) => {
  if (status === 'connected') {
    setStatus(chalk.green('connected'));
    if (!historyLoaded) {
      client.requestHistory({ limit: 50, channel, qualifier });
    }
  } else if (status === 'disconnected') {
    setStatus(chalk.red('disconnected'));
  } else if (status === 'refused') {
    setStatus(chalk.red('refused — is server running?'));
  } else if (status === 'connecting') {
    setStatus(chalk.yellow('connecting...'));
  }
});

client.on('history', (entries) => {
  if (historyLoaded) return;
  historyLoaded = true;
  if (entries.length > 0) {
    renderHistory(entries.reverse());
  }
});

client.on('message', (text, sessionHash) => {
  hideLoader();

  // Detect conversation boundary from live messages
  if (
    sessionHash
    && lastSeenConversationId !== undefined
    && sessionHash !== lastSeenConversationId
  ) {
    appendMessage(new Text(chalk.dim(`── new conversation ──`), 1, 0));
  }
  if (sessionHash) lastSeenConversationId = sessionHash;

  appendMessage(new Markdown(text, 1, 0, markdownTheme));

  // Re-enable input
  waiting = false;
  editor.disableSubmit = false;
});

client.on('typing', () => showLoader());
client.on('typingStopped', () => hideLoader());

client.on('error', (text) => {
  hideLoader();
  appendMessage(new Text(chalk.red(`Error: ${text}`), 1, 0));

  // Re-enable input on error too
  waiting = false;
  editor.disableSubmit = false;
});

// --- Start ---

tui.start();
