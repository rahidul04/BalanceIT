const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class BalanceITDatabase {
  constructor(filename) {
    this.raw = new DatabaseSync(filename);
  }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) { return this.raw.prepare(sql); }
  pragma(statement) { return this.raw.exec(`PRAGMA ${statement}`); }
  transaction(callback) {
    return (...args) => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.raw.exec('ROLLBACK'); } catch {}
        throw error;
      }
    };
  }
  close() { return this.raw.close(); }
}

function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new BalanceITDatabase(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  const migration = path.join(__dirname, '..', 'migrations', '001_initial.sql');
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get();
  if (!applied) {
    const sql = fs.readFileSync(migration, 'utf8');
    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version) VALUES(1)').run();
    });
    migrate();
  }
  return db;
}

module.exports = { openDatabase, BalanceITDatabase };
