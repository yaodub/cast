/**
 * TabChannel implementation backed by a `MessagePort` (the channel a
 * SharedWorker hands out to each connecting tab). Thin wrapper — the
 * worker's subscription / dispatch code consumes the abstract `TabChannel`
 * interface so the same logic survives a future migration to a networked
 * persistence service.
 */

import type { TabChannel } from './interfaces';

export class PortTabChannel implements TabChannel {
  private readonly port: MessagePort;
  private readonly messageHandlers = new Set<(envelope: unknown) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(port: MessagePort) {
    this.port = port;
    port.onmessage = (e: MessageEvent) => {
      for (const h of this.messageHandlers) h(e.data);
    };
    port.onmessageerror = () => {
      this.fireClose();
    };
    // SharedWorker MessagePort doesn't fire close events on tab unload;
    // the only signal is messageerror or a missing pong. Tabs send an
    // explicit `unsubscribe`/`disconnect-identity` on unmount when they
    // can. The refcount grace period in ConnectionState absorbs the
    // unclean-close case.
    port.start();
  }

  postMessage(envelope: unknown, transfer?: Transferable[]): void {
    if (this.closed) return;
    if (transfer && transfer.length > 0) {
      this.port.postMessage(envelope, transfer);
    } else {
      this.port.postMessage(envelope);
    }
  }

  onMessage(handler: (envelope: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => { this.messageHandlers.delete(handler); };
  }

  onClose(handler: () => void): () => void {
    if (this.closed) {
      // Late registration after close — fire immediately.
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.close();
    } catch {
      // Already closed.
    }
    this.fireClose();
  }

  private fireClose(): void {
    for (const h of this.closeHandlers) h();
    this.closeHandlers.clear();
    this.messageHandlers.clear();
  }
}
