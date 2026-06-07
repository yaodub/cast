/**
 * Blocking setup-step runner — execSync with inherited stdio, exiting cleanly
 * on failure instead of letting the throw escape. The child's own output is
 * already on screen, so an uncaught execSync Error would only stack Node's
 * generic "Command failed: …" trace on top of the real message. The one-liner
 * carries the only facts the wrapper uniquely knows — which step, and how it
 * died — so a child killed without printing anything (e.g. OOM) still leaves
 * an explanation.
 *
 * Used by start.mjs and dev.ts for pre-flight steps (pnpm install, web-ui
 * build, server bundle, agent image build).
 */
import { execSync } from 'child_process';

/** Run `cmd` with inherited stdio; on failure print one `[cast]`-tagged line
 *  naming `what` and how it died, then exit mirroring the child's code.
 *  Ctrl-C (SIGINT) exits 130 silently — a user cancel, not a failure. */
export function run(cmd, what) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    if (err?.signal === 'SIGINT') process.exit(130);
    const code = typeof err?.status === 'number' ? err.status : 1;
    console.error(`\x1b[31m[cast]\x1b[0m ${what} failed (${err?.signal ? `killed by ${err.signal}` : `exit ${code}`}).`);
    process.exit(code);
  }
}
