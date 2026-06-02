interface Row {
  i: number;
  icon: string;
  name: string;
  note: string;
  hi?: boolean;
}

const rows: Row[] = [
  { i: 0, icon: '📁', name: 'agents/', note: 'a folder on your computer' },
  { i: 1, icon: '📁', name: 'assistant/', note: 'one agent', hi: true },
  { i: 2, icon: '📄', name: 'manifest.json', note: 'name + status' },
  { i: 2, icon: '📁', name: 'blueprint/', note: 'how it works' },
  { i: 2, icon: '📁', name: 'memory/', note: 'what it remembers' },
  { i: 2, icon: '📁', name: 'home/', note: 'its working files' },
  { i: 1, icon: '📁', name: 'note-taker/', note: 'another agent' },
];

export function AgentFolder() {
  return (
    <div class="win95-window">
      <div class="win95-titlebar">
        <div class="win95-title">
          <span class="win95-title-icon" aria-hidden="true">
            <svg width="14" height="12" viewBox="0 0 14 12" style={{ imageRendering: 'pixelated' }}>
              <rect x="0" y="2" width="6" height="2" fill="#ffff00" stroke="#000" stroke-width="0.5" />
              <rect x="0" y="3" width="14" height="8" fill="#ffff00" stroke="#000" stroke-width="0.5" />
            </svg>
          </span>
          <span>C:\CAST</span>
        </div>
        <div class="win95-controls" aria-hidden="true">
          <button class="win95-btn" tabIndex={-1}>
            _
          </button>
          <button class="win95-btn" tabIndex={-1}>
            ▢
          </button>
          <button class="win95-btn win95-btn-close" tabIndex={-1}>
            ×
          </button>
        </div>
      </div>

      <div class="win95-menubar">
        <span>
          <u>F</u>ile
        </span>
        <span>
          <u>E</u>dit
        </span>
        <span>
          <u>V</u>iew
        </span>
        <span>
          <u>H</u>elp
        </span>
      </div>

      <div class="win95-body">
        <div
          style={{
            padding: '16px 18px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            lineHeight: 1.9,
          }}
        >
          {rows.map((r, idx) => (
            <div
              key={idx}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 16,
                paddingLeft: r.i * 20,
                color: r.hi ? 'var(--fg)' : 'var(--fg-muted)',
                fontWeight: r.hi ? 500 : 400,
              }}
            >
              <span>
                <span style={{ marginRight: 8 }}>{r.icon}</span>
                <span style={{ color: r.hi ? 'var(--accent)' : 'inherit' }}>{r.name}</span>
              </span>
              <span
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 12,
                  color: 'var(--fg-subtle)',
                  fontStyle: 'italic',
                }}
              >
                {r.note}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
