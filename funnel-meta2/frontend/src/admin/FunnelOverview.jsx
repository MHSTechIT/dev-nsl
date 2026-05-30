/* Funnel Overview — first tab in the admin dashboard.
   Pure-SVG visualisation of the customer journey funnel:
   Awareness → Consideration → Conversion → Loyalty → Advocacy.

   Each stage renders as a 3-D-looking stacked disc that tapers as it
   descends. Right-side leader lines connect each disc to its label. */

/* Per-stage counts are placeholder values for visual layout. When ready to
   wire to live data, replace each `count` with the matching backend metric
   (e.g. unique_visitors / wa_clicks from /api/admin/dashboard). */
const STAGES = [
  { id: 'unique_leads',       letter: 'U', label: 'Unique Leads',       blurb: 'Unique visitors landing on the funnel',       count: 12500 },
  { id: 'start_registration', letter: 'S', label: 'Start Registration', blurb: 'Tapped Start and began filling the form',     count:  8400 },
  { id: 'sugar_level',        letter: 'S', label: 'Sugar Level',        blurb: 'Picked their fasting sugar bucket',           count:  6200 },
  { id: 'tamil',              letter: 'T', label: 'Do You Know Tamil',  blurb: 'Confirmed Tamil language preference',         count:  5100 },
  { id: 'registration',       letter: 'R', label: 'Registration',       blurb: 'Completed the registration form',             count:  3800 },
  { id: 'whatsapp',           letter: 'W', label: 'WhatsApp',           blurb: 'Tapped through to the WhatsApp confirmation', count:  2950 },
];

/* Compact integer formatter — adds Indian-style commas (1,23,456). */
function fmtCount(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-IN');
}

/* Disc geometry — tapers from 420 → 100 over 6 stages.
   Heights & gaps tuned so the funnel fits in the viewport without scroll. */
const TOP_Y     = 14;
const DISC_H    = 40;
const DISC_GAP  = 20;          // empty vertical space between adjacent discs
const DISC_RY   = 7;           // ellipse vertical radius (perspective)
const TOP_WIDTHS = [420, 370, 320, 270, 220, 170];
const BOT_WIDTHS = [370, 320, 270, 220, 170, 120];

/* Per-stage purple gradient ramp — change a single index to recolour one
   disc independently. Order matches `STAGES`: [Unique Leads, Start
   Registration, Sugar Level, Do You Know Tamil, Registration, WhatsApp]. */
const TOP_FILLS = ['#C4B5FD', '#B4A4F8', '#A78BFA', '#9173F0', '#8062E8', '#7C5FE6'];
const SIDE_TOP  = ['#A78BFA', '#9077F0', '#7C5FE6', '#6E47DA', '#5F32C8', '#5B21B6'];
const SIDE_BOT  = ['#8B5CF6', '#7C3AED', '#6B22D6', '#5B21B6', '#52189F', '#4C1D95'];

const CENTER_X  = 230;
const SVG_W     = 760;          // wider so right-side labels + counts render fully
const SVG_H     = TOP_Y
                + DISC_H * STAGES.length
                + DISC_GAP * (STAGES.length - 1)
                + 32;

export default function FunnelOverview() {
  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',   // funnel + labels right-aligned inside the card
        background: 'linear-gradient(180deg, #FAF7FF 0%, #F1ECFC 100%)',
        borderRadius: 18,
        padding: '20px 16px 24px',
        border: '1px solid rgba(147,51,234,0.10)',
      }}>
        <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} width="100%" style={{ maxWidth: 740 }}>
          <defs>
            {STAGES.map((_, i) => (
              <linearGradient key={i} id={`disc-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0"   stopColor={SIDE_TOP[i]} />
                <stop offset="1"   stopColor={SIDE_BOT[i]} />
              </linearGradient>
            ))}
            {/* Soft drop shadow under each disc */}
            <filter id="discShadow" x="-20%" y="-20%" width="140%" height="160%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" />
              <feOffset dx="0" dy="3" result="off" />
              <feComponentTransfer><feFuncA type="linear" slope="0.35" /></feComponentTransfer>
              <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {(() => {
            /* Funnel-of-funnels baseline — `Unique Leads` (first stage) is
               always 100%. Every other stage shows what % of unique leads
               survived to that step. Computed once outside the map so each
               row can reference the same baseline. */
            const baseline = STAGES[0]?.count || 0;
            return STAGES.map((stage, i) => {
            const topW = TOP_WIDTHS[i];
            const botW = BOT_WIDTHS[i];
            const yTop = TOP_Y + i * (DISC_H + DISC_GAP);
            const yBot = yTop + DISC_H;
            const pct  = baseline > 0
              ? (i === 0 ? 100 : Math.round((stage.count / baseline) * 1000) / 10)
              : 0;
            const pctText = i === 0 ? '100%' : `${pct}%`;

            // Side wall — closed path: starts top-left, back curve of top
            // ellipse (hidden), down right edge, front curve of bottom ellipse,
            // up left edge.
            const sidePath =
              `M ${CENTER_X - topW / 2} ${yTop} ` +
              `A ${topW / 2} ${DISC_RY} 0 0 0 ${CENTER_X + topW / 2} ${yTop} ` +
              `L ${CENTER_X + botW / 2} ${yBot} ` +
              `A ${botW / 2} ${DISC_RY} 0 0 1 ${CENTER_X - botW / 2} ${yBot} ` +
              `Z`;

            // Leader line: from the rightmost rim of this disc, going right.
            const lineStartX = CENTER_X + topW / 2 - 4;
            const lineY      = yTop + DISC_H / 2;
            const lineEndX   = CENTER_X + 240;
            const labelX     = lineEndX + 8;

            return (
              <g key={stage.id} filter="url(#discShadow)">
                {/* Side wall */}
                <path d={sidePath} fill={`url(#disc-grad-${i})`} />

                {/* Top ellipse — the visible "rim" */}
                <ellipse
                  cx={CENTER_X} cy={yTop}
                  rx={topW / 2} ry={DISC_RY}
                  fill={TOP_FILLS[i]}
                  stroke="rgba(255,255,255,0.40)" strokeWidth="1"
                />

                {/* Percentage anchored just below the body midpoint so the
                   text sits in the lower half of each disc — feels closer
                   to a conventional funnel-chart label. */}
                <text
                  x={CENTER_X} y={yTop + DISC_H / 2 + 5}
                  fill="#fff"
                  fontSize={Math.max(12, 17 - i * 0.5)}
                  fontWeight="800"
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ pointerEvents: 'none' }}
                >
                  {pctText}
                </text>

                {/* Leader line + label */}
                <line
                  x1={lineStartX} y1={lineY}
                  x2={lineEndX}   y2={lineY}
                  stroke="rgba(91,33,182,0.50)" strokeWidth="1.2"
                  strokeDasharray="0"
                />
                <circle cx={lineEndX} cy={lineY} r="2.4" fill="#5B21B6" />
                <text
                  x={labelX} y={lineY + 4}
                  fill="#3B0764" fontSize="13" fontWeight="700"
                  dominantBaseline="alphabetic"
                >
                  {stage.label}
                  <tspan dx="10" fill="#7C3AED" fontSize="13" fontWeight="800">
                    · {fmtCount(stage.count)}
                  </tspan>
                </text>
              </g>
            );
            });
          })()}

          {/* ── Flow particles ──
             3 small droplets fall through each gap between consecutive
             discs. Each droplet is a circle that animates its `cy` from
             the bottom of the upper disc to the top of the next, fading
             in / out at the ends. The three particles per gap are
             staggered (delay 0 / 0.5 / 1.0 s) so the flow looks
             continuous instead of pulsing in unison. Rendered AFTER the
             discs so they appear on top of the rims. */}
          {STAGES.slice(0, -1).map((_, i) => {
            const yBot     = TOP_Y + i * (DISC_H + DISC_GAP) + DISC_H;
            const yTopNext = TOP_Y + (i + 1) * (DISC_H + DISC_GAP);
            const drops = [
              { dx: -8, delay: 0    },
              { dx:  0, delay: 0.55 },
              { dx:  8, delay: 1.10 },
            ];
            return drops.map((d, pi) => (
              <circle
                key={`flow-${i}-${pi}`}
                cx={CENTER_X + d.dx}
                cy={yBot}
                r="3"
                fill="#DDD6FE"
                stroke="rgba(255,255,255,0.55)"
                strokeWidth="0.5"
              >
                <animate
                  attributeName="cy"
                  from={yBot}
                  to={yTopNext + DISC_RY * 0.6}
                  dur="1.6s"
                  begin={`${d.delay}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.18;0.78;1"
                  dur="1.6s"
                  begin={`${d.delay}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="r"
                  values="2;3.2;3.2;2"
                  keyTimes="0;0.25;0.75;1"
                  dur="1.6s"
                  begin={`${d.delay}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ));
          })}
        </svg>
      </div>
    </div>
  );
}
