import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { ConversationsFigure } from '../../../components/docs/ConversationsFigure';

export function ConceptsConversations() {
  return (
    <DocsLayout
      url="/docs/concepts/conversations"
      crumbs={['docs', 'concepts', 'conversations']}
      title="Conversations"
      lede="Talking to an agent should feel like one continuous conversation. Underneath it's many — Cast reconciles memory across them to keep the experience whole."
      toc={[
        { label: 'One agent, many conversations' },
        { label: 'How reconciliation works' },
        { label: 'Container and isolation' },
        { label: 'Other shapes a conversation can take' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Talking to an agent should feel like talking to someone who remembers you — you
        speak, it remembers. The LLM behind the agent has no memory across context
        windows. To deliver that experience, you need to reconcile context across
        sessions.
      </p>

      <H2>One agent, many conversations</H2>
      <p style={proseP}>
        A Cast agent often runs many conversations at once. Each one belongs to a
        counterparty — a specific person, or a specific peer agent. When Alice and Bob
        both message the same agent, the agent runs two separate conversations, with
        two separate histories and two separate context windows. Alice and Bob don't
        see each other.
      </p>
      <p style={proseP}>
        Cast routes each inbound turn to the right conversation. The human doesn't
        choose — they just talk to the agent. They see one continuous stream; the agent
        sees a specific conversation with a specific counterparty.
      </p>

      <ConversationsFigure caption="Conversations before and after memory reconciliation" />

      <p style={proseP}>
        Cast's answer to the reconciliation problem is bounded conversations with
        explicit memory reconciliation. Each conversation has a start, runs some turns,
        and ends. On opening, it reads from memory; on close, it distills the
        conversation back into shared memory. Memory is the shared substrate that lets
        otherwise-isolated conversations bridge across users, surfaces, and time.
      </p>

      <H2>How reconciliation works</H2>
      <p style={proseP}>
        Cast doesn't prescribe how to reconcile memory. It provides three primitives;
        the author composes them into whatever shape fits the agent.
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Bootstrap</strong> — runs at the start of a new conversation, before
          any user turn. The author writes the script; the framework injects its
          output as opening context.
        </li>
        <li>
          <strong>Cleanup</strong> — runs at the close. The author writes the script;
          the framework swallows its output. Whatever cleanup writes to{' '}
          <code>/memory/</code> persists for next time, and summaries written to a
          specific slot auto-inject into future conversations with the same
          counterparty.
        </li>
        <li>
          <strong>Cross-conversation push</strong> — a tool the agent can call mid-turn
          to drop a message into another ongoing conversation under the same agent.
          For handoffs, notifications, status broadcasts.
        </li>
      </ul>
      <p style={proseP}>
        Bootstrap and cleanup can be used for other things too — reflection, alerts,
        post-processing, whatever the author wants to run at those boundaries.
      </p>

      <H2>Container and isolation</H2>
      <p style={proseP}>
        Each conversation runs in its own container while it's open. The container
        reads and writes the agent's filesystem — memory, attachments, working storage
        — and exposes the agent's tools through its own private socket. When the
        conversation closes, the container exits.
      </p>
      <p style={proseP}>
        Two conversations on the same agent run in two different containers. They
        share the agent's files on disk, but their processes run independently.
        Neither sees the other's prompt, context, or history.
      </p>

      <H2>Other shapes a conversation can take</H2>
      <p style={proseP}>
        Conversations can also:
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Close after a single turn</strong> — every inbound turn opens a
          fresh conversation, the agent responds once, and it closes. Nothing carries
          between calls. Useful for untrusted input, peer query/answer exchanges,
          audit-style edges.
        </li>
        <li>
          <strong>Run on a different model</strong> than the agent's default — a
          cheaper model for cleanup-time summarization, or a sharper one for a
          high-stakes question path.
        </li>
        <li>
          <strong>Expose a subset of the agent's tools</strong> — narrowing what the
          agent can do on this conversation.
        </li>
        <li>
          <strong>Not persist history</strong> — useful for high-volume notification
          flows, or for conversations you don't want the agent reading back after the
          fact.
        </li>
        <li>
          <strong>Restrict who can send and who can receive</strong> — only certain
          counterparties allowed in either direction.
        </li>
      </ul>
      <p style={proseP}>
        Each is a variation on the same underlying conversation. An agent can run
        many of these in parallel — different counterparties on different shapes, all
        live at once.
      </p>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/concepts/channels">Channels</DocsLink> — where you
          configure each of the shapes above.
        </li>
        <li>
          <DocsLink href="/docs/concepts/multi-user">Conversation grid</DocsLink> — when
          several people share one agent, how each gets their own private conversation,
          laid out as a grid.
        </li>
        <li>
          <DocsLink href="/docs/concepts/triggers">Scheduling &amp; triggers</DocsLink>{' '}
          — what else can open a conversation, beyond a person sending a turn.
        </li>
      </ul>
    </DocsLayout>
  );
}
