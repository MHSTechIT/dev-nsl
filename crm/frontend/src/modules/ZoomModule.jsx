/* ──────────────────────────────────────────────────────────────────────────
   ZoomModule — CRM sidebar page sitting next to "Web Reminder".

   Functionality is intentionally TBD — this renders a branded placeholder so
   the nav entry resolves to a real surface. When the feature is specced,
   build it out right here. It already receives:
     • token   — Bearer token for authed calls to the CRM backend (:3003)
     • source  — active workspace ('meta' | 'yt' | 'meta2')

   The page title ("Zoom") + subtitle are rendered by CrmShell's top bar, so
   this component only owns the body below it.
   ────────────────────────────────────────────────────────────────────────── */
export default function ZoomModule({ token, source = 'meta' }) {
  return (
    <div
      className="bg-white rounded-card shadow-card p-6"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: 320, textAlign: 'center', gap: 10,
      }}
    >
      <div
        style={{
          width: 56, height: 56, borderRadius: 16,
          background: 'rgba(91,33,182,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 4,
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      </div>
      <h2 style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#3B0764', margin: 0 }}>
        Zoom
      </h2>
      <p style={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem', color: 'rgba(91,33,182,0.55)', margin: 0, maxWidth: 380 }}>
        This page is ready and wired into the CRM. Tell me the fields, actions,
        and Zoom integration you want, and I'll build it out here.
      </p>
    </div>
  );
}
