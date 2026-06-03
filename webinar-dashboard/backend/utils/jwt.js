const jwt = require('jsonwebtoken');

// Standalone token signing for the Webinar Dashboard. Independent of the CRM —
// it validates CRM staff credentials at login but issues its OWN tokens, signed
// with this app's JWT_SECRET (set in backend/.env).
const ALG = 'HS256';
const EXPIRES = '12h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set in webinar-dashboard/backend/.env');
  return s;
}

function sign(payload) {
  return jwt.sign(payload, getSecret(), { algorithm: ALG, expiresIn: EXPIRES });
}
function verify(token) {
  return jwt.verify(token, getSecret(), { algorithms: [ALG] });
}

module.exports = { sign, verify };
