import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

const CredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
  }),
});

function readCredentialsFile(): z.infer<typeof CredentialsSchema> | null {
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    return CredentialsSchema.parse(raw);
  } catch {
    return null;
  }
}

/** Atomic read of both meta and token from a single file parse.
 *  Used by `setup-token` mode as a fallback when `CLAUDE_CODE_OAUTH_TOKEN`
 *  is not present in `.env`. */
export function readCredentials(): { token: string; expiresAt: number; hasRefreshToken: boolean } | null {
  const creds = readCredentialsFile();
  if (!creds) return null;
  return {
    token: creds.claudeAiOauth.accessToken,
    expiresAt: creds.claudeAiOauth.expiresAt,
    hasRefreshToken: !!creds.claudeAiOauth.refreshToken,
  };
}
