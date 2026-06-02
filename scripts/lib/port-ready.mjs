/**
 * Port-readiness probe — gates browser-open on the API + web UI being
 * actually bound, rather than a hardcoded delay. The inverse of port-busy
 * detection: try to connect, succeed iff something is listening.
 *
 * Used by start.mjs and dev.ts to replace the old `setTimeout(open, 6000)`
 * race that lost on cold starts, slow disks, and first-build runs.
 */
import { createConnection } from 'net';

/** Try a localhost TCP connect to `port`. Resolves true if anything is bound.
 *  Uses `host: 'localhost'` rather than a hardcoded IP so Node's
 *  `autoSelectFamily` (default in 20+) walks both ::1 and 127.0.0.1 — vite
 *  preview binds only the first DNS-resolved family of localhost, which on
 *  macOS is ::1, so a hardcoded 127.0.0.1 probe would miss it. */
export function portReady(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port: Number(port), host: 'localhost' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/** Poll `port` every 100ms until it accepts a connection, or `deadlineMs` elapses. */
export async function waitForReady(port, deadlineMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await portReady(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
