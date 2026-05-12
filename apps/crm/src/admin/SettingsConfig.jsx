import { useEffect, useState, useCallback } from 'react';

/* ──────────────────────────────────────────────────────────────────────
   Settings panel — per-source admin preferences.
   Currently exposes one card: the WhatsApp number that should receive
   leads-alert WATI notifications when the upcoming webinar isn't set up
   in time. Reads/writes via /api/admin/settings.
   ────────────────────────────────────────────────────────────────────── */

export default function SettingsConfig({ token, source = 'meta' }) {
  const [phone, setPhone]       = useState('');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [testing, setTesting]   = useState(false);
  const [testMsg, setTestMsg]   = useState('');

  // Meta campaign multi-select
  const [campaigns, setCampaigns]           = useState([]);
  const [selectedCampaigns, setSelected]    = useState([]);   // string[] of campaign ids
  const [campaignsLoading, setCampLoading]  = useState(true);
  const [campaignsConfigured, setCampReady] = useState(false);
  const [campSaving, setCampSaving]         = useState(false);
  const [campSavedMsg, setCampSavedMsg]     = useState('');
  const [campOpen, setCampOpen]             = useState(false);
  const [campQuery, setCampQuery]           = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/settings?source=${source}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load settings');
      const d = await res.json();
      setPhone(d.alert_phone_number || '');
      setSelected(Array.isArray(d.meta_campaign_ids) ? d.meta_campaign_ids : []);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [token, source]);

  const loadCampaigns = useCallback(async () => {
    setCampLoading(true);
    try {
      const res = await fetch('/api/admin/meta-campaigns', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load campaigns');
      const d = await res.json();
      setCampReady(!!d.configured);
      setCampaigns(Array.isArray(d.campaigns) ? d.campaigns : []);
    } catch (_) {
      setCampReady(false);
      setCampaigns([]);
    } finally {
      setCampLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  async function saveCampaigns() {
    setCampSaving(true);
    setCampSavedMsg('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, meta_campaign_ids: selectedCampaigns }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setSelected(Array.isArray(d.meta_campaign_ids) ? d.meta_campaign_ids : []);
      setCampSavedMsg(`✓ Saved — ${selectedCampaigns.length} campaign${selectedCampaigns.length === 1 ? '' : 's'} selected.`);
      setTimeout(() => setCampSavedMsg(''), 3000);
    } catch (e) {
      setCampSavedMsg('⚠ ' + (e.message || 'Save failed'));
    } finally {
      setCampSaving(false);
    }
  }

  function toggleCampaign(id) {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function selectAllVisible(visibleIds) {
    setSelected(prev => Array.from(new Set([...prev, ...visibleIds])));
  }
  function clearAll() {
    setSelected([]);
  }

  async function save() {
    setSaving(true);
    setSavedMsg('');
    setError('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, alert_phone_number: phone }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setPhone(d.alert_phone_number || '');
      setSavedMsg('✓ Saved.');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function testNow() {
    if (!phone) {
      setTestMsg('⚠ Save a phone number first.');
      return;
    }
    setTesting(true);
    setTestMsg('');
    try {
      // Bypasses scheduler gating — fires a real WATI template right now to
      // verify the integration. Returns the actual WATI response so we can
      // see whether the call succeeded or what error came back.
      const res = await fetch('/api/admin/settings/send-test-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, template_name: 'leads_alert' }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Test failed (${res.status})`);

      if (d.ok) {
        setTestMsg(`✓ WATI accepted "${d.template}" → +91 ${d.phone}. Check your WhatsApp.`);
      } else {
        // Build a useful error string from the WATI response so user sees the cause
        const body = d.body || {};
        const watiMsg = body?.info || body?.message || body?.error || body?.raw || JSON.stringify(body).slice(0, 200);
        setTestMsg(`⚠ WATI rejected the request (HTTP ${d.status || '?'}): ${watiMsg}`);
        console.error('[WATI test response]', d);
      }
    } catch (e) {
      setTestMsg('⚠ ' + (e.message || 'Test failed'));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{
        background: '#fff', borderRadius: 10,
        border: '1px solid rgba(209,196,240,0.50)',
        padding: 24,
        boxShadow: '0 4px 16px rgba(91,33,182,0.05)',
        maxWidth: 560,
      }}>
        <h3 style={{ margin: '0 0 18px', fontWeight: 700, fontSize: '1.05rem', color: '#3B0764' }}>
          Leads Alert — WhatsApp Recipient
        </h3>

        <label style={{ display: 'block', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.80rem', color: '#3B0764', marginBottom: 6 }}>
          Phone Number <span style={{ color: 'rgba(91,33,182,0.55)', fontWeight: 500 }}>(10-digit, no spaces)</span>
        </label>
        <input
          type="text"
          value={phone}
          onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 15))}
          placeholder="e.g. 9876543210"
          maxLength={15}
          style={{
            width: '100%', height: '2.6rem', padding: '0 12px',
            borderRadius: 6,
            border: '1px solid rgba(209,196,240,0.8)',
            background: 'rgba(237,234,248,0.30)',
            fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem',
            color: '#3B0764', outline: 'none', boxSizing: 'border-box',
            letterSpacing: '0.02em',
          }}
        />

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            style={{
              padding: '0 18px', height: '2.4rem', borderRadius: 6, border: 'none',
              background: saving ? 'rgba(91,33,182,0.45)' : '#5B21B6',
              color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
              cursor: saving ? 'wait' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={testNow}
            disabled={testing || !phone}
            title="Run the alert scheduler once for this source — sends a real WATI message if conditions are met"
            style={{
              padding: '0 14px', height: '2.4rem', borderRadius: 6,
              border: '1px solid rgba(91,33,182,0.30)',
              background: 'rgba(237,234,248,0.50)',
              color: '#5B21B6', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.82rem',
              cursor: testing ? 'wait' : (!phone ? 'not-allowed' : 'pointer'),
              opacity: !phone ? 0.6 : 1,
            }}
          >
            {testing ? 'Testing…' : 'Test alert now'}
          </button>
          {savedMsg && <span style={{ fontSize: '0.80rem', color: '#047857', fontFamily: 'Outfit, sans-serif' }}>{savedMsg}</span>}
        </div>

        {testMsg && (
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 6,
            background: testMsg.startsWith('⚠') ? 'rgba(254,242,242,0.95)' : 'rgba(237,234,248,0.50)',
            border: '1px solid ' + (testMsg.startsWith('⚠') ? 'rgba(248,113,113,0.4)' : 'rgba(209,196,240,0.7)'),
            fontSize: '0.82rem', color: testMsg.startsWith('⚠') ? '#DC2626' : '#3B0764',
            fontFamily: 'Outfit, sans-serif',
          }}>
            {testMsg}
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 6, background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', fontSize: '0.82rem', color: '#DC2626' }}>
            ⚠ {error}
          </div>
        )}
      </div>

      {/* ── Meta campaign filter card ── */}
      <MetaCampaignCard
        configured={campaignsConfigured}
        loading={campaignsLoading}
        campaigns={campaigns}
        selected={selectedCampaigns}
        onToggle={toggleCampaign}
        onSelectAllVisible={selectAllVisible}
        onClearAll={clearAll}
        onSave={saveCampaigns}
        saving={campSaving}
        savedMsg={campSavedMsg}
        open={campOpen}
        setOpen={setCampOpen}
        query={campQuery}
        setQuery={setCampQuery}
      />

    </div>
  );
}

function MetaCampaignCard({
  configured, loading, campaigns, selected,
  onToggle, onSelectAllVisible, onClearAll, onSave,
  saving, savedMsg, open, setOpen, query, setQuery,
}) {
  // Filter by search query (matches name or id, case-insensitive).
  const q = query.trim().toLowerCase();
  const filtered = q
    ? campaigns.filter(c => (c.name || '').toLowerCase().includes(q) || (c.id || '').includes(q))
    : campaigns;
  const visibleIds = filtered.map(c => c.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.includes(id));

  // Group by account_id for visual separation.
  const grouped = filtered.reduce((acc, c) => {
    (acc[c.account_id] = acc[c.account_id] || []).push(c);
    return acc;
  }, {});

  return (
    <div style={{
      background: '#fff', borderRadius: 10,
      border: '1px solid rgba(209,196,240,0.50)',
      padding: 24,
      boxShadow: '0 4px 16px rgba(91,33,182,0.05)',
      maxWidth: 720,
    }}>
      <h3 style={{ margin: '0 0 6px', fontWeight: 700, fontSize: '1.05rem', color: '#3B0764' }}>
        Meta Ad Campaign Filter
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: '0.80rem', color: 'rgba(91,33,182,0.65)' }}>
        Choose which campaigns count towards <b>Meta Page Views</b> on the Page Performance tab.
        Leave empty to include every campaign across all three ad accounts.
      </p>

      {!configured ? (
        <div style={{ padding: '14px 16px', borderRadius: 6, background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.30)', fontSize: '0.82rem', color: '#B91C1C' }}>
          Meta integration is not configured — set <code>META_ACCESS_TOKEN</code> and <code>META_AD_ACCOUNTS</code> in <code>backend/.env</code>.
        </div>
      ) : loading ? (
        <div style={{ fontSize: '0.84rem', color: 'rgba(91,33,182,0.55)' }}>Loading campaigns…</div>
      ) : (
        <>
          {/* Dropdown trigger */}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              width: '100%', height: '2.6rem', padding: '0 12px',
              borderRadius: 6, border: '1px solid rgba(209,196,240,0.8)',
              background: 'rgba(237,234,248,0.30)',
              fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem',
              color: '#3B0764', cursor: 'pointer', textAlign: 'left',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <span>
              {selected.length === 0
                ? 'All campaigns (no filter)'
                : `${selected.length} campaign${selected.length === 1 ? '' : 's'} selected`}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 200ms' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {open && (
            <div style={{
              marginTop: 8, borderRadius: 8,
              border: '1px solid rgba(209,196,240,0.8)',
              background: '#fff',
              boxShadow: '0 4px 16px rgba(91,33,182,0.08)',
              maxHeight: 360, display: 'flex', flexDirection: 'column',
            }}>
              {/* Search + bulk controls */}
              <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(209,196,240,0.40)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search campaigns by name or id…"
                  style={{
                    flex: 1, minWidth: 200, height: '2rem', padding: '0 10px',
                    borderRadius: 6, border: '1px solid rgba(209,196,240,0.7)',
                    fontSize: '0.82rem', color: '#3B0764', outline: 'none',
                    background: 'rgba(237,234,248,0.30)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => allVisibleSelected ? null : onSelectAllVisible(visibleIds)}
                  disabled={visibleIds.length === 0 || allVisibleSelected}
                  style={{
                    padding: '0 10px', height: '2rem', borderRadius: 6,
                    border: '1px solid rgba(91,33,182,0.30)',
                    background: 'rgba(237,234,248,0.50)', color: '#5B21B6',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem',
                    cursor: visibleIds.length === 0 || allVisibleSelected ? 'not-allowed' : 'pointer',
                    opacity: visibleIds.length === 0 || allVisibleSelected ? 0.5 : 1,
                  }}
                >
                  Select shown
                </button>
                <button
                  type="button"
                  onClick={onClearAll}
                  disabled={selected.length === 0}
                  style={{
                    padding: '0 10px', height: '2rem', borderRadius: 6,
                    border: '1px solid rgba(239,68,68,0.30)',
                    background: 'rgba(254,242,242,0.70)', color: '#B91C1C',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem',
                    cursor: selected.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: selected.length === 0 ? 0.5 : 1,
                  }}
                >
                  Clear
                </button>
              </div>

              {/* List */}
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 16, textAlign: 'center', color: 'rgba(91,33,182,0.55)', fontSize: '0.82rem' }}>
                    {campaigns.length === 0 ? 'No campaigns found in any account.' : 'No campaigns match your search.'}
                  </div>
                ) : (
                  Object.entries(grouped).map(([accountId, list]) => (
                    <div key={accountId}>
                      <div style={{
                        padding: '6px 12px', background: 'rgba(237,234,248,0.50)',
                        fontSize: '0.70rem', fontWeight: 700, color: 'rgba(91,33,182,0.65)',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        position: 'sticky', top: 0,
                      }}>
                        Ad Account {accountId} · {list.length} campaign{list.length === 1 ? '' : 's'}
                      </div>
                      {list.map(c => {
                        const checked = selected.includes(c.id);
                        return (
                          <label key={c.id} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 12px', cursor: 'pointer',
                            background: checked ? 'rgba(91,33,182,0.04)' : 'transparent',
                            borderBottom: '1px solid rgba(209,196,240,0.25)',
                          }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => onToggle(c.id)}
                              style={{ width: 16, height: 16, accentColor: '#5B21B6', cursor: 'pointer' }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#3B0764', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {c.name}
                              </div>
                              <div style={{ fontSize: '0.68rem', color: 'rgba(91,33,182,0.55)' }}>
                                {c.id} · {c.status || 'UNKNOWN'}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              style={{
                padding: '0 18px', height: '2.4rem', borderRadius: 6, border: 'none',
                background: saving ? 'rgba(91,33,182,0.45)' : '#5B21B6',
                color: '#fff', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedMsg && (
              <span style={{ fontSize: '0.80rem', color: savedMsg.startsWith('⚠') ? '#DC2626' : '#047857', fontFamily: 'Outfit, sans-serif' }}>
                {savedMsg}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
