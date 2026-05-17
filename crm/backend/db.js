const { Pool } = require('pg');

const pool = new Pool({
  connectionString:    process.env.DATABASE_URL,
  ssl:                 process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                 parseInt(process.env.DB_POOL_MAX, 10)      || 50,
  idleTimeoutMillis:   parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10) || 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = pool;
