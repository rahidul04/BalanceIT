require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { openDatabase } = require('./db');
const { resetUsers } = require('./seed');

const tables = [
  ['users', ['id', 'username', 'password_hash', 'display_name', 'created_at']],
  ['expenses', ['id', 'title', 'amount_paise', 'category', 'expense_date', 'expense_type', 'paid_by', 'status', 'rejection_reason', 'created_at', 'updated_at']],
  ['expense_participants', ['id', 'expense_id', 'user_id', 'share_paise']],
  ['expense_votes', ['id', 'expense_id', 'user_id', 'vote', 'rejection_reason', 'created_at']],
  ['settlements', ['id', 'payer_id', 'receiver_id', 'amount_paise', 'payment_date', 'note', 'status', 'created_at', 'confirmed_at', 'confirmed_amount_paise']],
  ['notifications', ['id', 'user_id', 'title', 'message', 'related_type', 'related_id', 'is_read', 'created_at']],
  ['data_reset_requests', ['id', 'requested_by', 'status', 'created_at', 'completed_at']],
  ['data_reset_votes', ['id', 'request_id', 'user_id', 'vote', 'created_at']],
  ['data_reset_archives', ['id', 'request_id', 'archived_by', 'archived_at', 'expense_count', 'settlement_count', 'archive_json']]
];

async function importSqlite(sourcePath = process.env.SQLITE_IMPORT_PATH || config.databasePath) {
  if (!config.databaseUrl) throw new Error('Set DATABASE_URL to your new Supabase PostgreSQL connection string before importing.');
  const absoluteSource = path.resolve(sourcePath);
  if (!fs.existsSync(absoluteSource)) throw new Error(`SQLite source file was not found: ${absoluteSource}`);
  for (const member of config.members) {
    if (!member.password || member.password.length < 10) throw new Error(`Set a password of at least 10 characters for ${member.username} before importing.`);
  }

  const source = openDatabase(absoluteSource);
  const destination = openDatabase(config);
  try {
    await destination.initialize();
    const sourceUsers = source.prepare('SELECT id,username FROM users ORDER BY id').all();
    if (sourceUsers.length !== 5) throw new Error('The SQLite source must contain exactly five member accounts.');
    if (sourceUsers.some((user, index) => user.id !== index + 1)) throw new Error('The SQLite member IDs must be 1 through 5 to preserve all ledger references safely.');

    const configuredUsers = await destination.prepare('SELECT id,username FROM users ORDER BY id').all();
    const importUsers = configuredUsers.length === 0;
    if (!importUsers && (configuredUsers.length !== 5 || configuredUsers.some((user, index) => user.id !== index + 1 || user.username.toLowerCase() !== sourceUsers[index].username.toLowerCase()))) {
      throw new Error('Supabase already has a different member set. Import into a fresh app database or make the five configured usernames match the SQLite source.');
    }
    for (const [table] of tables.filter(([name]) => name !== 'users')) {
      const existing = await destination.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      if (existing.count !== 0) throw new Error(`Supabase table ${table} already contains records. Import only before adding ledger history to avoid mixing or duplicating records.`);
    }

    const counts = {};
    await destination.transaction(async () => {
      for (const [table, columns] of tables) {
        if (table === 'users' && !importUsers) continue;
        const records = source.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY id`).all();
        counts[table] = records.length;
        if (!records.length) continue;
        const columnSql = columns.join(',');
        const placeholders = columns.map(() => '?').join(',');
        const insert = destination.prepare(`INSERT INTO ${table}(${columnSql}) VALUES(${placeholders})`);
        for (const record of records) {
          await insert.run(...columns.map(column => record[column] ?? null));
        }
      }
    })();

    // Keep configured deployment credentials, while preserving the imported user IDs.
    if (importUsers) await resetUsers(destination, config.members);
    for (const [table] of tables) {
      await destination.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE(MAX(id),1), COUNT(*) > 0) FROM ${table}`);
    }
    return counts;
  } finally {
    source.close();
    await destination.close();
  }
}

if (require.main === module) {
  importSqlite(process.argv[2]).then(counts => {
    console.log('SQLite history imported into Supabase. Member credentials were updated from the configured environment variables.');
    for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count} rows`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { importSqlite };
