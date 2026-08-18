'use strict';
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const config = require('./config');

const db = new Database(path.join(config.DATA_DIR, 'strongroom.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  quota_bytes   INTEGER NOT NULL,
  used_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relpath    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
`);

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const username = config.ADMIN_USERNAME;
  let password = config.ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  const hash = bcrypt.hashSync(password, config.BCRYPT_COST);
  db.prepare(
    'INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, hash, 'admin', config.DEFAULT_QUOTA_BYTES, Date.now());
  if (generated) {
    console.log('');
    console.log('  ================================================');
    console.log(`  First run: created admin account "${username}"`);
    console.log(`  Password:  ${password}`);
    console.log('  This is shown once. Change it after signing in.');
    console.log('  ================================================');
    console.log('');
  } else {
    console.log(`[strongroom] first run: created admin account "${username}" from ADMIN_PASSWORD`);
  }
}
seedAdmin();

function audit({ userId = null, username = null, action, detail = '', ip = '' }) {
  db.prepare(
    'INSERT INTO audit_logs (user_id, username, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, username, action, String(detail).slice(0, 500), ip, Date.now());
}

function createSession(userId, ip, userAgent) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, csrf, ip || '', String(userAgent || '').slice(0, 300), now, now + config.SESSION_TTL_MS);
  return { id, csrf };
}

function getSession(id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return s;
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function deleteUserSessions(userId, exceptSessionId = null) {
  if (exceptSessionId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptSessionId);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function setUsedBytes(userId, used) {
  db.prepare('UPDATE users SET used_bytes = ? WHERE id = ?').run(Math.max(0, used), userId);
}

function addUsedBytes(userId, delta) {
  db.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?').run(delta, userId);
}

module.exports = {
  db,
  audit,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  cleanupExpiredSessions,
  getUserById,
  getUserByUsername,
  setUsedBytes,
  addUsedBytes,
};
