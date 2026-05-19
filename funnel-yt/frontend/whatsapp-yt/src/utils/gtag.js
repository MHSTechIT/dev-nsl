/* Google Ads (gtag.js) helpers — whatsapp-yt standalone app.
 * ===================================================================
 * Mirrors `funnel-yt/frontend/funnel-yt/src/utils/gtag.js`. Bootstrap
 * (`<script>` tag for the gtag library) lives in `index.html`. This
 * helper centralises the Lead conversion fire so the standalone
 * WhatsApp page doesn't drift from the main funnel's tracking setup.
 *
 * Lead fires on page load with `transaction_id` = lead_id from URL
 * (?lead_id=…). Google Ads de-duplicates conversions sharing the same
 * transaction_id, so this fire + the one from Screen3 inside the main
 * funnel collapse into a single counted conversion.
 * ===================================================================*/

const ADS_ACCOUNT  = 'AW-17164057977';
const LEAD_SEND_TO = `${ADS_ACCOUNT}/aYa6COGX_6kcEPn6uvg_`;

function safeGtag(...args) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag(...args);
    }
  } catch (_) { /* ignore — analytics must never break the flow */ }
}

/* Lead — fires once when the WhatsApp page mounts. Pass the lead_id
   from the URL as `transaction_id` so Google Ads de-duplicates this
   fire with the Screen3 fire inside the main funnel. */
export function gtagLead({ transactionId, value, currency = 'INR' } = {}) {
  safeGtag('event', 'conversion', {
    send_to: LEAD_SEND_TO,
    ...(transactionId && { transaction_id: transactionId }),
    ...(value != null && { value, currency }),
  });
}
