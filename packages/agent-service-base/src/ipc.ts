/**
 * IPC message schemas and helpers for agent services.
 *
 * Services communicate with the cast server via Node.js IPC (process.send/on('message')).
 * This module defines the message schemas and provides typed send/receive helpers.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inbound messages (server → service)
// ---------------------------------------------------------------------------

export const IpcInMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown') }),
  z.object({
    type: z.literal('route-result'),
    id: z.string(),
    result: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal('execute-approved-tool'),
    id: z.string(),
    tool: z.string(),
    args: z.string(),
  }),
]);

export type IpcInMessage = z.infer<typeof IpcInMessageSchema>;

// ---------------------------------------------------------------------------
// Outbound messages (service → server)
// ---------------------------------------------------------------------------

export type IpcOutMessage =
  | { type: 'ready' }
  | { type: 'route-message'; id: string; channel: string; text: string; target?: string }
  | { type: 'request-approval'; id: string; tool: string; args: string; summary: string; details?: string; participant: string; channel?: string; conversationKey?: string; expiresIn?: number }
  | { type: 'approval-tool-result'; id: string; result: string; isError?: boolean };

// ---------------------------------------------------------------------------
// Send helper
// ---------------------------------------------------------------------------

export function sendIpc(msg: IpcOutMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Route-message RPC (send message to agent, wait for result)
// ---------------------------------------------------------------------------

type RouteCallback = (result: string | null, error: string | null) => void;
const pendingRoutes = new Map<string, RouteCallback>();

export function routeMessage(
  channel: string,
  text: string,
  target?: string,
): Promise<{ result: string | null; error: string | null }> {
  const id = `rm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    pendingRoutes.set(id, (result, error) => resolve({ result, error }));
    sendIpc({ type: 'route-message', id, channel, text, ...(target ? { target } : {}) });
  });
}

/** Resolve a pending route-message callback. Called by the IPC listener. */
export function resolveRoute(id: string, result: string | null, error: string | null): boolean {
  const cb = pendingRoutes.get(id);
  if (cb) {
    pendingRoutes.delete(id);
    cb(result, error);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function log(agentFolder: string, message: string): void {
  console.error(`[service:${agentFolder}] ${message}`);
}
