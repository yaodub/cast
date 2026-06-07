export const SERVICE_SKELETON = `\
/**
 * Agent service entry point — persistent process forked by cast server.
 *
 * Responsibilities:
 *   - Read manifest.json for job declarations
 *   - Run internal cron scheduler (evaluates schedules, spawns job scripts)
 *   - Listen for IPC commands from cast server (run-job, shutdown)
 *   - Report ready/job-complete/job-error to parent via IPC
 */
import { spawn as childSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CronExpressionParser } from 'cron-parser';

// Config injected by the cast server (SPEC.md §9).
const cfg = (() => {
  try { return JSON.parse(process.env.CAST_SERVICE_CONFIG ?? ''); } catch { return null; }
})();
if (!cfg?.agentDir || !cfg?.agentFolder) {
  console.error('Missing or invalid CAST_SERVICE_CONFIG — service must be launched by the cast server');
  process.exit(1);
}
const AGENT_DIR = cfg.agentDir;
const AGENT_ID = cfg.agentFolder;

// Service code dir (manifest.json + job scripts). Stamped bundle: alongside
// index.js at the service root. Template dev (entry src/index.ts): one level up.
const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODE_DIR = fs.existsSync(path.join(ENTRY_DIR, 'manifest.json')) ? ENTRY_DIR : path.resolve(ENTRY_DIR, '..');

const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const POLL_INTERVAL = 60_000;

function log(message) {
  console.error(\`[service:\${AGENT_ID}] \${message}\`);
}

function sendIpc(msg) {
  if (process.send) process.send(msg);
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CODE_DIR, 'manifest.json'), 'utf-8'));
  } catch (err) {
    log(\`Failed to read manifest: \${err.message}\`);
    return { jobs: [] };
  }
}

// Operator-owned secrets snapshot (config/ext/service/secrets.json). The
// server restarts this process when the file changes, so a startup read is
// always current. Missing or invalid file → {} (service starts unconfigured).
function loadSecrets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'config', 'ext', 'service', 'secrets.json'), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string'));
  } catch { return {}; }
}

function computeNextRun(cronExpr) {
  return CronExpressionParser.parse(cronExpr, { tz: TIMEZONE }).next().toISOString();
}

async function runJob(state, secrets) {
  const { decl } = state;
  const scriptPath = path.resolve(CODE_DIR, decl.script);
  if (!fs.existsSync(scriptPath)) {
    sendIpc({ type: 'job-error', name: decl.name, error: \`Script not found: \${decl.script}\` });
    return;
  }
  state.running = true;
  log(\`Running job: \${decl.name}\`);
  try {
    const code = await new Promise((resolve) => {
      const proc = childSpawn('npx', ['tsx', scriptPath], {
        cwd: AGENT_DIR, env: { ...process.env, ...secrets, CAST_AGENT_FOLDER: AGENT_ID, CAST_AGENT_DIR: AGENT_DIR },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.end();
      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => process.stderr.write(d));
      proc.on('close', resolve);
      proc.on('error', () => resolve(1));
    });
    if (code !== 0) sendIpc({ type: 'job-error', name: decl.name, error: \`Exit code \${code}\` });
    else sendIpc({ type: 'job-complete', name: decl.name });
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
    try { state.nextRun = computeNextRun(decl.schedule); } catch {}
  }
}

async function main() {
  const manifest = readManifest();
  const secrets = loadSecrets();
  const jobs = [];
  for (const decl of manifest.jobs ?? []) {
    try { jobs.push({ decl, nextRun: computeNextRun(decl.schedule), running: false, lastRun: null }); }
    catch (err) { log(\`Invalid cron for "\${decl.name}": \${err.message}\`); }
  }
  log(\`Loaded \${jobs.length} jobs\`);

  const timer = setInterval(() => {
    const now = new Date().toISOString();
    for (const state of jobs) {
      if (!state.running && state.nextRun <= now) runJob(state, secrets);
    }
  }, POLL_INTERVAL);

  process.on('message', (msg) => {
    if (msg.type === 'run-job') {
      const state = jobs.find((j) => j.decl.name === msg.name);
      if (!state) { sendIpc({ type: 'job-error', name: msg.name, error: 'Job not found' }); return; }
      if (state.running) { sendIpc({ type: 'job-error', name: msg.name, error: 'Already running' }); return; }
      runJob(state, secrets);
    }
    if (msg.type === 'shutdown') {
      log('Shutdown requested');
      clearInterval(timer);
      setTimeout(() => process.exit(0), 5_000);
    }
  });

  sendIpc({ type: 'ready' });
  log('Service ready');
}

main().catch((err) => { log(\`Fatal: \${err.message}\`); process.exit(1); });
`;
