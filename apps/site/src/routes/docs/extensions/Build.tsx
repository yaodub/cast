import {
  DocsLayout,
  H2,
  proseP,
  proseTable,
  proseTh,
  proseTd,
  monoTd,
  monoTdMuted,
} from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';

export function ExtensionsBuild() {
  return (
    <DocsLayout
      url="/docs/extensions/build"
      crumbs={['docs', 'plugins', 'extensions', 'creating an extension']}
      title="Creating an extension"
      lede="An extension is a standalone package that adds a capability to any agent — host-side code with a declared config, secrets, tools, lifecycle, and an admin hook. Build one when a capability is worth reusing across agents."
      toc={[
        { label: 'defineExtension' },
        { label: 'Config & secrets' },
        { label: 'ExtensionContext' },
        { label: 'Lifecycle' },
        { label: 'Tools & handle' },
        { label: 'Approval gates' },
        { label: 'promptSection' },
        { label: 'deliver & push' },
        { label: 'connect' },
        { label: 'Staging & storage' },
        { label: 'Package' },
        { label: 'Manual' },
        { label: 'Registering' },
        { label: 'Service API' },
      ]}
    >
      <H2>defineExtension</H2>
      <p style={proseP}>
        An extension is a value returned by <code>defineExtension()</code>. It declares its
        schemas and lifecycle; <code>create()</code> builds the per-agent instance that
        carries the tools.
      </p>
      <Code lang="ts" title="defineExtension">{`export const myExt = defineExtension({
  name: 'my-ext',
  configSchema: MyConfigSchema,
  secretsSchema: MySecretsSchema,
  create: (ctx) => new MyExtension(ctx),
  connect,  // optional admin hook
});`}</Code>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Field</th>
            <th style={proseTh}>Type</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>name</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>
              Registry key, and the <code>config/ext/&lt;name&gt;/</code> folder name.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>configSchema</td>
            <td style={monoTdMuted}>{'ZodType<TConfig>'}</td>
            <td style={proseTd}>Behavioral policy, merged from the blueprint and operator overrides.</td>
          </tr>
          <tr>
            <td style={monoTd}>secretsSchema</td>
            <td style={monoTdMuted}>{'ZodType<TSecrets>'}</td>
            <td style={proseTd}>
              Credentials, read from <code>config/ext/&lt;name&gt;/secrets.json</code>.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>onServerStart? · onServerStop?</td>
            <td style={monoTdMuted}>{'(log) => Promise<void>'}</td>
            <td style={proseTd}>Server-level shared resources (e.g. a subprocess pool). Run once.</td>
          </tr>
          <tr>
            <td style={monoTd}>create</td>
            <td style={monoTdMuted}>{'(ctx) => ExtensionInstance'}</td>
            <td style={proseTd}>
              Build one instance per agent that enables the extension. The instance carries{' '}
              <code>tools</code>, <code>handle</code>, an optional <code>promptSection</code>,
              and <code>onAgentStart</code>/<code>onAgentStop</code>.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>connect?</td>
            <td style={monoTdMuted}>{'(ctx) => Promise<Result>'}</td>
            <td style={proseTd}>Admin credential check and resource discovery — see below.</td>
          </tr>
        </tbody>
      </table>

      <H2>Config &amp; secrets</H2>
      <p style={proseP}>
        Two schemas, two files. <code>configSchema</code> validates behavioral policy;{' '}
        <code>secretsSchema</code> validates credentials. The operator's values land in{' '}
        <code>config/ext/&lt;name&gt;/config.json</code> and{' '}
        <code>config/ext/&lt;name&gt;/secrets.json</code>; the blueprint author declares the
        defaults in <code>capabilities.json</code>. See{' '}
        <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink> for the
        operator's-eye view of those files.
      </p>
      <Callout kind="jargon">
        <strong>Locked by default.</strong> A bare value the author sets in{' '}
        <code>capabilities.json</code> is fixed — the operator can't override it. Wrap it as{' '}
        <code>{'{ unlocked: true, value }'}</code> to let the operator change it in{' '}
        <code>config.json</code>. The framework strips <code>enabled</code> and{' '}
        <code>channel</code> before your schema sees the config.
      </Callout>

      <H2>ExtensionContext</H2>
      <p style={proseP}>
        <code>create(ctx)</code> receives the context — the validated config and secrets,
        plus the surfaces an extension is allowed to reach for:
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Member</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>config · secrets</td>
            <td style={proseTd}>Merged, validated config and credentials.</td>
          </tr>
          <tr>
            <td style={monoTd}>privateDir</td>
            <td style={proseTd}>
              <code>ext/&lt;name&gt;/</code> — persistent extension state, never mounted into
              the container.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>sharedDir</td>
            <td style={proseTd}>
              <code>shared/ext/&lt;name&gt;/</code> — mounted read-only at{' '}
              <code>/shared/&lt;name&gt;</code> for the agent.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>hasChannel</td>
            <td style={proseTd}>Whether the agent paired a dedicated channel for push.</td>
          </tr>
          <tr>
            <td style={monoTd}>{'deliver(text, opts?)'}</td>
            <td style={proseTd}>Push a message into the agent (see deliver &amp; push).</td>
          </tr>
          <tr>
            <td style={monoTd}>log</td>
            <td style={proseTd}>Structured logger scoped to the extension.</td>
          </tr>
        </tbody>
      </table>

      <H2>Lifecycle</H2>
      <p style={proseP}>An extension runs at three scopes:</p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Scope</th>
            <th style={proseTh}>Hooks</th>
            <th style={proseTh}>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}>Server</td>
            <td style={monoTd}>onServerStart · onServerStop</td>
            <td style={proseTd}>Once, around server start/stop — shared resources.</td>
          </tr>
          <tr>
            <td style={proseTd}>Agent</td>
            <td style={monoTd}>create → onAgentStart → onAgentStop</td>
            <td style={proseTd}>Per agent that enables it, at load and shutdown.</td>
          </tr>
          <tr>
            <td style={proseTd}>Call</td>
            <td style={monoTd}>handle</td>
            <td style={proseTd}>Every tool call.</td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        Editing <code>capabilities.json</code> reloads the agent's extensions; editing a
        single <code>config/ext/&lt;name&gt;/</code> file reloads just that one.
      </p>

      <H2>Tools &amp; handle</H2>
      <p style={proseP}>
        Each tool is a <code>ToolDefinition</code>; <code>handle</code> dispatches every
        call. The tool layer is your policy boundary — parse the args, enforce scope, and
        return a result.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Field</th>
            <th style={proseTh}>Type</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>name</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>
              The MCP tool name, by convention <code>{'{ext}__{action}'}</code>.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>description</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>What the tool does — the agent reads this.</td>
          </tr>
          <tr>
            <td style={monoTd}>schema</td>
            <td style={monoTdMuted}>{'Record<string, ZodTypeAny>'}</td>
            <td style={proseTd}>Zod schemas for the tool's parameters.</td>
          </tr>
          <tr>
            <td style={monoTd}>approval?</td>
            <td style={monoTdMuted}>object</td>
            <td style={proseTd}>Optional human-approval gate — see below.</td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        <code>handle(toolName, args, call)</code> is single dispatch by tool name. Use{' '}
        <code>call</code> for the per-conversation staging dirs, and return{' '}
        <code>textResult(...)</code>.
      </p>

      <H2>Approval gates</H2>
      <p style={proseP}>
        A tool can require human approval before it runs. The agent calls it as usual; the
        participant gets an interactive prompt and the outcome arrives as a follow-up.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Field</th>
            <th style={proseTh}>Type</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>enabled</td>
            <td style={monoTdMuted}>boolean</td>
            <td style={proseTd}>Whether this call needs approval (resolved from config).</td>
          </tr>
          <tr>
            <td style={monoTd}>expiry?</td>
            <td style={monoTdMuted}>number</td>
            <td style={proseTd}>Seconds an approval stays valid (default 3600).</td>
          </tr>
          <tr>
            <td style={monoTd}>preview</td>
            <td style={monoTdMuted}>{'(args) => Preview'}</td>
            <td style={proseTd}>Builds the human-facing summary and optional detail.</td>
          </tr>
          <tr>
            <td style={monoTd}>filter?</td>
            <td style={monoTdMuted}>{"(args, ctx) => 'approve' | 'skip' | 'block'"}</td>
            <td style={proseTd}>
              Per-call decision. <code>ctx.wasApproved(...)</code> lets a call inherit trust
              from an earlier approval in the same conversation.
            </td>
          </tr>
        </tbody>
      </table>

      <H2>promptSection</H2>
      <p style={proseP}>
        An instance may contribute a <code>promptSection</code> — a string injected into the
        agent's <DocsLink href="/docs/runtime/context">system prompt</DocsLink> every turn. Keep it short, and condition it on the config and{' '}
        <code>hasChannel</code> (for example, drop the subscription guidance when the agent
        has no channel to push to).
      </p>

      <H2>deliver &amp; push</H2>
      <p style={proseP}>
        <code>ctx.deliver(text, {'{ replyTo? }'})</code> pushes a message into the agent —
        routed to the paired channel when one is configured — and returns the agent's first
        response. This is how a subscription or watch wakes the agent when something happens,
        rather than waiting to be asked.
      </p>

      <H2>connect</H2>
      <p style={proseP}>
        The optional <code>connect</code> hook powers the dashboard's Connect button: it
        validates the credentials and discovers what's reachable — folders, calendars, chats
        — in one call. Return the inventory in <code>state</code>, parsed through a Zod
        schema you export, so the admin UI can render it. An extension with no credentials to
        check (web-fetch) simply omits it.
      </p>
      <Code lang="ts" title="connect">{`async function connect({ secrets }) {
  const folders = await probe(secrets);   // verify creds + discover
  return { ok: true, message: 'Connected.', state: { folders } };
}`}</Code>

      <H2>Staging &amp; storage</H2>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Where</th>
            <th style={proseTh}>Role</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>call.stagingDir</td>
            <td style={proseTd}>
              Files the extension writes for the agent to <code>Read</code> — per
              conversation, cleared when it ends.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>call.stagingOutDir</td>
            <td style={proseTd}>Files the agent writes for the extension to pick up.</td>
          </tr>
          <tr>
            <td style={monoTd}>privateDir</td>
            <td style={proseTd}>Persistent extension state; never mounted.</td>
          </tr>
          <tr>
            <td style={monoTd}>sharedDir</td>
            <td style={proseTd}>
              Read-only mount the agent sees at <code>/shared/&lt;name&gt;</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <H2>Package</H2>
      <p style={proseP}>
        An extension is a self-contained package under{' '}
        <code>packages/ext-&lt;name&gt;/</code> — its own code, schemas, and a manual — so it
        can be reasoned about and shipped on its own.
      </p>
      <Code lang="bash" noHead>{`packages/ext-my-ext/
  package.json        # @getcast/ext-my-ext
  src/index.ts        # the defineExtension() export
  manual/README.md    # mechanical reference (required)
  manual/SKILL.md     # behavioral skill (standard)`}</Code>
      <p style={proseP}>
        <code>src/index.ts</code> exports the <code>defineExtension()</code> result. The
        package peer-depends on <code>@getcast/extension-schema</code> and <code>zod</code> —
        the portable contract, free of server internals — with any protocol clients or
        parsers as direct dependencies.
      </p>

      <H2>Manual</H2>
      <p style={proseP}>
        The manual is how the extension explains itself to the rest of Cast — the reference
        each surface reads instead of its source. It's two files: <code>README.md</code>{' '}
        (required) carries the mechanical contract, and <code>SKILL.md</code> (standard) is
        behavioral guidance an author weaves into a blueprint when the agent picks up the
        extension.
      </p>
      <p style={proseP}>
        <code>README.md</code> is organized into sections, each written for a different
        reader:
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Section</th>
            <th style={proseTh}>What it's for</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>USAGE</td>
            <td style={proseTd}>How the agent should use the tools.</td>
          </tr>
          <tr>
            <td style={monoTd}>CONFIG</td>
            <td style={proseTd}>The behavioral settings and what each controls.</td>
          </tr>
          <tr>
            <td style={monoTd}>SECRETS</td>
            <td style={proseTd}>The credentials the extension needs.</td>
          </tr>
          <tr>
            <td style={monoTd}>CHANNEL</td>
            <td style={proseTd}>Channel pairing and push behavior, when the extension has it.</td>
          </tr>
          <tr>
            <td style={monoTd}>STORAGE</td>
            <td style={proseTd}>Where the extension keeps its state.</td>
          </tr>
          <tr>
            <td style={monoTd}>SECURITY</td>
            <td style={proseTd}>Risk levels and how to compose a safe config.</td>
          </tr>
          <tr>
            <td style={monoTd}>ADMIN</td>
            <td style={proseTd}>The build spec for the extension's admin page.</td>
          </tr>
          <tr>
            <td style={monoTd}>SERVICE API</td>
            <td style={proseTd}>Public methods for using the extension from a service.</td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        <strong>ADMIN</strong> is worth singling out: it specifies the fields the dashboard
        shows, their input types and help text, how the <code>connect</code> hook's
        discovered resources are surfaced, and how credentials are validated — so the admin
        page is built from the manual rather than reverse-engineered from the code. Driving
        the admin UI is one of the manual's jobs, not the whole point.
      </p>

      <H2>Registering</H2>
      <p style={proseP}>
        Import the package into the server entry, register it, and enable it on an agent.
        Registration is fail-fast — a duplicate <code>name</code> throws at startup.
      </p>
      <Code lang="ts" noHead>{`// packages/cast/src/index.ts
import { registerExtension } from './extensions/registry.js';
import { myExt } from '@getcast/ext-my-ext';

registerExtension(myExt);

// blueprint/props/capabilities.json
{
  "extensions": {
    "my-ext": { "enabled": true, "channel": "inbox" }
  }
}`}</Code>

      <H2>Service API</H2>
      <p style={proseP}>
        An extension can also be driven directly from an{' '}
        <DocsLink href="/docs/build/services">agent service</DocsLink> rather than registered
        with the server — which is how a capability reaches one agent without changing the
        Cast runtime. To support that, expose public methods on the instance beyond the tool
        handlers, and document them in the manual's <strong>SERVICE API</strong> section.
        Those methods run below the approval gates that live in <code>handle</code>, so the
        calling service is the trusted party and applies its own policy. The using-side wiring
        is in <DocsLink href="/docs/extensions">Extensions</DocsLink>.
      </p>
    </DocsLayout>
  );
}
