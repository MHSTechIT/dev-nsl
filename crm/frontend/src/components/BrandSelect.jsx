import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/* Brand-styled single/multi select dropdown — matches the CRM aesthetic
   (purple, Outfit, white panel portaled to <body> so it never clips).
   Props:
     value        scalar (single) or string[] (multiple)
     onChange(v)  v is the picked value (single) or the new array (multiple)
     options      [{ value, label }]
     disabled, multiple, searchable, searchPlaceholder, placeholder
   Single-select keeps an empty-value option as its placeholder row. */

const bsInputStyle = {
  width: '100%', height: '2.6rem', padding: '0 12px', borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)', background: '#fff',
  fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', color: '#3B0764',
  outline: 'none', boxSizing: 'border-box',
};

export default function BrandSelect({
  value, onChange, options = [], disabled = false,
  searchable = false, searchPlaceholder = 'Search…',
  multiple = false, placeholder = 'Select…', compact = false,
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos]     = useState({ top: 0, left: 0, width: 0, maxH: 280 });
  const wrapRef    = useRef(null);
  const triggerRef = useRef(null);
  const panelRef   = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    function onScroll(e) {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = Math.min(340, Math.max(180, spaceBelow));
      const top  = spaceBelow >= 200 ? r.bottom + 4 : Math.max(8, r.top - maxH - 4);
      setPos({ top, left: r.left, width: r.width, maxH });
      setQuery('');
    }
    setOpen(o => !o);
  }

  const valArr = multiple ? (Array.isArray(value) ? value.map(String) : []) : [];
  const isSelectedVal = (ov) => multiple ? valArr.includes(String(ov)) : String(ov) === String(value);

  function pick(v) {
    if (multiple) {
      const s = String(v);
      onChange(valArr.includes(s) ? valArr.filter(x => x !== s) : [...valArr, s]);
    } else {
      onChange(v); setOpen(false);
    }
  }

  const selected = options.find(o => String(o.value) === String(value));
  const label    = multiple
    ? (valArr.length ? `${valArr.length} selected` : '')
    : (selected ? selected.label : '');
  const isPlaceholder = multiple ? valArr.length === 0 : !value;

  const placeholderOpt = options.find(o => o.value === '');
  const realOptions    = options.filter(o => o.value !== '');
  const q = query.trim().toLowerCase();
  const filtered = q ? realOptions.filter(o => String(o.label).toLowerCase().includes(q)) : realOptions;
  const visible  = (placeholderOpt && !multiple) ? [placeholderOpt, ...filtered] : filtered;

  const rowFor = (o) => {
    const isSel = isSelectedVal(o.value);
    return (
      <div
        key={String(o.value) || '__none__'}
        onClick={() => pick(o.value)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px', cursor: 'pointer',
          fontSize: '0.88rem', color: '#3B0764',
          fontWeight: isSel ? 700 : 500,
          background: isSel ? 'rgba(91,33,182,0.07)' : 'transparent',
          borderBottom: '1px solid rgba(139,92,246,0.07)',
          transition: 'background 120ms',
        }}
        onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(139,92,246,0.06)'; }}
        onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
      >
        {multiple ? (
          <span style={{
            width: 16, height: 16, flexShrink: 0, borderRadius: 4,
            border: isSel ? '1px solid #5B21B6' : '1px solid rgba(91,33,182,0.35)',
            background: isSel ? '#5B21B6' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isSel && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff"
                strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
            {isSel && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.label}
        </span>
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={{
          ...bsInputStyle,
          ...(compact ? { height: '2.1rem', fontSize: '0.8rem', padding: '0 10px' } : {}),
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
          fontWeight: isPlaceholder ? 500 : 700,
          color: isPlaceholder ? 'rgba(91,33,182,0.50)' : '#5B21B6',
          border: open ? '1px solid rgba(91,33,182,0.55)' : bsInputStyle.border,
          boxShadow: open ? '0 0 0 3px rgba(91,33,182,0.10)' : 'none',
          transition: 'border 160ms, box-shadow 160ms',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 180ms' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: Math.max(pos.width, 96),
            background: '#fff', border: '1px solid rgba(139,92,246,0.18)', borderRadius: 10,
            boxShadow: '0 14px 44px rgba(91,33,182,0.20)',
            zIndex: 10000, overflow: 'hidden', fontFamily: 'Outfit, sans-serif',
            display: 'flex', flexDirection: 'column', maxHeight: pos.maxH,
          }}
        >
          {searchable && (
            <div style={{ padding: 8, borderBottom: '1px solid rgba(139,92,246,0.12)', flexShrink: 0 }}>
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  width: '100%', height: 34, padding: '0 10px', borderRadius: 8,
                  border: '1px solid rgba(139,92,246,0.25)', outline: 'none',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: '#3B0764',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.7rem', color: 'rgba(91,33,182,0.55)', padding: '6px 2px 0', fontWeight: 600 }}>
                {q ? `${filtered.length} of ${realOptions.length}` : realOptions.length} item{realOptions.length === 1 ? '' : 's'}
              </div>
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {visible.length === 0
              ? <div style={{ padding: '14px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: 'rgba(91,33,182,0.5)' }}>No matches.</div>
              : visible.map(rowFor)}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
