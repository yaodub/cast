function BandedDiagram() {
  const W = 920;
  const PAD = 24;
  const B = {
    outside: { y: 24, h: 170 },
    gates: { y: 208, h: 64 },
    inside: { y: 286, h: 235 },
    disk: { y: 552, h: 110 },
  };
  const TRUNK_X = W / 2;

  return (
    <svg
      viewBox={`0 0 ${W} 690`}
      width="100%"
      style={{ display: 'block' }}
      fontFamily="Arial, Helvetica, sans-serif"
      aria-label="Banded architecture diagram. Outside band contains people and the internet, with one denied person and one denied service. A security boundary band lists the four crossing categories. Inside band contains the morning-digest agent flanked by two peer agents. Local disk band contains your files."
    >
      <defs>
        <marker
          id="bd-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--y2k-ink)" />
        </marker>
        <marker
          id="bd-arrow-deny"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#B0203A" />
        </marker>
        <pattern
          id="bd-hatch"
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--y2k-ink)" stroke-width="0.5" opacity="0.18" />
        </pattern>
        <filter id="bd-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="var(--accent)" flood-opacity="0.35" />
        </filter>
      </defs>

      <rect
        x={PAD}
        y={B.outside.y}
        width={W - PAD * 2}
        height={B.outside.h}
        fill="url(#bd-hatch)"
        stroke="var(--y2k-ink)"
        stroke-width="1"
      />
      <text x={PAD + 12} y={B.outside.y + 22} font-size="13" font-weight="700" letter-spacing="1.6" fill="var(--y2k-ink)">
        OUTSIDE · the world
      </text>

      <rect
        x={PAD}
        y={B.gates.y}
        width={W - PAD * 2}
        height={B.gates.h}
        fill="var(--y2k-ink)"
        stroke="var(--y2k-ink)"
        stroke-width="3.5"
      />
      <text x={PAD + 12} y={B.gates.y + 20} font-size="13" font-weight="700" letter-spacing="1.6" fill="#FFFFFF">
        SECURITY BOUNDARY · enforces every crossing
      </text>

      <rect
        x={PAD}
        y={B.inside.y}
        width={W - PAD * 2}
        height={B.inside.h}
        fill="#FBFAF5"
        stroke="var(--y2k-ink)"
        stroke-width="2"
      />
      <text x={PAD + 12} y={B.inside.y + 22} font-size="13" font-weight="700" letter-spacing="1.6" fill="var(--y2k-ink)">
        INSIDE · the cast host
      </text>

      <text x={PAD + 12} y={B.disk.y + 18} font-size="13" font-weight="700" letter-spacing="1.6" fill="var(--y2k-ink)">
        LOCAL DISK · your files
      </text>

      <g transform={`translate(${PAD + 40} ${B.outside.y + 50})`}>
        <text x="0" y="0" font-size="11" font-weight="700" letter-spacing="1.2" fill="var(--fg-muted)">
          PEOPLE
        </text>
        {[
          { x: 0, label: 'you', sub: 'owner', allowed: true },
          { x: 130, label: 'collaborator', sub: 'paired', allowed: true },
          { x: 260, label: 'unknown', sub: 'no key', allowed: false },
        ].map((p, i) => {
          const stroke = p.allowed ? 'var(--y2k-ink)' : '#B0203A';
          const dash = p.allowed ? '' : '4 3';
          return (
            <g key={i} transform={`translate(${p.x} 14)`}>
              <circle cx="20" cy="14" r="7" fill="none" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <line x1="20" y1="21" x2="20" y2="44" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <line x1="20" y1="28" x2="10" y2="38" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <line x1="20" y1="28" x2="30" y2="38" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <line x1="20" y1="44" x2="12" y2="58" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <line x1="20" y1="44" x2="28" y2="58" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <text
                x="20"
                y="76"
                text-anchor="middle"
                font-size="11"
                fill={p.allowed ? 'var(--y2k-ink)' : '#B0203A'}
                fontFamily="JetBrains Mono, monospace"
                text-decoration={p.allowed ? 'none' : 'line-through'}
              >
                {p.label}
              </text>
              <text
                x="20"
                y="90"
                text-anchor="middle"
                font-size="9"
                fill={p.allowed ? 'var(--fg-muted)' : '#B0203A'}
                fontFamily="JetBrains Mono, monospace"
              >
                {p.sub}
              </text>
            </g>
          );
        })}
      </g>

      <g transform={`translate(${W / 2 + 30} ${B.outside.y + 36})`}>
        <text x="0" y="14" font-size="11" font-weight="700" letter-spacing="1.2" fill="var(--fg-muted)">
          NETWORK
        </text>
        <rect x="-18" y="22" width="260" height="108" fill="#EAF4EC" stroke="#1F8A5B" stroke-width="1.2" />
        <text
          x="-10"
          y="36"
          font-size="9"
          font-weight="700"
          letter-spacing="1.2"
          fill="#1F8A5B"
          fontFamily="JetBrains Mono, monospace"
        >
          ALLOWED
        </text>
        {[
          { x: 26, label: 'llm provider', sub: 'pinned', allowed: true },
          { x: 150, label: 'weather api', sub: 'allow-list', allowed: true },
          { x: 296, label: 'unlisted host', sub: 'analytics.example', allowed: false },
        ].map((s, i) => {
          const stroke = s.allowed ? '#1F8A5B' : '#B0203A';
          const dash = s.allowed ? '' : '4 3';
          return (
            <g key={i} transform={`translate(${s.x} 50)`}>
              <ellipse cx="24" cy="6" rx="22" ry="5" fill="#FFFFFF" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <path
                d="M 2 6 L 2 32 A 22 5 0 0 0 46 32 L 46 6"
                fill="#FFFFFF"
                stroke={stroke}
                stroke-width="1.4"
                stroke-dasharray={dash}
              />
              <path d="M 2 6 A 22 5 0 0 0 46 6" fill="none" stroke={stroke} stroke-width="1.4" stroke-dasharray={dash} />
              <text
                x="24"
                y="54"
                text-anchor="middle"
                font-size="11"
                fill={s.allowed ? 'var(--y2k-ink)' : '#B0203A'}
                fontFamily="JetBrains Mono, monospace"
                text-decoration={s.allowed ? 'none' : 'line-through'}
              >
                {s.label}
              </text>
              <text
                x="24"
                y="68"
                text-anchor="middle"
                font-size="9"
                fill={s.allowed ? 'var(--fg-muted)' : '#B0203A'}
                fontFamily="JetBrains Mono, monospace"
              >
                {s.sub}
              </text>
            </g>
          );
        })}
      </g>

      <g fontFamily="JetBrains Mono, monospace" font-size="11" font-weight="700" fill="#FFFFFF">
        {[
          { x: 150, label: 'IDENTITY' },
          { x: 360, label: 'ACCESS CONTROL' },
          { x: 570, label: 'MESSAGING' },
          { x: 770, label: 'WEB ACCESS' },
        ].map((g, i) => (
          <g key={i} transform={`translate(${g.x} ${B.gates.y + 32})`}>
            <rect x="-70" y="0" width="140" height="22" fill="none" stroke="#FFFFFF" stroke-width="1.2" />
            <text x="0" y="15" text-anchor="middle">
              {g.label}
            </text>
          </g>
        ))}
      </g>

      <g transform={`translate(${PAD + 60} ${B.inside.y + 60})`}>
        <rect x="0" y="0" width="140" height="100" fill="#FFFFFF" stroke="var(--y2k-ink)" stroke-width="1.2" />
        <rect x="0" y="0" width="140" height="20" fill="var(--y2k-ink)" />
        <text x="8" y="14" font-size="9" font-weight="700" letter-spacing="1.2" fill="#FFFFFF">
          PEER AGENT
        </text>
        <text x="70" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="var(--y2k-ink)">
          calendar-keeper
        </text>
        <text x="70" y="82" text-anchor="middle" font-size="9" fill="var(--fg-muted)" fontFamily="JetBrains Mono, monospace">
          logic · memory · skills
        </text>
      </g>

      <g transform={`translate(${W - PAD - 200} ${B.inside.y + 60})`}>
        <rect x="0" y="0" width="140" height="100" fill="#FFFFFF" stroke="var(--y2k-ink)" stroke-width="1.2" />
        <rect x="0" y="0" width="140" height="20" fill="var(--y2k-ink)" />
        <text x="8" y="14" font-size="9" font-weight="700" letter-spacing="1.2" fill="#FFFFFF">
          PEER AGENT
        </text>
        <text x="70" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="var(--y2k-ink)">
          email-manager
        </text>
        <text x="70" y="82" text-anchor="middle" font-size="9" fill="var(--fg-muted)" fontFamily="JetBrains Mono, monospace">
          logic · memory · skills
        </text>
      </g>

      <g transform={`translate(${TRUNK_X - 150} ${B.inside.y + 30})`}>
        <rect x="0" y="0" width="300" height="180" fill="#DDE7F0" stroke="var(--y2k-ink)" stroke-width="2.5" filter="url(#bd-glow)" />
        <rect x="0" y="0" width="300" height="26" fill="var(--y2k-ink)" />
        <text x="12" y="18" font-size="11" font-weight="700" letter-spacing="1.4" fill="#FFFFFF">
          AGENT
        </text>
        <text x="150" y="50" text-anchor="middle" font-size="18" font-weight="800" fill="var(--y2k-ink)">
          morning-digest
        </text>
        {[
          { x: 16, y: 70, label: 'home/' },
          { x: 158, y: 70, label: 'memory/' },
          { x: 16, y: 112, label: 'config/' },
          { x: 158, y: 112, label: 'state/' },
        ].map((p, i) => (
          <g key={i} transform={`translate(${p.x} ${p.y})`}>
            <rect x="0" y="0" width="126" height="32" fill="#FFFFFF" stroke="var(--y2k-ink)" stroke-width="1" />
            <text
              x="63"
              y="21"
              text-anchor="middle"
              font-size="12"
              fontFamily="JetBrains Mono, monospace"
              fill="var(--y2k-ink)"
            >
              {p.label}
            </text>
          </g>
        ))}
        <text x="150" y="166" text-anchor="middle" font-size="10" fill="var(--fg-muted)" fontFamily="JetBrains Mono, monospace">
          logic · memory · skills
        </text>
      </g>

      {(() => {
        const yTop = B.inside.y + 90;
        const yBot = B.inside.y + 130;
        const leftPeerR = PAD + 60 + 140;
        const mdLeftX = TRUNK_X - 150;
        const rightPeerL = W - PAD - 200;
        const mdRightX = TRUNK_X + 150;
        const cx = (mdRightX + rightPeerL) / 2;
        return (
          <g fill="none">
            <path d={`M ${leftPeerR} ${yTop} L ${mdLeftX} ${yTop}`} stroke="var(--y2k-ink)" stroke-width="1.4" marker-end="url(#bd-arrow)" />
            <path d={`M ${mdLeftX} ${yBot} L ${leftPeerR} ${yBot}`} stroke="var(--y2k-ink)" stroke-width="1.4" marker-end="url(#bd-arrow)" />
            <path d={`M ${rightPeerL} ${yTop} L ${mdRightX} ${yTop}`} stroke="var(--y2k-ink)" stroke-width="1.4" marker-end="url(#bd-arrow)" />
            <path
              d={`M ${mdRightX} ${yBot} L ${rightPeerL} ${yBot}`}
              stroke="#B0203A"
              stroke-width="1.5"
              stroke-dasharray="5 4"
              marker-end="url(#bd-arrow-deny)"
            />
            <circle cx={cx} cy={yBot} r="9" fill="#FFFFFF" stroke="#B0203A" stroke-width="1.4" />
            <text x={cx} y={yBot + 4} text-anchor="middle" font-size="11" font-weight="700" fill="#B0203A">
              ✗
            </text>
            <text
              x={cx}
              y={yBot + 22}
              text-anchor="middle"
              font-size="9"
              font-weight="700"
              letter-spacing="0.6"
              fontFamily="JetBrains Mono, monospace"
              fill="#B0203A"
            >
              acl blocked
            </text>
          </g>
        );
      })()}

      {(() => {
        const folderW = 240,
          folderH = 32,
          gap = 8,
          padInner = 14;
        const wrapX = PAD;
        const wrapY = B.disk.y + 32;
        const wrapW = W - PAD * 2;
        const wrapH = folderH * 2 + gap + padInner * 2;
        const stackX = wrapX + (wrapW - folderW) / 2;
        const stackY = wrapY + padInner;
        return (
          <g>
            <rect x={wrapX} y={wrapY} width={wrapW} height={wrapH} fill="#F4F0E6" stroke="var(--y2k-ink)" stroke-width="1" stroke-dasharray="3 3" />
            <g transform={`translate(${stackX} ${stackY})`}>
              {['~/Documents/', '~/Inbox/'].map((f, i) => (
                <g key={i} transform={`translate(0 ${i * (folderH + gap)})`}>
                  <rect x="0" y="0" width={folderW} height={folderH} fill="#FFFFFF" stroke="var(--y2k-ink)" stroke-width="1" />
                  <text
                    x={folderW / 2}
                    y={folderH / 2 + 5}
                    text-anchor="middle"
                    font-size="12"
                    fontFamily="JetBrains Mono, monospace"
                    fill="var(--y2k-ink)"
                  >
                    {f}
                  </text>
                </g>
              ))}
            </g>
          </g>
        );
      })()}

      <g stroke="var(--y2k-ink)" stroke-width="1.4" fill="none">
        <path d="M  84 184 L  84 208" marker-end="url(#bd-arrow)" />
        <path d="M 214 184 L 214 208" marker-end="url(#bd-arrow)" />
        <path d="M 540 184 L 540 208" marker-end="url(#bd-arrow)" />
        <path d="M 664 184 L 664 208" marker-end="url(#bd-arrow)" />
      </g>

      {[344, 820].map((x, i) => (
        <g key={i}>
          <path d={`M ${x} 184 L ${x} 196`} stroke="#B0203A" stroke-width="1.6" stroke-dasharray="5 4" fill="none" />
          <circle cx={x} cy="201" r="9" fill="#FFFFFF" stroke="#B0203A" stroke-width="1.4" />
          <text x={x} y="205" text-anchor="middle" font-size="11" font-weight="700" fill="#B0203A">
            ✗
          </text>
        </g>
      ))}

      <g stroke="var(--y2k-ink)" stroke-width="1.6" fill="none">
        <path d={`M ${TRUNK_X} ${B.gates.y + B.gates.h} L ${TRUNK_X} ${B.inside.y + 30}`} marker-end="url(#bd-arrow)" />
      </g>

      <g stroke="var(--y2k-ink)" stroke-width="1.6" fill="none">
        <path d={`M ${TRUNK_X} ${B.disk.y + 32} L ${TRUNK_X} ${B.inside.y + 210}`} marker-end="url(#bd-arrow)" />
      </g>
    </svg>
  );
}

export function VisioDiagram() {
  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '2px solid var(--y2k-ink)',
        boxShadow: '3px 3px 0 0 var(--y2k-ink)',
        padding: '28px 24px 24px',
        maxWidth: 880,
        margin: '0 auto',
      }}
    >
      <div
        style={{
          fontFamily: 'VT323, monospace',
          fontSize: 15,
          color: 'var(--fg-subtle)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: 14,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>fig. 1 &nbsp;·&nbsp; how a cast agent works</span>
        <span>rev. 0.8.2</span>
      </div>
      <BandedDiagram />
    </div>
  );
}
