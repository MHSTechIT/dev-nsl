const jwtUtil = require('../utils/jwt');

/* Gate protected routes — requires a valid Bearer token issued by /api/auth/login.
   Attaches the decoded payload to req.user. */
module.exports = function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwtUtil.verify(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session.' });
  }
};
