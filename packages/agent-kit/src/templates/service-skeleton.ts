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

import { CronExpressionParser } from 'cron-parser';
import dotenv from 'dotenv';

const AGENT_DIR = process.env.CAST_AGENT_DIR;
const AGENT_ID = process.env.CAST_AGENT_FOLDER;
const SERVICE_DIR = process.env.SERVICE_DIR;

if (!AGENT_DIR || !AGENT_ID || !SERVICE_DIR) {
  console.error('Missing required env: CAST_AGENT_DIR, CAST_AGENT_FOLDER, SERVICE_DIR');
  process.exit(1);
}

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
    return JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, 'manifest.json'), 'utf-8'));
  } catch (err) {
    log(\`Failed to read manifest: \${err.message}\`);
    return { jobs: [] };
  }
}

function loadSecrets() {
  try {
    return dotenv.parse(fs.readFileSync(path.join(SERVICE_DIR, '.env'), 'utf-8'));
  } catch { return {}; }
}

function computeNextRun(cronExpr) {
  return CronExpressionParser.parse(cronExpr, { tz: TIMEZONE }).next().toISOString();
}

async function runJob(state, secrets) {
  const { decl } = state;
  const scriptPath = path.resolve(SERVICE_DIR, decl.script);
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
