import { DocsLayout, H2, proseP, proseTable, proseTh, proseTd } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FieldTable } from '../../../components/docs/FieldTable';

export function AdvancedBackups() {
  return (
    <DocsLayout
      url="/docs/advanced/backups"
      crumbs={['docs', 'advanced', 'backups & data']}
      title="Backups & data"
      lede="Cast snapshots each agent on a daily schedule. Knowing what those snapshots cover — and the data they don't — is the difference between a clean recovery and a surprise."
      toc={[
        { label: 'Automatic snapshots' },
        { label: "What's covered, and what isn't" },
        { label: "The agent's keypair" },
        { label: 'Restoring' },
        { label: 'Backing up safely' },
      ]}
    >
      <p style={proseP}>
        The unit of backup is the agent folder. Cast takes an automatic daily snapshot of
        each one; the agent's keypair and your server-level config need separate
        attention, covered below.
      </p>

      <H2>Automatic snapshots</H2>
      <p style={proseP}>
        Once a day, after a configurable UTC hour, Cast tars the agent's folder to{' '}
        <code>&lt;agent&gt;/.backups/YYYY-MM-DD.tar.gz</code>. New agents are created with
        this on. The archive holds everything in the folder except dot-directories
        (<code>.backups/</code>, <code>.stamps/</code>, and other scratch) — so{' '}
        <code>blueprint/</code>, <code>config/</code>, <code>state/</code>,{' '}
        <code>memory/</code>, <code>home/</code>, and <code>secrets/</code> all travel.
      </p>
      <p style={proseP}>
        At most one snapshot is kept per calendar day, and if nothing changed since the
        last one the new tarball is discarded (it's compared by content hash). A quiet day
        simply produces no file — that's expected, not a failure. Older snapshots are
        pruned once the count passes <code>retain</code>.
      </p>

      <FieldTable
        fields={[
          {
            name: 'retain',
            type: 'int',
            default: '7',
            effect: 'Number of snapshots kept. Once exceeded, the oldest are deleted.',
          },
          {
            name: 'hour',
            type: 'int (0–23)',
            default: '3',
            effect: 'UTC hour at or after which the day’s snapshot is taken.',
          },
        ]}
      />
      <Code lang="json" title="config/agent.json (excerpt)">{`{
  "backup": { "retain": 7, "hour": 3 }
}`}</Code>

      <H2>What's covered, and what isn't</H2>
      <p style={proseP}>
        The snapshot is the agent folder, and nothing else. Everything that defines and
        records one agent is inside it; data that lives at the server level is not — back
        that up yourself.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Location</th>
            <th style={proseTh}>In snapshots?</th>
            <th style={proseTh}>What it holds</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}><code>&lt;agent&gt;/</code></td>
            <td style={proseTd}>Yes</td>
            <td style={proseTd}>
              Blueprint, config (model, ACL, extension credentials), state (conversation
              log, tasks, access grants, attachments), memory, home, and the keypair. The full
              breakdown is on{' '}
              <DocsLink href="/docs/build/agent-folder">Agent folder anatomy</DocsLink>.
            </td>
          </tr>
          <tr>
            <td style={proseTd}><code>~/.cast/config/</code></td>
            <td style={proseTd}>No</td>
            <td style={proseTd}>
              Server-level data: <code>routes.json</code>, <code>firewall.json</code>,{' '}
              <code>gateway.db</code>, the identity database, and console/host logs. Not
              part of any agent snapshot.
            </td>
          </tr>
          <tr>
            <td style={proseTd}><code>.env</code></td>
            <td style={proseTd}>No</td>
            <td style={proseTd}>
              Your Claude credentials. Lives in the working directory, never in an agent
              folder.
            </td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        To protect a whole install — not just one agent — copy <code>~/.cast/config/</code>{' '}
        and your <code>.env</code> alongside the per-agent snapshots. Paths are
        configurable; see{' '}
        <DocsLink href="/docs/advanced/runtime-options">Runtime options</DocsLink>.
      </p>

      <H2>The agent's keypair</H2>
      <Callout kind="security">
        <code>secrets/agent.key</code> is the agent's Ed25519 identity key. It rides along
        in snapshots, but if you ever lose both the live folder and its snapshots, it's
        gone for good — there's no regeneration path that preserves the agent's identity.
        A replacement agent starts as a new identity, and its history won't be attributable
        to the old one. Treat this file as the one piece you cannot afford to lose.
      </Callout>

      <H2>Restoring</H2>
      <p style={proseP}>
        There's no built-in restore command — recovery is a manual extract-and-copy. The
        archive contains the agent folder at its root, so extract it somewhere scratch,
        then copy the pieces you want back:
      </p>
      <Code lang="bash" noHead>{`# stop the agent (or the whole server) first — see below
tar -xzf ~/.cast/agents/<name>/.backups/2026-05-27.tar.gz -C /tmp
cp -a /tmp/<name>/. ~/.cast/agents/<name>/`}</Code>
      <p style={proseP}>
        Copy selectively if you only want part of it back — restoring <code>blueprint/</code>{' '}
        to undo a bad edit, say, without rolling <code>state/</code> back to a stale
        conversation log.
      </p>

      <H2>Backing up safely</H2>
      <p style={proseP}>
        The snapshot tars the agent's SQLite databases (<code>state/agent.db</code> and its{' '}
        <code>-wal</code>/<code>-shm</code> companions) while the agent may be mid-write.
        SQLite usually recovers a copy taken this way on next open, and the automatic daily
        snapshot accepts that small risk for unattended operation. For a backup you intend
        to rely on — and before any restore — <strong>stop the agent or the server first</strong>{' '}
        so the databases are quiescent and the copy is unambiguously consistent.
      </p>
    </DocsLayout>
  );
}
