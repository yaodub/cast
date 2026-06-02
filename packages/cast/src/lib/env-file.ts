/**
 * Surgical .env file reader/writer for the **server-level** `.env` only.
 * Preserves comments, blank lines, and key ordering when writing.
 *
 * Used by `admin/routers/auth.ts` for AUTH_MODE / ANTHROPIC_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN — values that PM2 and dotenv consume at boot.
 *
 * Per-extension secrets live in `secrets.json` (see `lib/secrets-file.ts`);
 * do not reach for this module for extension or per-agent secrets.
 *
 * Reads bypass the watcher cache — the server's `.env` sits outside any
 * watched directory.
 */
import fs from 'fs';
import dotenv from 'dotenv';
import { writeAtomic } from './utils.js';

/** Parse a .env file into a key-value record. Returns empty record on any failure. */
export function readEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return dotenv.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write key-value pairs to a .env file, preserving comments, blank lines, and key ordering.
 *
 * Existing keys are updated in-place. New keys are appended at the end.
 * Keys not in `updates` are left untouched.
 */
export function writeEnvFile(filePath: string, updates: Record<string, string>): void {
  const pending = new Map(Object.entries(updates));
  const lines: string[] = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8').split('\n')
    : [];

  const output: string[] = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return line;
    const key = trimmed.slice(0, eqIndex).trim();
    if (pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  // Append any new keys not found in the original file
  for (const [key, value] of pending) {
    output.push(`${key}=${value}`);
  }

  writeAtomic(filePath, output.join('\n'));
}
