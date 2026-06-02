/**
 * URL security validation — SSRF prevention.
 *
 * Validates URLs before fetching: blocks private IPs, reserved hostnames,
 * non-HTTP schemes, and embedded credentials.
 */

const BLOCKED_SCHEMES = new Set(['file:', 'data:', 'javascript:', 'ftp:', 'blob:']);

const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // 127.0.0.0/8
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // 169.254.0.0/16 (link-local, AWS metadata)
  /^0\.0\.0\.0$/, // unspecified
];

const PRIVATE_IPV6 = new Set(['::1', '[::1]']);
const IPV6_ULA_PREFIX = /^f[cd]/i; // fc00::/7

function isPrivateIp(hostname: string): boolean {
  // Strip brackets from IPv6
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

  if (PRIVATE_IPV6.has(hostname) || PRIVATE_IPV6.has(bare)) return true;
  if (IPV6_ULA_PREFIX.test(bare)) return true;

  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(bare)) return true;
  }

  return false;
}

function isReservedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.local');
}

/**
 * Validate a URL for safe fetching. Throws if the URL is blocked.
 *
 * Checks: scheme (http/https only), no embedded credentials,
 * no private/reserved IPs, no reserved hostnames.
 */
export function validateFetchUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (BLOCKED_SCHEMES.has(parsed.protocol) || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked scheme: ${parsed.protocol} — only http: and https: are allowed`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new Error(`Blocked private/reserved IP: ${parsed.hostname}`);
  }

  if (isReservedHostname(parsed.hostname)) {
    throw new Error(`Blocked reserved hostname: ${parsed.hostname}`);
  }
}
