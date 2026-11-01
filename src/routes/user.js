'use strict';
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db, audit, deleteUserSessions } = require('../db');
const { requireAuth, csrfProtect } = require('../middleware/auth');
const locks = require('../util/locks');
const usage = require('../util/usage');

const router = express.Router();
router.use(requireAuth, csrfProtect);

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many password attempts. Wait 15 minutes and try again.' },
});

// POST /api/user/password {current, next}
router.post('/password', passwordLimiter, async (req, res, nextFn) => {
  try {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') {
      return res.status(400).json({ error: 'Enter your current and new password' });
    }
    if (next.length < config.MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `New password needs at least ${config.MIN_PASSWORD_LENGTH} characters` });
    }
    const ok = await bcrypt.compare(current, req.user.password_hash);
    if (!ok) {
      audit({ userId: req.user.id, username: req.user.username, action: 'password.fail', ip: req.ip });
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    const hash = await bcrypt.hash(next, config.BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    // Kill every other session for this account; the current one stays valid.
    deleteUserSessions(req.user.id, req.session.id);
    audit({ userId: req.user.id, username: req.user.username, action: 'password.change', ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    nextFn(err);
  }
});

// GET /api/user/usage — recounted from disk now (asynchronously: the server
// keeps serving other requests meanwhile), not the cached column
router.get('/usage', (req, res, next) => {
  usage.refresh(req.user)
    .then((u) => res.json({ usedBytes: u.usedBytes, quotaBytes: req.user.quota_bytes }))
    .catch(next);
});

// GET /api/user/overview — everything the home screen shows in one call:
// storage split by top-level folder, recent uploads, and recent activity
// (the user's own; admins see everyone's). Folder sizes come from the last
// count (src/util/usage.js), which is redone in the background when it's old;
// walking a big tree here used to freeze the whole server on every reload.
router.get('/overview', (req, res) => {
  const fs = require('fs');
  const root = path.join(config.STORAGE_ROOT, req.user.username);
  fs.mkdirSync(root, { recursive: true });

  const sizes = usage.current(req.user);
  const breakdown = sizes.breakdown;
  const looseBytes = sizes.looseBytes;
  const used = req.user.used_bytes; // kept up to date by uploads/deletes and by each count

  // Recent uploads that still exist where they were put, leaving out what's in
  // a locked folder this session hasn't opened.
  const lv = locks.view(req);
  const recent = [];
  const seen = new Set();
  const rows = db.prepare(
    'SELECT relpath, size, mime, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 60'
  ).all(req.user.id);
  for (const r of rows) {
    if (recent.length >= 8 || seen.has(r.relpath)) continue;
    seen.add(r.relpath);
    if (lv.blocking(r.relpath)) continue;
    try {
      const st = fs.statSync(path.join(root, ...r.relpath.split('/').filter(Boolean)));
      if (!st.isFile()) continue;
      recent.push({ path: r.relpath, name: r.relpath.split('/').pop(), size: st.size, mime: r.mime, created: r.created_at });
    } catch { /* moved or deleted since */ }
  }

  const isAdmin = req.user.role === 'admin';
  const activity = db.prepare(
    `SELECT id, username, action, detail, created_at FROM audit_logs
     ${isAdmin ? '' : 'WHERE user_id = ?'} ORDER BY created_at DESC, id DESC LIMIT 200`
  ).all(...(isAdmin ? [] : [req.user.id]))
    // Your own events about files in a closed locked folder (their names) stay hidden too.
    .filter((r) => {
      if (r.username !== req.user.username || !lv.locks.length || r.action.startsWith('folder.')) return true;
      const m = String(r.detail || '').match(/^(\/[^\n]*?)(?: \(\d+ bytes\)| \(folder\)| -> .*|: .*)?$/);
      return !(m && lv.blocking(m[1].replace(/\/$/, '') || '/'));
    });

  res.json({
    usedBytes: used,
    quotaBytes: req.user.quota_bytes,
    breakdown,
    looseBytes,
    sizesPending: sizes.pending, // no count yet: the page asks again in a bit
    sizesAt: sizes.computedAt,
    recent,
    activity,
    activityScope: isAdmin ? 'everyone' : 'you',
  });
});

module.exports = router;
