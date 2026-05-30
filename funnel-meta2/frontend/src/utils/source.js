// Meta 2.0 build: every API call is hardcoded as source='meta2'.
// (The original Meta build at apps/funnel uses the backend default;
//  the YT build at apps/funnel-yt hardcodes 'yt'.)
export function detectSource() {
  return 'meta2';
}
