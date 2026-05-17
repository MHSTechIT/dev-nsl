/**
 * JWT helper for CRM caller auth.
 * Secret comes from JWT_SECRET env var; if absent, generates one and persists
 * it to backend/data/admin.json so dev installs work out of the box.
 */
const jwt  = require('jsonwebtoken');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readConfig, writeConfig } = require('./adminConfig');

const ALG     = 'HS256';
const EXPIRES = '24h';

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const cfg = readConfig();
  if (cfg.jwt_secret) return cfg.jwt_secret;
  const secret = crypto.randomBytes(48).toString('hex');
  try { writeConfig({ jwt_secret: secret }); } catch (_) { /* read-only fs — fall back to env or in-memory */ }
  return secret;
}

function sign(payload) {
  return jwt.sign(payload, getSecret(), { algorithm: ALG, expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, getSecret(), { algorithms: [ALG] });
}

module.exports = { sign, verify };
