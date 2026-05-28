import { useState, useEffect, useCallback } from 'react';
import Toast from '../components/Toast';
import { TIMER_GROUPS, TIMER_DEFAULTS, EDITABLE_KEYS, clampTimer, mergeTimerSettings } from '../config/timerSchema';

/* Only the EDITABLE_KEYS are shown on the page — every other timing is fixed
   permanently in code. Groups are filtered to their editable items; empty
   groups drop out entirely. */
const VISIBLE_GROUPS = TIMER_GROUPS
  .map(g => ({ ...g, items: g.items.filter(it => EDITABLE_KEYS.includes(it.key)) }))
  .filter(g => g.items.length > 0);

/* ──────────────────────────────────────────────────────────────────────────
   Timer — admin-tunable timing settings for the Sales dashboard.

   Every adjustable interval / delay / count in the CRM lives in
   config/timerSchema.js. This page renders one card per TIMER_GROUPS entry,
   one numeric input per item, and writes the flat { key:value } map back via
   PUT /api/admin/timer-settings.

   DISPLAY UNIT: durations are stored in MILLISECONDS (the caller app and the
   backend schedulers consume ms), but this page shows and accepts SECONDS so
   the admin never has to think in ms. Conversion happens only at the load /
   save boundary — `settings` state is always held in DISPLAY units:
     unit 'ms'    → shown in seconds   (ms ÷ 1000)
     unit 'sec'   → shown in seconds   (unchanged)
     unit 'count' → shown as a plain count (unchanged)
   ────────────────────────────────────────────────────────────────────────── */

/* Display-unit suffix. Most durations read as "sec"; long-scale durations
   (unit 'min') read as "min"; counts as "×". */
function unitLabel(unit) {
  if (unit === 'count') return '×';
  if (unit === 'min')   return 'min';
  return 'sec';
}

/* Native scale per schema unit. Native is always milliseconds for time
   fields. Returns how many native units make up ONE display unit. */
function nativePerDisplay(unit) {
  if (unit === 'ms')  return 1000;     // 1 display-sec = 1000 ms
  if (unit === 'min') return 60000;    // 1 display-min = 60000 ms
  return 1;                            // 'sec' / 'count' are already native
}

/* ms (or native) → display unit. */
function toDisplay(item, native) {
  const n = Number(native);
  const scale = nativePerDisplay(item.unit);
  if (!Number.isFinite(n)) return item.default / scale;
  return n / scale;
}

/* display unit → ms (or native), as an integer. */
function toNative(item, disp) {
  const n = Number(disp);
  if (!Number.isFinite(n)) return item.default;
  return Math.round(n * nativePerDisplay(item.unit));
}

/* Clamp a display-unit value to the schema bounds (bounds are native, so
   round-trip through clampTimer). */
function clampDisplay(item, disp) {
  return toDisplay(item, clampTimer(item.key, toNative(item, disp)));
}

/* Convert a whole { key: nativeValue } map into display units. */
function toDisplayAll(nativeMap) {
  const out = {};
  for (const group of TIMER_GROUPS) {
    for (const item of group.items) out[item.key] = toDisplay(item, nativeMap[item.key]);
  }
  return out;
}

/* Friendly hint shown next to the input.
     – 'sec'/'ms' fields → "≈ N min" once they cross a minute.
     – 'min' fields      → "≈ N hour" once they cross an hour, else blank.
     – 'count'           → no hint. */
function friendlyHint(item, dispValue) {
  if (item.unit === 'count') return '';
  const v = Number(dispValue);
  if (!Number.isFinite(v)) return '';
  if (item.unit === 'min') {
    if (v < 60) return '';
    const h = v / 60;
    return `≈ ${Number.isInteger(h) ? h : h.toFixed(1)} hour`;
  }
  if (v < 60) return '';
  const m = v / 60;
  return `≈ ${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/* Trim trailing-zero noise from a converted number (e.g. 0.420 → 0.42). */
function tidy(n) {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : n;
}

export default function SalesTimerView({ token, readOnly = false }) {
  // `settings` is always held in DISPLAY units (seconds / counts).
  const [settings, setSettings] = useState(() => toDisplayAll(TIMER_DEFAULTS));
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [toast, setToast]       = useState(null);          // { msg, kind }
  const [collapsed, setCollapsed] = useState({});          // { groupId: true }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/timer-settings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load timer settings.');
      const data = await res.json();
      setSettings(toDisplayAll(mergeTimerSettings(data.settings)));
      setError('');
    } catch (e) {
      // Backend may not be ready yet — still render with schema defaults.
      setSettings(toDisplayAll(TIMER_DEFAULTS));
      setError(`${e.message} Showing default values.`);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const itemByKey = useCallback((key) => {
    for (const g of TIMER_GROUPS) {
      for (const it of g.items) if (it.key === key) return it;
    }
    return null;
  }, []);

  /* Raw text typing — clamped on blur, not on every keystroke, so the admin
     can freely edit a value mid-type without it snapping. */
  function handleChange(key, raw) {
    setSettings(prev => ({ ...prev, [key]: raw }));
  }
  function handleBlur(key) {
    const item = itemByKey(key);
    setSettings(prev => ({ ...prev, [key]: item ? tidy(clampDisplay(item, prev[key])) : prev[key] }));
  }

  function resetGroup(group) {
    setSettings(prev => {
      const next = { ...prev };
      for (const item of group.items) next[item.key] = tidy(toDisplay(item, item.default));
      return next;
    });
  }
  function resetAll() {
    setSettings(toDisplayAll(TIMER_DEFAULTS));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      // Convert display units → ms and clamp every value before persisting,
      // so an un-blurred field can't send an out-of-range number.
      const payload = {};
      for (const group of VISIBLE_GROUPS) {
        for (const item of group.items) {
          payload[item.key] = clampTimer(item.key, toNative(item, settings[item.key]));
        }
      }
      const res = await fetch('/api/admin/timer-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: payload }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Save failed — please try again.');
      setSettings(toDisplayAll(mergeTimerSettings(d.settings || payload)));
      setToast({ msg: 'Timer settings saved', kind: 'success' });
    } catch (e) {
      setError(e.message);
      setToast({ msg: e.message, kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  function toggleGroup(id) {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 80 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1rem', color: '#3B0764' }}>
            Timer settings
          </h3>
          <span style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit, sans-serif' }}>
            Robot-nudge &amp; auto-pause timings, per caller card — all times in seconds
          </span>
        </div>
        <button
          onClick={resetAll}
          disabled={loading}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 50,
            border: '1px solid rgba(220,38,38,0.35)', background: '#fff',
            color: '#B91C1C', fontFamily: 'Outfit, sans-serif',
            fontWeight: 700, fontSize: '0.8rem',
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Reset all to defaults
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-card shadow-card" style={{ padding: 40, textAlign: 'center', fontFamily: 'Outfit, sans-serif', color: 'rgba(91,33,182,0.55)', fontSize: '0.88rem' }}>
          Loading timer settings…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {VISIBLE_GROUPS.map(group => {
            const isCollapsed = !!collapsed[group.id];
            return (
              <div
                key={group.id}
                className="bg-white rounded-card shadow-card"
                style={{ padding: 0, overflow: 'hidden' }}
              >
                {/* Section header — click to collapse/expand */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, padding: '14px 18px', cursor: 'pointer',
                    borderBottom: isCollapsed ? 'none' : '1px solid rgba(209,196,240,0.45)',
                    background: 'rgba(237,234,248,0.35)',
                  }}
                  onClick={() => toggleGroup(group.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="#5B21B6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: `rotate(${isCollapsed ? -90 : 0}deg)`, transition: 'transform 180ms' }}
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                    <h4 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem', color: '#3B0764' }}>
                      {group.label}
                    </h4>
                    <span style={{
                      background: '#EDE9FE', color: '#5B21B6', borderRadius: 50,
                      padding: '2px 9px', fontSize: '0.68rem', fontWeight: 800,
                      fontFamily: 'Outfit, sans-serif',
                    }}>
                      {group.items.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); resetGroup(group); }}
                    style={{
                      padding: '5px 12px', borderRadius: 50,
                      border: '1px solid rgba(91,33,182,0.30)',
                      background: '#fff', color: '#5B21B6',
                      fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.72rem',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    Reset section
                  </button>
                </div>

                {/* Section body */}
                {!isCollapsed && (
                  <div style={{ padding: '8px 18px 16px' }}>
                    {group.items.map(item => {
                      const value = settings[item.key];
                      const hint  = friendlyHint(item, value);
                      const suffix = unitLabel(item.unit);
                      const dispMin = tidy(toDisplay(item, item.min));
                      const dispMax = tidy(toDisplay(item, item.max));
                      const dispDefault = tidy(toDisplay(item, item.default));
                      const isDefault = clampDisplay(item, value) === dispDefault;
                      return (
                        <div
                          key={item.key}
                          style={{
                            display: 'flex', alignItems: 'flex-start', gap: 16,
                            padding: '12px 0', borderBottom: '1px solid rgba(209,196,240,0.30)',
                            flexWrap: 'wrap',
                          }}
                        >
                          {/* Label + help */}
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <label
                                htmlFor={`timer-${item.key}`}
                                style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.85rem', color: '#3B0764' }}
                              >
                                {item.label}
                              </label>
                              {!isDefault && (
                                <span style={{
                                  fontSize: '0.62rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                                  background: 'rgba(245,158,11,0.14)', color: '#B45309',
                                  borderRadius: 50, padding: '2px 7px', textTransform: 'uppercase',
                                  letterSpacing: '0.04em',
                                }}>
                                  Changed
                                </span>
                              )}
                            </div>
                            <p style={{
                              margin: '3px 0 0', fontFamily: 'Outfit, sans-serif',
                              fontSize: '0.74rem', color: 'rgba(91,33,182,0.60)', lineHeight: 1.4,
                            }}>
                              {item.help}
                            </p>
                            <p style={{
                              margin: '3px 0 0', fontFamily: 'Outfit, sans-serif',
                              fontSize: '0.68rem', color: 'rgba(91,33,182,0.40)',
                            }}>
                              Range {dispMin}–{dispMax} {suffix} · default {dispDefault}
                            </p>
                          </div>

                          {/* Numeric input — in seconds (or count) */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                            <input
                              id={`timer-${item.key}`}
                              type="number"
                              value={value}
                              min={dispMin}
                              max={dispMax}
                              step={item.unit === 'count' ? 1 : 'any'}
                              onChange={e => handleChange(item.key, e.target.value)}
                              onBlur={() => handleBlur(item.key)}
                              readOnly={readOnly}
                              disabled={readOnly}
                              title={readOnly ? 'Read-only — ask your manager to adjust this.' : undefined}
                              style={{
                                width: 110, height: '2.5rem', padding: '0 10px', borderRadius: 8,
                                border: '1px solid rgba(209,196,240,0.85)',
                                background: readOnly ? 'rgba(237,234,248,0.55)' : 'rgba(237,234,248,0.30)',
                                fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', fontWeight: 600,
                                color: readOnly ? 'rgba(59,7,100,0.55)' : '#3B0764',
                                outline: 'none', boxSizing: 'border-box',
                                textAlign: 'right',
                                cursor: readOnly ? 'not-allowed' : 'auto',
                              }}
                            />
                            <span style={{
                              fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 700,
                              color: 'rgba(91,33,182,0.65)', minWidth: 26,
                            }}>
                              {suffix}
                            </span>
                            {hint && (
                              <span style={{
                                fontFamily: 'Outfit, sans-serif', fontSize: '0.70rem',
                                color: 'rgba(91,33,182,0.45)', whiteSpace: 'nowrap',
                              }}>
                                {hint}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Floating save button — transparent wrapper, sits over the page
          content; only the button itself catches clicks. Hidden entirely
          for TL view (readOnly): TLs see the department-wide timer config
          but cannot mutate it. Backend also rejects PUT /timer-settings
          from a team_leader JWT (403) as a defense-in-depth. */}
      {!loading && !readOnly && (
        <div style={{
          position: 'sticky', bottom: 16, zIndex: 20,
          display: 'flex', justifyContent: 'flex-end',
          marginTop: 4, pointerEvents: 'none',
        }}>
          <button
            onClick={save}
            disabled={saving}
            style={{
              pointerEvents: 'auto',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 24px', borderRadius: 50, border: 'none',
              background: saving ? 'rgba(91,33,182,0.45)' : '#5B21B6',
              color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700,
              fontSize: '0.86rem', cursor: saving ? 'wait' : 'pointer',
              boxShadow: '0 6px 22px rgba(91,33,182,0.40)',
            }}
          >
            {saving ? (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.30)" strokeWidth="4"/>
                  <path d="M4 12a8 8 0 018-8" stroke="#fff" strokeWidth="4" strokeLinecap="round"/>
                </svg>
                Saving…
              </>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                  <polyline points="17 21 17 13 7 13 7 21"/>
                  <polyline points="7 3 7 8 15 8"/>
                </svg>
                Save changes
              </>
            )}
          </button>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {toast && <Toast message={toast.msg} kind={toast.kind} onDone={() => setToast(null)} />}
    </div>
  );
}
