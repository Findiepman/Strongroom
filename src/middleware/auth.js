'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getSession, getUserById } = require('../db');

function clearAuthCookie(res) {
  res.clearCookie(config.COOKIE_NAME, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
  });
}

function setAuthCookie(res, token) {
  res.cookie(config.COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
    maxAge: config.SESSION_TTL_MS,
  });
}

// Resolves the session from the JWT cookie; attaches req.user and req.session
// or leaves both undefined. Never errors.
function resolveSession(req, res) {
  const token = req.cookies && req.cookies[config.COOKIE_NAME];
  if (!token) return;
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    clearAuthCookie(res);
    return;
  }
  const session = getSession(payload.sid);
  if (!session) {
    clearAuthCookie(res);
    return;
  }
  const user = getUserById(session.user_id);
  if (!user) {
    clearAuthCookie(res);
    return;
  }
  req.session = session;
  req.user = user;
}

function requireAuth(req, res, next) {
  resolveSession(req, res);
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'This action needs an admin account' });
  }
  next();
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// CSRF: session-bound token, delivered via /api/auth/me, sent back in a header.
// Combined with SameSite=Strict cookies this is defense in depth.
function csrfProtect(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const token = req.get('x-csrf-token');
  if (!req.session || !token || !timingSafeEqualStr(token, req.session.csrf_token)) {
    return res.status(403).json({ error: 'Request rejected (missing or stale CSRF token). Reload the page and try again.' });
  }
  next();
}

module.exports = { resolveSession, requireAuth, requireAdmin, csrfProtect, setAuthCookie, clearAuthCookie };
