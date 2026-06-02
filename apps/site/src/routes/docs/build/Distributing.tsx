import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';

export function BuildDistributing() {
  return (
    <DocsLayout
      url="/docs/build/distributing"
      crumbs={['docs', 'build agents', 'distributing blueprints']}
      title="Distributing blueprints"
      lede="A blueprint folder is portable — copy it, version it, hand it over. Cast doesn't prescribe a distribution mechanism; the folder is what travels. Whether it travels well comes down to how you authored it."
      toc={[
        { label: 'The portability boundary' },
        { label: 'Designing for portability' },
        { label: 'Using an existing blueprint' },
        { label: 'What to read next' },
      ]}
    >
      <H2>The portability boundary</H2>
      <p style={proseP}>
        The unit of distribution is <code>blueprint/</code> — identity, channels, props,
        service, assets. Everything that defines what the agent <em>is</em>. Drop that
        folder into another install's <code>agents/&lt;name&gt;/blueprint/</code> and the
        agent behaves the same. The full zone breakdown is on{' '}
        <DocsLink href="/docs/build/agent-folder">Agent folder anatomy</DocsLink>.
      </p>
      <p style={proseP}>Five zones stay behind, each for a different reason:</p>
      <ul style={proseUl}>
        <li>
          <code>config/</code> — model picks, ACL, extension overrides. Per-install
          decisions the author can't make.
        </li>
        <li>
          <code>secrets/</code> — the agent's keypair. Never mounted, never
          console-readable; per-install by definition.
        </li>
        <li>
          <code>state/</code> — the server's record of what happened on{' '}
          <em>your</em> install. Conversations, tasks, attachments, paired users.
        </li>
        <li>
          <code>memory/</code> and <code>home/</code> — what the agent wrote about its
          work with you. The recipient's agent has its own world to fill in.
        </li>
      </ul>
      <p style={proseP}>
        How the folder moves between installs is up to you. Push it to a git repo, zip
        it, hand it over on a thumb drive — anything that copies a directory works.
      </p>

      <H2>Designing for portability</H2>
      <p style={proseP}>
        The discipline boils down to one rule: the blueprint describes what the agent{' '}
        <em>is</em>, without carrying traces of your install with it. A few practices
        make that concrete.
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Don't couple to your machine.</strong> Hardcoded host paths in
          identity files (<code>/Users/&lt;you&gt;/notes</code>) won't resolve on the
          recipient's. Use the agent's mounted zones (<code>/memory/</code>,{' '}
          <code>/home/agent/</code>) or declare a slot in{' '}
          <code>capabilities.json::resources</code> and let the recipient bind their
          own path.
        </li>
        <li>
          <strong>Don't carry your operator identity.</strong>{' '}
          <code>whoami.md</code> that names you, your timezone, or your
          operator-specific facts couples the agent to one person. Strip those out
          and let the recipient configure — or leave a templated slot and call it
          out in the README.
        </li>
        <li>
          <strong>Don't bake credentials.</strong> Credentials belong in operator-managed
          files under <code>config/ext/&lt;name&gt;/</code>, never in{' '}
          <code>blueprint/</code>. Anything resembling a credential in the blueprint
          is a bug.
        </li>
        <li>
          <strong>Declare what you need.</strong> If the agent needs a folder,
          declare a <code>resources</code> slot rather than hardcoding a path. If
          the service needs an OAuth token, declare it as a key in the expected{' '}
          <code>.env</code> rather than embedding one. Declarations let the
          recipient wire correctly; assumed defaults break silently.
        </li>
        <li>
          <strong>Use locked-vs-unlocked deliberately.</strong> The pattern in{' '}
          <code>capabilities.json</code> (see{' '}
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink>)
          decides what the recipient can change. Lock identity and safety; unlock
          anything that legitimately varies per install. Lock something they
          actually need to change and no install completes.
        </li>
        <li>
          <strong>Write the install README.</strong> The blueprint defines what
          the agent <em>is</em>; the README tells the recipient what they need to
          provide before it runs. Resource slot paths, extension and service
          credentials, MCP env, peer ACL pairs — each gets a line. Without it the
          recipient is reverse-engineering your blueprint to know what to fill in.
        </li>
        <li>
          <strong>Sweep runtime traces before shipping.</strong>{' '}
          <code>memory/</code> and <code>home/</code> are runtime zones — what the
          agent wrote about its work with you. If you didn't deliberately seed
          them, don't ship them.
        </li>
      </ul>
      <Callout kind="security">
        <code>memory/</code> and <code>home/</code> are where the agent kept notes on
        its work with you — names, decisions, anything worth remembering. Shipping
        them by accident leaks all of that to whoever installs the blueprint. The
        framework won't catch this for you.
      </Callout>

      <H2>Using an existing blueprint</H2>
      <p style={proseP}>
        On the receiving end, the flow is the same whether the blueprint came from a
        colleague, a git repo, or yourself on another machine.
      </p>
      <ol style={{ ...proseP, paddingLeft: 22, listStyle: 'decimal' }}>
        <li>
          <strong>Create a fresh agent on your install.</strong> Through the
          dashboard's Create button, with the name you want. The server generates an
          Ed25519 keypair under <code>secrets/</code>, seeds default config, and
          registers the agent in draft.
        </li>
        <li>
          <strong>Replace <code>blueprint/</code> with the shipped folder.</strong>{' '}
          Your keypair, your config, and any seeded runtime stay yours; the new
          blueprint takes over identity, channels, and capabilities.
        </li>
        <li>
          <strong>Fill in <code>config/</code> per the shipped README.</strong>{' '}
          Model and timezone in <code>agent.json</code>; resource slot paths in{' '}
          <code>provisions.json</code>; extension credentials under{' '}
          <code>config/ext/&lt;name&gt;/</code>; service credentials in{' '}
          <code>config/ext/service/.env</code>; external MCP env in{' '}
          <code>mcp-servers.json</code>. See{' '}
          <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink>{' '}
          for the field-level reference.
        </li>
        <li>
          <strong>Wire any peer ACLs.</strong> If the blueprint declares peer agents
          in <code>peers.md</code>, the cross-agent edge needs a grant in{' '}
          <code>config/acl.json</code> on both sides. See{' '}
          <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>.
        </li>
        <li>
          <strong>Promote the agent from draft.</strong> Through the Review console
          for the recommended path; through Settings → Lifecycle to skip review on a
          throwaway agent.
        </li>
        <li>
          <strong>Pair the humans who'll talk to it.</strong> Send{' '}
          <code>/pair</code> from each transport you want the agent reachable on;
          see <DocsLink href="/docs/use/pairing">Pairing</DocsLink>.
        </li>
      </ol>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/agent-folder">Agent folder anatomy</DocsLink> —
          the full zone breakdown, including what the container actually sees.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> —
          the locked-vs-unlocked pattern in detail, and every other field in{' '}
          <code>blueprint/</code>.
        </li>
        <li>
          <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink> —
          the operator-side companion: what the recipient fills in after the
          folder lands.
        </li>
      </ul>
    </DocsLayout>
  );
}
