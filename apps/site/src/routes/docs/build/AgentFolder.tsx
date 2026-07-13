import type { ComponentChildren } from 'preact';
import { DocsLayout, H2, proseP, proseUl, proseTable, proseTh, proseTd } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';

type ZoneKey = 'blueprint' | 'config' | 'state' | 'runtime';

const zoneColor: Record<ZoneKey, string> = {
  blueprint: '#0EA5E9',
  config: '#F59E0B',
  state: '#8B5CF6',
  runtime: '#10B981',
};

const zoneBg: Record<ZoneKey, string> = {
  blueprint: 'rgba(14, 165, 233, 0.08)',
  config: 'rgba(245, 158, 11, 0.08)',
  state: 'rgba(139, 92, 246, 0.08)',
  runtime: 'rgba(16, 185, 129, 0.08)',
};

function ZoneTag({ zone }: { zone: ZoneKey }) {
  const label = zone[0]!.toUpperCase() + zone.slice(1);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 4,
        background: zoneBg[zone],
        color: zoneColor[zone],
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: '0.04em',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 2,
          background: zoneColor[zone],
        }}
      />
      {label}
    </span>
  );
}

interface FolderLine {
  text: string;
  comment?: string;
  zone?: ZoneKey;
}

function FolderMap({ lines }: { lines: FolderLine[] }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '12px 0',
        margin: '4px 0 12px',
        background: 'var(--bg-elev)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        lineHeight: 1.7,
        overflow: 'hidden',
      }}
    >
      {lines.map((l, i) => {
        const hasZone = !!l.zone;
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 14,
              padding: '0 14px',
              borderLeft: hasZone ? `3px solid ${zoneColor[l.zone!]}` : '3px solid transparent',
              background: hasZone ? zoneBg[l.zone!] : 'transparent',
              minHeight: 22,
            }}
          >
            <span
              style={{
                color: 'var(--fg)',
                whiteSpace: 'pre',
                flexShrink: 0,
              }}
            >
              {l.text || ' '}
            </span>
            {l.comment && (
              <span
                style={{
                  color: 'var(--fg-subtle)',
                  fontStyle: 'italic',
                }}
              >
                {l.comment}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const folderTree: FolderLine[] = [
  { text: 'agents/my-agent/' },
  { text: '├── manifest.json', comment: 'alias, pubkey, spec version' },
  { text: '├── secrets/' },
  { text: '│   └── agent.key', comment: 'Ed25519 private key — never mounted to any container' },
  { text: '│' },
  { text: '├── blueprint/', zone: 'blueprint' },
  { text: '│   ├── identity/', zone: 'blueprint' },
  { text: '│   │   ├── prompt.md', comment: 'core persona', zone: 'blueprint' },
  { text: '│   │   ├── whoami.md', comment: 'structured identity facts', zone: 'blueprint' },
  { text: '│   │   └── skills.md', comment: 'tool guidance', zone: 'blueprint' },
  { text: '│   ├── channels/', zone: 'blueprint' },
  { text: '│   │   └── <name>/', zone: 'blueprint' },
  { text: '│   │       ├── channel.json', comment: 'idle timeout, lifecycle, log policy', zone: 'blueprint' },
  { text: '│   │       ├── prompt.md', comment: 'channel-specific instructions', zone: 'blueprint' },
  { text: '│   │       ├── bootstrap.md', comment: 'restore working state', zone: 'blueprint' },
  { text: '│   │       └── cleanup.md', comment: 'persist before close', zone: 'blueprint' },
  { text: '│   ├── props/', zone: 'blueprint' },
  { text: '│   │   ├── settings.json', comment: 'profile, env overrides', zone: 'blueprint' },
  { text: '│   │   ├── capabilities.json', comment: 'disabled tools, extension config', zone: 'blueprint' },
  { text: '│   │   └── schedule.txt', comment: 'declarative cron messages', zone: 'blueprint' },
  { text: '│   ├── service/', comment: 'optional: persistent host process', zone: 'blueprint' },
  { text: '│   └── assets/', comment: 'optional: static reference data', zone: 'blueprint' },
  { text: '│' },
  { text: '├── config/', zone: 'config' },
  { text: '│   ├── agent.json', comment: 'model, network mode, timezone', zone: 'config' },
  { text: '│   ├── acl.json', comment: 'agent + human access grants', zone: 'config' },
  { text: '│   └── ext/<name>/', comment: 'operator overrides + .env per extension', zone: 'config' },
  { text: '│' },
  { text: '├── state/', zone: 'state' },
  { text: '│   ├── conversations.jsonl', zone: 'state' },
  { text: '│   ├── tasks.json', zone: 'state' },
  { text: '│   ├── agent.db', comment: 'message log + FTS5', zone: 'state' },
  { text: '│   ├── attachments/', comment: 'content-addressed blob store', zone: 'state' },
  { text: '│   └── identity-roster.json', zone: 'state' },
  { text: '│' },
  { text: '├── memory/', comment: 'agent-writable, mounted', zone: 'runtime' },
  { text: '├── home/', comment: 'agent-writable, mounted', zone: 'runtime' },
  { text: '├── shared/', comment: 'extension → agent publishing', zone: 'runtime' },
  { text: '└── ext/', comment: 'extension private runtime', zone: 'runtime' },
];

function ZoneCard({
  zone,
  title,
  body,
}: {
  zone: ZoneKey;
  title: string;
  body: ComponentChildren;
}) {
  return (
    <div
      style={{
        padding: '14px 16px',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${zoneColor[zone]}`,
        borderRadius: 6,
        background: zoneBg[zone],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <ZoneTag zone={zone} />
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--fg)' }}>{title}</span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

export function BuildAgentFolder() {
  return (
    <DocsLayout
      url="/docs/build/agent-folder"
      crumbs={['docs', 'build agents', 'agent folder anatomy']}
      title="Agent folder anatomy"
      lede="Everything an agent is — its identity, its memory, how it connects — lives in one directory. Edit it, the agent changes. Copy it, the agent travels."
      toc={[
        { label: 'The four zones' },
        { label: 'The manifest' },
        { label: 'What the container sees' },
        { label: 'The folder map' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Every agent on a Cast server is a single directory under{' '}
        <code>~/.cast/agents/</code> by default (override with{' '}
        <code>CAST_AGENTS_DIR</code> — see{' '}
        <DocsLink href="/docs/advanced/runtime-options">Runtime options</DocsLink>).
        The directory IS the agent — not a manifest pointing elsewhere, not a database
        row with files alongside. Inside, the subfolders split into four zones by writer
        and lifetime. That split tells you what's portable, what's local to this
        install, what the server writes for you, and what the agent writes for itself.
      </p>

      <H2>The four zones</H2>

      <div style={{ display: 'grid', gap: 10, margin: '4px 0 22px' }}>
        <ZoneCard
          zone="blueprint"
          title="Blueprint — what the agent IS"
          body={
            <>
              Identity, channels, props, optionally a service. The unit of authorship.
              Copy <code>blueprint/</code> into a fresh install and the agent behaves
              the same.
            </>
          }
        />
        <ZoneCard
          zone="config"
          title="Config — how it's wired into this install"
          body={
            <>
              The model, the ACL, per-extension credentials. Not portable on purpose —
              per-install decisions and per-machine secrets.
            </>
          }
        />
        <ZoneCard
          zone="state"
          title="State — what the server records"
          body={
            <>
              Conversation log (<code>agent.db</code>), attachments, tasks, identity
              roster. Server-managed — read when debugging, never hand-edit.
            </>
          }
        />
        <ZoneCard
          zone="runtime"
          title="Runtime — what the agent and extensions write"
          body={
            <>
              <code>memory/</code> and <code>home/</code> are the agent's working
              storage. <code>shared/</code> and <code>ext/</code> are extensions'
              publish-to-agent outputs and private state. All mounted into the
              container.
            </>
          }
        />
      </div>
      <p style={proseP}>
        Everything else under the folder is process scratch — recreated on each run, safe
        to ignore.
      </p>

      <Callout kind="tip">
        Most blueprint and config edits hot-reload — change a file, the next message picks
        it up. Service code is the exception: restart the service to pick up changes there.
      </Callout>

      <H2>The manifest</H2>
      <p style={proseP}>
        <code>manifest.json</code> at the top of the folder holds the agent's
        identifying metadata. Required: <code>spec</code> (schema version) and{' '}
        <code>name</code> (the agent's alias — the folder name on disk is independent).
        Optional standard fields: <code>pubkey</code>, <code>description</code>,{' '}
        <code>status: "draft"</code>. Additional keys pass through untouched, so
        generators can stash provenance metadata without coordinating with the server.
      </p>

      <Code lang="json" title="manifest.json">{`{
  "spec": "1.0.0",
  "name": "morning-briefing",
  "description": "Curates morning emails.",
  "pubkey": "0a3f...8e2c"
}`}</Code>

      <H2>What the container sees</H2>
      <p style={proseP}>
        The agent runs inside a container, and the container is a sandbox. The LLM only
        sees what's mounted in. Everything else on disk — <code>config/</code>,{' '}
        <code>blueprint/service/</code>, the bus, the host filesystem — is invisible from
        the agent's side.
      </p>

      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Inside the container</th>
            <th style={proseTh}>Mounted from</th>
            <th style={proseTh}>Access</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}><code>/identity</code></td>
            <td style={proseTd}><code>blueprint/identity/</code></td>
            <td style={proseTd}>read-only</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/assets</code></td>
            <td style={proseTd}><code>blueprint/assets/</code></td>
            <td style={proseTd}>read-only</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/memory</code></td>
            <td style={proseTd}><code>memory/</code></td>
            <td style={proseTd}>read-write</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/home/agent</code></td>
            <td style={proseTd}><code>home/</code></td>
            <td style={proseTd}>read-write</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/shared</code></td>
            <td style={proseTd}><code>shared/ext/</code></td>
            <td style={proseTd}>read-only</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/attachments</code></td>
            <td style={proseTd}><code>state/attachments/</code></td>
            <td style={proseTd}>read-only</td>
          </tr>
          <tr>
            <td style={proseTd}><code>/staging</code></td>
            <td style={proseTd}>per-conversation <code>staging/</code></td>
            <td style={proseTd}>read-write</td>
          </tr>
        </tbody>
      </table>

      <Callout kind="security">
        The mount table IS the security boundary. A secret in <code>config/ext/email/.env</code>{' '}
        is invisible to the agent — only the extension code (running on the host) sees it.
        A secret in <code>home/</code> or <code>memory/</code> is right there in the agent's
        filesystem, available to any tool the agent invokes. When in doubt about a credential,
        config/.
      </Callout>

      <H2>The folder map</H2>
      <p style={proseP}>
        Not exhaustive — the load-bearing entries, with their zone in the right margin.
      </p>

      <FolderMap lines={folderTree} />

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/concepts/conversations">Conversations</DocsLink> — what
          actually runs inside the container, and how the conversation tuple bounds
          isolation.
        </li>
        <li>
          <DocsLink href="/docs/concepts/channels">Channels</DocsLink> — the concept
          behind each <code>blueprint/channels/&lt;name&gt;/</code> folder.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> — the
          contents of <code>blueprint/</code> as authoring surfaces: identity, channels,
          props, the system prompt that ties them together.
        </li>
        <li>
          <DocsLink href="/docs/build/services">Writing services</DocsLink> — when{' '}
          <code>blueprint/service/</code> earns its keep, and the trust model that comes
          with it.
        </li>
      </ul>
    </DocsLayout>
  );
}
