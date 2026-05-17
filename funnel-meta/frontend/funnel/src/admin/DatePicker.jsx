import { useState, useRef, useEffect } from 'react';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Mo','Tu','We','Th','Fr','Sa','Su'];

function getDaysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function getFirstDayOfMonth(year, month) { return (new Date(year, month, 1).getDay() + 6) % 7; }

export default function DatePicker({ value, onChange, placeholder = 'Select date' }) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const [viewYear, setViewYear]   = useState(() => value ? parseInt(value.split('-')[0]) : now.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => value ? parseInt(value.split('-')[1]) - 1 : now.getMonth());
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (value) {
      const [y, m] = value.split('-').map(Number);
      setViewYear(y); setViewMonth(m - 1);
    }
  }, [value]);

  function openPicker() {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = 320;
      const top = spaceBelow >= maxH ? r.bottom + 4 : r.top - maxH - 4;
      setDropPos({ top, left: r.left, width: Math.max(r.width, 260) });
    }
    setOpen(o => !o);
  }

  const pad = n => String(n).padStart(2, '0');

  function pickDay(day) {
    onChange(`${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`);
    setOpen(false);
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);
  const today = new Date();

  // Parse selected date
  let selYear = null, selMonth = null, selDay = null;
  if (value) {
    const parts = value.split('-').map(Number);
    selYear = parts[0]; selMonth = parts[1] - 1; selDay = parts[2];
  }

  const isSelected = (day) => selYear === viewYear && selMonth === viewMonth && selDay === day;
  const isToday = (day) => today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;

  const displayStr = value
    ? `${selDay} ${MONTHS[selMonth].slice(0, 3)} ${selYear}`
    : '';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={triggerRef} type="button" onClick={openPicker} style={{
        height: '2.1rem', padding: '0 30px 0 10px', borderRadius: 10,
        border: open ? '1px solid rgba(91,33,182,0.55)' : '1px solid rgba(139,92,246,0.25)',
        background: '#fff', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
        color: displayStr ? '#3B0764' : 'rgba(91,33,182,0.35)',
        cursor: 'pointer', outline: 'none', textAlign: 'left',
        position: 'relative', whiteSpace: 'nowrap',
        boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.08)' : 'none',
        transition: 'border 200ms, box-shadow 200ms',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.45)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {displayStr || placeholder}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', right: 8, top: '50%', transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'fixed', top: dropPos.top, left: dropPos.left,
          width: dropPos.width, background: '#fff',
          border: '1px solid rgba(139,92,246,0.18)', borderRadius: 14,
          boxShadow: '0 12px 48px rgba(91,33,182,0.16)',
          zIndex: 9999, padding: '10px 12px 12px',
          fontFamily: 'Outfit, sans-serif',
        }}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" onClick={prevMonth} style={{
              width: 30, height: 30, borderRadius: 8,
              border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(237,234,248,0.50)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#3B0764' }}>{MONTHS[viewMonth]} {viewYear}</span>
            <button type="button" onClick={nextMonth} style={{
              width: 30, height: 30, borderRadius: 8,
              border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(237,234,248,0.50)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
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
              return (
                <button key={day} type="button" onClick={() => pickDay(day)} style={{
                  height: 28, borderRadius: 7, border: 'none',
                  background: sel ? '#5B21B6' : tod ? 'rgba(139,92,246,0.12)' : 'transparent',
                  color: sel ? '#fff' : tod ? '#5B21B6' : '#3B0764',
                  fontWeight: sel ? 700 : tod ? 600 : 400, fontSize: '0.78rem',
                  cursor: 'pointer', transition: 'all 150ms',
                  outline: tod && !sel ? '1.5px solid rgba(91,33,182,0.35)' : 'none',
                }}
                  onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(139,92,246,0.15)'; }}
                  onMouseLeave={e => { if (!sel) e.currentTarget.style.background = tod ? 'rgba(139,92,246,0.12)' : 'transparent'; }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Clear / Today buttons */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            {value && (
              <button type="button" onClick={() => { onChange(''); setOpen(false); }} style={{
                padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.25)',
                background: 'rgba(254,242,242,0.80)', fontFamily: 'Outfit, sans-serif',
                fontSize: '0.75rem', fontWeight: 600, color: '#DC2626', cursor: 'pointer',
              }}>Clear</button>
            )}
            <button type="button" onClick={() => pickDay(today.getDate())} style={{
              padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(139,92,246,0.25)',
              background: 'rgba(237,234,248,0.50)', fontFamily: 'Outfit, sans-serif',
              fontSize: '0.75rem', fontWeight: 600, color: '#5B21B6', cursor: 'pointer',
              marginLeft: 'auto',
            }}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
