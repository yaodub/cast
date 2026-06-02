/**
 * Shared constants for the WhatsApp extension.
 */
import pino from 'pino';

/**
 * WhatsApp protocol version — Baileys 7.0.0-rc.9 ships an outdated default
 * (1027934701) that WhatsApp rejects with 405. Override with the current
 * stable WA Web version. Update this when upgrading Baileys or when
 * WhatsApp bumps the minimum version again.
 *
 * See: https://github.com/WhiskeySockets/Baileys/issues/2376
 */
export const WA_VERSION: [number, number, number] = [2, 3000, 1034074495];

/** Pino logger for Baileys internals — warn level to suppress verbose protocol chatter. */
export const baileysLogger = pino({ level: 'warn' });
