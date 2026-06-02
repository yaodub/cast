/**
 * Ensure Playwright's chromium browser binary is installed on the host.
 *
 * web-fetch runs host-side as a server-scoped subprocess that drives a headless
 * chromium via Playwright. Installing the npm `playwright` package does NOT
 * download the browser binary — Playwright 1.x ships no postinstall, and pnpm
 * would only run one for an allow-listed dependency anyway. So `pnpm install`
 * leaves chromium absent, the subprocess exits at its preflight, and web__fetch
 * disappears fleet-wide. This bridges the gap: a boot-time check that downloads
 * chromium once when it's missing.
 *
 * Detection mirrors the server's own checkChromium() — ask Playwright for the
 * executable path it will look for, then test existence — rather than guessing
 * a cache dir, which is platform-specific (macOS ~/Library/Caches, Linux
 * ~/.cache) and overridable via PLAYWRIGHT_BROWSERS_PATH. Both the check and the
 * install run via `pnpm --filter @getcast/web-fetch exec`, so they use the exact
 * Playwright version the web-fetch subprocess resolves at runtime.
 */
import { execSync } from 'child_process';

function chromiumInstalled() {
  try {
    execSync(
      `pnpm --filter @getcast/web-fetch exec node -e "process.exit(require('fs').existsSync(require('playwright').chromium.executablePath())?0:1)"`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Install chromium when missing. Logs via the caller's logger. Non-fatal: a
 * failed download (offline, sandboxed CI) must not block the rest of Cast from
 * booting — web-fetch just stays unavailable until chromium is installed.
 */
export function ensureChromium(log) {
  if (chromiumInstalled()) return;
  log('Installing chromium for web-fetch (~150MB, one-time)...');
  try {
    execSync('pnpm --filter @getcast/web-fetch exec playwright install chromium', {
      stdio: 'inherit',
    });
  } catch {
    log(
      'Could not install chromium — web-fetch will be unavailable. Install it later with:\n' +
      '      pnpm --filter @getcast/web-fetch exec playwright install chromium',
    );
  }
}
