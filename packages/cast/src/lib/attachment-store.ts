/**
 * Content-addressed attachment store.
 *
 * Blobs live at state/attachments/{hash[0:2]}/{hash}.{ext} per agent.
 * Dedup is automatic — identical content produces the same hash and skips the write.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { agentPath } from '../config.js';

function extFromMime(mimeType: string): string {
  // Inline the common cases; fall back to subtype.
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  };
  return map[mimeType] || mimeType.split('/')[1] || 'bin';
}

function storeDir(agentFolder: string): string {
  return agentPath(agentFolder, 'state', 'attachments');
}

function blobPath(base: string, hash: string, ext: string): string {
  return path.join(base, hash.slice(0, 2), `${hash}.${ext}`);
}

/** Container-side path for an attachment blob. */
export function attachmentContainerPath(hash: string, ext: string): string {
  return `/attachments/${hash.slice(0, 2)}/${hash}.${ext}`;
}

/** Host-side path for an attachment blob. */
export function attachmentHostPath(agentFolder: string, hash: string, ext: string): string {
  return blobPath(storeDir(agentFolder), hash, ext);
}

export interface PersistedAttachment {
  hash: string;
  ext: string;
  hostPath: string;
  containerPath: string;
  deduplicated: boolean;
}

/** Persist a buffer to the content-addressed store. Skips write if blob exists (dedup). */
export function persistAttachment(agentFolder: string, data: Buffer, mimeType: string): PersistedAttachment {
  const hash = createHash('sha256').update(data).digest('hex');
  const ext = extFromMime(mimeType);
  const dest = blobPath(storeDir(agentFolder), hash, ext);

  let deduplicated = false;
  if (fs.existsSync(dest)) {
    deduplicated = true;
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  return { hash, ext, hostPath: dest, containerPath: attachmentContainerPath(hash, ext), deduplicated };
}

/** Persist a file from disk to the content-addressed store. Moves the file (no copy) unless deduped. */
export function persistAttachmentFromFile(agentFolder: string, filePath: string, mimeType: string): PersistedAttachment {
  const data = fs.readFileSync(filePath);
  const hash = createHash('sha256').update(data).digest('hex');
  const ext = extFromMime(mimeType);
  const dest = blobPath(storeDir(agentFolder), hash, ext);

  let deduplicated = false;
  if (fs.existsSync(dest)) {
    deduplicated = true;
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(filePath, dest);
  }

  return { hash, ext, hostPath: dest, containerPath: attachmentContainerPath(hash, ext), deduplicated };
}
