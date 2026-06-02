import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [
    preact({
      prerender: {
        enabled: true,
        renderTarget: '#app',
        additionalPrerenderRoutes: [
          '/',
          '/examples',
          '/examples/second-brain',
          '/examples/group-trip',
          '/examples/prediction-edge',
          '/examples/health-stack',
          '/how-it-works',
          '/how-it-works/agents-as-folders',
          '/how-it-works/sandbox',
          '/how-it-works/channels',
          '/how-it-works/identity',
          '/docs/quickstart',
          '/docs/use/server-dashboard',
          '/docs/use/first-agent',
          '/docs/use/pairing',
          '/docs/concepts/conversations',
          '/docs/concepts/channels',
          '/docs/concepts/triggers',
          '/docs/concepts/capabilities',
          '/docs/concepts/multi-user',
          '/docs/concepts/migrating',
          '/docs/build/agent-folder',
          '/docs/build/blueprints',
          '/docs/build/multi-agent',
          '/docs/build/designing-well',
          '/docs/build/claude-code',
          '/docs/build/services',
          '/docs/build/packaging',
          '/docs/extend/extension',
          '/docs/extend/transport',
          '/docs/extend/profile',
          '/docs/advanced/deployment',
          '/docs/advanced/runtime-options',
          '/docs/advanced/backups',
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
