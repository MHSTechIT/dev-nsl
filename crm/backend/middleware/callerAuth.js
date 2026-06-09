/**
 * JWT auth for CRM callers.
 * Reads Authorization: Bearer <jwt> OR ?token=<jwt> (for EventSource SSE,
 * which can't set headers). Verifies with utils/jwt and attaches req.caller.
 */
const { verify } = require('../utils/jwt');

function callerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token  = bearer || (typeof req.query?.token === 'string' ? req.query.token : '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const payload = verify(token);
    if (!payload?.user_id) return res.status(401).json({ error: 'unauthorized' });
    // workspace scopes every caller query to the right tables (Meta vs nsm_*).
    // Absent on legacy Meta tokens → defaults to 'meta' (behavior unchanged).
    req.caller = {
      id: payload.user_id,
      role: payload.role,
      full_name: payload.full_name,
      workspace: payload.workspace || 'meta',
      // Admin "preview as caller" tokens carry preview:true. The caller router
      // uses this to allow read-only GETs while blocking every write/telephony
      // call, so an admin previewing a caller's pages can never mutate that
      // caller's session or place a real call. See routes/caller.js gate.
      preview: payload.preview === true,
    };
    next();
  } catch (_) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

module.exports = { callerAuth };
