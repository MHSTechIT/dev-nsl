/**
 * Autonomous admin config — stored in server/data/admin.json.
 * No database required. Falls back to ADMIN_PASSWORD env var if file is absent.
 */
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/admin.json');

const DEFAULTS = {
  password:       null,   // overrides ADMIN_PASSWORD env var when set
  reset_token:    null,
  reset_expires:  null,
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.warn('adminConfig: failed to read config file:', e.message);
  }
  return { ...DEFAULTS };
}

function writeConfig(updates) {
  const current = readConfig();
  const next    = { ...current, ...updates };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('adminConfig: failed to write config file:', e.message);
    throw e;
  }
}

/** Returns the active password: file override → env var */
function getPassword() {
  const cfg = readConfig();
  return cfg.password || process.env.ADMIN_PASSWORD || '';
}

module.exports = { readConfig, writeConfig, getPassword };
