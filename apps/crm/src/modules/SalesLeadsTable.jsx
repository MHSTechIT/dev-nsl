import { useState, useEffect, useCallback } from 'react';

const SUGAR_BADGE = {
  '250+':    { bg: '#FEE2E2', fg: '#B91C1C' },
  '150-250': { bg: '#FEF9C3', fg: '#A16207' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
}

function fmtPhone(p) {
  if (!p) return '—';
  const digits = String(p).replace(/\D/g, '');
  return digits.startsWith('91') ? '+' + digits : '+91 ' + digits;
}

const PAGE_SIZE = 10;

export default function SalesLeadsTable({ token }) {
  const [leads, setLeads]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [page, setPage]       = useState(1);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/leads', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load leads.');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) {
      setError(e.message || 'Failed to load leads.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const filtered = leads.filter(l => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const blob = `${l.full_name || ''} ${l.email || ''} ${l.whatsapp_number || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows  = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => { setPage(1); }, [search]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Search toolbar */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 16 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search the pipeline by name, email, or phone…"
            style={{ width: '100%', height: '2.4rem', padding: '0 12px 0 34px', borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)', background: 'rgba(237,234,248,0.30)', fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(254,242,242,0.9)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
        </div>
      )}

      {/* Pipeline table */}
      <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontFamily: 'Outfit,sans-serif', fontSize: '0.9rem' }}>Loading pipeline…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit,sans-serif' }}>
            <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>
              {leads.length === 0 ? 'No leads in pipeline yet' : 'No matches'}
            </div>
            <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem' }}>
              {leads.length === 0 ? 'Once people register, they will land here.' : 'Try clearing the search or score filter.'}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Outfit, sans-serif' }}>
              <thead>
                <tr style={{ background: 'rgba(237,234,248,0.50)', textAlign: 'left' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Sugar</th>
                  <th style={thStyle}>Registered</th>
                  <th style={thStyle}>Assigned To</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(l => {
                  const sugar = SUGAR_BADGE[l.sugar_level] || { bg: '#F3F4F6', fg: '#4B5563' };
                  return (
                    <tr key={l.id} style={{ borderTop: '1px solid rgba(209,196,240,0.30)' }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: '#3B0764' }}>{l.full_name || '—'}</div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email || '—'}</div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.80rem' }}>
                        {fmtPhone(l.whatsapp_number)}
                      </td>
                      <td style={tdStyle}><span style={badgeStyle(sugar)}>{l.sugar_level || '—'}</span></td>
                      <td style={{ ...tdStyle, fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)' }}>{fmtDate(l.created_at)}</td>
                      <td style={tdStyle}>
                        {l.assigned_to_name
                          ? <span style={{ fontWeight: 600, color: '#3B0764', fontSize: '0.84rem' }}>{l.assigned_to_name}</span>
                          : <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 50, fontSize: '0.72rem', fontWeight: 700, background: 'rgba(107,114,128,0.12)', color: '#6B7280' }}>Unassigned</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderTop: '1px solid rgba(209,196,240,0.30)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: 'rgba(91,33,182,0.65)',
            flexWrap: 'wrap', gap: 8,
          }}>
            <span>
              Showing <b style={{ color: '#3B0764' }}>{pageStart + 1}</b>–
              <b style={{ color: '#3B0764' }}>{Math.min(pageStart + PAGE_SIZE, filtered.length)}</b> of{' '}
              <b style={{ color: '#3B0764' }}>{filtered.length}</b>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <PageBtn disabled={currentPage === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹ Prev</PageBtn>
              <span style={{ padding: '0 10px', fontWeight: 700, color: '#3B0764' }}>
                Page {currentPage} / {totalPages}
              </span>
              <PageBtn disabled={currentPage === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next ›</PageBtn>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function PageBtn({ children, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px', borderRadius: 8,
        border: '1px solid rgba(91,33,182,0.20)',
        background: disabled ? 'rgba(237,234,248,0.50)' : '#fff',
        color: disabled ? 'rgba(91,33,182,0.35)' : '#5B21B6',
        fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const thStyle = {
  padding: '12px 16px',
  fontSize: '0.72rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'rgba(91,33,182,0.60)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '14px 16px',
  fontSize: '0.86rem',
  color: '#3B0764',
  verticalAlign: 'middle',
};

function badgeStyle(badge) {
  return {
    display: 'inline-block', padding: '3px 10px', borderRadius: 50,
    fontSize: '0.72rem', fontWeight: 700,
    background: badge.bg, color: badge.fg,
    whiteSpace: 'nowrap',
  };
}
