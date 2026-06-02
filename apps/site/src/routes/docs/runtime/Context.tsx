import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { M } from '../../../components/docs/ToolDoc';

const monoFont = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

type Attr = { name: string; type: string; required?: boolean; desc: any };

function Example({ children }: { children: string }) {
  return (
    <div style={{
      fontFamily: monoFont,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb, var(--fg) 8%, transparent)',
      border: '1px solid color-mix(in srgb, var(--fg) 12%, transparent)',
      padding: '8px 12px',
      whiteSpace: 'pre',
      overflowX: 'auto',
      color: 'var(--fg)',
      marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

function AttrList({ attrs }: { attrs: Attr[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attrs.map(a => (
        <li key={a.name} style={{ fontSize: 13, lineHeight: 1.55 }}>
          {!a.required && <span style={{ color: 'var(--fg-subtle)' }}>optional </span>}
          <span class="mono" style={{
            background: 'color-mix(in srgb, var(--fg) 7%, transparent)',
            padding: '1px 6px',
            fontSize: 12,
          }}>{a.name}</span>
          <span style={{ color: 'var(--fg-subtle)', margin: '0 8px' }}>[{a.type}]</span>
          {a.desc}
        </li>
      ))}
    </ul>
  );
}

function SubSection({ title, note, children, first }: { title: any; note?: any; children: any; first?: boolean }) {
  return (
    <section style={{ marginTop: first ? 0 : 18 }}>
      <header style={{ marginBottom: 8 }}>
        <h4 class="mono" style={{
          fontSize: 14,
          fontWeight: 500,
          margin: 0,
          color: 'var(--fg)',
        }}>
          {title}
        </h4>
        {note && (
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontStyle: 'italic', marginTop: 3 }}>
            {note}
          </div>
        )}
      </header>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </section>
  );
}

const subTable = {
  fontSize: 12.5,
  borderCollapse: 'collapse' as const,
  width: '100%',
  marginBottom: 8,
};
const subTh = {
  textAlign: 'left' as const,
  fontWeight: 500,
  color: 'var(--fg-subtle)',
  borderBottom: '1px solid color-mix(in srgb, var(--fg) 15%, transparent)',
  padding: '4px 10px 4px 0',
  fontSize: 11,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};
const subTd = {
  padding: '5px 10px 5px 0',
  borderBottom: '1px solid color-mix(in srgb, var(--fg) 7%, transparent)',
  verticalAlign: 'top' as const,
};
const subTdMono = { ...subTd, fontFamily: monoFont, fontSize: 12, whiteSpace: 'nowrap' as const };

type Layer = {
  num: string;
  tag: string;
  tagNote?: string;
  source?: string;
  sourceMono?: boolean;
  conditional?: string;
  desc: any;
  children?: any;
};

const PROMPT_LAYERS: Layer[] = [
  {
    num: '1',
    tag: '<cast-protocol>',
    source: 'server-generated',
    desc: 'Server-side runtime contract — what is mounted, what is reachable, what extensions have contributed. Composed by the prompt assembler from operator config and active extensions.',
    children: (
      <>
        <SubSection title="Directory layout" first>
          <table style={subTable}>
            <thead>
              <tr>
                <th style={subTh}>Path</th>
                <th style={subTh}>Purpose</th>
                <th style={subTh}>Access</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={subTdMono}>/home/agent</td><td style={subTd}>Working directory (CWD)</td><td style={subTd}>read-write</td></tr>
              <tr><td style={subTdMono}>/identity</td><td style={subTd}>Identity files (whoami, skills)</td><td style={subTd}>read-only</td></tr>
              <tr><td style={subTdMono}>/memory</td><td style={subTd}>Persistent memory across runs</td><td style={subTd}>read-write</td></tr>
              <tr><td style={subTdMono}>/assets</td><td style={subTd}>Static reference data</td><td style={subTd}>read-only</td></tr>
              <tr><td style={subTdMono}>/shared</td><td style={subTd}>Service-written agent context</td><td style={subTd}>read-only</td></tr>
              <tr><td style={subTdMono}>/attachments</td><td style={subTd}>Received and sent files</td><td style={subTd}>read-only</td></tr>
              <tr><td style={subTdMono}>/staging/in</td><td style={subTd}>Inbound files dropped by extensions and services for the agent to Read</td><td style={subTd}>read-write</td></tr>
              <tr><td style={subTdMono}>/staging/out</td><td style={subTd}>Write files here to send them back</td><td style={subTd}>read-write</td></tr>
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            Operator-configured resource mounts (<M>/resources/&lt;name&gt;</M>) append rows when present.
          </div>
        </SubSection>

        <SubSection title="Network mode" note={<>set in <M>config/agent.json</M></>}>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 6, margin: 0 }}>
            <dt class="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>none</dt>
            <dd style={{ margin: 0, fontSize: 13 }}>no network access; all operations local</dd>
            <dt class="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>sdk-only</dt>
            <dd style={{ margin: 0, fontSize: 13 }}>only Anthropic API endpoints reachable; agent is told to use WebSearch rather than curl/wget</dd>
            <dt class="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>full</dt>
            <dd style={{ margin: 0, fontSize: 13 }}>unrestricted egress (operator-set)</dd>
          </dl>
        </SubSection>

        <SubSection title="Python packages" note="appended only when pip is enabled in the manifest">
          Tells the agent to use the <M>pip__install</M> tool — there is no system pip in the container. Packages install to <M>/home/agent/.python-packages/</M> and persist across conversations; <M>PYTHONPATH</M> is preconfigured.
        </SubSection>

        <SubSection title="Extension prompt sections" note="one block per active extension, appended in load order">
          Each active extension appends its own block — see <DocsLink href="/docs/extensions">Extensions</DocsLink> for what each one carries.
        </SubSection>
      </>
    ),
  },
  { num: '2',   tag: '<agent-profile>',         source: 'profile.prompt',       sourceMono: true, desc: 'Filesystem conventions and behavior baseline from the chosen profile.' },
  { num: '3',   tag: '<agent-profile-skills>',  source: 'profile.skills',       sourceMono: true, desc: "Profile-level skills — e.g. the standard profile's framework-tag handling." },
  { num: '4',   tag: 'blueprint/identity/prompt.md', tagNote: 'no wrapping tag', desc: "Persona and core behavior — the agent's “who I am” text." },
  { num: '5',   tag: '<agent-identity>',        source: 'blueprint/identity/whoami.md', sourceMono: true, desc: 'Structured identity facts (name, role, owner).' },
  { num: '6',   tag: '<agent-peers>',           source: 'blueprint/identity/peers.md',  sourceMono: true, desc: 'Author-supplied peer relationships, alongside the live agent__list_peers tool.' },
  { num: '7',   tag: '<agent-skills>',          source: 'blueprint/identity/skills.md', sourceMono: true, desc: 'Domain-specific guidance the agent should carry across all conversations.' },
  { num: '7.5', tag: '<channel-contract>',      source: 'server-derived from ACL', conditional: 'inserted only when the channel enforces a fixed reply protocol', desc: "Required shape of the agent's reply on this channel — what its output must look like to be accepted." },
  { num: '8',   tag: '<channel-instructions>',  source: 'blueprint/channels/NAME/prompt.md', sourceMono: true, desc: 'Per-channel instructions — tone, scope, escalation rules.' },
  { num: '9',   tag: '<service-context>',       source: 'shared/ext/service/agent-context.md', sourceMono: true, desc: "Dynamic context injected by the agent's service process — custom code attached to this agent, free to write whatever the agent should know right now." },
  {
    num: '10',
    tag: '<conversation-context>',
    source: 'server-generated, per spawn',
    desc: "The agent's situational awareness for this turn. Reassembled when the conversation re-spawns (idle timeout, channel handoff); stable within a single conversation.",
    children: (
      <>
        <SubSection title="<participant>" first>
          <Example>{`<participant id="ID" handle="HANDLE" declared-name="NAME" />`}</Example>
          <div>Who's talking to the agent.</div>
          <AttrList attrs={[
            { name: 'id', type: 'string', required: true, desc: 'Stable identity address. Use for record-keeping and memory cross-referencing.' },
            { name: 'handle', type: 'string', desc: 'Transport-specific handle (e.g. Telegram username, email address). Present when known.' },
            { name: 'declared-name', type: 'string', desc: "User-chosen display name. Use in greetings; don't use as a stable key." },
          ]} />
        </SubSection>

        <SubSection title="<channel>">
          <Example>{`<channel name="NAME" />`}</Example>
          <div>Which channel this conversation is on. Sharded channels render with a qualifier appended via <M>~</M>.</div>
          <AttrList attrs={[
            { name: 'name', type: 'string', required: true, desc: <>Channel name as defined in <M>blueprint/channels/</M>. Sharded subdivisions append a qualifier with <M>~</M>.</> },
          ]} />
        </SubSection>

        <SubSection title="<agent>">
          <Example>{`<agent name="NAME" />`}</Example>
          <div>Which agent this is — useful when one Claude session might serve more than one identity.</div>
          <AttrList attrs={[
            { name: 'name', type: 'string', required: true, desc: "Agent's display name from the host registry." },
          ]} />
        </SubSection>

        <SubSection title="<time>">
          <Example>{`<time timezone="TIMEZONE">WEEKDAY ISO_TIMESTAMP</time>`}</Example>
          <div>Wall-clock time when the prompt was assembled, in the agent's timezone. The agent's clock does not advance during a conversation — use <M>time__now</M> to refresh.</div>
          <AttrList attrs={[
            { name: 'timezone', type: 'IANA timezone', required: true, desc: "Agent's configured timezone. Body is the current ISO timestamp with offset, prefixed by weekday." },
          ]} />
        </SubSection>

        <SubSection title="<previous-session>" note="one entry per prior session, newest first; stops at the first session with a written summary">
          <Example>{`<previous-session last-active="DURATION">SUMMARY</previous-session>

<previous-session last-active="DURATION" summary="unavailable" />

<previous-session first-time="true" />`}</Example>
          <AttrList attrs={[
            { name: 'last-active', type: 'string', desc: <>Rough <M>Nh ago</M> / <M>Nd ago</M> — when the previous session was last active.</> },
            { name: 'summary', type: 'string', desc: <>Set to <M>unavailable</M> if the session has no recorded summary.</> },
            { name: 'first-time', type: 'boolean', desc: <>Present (as <M>first-time="true"</M>) when this is the participant's first conversation with the agent.</> },
          ]} />
        </SubSection>

        <SubSection title="<other-participants>" note="capped list with ellipsis when more exist">
          <Example>{`<other-participants>NAME (DURATION ago), …</other-participants>

<other-participants visibility="disabled" />`}</Example>
          <div>Ambient awareness of who else is active on this channel. When the channel has <M>show_co_participants=false</M>, the element renders with <M>visibility="disabled"</M> so the agent reads “I can't see who else is here, by policy” rather than “I'm alone.”</div>
          <AttrList attrs={[
            { name: 'visibility', type: 'string', desc: <>Set to <M>disabled</M> when the channel's <M>show_co_participants</M> is false. Otherwise omitted.</> },
          ]} />
        </SubSection>
      </>
    ),
  },
];

function LayerCard({ layer }: { layer: Layer }) {
  return (
    <div style={{
      background: 'color-mix(in srgb, var(--fg) 4%, transparent)',
      border: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
      padding: '14px 18px',
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        <span class="mono" style={{ fontSize: 16, color: 'var(--fg)' }}>{layer.tag}</span>
        {layer.tagNote && (
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>· {layer.tagNote}</span>
        )}
      </div>
      {layer.source && (
        <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginBottom: 6 }}>
          from{' '}
          <span style={layer.sourceMono ? { fontFamily: monoFont } : undefined}>
            {layer.source}
          </span>
        </div>
      )}
      {layer.conditional && (
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontStyle: 'italic', marginBottom: 6 }}>
          {layer.conditional}
        </div>
      )}
      <div style={{ fontSize: 14, lineHeight: 1.55 }}>{layer.desc}</div>
      {layer.children && (
        <div style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
        }}>
          {layer.children}
        </div>
      )}
    </div>
  );
}

function LayerArrow() {
  return (
    <div aria-hidden="true" style={{
      textAlign: 'center',
      color: '#E63946',
      fontSize: 22,
      fontWeight: 600,
      lineHeight: 1,
      padding: '6px 0',
    }}>
      ↓
    </div>
  );
}

function ConversationTerminus() {
  return (
    <div class="mono" style={{
      textAlign: 'center',
      fontSize: 18,
      letterSpacing: '0.18em',
      color: 'color-mix(in srgb, var(--fg) 65%, transparent)',
      padding: '18px 0',
    }}>
      CONVERSATION BEGINS
    </div>
  );
}

export function ApiContext() {
  return (
    <DocsLayout
      url="/docs/runtime/context"
      crumbs={['docs', 'runtime', 'context']}
      title="Context"
      lede="Everything the agent reads — the system prompt assembled at conversation start, and the per-message decoration on every turn."
      toc={[
        { label: 'System prompt layers' },
        { label: 'Per-message decoration' },
      ]}
    >
      <p style={proseP}>
        Context arrives in two rhythms. The <strong>system prompt</strong>{' '}
        is assembled when the conversation spawns — ten layers stacked top-to-bottom,
        followed by the first user turn. The <strong>per-message decoration</strong>{' '}
        wraps each inbound turn after that — attachments, scheduler fires, peer
        pushes, and other framework stimulus.
      </p>

      <H2>System prompt layers</H2>
      <p style={proseP}>
        Assembled top-to-bottom when the conversation spawns. Conditional layers
        whose source is absent are skipped silently. Layers 1 and 10 are
        expanded inline to show what they contain.
      </p>
      <div>
        {PROMPT_LAYERS.map((layer, i) => (
          <div key={layer.num}>
            <LayerCard layer={layer} />
            {i < PROMPT_LAYERS.length - 1 && <LayerArrow />}
          </div>
        ))}
        <LayerArrow />
        <ConversationTerminus />
      </div>

      <H2>Per-message decoration</H2>
      <p style={proseP}>
        What gets added to a turn beyond its raw text. Regular user messages
        pass through verbatim — sender and timestamp metadata for the current
        conversation lives in the <M>&lt;conversation-context&gt;</M> envelope
        above, not per-turn. The decorations below only apply to turns that
        carry attachments, ingested archives, or non-user triggers.
      </p>
      <div style={{
        background: 'color-mix(in srgb, var(--fg) 4%, transparent)',
        border: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
        padding: '14px 18px',
      }}>
        <SubSection title="Attachment markers" first>
          <Example>{`[Attachment: LABEL | PATH | MIME_TYPE | SIZE_BYTES]`}</Example>
          <div>
            Inline marker prepended to inbound messages that carry files. The agent
            uses the path with the Read tool to view images/PDFs. All attachments are
            persisted to <M>/attachments</M> automatically.
          </div>
        </SubSection>

        <SubSection title="Ingested message wrapper" note="for messages delivered via cast:ingest, not live user turns">
          <Example>{`<message sender="NAME" time="ISO_TIMESTAMP">BODY</message>`}</Example>
          <div>
            Messages bulk-imported from an outside source (email backlog, chat export, etc.)
            are wrapped so the agent can tell apart who sent each one and when. Live user
            turns never get this wrapper.
          </div>
        </SubSection>

        <SubSection title="Inbound stimulus tags" note="cast:* — non-user triggers">
          <Example>{`<cast:schedule>BODY</cast:schedule>
<cast:service>BODY</cast:service>
<cast:lifecycle>BODY</cast:lifecycle>
<cast:watch path="GLOB" since="ISO_TIMESTAMP" through="ISO_TIMESTAMP">FILE_LIST</cast:watch>
<cast:push fromAgent="NAME" fromParticipant="ID" fromChannel="NAME">BODY</cast:push>
<cast:rejection request="ID">REASON</cast:rejection>`}</Example>
          <div>
            Non-user triggers arrive wrapped in one of these. Full attribute schemas
            and validation rules on <DocsLink href="/docs/runtime/wire-format">Runtime › Wire format</DocsLink>.
          </div>
        </SubSection>
      </div>
    </DocsLayout>
  );
}
