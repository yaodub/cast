import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { Code } from '../../../components/ui/Code';
import { Callout } from '../../../components/ui/Callout';
import { FieldTable } from '../../../components/docs/FieldTable';

export function AdvancedRuntimeOptions() {
  return (
    <DocsLayout
      url="/docs/advanced/runtime-options"
      crumbs={['docs', 'advanced', 'runtime options']}
      title="Runtime options"
      lede="Every environment variable the Cast server reads, with defaults and effects."
      toc={[
        { label: 'Data location' },
        { label: 'Container runtime' },
        { label: 'Port' },
        { label: 'Limits and timeouts' },
        { label: 'Offline mode' },
        { label: 'Secrets (.env-only)' },
        { label: 'Running multiple instances' },
      ]}
    >
      <p style={proseP}>
        Source-of-truth for the schema: <code>packages/cast/src/env.ts</code>. Most
        defaults are fine for personal use — reach for these when you want a different
        data location, port-pinning, or multi-instance setup.
      </p>

      <H2>Data location</H2>
      <FieldTable
        fields={[
          {
            name: 'CAST_AGENTS_DIR',
            type: 'path',
            required: true,
            effect: (
              <>
                Directory holding agent instance folders. The wrapper scripts default it
                to <code>~/.cast/agents/</code>.
              </>
            ),
          },
          {
            name: 'CAST_CONFIG_DIR',
            type: 'path',
            required: true,
            effect: (
              <>
                Server-level config and SQLite databases (<code>routes.json</code>,{' '}
                <code>firewall.json</code>, <code>gateway.db</code>, <code>host.db</code>).
                The wrapper scripts default it to <code>~/.cast/config/</code>.
              </>
            ),
          },
        ]}
      />
      <p style={proseP}>
        Both default to subdirectories of <code>~/.cast/</code> — deliberately outside
        the Cast source repo so updates and clones never touch user data. The wrapper
        scripts (<code>pnpm start</code>, <code>pnpm dev</code>) resolve these defaults
        and create the directories if missing; the server itself requires the env vars
        to be set explicitly (no defaults in <code>env.ts</code>).
      </p>
      <Callout kind="tip">
        Two Cast clones share <code>~/.cast/</code> by default — same model as{' '}
        <code>~/.claude/</code>, <code>~/.npm/</code>. If you want isolation per clone,
        set <code>CAST_AGENTS_DIR</code> and <code>CAST_CONFIG_DIR</code> explicitly in
        each clone's shell.
      </Callout>

      <H2>Container runtime</H2>
      <FieldTable
        fields={[
          {
            name: 'CAST_RUNTIME',
            type: 'enum',
            default: 'auto',
            effect: (
              <>
                <code>auto</code> prefers Apple Container on macOS and Docker elsewhere
                (including Linux and Windows/WSL2); force a choice with <code>docker</code>{' '}
                or <code>apple-container</code>.
              </>
            ),
          },
          {
            name: 'CONTAINER_IMAGE',
            type: 'string',
            default: 'cast-agent:latest',
            effect: (
              <>
                Agent container image tag. Release builds also tag{' '}
                <code>cast-agent:&lt;version&gt;</code>.
              </>
            ),
          },
        ]}
      />

      <H2>Port</H2>
      <p style={proseP}>
        Cast runs as two processes: the API server and the web UI in front of it. Each has
        its own port. <code>5051</code> — the web UI — is the address you open;{' '}
        <code>CAST_PORT</code> sits behind it. (<code>PORT</code> is read by the web-UI
        process, not the server, but it's listed here since it's the port you actually
        visit.)
      </p>
      <FieldTable
        fields={[
          {
            name: 'PORT',
            type: 'int',
            default: '5051',
            effect: (
              <>
                The web UI's port — what you open in a browser. It proxies API and
                WebSocket traffic to <code>CAST_PORT</code>, so this is the only port a
                user needs.
              </>
            ),
          },
          {
            name: 'CAST_PORT',
            type: 'int',
            default: '5050',
            effect: (
              <>
                Port for the Cast API server and its WebSocket — the target the web UI
                proxies to. Set <code>0</code> to let the OS pick a free port (printed in
                the startup banner).
              </>
            ),
          },
        ]}
      />

      <H2>Limits and timeouts</H2>
      <FieldTable
        fields={[
          {
            name: 'MAX_CONCURRENT_CONTAINERS',
            type: 'int',
            default: '3',
            effect: 'Global cap on simultaneous agent containers (minimum 1).',
          },
          {
            name: 'CONTAINER_TIMEOUT',
            type: 'ms',
            default: '1800000',
            effect: 'Max wall-clock time for a single container run (30 min).',
          },
          {
            name: 'CONTAINER_MAX_OUTPUT_SIZE',
            type: 'bytes',
            default: '10485760',
            effect: "Cap on a single container run's captured output (10 MB).",
          },
          {
            name: 'IDLE_TIMEOUT',
            type: 'ms',
            default: '1800000',
            effect:
              'How long a container stays alive after responding, waiting for follow-up messages (30 min).',
          },
          {
            name: 'MAX_ATTACHMENT_MB',
            type: 'int',
            default: '10',
            effect: 'Per-message attachment size limit, in MB.',
          },
        ]}
      />

      <H2>Offline mode</H2>
      <FieldTable
        fields={[
          {
            name: 'CAST_DISABLE_UPDATE_CHECK',
            type: 'bool',
            default: 'false',
            effect: (
              <>
                Skip the update check against <code>api.getcast.dev</code>.
              </>
            ),
          },
          {
            name: 'CAST_DISABLE_MODEL_REFRESH',
            type: 'bool',
            default: 'false',
            effect:
              'Skip the model-catalog refresh; fall back to the embedded snapshot.',
          },
        ]}
      />

      <H2>Secrets (.env-only)</H2>
      <p style={proseP}>
        These are read from <code>.env</code> in the working directory only — never from{' '}
        <code>process.env</code>. Keeps credentials off shell history and out of inherited
        environments.
      </p>
      <FieldTable
        fields={[
          {
            name: 'AUTH_MODE',
            type: 'enum',
            effect: (
              <>
                <code>api-key</code> or <code>setup-token</code> — selects which
                credential below is used.
              </>
            ),
          },
          {
            name: 'ANTHROPIC_API_KEY',
            type: 'string',
            effect: (
              <>
                Anthropic API key, for <code>api-key</code> mode.
              </>
            ),
          },
          {
            name: 'CLAUDE_CODE_OAUTH_TOKEN',
            type: 'string',
            effect: (
              <>
                OAuth token from <code>claude setup-token</code>, for{' '}
                <code>setup-token</code> mode.
              </>
            ),
          },
        ]}
      />

      <H2>Running multiple instances</H2>
      <p style={proseP}>
        Cast is a single Node process. To run more than one (per-user, per-project,
        per-environment), point each at a distinct data dir and port:
      </p>
      <Code lang="bash">{`CAST_AGENTS_DIR=~/cast-work/agents \\
CAST_CONFIG_DIR=~/cast-work/config \\
CAST_PORT=3002 \\
pnpm start

CAST_AGENTS_DIR=~/cast-personal/agents \\
CAST_CONFIG_DIR=~/cast-personal/config \\
CAST_PORT=3003 \\
pnpm start`}</Code>
      <p style={proseP}>
        Each instance gets its own agent folders, gateway DB, and config files.
        Credentials in <code>.env</code> are shared because <code>.env</code> lives in
        the source repo — separate clones or distinct <code>.env</code> files if you want
        credential isolation too.
      </p>
    </DocsLayout>
  );
}
