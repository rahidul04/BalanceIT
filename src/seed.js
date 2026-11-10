require('dotenv').config();
const bcrypt = require('bcryptjs');
const config = require('./config');
const { openDatabase } = require('./db');

async function seedUsers(db, members = config.members) {
  if (members.length !== 5) throw new Error('Configure exactly five members.');
  const usernames = members.map(member => member.username.toLowerCase());
  if (new Set(usernames).size !== 5 || usernames.some(name => !/^[a-z0-9_.-]{3,32}$/.test(name))) {
    throw new Error('Member usernames must be unique and 3–32 letters, numbers, dots, underscores or hyphens.');
  }
  const count = (await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count;
  if (count > 0) {
    const stored = (await db.prepare('SELECT username FROM users ORDER BY id').all()).map(row => row.username.toLowerCase());
    if (stored.length !== 5 || stored.some(name => !usernames.includes(name))) {
      throw new Error('Database already contains a different member set. This app supports exactly five configured users.');
    }
    // Display-name changes are safe to sync at startup; keep credentials and ledger history untouched.
    const syncNames = db.transaction(async () => {
      for (const member of members) {
        const user = await db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(member.username);
        await db.prepare('UPDATE users SET display_name=? WHERE id=?').run(member.displayName, user.id);
      }
    });
    await syncNames();
    return;
  }
  for (const member of members) {
    if (!member.password || member.password.length < 10) throw new Error(`Set a password of at least 10 characters for ${member.username} in .env.`);
  }
  const hashed = await Promise.all(members.map(member => bcrypt.hash(member.password, 12)));
  const tx = db.transaction(async () => {
    for (const [index, member] of members.entries()) {
      await db.prepare('INSERT INTO users(username,password_hash,display_name) VALUES(?,?,?)').run(member.username, hashed[index], member.displayName);
    }
  });
  await tx();
  console.log('Seeded the five configured BalanceIT accounts.');
}

async function resetUsers(db, members = config.members) {
  if (members.length !== 5) throw new Error('Configure exactly five members.');
  const usernames = members.map(member => member.username.toLowerCase());
  if (new Set(usernames).size !== 5 || usernames.some(name => !/^[a-z0-9_.-]{3,32}$/.test(name))) {
    throw new Error('Member usernames must be unique and 3–32 letters, numbers, dots, underscores or hyphens.');
  }
  for (const member of members) {
    if (!member.password || member.password.length < 10) throw new Error(`Set a password of at least 10 characters for ${member.username} in .env.`);
  }
  const current = await db.prepare('SELECT id FROM users ORDER BY id').all();
  if (current.length !== 5) throw new Error('Credential reset requires an initialized database containing exactly five accounts.');
  const hashed = await Promise.all(members.map(member => bcrypt.hash(member.password, 12)));
  const tx = db.transaction(async () => {
    // Temporary names make username swaps safe while this transaction is invisible to other requests.
    for (const [index, user] of current.entries()) await db.prepare('UPDATE users SET username=?,password_hash=?,display_name=? WHERE id=?').run(`__balanceit reset ${user.id}`, hashed[index], members[index].displayName, user.id);
    for (const [index, user] of current.entries()) await db.prepare('UPDATE users SET username=?,password_hash=?,display_name=? WHERE id=?').run(members[index].username, hashed[index], members[index].displayName, user.id);
  });
  await tx();
  console.log('Updated usernames, password hashes, and display names for the five configured accounts.');
}

async function main() {
  const db = openDatabase(config);
  try {
    await db.initialize?.();
    if (process.argv.includes('--reset-credentials')) await resetUsers(db);
    else await seedUsers(db);
  }
  finally { db.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { seedUsers, resetUsers };
