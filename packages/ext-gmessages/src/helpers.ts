/**
 * Small pure helpers shared across the extension.
 */

/** Reject with `message` if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Filename extension → MIME, restricted to types the relay's own format table
 * knows (`MEDIA_FORMATS` in the library).
 *
 * An unknown MIME is not fatal on the wire — the format field just goes out as
 * UNSPECIFIED, which is what Google's own client does — but sending a type the
 * table has never carried is a guess, so the send tool refuses rather than
 * discovering the outcome on someone else's phone.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  aac: 'audio/aac',
  amr: 'audio/amr',
  mp3: 'audio/mp3',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  vcf: 'text/vcard',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
  ics: 'text/calendar',
};

/** MIME for a filename, or null when the extension is unknown/absent. */
export function mimeFromFilename(name: string): string | null {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? null;
}

/** A filesystem-safe basename, so a tool argument cannot escape the staging dir. */
export function safeBasename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? '';
}

/**
 * Format a microsecond wire timestamp as `YYYY-MM-DD HH:MM` (UTC).
 *
 * `InboundMessage.timestampMicros` is microseconds; JS dates are milliseconds. A zero/absent stamp renders
 * empty rather than 1970.
 */
export function formatMicros(micros: bigint): string {
  if (micros <= 0n) return '';
  const ms = Number(micros / 1000n);
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
