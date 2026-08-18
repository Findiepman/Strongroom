'use strict';
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db, audit, deleteUserSessions, setUsedBytes } = require('../db');
const { requireAuth, csrfProtect } = require('../middleware/auth');
const { dirSize } = require('../util/paths');

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

// GET /api/user/usage — recomputed from disk, not the cached column
router.get('/usage', (req, res) => {
  const root = path.join(config.STORAGE_ROOT, req.user.username);
  const used = dirSize(root);
  setUsedBytes(req.user.id, used);
  res.json({ usedBytes: used, quotaBytes: req.user.quota_bytes });
});

module.exports = router;
