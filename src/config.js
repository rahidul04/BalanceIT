const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const nodeEnv = process.env.NODE_ENV || 'development';
const databaseUrl = process.env.DATABASE_URL || '';
const legacyDatabasePath = path.resolve('./data/roomledger.sqlite');
const newDatabasePath = path.resolve('./data/balanceit.sqlite');
// Reuse the existing ledger after a branding-only rename when DATABASE_PATH is unset.
const databasePath = process.env.DATABASE_PATH === ':memory:' ? ':memory:'
  : process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH)
    : path.resolve(fs.existsSync(legacyDatabasePath) ? legacyDatabasePath : newDatabasePath);

const members = Array.from({ length: 5 }, (_, index) => {
  const n = index + 1;
  return {
    username: process.env[`MEMBER_${n}_USERNAME`] || `member${n}`,
    password: process.env[`MEMBER_${n}_PASSWORD`] || '',
    displayName: process.env[`MEMBER_${n}_NAME`] || ['Rahidul', 'Bapan', 'Manojit', 'Hara', 'Wahid'][index]
  };
});

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv,
  sessionSecret: process.env.SESSION_SECRET || (nodeEnv === 'production' ? '' : crypto.randomBytes(32).toString('hex')),
  databaseUrl,
  databasePath,
  members
};
