/**
 * Content-type classification — determines how to process a response.
 */

export type ContentCategory = 'html' | 'json' | 'text' | 'xml' | 'pdf' | 'image' | 'binary';

/** Classify a Content-Type header value into a processing category. */
export function classifyContentType(contentType: string): ContentCategory {
  // Strip charset/boundary parameters: "text/html; charset=utf-8" → "text/html"
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml';
  if (mime === 'text/plain') return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';

  // Text-based types go through HTML pipeline
  if (mime.startsWith('text/')) return 'html';

  // Non-text MIME types we don't recognize → binary
  if (mime && !mime.startsWith('text/')) return 'binary';

  // Unrecognized / empty → html (pipeline will handle it)
  return 'html';
}

/** File extension for a content category. */
export function extForCategory(category: ContentCategory): string {
  switch (category) {
    case 'json': return 'json';
    case 'xml': return 'xml';
    case 'text': return 'txt';
    case 'html': return 'md';
    case 'pdf': return 'pdf';
    case 'image': return 'png';
    case 'binary': return 'bin';
  }
}

/** Whether a content category represents binary (non-text) data. */
export function isBinaryCategory(category: ContentCategory): boolean {
  return category === 'pdf' || category === 'image' || category === 'binary';
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/zip': 'zip',
  'application/gzip': 'gz',
};

/** Precise file extension from MIME type, falls back to category-based default. */
export function extForMime(contentType: string): string {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXT[mime] ?? extForCategory(classifyContentType(contentType));
}
