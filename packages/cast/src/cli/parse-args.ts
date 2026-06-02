/**
 * Parse CLI/TUI arguments: <agent[/channel[/qualifier]]> [--handle <key>]
 *
 * Examples:
 *   main                → agent=main
 *   main/scratch        → agent=main, channel=scratch
 *   main/scratch/daily  → agent=main, channel=scratch, qualifier=daily
 *   main --handle bob   → agent=main, handle=bob
 */
export function parseCliArgs(args: string[]): {
  agent: string;
  channel: string | undefined;
  qualifier: string | undefined;
  handle: string | undefined;
  port: string | undefined;
} {
  let target: string | undefined;
  let handle: string | undefined;
  let port: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--handle' && i + 1 < args.length) {
      handle = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      port = args[++i];
    } else if (!arg.startsWith('--')) {
      target = arg;
    }
    i++;
  }

  if (!target) {
    console.error('Usage: pnpm cli|tui <agent[/channel[/qualifier]]> [--handle <key>] [--port <port>]');
    process.exit(1);
  }

  const parts = target.split('/');
  const agent = parts[0]!;
  const channel = parts[1] || undefined;
  const qualifier = parts[2] || undefined;

  return { agent, channel, qualifier, handle, port };
}
