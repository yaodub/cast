/**
 * Figure for the "Agent services" section on Authoring blueprints.
 *
 * Two boxes side by side, both connecting down to a single agent box:
 *   Left  — "curated extensions": solid border (fig-harness), four named
 *           chips for the bundled extensions, caption "safe by design,
 *           token-disciplined".
 *   Right — "agent service": solid border in fig-shade (amber/caution,
 *           not danger-red), two centered lines "custom connectors" /
 *           "custom skills", caption "full power, full responsibility".
 *
 * Visual contrast (solid+contained+named vs dashed+open+wide) signals
 * curated-finite-set vs unbounded-write-your-own. Class vocabulary
 * matches the how-it-works/reach perimeter figures.
 */

const EXT_NAMES = ['email', 'calendar', 'web-fetch', 'whatsapp'];

const W = 560;
const H = 230;
const PAD = 20;
const BOX_W = 245;
const BOX_H = 110;
const BOX_Y = 26;
const AGENT_W = 90;
const AGENT_H = 30;
const AGENT_Y = 184;

export function ExtensionsServicesFigure({ caption }: { caption?: string }) {
  const agentX = (W - AGENT_W) / 2;
  const leftBoxX = PAD;
  const rightBoxX = W - BOX_W - PAD;

  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '20px 0',
          display: 'flex',
          justifyContent: 'center',
          color: 'var(--code-fg)',
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ maxWidth: W + 40, height: 'auto' }}
          font-family="JetBrains Mono, monospace"
        >
          {/* Left box — curated extensions */}
          <rect
            x={leftBoxX}
            y={BOX_Y}
            width={BOX_W}
            height={BOX_H}
            rx={4}
            class="fig-harness"
            fill="none"
            stroke="currentColor"
            stroke-width={1.4}
          />
          <text
            x={leftBoxX + 14}
            y={BOX_Y + 20}
            class="fig-harness"
            fill="currentColor"
            font-size={11}
            style={{ letterSpacing: '0.06em' }}
          >
            CURATED EXTENSIONS
          </text>
          {EXT_NAMES.map((name, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const chipW = 100;
            const chipH = 22;
            const chipGap = 8;
            const totalChipsW = chipW * 2 + chipGap;
            const startX = leftBoxX + (BOX_W - totalChipsW) / 2;
            const chipX = startX + col * (chipW + chipGap);
            const chipY = BOX_Y + 36 + row * (chipH + 8);
            return (
              <g key={name}>
                <rect
                  x={chipX}
                  y={chipY}
                  width={chipW}
                  height={chipH}
                  rx={3}
                  fill="currentColor"
                  fill-opacity={0.07}
                  stroke="currentColor"
                  stroke-opacity={0.4}
                  stroke-width={0.8}
                />
                <text
                  x={chipX + chipW / 2}
                  y={chipY + chipH / 2}
                  text-anchor="middle"
                  dy="0.35em"
                  fill="currentColor"
                  font-size={11.5}
                >
                  {name}
                </text>
              </g>
            );
          })}
          <text
            x={leftBoxX + BOX_W / 2}
            y={BOX_Y + BOX_H - 10}
            text-anchor="middle"
            fill="currentColor"
            fill-opacity={0.5}
            font-size={10.5}
            font-style="italic"
          >
            safe by design, token-disciplined
          </text>

          {/* Right box — agent service */}
          <rect
            x={rightBoxX}
            y={BOX_Y}
            width={BOX_W}
            height={BOX_H}
            rx={4}
            class="fig-shade"
            fill="currentColor"
            fill-opacity={0.07}
            stroke="currentColor"
            stroke-width={1.4}
          />
          <text
            x={rightBoxX + 14}
            y={BOX_Y + 20}
            class="fig-shade"
            fill="currentColor"
            font-size={11}
            style={{ letterSpacing: '0.06em' }}
          >
            AGENT SERVICE
          </text>
          <text
            x={rightBoxX + BOX_W / 2}
            y={BOX_Y + BOX_H / 2 - 4}
            text-anchor="middle"
            class="fig-shade"
            fill="currentColor"
            font-size={13.5}
          >
            custom connectors
          </text>
          <text
            x={rightBoxX + BOX_W / 2}
            y={BOX_Y + BOX_H / 2 + 16}
            text-anchor="middle"
            class="fig-shade"
            fill="currentColor"
            font-size={13.5}
          >
            custom skills
          </text>
          <text
            x={rightBoxX + BOX_W / 2}
            y={BOX_Y + BOX_H - 10}
            text-anchor="middle"
            fill="currentColor"
            fill-opacity={0.5}
            font-size={10.5}
            font-style="italic"
          >
            full power, full responsibility
          </text>

          {/* Connecting lines from each box to the agent */}
          <line
            x1={leftBoxX + BOX_W / 2}
            y1={BOX_Y + BOX_H}
            x2={agentX + AGENT_W / 2}
            y2={AGENT_Y}
            stroke="currentColor"
            stroke-opacity={0.35}
            stroke-width={1.2}
          />
          <line
            x1={rightBoxX + BOX_W / 2}
            y1={BOX_Y + BOX_H}
            x2={agentX + AGENT_W / 2}
            y2={AGENT_Y}
            stroke="currentColor"
            stroke-opacity={0.35}
            stroke-width={1.2}
          />

          {/* Agent box */}
          <rect
            x={agentX}
            y={AGENT_Y}
            width={AGENT_W}
            height={AGENT_H}
            rx={2}
            fill="none"
            stroke="currentColor"
            stroke-width={1.4}
          />
          <text
            x={agentX + AGENT_W / 2}
            y={AGENT_Y + AGENT_H / 2}
            text-anchor="middle"
            dy="0.35em"
            fill="currentColor"
            font-size={13}
          >
            agent
          </text>
        </svg>
      </div>
    </div>
  );
}
