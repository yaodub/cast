export interface SystemCommandContext {
  /** Resolved identity ID (e.g. "u:a7f3k@srv" or "local"), or null if unresolved. */
  identity: string | null;
  /** Transport handle (e.g. "tg:12345"). */
  handle: string;
}

export interface SystemCommandResult {
  text: string;
}

export interface SystemCommandDef {
  /** Command name including the leading slash (e.g. "/name"). */
  command: string;
  /** Short description shown in /help output. */
  description: string;
  handler: (ctx: SystemCommandContext, args: string) => SystemCommandResult | null;
}
