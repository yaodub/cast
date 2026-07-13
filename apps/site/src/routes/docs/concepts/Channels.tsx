import { DocsLayout, H2, proseP, proseUl, proseTable, proseTh, proseTd } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';

export function ConceptsChannels() {
  return (
    <DocsLayout
      url="/docs/concepts/channels"
      crumbs={['docs', 'concepts', 'channels']}
      title="Channels"
      lede="A channel is a named surface where conversations open. With more than one, the same agent can be approached in more than one way."
      toc={[
        { label: 'One agent, many hats' },
        { label: 'A friends channel' },
        { label: 'A peer-query endpoint' },
        { label: 'A reflection channel that runs on its own' },
        { label: "What's in a channel definition" },
        { label: 'What to read next' },
      ]}
    >
      <H2>One agent, many hats</H2>
      <p style={proseP}>
        The agent has a single identity and memory, but it is able to wear a different
        "hat" on each entrypoint to the agent. For example, a <code>friends</code> channel
        can be a guarded way for friends to contact your agent. A <code>peer-query</code> channel
        can be a one-shot communication endpoint for another agent. A{' '}
        <code>reflection</code> channel can be a quiet space where the agent works on
        itself on a schedule. Each channel has its own lifetime, tools, prompt, boundary
        scripts, model, and who can reach it. The three patterns below make this concrete.
      </p>

      <H2>A friends channel</H2>
      <p style={proseP}>
        You might want to let a friend talk to your personal agent — get help with
        something, ask a question — without giving them the same surface you use
        yourself. A separate channel with its own prompt and ACL grant does that.
      </p>
      <p style={proseP}>
        Persistent lifetime keeps the chat open between messages. Full lifecycle wires
        in bootstrap and cleanup so context with this friend carries across sessions.
        The per-channel prompt sets the agent's posture (warm but guarded) and tells it
        when to push a question back to you.
      </p>

      <Code lang="bash" title="channel: friends">{`# blueprint/channels/friends/channel.json
{
  "idle_timeout": 1800000,
  "lifecycle": "full"
}

# blueprint/channels/friends/prompt.md
You're talking to one of my friends, not me. Be helpful and warm.
You can share what I've marked as shareable in /memory/; otherwise
default to private — answer in general terms or politely decline.

If a question comes up you're unsure about, message me and wait for
my reply before answering.`}</Code>

      <Callout kind="jargon">
        The friend gets access once you approve them, recorded in <code>config/acl.json</code>.
        Without that grant, the channel exists but they can't reach it.
      </Callout>

      <Callout kind="security">
        <strong>Soft partition, not a security boundary.</strong> The agent on the
        friends channel is the same agent that knows everything you know — the prompt
        above is a behavioral instruction the LLM follows, not enforced isolation. A
        persuasive friend can still talk the agent into sharing things you wouldn't
        want shared. For real isolation (different memory, different identity), run a
        separate agent.
      </Callout>

      <H2>A peer-query endpoint</H2>
      <p style={proseP}>
        Another agent might need a quick answer without opening an ongoing relationship.
        A peer-query channel takes one question, returns one answer, and closes. The
        peer accumulates no state with you, and the channel can expose a narrower tool
        surface than the default — answers don't need to schedule tasks or push into
        other conversations.
      </p>
      <p style={proseP}>
        <code>idle_timeout: null</code> makes it single-shot, paired with{' '}
        <code>disabled_tools</code> to narrow what the peer-callable surface can reach.
        A short <code>prompt.md</code> sets the one-shot posture so the agent commits to
        a complete answer in its single turn.
      </p>

      <Code lang="bash" title="channel: peer-query">{`# blueprint/channels/peer-query/channel.json
{
  "idle_timeout": null,
  "disabled_tools": ["task__*", "conversation__push_to_channel"]
}

# blueprint/channels/peer-query/prompt.md
You're answering one question from a peer agent. Give a complete
answer in your single turn — there are no follow-ups. Cite from
/memory/ where you can; be specific.`}</Code>

      <Callout kind="jargon">
        Which peers are allowed to reach this channel is set in{' '}
        <code>config/acl.json</code>, alongside the rest of the agent's access grants.
        The channel itself doesn't gate callers — the ACL does.
      </Callout>

      <H2>A reflection channel that runs on its own</H2>
      <p style={proseP}>
        An agent benefits from working on itself off-thread. A reflection channel is the
        agent talking to itself on a schedule: review the day, distill what mattered,
        leave a note in <code>/memory/</code>. No human in the loop, no ongoing chat to
        maintain. The conversation opens, the agent does its work in one turn, and it
        closes.
      </p>
      <p style={proseP}>
        Three pieces carry the pattern. <code>idle_timeout: null</code> makes it
        single-shot. The per-channel <code>prompt.md</code> tells the agent what
        reflection means on this surface. And a per-channel model override pins it to
        Haiku, since this work doesn't need the agent's heavier default.
      </p>

      <Code lang="bash" title="channel: reflection">{`# blueprint/channels/reflection/channel.json
{
  "idle_timeout": null
}

# blueprint/channels/reflection/prompt.md
You're doing your daily reflection. Skim recent work logs and message
threads. Append a paragraph to today's entry in /memory/journal/ —
decisions made, surprises, anything worth remembering next time.

# config/agent.json   (excerpt — per-channel model override)
{
  "modelOverrides": [
    { "channel": "reflection", "model": "claude-haiku-4-5" }
  ]
}`}</Code>

      <Callout kind="jargon">
        The schedule that fires this channel lives in{' '}
        <code>blueprint/props/schedule.txt</code>, not in the channel folder. See{' '}
        <DocsLink href="/docs/concepts/triggers">Scheduling &amp; triggers</DocsLink> for
        the cron grammar.
      </Callout>

      <H2>What's in a channel definition</H2>
      <p style={proseP}>
        A channel is a directory under <code>blueprint/channels/&lt;name&gt;/</code>.
        Most of what shapes the channel lives inside that folder; a couple of
        operator-set knobs sit outside it, in the agent's config.
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Setting</th>
            <th style={proseTh}>Where it lives</th>
            <th style={proseTh}>What it controls</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}>Lifetime</td>
            <td style={proseTd}><code>channel.json</code> <code>idle_timeout</code></td>
            <td style={proseTd}>
              Persistent (positive integer = milliseconds of idle before close) or
              single-shot (<code>null</code>).
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Lifecycle</td>
            <td style={proseTd}><code>channel.json</code> <code>lifecycle</code></td>
            <td style={proseTd}>
              Which boundary scripts fire: <code>none</code>,{' '}
              <code>bootstrap-only</code>, <code>cleanup-only</code>, or{' '}
              <code>full</code>.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Tool narrowing</td>
            <td style={proseTd}><code>channel.json</code> <code>disabled_tools</code></td>
            <td style={proseTd}>
              Tool names or globs (e.g. <code>task__*</code>) removed from this
              channel's surface.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Logging</td>
            <td style={proseTd}><code>channel.json</code> <code>log_messages</code></td>
            <td style={proseTd}>
              Whether turns on this channel are recorded in the message log.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Sharding</td>
            <td style={proseTd}><code>channel.json</code> <code>use_sharding</code></td>
            <td style={proseTd}>
              Enables sub-conversations within the channel.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Co-participant visibility</td>
            <td style={proseTd}><code>channel.json</code> <code>show_co_participants</code></td>
            <td style={proseTd}>
              Whether the agent is aware of other participants on this channel
              and can push messages to them (default on). Off hides them — for
              specialist or private channels.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Channel prompt</td>
            <td style={proseTd}><code>prompt.md</code></td>
            <td style={proseTd}>
              Per-channel instructions layered on the agent's identity, active only
              when this channel is in play.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Bootstrap</td>
            <td style={proseTd}><code>bootstrap.md</code></td>
            <td style={proseTd}>
              Runs at conversation open (when lifecycle includes bootstrap). Output
              injects into opening context.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Cleanup</td>
            <td style={proseTd}><code>cleanup.md</code></td>
            <td style={proseTd}>
              Runs at conversation close (when lifecycle includes cleanup). Output is
              swallowed; writes to <code>/memory/</code> persist.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Model</td>
            <td style={proseTd}><code>config/agent.json</code> <code>modelOverrides</code></td>
            <td style={proseTd}>
              Operator-set per-channel model override. The agent has a default model;
              individual channels can swap it.
            </td>
          </tr>
          <tr>
            <td style={proseTd}>Access</td>
            <td style={proseTd}><code>config/acl.json</code></td>
            <td style={proseTd}>
              Which identities can send to and receive from this channel. Operator-set.
            </td>
          </tr>
        </tbody>
      </table>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/concepts/conversations">Conversations</DocsLink> — the
          unit a channel shapes.
        </li>
        <li>
          <DocsLink href="/docs/concepts/triggers">Scheduling &amp; triggers</DocsLink>{' '}
          — what fires a channel, beyond a person sending a turn.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> — the
          full field reference for every file in the channel folder.
        </li>
      </ul>
    </DocsLayout>
  );
}
