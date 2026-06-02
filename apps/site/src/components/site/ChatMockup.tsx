interface Tool {
  icon: string;
  source: string;
  detail: string;
}

interface UserMsg {
  from: 'user';
  time?: string;
  via?: string;
  text: string;
}

interface AgentMsg {
  from: 'agent';
  time?: string;
  via?: string;
  tools?: Tool[];
  text: string;
  footer?: string;
}

export type ChatMessage = UserMsg | AgentMsg;

interface CellKey {
  channel: string;
  participant: string;
  /** Solid color keying this panel to its grid cell; tints the user bubble. */
  color: string;
}

interface Props {
  agentName: string;
  script: ChatMessage[];
  compact?: boolean;
  /** Coordinate chip in the header, color-keyed to a ConversationGridFigure cell. */
  cell?: CellKey;
}

type ConsoleTheme = 'design' | 'configure' | null;

const consoleColors = {
  design: {
    bg: 'rgba(14, 165, 233, 0.07)',
    border: 'rgba(14, 165, 233, 0.32)',
    label: '#0284C7',
  },
  configure: {
    bg: 'rgba(217, 119, 6, 0.08)',
    border: 'rgba(217, 119, 6, 0.32)',
    label: '#B45309',
  },
} as const;

function detectConsole(via: string | undefined): ConsoleTheme {
  if (!via) return null;
  const v = via.toLowerCase();
  if (v.includes('configure')) return 'configure';
  if (v.includes('design')) return 'design';
  return null;
}

export function ChatMockup({ agentName, script, compact = false, cell }: Props) {
  const outerStyle = compact
    ? { background: '#F5F5F4' }
    : {
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: '#F5F5F4',
        overflow: 'hidden',
        margin: '8px 0 22px',
        boxShadow: 'var(--shadow)',
      };

  return (
    <div style={outerStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: compact ? '8px 14px' : '10px 16px',
          borderBottom: '1px solid var(--border)',
          fontSize: compact ? 11 : 12,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--fg-muted)',
          background: '#F5F5F4',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#22c55e',
            display: 'inline-block',
          }}
        />
        <span>{agentName}</span>
        {cell && (
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: cell.color,
              fontWeight: 600,
              letterSpacing: '0.02em',
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: cell.color,
                display: 'inline-block',
              }}
            />
            {`${cell.channel} · ${cell.participant}`}
          </span>
        )}
      </div>
      <div
        style={{
          padding: compact ? 14 : 20,
          display: 'flex',
          flexDirection: 'column',
          gap: compact ? 10 : 14,
          background: '#F5F5F4',
        }}
      >
        {script.map((m, i) =>
          m.from === 'user' ? (
            <UserBubble key={i} msg={m} compact={compact} accent={cell?.color} />
          ) : (
            <AgentBubble key={i} msg={m} compact={compact} />
          ),
        )}
      </div>
    </div>
  );
}

function UserBubble({ msg, compact, accent }: { msg: UserMsg; compact: boolean; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '78%' }}>
        {(msg.via || msg.time) && (
          <Meta from="user" via={msg.via} time={msg.time} theme={null} />
        )}
        <div
          style={{
            background: accent ?? '#115E59',
            color: '#F3F4F6',
            padding: compact ? '8px 12px' : '10px 14px',
            borderRadius: '14px 14px 4px 14px',
            fontSize: compact ? 13 : 14,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {msg.text}
        </div>
      </div>
    </div>
  );
}

function AgentBubble({ msg, compact }: { msg: AgentMsg; compact: boolean }) {
  const theme = detectConsole(msg.via);
  const bubbleBg = theme ? consoleColors[theme].bg : 'var(--bg-elev)';
  const bubbleBorder = theme ? consoleColors[theme].border : 'var(--border)';

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{ maxWidth: '88%' }}>
        {(msg.via || msg.time) && (
          <Meta from="agent" via={msg.via} time={msg.time} theme={theme} />
        )}
        <div
          style={{
            background: bubbleBg,
            border: `1px solid ${bubbleBorder}`,
            color: 'var(--fg)',
            padding: compact ? '10px 14px' : '12px 16px',
            borderRadius: '14px 14px 14px 4px',
            fontSize: compact ? 13 : 14,
            lineHeight: 1.55,
          }}
        >
          {msg.tools && msg.tools.length > 0 && (
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: compact ? 11 : 12,
                color: 'var(--fg-muted)',
                marginBottom: compact ? 8 : 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {msg.tools.map((t, i) => (
                <div key={i}>
                  <span style={{ marginRight: 8 }}>{t.icon}</span>
                  <span style={{ color: 'var(--fg)', marginRight: 10 }}>{t.source}</span>
                  <span>{t.detail}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
          {msg.footer && (
            <div
              style={{
                marginTop: compact ? 10 : 12,
                paddingTop: compact ? 8 : 10,
                borderTop: `1px dashed ${theme ? consoleColors[theme].border : 'var(--border)'}`,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: compact ? 10 : 11,
                color: 'var(--fg-subtle)',
                fontStyle: 'italic',
              }}
            >
              {msg.footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({
  from,
  via,
  time,
  theme,
}: {
  from: 'user' | 'agent';
  via?: string;
  time?: string;
  theme: ConsoleTheme;
}) {
  const labelColor = theme ? consoleColors[theme].label : 'var(--fg-subtle)';
  return (
    <div
      style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        color: labelColor,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 4,
        textAlign: from === 'user' ? 'right' : 'left',
        fontWeight: theme ? 600 : 400,
      }}
    >
      {[via, time].filter(Boolean).join(' · ')}
    </div>
  );
}
