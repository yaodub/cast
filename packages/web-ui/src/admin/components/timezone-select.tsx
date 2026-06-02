import { useMemo } from 'preact/hooks';

function parseGmtOffset(str: string): number {
  const m = str.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 0;
  return (parseInt(m[2]!, 10) * 60 + parseInt(m[3] ?? '0', 10)) * (m[1] === '-' ? -1 : 1);
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getOffsetAt(tz: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date);
  return parseGmtOffset(parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT');
}

/** Well-known cities preferred as group representatives. */
const PREFERRED = new Set([
  'Pacific/Midway', 'Pacific/Pago_Pago', 'Pacific/Honolulu', 'Pacific/Marquesas',
  'America/Anchorage', 'America/Los_Angeles', 'America/Phoenix', 'America/Denver',
  'America/Chicago', 'America/New_York', 'America/Halifax', 'America/St_Johns',
  'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Atlantic/South_Georgia', 'Atlantic/Azores', 'Atlantic/Cape_Verde',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Helsinki',
  'Europe/Istanbul', 'Europe/Moscow', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Kabul',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Yangon',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Adelaide', 'Australia/Sydney', 'Australia/Lord_Howe',
  'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Tongatapu',
  'Pacific/Kiritimati',
]);

/** Timezone dropdown — dedupes zones with identical year-round offset behavior,
 *  sorts by standard offset, and picks well-known cities as representatives. */
export function TimezoneSelect({ value, onChange, class: className }: {
  value: string;
  onChange: (v: string) => void;
  class?: string;
}) {
  const options = useMemo(() => {
    const allTzs = Intl.supportedValuesOf('timeZone');
    const jan = new Date('2025-01-15T12:00:00Z');
    const jul = new Date('2025-07-15T12:00:00Z');

    const groups = new Map<string, { tz: string; janOff: number; julOff: number }[]>();
    for (const tz of allTzs) {
      const janOff = getOffsetAt(tz, jan);
      const julOff = getOffsetAt(tz, jul);
      const key = `${janOff}|${julOff}`;
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push({ tz, janOff, julOff });
    }

    const reps: { tz: string; stdOff: number; hasDst: boolean }[] = [];
    for (const group of groups.values()) {
      const pick = group.find((g) => PREFERRED.has(g.tz))
        ?? group.sort((a, b) => a.tz.split('/').length - b.tz.split('/').length || a.tz.length - b.tz.length)[0]!;
      const stdOff = Math.min(pick.janOff, pick.julOff);
      reps.push({ tz: pick.tz, stdOff, hasDst: pick.janOff !== pick.julOff });
    }

    return reps
      .sort((a, b) => a.stdOff - b.stdOff || a.tz.localeCompare(b.tz))
      .map((r) => {
        const city = r.tz.split('/').pop()!.replace(/_/g, ' ');
        return { tz: r.tz, label: `(${formatOffset(r.stdOff)}) ${city}` };
      });
  }, []);

  return (
    <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} class={className}>
      <option value="">Server default</option>
      {options.map((o) => <option key={o.tz} value={o.tz}>{o.label}</option>)}
    </select>
  );
}
