import {
  DocsLayout,
  H2,
  proseP,
  proseUl,
  proseTable,
  proseTh,
  proseTd,
} from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';

export function ProfilesIndex() {
  return (
    <DocsLayout
      url="/docs/profiles"
      crumbs={['docs', 'plugins', 'profiles']}
      title="Profiles"
      lede="A profile is the baseline every agent runs on that makes it fluent in Cast before any personality is added."
      toc={[
        { label: 'What a profile is' },
        { label: 'The two profiles' },
        { label: 'Which to use' },
      ]}
    >
      <H2>What a profile is</H2>
      <p style={proseP}>
        A blueprint says who an agent is — its persona, its knowledge, the people it knows.
        A profile is everything underneath that: how <em>any</em> Cast agent finds its way
        around. The filesystem it lives in, the built-in tools it can reach for, how it
        keeps memory, how it talks to other agents, how a conversation opens and closes.
        The profile is what turns a raw model into an agent that already knows the house
        rules.
      </p>
      <p style={proseP}>
        Every agent runs exactly one profile, picked in its{' '}
        <DocsLink href="/docs/build/configuration">configuration</DocsLink> (the{' '}
        <code>profile</code> field, defaulting to <code>standard</code>). It's a choice, not
        something you wire up — Cast ships two, and you select one.
      </p>

      <Callout kind="jargon">
        <strong>A profile guides; it doesn't grant.</strong> It shapes what the agent is{' '}
        <em>told</em> — which tools it knows about, how it should behave — not which tools
        physically exist. Tool availability is set by the channel; the profile decides how
        much the agent is taught about its world.
      </Callout>

      <H2>The two profiles</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/profiles/standard">standard</DocsLink> — the full briefing.
          Everything a capable, self-directed agent needs to operate well in Cast out of the
          box.
        </li>
        <li>
          <DocsLink href="/docs/profiles/minimal">minimal</DocsLink> — a bare baseline. For
          authors who want to define the agent's protocol-level relationship with Cast
          themselves.
        </li>
      </ul>

      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}></th>
            <th style={proseTh}>standard</th>
            <th style={proseTh}>minimal</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}>Filesystem &amp; participants</td>
            <td style={proseTd}>Full conventions</td>
            <td style={proseTd}>Bare directories</td>
          </tr>
          <tr>
            <td style={proseTd}>Built-in tools explained</td>
            <td style={proseTd}>The whole catalog</td>
            <td style={proseTd}>A handful of essentials</td>
          </tr>
          <tr>
            <td style={proseTd}>Cross-agent &amp; framework protocol</td>
            <td style={proseTd}>Taught in full</td>
            <td style={proseTd}>Left out</td>
          </tr>
          <tr>
            <td style={proseTd}>Memory &amp; knowledge discipline</td>
            <td style={proseTd}>Spelled out</td>
            <td style={proseTd}>Left to the agent</td>
          </tr>
          <tr>
            <td style={proseTd}>Conversation lifecycle</td>
            <td style={proseTd}>Guided bootstrap &amp; cleanup</td>
            <td style={proseTd}>Light-touch</td>
          </tr>
          <tr>
            <td style={proseTd}>Context cost</td>
            <td style={proseTd}>Heavier</td>
            <td style={proseTd}>Light</td>
          </tr>
        </tbody>
      </table>

      <H2>Which to use</H2>
      <p style={proseP}>
        <strong>Reach for <DocsLink href="/docs/profiles/standard">standard</DocsLink> by
        default.</strong> It's what most agents want: arrive fluent in Cast without having
        to teach any of it in the blueprint. If you're not sure, this is the answer.
      </p>
      <p style={proseP}>
        <strong>Choose <DocsLink href="/docs/profiles/minimal">minimal</DocsLink></strong>{' '}
        when you want fine-grained control over how the agent interacts with Cast at the
        protocol level. It clears the standard briefing out of the way so your blueprint
        defines that relationship exactly — but it's an advanced choice: everything standard
        would have taught becomes yours to provide, so reach for it only if you understand
        how Cast works under the hood.
      </p>
    </DocsLayout>
  );
}
