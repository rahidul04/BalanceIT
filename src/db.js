const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SQLITE_MIGRATIONS = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_confirmed_settlement_amount.sql' },
  { version: 3, file: '003_data_reset_approval.sql' }
];
const POSTGRES_MIGRATIONS = [
  { version: 1, file: 'postgres/001_initial.sql' },
  { version: 2, file: 'postgres/002_confirmed_settlement_amount.sql' },
  { version: 3, file: 'postgres/003_data_reset_approval.sql' }
];

class SQLiteDatabase {
  constructor(filename) {
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));");
    for (const migration of SQLITE_MIGRATIONS) {
      if (this.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) continue;
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', migration.file), 'utf8');
      this.transaction(() => {
        this.exec(sql);
        this.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(migration.version);
      })();
    }
  }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) { return this.raw.prepare(sql); }
  pragma(statement) { return this.raw.exec(`PRAGMA ${statement}`); }
  transaction(callback) {
    return (...args) => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(...args);
        if (result && typeof result.then === 'function') {
          return result.then(value => { this.raw.exec('COMMIT'); return value; }, error => {
            try { this.raw.exec('ROLLBACK'); } catch {}
            throw error;
          });
        }
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

function toPostgresSql(sql) {
  let query = String(sql)
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/username\s*=\s*\?\s+COLLATE\s+NOCASE/gi, 'LOWER(username)=LOWER(?)')
    .replace(/SUM\(\s*vote\s*=\s*'approved'\s*\)/gi, "SUM(CASE WHEN vote='approved' THEN 1 ELSE 0 END)")
    .replace(/SUM\(\s*vote\s*=\s*'rejected'\s*\)/gi, "SUM(CASE WHEN vote='rejected' THEN 1 ELSE 0 END)");
  let index = 0;
  query = query.replace(/\?/g, () => `$${++index}`);
  return query;
}

class PostgresDatabase {
  constructor(connectionString) {
    const { Pool, types } = require('pg');
    // All monetary columns and IDs are safe integers in this app. Convert PostgreSQL
    // int8/numeric results to JS numbers so they match the local SQLite behavior.
    types.setTypeParser(types.builtins.INT8, value => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds JavaScript safe integer range.');
      return number;
    });
    types.setTypeParser(types.builtins.NUMERIC, value => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('Database numeric exceeds JavaScript safe integer range.');
      return number;
    });
    const secureConnectionString = new URL(connectionString);
    if (!secureConnectionString.searchParams.has('sslmode')) secureConnectionString.searchParams.set('sslmode', 'require');
    this.pool = new Pool({
      connectionString: secureConnectionString.toString(),
      max: Number(process.env.DB_POOL_SIZE || 5),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
    const { AsyncLocalStorage } = require('node:async_hooks');
    this.transactionContext = new AsyncLocalStorage();
    this.isPostgres = true;
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::TEXT)
    )`);
    for (const migration of POSTGRES_MIGRATIONS) {
      const applied = await this.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version);
      if (applied) continue;
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', migration.file), 'utf8');
      await this.transaction(async () => {
        await this.exec(sql);
        await this.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(migration.version);
      })();
    }
  }

  async query(sql, params = []) {
    const client = this.transactionContext.getStore();
    return (client || this.pool).query(toPostgresSql(sql), params);
  }

  exec(sql) { return this.query(sql); }

  prepare(sql) {
    return {
      get: async (...params) => (await this.query(sql, params)).rows[0],
      all: async (...params) => (await this.query(sql, params)).rows,
      run: async (...params) => {
        const statement = String(sql).trim();
        const insert = /^INSERT\b/i.test(statement);
        const result = await this.query(insert && !/\bRETURNING\b/i.test(statement) ? `${statement} RETURNING *` : statement, params);
        return { changes: result.rowCount, lastInsertRowid: result.rows?.[0]?.id };
      }
    };
  }

  transaction(callback) {
    return async (...args) => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const value = await this.transactionContext.run(client, () => callback(...args));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close() { await this.pool.end(); }
}

function openDatabase(database = ':memory:') {
  if (typeof database === 'object' && database.databaseUrl) return new PostgresDatabase(database.databaseUrl);
  const filename = typeof database === 'object' ? database.databasePath : database;
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  return new SQLiteDatabase(filename);
}

module.exports = { openDatabase, SQLiteDatabase, PostgresDatabase, toPostgresSql };
