import { DocsLayout, H2, H3, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { ChatMockup } from '../../../components/site/ChatMockup';
import { ConversationGridFigure } from '../../../components/docs/ConversationGridFigure';
import { PeerDialogueFigure } from '../../../components/docs/PeerDialogueFigure';

// Colors key a cell to its chat panel — anchored to the conversation, not the
// person (so Alice's two channels are two different colors).
const TEAL = '#115E59'; // alice · default
const INDIGO = '#3730A3'; // bob · default
const PLUM = '#6D28D9'; // alice · focus
const GREEN = '#15803D'; // alice · default, on a second agent
const AMBER = '#B45309'; // bob · focus

const PEOPLE = ['Alice', 'Bob'];
const CHANNELS = ['default', 'focus'];

export function ConceptsMultiUser() {
  return (
    <DocsLayout
      url="/docs/concepts/multi-user"
      crumbs={['docs', 'concepts', 'conversation grid']}
      title="Conversation grid"
      lede="When friends, teammates, or family share an agent, each person talks to it privately."
      toc={[
        { label: 'Each person has their own cell' },
        { label: "The agent knows who it's talking to" },
        { label: 'Moving between cells' },
        { label: 'Meeting on shared ground' },
        { label: 'Across agents' },
        { label: 'What to read next' },
      ]}
    >
      <H2>Each person has their own cell</H2>
      <p style={proseP}>
        On any channel, every paired person has their own conversation with the agent. Each
        has its own short-term memory; all of them share the agent's one long-term memory. Lay
        them on a grid — a row per person, a column per channel — and each cell is one
        conversation.
      </p>

      <ConversationGridFigure
        rows={PEOPLE}
        cols={CHANNELS}
        pinned="[assistant]"
        cells={[
          { row: 0, col: 0, color: TEAL },
          { row: 1, col: 0, color: INDIGO },
        ]}
        caption="one agent, held fixed — each person, their own cell"
      />

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'alice', color: TEAL }}
        script={[
          { from: 'user', via: 'alice', text: "what's first on my list today?" },
          {
            from: 'agent',
            via: 'to alice',
            text: 'Finish the slide review before your 11am with marketing — you flagged it as the blocker last night.',
          },
        ]}
      />

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'bob', color: INDIGO }}
        script={[
          { from: 'user', via: 'bob', text: "what's first on my list today?" },
          {
            from: 'agent',
            via: 'to bob',
            text: 'The PR you opened last night has two review comments from Priya waiting on you.',
          },
        ]}
      />

      <Callout kind="jargon">
        <strong>Is this group chat?</strong> No. A group chat puts everyone in one room with
        one shared transcript. Here, each person has their own private conversation, and the
        agent is the only one who sees across them. To share anything between them, you use the
        moves below.
      </Callout>

      <H2>The agent knows who it's talking to</H2>
      <p style={proseP}>
        When it answers someone, the agent knows who's in front of it and uses their name. By
        default it also knows the other people on the channel — enough to coordinate across
        them without you wiring anything up. Turn that off per channel when people shouldn't
        know about each other, like a specialist with separate clients. See{' '}
        <DocsLink href="/docs/concepts/channels">Channels</DocsLink>.
      </p>

      <H2>Moving between cells</H2>
      <p style={proseP}>
        The agent in one cell can inject a message into a different cell — another person, or
        another channel.
      </p>

      <H3>To another person</H3>
      <p style={proseP}>
        The agent sends a message into another person's cell on the same channel. Good for
        handoffs, status broadcasts, and asking the right person.
      </p>

      <ConversationGridFigure
        rows={PEOPLE}
        cols={CHANNELS}
        pinned="[assistant]"
        cells={[
          { row: 0, col: 0, color: TEAL },
          { row: 1, col: 0, color: INDIGO },
        ]}
        arrow={{ from: { row: 0, col: 0 }, to: { row: 1, col: 0 } }}
        caption="down a column — same channel, another person"
      />

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'alice', color: TEAL }}
        script={[
          { from: 'user', via: 'alice', text: 'Looks good — ship it.' },
          {
            from: 'agent',
            via: 'to alice',
            text: "Approved. I'll let Bob know he's clear to push.",
          },
        ]}
      />

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'bob', color: INDIGO }}
        script={[
          {
            from: 'agent',
            via: 'to bob',
            time: 'moments later',
            text:
              "Heads up — Alice just approved the launch copy. You're clear to push when ready.",
          },
          { from: 'user', via: 'bob', text: 'on it' },
        ]}
      />

      <H3>To another channel</H3>
      <p style={proseP}>
        The agent can also move someone's conversation into a different channel — carrying a
        request from the main channel into a side room and working it there. Same person,
        different cell.
      </p>

      <ConversationGridFigure
        rows={PEOPLE}
        cols={CHANNELS}
        pinned="[assistant]"
        cells={[
          { row: 0, col: 0, color: TEAL },
          { row: 0, col: 1, color: PLUM },
        ]}
        arrow={{ from: { row: 0, col: 0 }, to: { row: 0, col: 1 } }}
        caption="across a row — same person, another channel"
      />

      <H3>To another person on another channel</H3>
      <p style={proseP}>
        These moves combine. The agent can reach another person on another channel in a single
        move, choosing both the person and the channel at once.
      </p>

      <ConversationGridFigure
        rows={PEOPLE}
        cols={CHANNELS}
        pinned="[assistant]"
        cells={[
          { row: 0, col: 0, color: TEAL },
          { row: 1, col: 1, color: AMBER },
        ]}
        arrow={{ from: { row: 0, col: 0 }, to: { row: 1, col: 1 } }}
        caption="diagonal — another person and another channel, in one move"
      />

      <H2>Meeting on shared ground</H2>
      <p style={proseP}>
        When several conversations need to track the same changing state — a decision log, a
        shared backlog, an event stream — they meet on an append-only file. Each writes to it and watches it; a new row wakes whoever's watching. The file is the meeting
        point: conversations that never talk directly still coordinate through what's written
        there.
      </p>

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'alice', color: TEAL }}
        script={[
          {
            from: 'user',
            via: 'alice',
            text: 'Add "review the migration plan" to the team backlog, flag the GDPR section.',
          },
          {
            from: 'agent',
            via: 'to alice',
            text: 'Added. Anyone watching the backlog will pick it up on their next wake.',
          },
        ]}
      />

      <ChatMockup
        agentName="agent"
        cell={{ channel: 'default', participant: 'bob', color: INDIGO }}
        script={[
          {
            from: 'agent',
            via: 'to bob',
            time: 'backlog updated',
            text:
              'Alice just added "review the migration plan" to the backlog. She flagged the GDPR section. Want me to pull that doc and prep a summary?',
          },
          { from: 'user', via: 'bob', text: 'yes please' },
        ]}
      />

      <H2>Across agents</H2>
      <p style={proseP}>
        Agents can also work with each other, two ways.
      </p>

      <H3>Ask a peer</H3>
      <p style={proseP}>
        One agent can ask another a question and get an answer back. The two agents talk
        directly — no person is in between — so a generalist can consult a specialist and use
        the reply in its own conversation. The question goes out; the answer comes back on a
        later turn. This is the main way agents work together.
      </p>

      <PeerDialogueFigure
        left={{ agent: '[assistant]', participant: '[research]', channel: 'peers', color: TEAL }}
        right={{ agent: '[research]', participant: '[assistant]', channel: 'peers', color: GREEN }}
        caption="each agent is a participant in the other's grid — ask, answer back"
      />

      <H3>Hand off a person</H3>
      <p style={proseP}>
        One agent can also hand a person off to another agent — same person, different agent.
        The second agent picks up the conversation and replies to them directly.
      </p>

      <ConversationGridFigure
        rows={['[assistant]', '[research]']}
        cols={CHANNELS}
        pinned="alice"
        cells={[
          { row: 0, col: 0, color: TEAL },
          { row: 1, col: 0, color: GREEN },
        ]}
        arrow={{ from: { row: 0, col: 0 }, to: { row: 1, col: 0 } }}
        caption="one person, held fixed — handing them to a peer agent"
      />

      <p style={proseP}>
        Either way, the other agent works under its own access rules, not the sender's. So
        reaching a different person on a different agent isn't one step: you ask the peer, and
        it decides who to message.
      </p>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/use/pairing">Pairing</DocsLink> — how a new person joins.
        </li>
        <li>
          <DocsLink href="/docs/concepts/channels">Channels</DocsLink> — what shapes the
          conversation in each cell.
        </li>
        <li>
          <DocsLink href="/docs/concepts/triggers">Scheduling &amp; triggers</DocsLink> — what
          else opens a conversation, and the shared file in depth.
        </li>
        <li>
          <DocsLink href="/docs/runtime/wire-format">Wire format</DocsLink> — how agents ask
          and answer each other.
        </li>
      </ul>
    </DocsLayout>
  );
}
