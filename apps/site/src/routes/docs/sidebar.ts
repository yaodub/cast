export interface DocPage {
  url: string;
  label: string;
  /**
   * Children appear in the sidebar only when the current URL is the parent URL
   * or starts with `<parent>/`. Used for reference sections (e.g. per-extension
   * pages) that shouldn't clutter the sidebar at all times.
   */
  children?: DocPage[];
}

export interface DocSection {
  title: string;
  items: DocPage[];
}

export const docsSections: DocSection[] = [
  {
    title: 'Get started',
    items: [{ url: '/docs/quickstart', label: 'Quickstart' }],
  },
  {
    title: 'Use Cast',
    items: [
      { url: '/docs/use/server-dashboard', label: 'Server dashboard' },
      { url: '/docs/use/first-agent', label: 'Your first agent' },
      { url: '/docs/use/pairing', label: 'Pairing' },
      { url: '/docs/use/migrating', label: 'Migrating from other platforms' },
    ],
  },
  {
    title: 'Concepts',
    items: [
      { url: '/docs/concepts/conversations', label: 'Conversations' },
      { url: '/docs/concepts/channels', label: 'Channels' },
      { url: '/docs/concepts/multi-user', label: 'Conversation grid' },
      { url: '/docs/concepts/triggers', label: 'Scheduling & triggers' },
      { url: '/docs/concepts/capabilities', label: 'Capabilities' },
    ],
  },
  {
    title: 'Build agents',
    items: [
      { url: '/docs/build/agent-folder', label: 'Agent folder anatomy' },
      { url: '/docs/build/blueprints', label: 'Authoring blueprints' },
      { url: '/docs/build/configuration', label: 'Configuring agents' },
      { url: '/docs/build/multi-agent', label: 'Multi-agent composition' },
      { url: '/docs/build/services', label: 'Writing services' },
      { url: '/docs/build/claude-code', label: 'Working in Claude Code' },
      { url: '/docs/build/designing-well', label: 'Designing well' },
      { url: '/docs/build/distributing', label: 'Distributing blueprints' },
    ],
  },
  {
    title: 'Agent runtime',
    items: [
      { url: '/docs/runtime/context', label: 'Context' },
      { url: '/docs/runtime/tools', label: 'Tools' },
      { url: '/docs/runtime/wire-format', label: 'Wire format' },
    ],
  },
  {
    title: 'Plugins',
    items: [
      {
        url: '/docs/transports',
        label: 'Transports',
        children: [
          { url: '/docs/transports/telegram', label: 'telegram' },
          // DISCONNECTED: email transport temporarily disabled — page file is
          // preserved at routes/docs/transports/Email.tsx but unrouted.
          // { url: '/docs/transports/email', label: 'email' },
          { url: '/docs/transports/slack', label: 'slack' },
          { url: '/docs/transports/build', label: 'Creating a transport' },
        ],
      },
      {
        url: '/docs/extensions',
        label: 'Extensions',
        children: [
          { url: '/docs/extensions/calendar', label: 'calendar' },
          { url: '/docs/extensions/email', label: 'email' },
          { url: '/docs/extensions/web-fetch', label: 'web-fetch' },
          { url: '/docs/extensions/whatsapp', label: 'whatsapp' },
          { url: '/docs/extensions/build', label: 'Creating an extension' },
        ],
      },
      {
        url: '/docs/profiles',
        label: 'Profiles',
        children: [
          { url: '/docs/profiles/standard', label: 'standard' },
          { url: '/docs/profiles/minimal', label: 'minimal' },
        ],
      },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { url: '/docs/advanced/deployment', label: 'Deployment' },
      { url: '/docs/advanced/runtime-options', label: 'Runtime options' },
      { url: '/docs/advanced/backups', label: 'Backups & data' },
    ],
  },
];

const flat = docsSections.flatMap((s) =>
  s.items.flatMap((i) => [i, ...(i.children ?? [])]),
);

export function neighbors(url: string): { prev: DocPage | null; next: DocPage | null } {
  const i = flat.findIndex((p) => p.url === url);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? flat[i - 1]! : null,
    next: i < flat.length - 1 ? flat[i + 1]! : null,
  };
}

export function findPage(url: string): DocPage | undefined {
  return flat.find((p) => p.url === url);
}
