import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Stand in for the esbuild define used by the bundled server build. Without
  // it, env.ts falls through to a runtime package.json read at module load —
  // which fails in tests that mock `fs.readFileSync` with a blanket throw.
  define: {
    __CAST_VERSION__: JSON.stringify('test'),
  },
  test: {
    root: __dirname,
    include: [
      'src/**/*.test.ts',
      '../agent-runner/src/**/*.test.ts',
      '../ext-whatsapp/src/**/*.test.ts',
      '../ext-calendar/src/**/*.test.ts',
      '../ext-email/src/**/*.test.ts',
    ],
    env: {
      CAST_AGENTS_DIR: path.join(__dirname, '.vitest-tmp', 'agents'),
      CAST_CONFIG_DIR: path.join(__dirname, '.vitest-tmp', 'config'),
    },
  },
});
