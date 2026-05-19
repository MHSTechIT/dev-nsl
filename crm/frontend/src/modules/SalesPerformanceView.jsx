import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import SalesPerformanceDrillPanel from './SalesPerformanceDrillPanel';
import ReassignDistributionModal   from '../admin/ReassignDistributionModal';
import CallerActivityDrawer        from '../admin/CallerActivityDrawer';
import CallerPageDrawer            from '../admin/CallerPageDrawer';
import Toast                       from '../components/Toast';

/* ── small formatters ── */
function fmtDuration(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtHMS(sec) {
  if (!sec || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function minutesSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

/* ── date range helpers ── */
function rangeForPreset(preset) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const today = ymd(ist);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') {
    const start = new Date(ist); start.setUTCDate(start.getUTCDate() - 6);
    return { from: ymd(start), to: today };
  }
  if (preset === 'month') {
    const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1));
    return { from: ymd(start), to: today };
  }
  return { from: today, to: today };
}

/* ── filter pill ── */
function Pill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 50, border: 'none',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
        cursor: 'pointer', transition: 'all 150ms',
        background: active ? '#5B21B6' : 'rgba(91,33,182,0.08)',
        color: active ? '#fff' : 'rgba(91,33,182,0.70)',
        boxShadow: active ? '0 2px 8px rgba(91,33,182,0.30)' : 'none',
      }}
    >
      {label}
    </button>
  );
}

/* ── status pill (Active / Paused quick filter) ──
   Like Pill but with a colored dot beside the label so the eye can pick
   it out as a status filter, not a date filter. */
function StatusPill({ label, active, onClick, dotColor }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 50, border: 'none',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
        cursor: 'pointer', transition: 'all 150ms', whiteSpace: 'nowrap',
        background: active ? '#5B21B6' : '#fff',
        color: active ? '#fff' : 'rgba(91,33,182,0.75)',
        border: '1px solid ' + (active ? '#5B21B6' : 'rgba(139,92,246,0.25)'),
        boxShadow: active ? '0 2px 8px rgba(91,33,182,0.30)' : 'none',
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dotColor || '#5B21B6',
        boxShadow: active ? '0 0 0 1.5px #fff' : 'none',
      }} />
      {label}
    </button>
  );
}

/* ── trend arrow ── */
/* Pricing-table-style performance grid. Every card (label rail + caller
   cards + team total) wears the same violet header band so the row of
   headers reads as one continuous bar. Body of each card stays white. */
const UNIFIED_PALETTE = {
  bg:   'linear-gradient(180deg,#7C3AED,#5B21B6)',
  tint: '#FFFFFF',
};
const CALLER_PALETTE = [UNIFIED_PALETTE];
const TEAM_PALETTE   = {
  bg:   'linear-gradient(180deg,#7C3AED,#5B21B6)',
  tint: '#FFFFFF',
};

function PricingPerfTable({
  rows, tt, topRowId, nowTick,
  selectedRoles, toggleRole,
  openDrill, openMovePicker, togglePause, pauseBusyIds,
  openActivity, openCallerPage,
}) {
  // Click-to-highlight — track which label row the admin has selected.
  // Clicking the same label again clears the highlight. The wash applies
  // to every cell in that row across every caller card + the team total.
  const [highlightedRow, setHighlightedRow] = useState(null);
  function toggleHighlight(label) {
    setHighlightedRow(curr => (curr === label ? null : label));
  }

  /* Distinct roles in the current data + short labels for chips. */
  const ROLE_LABEL = {
    junior_caller: 'Junior',
    senior_caller: 'Senior',
    team_leader:   'Team Lead',
    manager:       'Manager',
    trainer:       'Trainer',
    admin:         'Admin',
  };
  const roleCategories = Array.from(new Set(rows.map(r => r.role))).sort();

  // Each metric row: label, optional drill filter, and a value-extractor.
  const METRICS = [
    { label: 'Assigned',    key: 'assigned',       drill: 'assigned'  },
    { label: 'Hot',         key: 'hot',            drill: 'hot',
      style: v => ({ color: v > 0 ? '#DC2626' : 'rgba(91,33,182,0.55)', fontWeight: 700 }) },
    { label: 'Warm',        key: 'warm',           drill: 'warm'      },
    { label: 'Touched',     key: 'touched',        drill: 'touched'   },
    { label: 'Untouched',   key: 'untouched',      drill: 'untouched' },
    { label: 'Follow-ups',  key: 'followups',      drill: 'follow_up',
      style: v => ({ color: v > 0 ? '#5B21B6' : 'rgba(91,33,182,0.55)', fontWeight: v > 0 ? 700 : 500 }) },
    { label: 'Total Calls', key: 'total_calls',    drill: 'calls', trend: 'total_calls_prev' },
    { label: 'Incoming',    key: 'incoming',       drill: 'in'        },
    { label: 'Outgoing',    key: 'outgoing',       drill: 'out'       },
    { label: 'Connected',   key: 'connected',      drill: 'connected' },
    { label: 'Conn %',      render: r => `${r.connection_rate_pct}%` },
    { label: 'Avg Dur',     render: r => fmtDuration(r.avg_duration_sec) },
    { label: 'Total Dur',   render: r => fmtHMS(r.total_duration_sec) },
  ];

  // Inline CSS scoped to this grid.
  //   • Wrapper scrolls horizontally if cards overflow.
  //   • Label column is sticky-left + has its own card look so it never
  //     slides under the caller cards as you scroll.
  //   • All "rows" (select-all/header, status, metrics) have fixed pixel
  //     heights so the leftmost label row visually aligns with the same
  //     row inside every caller card.
  const HEADER_H  = 56;    // colored header band + select-all box
  const STATUS_H  = 26;    // status badge row — slim
  const METRIC_H  = 22;    // each metric row — slim, no extra vertical gap
  const STYLES = `
    /* Vertical scroll container — fills the remaining viewport height after
       tabs + filter bar. Sticky headers inside stick to the TOP of this
       container so the metric rows scroll under them. Both scrollbars
       hidden visually — vertical/horizontal scroll still works via mouse
       wheel, shift+wheel, trackpad, or touch. */
    /* Two-wrapper trick to keep the horizontal scrollbar visible while
       hiding the vertical one entirely across all browsers (including
       Firefox, where you can't toggle per-axis scrollbar visibility):
         .pp-vclip — fixed max-height, clips right-edge overflow
         .pp-scroll — inner, extended 18px past the clip's right edge
                      via negative margin so its vertical scrollbar
                      lives in the clipped region and is invisible.
       Vertical mouse-wheel / trackpad / keyboard scrolling still works
       on .pp-scroll because the scroll mechanism is independent of
       whether the scrollbar UI is painted. */
    .pp-vclip {
      max-height: calc(100vh - 220px);
      overflow: hidden;
    }
    .pp-scroll {
      max-height: calc(100vh - 220px);
      overflow-x: auto;
      overflow-y: auto;
      margin-right: -18px;
      padding-right: 18px;
      scrollbar-width: thin;
      scrollbar-color: rgba(91,33,182,0.45) rgba(91,33,182,0.10);
      padding-bottom: 4px;
    }
    /* Themed horizontal scrollbar at the bottom of .pp-scroll. */
    .pp-scroll::-webkit-scrollbar           { width: 0; height: 10px; }
    .pp-scroll::-webkit-scrollbar:vertical  { width: 0; display: none; }
    .pp-scroll::-webkit-scrollbar-track     { background: rgba(91,33,182,0.10); border-radius: 8px; }
    .pp-scroll::-webkit-scrollbar-thumb     { background: rgba(91,33,182,0.45); border-radius: 8px; }
    .pp-scroll::-webkit-scrollbar-thumb:hover { background: rgba(91,33,182,0.65); }

    /* Parent grid drives both columns AND rows so each row auto-sizes to
       the tallest cell across all columns. Each child column (label col,
       caller cards, team total) opts in to the row tracks via CSS subgrid,
       which keeps every cell in row N the same height regardless of which
       column they sit in — and grows the row when any cell needs more
       vertical room (e.g. a wrapped caller name).
       Row tracks:
         1   = header band (CATEGORIES / name+role / TEAM TOTAL)
         2   = status badge
         3…N = one row per metric */
    .pp-grid { display: grid; gap: 14px; padding: 4px 4px 16px;
               grid-template-columns: 180px repeat(${rows.length + 1}, minmax(170px, 1fr));
               grid-template-rows: auto auto repeat(${METRICS.length}, auto); }

    /* Label column = white card with a violet header band (matching the
       caller cards). Sticky-left so it stays put when caller cards scroll
       horizontally underneath it. Slight extra shadow on the right edge
       hints at the scroll boundary.

       NOTE: must be overflow: visible — overflow: hidden on a parent
       breaks position: sticky on any descendant (the .pp-select-all band
       sticks to the page top). Rounded corners are applied to the first
       and last children directly instead of clipping the whole column. */
    .pp-label-col {
      display: grid; grid-template-rows: subgrid;
      grid-row: 1 / span ${2 + METRICS.length};
      background: #fff;
      border-radius: 8px;
      border: 1px solid rgba(209,196,240,0.45);
      box-shadow: 0 6px 18px rgba(91,33,182,0.10), 4px 0 12px -8px rgba(91,33,182,0.18);
      overflow: visible;
      /* z-index 22 outranks the sticky-top caller card headers (z-index
         20) so the leftmost CATEGORIES column always sits on top of any
         caller-card content as it scrolls past horizontally. The
         CATEGORIES header band (.pp-select-all) inside this column then
         goes one notch higher (z-index 23, set below) so the corner
         cell wins both axes. */
      position: sticky; left: 0; z-index: 22;
    }
    .pp-label-col > :last-child { border-bottom-left-radius: 8px; border-bottom-right-radius: 8px; }

    .pp-card { display: grid; grid-template-rows: subgrid;
               grid-row: 1 / span ${2 + METRICS.length};
               border-radius: 8px; background: #fff;
               box-shadow: 0 6px 18px rgba(91,33,182,0.10);
               border: 1px solid rgba(209,196,240,0.45);
               /* visible: so the sticky header can stick to the page-top */
               overflow: visible; }
    /* Caller-card header — 3-column grid so the checkbox is vertically
       centered on the LEFT (matching Select-all in the label column) and
       the kebab is vertically centered on the RIGHT. The name + role
       stack fills the center column. */
    .pp-card-head { min-height: ${HEADER_H}px; padding: 4px 10px; color: #fff; text-align: center;
                    position: sticky; top: 0; z-index: 20;
                    display: flex; align-items: center; justify-content: center;
                    border-top-left-radius: 8px; border-top-right-radius: 8px; }
    .pp-card-head .pp-name-stack { display: flex; flex-direction: column;
                                    align-items: center; justify-content: center; gap: 1px;
                                    width: 100%; }
    /* Kebab sits absolutely so it doesn't push the name stack off-centre. */
    .pp-card-head .pp-kebab { position: absolute; right: 8px; top: 50%;
                              transform: translateY(-50%); }
    /* Three-dot button is transparent with white dots so it reads as part
       of the violet header band. Hover gets a faint translucent white wash
       so the affordance is still visible. */
    .pp-kebab > div > button {
      background: transparent !important;
      color: #fff !important;
      box-shadow: none !important;
    }
    .pp-kebab > div > button:hover {
      background: rgba(255,255,255,0.18) !important;
    }
    .pp-name { font-family: Outfit, sans-serif; font-weight: 800; font-size: 0.92rem;
               letter-spacing: 0.02em; color: #fff;
               overflow-wrap: anywhere; line-height: 1.15; }
    .pp-role { font-family: Outfit, sans-serif; font-size: 0.62rem; font-weight: 600;
               text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.85); }

    .pp-status-cell { min-height: ${STATUS_H}px; padding: 0 8px; display: flex; justify-content: center;
                      align-items: center; border-bottom: 1px solid rgba(209,196,240,0.30); }
    .pp-metric-row  { min-height: ${METRIC_H}px; padding: 0 8px; text-align: center;
                      font-family: Outfit, sans-serif; font-size: 0.92rem; color: #3B0764;
                      border-bottom: 1px solid rgba(209,196,240,0.25);
                      display: flex; align-items: center; justify-content: center; }
    .pp-metric-row:last-child { border-bottom: none; }
    .pp-metric-row button { background: transparent; border: none; cursor: pointer;
                             padding: 4px 10px; border-radius: 6px; font: inherit; color: inherit;
                             transition: background 120ms; }
    .pp-metric-row button:hover { background: rgba(91,33,182,0.08); }

    /* Left-column rows mirror the heights above so labels line up exactly.
       Violet header band at the top (matches caller card heads), then
       neutral violet-on-white label rows below. Each row is clickable —
       see the .pp-row-active style for the highlighted state. */
    .pp-select-all  { min-height: ${HEADER_H}px; padding: 6px 10px;
                      display: flex; flex-direction: column; align-items: center;
                      justify-content: center; gap: 4px;
                      font-family: Outfit, sans-serif; color: #fff;
                      background: linear-gradient(180deg,#7C3AED,#5B21B6);
                      position: sticky; top: 0; z-index: 23;
                      border-top-left-radius: 8px; border-top-right-radius: 8px; }
    .pp-categories-label { font-size: 0.62rem; font-weight: 700;
                            text-transform: uppercase; letter-spacing: 0.10em;
                            color: rgba(255,255,255,0.85); }
    .pp-categories-chips { display: flex; flex-wrap: wrap; gap: 4px;
                            justify-content: center; }
    .pp-cat-chip { padding: 2px 8px; border-radius: 50;
                   border: 1px solid rgba(255,255,255,0.45);
                   background: rgba(255,255,255,0.10);
                   color: #fff;
                   font-family: Outfit, sans-serif; font-size: 0.62rem;
                   font-weight: 700; letter-spacing: 0.02em;
                   cursor: pointer; transition: background 120ms; }
    .pp-cat-chip:hover { background: rgba(255,255,255,0.22); }
    .pp-cat-chip[data-active="true"] {
      background: #fff; color: #5B21B6; border-color: #fff;
      box-shadow: 0 0 0 1.5px rgba(255,255,255,0.40);
    }
    .pp-label-status { min-height: ${STATUS_H}px; padding: 0 14px; font-family: Outfit, sans-serif;
                       font-weight: 700; font-size: 0.70rem; text-transform: uppercase;
                       letter-spacing: 0.06em; color: rgba(91,33,182,0.65);
                       border-bottom: 1px solid rgba(209,196,240,0.30);
                       display: flex; align-items: center;
                       cursor: pointer; transition: background 120ms; }
    .pp-label-row    { min-height: ${METRIC_H}px; padding: 0 14px; font-family: Outfit, sans-serif;
                       font-weight: 700; font-size: 0.70rem; text-transform: uppercase;
                       letter-spacing: 0.06em; color: rgba(91,33,182,0.65);
                       border-bottom: 1px solid rgba(209,196,240,0.25);
                       display: flex; align-items: center;
                       cursor: pointer; transition: background 120ms; }
    .pp-label-row:last-child { border-bottom: none; }
    .pp-label-status:hover, .pp-label-row:hover { background: rgba(91,33,182,0.05); }

    /* Click-to-highlight: when the user clicks a row's label, the active
       state lights up that label AND every corresponding cell in every
       caller card with a soft violet wash. */
    .pp-row-active { background: rgba(91,33,182,0.12) !important; }
    .pp-row-active.pp-label-status, .pp-row-active.pp-label-row {
      color: #5B21B6; box-shadow: inset 3px 0 0 #5B21B6;
    }

    @media (max-width: 900px) {
      .pp-grid { grid-template-columns: 1fr; }
      .pp-label-col { display: none; position: static; }
    }
  `;

  return (
    <>
      <style>{STYLES}</style>
      <div className="pp-vclip">
      <div className="pp-scroll">
      <div className="pp-grid">
        {/* Leftmost column: role-category chips + Status label + metric
            labels. The "Select all" checkbox is gone — category chips
            replace it, acting as quick filters on the caller roles. */}
        <div className="pp-label-col">
          <div className="pp-select-all">
            <div className="pp-categories-label">CATEGORIES</div>
          </div>
          <div
            className={`pp-label-status${highlightedRow === '__status__' ? ' pp-row-active' : ''}`}
            onClick={() => toggleHighlight('__status__')}
            title="Highlight this row across all callers"
          >Status</div>
          {METRICS.map(m => (
            <div
              key={m.label}
              className={`pp-label-row${highlightedRow === m.label ? ' pp-row-active' : ''}`}
              onClick={() => toggleHighlight(m.label)}
              title="Highlight this row across all callers"
            >{m.label}</div>
          ))}
        </div>

        {/* One card per caller */}
        {rows.map((r, i) => {
          // Top-performer + idle indicators are intentionally NOT rendered
          // in the card header per design (live Status badge below the
          // header already conveys real-time activity).
          const palette = CALLER_PALETTE[i % CALLER_PALETTE.length];
          return (
            <div className="pp-card" key={r.caller_id} style={{ background: palette.tint }}>
              <div className="pp-card-head" style={{ background: palette.bg }}>
                <div className="pp-name-stack">
                  <div className="pp-name">{r.name}</div>
                  <div className="pp-role">{r.role.replace('_', ' ')}</div>
                  {/* PAUSED pill kept (real admin state). */}
                  {r.is_active === false && (
                    <span style={{ background: 'rgba(255,255,255,0.25)', color: '#fff', padding: '1px 7px', borderRadius: 50, fontSize: '0.56rem', fontWeight: 800, letterSpacing: '0.04em' }}>PAUSED</span>
                  )}
                </div>
                <div className="pp-kebab">
                  <RowMenuButton
                    row={r}
                    busyPause={pauseBusyIds.has(r.caller_id)}
                    onMove={openMovePicker}
                    onView={(row) => openDrill(row.caller_id, 'assigned')}
                    onTogglePause={togglePause}
                    onCallerPage={openCallerPage}
                  />
                </div>
              </div>
              <div
                className={`pp-status-cell${highlightedRow === '__status__' ? ' pp-row-active' : ''}`}
                onClick={() => openActivity?.(r)}
                title="View activity log"
                style={{ cursor: openActivity ? 'pointer' : 'default' }}
              >
                <StatusBadge row={r} nowTick={nowTick} />
              </div>
              {METRICS.map(m => {
                const raw = m.render ? m.render(r) : r[m.key];
                const isClickable = !!m.drill;
                const cellStyle = m.style ? m.style(r[m.key]) : null;
                const activeClass = highlightedRow === m.label ? ' pp-row-active' : '';
                return (
                  <div key={m.label} className={`pp-metric-row${activeClass}`} style={cellStyle}>
                    {isClickable ? (
                      <button onClick={() => openDrill(r.caller_id, m.drill)} title={`View ${m.label.toLowerCase()}`}>
                        {raw}
                        {m.trend && <TrendArrow now={r[m.key]} prev={r[m.trend]} />}
                      </button>
                    ) : raw}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Team Total card on the right */}
        {tt && (
          <div className="pp-card" style={{ background: TEAM_PALETTE.tint }}>
            <div className="pp-card-head" style={{ background: TEAM_PALETTE.bg }}>
              <div className="pp-name-stack">
                <div className="pp-name">Team Total</div>
                <div className="pp-role">All callers</div>
              </div>
            </div>
            <div
              className={`pp-status-cell${highlightedRow === '__status__' ? ' pp-row-active' : ''}`}
              style={{ color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem' }}
            >—</div>
            {METRICS.map(m => {
              const raw = m.render
                ? (m.render === undefined ? tt[m.key] : ({
                    'Conn %':     `${tt.connection_rate_pct}%`,
                    'Avg Dur':    fmtDuration(tt.avg_duration_sec),
                    'Total Dur':  fmtHMS(tt.total_duration_sec),
                  }[m.label] ?? tt[m.key]))
                : tt[m.key];
              const activeClass = highlightedRow === m.label ? ' pp-row-active' : '';
              return (
                <div
                  key={m.label}
                  className={`pp-metric-row${activeClass}`}
                  style={{ fontWeight: 800, color: '#3B0764' }}
                >
                  {raw}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
      </div>
    </>
  );
}

/* Live caller-status badge.
   Tracking window: 9 AM – 6 PM IST. Outside this window we render a dash and
   skip color logic entirely so admins don't see stale heartbeat data flagged
   red overnight.
     Green  = working (in a call OR auto-call mode)
     Orange = on a break, within the allotted minutes
     Red    = idle, break overrun, or heartbeat older than 90s ("Offline").
              Red shows the continuous rest time computed from rest_started_at.
*/
function fmtRest(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function StatusBadge({ row, nowTick }) {
  const now = nowTick;
  // IST hour
  const istHr = new Date(now + 5.5 * 3600 * 1000).getUTCHours();
  const inWorkWindow = istHr >= 9 && istHr < 18;
  if (!inWorkWindow) {
    return (
      <span title="Tracking window is 9 AM – 6 PM IST" style={{
        display: 'inline-block', padding: '3px 10px', borderRadius: 50,
        fontSize: '0.68rem', fontWeight: 700,
        background: 'rgba(107,114,128,0.12)', color: '#6B7280',
        whiteSpace: 'nowrap',
      }}>Off hours</span>
    );
  }

  const hbAge = row.last_heartbeat_at
    ? now - new Date(row.last_heartbeat_at).getTime()
    : Infinity;

  // Offline = no heartbeat in 90s. Treat as red with rest time.
  if (hbAge > 90_000) {
    const restMs = row.rest_started_at
      ? Math.max(0, now - new Date(row.rest_started_at).getTime())
      : null;
    return (
      <span title={`No heartbeat in ${Math.floor(hbAge/1000)}s`} style={badgeStyleByColor('red')}>
        Offline{restMs != null && ` · ${fmtRest(restMs)}`}
      </span>
    );
  }

  if (row.activity_status === 'working') {
    return <span style={badgeStyleByColor('green')}>Working</span>;
  }

  if (row.activity_status === 'on_break') {
    const b = row.activity_break || {};
    const endsAtMs = b.endsAt ? new Date(b.endsAt).getTime()
                    : (typeof b.endsAt === 'number' ? b.endsAt : null);
    const overrun  = endsAtMs && now > endsAtMs;
    if (overrun) {
      const restMs = row.rest_started_at
        ? Math.max(0, now - new Date(row.rest_started_at).getTime())
        : 0;
      return (
        <span title={`Break overrun — was ${b.reason || 'on break'}`} style={badgeStyleByColor('red')}>
          Overrun · {fmtRest(restMs)}
        </span>
      );
    }
    return (
      <span title={b.reason || 'On break'} style={badgeStyleByColor('orange')}>
        {b.reason || 'Break'}
      </span>
    );
  }

  // Idle (no work, no break, but heartbeating recently).
  const restMs = row.rest_started_at
    ? Math.max(0, now - new Date(row.rest_started_at).getTime())
    : 0;
  return (
    <span style={badgeStyleByColor('red')}>
      Resting · {fmtRest(restMs)}
    </span>
  );
}
function badgeStyleByColor(c) {
  const palettes = {
    green:  { bg: 'rgba(5,150,105,0.15)',  fg: '#047857' },
    orange: { bg: 'rgba(245,158,11,0.18)', fg: '#B45309' },
    red:    { bg: 'rgba(220,38,38,0.14)',  fg: '#B91C1C' },
  };
  const p = palettes[c] || palettes.red;
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.68rem', fontWeight: 700,
    background: p.bg, color: p.fg,
    whiteSpace: 'nowrap', fontFamily: 'Outfit, sans-serif',
  };
}

/* Numeric cell that opens the drill panel pre-filtered to its column. The
   inner button stops click propagation so the row's onClick (which would
   open the panel with the default Assigned filter) doesn't double-fire. */
function DrillCell({ value, onOpen, title, style, children }) {
  const display = children !== undefined ? children : value;
  const muted = !children && (value === 0 || value === null || value === undefined);
  return (
    <td style={{ padding: '4px 8px' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen?.(); }}
        title={title}
        style={{
          width: '100%', minHeight: 26, padding: '4px 8px',
          border: 'none', background: 'transparent', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 'inherit', textAlign: 'right',
          color: muted ? 'rgba(91,33,182,0.55)' : '#3B0764',
          borderRadius: 6, transition: 'background 120ms',
          ...(style || {}),
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {display}
      </button>
    </td>
  );
}

function TrendArrow({ now, prev }) {
  if (prev == null || (now === 0 && prev === 0)) return null;
  if (now > prev) return <span title={`Prev: ${prev}`} style={{ color: '#059669', marginLeft: 4, fontSize: '0.72rem' }}>▲</span>;
  if (now < prev) return <span title={`Prev: ${prev}`} style={{ color: '#DC2626', marginLeft: 4, fontSize: '0.72rem' }}>▼</span>;
  return <span title={`Prev: ${prev}`} style={{ color: 'rgba(91,33,182,0.40)', marginLeft: 4, fontSize: '0.72rem' }}>–</span>;
}

/* ── per-row kebab menu ──
   Three actions:
     1. Move leads      — opens scope picker (all_open vs followups_for_date),
                          then mounts ReassignDistributionModal in the parent.
     2. View call log   — re-uses the existing setDrillId hook to open
                          SalesPerformanceDrillPanel. Same as clicking the row.
     3. Pause / Resume  — toggles crm_users.is_active via the admin PATCH.
                          Disabled while a previous toggle is in flight.

   Stops click propagation so the row's drill-down click isn't triggered. */
function RowMenuButton({ row, busyPause, onMove, onView, onTogglePause, onCallerPage }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const menuRef    = useRef(null);
  // Anchor position the menu relative to the trigger using
  // getBoundingClientRect, then portal the menu to <body> so it escapes
  // any ancestor's stacking context (sticky table headers, transformed
  // drawers, etc.). Without this the dropdown rendered BEHIND the next
  // table cells because the sticky header creates a fresh stacking
  // context that traps absolute children.
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      const inTrigger = wrapperRef.current && wrapperRef.current.contains(e.target);
      const inMenu    = menuRef.current    && menuRef.current.contains(e.target);
      if (!inTrigger && !inMenu) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isPaused = row.is_active === false;
  const itemStyle = (danger) => ({
    width: '100%', textAlign: 'left', padding: '8px 12px',
    borderRadius: 6, border: 'none', background: 'transparent',
    color: danger ? '#B91C1C' : '#3B0764',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', fontWeight: 600,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 8,
  });

  function close() { setOpen(false); }
  function handleItem(fn) { return (e) => { e.stopPropagation(); close(); fn?.(row); }; }

  function toggleOpen(e) {
    e.stopPropagation();
    if (!open && wrapperRef.current) {
      // Anchor the menu's top-right corner to the trigger's bottom-right.
      // Using viewport coords because the menu is portaled to <body>,
      // which is positioned relative to the viewport.
      const r = wrapperRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.right - 200 });   // 200 = menu min-width
    }
    setOpen(v => !v);
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-label={`Actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: 28, height: 28, borderRadius: 6, border: 'none',
          background: open ? 'rgba(91,33,182,0.12)' : 'transparent',
          color: '#5B21B6', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 150ms',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'rgba(91,33,182,0.08)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5"  r="1.7"/>
          <circle cx="12" cy="12" r="1.7"/>
          <circle cx="12" cy="19" r="1.7"/>
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed', top: menuPos.top, left: menuPos.left,
            minWidth: 200, background: '#fff', borderRadius: 10,
            border: '1px solid rgba(209,196,240,0.60)',
            boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
            padding: 6, zIndex: 99999,
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          <button role="menuitem" onClick={handleItem(onMove)} style={itemStyle(false)}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/>
              <polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/>
              <line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>
            </svg>
            Move leads
          </button>
          <button role="menuitem" onClick={handleItem(onView)} style={itemStyle(false)}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            View call log
          </button>
          {/* Caller page — opens a side drawer that shows the caller's
              own Assigned / Completed / Not Picked buckets and lets the
              admin bulk-reopen any completed lead back to Assigned. Only
              rendered when the parent wired up onCallerPage so older
              usages of RowMenuButton stay compatible. */}
          {typeof onCallerPage === 'function' && (
            <button role="menuitem" onClick={handleItem(onCallerPage)} style={itemStyle(false)}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(91,33,182,0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {/* layout-grid icon */}
                <rect x="3" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
              Caller page
            </button>
          )}
          <button
            role="menuitem"
            disabled={busyPause}
            onClick={handleItem(onTogglePause)}
            style={{
              ...itemStyle(!isPaused),
              opacity: busyPause ? 0.55 : 1,
              cursor: busyPause ? 'wait' : 'pointer',
            }}
            onMouseEnter={e => { if (!busyPause) e.currentTarget.style.background = isPaused ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.08)'; }}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {isPaused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
            )}
            {busyPause ? '…' : (isPaused ? 'Resume caller' : 'Pause caller')}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ── salesperson dropdown ── */
function SalespersonSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 180 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', height: '2.1rem', borderRadius: 10,
          border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
          padding: '0 32px 0 12px', fontFamily: 'Outfit, sans-serif',
          fontSize: '0.82rem', fontWeight: 600, color: '#3B0764',
          cursor: 'pointer', outline: 'none', textAlign: 'left',
          position: 'relative',
        }}
      >
        {selected ? selected.label : 'All salespeople'}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: '#fff', borderRadius: 12, border: '1px solid rgba(139,92,246,0.20)',
          boxShadow: '0 8px 24px rgba(91,33,182,0.15)', zIndex: 50,
          padding: '4px 0', maxHeight: 240, overflowY: 'auto',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                width: '100%', border: 'none', background: value === opt.value ? 'rgba(91,33,182,0.08)' : 'transparent',
                padding: '8px 14px', fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem',
                fontWeight: value === opt.value ? 700 : 500,
                color: value === opt.value ? '#5B21B6' : '#3B0764',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── row tint logic ── */
function rowBg(row, isTopPerformer) {
  // No-activity flag wins
  if (row.assigned > 0 && row.touched === 0) return 'rgba(254,215,170,0.30)';
  if (isTopPerformer) return 'rgba(254,243,199,0.45)';
  const c = row.conversion_pct || 0;
  if (c >= 5) return 'rgba(220,252,231,0.40)';
  if (c >= 1) return 'rgba(254,249,195,0.30)';
  if (row.assigned > 0) return 'rgba(254,226,226,0.35)';
  return 'transparent';
}

/* ── CSV export ──
   EXPORT_COLUMNS lists the category buckets the admin can pick. Each id
   is a server-side category filter — the backend returns the set of
   UNIQUE leads that match ANY selected bucket (no duplicates even if a
   lead falls into multiple buckets, e.g. hot + touched). Each lead row
   carries c_<bucket>=1 flags which we collapse into a "Matched" column
   so the admin can see which categories caught each lead. */
const EXPORT_COLUMNS = [
  { id: 'assigned',    header: 'Assigned'    },
  { id: 'hot',         header: 'Hot'         },
  { id: 'warm',        header: 'Warm'        },
  { id: 'touched',     header: 'Touched'     },
  { id: 'untouched',   header: 'Untouched'   },
  { id: 'follow_up',   header: 'Follow_Ups'  },
  { id: 'total_calls', header: 'Total_Calls' },
  { id: 'incoming',    header: 'Incoming'    },
  { id: 'outgoing',    header: 'Outgoing'    },
  { id: 'connected',   header: 'Connected'   },
];

function leadsToCsv(leads, selectedIds) {
  /* Fixed lead-level columns + a Matched column that lists the buckets
     each lead fell into. We include only the bucket flags the admin
     actually selected, so the matched-categories column reflects their
     filter choices. */
  const header = [
    'Lead_ID', 'Full_Name', 'WhatsApp', 'Email', 'Language',
    'Sugar_Level', 'Diabetes_Duration', 'Lead_Score', 'Lead_Tag',
    'Last_Outcome', 'Assigned_To', 'Assigned_To_Role',
    'Assigned_At', 'Last_Note_At', 'Completed_At',
    'Matched_Categories',
  ];
  const fmtTs = ts => ts ? new Date(ts).toISOString() : '';
  const body = leads.map(l => {
    const matched = EXPORT_COLUMNS
      .filter(c => selectedIds.has(c.id) && l[`c_${c.id}`] === 1)
      .map(c => c.header)
      .join('|');
    return [
      l.id, l.full_name, l.whatsapp_number, l.email, l.language_pref,
      l.sugar_level, l.diabetes_duration, l.lead_score, l.lead_tag,
      l.last_note_outcome, l.assigned_to_name, l.assigned_to_role,
      fmtTs(l.assigned_at), fmtTs(l.last_note_at), fmtTs(l.completed_at),
      matched,
    ];
  });
  return [header, ...body].map(row => row.map(v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ══════════════════ Main component ══════════════════ */
export default function SalesPerformanceView({ token, actionsSlotEl }) {
  const [data, setData]         = useState({ rows: [], team_totals: null, hot_to_enroll_ratio: 0, window: null });
  const [callers, setCallers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [lastUpdated, setLastUpdated] = useState('');

  const [preset, setPreset]     = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [webinarId,  setWebinarId]  = useState('');     // '' = all webinars
  const [webinars,   setWebinars]   = useState([]);     // for the dropdown
  /* Multi-select set of caller-ids. Empty set = "all salespeople". */
  const [salespeopleSel, setSalespeopleSel] = useState(() => new Set());
  /* Tri-state status quick-filter:
       'all'    — every caller (default)
       'active' — only is_active = true
       'paused' — only is_active = false */
  const [statusFilter, setStatusFilter] = useState('all');
  const [salespeopleOpen, setSalespeopleOpen] = useState(false);
  const salespeopleRef = useRef(null);
  const [salespeopleQuery, setSalespeopleQuery] = useState('');

  /* Webinar dropdown — converted from native <select> to a custom panel
     so we can embed a search input inside it. */
  const [webinarOpen,  setWebinarOpen]  = useState(false);
  const [webinarQuery, setWebinarQuery] = useState('');
  const webinarRef = useRef(null);

  /* Custom date range picker — calendar popup that replaces the native
     <input type="date"> pair. customFrom / customTo are still strings in
     YYYY-MM-DD format (kept compatible with the rest of the page). */
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const customRangeRef = useRef(null);
  const [customMonth, setCustomMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };  // month 0-indexed
  });
  /* Display-only time row in the picker (matches the mockup). Stored but
     not yet plumbed into the API request — date precision is sufficient
     for the performance query. */
  const [customTime, setCustomTime] = useState({ hh: '11', mm: '59', ampm: 'PM' });

  /* Categories multi-select dropdown — combines status (Active/Paused) and
     role (Junior/Senior/Team Lead/Manager/Trainer/Admin) into a single
     filter pane with checkboxes. Values are namespaced strings like
     'status:active' or 'role:junior_caller'. Empty set = no filtering. */
  const [categoriesSel,  setCategoriesSel]  = useState(() => new Set());
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categoriesRef = useRef(null);
  function toggleCategory(value) {
    setCategoriesSel(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }
  const CATEGORY_GROUPS = [
    {
      title: 'Status',
      items: [
        { value: 'status:active', label: 'Active',  dot: '#059669' },
        { value: 'status:paused', label: 'Paused',  dot: '#DC2626' },
      ],
    },
    {
      title: 'Role',
      items: [
        { value: 'role:junior_caller', label: 'Junior' },
        { value: 'role:senior_caller', label: 'Senior' },
      ],
    },
  ];
  const [drillId,     setDrillId]     = useState(null);
  const [drillFilter, setDrillFilter] = useState('assigned');  // which numeric column was clicked
  /* Activity drawer state — opened by clicking the Status pill in a
     caller's column header. Holds the row so we can show name + role
     in the drawer header. */
  const [activityRow, setActivityRow] = useState(null);
  function openActivity(row) { setActivityRow(row); }
  // "Caller page" drawer — admin view of all a caller's leads with the
  // ability to bulk-reopen completed leads back to Assigned.
  const [callerPageRow, setCallerPageRow] = useState(null);
  function openCallerPage(row) { setCallerPageRow(row); }

  /* Export modal — opens when admin clicks Export CSV. The set holds
     which optional metric columns to include; identity columns
     (Salesperson + Role) are always written regardless. Default = every
     metric column selected. */
  const [exportOpen,    setExportOpen]    = useState(false);
  const [exportBusy,    setExportBusy]    = useState(false);
  const [exportError,   setExportError]   = useState('');
  const [exportSelected, setExportSelected] = useState(() => new Set(EXPORT_COLUMNS.map(c => c.id)));
  function toggleExportCol(id) {
    setExportSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllExportCols() { setExportSelected(new Set(EXPORT_COLUMNS.map(c => c.id))); }
  function clearAllExportCols()  { setExportSelected(new Set()); }
  async function confirmExport() {
    if (exportSelected.size === 0 || exportBusy) return;
    setExportBusy(true);
    setExportError('');
    try {
      const params = new URLSearchParams({
        from: range.from, to: range.to,
        categories: Array.from(exportSelected).join(','),
      });
      if (webinarId) params.set('webinar_id', webinarId);
      const r = await fetch(`/api/admin/sales-performance/leads-export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const csv = leadsToCsv(d.leads || [], exportSelected);
      downloadCsv(csv, `sales-leads-${range.from}_to_${range.to}.csv`);
      setExportOpen(false);
    } catch (err) {
      setExportError(err.message || 'Export failed');
    } finally {
      setExportBusy(false);
    }
  }

  /* Open the per-caller drill panel pre-filtered to a specific cell. */
  function openDrill(callerId, filterId) {
    setDrillFilter(filterId || 'assigned');
    setDrillId(callerId);
  }

  /* Kebab-menu state */
  const [movePickerRow, setMovePickerRow] = useState(null);   // row → pick scope step
  const [moveCtx,       setMoveCtx]       = useState(null);   // { row, scope, date, total, workload }
  const [pauseBusyIds,  setPauseBusyIds]  = useState(() => new Set());
  const [toast,         setToast]         = useState('');
  const [toastKind,     setToastKind]     = useState('success');

  /* nowTick — re-renders the Status column's elapsed-time badge every second
     so "Resting 1h 23m" updates smoothly without re-fetching the API. */
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Role-category filter — replaces the old per-row checkbox column.
     The pricing-table header shows one chip per distinct role; clicking a
     chip narrows the visible rows to that role. Multi-select. */
  const [selectedRoles, setSelectedRoles] = useState(() => new Set());
  function toggleRole(role) {
    setSelectedRoles(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  }
  /* Legacy selection API — kept as no-op stubs so any straggler call sites
     in the gated legacy table below don't throw. The new UI no longer uses
     per-row selection. */
  const selectedIds = useMemo(() => new Set(), []);
  function toggleRow() {}
  function toggleAll() {}

  const range = preset === 'custom' && customFrom
    ? { from: customFrom, to: customTo || customFrom }
    : rangeForPreset(preset);

  /* Salesperson list — still used internally by other parts of the page
     (e.g. Move-leads picker). Webinar dropdown replaces the salesperson
     filter, but the underlying caller list is still loaded for reuse. */
  useEffect(() => {
    fetch('/api/admin/crm-users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const filtered = (d.users || []).filter(u =>
          u.is_active && ['junior_caller','senior_caller','team_leader','manager'].includes(u.role)
        );
        setCallers(filtered);
      })
      .catch(() => {});
  }, [token]);

  /* Webinar list for the dropdown — same endpoint Sales Leads uses. */
  useEffect(() => {
    fetch('/api/admin/webinars', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setWebinars(d.webinars || []))
      .catch(() => {});
  }, [token]);

  const fetchData = useCallback(async () => {
    setError('');
    // salesperson + status filters are applied client-side now (see
    // `visibleRows` below) — they're cheap multi-select filters that we
    // don't need to round-trip to the server for.
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (webinarId) params.set('webinar_id', webinarId);
    try {
      const res = await fetch(`/api/admin/sales-performance?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load sales performance');
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [token, range.from, range.to, webinarId]);

  /* Outside-click closes the salespeople multi-select dropdown. */
  useEffect(() => {
    if (!salespeopleOpen) return undefined;
    function onDocClick(e) {
      if (salespeopleRef.current && !salespeopleRef.current.contains(e.target)) setSalespeopleOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [salespeopleOpen]);

  /* Outside-click closes the categories multi-select dropdown. */
  useEffect(() => {
    if (!categoriesOpen) return undefined;
    function onDocClick(e) {
      if (categoriesRef.current && !categoriesRef.current.contains(e.target)) setCategoriesOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [categoriesOpen]);

  /* Outside-click closes the webinar custom dropdown. */
  useEffect(() => {
    if (!webinarOpen) return undefined;
    function onDocClick(e) {
      if (webinarRef.current && !webinarRef.current.contains(e.target)) setWebinarOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [webinarOpen]);

  /* Outside-click closes the custom date-range picker. */
  useEffect(() => {
    if (!customRangeOpen) return undefined;
    function onDocClick(e) {
      if (customRangeRef.current && !customRangeRef.current.contains(e.target)) setCustomRangeOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [customRangeOpen]);

  /* Visible rows = data.rows after applying:
       • the multi-select salesperson filter
       • the active/paused status quick-filter pills
       • the in-table role chips (selectedRoles)
       • the unified Categories dropdown (status + role, multi-select)
     Within Categories, status entries OR together, role entries OR together,
     and the two groups AND. So e.g. {Active, Junior, Senior} → only active
     juniors + active seniors. Server returns every caller; we narrow client-side. */
  const catStatuses = Array.from(categoriesSel).filter(v => v.startsWith('status:')).map(v => v.slice(7));
  const catRoles    = Array.from(categoriesSel).filter(v => v.startsWith('role:'  )).map(v => v.slice(5));
  const visibleRows = data.rows.filter(r => {
    if (statusFilter === 'active' && r.is_active === false) return false;
    if (statusFilter === 'paused' && r.is_active !== false) return false;
    if (salespeopleSel.size > 0 && !salespeopleSel.has(r.caller_id)) return false;
    if (selectedRoles.size > 0 && !selectedRoles.has(r.role)) return false;
    if (catStatuses.length > 0) {
      const rowStatus = r.is_active === false ? 'paused' : 'active';
      if (!catStatuses.includes(rowStatus)) return false;
    }
    if (catRoles.length > 0 && !catRoles.includes(r.role)) return false;
    return true;
  });

  useEffect(() => { fetchData(); }, [fetchData]);

  /* Auto refresh every 30 s */
  useEffect(() => {
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  /* ── Kebab actions ───────────────────────────────────────────────────── */

  function showToast(msg, kind = 'success') {
    setToastKind(kind);
    setToast(msg);
  }

  /* Step 1 of Move — open scope picker for this row. */
  function openMovePicker(row) { setMovePickerRow(row); }
  function closeMovePicker()   { setMovePickerRow(null); }

  /* Step 2 of Move — caller picked scope + (maybe) date. Fetch the workload
     for the chosen date so the distribution modal can show "X currently open"
     per teammate, compute the total, then open the shared modal. */
  async function confirmMoveScope({ scope, date }) {
    const row = movePickerRow;
    if (!row) return;
    closeMovePicker();
    try {
      const url = `/api/admin/caller-workload?date=${encodeURIComponent(date)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load workload.');
      const data = await res.json();
      const workload = data.callers || [];
      const src = workload.find(c => c.id === row.caller_id);
      const total = src
        ? (scope === 'followups_for_date' ? src.followups_for_date : src.total_open)
        : 0;
      if (!total || total <= 0) {
        showToast(
          scope === 'followups_for_date'
            ? `${row.name} has no follow-ups for ${date}.`
            : `${row.name} has no open leads to move.`,
          'info'
        );
        return;
      }
      setMoveCtx({
        row,
        scope,
        date,
        total,
        workload,
        fromCaller: { id: row.caller_id, full_name: row.name },
      });
    } catch (e) {
      showToast(e.message || 'Move failed.', 'error');
    }
  }
  function closeMove() { setMoveCtx(null); }

  function handleMoved({ moved, remaining, breakdown, fromName }) {
    const stayed = remaining > 0 ? ` (${remaining} stay with ${fromName})` : '';
    showToast(`Moved ${moved} lead${moved === 1 ? '' : 's'} → ${breakdown}${stayed}`);
    closeMove();
    fetchData();
  }

  /* Pause / Resume — PATCH /api/admin/crm-users/:id { is_active }.
     Optimistic: keep the row in busy state until response, then refetch. */
  async function togglePause(row) {
    const id = row.caller_id;
    if (pauseBusyIds.has(id)) return;
    setPauseBusyIds(prev => new Set(prev).add(id));
    const targetActive = !(row.is_active !== false);   // flipping from current
    try {
      const res = await fetch(`/api/admin/crm-users/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ is_active: targetActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update caller.');
      showToast(targetActive ? `${row.name} resumed.` : `${row.name} paused.`);
      await fetchData();
    } catch (e) {
      showToast(e.message || 'Failed to toggle pause.', 'error');
    } finally {
      setPauseBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  /* Top performer — highest conversion among rows with at least 1 enrollment */
  const topRowId = (() => {
    const candidates = data.rows.filter(r => r.enrolled > 0);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.conversion_pct > a.conversion_pct ? b : a)).caller_id;
  })();

  const tt = data.team_totals;
  const ratio = data.hot_to_enroll_ratio || 0;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <style>{`
        .sp-table { width: 100%; border-collapse: collapse; min-width: 1100px; font-size: 0.82rem; }
        .sp-table th, .sp-table td { padding: 10px 8px; text-align: right; white-space: nowrap; border-right: 1px solid rgba(209,196,240,0.35); }
        .sp-table th:last-child, .sp-table td:last-child { border-right: none; }
        .sp-table th { background: rgba(237,234,248,0.65); color: rgba(91,33,182,0.65); font-weight: 700; font-size: 0.70rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; z-index: 1; }
        .sp-table th:first-child, .sp-table td:first-child { text-align: left; }
        .sp-table tbody tr { border-top: 1px solid rgba(209,196,240,0.30); transition: background 150ms; }
        .sp-table tbody tr:hover { box-shadow: inset 0 0 0 2px rgba(91,33,182,0.20); cursor: pointer; }
        .sp-table tfoot td { background: rgba(91,33,182,0.06); font-weight: 800; color: #3B0764; border-top: 2px solid rgba(91,33,182,0.20); }
        @media (max-width: 640px) {
          .sp-filter-bar { padding: 8px 10px !important; gap: 6px !important; }
        }
      `}</style>

      {/* Refresh + Export CSV portal — visually mounts beside the tab bar
          in SalesDashboardModule via the parent's actions slot. Keeps the
          handlers + state local to this view while sharing the tab-bar row. */}
      {actionsSlotEl && createPortal(
        <>
          {lastUpdated && (
            <span style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.45)' }}>
              Last updated: {lastUpdated}
            </span>
          )}
          <button onClick={fetchData} style={{
            height: '2.1rem', padding: '0 14px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)',
            background: '#fff', color: '#5B21B6',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem', fontWeight: 700, cursor: 'pointer',
          }}>↻ Refresh</button>
          <button
            onClick={() => setExportOpen(true)}
            disabled={data.rows.length === 0}
            style={{
              height: '2.1rem', padding: '0 14px', borderRadius: 10, border: '1px solid rgba(91,33,182,0.25)',
              background: '#fff', color: '#5B21B6', fontWeight: 700, fontSize: '0.80rem',
              fontFamily: 'Outfit, sans-serif',
              cursor: data.rows.length === 0 ? 'not-allowed' : 'pointer',
              opacity: data.rows.length === 0 ? 0.5 : 1,
            }}
          >
            ⤓ Export CSV
          </button>
        </>,
        actionsSlotEl
      )}

      {/* Filter bar — always visible. Must outrank the sticky caller-card
          headers (z-index 20) so the popup dropdowns (Categories / Webinar
          / Salesperson / Custom-date calendar) render ABOVE the table
          headers when their parent's stacking context inherits from here. */}
      <div className="sp-filter-bar" style={{
        position: 'relative',
        zIndex: 60,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: '#EFE9F7',
        borderRadius: 14,
        border: '1px solid rgba(139,92,246,0.15)',
        padding: '10px 14px', marginBottom: 16,
        boxShadow: '0 8px 24px rgba(91,33,182,0.10)',
      }}>
        {[
          { id: 'today',  label: 'Today' },
          { id: 'custom', label: 'Custom' },
        ].map(p => <Pill key={p.id} label={p.label} active={preset === p.id} onClick={() => setPreset(p.id)} />)}

        {preset === 'custom' && (() => {
          /* Helpers — local to the picker. We keep customFrom / customTo as
             YYYY-MM-DD strings so the rest of the page stays unchanged. */
          const pad = n => String(n).padStart(2, '0');
          const toYMD = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
          const parseYMD = s => {
            if (!s) return null;
            const [y, m, d] = s.split('-').map(Number);
            return new Date(y, m-1, d);
          };
          const fromDate = parseYMD(customFrom);
          const toDate   = parseYMD(customTo);
          const MONTH_NAMES = ['January','February','March','April','May','June',
                                'July','August','September','October','November','December'];
          const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];
          const year  = customMonth.year;
          const month = customMonth.month;
          /* Build the 6×7 day grid. Week starts Monday. */
          const firstOfMonth = new Date(year, month, 1);
          const lastOfMonth  = new Date(year, month+1, 0);
          const daysInMonth  = lastOfMonth.getDate();
          /* JS Sunday=0; shift so Monday=0. */
          const firstWeekdayMon = (firstOfMonth.getDay() + 6) % 7;
          const prevMonthDays = new Date(year, month, 0).getDate();
          const cells = [];
          for (let i = 0; i < firstWeekdayMon; i++) {
            const d = prevMonthDays - firstWeekdayMon + 1 + i;
            cells.push({ day: d, inMonth: false, date: new Date(year, month-1, d) });
          }
          for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, inMonth: true, date: new Date(year, month, d) });
          }
          while (cells.length < 42) {
            const d = cells.length - (firstWeekdayMon + daysInMonth) + 1;
            cells.push({ day: d, inMonth: false, date: new Date(year, month+1, d) });
          }
          const sameYMD = (a, b) => a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
          const isInRange = d => fromDate && toDate && d > fromDate && d < toDate;

          function pickDay(d) {
            const ymd = toYMD(d);
            /* No range yet, or both already set → start new range. */
            if (!customFrom || (customFrom && customTo)) {
              setCustomFrom(ymd);
              setCustomTo('');
              return;
            }
            /* Have a from but no to. Set the to; swap if user picked an earlier day. */
            if (ymd < customFrom) {
              setCustomTo(customFrom);
              setCustomFrom(ymd);
            } else {
              setCustomTo(ymd);
            }
          }
          /* Two side-by-side date boxes (From / To) instead of one
             squashed trigger. Each box shows its full date or a
             placeholder, and clicking either opens the same calendar
             popup. Range selection inside the popup behaves the same
             way (first click sets From, second sets To). */
          const fromLabel = customFrom || 'From date';
          const toLabel   = customTo   || 'To date';
          const boxStyle = (active) => ({
            height: '2.1rem', padding: '0 12px',
            border: `1px solid ${active ? '#5B21B6' : 'rgba(139,92,246,0.25)'}`,
            borderRadius: 10, background: '#fff',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
            color: active ? '#3B0764' : 'rgba(91,33,182,0.55)',
            cursor: 'pointer', fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', gap: 8,
            minWidth: 140, whiteSpace: 'nowrap',
            boxShadow: active && customRangeOpen ? '0 0 0 2px rgba(91,33,182,0.18)' : 'none',
          });
          const calIcon = (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="3" y="4" width="18" height="18" rx="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          );

          return (
            <div ref={customRangeRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => setCustomRangeOpen(o => !o)}
                style={boxStyle(!!customFrom)}
                title="Pick start date"
              >
                {calIcon}
                <span style={{ flex: 1 }}>{fromLabel}</span>
              </button>
              <span style={{ color: 'rgba(91,33,182,0.45)', fontWeight: 700, fontSize: '0.82rem' }}>→</span>
              <button
                type="button"
                onClick={() => setCustomRangeOpen(o => !o)}
                style={boxStyle(!!customTo)}
                title="Pick end date"
              >
                {calIcon}
                <span style={{ flex: 1 }}>{toLabel}</span>
              </button>

              {customRangeOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                  width: 280, background: '#fff', borderRadius: 14,
                  boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                  border: '1px solid rgba(209,196,240,0.55)',
                  padding: 12, zIndex: 80,
                  fontFamily: 'Outfit, sans-serif',
                }}>
                  {/* Month header with prev/next */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <button
                      type="button"
                      onClick={() => setCustomMonth(({ year: y, month: m }) =>
                        m === 0 ? { year: y-1, month: 11 } : { year: y, month: m-1 })}
                      style={{
                        width: 26, height: 26, borderRadius: 8,
                        border: '1px solid rgba(139,92,246,0.20)',
                        background: 'rgba(91,33,182,0.04)', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      aria-label="Previous month"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6"/>
                      </svg>
                    </button>
                    <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.82rem' }}>
                      {MONTH_NAMES[month]} {year}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomMonth(({ year: y, month: m }) =>
                        m === 11 ? { year: y+1, month: 0 } : { year: y, month: m+1 })}
                      style={{
                        width: 26, height: 26, borderRadius: 8,
                        border: '1px solid rgba(139,92,246,0.20)',
                        background: 'rgba(91,33,182,0.04)', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      aria-label="Next month"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </button>
                  </div>

                  {/* Day-of-week row */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
                    {DOW.map(d => (
                      <div key={d} style={{
                        textAlign: 'center', fontSize: '0.58rem', fontWeight: 700,
                        color: 'rgba(91,33,182,0.55)', padding: '2px 0',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>{d}</div>
                    ))}
                  </div>

                  {/* Day grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
                    {cells.map((c, i) => {
                      const isFrom    = sameYMD(c.date, fromDate);
                      const isTo      = sameYMD(c.date, toDate);
                      const inBetween = isInRange(c.date);
                      const isEdge    = isFrom || isTo;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => pickDay(c.date)}
                          style={{
                            height: 28, border: 'none', cursor: 'pointer',
                            borderRadius: 8,
                            background:
                              isTo ? '#5B21B6' :
                              isFrom ? 'rgba(91,33,182,0.08)' :
                              inBetween ? 'rgba(91,33,182,0.10)' : 'transparent',
                            color:
                              isTo ? '#fff' :
                              c.inMonth ? '#3B0764' : 'rgba(91,33,182,0.30)',
                            fontFamily: 'Outfit, sans-serif',
                            fontWeight: isEdge ? 700 : 600,
                            fontSize: '0.74rem',
                            textDecoration: !c.inMonth ? 'line-through' : 'none',
                            outline: isFrom && !isTo ? '2px solid #5B21B6' : 'none',
                            outlineOffset: '-2px',
                            transition: 'background 120ms',
                          }}
                          onMouseEnter={e => {
                            if (!isEdge && !inBetween) e.currentTarget.style.background = 'rgba(91,33,182,0.06)';
                          }}
                          onMouseLeave={e => {
                            if (!isEdge && !inBetween) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          {c.day}
                        </button>
                      );
                    })}
                  </div>

                  {/* Divider */}
                  <div style={{ height: 1, background: 'rgba(209,196,240,0.55)', margin: '10px 0' }} />

                  {/* Time row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)' }}>Time</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={2}
                      value={customTime.hh}
                      onChange={e => {
                        const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                        setCustomTime(t => ({ ...t, hh: v }));
                      }}
                      style={{
                        width: 32, height: 24, borderRadius: 6,
                        border: '1px solid rgba(139,92,246,0.25)', textAlign: 'center',
                        fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 700,
                        color: '#3B0764', outline: 'none',
                      }}
                    />
                    <span style={{ fontWeight: 800, color: '#5B21B6', fontSize: '0.78rem' }}>:</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={2}
                      value={customTime.mm}
                      onChange={e => {
                        const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                        setCustomTime(t => ({ ...t, mm: v }));
                      }}
                      style={{
                        width: 32, height: 24, borderRadius: 6,
                        border: '1px solid rgba(139,92,246,0.25)', textAlign: 'center',
                        fontFamily: 'Outfit, sans-serif', fontSize: '0.74rem', fontWeight: 700,
                        color: '#3B0764', outline: 'none',
                      }}
                    />
                    {/* AM / PM toggle */}
                    <div style={{
                      display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
                      border: '1px solid rgba(139,92,246,0.25)',
                    }}>
                      {['AM','PM'].map(p => {
                        const active = customTime.ampm === p;
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setCustomTime(t => ({ ...t, ampm: p }))}
                            style={{
                              height: 24, padding: '0 8px', border: 'none', cursor: 'pointer',
                              background: active ? '#5B21B6' : '#fff',
                              color: active ? '#fff' : 'rgba(91,33,182,0.65)',
                              fontFamily: 'Outfit, sans-serif',
                              fontWeight: 700, fontSize: '0.64rem',
                            }}
                          >{p}</button>
                        );
                      })}
                    </div>
                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'rgba(91,33,182,0.45)' }}>IST</span>
                  </div>

                  {/* Done button */}
                  <button
                    type="button"
                    onClick={() => setCustomRangeOpen(false)}
                    style={{
                      width: '100%', height: 32, borderRadius: 10,
                      background: '#5B21B6', color: '#fff', border: 'none',
                      fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                      cursor: 'pointer', letterSpacing: '0.02em',
                      boxShadow: '0 3px 10px rgba(91,33,182,0.25)',
                    }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Categories — unified multi-select dropdown with status + role
            checkboxes. Within the dropdown the user can pick any combo of
            Active / Paused / Junior / Senior / Team Lead / Manager / Trainer
            / Admin. Filters apply AND across groups, OR within a group. */}
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', marginLeft: 8 }}>Categories</span>
        <div ref={categoriesRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setCategoriesOpen(o => !o)}
            style={{
              height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
              border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3B0764',
              cursor: 'pointer', minWidth: 180, textAlign: 'left',
              position: 'relative',
            }}
          >
            {categoriesSel.size === 0
              ? 'All categories'
              : `${categoriesSel.size} selected`}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${categoriesOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {categoriesOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              minWidth: 220, maxHeight: 360, overflowY: 'auto',
              background: '#fff', borderRadius: 10,
              border: '1px solid rgba(209,196,240,0.60)',
              boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
              padding: 6, zIndex: 50,
              fontFamily: 'Outfit, sans-serif',
            }}>
              {/* Clear-all */}
              <button
                type="button"
                onClick={() => setCategoriesSel(new Set())}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 10px', borderRadius: 6, border: 'none',
                  background: categoriesSel.size === 0 ? 'rgba(91,33,182,0.10)' : 'transparent',
                  color: categoriesSel.size === 0 ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                  fontWeight: categoriesSel.size === 0 ? 700 : 600, fontSize: '0.82rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                }}
                onMouseEnter={e => { if (categoriesSel.size > 0) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                onMouseLeave={e => { if (categoriesSel.size > 0) e.currentTarget.style.background = 'transparent'; }}
              >
                All categories
              </button>
              {CATEGORY_GROUPS.map(group => (
                <div key={group.title} style={{ marginTop: 4, marginBottom: 4 }}>
                  <div style={{
                    padding: '6px 10px 4px', fontSize: '0.62rem', fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.10em',
                    color: 'rgba(91,33,182,0.55)',
                  }}>{group.title}</div>
                  {group.items.map(item => {
                    const checked = categoriesSel.has(item.value);
                    return (
                      <label
                        key={item.value}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                          background: checked ? 'rgba(91,33,182,0.06)' : 'transparent',
                          transition: 'background 120ms',
                        }}
                        onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                        onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <input
                          type="checkbox"
                          className="sp-check"
                          checked={checked}
                          onChange={() => toggleCategory(item.value)}
                        />
                        {item.dot && (
                          <span style={{
                            width: 7, height: 7, borderRadius: '50%',
                            background: item.dot, flexShrink: 0,
                          }} />
                        )}
                        <span style={{
                          flex: 1, fontFamily: 'Outfit, sans-serif',
                          fontWeight: checked ? 700 : 600, fontSize: '0.84rem',
                          color: checked ? '#5B21B6' : '#3B0764',
                        }}>{item.label}</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Webinar custom dropdown — has an embedded search input so admins
            can filter a long webinar list. Single-select (one webinar at a
            time, plus "All webinars"). */}
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', marginLeft: 8 }}>Webinar</span>
        <div ref={webinarRef} style={{ position: 'relative' }}>
          {(() => {
            const selectedWebinar = webinars.find(w => String(w.id) === String(webinarId));
            const triggerLabel = selectedWebinar
              ? `${selectedWebinar.name}${!selectedWebinar.is_active ? ' (inactive)' : ''}`
              : 'All webinars';
            const q = webinarQuery.trim().toLowerCase();
            /* Hide future-dated INACTIVE webinars — those are "upcoming"
               drafts that haven't run yet, so they'd add noise to a
               performance-data picker. ACTIVE webinars always show, even
               if their date is upcoming (the currently-promoted one). */
            const nowMs = Date.now();
            const pastOrCurrent = webinars.filter(w => {
              if (w.is_active) return true;
              if (!w.webinar_at) return true;
              return new Date(w.webinar_at).getTime() <= nowMs;
            });
            const filteredWebinars = q
              ? pastOrCurrent.filter(w => (w.name || '').toLowerCase().includes(q))
              : pastOrCurrent;
            return (
              <>
                <button
                  type="button"
                  onClick={() => setWebinarOpen(o => !o)}
                  style={{
                    height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
                    border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3B0764',
                    cursor: 'pointer', minWidth: 200, textAlign: 'left',
                    position: 'relative',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {triggerLabel}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${webinarOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {webinarOpen && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                    minWidth: 260, maxHeight: 360, overflowY: 'auto',
                    background: '#fff', borderRadius: 10,
                    border: '1px solid rgba(209,196,240,0.60)',
                    boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
                    padding: 4, zIndex: 50,
                    fontFamily: 'Outfit, sans-serif',
                  }}>
                    {/* Search input — sticky inside the scroll container. */}
                    <div style={{
                      position: 'sticky', top: 0, background: '#fff',
                      padding: '4px 4px 6px', zIndex: 1,
                      borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                    }}>
                      <input
                        type="text"
                        autoFocus
                        value={webinarQuery}
                        onChange={e => setWebinarQuery(e.target.value)}
                        placeholder="Search webinars…"
                        style={{
                          width: '100%', height: '2.1rem',
                          padding: '0 10px', borderRadius: 8,
                          border: '1px solid rgba(139,92,246,0.30)',
                          fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
                          color: '#3B0764', outline: 'none',
                        }}
                      />
                    </div>
                    {/* "All webinars" option */}
                    <button
                      type="button"
                      onClick={() => { setWebinarId(''); setWebinarOpen(false); setWebinarQuery(''); }}
                      style={{
                        width: '100%', textAlign: 'left',
                        padding: '8px 10px', borderRadius: 6, border: 'none',
                        background: !webinarId ? 'rgba(91,33,182,0.10)' : 'transparent',
                        color: !webinarId ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                        fontWeight: !webinarId ? 700 : 600, fontSize: '0.82rem',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => { if (webinarId) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                      onMouseLeave={e => { if (webinarId) e.currentTarget.style.background = 'transparent'; }}
                    >
                      All webinars
                    </button>
                    {filteredWebinars.length === 0 ? (
                      <div style={{ padding: '12px 10px', fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', textAlign: 'center' }}>
                        No webinars match "{webinarQuery}"
                      </div>
                    ) : filteredWebinars.map(w => {
                      const selected = String(w.id) === String(webinarId);
                      return (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => { setWebinarId(w.id); setWebinarOpen(false); setWebinarQuery(''); }}
                          style={{
                            width: '100%', textAlign: 'left',
                            padding: '8px 10px', borderRadius: 6, border: 'none',
                            background: selected ? 'rgba(91,33,182,0.10)' : 'transparent',
                            color: selected ? '#5B21B6' : '#3B0764',
                            fontWeight: selected ? 700 : 600, fontSize: '0.82rem',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 8,
                          }}
                          onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                          onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.name}</span>
                          {!w.is_active && (
                            <span style={{
                              fontSize: '0.60rem', fontWeight: 700, textTransform: 'uppercase',
                              padding: '1px 6px', borderRadius: 50,
                              background: 'rgba(107,114,128,0.18)', color: '#374151',
                            }}>Inactive</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Multi-select salesperson picker. Trigger button shows count;
            panel has Select-all + per-caller checkboxes. */}
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.65)', marginLeft: 8 }}>Salesperson</span>
        <div ref={salespeopleRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setSalespeopleOpen(o => !o)}
            style={{
              height: '2.1rem', padding: '0 32px 0 12px', borderRadius: 10,
              border: '1px solid rgba(139,92,246,0.25)', background: '#fff',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: '#3B0764',
              cursor: 'pointer', minWidth: 200, textAlign: 'left',
              position: 'relative',
            }}
          >
            {salespeopleSel.size === 0
              ? 'All salespeople'
              : salespeopleSel.size === 1
                ? (callers.find(c => salespeopleSel.has(c.id))?.full_name || '1 selected')
                : `${salespeopleSel.size} selected`}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) rotate(${salespeopleOpen ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {salespeopleOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              minWidth: 240, maxHeight: 320, overflowY: 'auto',
              background: '#fff', borderRadius: 10,
              border: '1px solid rgba(209,196,240,0.60)',
              boxShadow: '0 12px 36px rgba(91,33,182,0.20)',
              padding: 4, zIndex: 50,
              fontFamily: 'Outfit, sans-serif',
            }}>
              {/* Search input — sticky inside the scroll container so it
                  stays visible while the user scrolls a long caller list. */}
              <div style={{
                position: 'sticky', top: 0, background: '#fff',
                padding: '4px 4px 6px', zIndex: 1,
                borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
              }}>
                <input
                  type="text"
                  autoFocus
                  value={salespeopleQuery}
                  onChange={e => setSalespeopleQuery(e.target.value)}
                  placeholder="Search salespeople…"
                  style={{
                    width: '100%', height: '2.1rem',
                    padding: '0 10px', borderRadius: 8,
                    border: '1px solid rgba(139,92,246,0.30)',
                    fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
                    color: '#3B0764', outline: 'none',
                  }}
                />
              </div>
              {/* Select-all toggle */}
              <button
                type="button"
                onClick={() => setSalespeopleSel(new Set())}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 10px', borderRadius: 6, border: 'none',
                  background: salespeopleSel.size === 0 ? 'rgba(91,33,182,0.10)' : 'transparent',
                  color: salespeopleSel.size === 0 ? '#5B21B6' : 'rgba(59,7,100,0.85)',
                  fontWeight: salespeopleSel.size === 0 ? 700 : 600, fontSize: '0.82rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(209,196,240,0.40)', marginBottom: 4,
                }}
                onMouseEnter={e => { if (salespeopleSel.size > 0) e.currentTarget.style.background = 'rgba(91,33,182,0.05)'; }}
                onMouseLeave={e => { if (salespeopleSel.size > 0) e.currentTarget.style.background = 'transparent'; }}
              >
                All salespeople
              </button>
              {(() => {
                const q = salespeopleQuery.trim().toLowerCase();
                const filtered = q
                  ? callers.filter(c => (c.full_name || '').toLowerCase().includes(q))
                  : callers;
                if (filtered.length === 0) {
                  return (
                    <div style={{ padding: '12px 10px', fontSize: '0.78rem', color: 'rgba(91,33,182,0.55)', textAlign: 'center' }}>
                      No salespeople match "{salespeopleQuery}"
                    </div>
                  );
                }
                return filtered.map(c => {
                const checked = salespeopleSel.has(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                      background: checked ? 'rgba(91,33,182,0.06)' : 'transparent',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                    onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      className="sp-check"
                      checked={checked}
                      onChange={() => {
                        setSalespeopleSel(prev => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                          return next;
                        });
                      }}
                    />
                    <span style={{
                      flex: 1, fontFamily: 'Outfit, sans-serif',
                      fontWeight: checked ? 700 : 600, fontSize: '0.84rem',
                      color: checked ? '#5B21B6' : '#3B0764',
                    }}>{c.full_name}</span>
                    {c.is_active === false && (
                      <span style={{
                        fontSize: '0.60rem', fontWeight: 700, textTransform: 'uppercase',
                        padding: '1px 6px', borderRadius: 50,
                        background: 'rgba(107,114,128,0.18)', color: '#374151',
                      }}>Paused</span>
                    )}
                  </label>
                );
              });
              })()}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.80)', border: '1px solid rgba(239,68,68,0.30)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, color: '#DC2626', fontSize: '0.82rem', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Table — horizontal scrollbar hidden visually but scroll still works
          (shift+wheel, trackpad, touch). The table has 17+ columns so it's
          wider than most screens, but the visible scrollbar was noisy.

          Also defines the custom checkbox style for the per-row + select-all
          checkboxes — native ones don't match the violet UI. */}
      <style>{`
        .sp-table-scroll { -ms-overflow-style: none; scrollbar-width: none; }
        .sp-table-scroll::-webkit-scrollbar { display: none; width: 0; height: 0; }

        .sp-check {
          -webkit-appearance: none; -moz-appearance: none; appearance: none;
          width: 18px; height: 18px; margin: 0;
          border: 1.5px solid rgba(91,33,182,0.40);
          border-radius: 5px;
          background: #fff;
          cursor: pointer;
          position: relative;
          transition: background 120ms, border-color 120ms, box-shadow 120ms;
          vertical-align: middle;
        }
        .sp-check:hover  { border-color: #5B21B6; box-shadow: 0 0 0 3px rgba(91,33,182,0.10); }
        .sp-check:focus  { outline: none; border-color: #5B21B6; box-shadow: 0 0 0 3px rgba(91,33,182,0.18); }
        .sp-check:checked,
        .sp-check:indeterminate {
          background: #5B21B6;
          border-color: #5B21B6;
        }
        /* Tick */
        .sp-check:checked::after {
          content: '';
          position: absolute; left: 5px; top: 1px;
          width: 5px; height: 10px;
          border: solid #fff; border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
        /* Dash for the select-all "some selected" state */
        .sp-check:indeterminate::after {
          content: '';
          position: absolute; left: 3px; top: 7px;
          width: 10px; height: 2px;
          background: #fff; border-radius: 1px;
        }
      `}</style>
      {/* Pricing-table-style performance grid — each caller a vertical card
          with a colored header band, metrics stacked as rows, Team Total on
          the right. Replaces the original horizontal table. */}
      {loading ? (
        <div className="bg-white" style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem', borderRadius: 14 }}>Loading performance data…</div>
      ) : visibleRows.length === 0 ? (
        <div className="bg-white" style={{ padding: 60, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem', borderRadius: 14 }}>
          {data.rows.length === 0
            ? 'No salespeople found for this period.'
            : 'No salespeople match the current filters. Adjust the Status pills or salesperson picker.'}
        </div>
      ) : (
        <PricingPerfTable
          rows={visibleRows}
          tt={tt}
          topRowId={topRowId}
          nowTick={nowTick}
          selectedRoles={selectedRoles}
          toggleRole={toggleRole}
          openDrill={openDrill}
          openMovePicker={openMovePicker}
          togglePause={togglePause}
          pauseBusyIds={pauseBusyIds}
          openActivity={openActivity}
          openCallerPage={openCallerPage}
        />
      )}

      {/* Legacy horizontal table — kept under a `false` gate as a reference
          fallback in case we ever need to A/B the layouts. Not rendered. */}
      {false && (
      <div style={{ background: '#fff', borderRadius: 14, boxShadow: '0 2px 12px rgba(91,33,182,0.07)', overflow: 'hidden' }}>
        <div className="sp-table-scroll" style={{ overflowX: 'auto', maxHeight: '70vh' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>Loading performance data…</div>
          ) : data.rows.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.9rem' }}>
              No salespeople found for this period.
            </div>
          ) : (
            <table className="sp-table">
              <thead>
                <tr>
                  <th style={{ width: 36, padding: '10px 4px' }}>
                    <input
                      type="checkbox"
                      className="sp-check"
                      aria-label="Select all"
                      checked={data.rows.length > 0 && data.rows.every(r => selectedIds.has(r.caller_id))}
                      ref={el => {
                        if (!el) return;
                        const selectedCount = data.rows.filter(r => selectedIds.has(r.caller_id)).length;
                        el.indeterminate = selectedCount > 0 && selectedCount < data.rows.length;
                      }}
                      onChange={() => toggleAll(data.rows)}
                    />
                  </th>
                  <th>Salesperson</th>
                  <th title="Live caller status — 9 AM to 6 PM IST">Status</th>
                  <th>Assigned</th>
                  <th>Hot</th>
                  <th>Warm</th>
                  <th>Touched</th>
                  <th>Untouched</th>
                  <th title="Leads parked with outcome = follow_up">Follow-ups</th>
                  <th>Total Calls</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Connected</th>
                  <th>Conn %</th>
                  <th>Avg Dur</th>
                  <th>Total Dur</th>
                  <th aria-label="Actions" style={{ width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => {
                  const isTop = r.caller_id === topRowId;
                  const idleMin = minutesSince(r.last_call_at);
                  const idle = (r.total_calls > 0 && idleMin != null && idleMin > 30) ? idleMin : null;
                  const noActivity = r.assigned > 0 && r.touched === 0;
                  return (
                    <tr key={r.caller_id}
                        onClick={() => openDrill(r.caller_id, 'assigned')}
                        style={{ background: rowBg(r, isTop) }}>
                      <td onClick={e => e.stopPropagation()} style={{ width: 36, padding: '10px 4px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="sp-check"
                          aria-label={`Select ${r.name}`}
                          checked={selectedIds.has(r.caller_id)}
                          onChange={() => toggleRow(r.caller_id)}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                          {isTop && <span title="Top performer" style={{ fontSize: '0.95rem' }}>🏆</span>}
                          <span style={{ fontWeight: 700, color: '#3B0764' }}>{r.name}</span>
                          <span style={{ fontSize: '0.65rem', color: 'rgba(91,33,182,0.45)', textTransform: 'capitalize' }}>
                            · {r.role.replace('_', ' ')}
                          </span>
                          {r.is_active === false && (
                            <span title="Paused by admin — cannot dial or receive new leads" style={{ background: 'rgba(107,114,128,0.18)', color: '#374151', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Paused</span>
                          )}
                          {noActivity && (
                            <span style={{ background: 'rgba(249,115,22,0.15)', color: '#C2410C', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>⚠ Idle</span>
                          )}
                          {idle != null && (
                            <span title={`No call in ${idle} min`} style={{ background: 'rgba(91,33,182,0.10)', color: '#5B21B6', padding: '1px 7px', borderRadius: 50, fontSize: '0.62rem', fontWeight: 700 }}>
                              Idle {idle}m
                            </span>
                          )}
                        </div>
                      </td>
                      <td onClick={e => e.stopPropagation()} style={{ padding: '6px 10px', textAlign: 'left' }}>
                        <StatusBadge row={r} nowTick={nowTick} />
                      </td>
                      <DrillCell value={r.assigned}        onOpen={() => openDrill(r.caller_id, 'assigned')}  title="View assigned leads" />
                      <DrillCell value={r.hot}             onOpen={() => openDrill(r.caller_id, 'hot')}       title="View hot leads"
                                 style={{ color: r.hot > 0 ? '#DC2626' : 'rgba(91,33,182,0.55)', fontWeight: 700 }} />
                      <DrillCell value={r.warm}            onOpen={() => openDrill(r.caller_id, 'warm')}      title="View warm leads" />
                      <DrillCell value={r.touched}         onOpen={() => openDrill(r.caller_id, 'touched')}   title="View touched leads" />
                      <DrillCell value={r.untouched}       onOpen={() => openDrill(r.caller_id, 'untouched')} title="View untouched leads" />
                      <DrillCell value={r.followups} onOpen={() => openDrill(r.caller_id, 'follow_up')} title="View follow-up leads"
                                 style={{ color: r.followups > 0 ? '#5B21B6' : 'rgba(91,33,182,0.55)', fontWeight: r.followups > 0 ? 700 : 500 }} />
                      <DrillCell
                        onOpen={() => openDrill(r.caller_id, 'calls')}
                        title="View all calls"
                      >
                        {r.total_calls}
                        <TrendArrow now={r.total_calls} prev={r.total_calls_prev} />
                      </DrillCell>
                      <DrillCell value={r.incoming}  onOpen={() => openDrill(r.caller_id, 'in')}        title="View incoming calls" />
                      <DrillCell value={r.outgoing}  onOpen={() => openDrill(r.caller_id, 'out')}       title="View outgoing calls" />
                      <DrillCell value={r.connected} onOpen={() => openDrill(r.caller_id, 'connected')} title="View connected calls" />
                      <td>
                        {r.connection_rate_pct}%
                      </td>
                      <td>{fmtDuration(r.avg_duration_sec)}</td>
                      <td>{fmtHMS(r.total_duration_sec)}</td>
                      <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center', padding: '6px 4px' }}>
                        <RowMenuButton
                          row={r}
                          busyPause={pauseBusyIds.has(r.caller_id)}
                          onMove={openMovePicker}
                          onView={(row) => openDrill(row.caller_id, 'assigned')}
                          onTogglePause={togglePause}
                          onCallerPage={openCallerPage}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {tt && (
                <tfoot>
                  <tr>
                    <td style={{ width: 36, padding: '10px 4px', textAlign: 'center' }}>
                      {selectedIds.size > 0 && (
                        <span style={{
                          display: 'inline-block', minWidth: 18, padding: '2px 6px',
                          borderRadius: 50, background: '#5B21B6', color: '#fff',
                          fontFamily: 'Outfit, sans-serif', fontSize: '0.66rem', fontWeight: 800,
                          lineHeight: 1.2,
                        }} title={`${selectedIds.size} selected`}>
                          {selectedIds.size}
                        </span>
                      )}
                    </td>
                    <td>Team Total</td>
                    <td></td>
                    <td>{tt.assigned}</td>
                    <td>{tt.hot}</td>
                    <td>{tt.warm}</td>
                    <td>{tt.touched}</td>
                    <td>{tt.untouched}</td>
                    <td>{tt.followups}</td>
                    <td>{tt.total_calls}</td>
                    <td>{tt.incoming}</td>
                    <td>{tt.outgoing}</td>
                    <td>{tt.connected}</td>
                    <td>{tt.connection_rate_pct}%</td>
                    <td>{fmtDuration(tt.avg_duration_sec)}</td>
                    <td>{fmtHMS(tt.total_duration_sec)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
      )}

      {/* Drill-down panel */}
      {drillId && (
        <SalesPerformanceDrillPanel
          token={token}
          caller={data.rows.find(r => r.caller_id === drillId)}
          initialFilter={drillFilter}
          onClose={() => setDrillId(null)}
        />
      )}

      {/* Caller activity log — opened by clicking the Status pill in a
          caller's column header in the pricing table. */}
      {activityRow && (
        <CallerActivityDrawer
          token={token}
          callerId={activityRow.caller_id}
          callerName={activityRow.name || activityRow.full_name}
          onClose={() => setActivityRow(null)}
          // `is_active` may be undefined on rows that haven't been
          // resolved yet — treat undefined as active so the button
          // defaults to "Pause" (the correct affordance for a live caller).
          isActive={activityRow.is_active !== false}
          // Reuse the existing togglePause handler. After the PATCH the
          // function refetches data, which refreshes activityRow's row
          // data so the button switches Pause ↔ Resume in real time.
          onTogglePause={() => togglePause(activityRow)}
        />
      )}

      {/* Caller-page side drawer — opened from the kebab menu's
          "Caller page" item. Shows the caller's Assigned / Completed /
          Not Picked buckets with bulk reopen for Completed leads. */}
      {callerPageRow && (
        <CallerPageDrawer
          token={token}
          callerId={callerPageRow.caller_id}
          callerName={callerPageRow.name || callerPageRow.full_name}
          onClose={() => setCallerPageRow(null)}
          // After a successful reopen, refetch the parent grid so the
          // caller's Assigned / Completed columns reflect the move.
          onAfterReopen={fetchData}
        />
      )}

      {/* Export CSV column-picker modal — centered alert card. Identity
          columns (Salesperson + Role) are always written; the user picks
          which metric columns to include. */}
      {exportOpen && (
        <>
          <div
            onClick={() => setExportOpen(false)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
              zIndex: 9300, backdropFilter: 'blur(2px)',
            }}
          />
          <div
            role="dialog" aria-modal="true"
            style={{
              position: 'fixed', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(540px, 92vw)', maxHeight: '85vh',
              background: '#fff', borderRadius: 18,
              boxShadow: '0 24px 60px rgba(15,23,42,0.28)',
              zIndex: 9301, display: 'flex', flexDirection: 'column',
              fontFamily: 'Outfit, sans-serif',
              animation: 'sp-export-in 180ms ease-out',
            }}
          >
            <style>{`
              @keyframes sp-export-in {
                from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
                to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
              }
            `}</style>
            {/* Header */}
            <div style={{
              padding: '18px 22px 14px', borderTopLeftRadius: 18, borderTopRightRadius: 18,
              background: 'linear-gradient(180deg,#7C3AED,#5B21B6)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.10em' }}>
                  Export leads CSV
                </div>
                <div style={{ fontSize: '1.10rem', fontWeight: 800, marginTop: 2 }}>
                  Pick categories to export
                </div>
              </div>
              <button
                type="button" onClick={() => setExportOpen(false)} aria-label="Close"
                style={{
                  width: 32, height: 32, borderRadius: 10, border: 'none',
                  background: 'rgba(255,255,255,0.18)', color: '#fff',
                  cursor: 'pointer', fontSize: '1.05rem', fontWeight: 800,
                }}
              >×</button>
            </div>

            {/* Toolbar */}
            <div style={{
              display: 'flex', gap: 8, padding: '10px 22px',
              borderBottom: '1px solid rgba(209,196,240,0.45)',
              background: '#FAF7FF',
            }}>
              <button
                type="button"
                onClick={selectAllExportCols}
                style={{
                  height: '2rem', padding: '0 12px', borderRadius: 8,
                  border: '1px solid rgba(91,33,182,0.20)', background: '#fff',
                  color: '#5B21B6', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer',
                }}
              >Select all</button>
              <button
                type="button"
                onClick={clearAllExportCols}
                style={{
                  height: '2rem', padding: '0 12px', borderRadius: 8,
                  border: '1px solid rgba(91,33,182,0.20)', background: '#fff',
                  color: '#5B21B6', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.76rem', fontWeight: 700, cursor: 'pointer',
                }}
              >Clear</button>
              <div style={{ flex: 1 }} />
              <span style={{
                alignSelf: 'center', fontSize: '0.74rem', fontWeight: 700,
                color: 'rgba(91,33,182,0.65)',
              }}>
                {exportSelected.size} of {EXPORT_COLUMNS.length} columns
              </span>
            </div>

            {/* Column checkboxes — Salesperson + Role chip shown first
                as a non-clickable hint so admins know identity is always
                included; below it the optional metric list. */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px 14px' }}>
              <div style={{
                margin: '6px 8px 10px', padding: '8px 12px', borderRadius: 10,
                background: 'rgba(91,33,182,0.06)', color: '#5B21B6',
                fontSize: '0.76rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Each lead appears only once — even if it matches multiple categories
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 4,
              }}>
                {EXPORT_COLUMNS.map(c => {
                  const checked = exportSelected.has(c.id);
                  return (
                    <label
                      key={c.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
                        background: checked ? 'rgba(91,33,182,0.06)' : 'transparent',
                        transition: 'background 120ms',
                      }}
                      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'rgba(91,33,182,0.04)'; }}
                      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <input
                        type="checkbox"
                        className="sp-check"
                        checked={checked}
                        onChange={() => toggleExportCol(c.id)}
                      />
                      <span style={{
                        flex: 1, fontFamily: 'Outfit, sans-serif',
                        fontWeight: checked ? 700 : 600, fontSize: '0.84rem',
                        color: checked ? '#5B21B6' : '#3B0764',
                      }}>{c.header.replace(/_/g, ' ')}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div style={{
              padding: '12px 22px', borderTop: '1px solid rgba(209,196,240,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
              background: '#FAF7FF', borderBottomLeftRadius: 18, borderBottomRightRadius: 18,
            }}>
              {exportError && (
                <span style={{
                  marginRight: 'auto', color: '#DC2626',
                  fontSize: '0.78rem', fontWeight: 700,
                }}>{exportError}</span>
              )}
              <button
                type="button" onClick={() => setExportOpen(false)}
                disabled={exportBusy}
                style={{
                  height: '2.4rem', padding: '0 16px', borderRadius: 10,
                  border: '1px solid rgba(91,33,182,0.25)', background: '#fff',
                  color: '#5B21B6', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.84rem', fontWeight: 700,
                  cursor: exportBusy ? 'not-allowed' : 'pointer',
                  opacity: exportBusy ? 0.6 : 1,
                }}
              >Cancel</button>
              <button
                type="button" onClick={confirmExport}
                disabled={exportSelected.size === 0 || exportBusy}
                style={{
                  height: '2.4rem', padding: '0 18px', borderRadius: 10,
                  border: 'none',
                  background: (exportSelected.size === 0 || exportBusy) ? 'rgba(91,33,182,0.30)' : '#5B21B6',
                  color: '#fff', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.84rem', fontWeight: 800,
                  cursor: (exportSelected.size === 0 || exportBusy) ? 'not-allowed' : 'pointer',
                  boxShadow: (exportSelected.size === 0 || exportBusy) ? 'none' : '0 4px 14px rgba(91,33,182,0.30)',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {exportBusy ? 'Exporting…' : `Export leads`}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Kebab > Move leads — step 1: scope picker */}
      {movePickerRow && (
        <MoveScopePicker
          row={movePickerRow}
          onClose={closeMovePicker}
          onConfirm={confirmMoveScope}
        />
      )}

      {/* Kebab > Move leads — step 2: distribution modal (shared component) */}
      {moveCtx && (
        <ReassignDistributionModal
          fromCaller={moveCtx.fromCaller}
          scope={moveCtx.scope}
          date={moveCtx.date}
          total={moveCtx.total}
          eligibleCallers={moveCtx.workload}
          token={token}
          onClose={closeMove}
          onMoved={handleMoved}
        />
      )}

      {/* Toast — used by Move, Pause, errors */}
      <Toast message={toast} kind={toastKind} onDone={() => setToast('')} />
    </div>
  );
}

/* ── Move scope picker — small modal asking "All open" vs "Follow-ups for date" ── */
function MoveScopePicker({ row, onClose, onConfirm }) {
  // Default date = today in IST (matches the existing CallerWorkload behavior).
  const todayIST = (() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  })();
  const [scope, setScope] = useState('all_open');
  const [date,  setDate]  = useState(todayIST);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,0,40,0.45)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 9500,
      fontFamily: 'Outfit, sans-serif',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 16, padding: 24, maxWidth: 420, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <h3 style={{ margin: 0, fontSize: '1.02rem', fontWeight: 700, color: '#3B0764' }}>
          Move leads from {row.name}
        </h3>
        <p style={{ margin: '4px 0 16px', fontSize: '0.82rem', color: 'rgba(91,33,182,0.65)' }}>
          Which leads should be reassigned?
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <ScopeOption
            value="all_open" current={scope} onChange={setScope}
            label="All open leads"
            desc="Everything this caller hasn't completed yet (untouched + follow-ups)."
          />
          <ScopeOption
            value="followups_for_date" current={scope} onChange={setScope}
            label="Follow-up leads for a specific date"
            desc="Only follow-ups scheduled for the chosen date."
          />
        </div>

        {scope === 'followups_for_date' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'rgba(91,33,182,0.75)' }}>
              Follow-ups for:
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              style={{
                height: '2.2rem', padding: '0 12px', borderRadius: 8,
                border: '1px solid rgba(209,196,240,0.7)', background: '#fff',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(91,33,182,0.20)',
            background: '#fff', color: '#5B21B6', fontWeight: 600, fontSize: '0.84rem',
            cursor: 'pointer',
          }}>Cancel</button>
          <button
            onClick={() => onConfirm({ scope, date })}
            style={{
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: '#5B21B6', color: '#fff',
              fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer',
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeOption({ value, current, onChange, label, desc }) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      style={{
        textAlign: 'left', padding: '10px 12px', borderRadius: 10,
        border: active ? '2px solid #5B21B6' : '1px solid rgba(209,196,240,0.7)',
        background: active ? 'rgba(91,33,182,0.06)' : '#fff',
        cursor: 'pointer',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        fontFamily: 'Outfit, sans-serif',
      }}
    >
      <span style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        border: active ? '5px solid #5B21B6' : '2px solid rgba(91,33,182,0.30)',
        marginTop: 2,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.88rem' }}>{label}</div>
        <div style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.60)', marginTop: 2 }}>{desc}</div>
      </div>
    </button>
  );
}
