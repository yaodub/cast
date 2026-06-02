/**
 * Dev entrypoint — idempotent pre-flight, then run the watch server.
 *
 * Replaces a direct `tsx watch` invocation so a fresh clone can run with one
 * command: dependencies install on first run, the agent container image is
 * built if missing, and the browser opens once the server has had time to
 * start. Subsequent runs skip pre-flight and start instantly.
 */
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

import { ensureChromium } from './lib/ensure-chromium.mjs';
import { waitForReady } from './lib/port-ready.mjs';
import { resolveAgentsDir, resolveConfigDir } from './lib/resolve-paths.mjs';

const log = (msg: string) => console.log(`\x1b[36m[cast]\x1b[0m ${msg}`);

// 1. Dependencies
if (!existsSync('node_modules')) {
  log('Installing dependencies (first run only)...');
  execSync('pnpm install', { stdio: 'inherit' });
}

// 1b. Browser binary for web-fetch — Playwright's chromium, host-side. Not
// fetched by `pnpm install`; download it once when missing so the web-fetch
// subprocess clears its startup preflight.
ensureChromium(log);

// 2. Agent container image — build if neither container runtime has it
function imageExists(runtime: string): boolean {
  try {
    execSync(`${runtime} image inspect cast-agent:latest`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (!imageExists('container') && !imageExists('docker')) {
  log('Building agent container image (~2 min on first run)...');
  execSync('node packages/agent-runner/build.mjs', { stdio: 'inherit' });
}

// 3. Ports. API server on CAST_PORT (5050); web UI on PORT (5051), proxying
// to the API. The user only ever opens 5051.
const apiPort = process.env.CAST_PORT || '5050';
const webPort = process.env.PORT || '5051';
const url = `http://localhost:${webPort}`;
log(`Starting Cast; web UI will open at ${url}`);

// 4. Resolve and ensure data dirs exist. ~/.cast/{agents,config} by
// default; override with CAST_AGENTS_DIR / CAST_CONFIG_DIR.
const agentsDir = resolveAgentsDir();
const configDir = resolveConfigDir();
mkdirSync(agentsDir, { recursive: true });
mkdirSync(configDir, { recursive: true });

// 5. Run the watch server + the web UI (vite dev, HMR) in foreground.
const server = spawn(
  'tsx',
  ['watch', '--exclude', 'mnt/**', 'packages/cast/src/index.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CAST_AGENTS_DIR: agentsDir,
      CAST_CONFIG_DIR: configDir,
      CAST_PORT: apiPort,
      // So the server's startup banner advertises the web UI port (the only one
      // the user opens) rather than its own API port.
      CAST_WEB_PORT: webPort,
    },
  },
);

const webUi = spawn('pnpm', ['--filter', '@getcast/web-ui', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: webPort, CAST_PORT: apiPort },
});

// Open the browser once both ports accept connections. Replaces a fixed
// `setTimeout(open, 6000)` that raced cold-start init on slow disks.
if (process.env.CAST_NO_OPEN !== '1') {
  (async () => {
    const apiOk = await waitForReady(apiPort);
    const webOk = apiOk && (await waitForReady(webPort));
    // If the probe times out we still open — a probe bug on some platform
    // shouldn't strand the user with no browser. Worst case is the page loads
    // before the server is ready and they refresh once.
    if (!apiOk || !webOk) {
      log(`Cast didn't confirm ready in 30s — opening anyway; refresh if it's blank.`);
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // best-effort; user can navigate manually
    }
  })();
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill(signal);
  webUi.kill(signal);
};
server.on('exit', (code) => { shutdown('SIGTERM'); process.exit(code ?? 0); });
webUi.on('exit', (code) => { shutdown('SIGTERM'); process.exit(code ?? 0); });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
