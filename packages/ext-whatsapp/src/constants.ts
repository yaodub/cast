/**
 * Shared constants for the WhatsApp extension.
 */
import pino from 'pino';

/**
 * WhatsApp protocol version — servers reject builds older than a rolling
 * minimum with 405 at handshake, so a stale pin is a total outage. This
 * matches the default shipped in Baileys 7.0.0-rc14; the pin stays as the
 * hotfix lever for the next bump WhatsApp makes between Baileys releases.
 * Current accepted value: Baileys' src/Defaults/baileys-version.json.
 *
 * See: https://github.com/WhiskeySockets/Baileys/issues/2376
 */
export const WA_VERSION: [number, number, number] = [2, 3000, 1043857760];

/** Pino logger for Baileys internals — warn level to suppress verbose protocol chatter. */
export const baileysLogger = pino({ level: 'warn' });
