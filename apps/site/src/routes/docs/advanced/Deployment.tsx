import { DocsLayout, H2, H3, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';

export function AdvancedDeployment() {
  return (
    <DocsLayout
      url="/docs/advanced/deployment"
      crumbs={['docs', 'advanced', 'deployment']}
      title="Deployment"
      lede="Cast is personal infrastructure: one always-on process, on a machine you trust, bound to localhost by design."
      toc={[
        { label: 'Keep it running' },
        { label: 'Reach your agents from anywhere' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Cast is a single Node process that runs your agents on one machine you control —
        a laptop, a home server, a small VPS. It binds <code>127.0.0.1</code>: the
        dashboard, the chat UI, and the admin surface are reachable only from that
        machine.
      </p>

      <Callout kind="security">
        Keep that binding — it's the security model. The admin surface trusts whoever can
        reach it, so it belongs on localhost, behind your own network. To reach an agent
        from another device, use a transport (see below) rather than exposing the server.
      </Callout>

      <p style={proseP}>
        So there are two things to set up: keeping Cast running across crashes and
        reboots, and reaching your agents while you're away from the machine.
      </p>

      <H2>Keep it running</H2>
      <p style={proseP}>
        <code>pnpm start</code> runs Cast in the foreground — fine while you're working,
        but it dies with the terminal. For an always-on agent you want a process
        supervisor: something that starts Cast on boot, restarts it if it crashes, and
        captures its logs. Whichever you pick, Cast still needs its container runtime
        (Apple Container or Docker) already running — the supervisor starts Cast, not the
        runtime underneath it.
      </p>

      <H3>Bundle to a deploy folder</H3>
      <p style={proseP}>
        You don't have to run Cast from the repo you cloned. <code>pnpm bundle</code>{' '}
        produces a self-contained directory you can put anywhere and run on its own —
        point it at a path with <code>--outdir</code>:
      </p>
      <Code lang="bash" noHead>{`pnpm bundle --outdir /opt/cast    # also: --name <pm2-name>  --port <port>`}</Code>
      <p style={proseP}>
        The result needs nothing but Node to run: the bundled server, the web-fetch
        subprocess, a resolved <code>node_modules/</code>, the manuals, and a ready{' '}
        <code>ecosystem.config.cjs</code>. No <code>pnpm install</code>, no source
        tree, no package manager at the destination — copy the folder to a server and
        start it:
      </p>
      <Code lang="bash" noHead>{`cd /opt/cast
node index.js                 # or: pm2 start ecosystem.config.cjs`}</Code>

      <Callout kind="tip">
        The bundle folder holds <strong>code, not state</strong>. Your agents, config,
        and message history live in the data dir (<code>~/.cast/</code> by default) — a
        separate place. So you can delete and re-bundle <code>/opt/cast</code> on every
        update without touching a single agent. They're two independent axes: where
        Cast runs from, and where its data lives.
      </Callout>

      <p style={proseP}>
        One thing to know: the generated <code>ecosystem.config.cjs</code> points the
        data dir at <code>~/.cast/</code> regardless of where you bundled —{' '}
        <code>--outdir</code> moves the code, not the data. To relocate data too (a
        dedicated volume, say), set <code>CAST_AGENTS_DIR</code> and{' '}
        <code>CAST_CONFIG_DIR</code> — see{' '}
        <DocsLink href="/docs/advanced/runtime-options">Runtime options</DocsLink>.
      </p>

      <H3>pm2 — the recommended path</H3>
      <p style={proseP}>
        The <code>ecosystem.config.cjs</code> the bundle wrote is already wired with
        your data directories and port. From the bundle folder, start it and tell pm2
        to bring Cast back on boot:
      </p>
      <Code lang="bash" noHead>{`pm2 start ecosystem.config.cjs
pm2 logs cast          # tail the server log
pm2 save               # remember the process list
pm2 startup            # generate the boot script (run the line it prints)`}</Code>
      <p style={proseP}>
        Cast ships no other supervisor config and isn't opinionated about it. If you
        already run launchd, systemd, or docker with a restart policy, point it at the
        same bundle — the admin UI's "Restart Cast Server" button just sends the process{' '}
        <code>SIGTERM</code> and lets your supervisor bring it back.
      </p>

      <H3>Graceful shutdown</H3>
      <p style={proseP}>
        The first <code>SIGTERM</code> starts a graceful drain — Cast stops taking new
        work and lets open conversations finish, up to about a minute. A second{' '}
        <code>SIGTERM</code> cuts that to a couple of seconds; a third exits immediately.
        The thing to get right is your supervisor's stop timeout: if it follows{' '}
        <code>SIGTERM</code> with <code>SIGKILL</code> a second or two later (pm2's default
        is ~1.6s), it severs the drain and can orphan a running container. Give Cast room
        to finish.
      </p>

      <H2>Reach your agents from anywhere</H2>
      <p style={proseP}>
        To reach an agent while you're away, talk to it through a chat transport. Wire an
        agent up to Telegram or Slack and it answers from your phone or a web client, the
        same way anyone you've let in reaches it.
      </p>
      <p style={proseP}>
        The transport connects out to the messaging service on Cast's behalf, so the
        agent is reachable from anywhere while the server stays bound to localhost. Pick
        one in <DocsLink href="/docs/transports">Transports</DocsLink>, then{' '}
        <DocsLink href="/docs/use/access">let yourself in</DocsLink> on it, the same way
        anyone else gets in.
      </p>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/transports">Transports</DocsLink> — the channels your
          agents answer on: Telegram, Slack, and the local web client.
        </li>
        <li>
          <DocsLink href="/docs/use/access">Access</DocsLink> — granting yourself and
          others access on each transport.
        </li>
        <li>
          <DocsLink href="/docs/advanced/runtime-options">Runtime options</DocsLink> —
          every environment variable the server reads, including <code>CAST_PORT</code>{' '}
          and the container-runtime selector.
        </li>
        <li>
          <DocsLink href="/docs/advanced/backups">Backups &amp; data</DocsLink> — what
          lives on disk on the machine you're keeping alive, and how to back it up.
        </li>
      </ul>
    </DocsLayout>
  );
}
