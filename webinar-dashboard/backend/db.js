const { Pool } = require('pg');

// Shares the project's Postgres but only ever touches NEW, isolated wd_* tables
// (created by the migration in app.js). Small pool to be gentle on the shared
// connection cap the other services also use.
const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                     parseInt(process.env.DB_POOL_MAX, 10) || 5,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[wd db] pool error:', err.message));

module.exports = pool;
