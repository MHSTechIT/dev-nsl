const { Pool } = require('pg');

const pool = new Pool({
  connectionString:    process.env.DATABASE_URL,
  ssl:                 process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                 parseInt(process.env.DB_POOL_MAX, 10)      || 50,
  // Keep connections WARM. The DB is on a remote (sometimes IP-changing) box, so
  // a cold reconnect costs ~370ms+ on the first query of every screen. Holding
  // idle connections open for 5 min — plus TCP keep-alive so the OS notices a
  // dead socket fast instead of the query hanging — removes most of that tax.
  idleTimeoutMillis:   parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 300000,  // 5 min (was 30s)
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 8000,
  keepAlive:           true,
  keepAliveInitialDelayMillis: 10000,
  // Fail a stuck query after 45s instead of letting a screen hang "forever" on a
  // flaky DB link — the UI gets a clean error and can retry. Generous enough for
  // every real query here (~0.1s) and the boot migrations.
  statement_timeout:   parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10) || 45000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = pool;
