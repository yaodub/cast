import { trpc } from '../trpc';

export function ChannelSelect({ alias, value, onChange, class: className }: {
  alias: string;
  value: string;
  onChange: (v: string) => void;
  class?: string;
}) {
  const agent = trpc.agent.get.useQuery({ alias: alias }, { enabled: !!alias });
  const channels = (agent.data?.channels ?? []).filter((ch) => ch.name !== 'default');
  return (
    <select
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      class={className}
      disabled={!alias}
    >
      <option value="">default</option>
      {channels.map((ch) => (
        <option key={ch.name} value={ch.name}>{ch.name}</option>
      ))}
    </select>
  );
}
