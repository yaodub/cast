import { DocsLayout, H2, proseP } from '../../components/docs/DocsLayout';
import { Code } from '../../components/ui/Code';

// Stub: linked from the dashboard's "Update available" banner. Intentionally
// minimal for now — the canonical update command plus room to grow. Not in
// sidebar.ts on purpose; it's reached from the banner, not the nav.
export function Updating() {
  return (
    <DocsLayout
      url="/docs/updating"
      crumbs={['docs', 'get started', 'updating']}
      title="Updating"
      lede="Keeping your Cast install current."
      toc={[{ label: 'Update' }]}
    >
      <H2>Update</H2>
      <p style={proseP}>From your Cast checkout:</p>
      <Code lang="bash">{`git pull && pnpm start`}</Code>
      <p style={proseP}>
        <code>pnpm start</code> detects what changed and rebuilds only what's needed —
        dependencies, the dashboard and server bundle, and the agent container image.
        Usually under a minute.
      </p>
    </DocsLayout>
  );
}
