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
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [token, source]);

  useEffect(() => { load(); }, [load]);

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

    </div>
  );
}
