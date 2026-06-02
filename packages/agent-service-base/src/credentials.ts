/**
 * Credentials persistence — read/write ext/service/credentials.json keyed by provider.
 *
 * The file stores a flat object of provider → credential data. Zod validates
 * on read; corrupt files return null rather than crashing the service.
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CredentialEntrySchema = z.object({
  refreshToken: z.string(),
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
});

const CredentialsFileSchema = z.record(z.string(), CredentialEntrySchema);

export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function credentialsPath(serviceDir: string): string {
  return path.join(serviceDir, 'credentials.json');
}

function readFile(serviceDir: string): Record<string, CredentialEntry> {
  const filePath = credentialsPath(serviceDir);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const parsed = CredentialsFileSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[credentials] Invalid credentials.json: ${parsed.error.message}`);
      return {};
    }
    return parsed.data;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load credentials for a specific provider. Returns null if not found or invalid. */
export function loadCredentials(serviceDir: string, provider: string): CredentialEntry | null {
  const all = readFile(serviceDir);
  return all[provider] ?? null;
}

/** Save credentials for a specific provider. Merges into existing file. */
export function saveCredentials(serviceDir: string, provider: string, entry: CredentialEntry): void {
  const all = readFile(serviceDir);
  all[provider] = entry;
  const filePath = credentialsPath(serviceDir);
  fs.writeFileSync(filePath, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}
