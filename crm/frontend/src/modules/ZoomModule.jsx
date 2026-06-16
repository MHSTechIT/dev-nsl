/* ──────────────────────────────────────────────────────────────────────────
   ZoomModule — CRM sidebar page sitting next to "Web Reminder".

   Hosts the "Webinar Sessions" list (moved here from Timer & Controls). Each
   card is one webinar session for the active workspace, tracking its own leads.
   Receives:
     • token   — Bearer token for authed calls to the CRM backend (:3003)
     • source  — active workspace ('meta' | 'yt' | 'meta2' | 'metatemp' | …)

   The page title ("Zoom") + subtitle are rendered by CrmShell's top bar, so
   this component only owns the body below it.
   ────────────────────────────────────────────────────────────────────────── */
import WebinarSessionsPanel from '../admin/WebinarSessionsPanel';

export default function ZoomModule({ token, source = 'meta' }) {
  return <WebinarSessionsPanel token={token} source={source} />;
}
