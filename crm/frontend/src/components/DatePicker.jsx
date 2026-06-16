import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

/* DatePicker — a date-only, app-styled calendar popup that replaces the native
   <input type="date">. Value/onChange use 'YYYY-MM-DD' strings (same as the
   native input), so it's a drop-in. `min` / `max` (also 'YYYY-MM-DD') disable
   out-of-range days. The popup is portaled to <body> with fixed positioning so
   it never gets clipped by a scrolling/overflow-hidden parent. */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Mo','Tu','We','Th','Fr','Sa','Su'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseYmd(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const firstWeekday = (y, m) => (new Date(y, m, 1).getDay() + 6) % 7; // Mon=0 … Su=6

export default function DatePicker({ value, onChange, min, max, placeholder = 'Select date' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, left: 0 });
  const sel = parseYmd(value);
  const [viewY, setViewY] = useState(() => (sel || new Date()).getFullYear());
  const [viewM, setViewM] = useState(() => (sel || new Date()).getMonth());
  const wrapRef    = useRef(null);
  const triggerRef = useRef(null);
  const panelRef   = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Keep the visible month in sync with the value when it changes externally.
  useEffect(() => {
    const s = parseYmd(value);
    if (s) { setViewY(s.getFullYear()); setViewM(s.getMonth()); }
  }, [value]);

  const minD = parseYmd(min);
  const maxD = parseYmd(max);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  function toggle() {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen((o) => !o);
  }
  function prevMonth() { if (viewM === 0) { setViewM(11); setViewY((y) => y - 1); } else setViewM((m) => m - 1); }
  function nextMonth() { if (viewM === 11) { setViewM(0); setViewY((y) => y + 1); } else setViewM((m) => m + 1); }
  function pick(day)   { onChange(ymd(new Date(viewY, viewM, day))); setOpen(false); }

  const display = sel
    ? `${pad(sel.getDate())} ${MONTHS[sel.getMonth()].slice(0, 3)} ${sel.getFullYear()}`
    : '';

  const isDisabled = (day) => {
    const d = new Date(viewY, viewM, day);
    return (minD && d < minD) || (maxD && d > maxD);
  };
  const isSelected = (day) => sel && sel.getFullYear() === viewY && sel.getMonth() === viewM && sel.getDate() === day;
  const isToday    = (day) => today.getFullYear() === viewY && today.getMonth() === viewM && today.getDate() === day;

  const nDays = daysInMonth(viewY, viewM);
  const lead  = firstWeekday(viewY, viewM);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={triggerRef} type="button" onClick={toggle} style={{ ...pill, borderColor: open ? 'rgba(91,33,182,0.55)' : 'rgba(124,58,237,0.25)', boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.55)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span style={{ color: display ? '#3B0764' : 'rgba(91,33,182,0.45)' }}>{display || placeholder}</span>
      </button>

      {open && createPortal(
        <div ref={panelRef} onMouseDown={(e) => e.stopPropagation()} style={{ ...panel, top: pos.top, left: pos.left }}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" onClick={prevMonth} style={navBtn}>‹</button>
            <span style={{ fontWeight: 700, fontSize: '0.86rem', color: '#3B0764' }}>{MONTHS[viewM]} {viewY}</span>
            <button type="button" onClick={nextMonth} style={navBtn}>›</button>
          </div>
          {/* Day-of-week headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 2 }}>
            {DAYS.map((d) => <div key={d} style={{ textAlign: 'center', fontSize: '0.62rem', fontWeight: 700, color: 'rgba(91,33,182,0.4)' }}>{d}</div>)}
          </div>
          {/* Day grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
            {Array.from({ length: lead }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: nDays }, (_, i) => i + 1).map((day) => {
              const dis = isDisabled(day), s = isSelected(day), t = isToday(day);
              return (
                <button
                  key={day} type="button" disabled={dis} onClick={() => pick(day)}
                  style={{
                    height: 28, borderRadius: 7, border: t && !s ? '1.5px solid rgba(91,33,182,0.35)' : 'none',
                    cursor: dis ? 'not-allowed' : 'pointer',
                    background: s ? '#5B21B6' : t ? 'rgba(139,92,246,0.12)' : 'transparent',
                    color: dis ? '#d1d5db' : s ? '#fff' : '#3B0764',
                    fontWeight: s ? 700 : t ? 600 : 400, fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                    opacity: dis ? 0.5 : 1,
                  }}
                >{day}</button>
              );
            })}
          </div>
          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, borderTop: '1px solid rgba(139,92,246,0.12)', paddingTop: 7 }}>
            <button type="button" onClick={() => { onChange(''); setOpen(false); }} style={linkBtn}>Clear</button>
            <button type="button" onClick={() => { onChange(ymd(new Date())); setOpen(false); }} style={linkBtn}>Today</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

const pill    = { display: 'inline-flex', alignItems: 'center', gap: 7, height: '2.1rem', padding: '0 12px', borderRadius: 9, border: '1px solid rgba(124,58,237,0.25)', background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', cursor: 'pointer', outline: 'none', whiteSpace: 'nowrap', transition: 'border 160ms, box-shadow 160ms' };
const panel   = { position: 'fixed', zIndex: 10000, background: '#fff', border: '1px solid rgba(139,92,246,0.18)', borderRadius: 12, boxShadow: '0 12px 40px rgba(91,33,182,0.18)', padding: '10px 12px', width: 240, fontFamily: 'Outfit, sans-serif' };
const navBtn  = { width: 26, height: 26, borderRadius: 7, border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(237,234,248,0.5)', color: '#5B21B6', cursor: 'pointer', fontWeight: 800, fontSize: '1rem', lineHeight: 1 };
const linkBtn = { border: 'none', background: 'transparent', color: '#5B21B6', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.78rem' };
