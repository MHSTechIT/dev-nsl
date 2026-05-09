const pool = require('../db');

const PREFIX = 'AWS-';
const START = 101;

async function nextWebinarName() {
  const { rows } = await pool.query(
    `SELECT COALESCE(
       MAX((substring(name FROM 'AWS-(\\d+)'))::int),
       $1 - 1
     ) AS max_num
     FROM webinars
     WHERE name ~ '^AWS-\\d+$'`,
    [START]
  );
  const next = (rows[0]?.max_num ?? START - 1) + 1;
  return `${PREFIX}${next}`;
}

module.exports = { nextWebinarName };
