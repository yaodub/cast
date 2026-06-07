/**
 * Rebuild a live agent's in-place service bundle and copy the artifacts back.
 *
 * There is no first-class CLI to rebuild a live agent's service (buildService is
 * only wired into `agent init` for fresh agents, and it WIPES its output dir —
 * pointing it at blueprint/service/ would delete your src/). This builds to a
 * throwaway dir and copies the four artifacts back over blueprint/service/.
 *
 * Usage:  pnpm tsx scripts/deploy-service.mts <path-to/blueprint/service>
 *
 * Then restart the service to load it: the agent's admin page → "Restart Agent
 * Service", or restart the Cast server process.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { buildService } from '../packages/agent-kit/src/build-service.ts';

const serviceDir = process.argv[2];
if (!serviceDir || !fs.existsSync(path.join(serviceDir, 'src', 'index.ts'))) {
  console.error('usage: pnpm tsx scripts/deploy-service.mts <path-to/blueprint/service>');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-service-'));
try {
  await buildService(serviceDir, tmp);
  const artifacts = ['index.js', 'index.js.map', 'checksum.txt', 'manifest.json'];
  for (const f of artifacts) {
    const from = path.join(tmp, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(serviceDir, f));
  }
  const checksum = fs.readFileSync(path.join(serviceDir, 'checksum.txt'), 'utf-8').trim();
  console.log(`✅ deployed to ${serviceDir}\n   checksum ${checksum.slice(0, 12)}… — restart the service to load it`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
