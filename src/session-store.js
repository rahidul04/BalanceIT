const session = require('express-session');

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.readStatement = db.prepare('SELECT sess,expired FROM sessions WHERE sid=?');
    this.upsertStatement = db.prepare(`INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?)
      ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired=excluded.expired`);
    this.deleteStatement = db.prepare('DELETE FROM sessions WHERE sid=?');
    this.touchStatement = db.prepare('UPDATE sessions SET expired=? WHERE sid=?');
  }
  get(sid, callback) {
    try {
      const row = this.readStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) { this.deleteStatement.run(sid); return callback(null, null); }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.upsertStatement.run(sid, JSON.stringify(sess), expires);
      this.db.prepare('DELETE FROM sessions WHERE expired<=?').run(Date.now());
      callback(null);
    } catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.touchStatement.run(expires, sid);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.deleteStatement.run(sid); callback(null); }
    catch (error) { callback(error); }
  }
}

module.exports = { SQLiteSessionStore };
