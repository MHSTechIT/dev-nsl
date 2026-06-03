import { useState, useEffect, useRef } from 'react';

/* DateTimePicker — a custom date + time picker styled in the app's purple
   palette (replaces the browser-native datetime-local popup, which can't be
   themed). Controlled by `value` (an ISO string or '') and emits an ISO string
   via onChange. Month grid is Monday-first; time is hour + minute selects. */

const VIOLET      = '#5B21B6';
const VIOLET_DARK = '#3B0764';
const INK         = '#3B0764';
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

export default function DateTimePicker({ value, onChange, placeholder = 'dd-mm-yyyy --:--' }) {
  const init = value ? new Date(value) : null;
  const [open, setOpen] = useState(false);
  const [sel, setSel]   = useState(init);
  const [hh, setHh]     = useState(init ? init.getHours() : 10);
  const [mm, setMm]     = useState(init ? init.getMinutes() : 0);
  const [view, setView] = useState(() => {
    const d = init || new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const emit = (d) => onChange?.(d ? d.toISOString() : '');

  function pickDay(date) {
    const nd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0);
    setView({ y: date.getFullYear(), m: date.getMonth() });
    setSel(nd); emit(nd);
  }
  function setHour(h)   { setHh(h); if (sel) { const nd = new Date(sel); nd.setHours(h, mm, 0, 0); setSel(nd); emit(nd); } }
  function setMinute(m) { setMm(m); if (sel) { const nd = new Date(sel); nd.setHours(hh, m, 0, 0); setSel(nd); emit(nd); } }
  function clear() { setSel(null); emit(null); }
  function today() {
    const t = new Date();
    setView({ y: t.getFullYear(), m: t.getMonth() });
    const nd = new Date(t.getFullYear(), t.getMonth(), t.getDate(), hh, mm, 0, 0);
    setSel(nd); emit(nd);
  }
  function shiftMonth(delta) {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  }

  // 42-cell, Monday-first grid for the visible month.
  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(view.y, view.m, 1 - offset);
  const cells = Array.from({ length: 42 }, (_, i) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const todayStr = new Date().toDateString();
  const selStr = sel ? sel.toDateString() : null;
  const display = sel
    ? `${pad(sel.getDate())}-${pad(sel.getMonth() + 1)}-${sel.getFullYear()}  ${pad(sel.getHours())}:${pad(sel.getMinutes())}`
    : '';

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={fieldBtn(!!display)}>
        <span>{display || placeholder}</span>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={VIOLET} strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>

      {open && (
        <div style={popover}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, color: VIOLET_DARK, fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem' }}>{MONTHS[view.m]} {view.y}</span>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" onClick={() => shiftMonth(-1)} style={navBtn} aria-label="Previous month">‹</button>
              <button type="button" onClick={() => shiftMonth(1)} style={navBtn} aria-label="Next month">›</button>
            </div>
          </div>

          <div style={grid7}>
            {WEEKDAYS.map((w) => (
              <span key={w} style={{ textAlign: 'center', fontSize: '0.66rem', fontWeight: 700, color: 'rgba(91,33,182,0.5)', fontFamily: 'Outfit, sans-serif', padding: '2px 0' }}>{w}</span>
            ))}
          </div>

          <div style={{ ...grid7, marginTop: 2, rowGap: 2 }}>
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === view.m;
              const isSel = d.toDateString() === selStr;
              const isToday = d.toDateString() === todayStr;
              return (
                <button
                  key={i} type="button" onClick={() => pickDay(d)} style={dayCell(inMonth, isSel, isToday)}
                  onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'rgba(91,33,182,0.08)'; }}
                  onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                >{d.getDate()}</button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(124,58,237,0.15)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={VIOLET} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
            <select value={hh} onChange={(e) => setHour(Number(e.target.value))} style={timeSel} aria-label="Hour">
              {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{pad(h)}</option>)}
            </select>
            <span style={{ fontWeight: 800, color: VIOLET_DARK }}>:</span>
            <select value={mm} onChange={(e) => setMinute(Number(e.target.value))} style={timeSel} aria-label="Minute">
              {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={m}>{pad(m)}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setOpen(false)} style={doneBtn}>Done</button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <button type="button" onClick={clear} style={linkBtn}>Clear</button>
            <button type="button" onClick={today} style={linkBtn}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}

const fieldBtn = (filled) => ({
  width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  border: '1px solid rgba(124,58,237,0.3)', borderRadius: 10, padding: '10px 12px', background: '#fff', cursor: 'pointer',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: filled ? INK : 'rgba(91,33,182,0.45)',
});
const popover = {
  position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30, width: 300, boxSizing: 'border-box',
  background: '#fff', borderRadius: 14, border: '1px solid rgba(124,58,237,0.2)',
  boxShadow: '0 16px 40px rgba(91,33,182,0.22)', padding: 12, fontFamily: 'Outfit, sans-serif',
};
const navBtn = { width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(124,58,237,0.2)', background: '#fff', color: VIOLET, cursor: 'pointer', fontSize: '1.05rem', fontWeight: 800, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
const grid7 = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 };
const dayCell = (inMonth, isSel, isToday) => ({
  height: 34, border: 'none', borderRadius: 9, cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
  fontSize: '0.82rem', fontWeight: isSel ? 800 : 600,
  background: isSel ? VIOLET : 'transparent',
  color: isSel ? '#fff' : inMonth ? INK : 'rgba(91,33,182,0.3)',
  boxShadow: !isSel && isToday ? `inset 0 0 0 1.5px ${VIOLET}` : 'none',
  transition: 'background 120ms',
});
const timeSel = { border: '1px solid rgba(124,58,237,0.3)', borderRadius: 8, padding: '5px 6px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK, background: '#fff', cursor: 'pointer' };
const doneBtn = { border: 'none', borderRadius: 8, padding: '6px 14px', background: `linear-gradient(135deg, ${VIOLET}, ${VIOLET_DARK})`, color: '#fff', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem' };
const linkBtn = { border: 'none', background: 'transparent', color: VIOLET, cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.8rem', padding: '4px 6px' };
