import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';

export function ProfilesMinimal() {
  return (
    <DocsLayout
      url="/docs/profiles/minimal"
      crumbs={['docs', 'plugins', 'profiles', 'minimal']}
      title="minimal"
      lede="A bare baseline — for authors who want to shape how the agent speaks to Cast themselves, at the protocol level."
      toc={[
        { label: 'What it leaves out' },
        { label: 'Why you would choose it' },
        { label: 'Before you reach for it' },
      ]}
    >
      <p style={proseP}>
        Minimal strips the baseline back to a short orientation: a few directories, a
        handful of essential tools, a one-line bootstrap and cleanup. Where{' '}
        <DocsLink href="/docs/profiles/standard">standard</DocsLink> hands the agent Cast's
        curated briefing, minimal hands it almost nothing — and hands you the pen.
      </p>

      <H2>What it leaves out</H2>
      <p style={proseP}>
        Compared with standard, minimal omits most of the briefing: the rich filesystem and
        address-book conventions, the full tool catalog, the <DocsLink href="/docs/runtime/wire-format"><code>cast:</code> framework-tag
        protocol</DocsLink>, the cross-agent query etiquette, and the memory and knowledge-boundary
        discipline. The bootstrap pass is a single sentence with nothing held back, and
        cleanup is just "save a summary."
      </p>
      <Callout kind="jargon">
        Minimal trims what the agent is <em>told</em>, not what it can do. The tools are
        still there if the channel offers them — the agent just isn't briefed on them, and
        won't reach for what it wasn't told about.
      </Callout>

      <H2>Why you would choose it</H2>
      <p style={proseP}>
        Minimal is for fine-grained control. Standard encodes Cast's opinion about how an
        agent should behave — which tags it watches for, how it leans on its tools, how it
        opens and closes a conversation. When you want to define that relationship yourself —
        to tune exactly how the agent interacts with Cast at the protocol level — minimal
        clears those defaults out of the way so the blueprint says precisely what you mean,
        and nothing you didn't.
      </p>

      <H2>Before you reach for it</H2>
      <p style={proseP}>
        Everything standard would have taught is now yours to supply: what the{' '}
        <code>cast:</code> tags mean, what each tool is for, how the bootstrap and cleanup
        phases work, how the agent should keep its memory. Minimal doesn't make an agent
        simpler to build — it makes you responsible for the parts standard handled.
      </p>
      <Callout kind="warn">
        This is an advanced choice. To use minimal well you have to understand how Cast
        works under the hood — the protocol, the tools, the conversation lifecycle — because
        you're now authoring all of it. If you're not there yet,{' '}
        <DocsLink href="/docs/profiles/standard">standard</DocsLink> is the right call.
      </Callout>
    </DocsLayout>
  );
}
