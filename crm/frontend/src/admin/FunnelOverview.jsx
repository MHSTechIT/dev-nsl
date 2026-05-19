import { useState, useEffect } from 'react';

/* Funnel Overview — first tab in the admin dashboard.
   Pure-SVG visualisation of the customer journey funnel:
   Awareness → Consideration → Conversion → Loyalty → Advocacy.

   Left-side filter panel fills the space next to the funnel — date range
   pills, webinar dropdown, refresh action. Counts are pulled live from
   `/api/admin/dashboard` (the same endpoint that powers the Page
   Performance tab) and re-fetched whenever any filter changes. */

/* Stage definitions — each `eventKeys` array lists the click_event names
   whose counts add up to that stage's value. The order here drives the
   funnel rendering top-to-bottom. */
const STAGES = [
  { id: 'unique_leads',       letter: 'U', label: 'Unique Leads',       blurb: 'Unique visitors landing on the funnel',       eventKeys: ['unique_visitors']                    },
  { id: 'start_registration', letter: 'S', label: 'Start Registration', blurb: 'Tapped Start and began filling the form',     eventKeys: ['cta_clicked']                        },
  { id: 'sugar_level',        letter: 'S', label: 'Sugar Level',        blurb: 'Picked their fasting sugar bucket',           eventKeys: ['sugar_150_250', 'sugar_250_plus']    },
  { id: 'tamil',              letter: 'T', label: 'Do You Know Tamil',  blurb: 'Confirmed Tamil language preference',         eventKeys: ['tamil_yes', 'tamil_no']              },
  { id: 'registration',       letter: 'R', label: 'Registration',       blurb: 'Completed the registration form',             eventKeys: ['registration_submitted']             },
  { id: 'whatsapp',           letter: 'W', label: 'WhatsApp',           blurb: 'Tapped through to the WhatsApp confirmation', eventKeys: ['wa_join_clicked']                    },
];

/* Sum every event count listed in `eventKeys` against the `counts` map
   returned by /api/admin/dashboard. Missing keys contribute 0 so the
   stage stays valid even if a particular event hasn't fired yet. */
function sumCounts(counts, keys) {
  let total = 0;
  for (const k of keys) total += (counts?.[k] || 0);
  return total;
}

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

/* Date-range pills + small filter components. Plain inline buttons so the
   funnel page doesn't drag in HomeDashboard's component imports. */
const DATE_PILLS = [
  { id: 'all',    label: 'All'    },
  { id: 'today',  label: 'Today'  },
  { id: 'custom', label: 'Custom' },
];

function Pill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 50, border: 'none',
        background: active ? '#5B21B6' : 'rgba(255,255,255,0.70)',
        color: active ? '#fff' : 'rgba(91,33,182,0.65)',
        fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem',
        cursor: 'pointer', transition: 'all 160ms',
        boxShadow: active ? '0 2px 8px rgba(91,33,182,0.25)' : 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function FilterCard({ icon, label, children }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.70)',
      border: '1px solid rgba(139,92,246,0.18)',
      borderRadius: 14,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', fontWeight: 700,
        color: 'rgba(91,33,182,0.65)',
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        {icon}
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

export default function FunnelOverview({ token, source = 'meta' }) {
  const [dateRange, setDateRange]   = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]     = useState('');
  const [webinarId, setWebinarId]   = useState('');
  const [webinars,  setWebinars]    = useState([]);
  const [counts,    setCounts]      = useState({});
  const [loading,   setLoading]     = useState(true);
  const [error,     setError]       = useState('');
  const [refetchTick, setRefetchTick] = useState(0);   // bumped by Refresh button
  const [lastUpdated, setLastUpdated] = useState(() =>
    new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
  );

  function refresh() {
    setRefetchTick(t => t + 1);
  }

  /* Populate the Webinar dropdown — reuses the same endpoint as every
     other admin view so the option list stays consistent. */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`/api/admin/webinars?source=${source}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (!cancelled) setWebinars(d.webinars || []); })
      .catch(() => { /* non-fatal — keeps the "All Webinars" default */ });
    return () => { cancelled = true; };
  }, [token, source]);

  /* Fetch live funnel counts whenever a filter changes. Reuses
     /api/admin/dashboard which already groups click_events by name +
     joins lead/wa-click totals — exactly what the funnel stages need. */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('source', source);
    if (dateRange === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      params.set('from', today);
      params.set('to',   today);
    } else if (dateRange === 'custom' && customFrom) {
      params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    }
    if (webinarId) {
      // `webinar_at` is what HomeDashboard sends — keep the contract stable.
      const w = webinars.find(x => String(x.id) === String(webinarId));
      if (w?.webinar_at) params.set('webinar_at', w.webinar_at);
    }
    setLoading(true);
    setError('');
    fetch(`/api/admin/dashboard?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to fetch')))
      .then(j => {
        if (cancelled) return;
        setCounts(j.counts || {});
        setLastUpdated(new Date().toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
        }));
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, source, dateRange, customFrom, customTo, webinarId, webinars, refetchTick]);

  /* Stage objects with live counts spliced in. Computed once per render
     so the SVG below renders against `liveStages` and the placeholder
     STAGES constant only carries config (labels, blurbs, event keys). */
  const liveStages = STAGES.map(s => ({ ...s, count: sumCounts(counts, s.eventKeys) }));

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 16,
        background: 'linear-gradient(180deg, #FAF7FF 0%, #F1ECFC 100%)',
        borderRadius: 18,
        padding: '20px 16px 24px',
        border: '1px solid rgba(147,51,234,0.10)',
      }}>

        {/* ── Left filter panel — fills the empty space next to the funnel ── */}
        <div className="funnel-filter-col" style={{
          width: 280, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          <FilterCard
            label="Date Range"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.65)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
              {DATE_PILLS.map(p => (
                <Pill key={p.id} label={p.label} active={dateRange === p.id} onClick={() => setDateRange(p.id)} />
              ))}
            </div>
            {dateRange === 'custom' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  style={{
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid rgba(139,92,246,0.25)',
                    background: '#fff',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: '#3B0764',
                  }}
                />
                <input
                  type="date"
                  value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  style={{
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid rgba(139,92,246,0.25)',
                    background: '#fff',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: '#3B0764',
                  }}
                />
              </div>
            )}
          </FilterCard>

          <FilterCard
            label="Webinar"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.65)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>
              </svg>
            }
          >
            <select
              value={webinarId}
              onChange={e => setWebinarId(e.target.value)}
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 8,
                border: '1px solid rgba(139,92,246,0.25)',
                background: '#fff',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', color: '#3B0764',
                cursor: 'pointer',
              }}
            >
              <option value="">All Webinars</option>
              {webinars.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name ? w.name.replace(/^AWS-/, 'AWS - ') : (w.webinar_at || w.id)}
                </option>
              ))}
            </select>
          </FilterCard>

          {/* Refresh + timestamp */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, marginTop: 'auto', padding: '4px 2px',
          }}>
            <span style={{ fontSize: '0.66rem', color: 'rgba(91,33,182,0.50)' }}>
              {loading ? 'Loading…' : `Updated ${lastUpdated}`}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              style={{
                padding: '6px 12px', borderRadius: 8, border: 'none',
                background: loading ? 'rgba(91,33,182,0.05)' : 'rgba(91,33,182,0.10)',
                color: '#5B21B6',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem',
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading ? 0.5 : 1,
              }}
            >
              ↻ Refresh
            </button>
          </div>
          {/* Compact inline error band — only visible when the API
              call fails. Doesn't unmount the funnel; the SVG stays so
              the admin can still glance at the previous counts. */}
          {error && (
            <div style={{
              padding: '6px 10px', borderRadius: 8,
              background: 'rgba(254,242,242,0.95)',
              border: '1px solid rgba(248,113,113,0.40)',
              color: '#B91C1C', fontSize: '0.74rem',
            }}>
              ⚠ {error}
            </div>
          )}
        </div>

        {/* ── Right: funnel SVG ── */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
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
            const baseline = liveStages[0]?.count || 0;
            return liveStages.map((stage, i) => {
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
            // Particles converge slightly toward the centre (funnel narrows).
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
        </div>{/* /right funnel column */}
      </div>{/* /outer flex card */}

      {/* Stack vertically on narrow screens — filter column drops above the funnel */}
      <style>{`
        @media (max-width: 880px) {
          .funnel-filter-col { width: 100% !important; }
          .funnel-filter-col + div { width: 100%; }
        }
      `}</style>
    </div>
  );
}
