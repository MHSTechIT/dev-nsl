/* Google Ads (gtag.js) helpers — YT funnel only.
 * ===================================================================
 * The bootstrap (`<script async src="…/gtag/js?id=AW-17164057977">`)
 * lives in `index.html`'s <head> so `window.gtag` is globally defined
 * by the time any React component mounts. This file just centralises
 * the two `gtag('event', 'conversion', …)` calls we fire from the app
 * so the conversion IDs aren't duplicated across screens and so they
 * mirror the fire-and-forget shape of `utils/trackEvent.js` — analytics
 * failures never propagate into the funnel flow.
 *
 * Conversions tracked:
 *   • LPV  (4yTLCLyo_6kcEPn6uvg_)  — Screen1A mount.
 *                                   Counts as "link click" in Google Ads.
 *   • Lead (aYa6COGX_6kcEPn6uvg_)  — Screen3 form-submit success.
 *                                   Counts as confirmed lead.
 * ===================================================================*/

const ADS_ACCOUNT = 'AW-17164057977';
const LPV_SEND_TO  = `${ADS_ACCOUNT}/4yTLCLyo_6kcEPn6uvg_`;
const LEAD_SEND_TO = `${ADS_ACCOUNT}/aYa6COGX_6kcEPn6uvg_`;

/* Safe wrapper. If gtag.js failed to load (ad-blocker, network error,
   strict CSP) `window.gtag` is undefined — we silently no-op. Any
   exception from inside Google's loader is also swallowed so a
   third-party crash can never break the funnel. */
function safeGtag(...args) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag(...args);
    }
  } catch (_) { /* ignore — analytics must never break the flow */ }
}

/* Landing-page view. Fires once on Screen1A mount via a module-level
   guard in the screen file (so it doesn't double-fire if the user
   bounces back to '/' mid-session). Google Ads counts this as the
   user's "click landed on our site" signal. */
export function gtagPageView() {
  safeGtag('event', 'conversion', { send_to: LPV_SEND_TO });
}

/* Lead. Fires right after POST /api/leads returns success in Screen3.
   We pass the lead_score as `value` so Google Ads can weight
   conversions if value-based bidding is turned on later. INR is the
   currency for all our ads — change if you switch markets.
   `transactionId` is the DB lead_id — passing it lets Google Ads
   de-duplicate this fire with the WhatsApp-page fire (same lead_id ⇒
   counted only once even though both pages fire the conversion). */
export function gtagLead({ transactionId, value, currency = 'INR' } = {}) {
  safeGtag('event', 'conversion', {
    send_to: LEAD_SEND_TO,
    ...(transactionId && { transaction_id: transactionId }),
    ...(value != null && { value, currency }),
  });
}
