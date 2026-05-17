import { useEffect, useState, useRef } from 'react';

/* ── Helpers ── */
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function getLinkIndex(leadCount) {
  return Math.max(1, Math.ceil(leadCount / 950));
}

/* ── Editable Link Row ── */
function LinkRow({ label, value, onChange, bg, isActive, readOnly }) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <label style={{
          fontFamily: 'Outfit, sans-serif', fontSize: '0.75rem', fontWeight: 700,
          color: '#4A1A94',
        }}>
          {label}
        </label>
        {isActive && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '1px 8px', borderRadius: 20,
            background: 'rgba(5,150,105,0.10)', border: '1px solid rgba(5,150,105,0.30)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.62rem', fontWeight: 700,
            color: '#059669', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e' }} />
            Active
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          flex: 1, position: 'relative',
          background: bg || 'rgba(237,234,248,0.30)',
          borderRadius: 10,
          border: editing
            ? '1.5px solid rgba(91,33,182,0.50)'
            : isActive
              ? '1.5px solid rgba(5,150,105,0.35)'
              : '1px solid rgba(139,92,246,0.18)',
          transition: 'border 200ms',
        }}>
          <input
            ref={inputRef}
            type="url"
            value={value}
            onChange={e => onChange(e.target.value)}
            readOnly={!editing && !readOnly}
            placeholder="https://chat.whatsapp.com/..."
            style={{
              width: '100%', height: '2.6rem',
              padding: '0 12px',
              borderRadius: 10, border: 'none',
              background: 'transparent',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem',
              color: '#3B0764', fontWeight: 500,
              outline: 'none', boxSizing: 'border-box',
              cursor: editing ? 'text' : 'default',
            }}
          />
        </div>
        <button
          onClick={() => setEditing(!editing)}
          title={editing ? 'Done' : 'Edit'}
          style={{
            width: 36, height: 36, borderRadius: 10,
            border: '1px solid rgba(139,92,246,0.20)',
            background: editing ? 'rgba(91,33,182,0.08)' : 'rgba(237,234,248,0.50)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, transition: 'all 200ms',
          }}
        >
          {editing ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              <path d="m15 5 4 4"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/* ── Webinar Column Card ── */
function WebinarCard({ type, webinarDate, webinarId, webinarName, links, setLinks, leadCount, saving, onSave, toast }) {
  const isCurrent = type === 'current';
  const activeLinkIndex = isCurrent ? Math.min(getLinkIndex(leadCount), links.length || 1) : 0;

  function updateLink(index, url) {
    setLinks(prev => prev.map((l, i) => i === index ? { ...l, link_url: url } : l));
  }

  function addLink() {
    setLinks(prev => [...prev, { link_url: '', order_index: prev.length + 1 }]);
  }

  function removeLink(index) {
    setLinks(prev => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, order_index: i + 1 })));
  }

  return (
    <div className="wa-card" style={{
      flex: 1, minWidth: 0,
      background: '#fff', borderRadius: 18,
      border: isCurrent
        ? '2px solid rgba(5,150,105,0.35)'
        : '2px solid rgba(91,33,182,0.25)',
      padding: 0,
      boxShadow: '0 2px 16px rgba(91,33,182,0.06)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px',
        borderBottom: isCurrent
          ? '1px solid rgba(5,150,105,0.15)'
          : '1px solid rgba(91,33,182,0.10)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div className="wa-card-header-pill" style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 20px', borderRadius: 50,
          border: isCurrent
            ? '1.5px solid rgba(5,150,105,0.40)'
            : '1.5px solid rgba(91,33,182,0.30)',
          background: isCurrent
            ? 'rgba(5,150,105,0.06)'
            : 'rgba(91,33,182,0.04)',
          flexWrap: 'nowrap', justifyContent: 'center', textAlign: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke={isCurrent ? '#059669' : '#5B21B6'}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0 }}>
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', fontWeight: 700,
            color: isCurrent ? '#059669' : '#5B21B6',
          }}>
            {isCurrent ? 'Current Webinar' : 'Upcoming Webinar'}{webinarName ? ` (${webinarName})` : ''} — {fmtDate(webinarDate)}
          </span>
        </div>
      </div>

      {/* Lead count + rotation info (current only) */}
      {isCurrent && webinarId && (
        <div style={{
          margin: '14px 20px 0', padding: '10px 14px',
          background: 'rgba(5,150,105,0.04)', borderRadius: 10,
          border: '1px solid rgba(5,150,105,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600, color: '#059669' }}>
              {leadCount} Leads
            </span>
          </div>
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.72rem', fontWeight: 600, color: 'rgba(5,150,105,0.65)' }}>
            Active: Link {activeLinkIndex} (rotates every 950)
          </span>
        </div>
      )}

      {/* Links */}
      <div style={{ padding: '18px 20px 6px', flex: 1 }}>
        {!webinarId ? (
          <div style={{
            textAlign: 'center', padding: '32px 16px',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem',
            color: 'rgba(91,33,182,0.45)', fontWeight: 500,
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.25)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}>
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <p>No {isCurrent ? 'active' : 'upcoming'} webinar set.</p>
            <p style={{ fontSize: '0.75rem', marginTop: 4 }}>Set the date in Timer & Controls tab.</p>
          </div>
        ) : (
          <>
            {links.map((link, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <LinkRow
                  label={isCurrent && i === 0 ? 'Current Link' : `${isCurrent ? 'Upcoming' : ''} Link ${i + 1}`}
                  value={link.link_url}
                  onChange={url => updateLink(i, url)}
                  bg={isCurrent && i === activeLinkIndex - 1 ? 'rgba(5,150,105,0.06)' : undefined}
                  isActive={isCurrent && i === activeLinkIndex - 1}
                />
                {links.length > 1 && (
                  <button
                    onClick={() => removeLink(i)}
                    title="Remove link"
                    style={{
                      position: 'absolute', top: 0, right: 0,
                      width: 20, height: 20, borderRadius: '50%',
                      border: '1px solid rgba(220,38,38,0.30)',
                      background: 'rgba(254,242,242,0.80)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 200ms',
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="3" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                )}
              </div>
            ))}

            {/* Add link button */}
            <button
              onClick={addLink}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                width: '100%', height: '2.4rem', borderRadius: 10,
                border: '1.5px dashed rgba(139,92,246,0.30)',
                background: 'rgba(237,234,248,0.25)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
                color: '#5B21B6', cursor: 'pointer', marginBottom: 16,
                transition: 'all 200ms',
              }}
              onMouseEnter={e => e.target.style.background = 'rgba(237,234,248,0.50)'}
              onMouseLeave={e => e.target.style.background = 'rgba(237,234,248,0.25)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Link
            </button>

            {/* Rotation info */}
            {links.length > 1 && (
              <div style={{
                padding: '8px 12px', borderRadius: 8,
                background: 'rgba(237,234,248,0.40)',
                fontFamily: 'Outfit, sans-serif', fontSize: '0.70rem', fontWeight: 500,
                color: 'rgba(91,33,182,0.55)', lineHeight: 1.5, marginBottom: 12,
              }}>
                Links auto-rotate every 950 leads:
                {links.map((_, i) => (
                  <span key={i}> Link {i + 1} = {i * 950}–{(i + 1) * 950} leads{i < links.length - 1 ? ',' : '+'}</span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Save button */}
      {webinarId && (
        <div style={{ padding: '0 20px 20px', display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center' }}>
          <button
            onClick={onSave}
            disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              height: '2.5rem', padding: '0 36px', borderRadius: 50,
              border: 'none',
              background: saving
                ? 'rgba(91,33,182,0.55)'
                : isCurrent ? '#059669' : '#5B21B6',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.88rem',
              color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: isCurrent
                ? '0 2px 10px rgba(5,150,105,0.25)'
                : '0 2px 10px rgba(91,33,182,0.22)',
              opacity: saving ? 0.7 : 1, transition: 'all 200ms',
            }}
          >
            {saving ? (
              <>
                <svg style={{ animation: 'spin 1s linear infinite', width: 14, height: 14 }} viewBox="0 0 24 24" fill="none">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Saving...
              </>
            ) : 'Save'}
          </button>
          {toast && (
            <span style={{
              fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', fontWeight: 600,
              color: toast.ok ? '#15803d' : '#DC2626',
            }}>
              {toast.ok ? '✓' : '✕'} {toast.msg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════ WhatsAppLinksEditor ══════════════════════ */
export default function WhatsAppLinksEditor({ token, source = 'meta' }) {
  const [webinars, setWebinars] = useState([]);
  const [config, setConfig]     = useState({});

  // Current webinar state
  const [curLinks, setCurLinks]     = useState([{ link_url: '', order_index: 1 }]);
  const [savingCur, setSavingCur]   = useState(false);
  const [toastCur, setToastCur]     = useState(null);

  // Upcoming webinar state
  const [upLinks, setUpLinks]       = useState([{ link_url: '', order_index: 1 }]);
  const [savingUp, setSavingUp]     = useState(false);
  const [toastUp, setToastUp]       = useState(null);

  // Find active + upcoming webinars
  const activeWebinar = webinars.find(w => w.is_active);
  const upcomingWebinar = config.backup_webinar_at
    ? webinars.find(w => {
        const wDate = new Date(w.webinar_at).getTime();
        const bDate = new Date(config.backup_webinar_at).getTime();
        return Math.abs(wDate - bDate) < 60000; // within 1 minute
      })
    : null;

  function loadData() {
    // Fetch webinars + config in parallel
    Promise.all([
      fetch(`/api/admin/webinars?source=${source}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`/api/webinar-config?source=${source}`).then(r => r.json()),
    ]).then(([wData, cData]) => {
      setWebinars(wData.webinars || []);
      setConfig(cData);
    }).catch(() => {});
  }

  useEffect(() => { loadData(); }, [token, source]);

  // Load links when webinars change
  useEffect(() => {
    if (activeWebinar?.id) {
      fetch(`/api/admin/wa-links?webinar_id=${activeWebinar.id}&source=${source}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => {
          const links = d.links || [];
          if (links.length > 0) {
            setCurLinks(links);
          } else {
            // Pre-fill with current active link from webinar_config
            const currentLink = config.tuesday_whatsapp_link || config.friday_whatsapp_link || '';
            setCurLinks([{ link_url: currentLink, order_index: 1 }]);
          }
        })
        .catch(() => {});
    }
  }, [activeWebinar?.id, token, source, config.tuesday_whatsapp_link]);

  useEffect(() => {
    if (upcomingWebinar?.id) {
      fetch(`/api/admin/wa-links?webinar_id=${upcomingWebinar.id}&source=${source}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => {
          const links = d.links || [];
          setUpLinks(links.length > 0 ? links : [{ link_url: '', order_index: 1 }]);
        })
        .catch(() => {});
    } else {
      setUpLinks([{ link_url: '', order_index: 1 }]);
    }
  }, [upcomingWebinar?.id, token, source]);

  async function handleSave(webinarId, links, setSaving, setToast) {
    setSaving(true);
    setToast(null);

    try {
      const res = await fetch('/api/admin/wa-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          webinar_id: webinarId,
          source,
          links: links
            .map((l, i) => ({ link_url: (l.link_url || '').trim(), order_index: i + 1 }))
            .filter(l => l.link_url),
        }),
      });

      if (res.ok) {
        setToast({ ok: true, msg: 'Links saved! Rotation updated.' });
        loadData();
      } else {
        setToast({ ok: false, msg: 'Failed to save. Try again.' });
      }
    } catch {
      setToast({ ok: false, msg: 'Network error.' });
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  return (
    <div>
      <style>{`
        @media (max-width: 640px) {
          .wa-grid { grid-template-columns: 1fr !important; }
          .wa-card { min-width: 0 !important; }
          .wa-card-header-pill { padding: 6px 10px !important; }
          .wa-card-header-pill span { font-size: 0.68rem !important; }
        }
      `}</style>
      <div style={{ marginBottom: 24 }}>
        <h3 className="font-sans text-xl font-bold text-purple-900">WhatsApp Group Link</h3>
        <p className="font-sans text-sm text-purple-400 mt-1">
          Set the update link and the time — it will auto-activate on schedule.
        </p>
      </div>

      {/* Two-column layout */}
      <div className="wa-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 20,
        alignItems: 'start',
      }}>
        {/* Current Webinar Card */}
        <WebinarCard
          type="current"
          webinarDate={config.next_webinar_at}
          webinarId={activeWebinar?.id}
          webinarName={activeWebinar?.name}
          links={curLinks}
          setLinks={setCurLinks}
          leadCount={activeWebinar?.lead_count || 0}
          saving={savingCur}
          onSave={() => handleSave(activeWebinar?.id, curLinks, setSavingCur, setToastCur)}
          toast={toastCur}
        />

        {/* Upcoming Webinar Card */}
        <WebinarCard
          type="upcoming"
          webinarDate={config.backup_webinar_at}
          webinarId={upcomingWebinar?.id}
          webinarName={upcomingWebinar?.name}
          links={upLinks}
          setLinks={setUpLinks}
          leadCount={0}
          saving={savingUp}
          onSave={() => handleSave(upcomingWebinar?.id, upLinks, setSavingUp, setToastUp)}
          toast={toastUp}
        />
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
