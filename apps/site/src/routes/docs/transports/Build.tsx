import {
  DocsLayout,
  H2,
  proseP,
  proseUl,
  proseTable,
  proseTh,
  proseTd,
  monoTd,
  monoTdMuted,
} from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Code } from '../../../components/ui/Code';

export function TransportsBuild() {
  return (
    <DocsLayout
      url="/docs/transports/build"
      crumbs={['docs', 'plugins', 'transports', 'creating a transport']}
      title="Creating a transport"
      lede="A transport wraps an external messaging system — Telegram, Slack, a custom bridge — and translates between its native message shape and Cast's packet model."
      toc={[
        { label: 'defineTransport' },
        { label: 'Config schema & routes.json' },
        { label: 'TransportContext' },
        { label: 'Transport' },
        { label: 'Inbound: native → packet' },
        { label: 'Outbound: packet → native' },
        { label: 'Events & approvals' },
        { label: 'TransportAdminDescriptor' },
        { label: 'Registering' },
      ]}
    >
      <H2>defineTransport</H2>
      <p style={proseP}>
        A transport is a value returned by <code>defineTransport()</code>. The factory
        returns your runtime instance, or <code>null</code> if no routes resolved to an
        agent.
      </p>
      <Code lang="ts" title="defineTransport">{`export const discord = defineTransport<DiscordConfig>({
  name: 'discord',
  addressPrefix: 'dc',
  configSchema: DiscordConfigSchema,
  admin: { /* form metadata, see below */ },
  create: (ctx, config) => new DiscordTransport(ctx, config),
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
              Unique registry key, and the <code>routes.json</code> key your slice lives
              under.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>addressPrefix</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>
              Participant-address namespace you own (Telegram <code>tg</code>, Slack{' '}
              <code>slack</code>). Often differs from <code>name</code>, and can't collide
              with another transport or one of the reserved system prefixes: <code>u</code>,{' '}
              <code>a</code>, <code>ext</code>, <code>cast</code>, <code>local</code>,{' '}
              <code>cli</code>, <code>web</code>, <code>admin</code>, <code>console</code>.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>configSchema</td>
            <td style={monoTdMuted}>ZodType&lt;TConfig&gt;</td>
            <td style={proseTd}>
              Validates your <code>routes.json</code> slice — typically an array of entries.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>create</td>
            <td style={monoTdMuted}>(ctx, config) =&gt; Transport | null</td>
            <td style={proseTd}>
              Factory: resolve addresses, build your instance, return it (or{' '}
              <code>null</code>).
            </td>
          </tr>
          <tr>
            <td style={monoTd}>admin</td>
            <td style={monoTdMuted}>TransportAdminDescriptor</td>
            <td style={proseTd}>Metadata that renders your dashboard form, registry-driven.</td>
          </tr>
        </tbody>
      </table>

      <H2>Config schema &amp; routes.json</H2>
      <p style={proseP}>
        <code>configSchema</code> validates the array under your transport's key in{' '}
        <code>routes.json</code>. Each entry carries an <code>address</code> (the agent it
        binds to) plus whatever credentials and options your transport needs —{' '}
        <strong>there is no separate secrets schema</strong>, credentials are fields in the
        same entry. In <code>create()</code>, canonicalize each <code>address</code> through{' '}
        <code>ctx.resolveAddress()</code>, skip entries that don't resolve, and return{' '}
        <code>null</code> if none do.
      </p>

      <H2>TransportContext</H2>
      <p style={proseP}>
        <code>ctx</code> — the first argument to your <code>create(ctx, config)</code>{' '}
        factory, above — gives your transport a small, fixed set of server capabilities to
        call:
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
            <td style={monoTd}>ingestInbound(from, to, text, senderName, routing?, attachments?)</td>
            <td style={proseTd}>
              Forward an inbound message into the gateway — runs identity, system commands,
              dispatch.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>ingestApprovalResponse(from, to, response)</td>
            <td style={proseTd}>Forward an approve/reject for an outstanding prompt.</td>
          </tr>
          <tr>
            <td style={monoTd}>resolveAddress(address)</td>
            <td style={proseTd}>
              Canonicalize a route's <code>address</code> label to a bus address.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>listSystemCommands()</td>
            <td style={proseTd}>
              The server's <code>/</code> commands (Telegram publishes these as its menu).
            </td>
          </tr>
          <tr>
            <td style={monoTd}>log</td>
            <td style={proseTd}>Pino-compatible child logger scoped to your transport.</td>
          </tr>
        </tbody>
      </table>

      <H2>Transport</H2>
      <p style={proseP}>The instance your factory returns implements this interface.</p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Member</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>connect() · disconnect() · isConnected()</td>
            <td style={proseTd}>Establish and tear down the inbound channel.</td>
          </tr>
          <tr>
            <td style={monoTd}>send(pkt, ctx)</td>
            <td style={proseTd}>Deliver an outbound packet to a participant.</td>
          </tr>
          <tr>
            <td style={monoTd}>sendEvent(evt)</td>
            <td style={proseTd}>
              Render an ephemeral event (typing, lifecycle); ignore unsupported ones.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>ownsParticipant(address)</td>
            <td style={proseTd}>
              Whether an address belongs to you — the gateway uses it to route outbound
              packets.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>deferredAck?</td>
            <td style={proseTd}>
              Set when <code>send()</code> succeeding doesn't imply durable receipt
              (cache-like clients); the gateway then waits for the transport to mark
              delivery.
            </td>
          </tr>
        </tbody>
      </table>

      <H2>Inbound: native → packet</H2>
      <p style={proseP}>
        When a native message arrives, extract the sender and target, download any
        attachments (gate on the max attachment size), and call{' '}
        <code>ctx.ingestInbound(...)</code>. Bursty sources benefit from a short debounce
        that merges rapid messages into one turn — Telegram coalesces at one second, Slack
        at 800ms.
      </p>

      <H2>Outbound: packet → native</H2>
      <p style={proseP}>
        <code>send()</code> is called once per outbound packet. Render each deliverable type
        into your native API.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Packet</th>
            <th style={proseTh}>Handling</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>conversation</td>
            <td style={proseTd}>A durable message — render it in your native API.</td>
          </tr>
          <tr>
            <td style={monoTd}>approval_request</td>
            <td style={proseTd}>
              Render an approve/reject affordance carrying the agent address and approval id.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>approval_ack</td>
            <td style={proseTd}>Settle the original approval message.</td>
          </tr>
          <tr>
            <td style={monoTd}>preview</td>
            <td style={proseTd}>An incremental streaming frame — drives edit-in-place (see below).</td>
          </tr>
          <tr>
            <td style={monoTd}>delegate</td>
            <td style={proseTd}>Never reaches a transport — bus-internal.</td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        Streaming output rides the same <code>send()</code> path — no extra method. The
        agent's response arrives as a run of <code>preview</code> packets, and you assemble a
        live, edit-in-place message by correlating them with the final durable{' '}
        <code>conversation</code> packet on a shared <code>streamId</code>:
      </p>
      <ol style={proseUl}>
        <li>
          First <code>preview</code> frame for a new <code>streamId</code> — post a message
          and remember its id against that <code>streamId</code>.
        </li>
        <li>
          Later frames with the same <code>streamId</code> — edit that message in place with
          the new text.
        </li>
        <li>
          The <code>conversation</code> packet arrives carrying the same{' '}
          <code>streamId</code> — fold its final text into the same message (one last edit)
          instead of posting fresh, and forget the <code>streamId</code>.
        </li>
      </ol>
      <p style={proseP}>
        If the route sets <code>streaming: false</code>, drop preview frames at the gate; the{' '}
        <code>conversation</code> packet then posts a single sealed message on its own. Since
        previews are never persisted, dropping them is always safe.
      </p>

      <H2>Events &amp; approvals</H2>
      <p style={proseP}>
        <code>sendEvent(evt)</code> delivers ephemeral signals — typing, lifecycle notices.
        Render the variants your medium supports and drop the rest; a common pattern gates
        lifecycle messages on whether the user was recently active, so a cold channel doesn't
        get "waking up…" noise.
      </p>
      <p style={proseP}>
        Approvals are a round trip: an <code>approval_request</code> arrives via{' '}
        <code>send()</code>, the user taps approve/reject, you call{' '}
        <code>ctx.ingestApprovalResponse(...)</code>, and an <code>approval_ack</code> comes
        back so you can settle the original message.
      </p>

      <H2>TransportAdminDescriptor</H2>
      <p style={proseP}>
        The admin page is registry-driven: declare this descriptor and your form renders with
        no edits to the admin router or web UI.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Property</th>
            <th style={proseTh}>Type</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>displayLabel</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>Label shown in the dashboard.</td>
          </tr>
          <tr>
            <td style={monoTd}>fields</td>
            <td style={monoTdMuted}>AdminField[]</td>
            <td style={proseTd}>The form inputs (below).</td>
          </tr>
          <tr>
            <td style={monoTd}>summarize</td>
            <td style={monoTdMuted}>(entry) =&gt; string</td>
            <td style={proseTd}>Projects one entry into the table's details column.</td>
          </tr>
          <tr>
            <td style={monoTd}>setupInstructions?</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>
              Markdown shown in a "how to get these credentials" disclosure.
            </td>
          </tr>
        </tbody>
      </table>
      <p style={proseP}>
        Each <code>AdminField</code>:
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Property</th>
            <th style={proseTh}>Type</th>
            <th style={proseTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>key</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>Form field key.</td>
          </tr>
          <tr>
            <td style={monoTd}>type</td>
            <td style={monoTdMuted}>'text' | 'password' | 'number'</td>
            <td style={proseTd}>Input type.</td>
          </tr>
          <tr>
            <td style={monoTd}>label</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>Field label.</td>
          </tr>
          <tr>
            <td style={monoTd}>secret?</td>
            <td style={monoTdMuted}>boolean</td>
            <td style={proseTd}>
              Mask on read; resolve the mask against the on-disk value on write.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>optional?</td>
            <td style={monoTdMuted}>boolean</td>
            <td style={proseTd}>Field may be left blank.</td>
          </tr>
          <tr>
            <td style={monoTd}>group?</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>Visual grouping in the form.</td>
          </tr>
          <tr>
            <td style={monoTd}>path?</td>
            <td style={monoTdMuted}>string</td>
            <td style={proseTd}>
              Dotted path for nested config (e.g. <code>imap.host</code>).
            </td>
          </tr>
        </tbody>
      </table>

      <H2>Registering</H2>
      <p style={proseP}>Three steps wire a new transport — say a Discord bridge — into the server:</p>
      <ol style={proseUl}>
        <li>
          Define it in <code>packages/cast/src/transports/discord.ts</code>, exporting a{' '}
          <code>defineTransport()</code> value.
        </li>
        <li>
          Import it into the server entry and call <code>registerTransport()</code>.
        </li>
        <li>
          Add a <code>discord</code> slice to <code>routes.json</code> with an entry per
          agent.
        </li>
      </ol>
      <Code lang="ts" noHead>{`// packages/cast/src/index.ts
import { registerTransport } from './transports/registry.js';
import { discord } from './transports/discord.js';

registerTransport(discord);

// routes.json
{
  "discord": [
    {
      "address": "assistant",
      "botToken": "..."
    }
  ]
}`}</Code>
      <p style={proseP}>
        Registration is fail-fast — a duplicate <code>name</code> or a reserved or colliding{' '}
        <code>addressPrefix</code> throws before the server starts. Once registered, your
        transport loads from <code>routes.json</code> automatically and participates in
        hot-reload like the bundled ones. See{' '}
        <DocsLink href="/docs/transports">Transports</DocsLink> for the operator-facing config
        model.
      </p>
    </DocsLayout>
  );
}
