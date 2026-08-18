'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const { db, audit, deleteUserSessions, getUserById } = require('../db');
const { requireAuth, requireAdmin, csrfProtect } = require('../middleware/auth');

const router = express.Router();
// Role check is middleware on every admin route, not a hidden UI affordance.
router.use(requireAuth, requireAdmin, csrfProtect);

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.quota_bytes, u.used_bytes, u.created_at,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
    FROM users u ORDER BY u.username
  `).all(Date.now());
  res.json({ users });
});

// POST /api/admin/users {username, password, role, quotaBytes}
router.post('/users', async (req, res, next) => {
  try {
    const { username, password, role, quotaBytes } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 chars: lowercase letters, digits, - or _, starting with a letter' });
    }
    if (typeof password !== 'string' || password.length < config.MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password needs at least ${config.MIN_PASSWORD_LENGTH} characters` });
    }
    if (role !== 'admin' && role !== 'user') {
      return res.status(400).json({ error: 'Role must be "admin" or "user"' });
    }
    const quota = Number.isFinite(Number(quotaBytes)) && Number(quotaBytes) > 0
      ? Math.floor(Number(quotaBytes))
      : config.DEFAULT_QUOTA_BYTES;
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: 'That username is taken' });

    const hash = await bcrypt.hash(password, config.BCRYPT_COST);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hash, role, quota, Date.now());
    fs.mkdirSync(path.join(config.STORAGE_ROOT, username), { recursive: true });
    fs.mkdirSync(path.join(config.SFTP_ROOT, username), { recursive: true });
    audit({ userId: req.user.id, username: req.user.username, action: 'user.create', detail: `${username} (${role}, quota ${quota})`, ip: req.ip });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id {quotaBytes?, role?}
router.patch('/users/:id', (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'No such user' });
  const { quotaBytes, role } = req.body || {};

  if (quotaBytes !== undefined) {
    const q = Math.floor(Number(quotaBytes));
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'Quota must be a positive number of bytes' });
    db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(q, target.id);
    audit({ userId: req.user.id, username: req.user.username, action: 'quota.set', detail: `${target.username} -> ${q} bytes`, ip: req.ip });
  }
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Role must be "admin" or "user"' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    audit({ userId: req.user.id, username: req.user.username, action: 'role.set', detail: `${target.username} -> ${role}`, ip: req.ip });
  }
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id — removes the account and its sessions.
// Files stay on disk so a mistaken delete loses no data; clean up manually.
router.delete('/users/:id', (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'No such user' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit({ userId: req.user.id, username: req.user.username, action: 'user.delete', detail: `${target.username} (files kept on disk)`, ip: req.ip });
  res.json({ ok: true, note: 'Account removed. Files remain on disk under the storage root.' });
});

// POST /api/admin/users/:id/logout — force-logout everywhere
router.post('/users/:id/logout', (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'No such user' });
  deleteUserSessions(target.id);
  audit({ userId: req.user.id, username: req.user.username, action: 'user.force_logout', detail: target.username, ip: req.ip });
  res.json({ ok: true });
});

// GET /api/admin/audit?action=&user=&limit=&offset=
router.get('/audit', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const clauses = [];
  const params = [];
  if (req.query.action) { clauses.push('action = ?'); params.push(String(req.query.action)); }
  if (req.query.user) { clauses.push('username = ?'); params.push(String(req.query.user)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT id, username, action, detail, ip, created_at FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`).get(...params).n;
  res.json({ rows, total, limit, offset });
});

module.exports = router;
