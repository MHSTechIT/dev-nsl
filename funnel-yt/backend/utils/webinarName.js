const pool = require('../db');

const PREFIX_BY_SOURCE = { meta: 'AWS-', yt: 'YT-' };
const START = 101;

function prefixFor(source) {
  return PREFIX_BY_SOURCE[source] || 'AWS-';
}

// Per-source name space so Meta and YT can't ever produce duplicate names
// (e.g. both starting at AWS-101). Meta keeps 'AWS-N', YT uses 'YT-N'.
async function nextWebinarName(source = 'meta') {
  const prefix = prefixFor(source);
  const numRegex   = `${prefix}(\\d+)`;        // capture group for SUBSTRING
  const matchRegex = `^${prefix}\\d+$`;        // ~ regex match

  const { rows } = await pool.query(
    `SELECT COALESCE(
       MAX((substring(name FROM $3))::int),
       $1 - 1
     ) AS max_num
     FROM webinars
     WHERE name ~ $4 AND source = $2`,
    [START, source, numRegex, matchRegex]
  );
  const next = (rows[0]?.max_num ?? START - 1) + 1;
  return `${prefix}${next}`;
}

// "Next Webinar" = (current active webinar number for this source) + 1.
async function nextUpcomingWebinarName(source = 'meta') {
  const prefix = prefixFor(source);
  const numRegex   = `${prefix}(\\d+)`;
  const matchRegex = `^${prefix}\\d+$`;

  const { rows } = await pool.query(
    `SELECT (substring(name FROM $1))::int AS num
       FROM webinars
      WHERE is_active = TRUE AND name ~ $2 AND source = $3
      ORDER BY num DESC LIMIT 1`,
    [numRegex, matchRegex, source]
  );
  const activeNum = rows[0]?.num;
  if (typeof activeNum === 'number') return `${prefix}${activeNum + 1}`;
  return nextWebinarName(source);
}

module.exports = { nextWebinarName, nextUpcomingWebinarName };
