/**
 * One-shot sweep: validate every agent under CAST_AGENTS_DIR using the new
 * shared validator. Used to surface drift before the strict-schema flips
 * (CapabilitiesSchema/ProvisionsSchema/AgentConfigSchema/AclSchema) ship.
 *
 * Run with `tsx packages/cast/scripts/validate-all-agents.ts` from the repo
 * root. Reads `.env` for CAST_AGENTS_DIR.
 */
import fs from 'fs';
import path from 'path';

import { email } from '@getcast/ext-email';
import { webFetch } from '@getcast/ext-web-fetch';
import { calendar } from '@getcast/ext-calendar';
import { whatsapp } from '@getcast/ext-whatsapp';

import { AGENTS_DIR } from '../src/config.js';
import { setWatcher } from '../src/lib/config-reader.js';
import { renderValidationReport, validateAgentBlueprint } from '../src/console/shared/validation.js';
import { registerExtension } from '../src/extensions/registry.js';

// Register the first-party extensions so capabilities.json blobs are validated
// against their real configSchema (matches src/index.ts at server startup).
registerExtension(email);
registerExtension(webFetch);
registerExtension(calendar);
registerExtension(whatsapp);

// Provide a no-watcher pass-through reader — the script runs offline and just
// needs disk reads to feed config-reader callers (extension activation/etc.).
setWatcher({
  get(filePath: string) {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  },
});

function main(): void {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`Agents dir does not exist: ${AGENTS_DIR}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  let problemCount = 0;
  let warningCount = 0;

  for (const folder of entries) {
    const report = validateAgentBlueprint(folder);
    const status = report.problems.length > 0
      ? `FAIL (${report.problems.length} problems`
      : 'OK';
    const w = report.warnings.length > 0 ? `, ${report.warnings.length} warnings)` : ')';
    console.log(`\n=== ${folder} — ${status}${report.problems.length > 0 ? w : ''}`);
    if (report.problems.length > 0 || report.warnings.length > 0) {
      const lines = renderValidationReport(report).split('\n');
      // Skip the leading 'Validation passed/failed' line; print only the parts
      // that name what's broken.
      for (const line of lines) {
        if (line.startsWith('Validation') || line.startsWith('Passed') || line.trim() === '') continue;
        if (line.startsWith('-')) console.log('  ' + line);
        else console.log('  ' + line);
      }
    }
    problemCount += report.problems.length;
    warningCount += report.warnings.length;
  }

  console.log(`\n=== Summary: ${entries.length} agents, ${problemCount} problems total, ${warningCount} warnings total`);
  process.exit(problemCount > 0 ? 1 : 0);
}

main();
