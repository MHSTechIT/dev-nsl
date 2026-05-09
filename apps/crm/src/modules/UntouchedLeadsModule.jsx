/* Untouched Leads — leads that have been assigned but not yet contacted.
   Empty placeholder for now; functionality to be defined. */
export default function UntouchedLeadsModule(/* { token } */) {
  return (
    <div className="bg-white rounded-card shadow-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 60, textAlign: 'center', fontFamily: 'Outfit, sans-serif' }}>
        <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'rgba(245,197,24,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#A16207" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div style={{ fontWeight: 700, color: '#3B0764', fontSize: '1rem', marginBottom: 6 }}>No untouched leads</div>
        <div style={{ color: 'rgba(91,33,182,0.55)', fontSize: '0.85rem', maxWidth: 380, margin: '0 auto' }}>
          Leads that haven't been called or messaged yet will appear here. Tell me when a lead should count as "untouched" and I'll wire it up.
        </div>
      </div>
    </div>
  );
}
