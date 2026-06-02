import { trpc } from '../trpc';

export function AgentSelect({ value, onChange, class: className }: {
  value: string;
  onChange: (v: string) => void;
  class?: string;
}) {
  const agents = trpc.agent.list.useQuery();
  return (
    <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} class={className}>
      <option value="">Select agent...</option>
      {(agents.data ?? []).map((a) => (
        <option key={a.alias} value={a.alias}>{a.alias}</option>
      ))}
    </select>
  );
}
