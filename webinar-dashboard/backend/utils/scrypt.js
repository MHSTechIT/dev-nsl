const crypto = require('crypto');

/* Verify a scrypt-hashed password (format: scrypt$<salt-hex>$<hash-hex>).
   Matches the CRM's hashing (crm/backend/routes/auth.js) so the same crm_users
   password_hash values verify here. */
function verifyScryptHash(plain, stored) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string') return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    let salt, expected;
    try {
      salt = Buffer.from(parts[1], 'hex');
      expected = Buffer.from(parts[2], 'hex');
    } catch { return resolve(false); }
    crypto.scrypt(plain, salt, expected.length, (err, derived) => {
      if (err) return resolve(false);
      try {
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      } catch { resolve(false); }
    });
  });
}

module.exports = { verifyScryptHash };
