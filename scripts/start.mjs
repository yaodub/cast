/**
 * Cast start script — smart wrapper around `node dist/index.js`.
 *
 * Quickstart entrypoint. On a clean clone, runs `pnpm install`, builds the
 * web-ui and server bundle, builds the agent container image, then starts
 * the bundled server. On re-run after `git pull`, detects what's stale —
 * mtime checks for the server bundle, a content-hash receipt tag for the
 * agent image (see packages/agent-runner/image-hash.mjs) — and rebuilds
 * only what's needed.
 *
 * Plain .mjs (not .ts) so it runs on a clean clone with just Node — no tsx
 * dep needed. The trade is: no type checking, and shared helpers must stay
 * plain .mjs (scripts/lib/). Acceptable for ~150 lines of glue.
 *
 * Counterpart: `scripts/dev.ts` is the contributor path (tsx watch, hot
 * reload on Cast source). This is the user path (stable bundled runtime).
 */
import { execSync, spawn } from 'child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { createServer } from 'net';
import { release } from 'os';
import { delimiter, join } from 'path';
import { ensureChromium } from './lib/ensure-chromium.mjs';
import { waitForReady } from './lib/port-ready.mjs';
import { resolveAgentsDir, resolveConfigDir } from './lib/resolve-paths.mjs';
import { run } from './lib/run.mjs';
import { computeImageHash, sentinelTag } from '../packages/agent-runner/image-hash.mjs';

const log = (msg) => console.log(`\x1b[36m[cast]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[cast]\x1b[0m ${msg}`);
  process.exit(1);
};

// --- Helpers ----------------------------------------------------------------

// Cross-platform PATH lookup — replaces shelling out to `which` (absent on
// Windows). Duplicated from config.ts's findBinary by design: this script runs
// on a clean clone with plain Node, before the package is built.
function binaryExists(name) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try { accessSync(join(dir, name + ext), constants.X_OK); return true; }
      catch { /* not here — try next */ }
    }
  }
  return false;
}

function imageExists(runtime, ref) {
  try { execSync(`${runtime} image inspect ${ref}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function daemonRunning(runtime) {
  try {
    const cmd = runtime === 'container' ? 'container system status' : 'docker info';
    execSync(cmd, { stdio: 'pipe' });
    return { ok: true, stderr: '' };
  } catch (err) {
    // execSync attaches captured streams to the error when stdio is 'pipe'.
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    return { ok: false, stderr: stderr + stdout };
  }
}

// True when running inside WSL2 (Linux kernel exposed by Windows). The kernel
// release string contains "microsoft" on both WSL1 and WSL2, and WSL_DISTRO_NAME
// is set by the WSL init for any distro shell.
function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); }
  catch { return false; }
}

// Probe whether a localhost TCP port is already bound. Plain-Node net probe (no
// deps) — mirrors lib/port.ts's findAvailablePort, duplicated here because this
// script runs on a clean clone before the bundle is built.
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.listen(Number(port), '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

// Welcome banner. Skipped when stdout is piped/redirected (CI, log capture) so
// log files stay clean. Printed before any environment check so even users
// who fail at "no Docker" see what they were booting.
function printBanner() {
  if (!process.stdout.isTTY) return;
  const gold = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const logo = [
    '                _   ',
    '   ___ __ _ ___| |_ ',
    '  / __/ _` / __| __|',
    ' | (_| (_| \\__ \\ |_ ',
    '  \\___\\__,_|___/\\__|',
  ];
  console.log();
  for (const line of logo) console.log(`${gold}${line}${reset}`);
  console.log(`${dim}   your agent team, on your machine · MIT${reset}`);
  console.log();
}

/** Max mtime across files under the given paths (files or dirs, walked recursively). */
function maxMtime(roots) {
  let max = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const st = statSync(root);
    if (st.isFile()) { if (st.mtimeMs > max) max = st.mtimeMs; continue; }
    const entries = readdirSync(root, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = join(e.parentPath ?? root, e.name);
      const s = statSync(p);
      if (s.mtimeMs > max) max = s.mtimeMs;
    }
  }
  return max;
}

printBanner();

// --- 1. Node version --------------------------------------------------------

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) fail(`Node 20+ required (have ${process.versions.node})`);

// Windows is supported only via WSL2. Native Windows (cmd.exe, PowerShell,
// Git Bash, MSYS2, Cygwin) all report `win32`; WSL1/WSL2 report `linux`.
// Catch native-Windows here so the failure points at WSL2 rather than at a
// later container-runtime or path-mount error.
if (process.platform === 'win32') {
  fail('Cast on Windows requires WSL2.\n  Install WSL2: https://learn.microsoft.com/windows/wsl/install\n  Then run `pnpm start` from inside your WSL2 shell.');
}

// --- 2. Container runtime + daemon -----------------------------------------

// Mirror env.ts's resolveRuntime() preference order: Apple Container on
// macOS if present, else Docker. Detect installed AND daemon-running
// separately so the error message tells the user which to fix.
const hasContainer = process.platform === 'darwin' && binaryExists('container');
const hasDocker = binaryExists('docker');
const runtime = hasContainer ? 'container' : hasDocker ? 'docker' : null;

if (!runtime) {
  // Apple Container requires macOS 26 (Tahoe) = Darwin 25. Anyone on Sequoia
  // or older sees only the Docker Desktop path — no point recommending an
  // installer that fails the moment they try it.
  const darwinMajor = process.platform === 'darwin' ? parseInt(release().split('.')[0], 10) : 0;
  if (darwinMajor >= 25) {
    fail('No container runtime found.\n  Install Apple Container: brew install container\n    or download the .pkg: https://github.com/apple/container/releases/latest\n  Or install and launch Docker Desktop: https://docker.com/products/docker-desktop');
  } else if (process.platform === 'darwin') {
    fail('No container runtime found.\n  Install and launch Docker Desktop: https://docker.com/products/docker-desktop');
  } else if (isWsl()) {
    // WSL2 needs Docker Desktop on Windows with the WSL 2 backend AND WSL
    // Integration enabled for this distro — that's what puts `docker` on PATH
    // inside the distro. Listing all three steps up front so users don't hit
    // them one by one.
    fail('No container runtime found.\n  Cast on WSL2 needs Docker Desktop running on Windows:\n    1. Install Docker Desktop: https://docker.com/products/docker-desktop\n    2. Settings → General → "Use the WSL 2 based engine" (default)\n    3. Settings → Resources → WSL Integration → enable this distro → Apply & Restart\n  Then re-run: pnpm start');
  } else {
    fail('No container runtime found.\n  Install and start Docker: https://docs.docker.com/engine/install/');
  }
}
const daemon = daemonRunning(runtime);
if (!daemon.ok) {
  // WSL2 + Docker Desktop's Windows shim: `docker` is on PATH but `docker info`
  // fails with a hint about activating WSL integration. The daemon is fine —
  // it just isn't proxied into this distro. Detect via the stderr hint so we
  // don't misroute a genuinely-stopped daemon to the integration settings.
  if (runtime === 'docker' && isWsl() && /WSL.*integration|could not be found in this WSL/i.test(daemon.stderr)) {
    fail('Docker Desktop is running on Windows, but WSL integration is disabled for this distro.\n  Fix: Docker Desktop → Settings → Resources → WSL Integration → enable this distro → Apply & Restart.\n  Then re-run: pnpm start');
  }
  if (runtime === 'container') {
    fail('Almost there — Apple Container is installed but not running yet.\n  Start it:    container system start\n  Then re-run: pnpm start');
  }
  // WSL2 docker: `docker` resolved but the daemon isn't reachable. Cover all
  // three failure modes (Docker Desktop not running, WSL 2 backend not
  // selected, WSL integration off) in one message so users don't hit them
  // serially.
  if (isWsl()) {
    fail('Docker daemon not reachable from WSL2.\n  Cast needs Docker Desktop running on Windows with:\n    1. Settings → General → "Use the WSL 2 based engine" (default)\n    2. Settings → Resources → WSL Integration → enable this distro → Apply & Restart\n  Install if missing: https://docker.com/products/docker-desktop\n  Then re-run: pnpm start');
  }
  if (process.platform === 'linux') {
    fail('Docker daemon not running.\n  Start it:    sudo systemctl start docker\n  Then re-run: pnpm start');
  }
  // macOS docker fallback (Apple Container unavailable or not picked).
  fail('Almost there — Docker is installed but its daemon is not running yet.\n  Launch Docker Desktop, then re-run: pnpm start');
}

// --- 2b. Apple Container minimum version -----------------------------------

// Apple Container changed its default container-capability model (and CLI
// surface) across the 0.11 → 0.12 line. Cast's sdk-only egress relies on
// in-container iptables and is verified from 0.11.0 up; older CLIs are
// untested and fail in non-obvious ways. Best-effort — a probe/parse hiccup
// must not block an otherwise-fine boot.
if (runtime === 'container') {
  try {
    const out = execSync('container --version', { stdio: 'pipe' }).toString();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const ver = [Number(m[1]), Number(m[2]), Number(m[3])];
      const MIN = [0, 11, 0];
      const cmp = ver[0] - MIN[0] || ver[1] - MIN[1] || ver[2] - MIN[2];
      if (cmp < 0) {
        fail(`Apple Container ${m[0]} is too old — Cast needs 0.11.0 or newer.\n  Update it:   brew upgrade container\n  Then re-run: pnpm start`);
      }
    }
  } catch { /* version probe failed — don't block boot on a parse/exec hiccup */ }
}

// --- 3. Dependencies --------------------------------------------------------

// Install if missing, or refresh if pnpm-lock.yaml is newer than node_modules.
// The latter handles `git pull` that bumped versions.
if (!existsSync('node_modules')) {
  log('Installing dependencies (first run)...');
  run('pnpm install', 'Dependency install');
} else if (existsSync('pnpm-lock.yaml')) {
  const lockMtime = statSync('pnpm-lock.yaml').mtimeMs;
  const nmMtime = statSync('node_modules').mtimeMs;
  if (lockMtime > nmMtime) {
    log('Lockfile changed — refreshing dependencies...');
    run('pnpm install', 'Dependency refresh');
  }
}

// --- 3b. Browser binary for web-fetch ---------------------------------------

// web-fetch drives a host-side headless chromium that `pnpm install` doesn't
// fetch (Playwright ships no browser binary). Download it once when missing so
// the web-fetch subprocess clears its startup preflight.
ensureChromium(log);

// --- 4. Bundle staleness ----------------------------------------------------

// Rebuild if dist/index.js is missing or older than any tracked source.
// build-server.ts itself is tracked so changes to the bundler invalidate too.
// packages/cast/package.json is tracked so version bumps invalidate the
// inlined __CAST_VERSION__ define.
const BUNDLE_OUT = 'dist/index.js';
// build-server.ts copies the web-fetch subprocess bundle alongside index.js.
// It's a separate artifact, so a present-but-stale dist/ can have index.js
// without it — track it explicitly or the web-fetch extension fails to launch.
const WEB_FETCH_SUBPROCESS_OUT = 'dist/web-fetch-server.js';
const SRC_ROOTS = [
  'packages/cast/src',
  'packages/cast/package.json',
  'packages/cast/snapshots',
  'packages/web-ui/src',
  'packages/web-ui/package.json',
  'packages/web-fetch/src',
  'scripts/build-server.ts',
];

let needsBundle = !existsSync(BUNDLE_OUT) || !existsSync(WEB_FETCH_SUBPROCESS_OUT);
if (!needsBundle) {
  const srcMtime = maxMtime(SRC_ROOTS);
  const bundleMtime = statSync(BUNDLE_OUT).mtimeMs;
  if (srcMtime > bundleMtime) needsBundle = true;
}
if (needsBundle) {
  log('Building web-ui...');
  run('pnpm --filter @getcast/web-ui build', 'Web-ui build');
  log('Bundling server (≈30s)...');
  run('pnpm bundle', 'Server bundle');
}

// --- 5. Agent container image ----------------------------------------------

// Staleness check: build.mjs staples a receipt tag (cast-agent:src-<hash of
// build inputs>) onto every default-tag build. If the receipt for the inputs
// on disk right now is absent, the store holds no image built from them —
// missing and stale collapse into the same probe, and a pre-receipt store
// (v0.1.0) migrates itself with one rebuild. :latest stays the run tag.
// Skipped when the operator points the server at a custom image — rebuilding
// cast-agent would be wasted work. (CAST_RUNTIME from .env files isn't
// honored here: these scripts don't parse .env, and partially honoring the
// shell var would let the check and build.mjs resolve different runtimes.)
const customImage = process.env.CONTAINER_IMAGE && process.env.CONTAINER_IMAGE !== 'cast-agent:latest';
if (!customImage && !imageExists(runtime, sentinelTag(computeImageHash()))) {
  if (imageExists(runtime, 'cast-agent:latest')) {
    log(`Agent image sources changed — rebuilding on ${runtime} (~2 min)...`);
  } else {
    log(`Building agent container image on ${runtime} (first run, ~2 min)...`);
  }
  run('node packages/agent-runner/build.mjs', 'Agent image build');
}

// --- 6. Ports + browser open (best-effort) ----------------------------------

// Two processes: the API server on CAST_PORT (5050) and the web UI on PORT
// (5051). The web UI proxies API/WebSocket traffic back to CAST_PORT, so 5051
// is the only port the user opens — the API port stays behind it.
const apiPort = process.env.CAST_PORT || '5050';
const webPort = process.env.PORT || '5051';

// Preflight: a force-kill (kill -9) or OOM-kill of a prior run can't be
// trapped, so its children may still hold these ports. We don't kill them for
// you — just fail loud with how to recover or run on different ports.
for (const [port, what, envVar] of [
  [apiPort, 'API server', 'CAST_PORT'],
  [webPort, 'web UI', 'PORT'],
]) {
  if (await portInUse(port)) {
    // The "free it" hint must use a tool present by default. macOS ships lsof;
    // a stock Debian/Ubuntu (incl. WSL2) does not, but always has ss (iproute2)
    // and usually fuser (psmisc) — so branch the suggestion per platform.
    const freeCmd = process.platform === 'darwin'
      ? `lsof -ti tcp:${port} | xargs kill`
      : `fuser -k ${port}/tcp   (or find the PID with: ss -ltnp 'sport = :${port}')`;
    fail(
      `Port ${port} (${what}) is already in use.\n` +
      `  A previous Cast may still be running — a force-kill (kill -9) or terminal\n` +
      `  crash can't be cleaned up automatically.\n` +
      `  Run on another port:  ${envVar}=<port> pnpm start\n` +
      `  Or, if you're sure nothing else needs port ${port}, free it:\n` +
      `      ${freeCmd}`,
    );
  }
}

const url = `http://localhost:${webPort}`;
log(`Starting Cast; web UI will open at ${url}`);

// --- 7. Run the API server + web UI -----------------------------------------

// Resolve and ensure data dirs exist. ~/.cast/{agents,config} by default;
// override with CAST_AGENTS_DIR / CAST_CONFIG_DIR.
const agentsDir = resolveAgentsDir();
const configDir = resolveConfigDir();
mkdirSync(agentsDir, { recursive: true });
mkdirSync(configDir, { recursive: true });

const server = spawn('node', ['dist/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // dist/index.js is the production artifact. Run it in production mode
    // (matching the pm2 ecosystem.config.cjs build-server.ts generates) so the
    // logger emits structured JSON instead of trying to load the pino-pretty
    // worker transport — a devDependency that isn't shipped in the bundle.
    NODE_ENV: 'production',
    CAST_AGENTS_DIR: agentsDir,
    CAST_CONFIG_DIR: configDir,
    CAST_PORT: apiPort,
    // So the server's startup banner advertises the web UI port (the only one
    // the user opens) rather than its own API port.
    CAST_WEB_PORT: webPort,
  },
});

// Web UI: vite preview serving packages/web-ui/dist, proxying to the API.
const webUi = spawn('pnpm', ['--filter', '@getcast/web-ui', 'preview'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: webPort, CAST_PORT: apiPort },
});

// Open the browser once both ports accept connections. Replaces a fixed
// `setTimeout(open, 6000)` that raced cold-start init on slow disks and
// first-build runs.
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
    // spawn reports a missing opener (e.g. no xdg-open on WSL2/headless Linux)
    // asynchronously via an 'error' event, not a synchronous throw — so the
    // handler, not try/catch, is what keeps it best-effort. Without it the
    // unhandled 'error' event would crash the whole process.
    const fallback = () => log(`Couldn't open a browser automatically — open ${url} manually.`);
    try {
      const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
      child.on('error', fallback);
      child.unref();
    } catch { fallback(); }
  })();
}

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill(signal);
  webUi.kill(signal);
};
// If either process exits, tear the other down and exit with its code.
server.on('exit', (code) => { shutdown('SIGTERM'); process.exit(code ?? 0); });
webUi.on('exit', (code) => { shutdown('SIGTERM'); process.exit(code ?? 0); });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Terminal close (SIGHUP) and quit (SIGQUIT) were untrapped — the parent died
// and orphaned both children on their ports. Map them to a graceful SIGTERM
// (the server traps SIGTERM/SIGINT). SIGKILL/OOM stay unreachable by design —
// the preflight above is their only backstop.
process.on('SIGHUP', () => shutdown('SIGTERM'));
process.on('SIGQUIT', () => shutdown('SIGTERM'));
