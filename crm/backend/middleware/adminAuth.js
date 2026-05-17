const crypto        = require('crypto');
const { getPassword } = require('../utils/adminConfig');

function adminAuth(req, res, next) {
  const header   = req.headers.authorization || '';
  const token    = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = getPassword();

  if (!token || !expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  /* Constant-time comparison to prevent timing attacks */
  const tokBuf = Buffer.alloc(Math.max(token.length, expected.length));
  const expBuf = Buffer.alloc(Math.max(token.length, expected.length));
  Buffer.from(token).copy(tokBuf);
  Buffer.from(expected).copy(expBuf);

  if (!crypto.timingSafeEqual(tokBuf, expBuf) || token.length !== expected.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

module.exports = { adminAuth };
