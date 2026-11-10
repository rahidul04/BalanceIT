const session = require('express-session');

class DatabaseSessionStore extends session.Store {
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
    Promise.resolve().then(() => this.readStatement.get(sid)).then(async row => {
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) { await this.deleteStatement.run(sid); return callback(null, null); }
      callback(null, JSON.parse(row.sess));
    }).catch(callback);
  }
  set(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
    Promise.resolve().then(async () => {
      await this.upsertStatement.run(sid, JSON.stringify(sess), expires);
      await this.db.prepare('DELETE FROM sessions WHERE expired<=?').run(Date.now());
    }).then(() => callback(null), callback);
  }
  touch(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
    Promise.resolve(this.touchStatement.run(expires, sid)).then(() => callback(null), callback);
  }
  destroy(sid, callback = () => {}) {
    Promise.resolve(this.deleteStatement.run(sid)).then(() => callback(null), callback);
  }
}

module.exports = { DatabaseSessionStore };
