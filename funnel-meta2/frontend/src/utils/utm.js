export function parseUTMParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    utm_source: p.get('utm_source'),
    utm_campaign: p.get('utm_campaign'),
    utm_content: p.get('utm_content'),
    fbclid: p.get('fbclid'),
  };
}
