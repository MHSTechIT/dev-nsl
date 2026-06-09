/* WhapiView — "Whapi" tab in the Marketing module (Meta Temp). Scaffold for
   now; the whapi dashboard (channel status, groups, QR reconnect, etc.) will
   be built once the functionalities are defined. */

export default function WhapiView() {
  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      <div style={{ marginBottom: 18 }}>
        <h3 className="font-sans text-xl font-bold text-purple-900">Whapi</h3>
        <p className="font-sans text-sm text-purple-400 mt-1">
          WhatsApp channel dashboard.
        </p>
      </div>

      <div
        style={{
          border: '1px dashed rgba(139,92,246,0.35)', borderRadius: 14,
          padding: '40px 24px', textAlign: 'center', background: 'rgba(237,234,248,0.30)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(91,33,182,0.45)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
        </div>
        <p style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#3B0764', margin: 0 }}>
          Whapi dashboard
        </p>
        <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.84rem', color: 'rgba(91,33,182,0.55)', margin: '6px 0 0' }}>
          Tell me the functionalities and I'll build them (channel status, groups, QR reconnect, etc.).
        </p>
      </div>
    </div>
  );
}
