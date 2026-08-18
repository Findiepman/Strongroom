'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { audit, createSession, deleteSession, getUserByUsername, setUsedBytes } = require('../db');
const { requireAuth, csrfProtect, setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const { dirSize } = require('../util/paths');

const router = express.Router();

// A constant hash compared against when the username does not exist, so
// response time does not reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.BCRYPT_COST);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' },
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    quotaBytes: u.quota_bytes,
    usedBytes: u.used_bytes,
  };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Enter a username and password' });
    }
    const user = getUserByUsername(username.trim());
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      audit({ action: 'login.fail', detail: `username=${username.trim().slice(0, 40)}`, ip: req.ip });
      return res.status(401).json({ error: 'Wrong username or password' });
    }

    // Refresh usage on login so the gauge is honest even after SFTP-side changes.
    const userRoot = path.join(config.STORAGE_ROOT, user.username);
    fs.mkdirSync(userRoot, { recursive: true });
    const used = dirSize(userRoot);
    setUsedBytes(user.id, used);
    user.used_bytes = used;

    const session = createSession(user.id, req.ip, req.get('user-agent'));
    const token = jwt.sign({ sid: session.id }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: Math.floor(config.SESSION_TTL_MS / 1000),
    });
    setAuthCookie(res, token);
    audit({ userId: user.id, username: user.username, action: 'login.success', ip: req.ip });
    res.json({ user: publicUser(user), csrf: session.csrf });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, csrfProtect, (req, res) => {
  deleteSession(req.session.id);
  clearAuthCookie(res);
  audit({ userId: req.user.id, username: req.user.username, action: 'logout', ip: req.ip });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), csrf: req.session.csrf_token });
});

module.exports = router;
