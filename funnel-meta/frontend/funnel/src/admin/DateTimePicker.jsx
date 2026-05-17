import { useState, useRef, useEffect } from 'react';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfMonth(year, month) {
  // 0=Sun → convert to Mon-start
  const d = new Date(year, month, 1).getDay();
  return (d + 6) % 7; // Mon=0 … Sun=6
}

export default function DateTimePicker({ value, onChange, placeholder = 'Select date & time' }) {
  const [open, setOpen]       = useState(false);
  const [viewYear, setViewYear]   = useState(() => value ? new Date(value).getFullYear() : new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => value ? new Date(value).getMonth()    : new Date().getMonth());
  const [selDate, setSelDate] = useState(() => value ? new Date(value) : null);
  // 12-hour clock state
  const [hour12, setHour12]   = useState(() => {
    if (value) { const h = new Date(value).getHours(); return h % 12 || 12; }
    return 7; // 7 PM default
  });
  const [minute, setMinute]   = useState(() => value ? new Date(value).getMinutes() : 0);
  const [second, setSecond]   = useState(() => value ? new Date(value).getSeconds() : 0);
  const [ampm, setAmpm]       = useState(() => {
    if (value) { return new Date(value).getHours() < 12 ? 'AM' : 'PM'; }
    return 'PM';
  });
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });
  const ref = useRef(null);
  const triggerRef = useRef(null);

  /* close on outside click or scroll */
  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', h);
    document.addEventListener('scroll', () => setOpen(false), true);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('scroll', () => setOpen(false), true);
    };
  }, []);

  function openPicker() {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      const maxH = Math.min(360, window.innerHeight - 16);

      let top;
      if (spaceBelow >= maxH) {
        top = r.bottom + 4;
      } else if (spaceAbove >= maxH) {
        top = r.top - maxH - 4;
      } else {
        // not enough space either side — anchor to top with full available height
        top = 8;
      }
      setDropPos({ top, left: r.left, width: r.width, maxH });
    }
    setOpen(o => !o);
  }

  /* sync value prop → state */
  useEffect(() => {
    if (value) {
      const d = new Date(value);
      setSelDate(d);
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
      const h = d.getHours();
      setHour12(h % 12 || 12);
      setAmpm(h < 12 ? 'AM' : 'PM');
      setMinute(d.getMinutes());
      setSecond(d.getSeconds());
    } else {
      /* value cleared — reset picker to blank state */
      setSelDate(null);
      const now = new Date();
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth());
      setHour12(7);
      setMinute(0);
      setSecond(0);
      setAmpm('PM');
    }
  }, [value]);

  const pad = n => String(n).padStart(2, '0');

  function to24h(h12, ap) {
    if (ap === 'AM') return h12 === 12 ? 0 : h12;
    return h12 === 12 ? 12 : h12 + 12;
  }

  function commit(date, h12, m, s, ap) {
    if (!date) return;
    const d = new Date(date);
    const h24 = to24h(h12, ap);
    const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(h24)}:${pad(m)}:${pad(s)}`;
    onChange(local);
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  function pickDay(day) {
    const d = new Date(viewYear, viewMonth, day);
    setSelDate(d);
    commit(d, hour12, minute, second, ampm);
  }

  function changeHour(h) {
    setHour12(h);
    commit(selDate, h, minute, second, ampm);
  }
  function changeMinute(m) {
    setMinute(m);
    commit(selDate, hour12, m, second, ampm);
  }
  function changeSecond(s) {
    setSecond(s);
    commit(selDate, hour12, minute, s, ampm);
  }
  function toggleAmPm(ap) {
    setAmpm(ap);
    commit(selDate, hour12, minute, second, ap);
  }

  const daysInMonth  = getDaysInMonth(viewYear, viewMonth);
  const firstDay     = getFirstDayOfMonth(viewYear, viewMonth);
  const today        = new Date();

  const displayStr = selDate
    ? `${selDate.getDate()} ${MONTHS[selDate.getMonth()].slice(0,3)} ${selDate.getFullYear()}  ${pad(hour12)}:${pad(minute)}:${pad(second)} ${ampm}`
    : '';

  const isSelected = (day) =>
    selDate && selDate.getFullYear() === viewYear && selDate.getMonth() === viewMonth && selDate.getDate() === day;
  const isToday = (day) =>
    today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;
  const isPast = (day) => {
    const d = new Date(viewYear, viewMonth, day, 23, 59, 59);
    return d < today;
  };
  // True if the currently viewed month/year is entirely in the past
  const isViewingPastMonth = () => {
    return viewYear < today.getFullYear() ||
      (viewYear === today.getFullYear() && viewMonth < today.getMonth());
  };

  /* --- styles --- */
  const selStyle = {
    height: '1.7rem', padding: '0 4px', borderRadius: 7,
    border: '1px solid rgba(139,92,246,0.22)',
    background: 'rgba(237,234,248,0.40)',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.80rem',
    color: '#3B0764', outline: 'none', cursor: 'pointer',
  };

  const pill = {
    width: '100%', height: '2.8rem',
    padding: '0 14px',
    borderRadius: 12,
    border: open ? '1px solid rgba(91,33,182,0.55)' : '1px solid rgba(139,92,246,0.22)',
    background: 'rgba(237,234,248,0.40)',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.9rem',
    color: displayStr ? '#3B0764' : 'rgba(91,33,182,0.35)',
    cursor: 'pointer', textAlign: 'left',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    outline: 'none', transition: 'border 200ms',
    boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
  };

  const dropdown = {
    position: 'fixed',
    top: dropPos.top,
    left: dropPos.left,
    width: dropPos.width,
    maxHeight: dropPos.maxH || 360,
    overflowY: 'auto',
    background: '#fff',
    border: '1px solid rgba(139,92,246,0.18)',
    borderRadius: 14,
    boxShadow: '0 12px 48px rgba(91,33,182,0.16)',
    zIndex: 9999, padding: '10px 12px 12px',
    fontFamily: 'Outfit, sans-serif',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button ref={triggerRef} type="button" style={pill} onClick={openPicker}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.50)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {displayStr || placeholder}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.40)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div style={dropdown}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" onClick={prevMonth}
              disabled={!isViewingPastMonth() && viewYear === today.getFullYear() && viewMonth === today.getMonth()}
              style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(237,234,248,0.50)', cursor: (viewYear === today.getFullYear() && viewMonth === today.getMonth()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: (viewYear === today.getFullYear() && viewMonth === today.getMonth()) ? 0.3 : 1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#3B0764' }}>{MONTHS[viewMonth]} {viewYear}</span>
            <button type="button" onClick={nextMonth} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(237,234,248,0.50)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>

          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, marginBottom: 2 }}>
            {DAYS.map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: '0.63rem', fontWeight: 700, color: 'rgba(91,33,182,0.40)', padding: '1px 0' }}>{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1 }}>
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
              const sel = isSelected(day);
              const tod = isToday(day);
              const past = isPast(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={past}
                  onClick={() => !past && pickDay(day)}
                  style={{
                    height: 26, borderRadius: 7, border: 'none',
                    background: sel ? '#5B21B6' : tod ? 'rgba(139,92,246,0.12)' : 'transparent',
                    color: past ? '#d1d5db' : sel ? '#fff' : tod ? '#5B21B6' : '#3B0764',
                    fontWeight: sel ? 700 : tod ? 600 : 400,
                    fontSize: '0.78rem',
                    cursor: past ? 'not-allowed' : 'pointer',
                    transition: 'all 150ms',
                    outline: tod && !sel ? '1.5px solid rgba(91,33,182,0.35)' : 'none',
                    textDecoration: past ? 'line-through' : 'none',
                    opacity: past ? 0.5 : 1,
                  }}
                  onMouseEnter={e => { if (!sel && !past) e.currentTarget.style.background = 'rgba(139,92,246,0.15)'; }}
                  onMouseLeave={e => { if (!sel && !past) e.currentTarget.style.background = tod ? 'rgba(139,92,246,0.12)' : 'transparent'; }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'rgba(139,92,246,0.10)', margin: '8px 0 7px' }} />

          {/* Time picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.45)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(91,33,182,0.55)' }}>Time</span>

            {/* Hour (1–12) */}
            <select
              value={hour12}
              onChange={e => changeHour(Number(e.target.value))}
              style={selStyle}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
                <option key={h} value={h}>{pad(h)}</option>
              ))}
            </select>

            <span style={{ fontWeight: 700, color: '#5B21B6', fontSize: '0.9rem' }}>:</span>

            {/* Minute (0–59) */}
            <select
              value={minute}
              onChange={e => changeMinute(Number(e.target.value))}
              style={selStyle}
            >
              {Array.from({ length: 60 }, (_, i) => i).map(m => (
                <option key={m} value={m}>{pad(m)}</option>
              ))}
            </select>

            <span style={{ fontWeight: 700, color: '#5B21B6', fontSize: '0.9rem' }}>:</span>

            {/* Second (0–59) */}
            <select
              value={second}
              onChange={e => changeSecond(Number(e.target.value))}
              style={selStyle}
            >
              {Array.from({ length: 60 }, (_, i) => i).map(s => (
                <option key={s} value={s}>{pad(s)}</option>
              ))}
            </select>

            {/* AM / PM toggle */}
            <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(139,92,246,0.25)', marginLeft: 2 }}>
              {['AM', 'PM'].map(ap => (
                <button
                  key={ap}
                  type="button"
                  onClick={() => toggleAmPm(ap)}
                  style={{
                    padding: '0 9px', height: '1.7rem',
                    background: ampm === ap ? '#5B21B6' : 'rgba(237,234,248,0.40)',
                    color: ampm === ap ? '#fff' : '#5B21B6',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.75rem',
                    border: 'none', cursor: 'pointer', transition: 'all 150ms',
                  }}
                >
                  {ap}
                </button>
              ))}
            </div>

            <span style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.40)', fontWeight: 500 }}>IST</span>
          </div>

          {/* Done button */}
          {selDate && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                marginTop: 8, width: '100%', height: '2rem',
                borderRadius: 50, border: 'none',
                background: '#5B21B6',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                color: '#fff', cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(91,33,182,0.30)',
              }}
            >
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}
