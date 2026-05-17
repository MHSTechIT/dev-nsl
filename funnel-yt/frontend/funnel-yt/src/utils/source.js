// YT-only build: every API call is hardcoded as source='yt'.
// (The Meta build at apps/funnel uses runtime detection.)
export function detectSource() {
  return 'yt';
}
