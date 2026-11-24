'use strict';
// Live preview of pulled repos: serves a repo folder as a static site so
// frontend-only apps run straight from the browser (/live/<repo>/).
//
// Repo code is untrusted. Served on the app's origin it could read
// /api/auth/me, take the CSRF token and act as whoever opened the preview
// (an admin). So every preview response carries `CSP: sandbox` without
// allow-same-origin: the page gets an opaque origin of its own and can't
// reach the app's cookies, storage or API. The price: localStorage, cookies
// and IndexedDB don't work inside previews.
//
// A sandboxed page's own requests (scripts, styles, images, fetch) go out
// without the session cookie (opaque origin = cross-site), so they can't be
// signed in that way. Instead the first, signed-in visit is redirected to
// /live/_/<token>/<repo>/..., and the token in the URL authorizes the rest.
// A token covers one repo for one sign-in session and dies with it; the page
// can read its own token, but that only opens the repo it already is.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getSession } = require('../db');
const { resolveSession } = require('../middleware/auth');
const { safeResolve, isRealInside } = require('../util/paths');

const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const TOKEN_RE = /^\/_\/([A-Za-z0-9_-]{32})(\/.*)?$/;

const tokens = new Map();    // token -> { sessionId, repo, expiresAt }
const bySession = new Map(); // `${sessionId}/${repo}` -> token, so reloads reuse one

function prune(now) {
  for (const [token, t] of tokens) {
    if (t.expiresAt <= now) {
      tokens.delete(token);
      bySession.delete(`${t.sessionId}/${t.repo}`);
    }
  }
}

function tokenFor(session, repo) {
  const now = Date.now();
  prune(now);
  const key = `${session.id}/${repo}`;
  const existing = bySession.get(key);
  if (existing && tokens.has(existing)) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, { sessionId: session.id, repo, expiresAt: session.expires_at });
  bySession.set(key, token);
  return token;
}

// The token's record while it and its sign-in session are still valid.
function checkToken(token) {
  const t = tokens.get(token);
  if (!t) return null;
  if (t.expiresAt <= Date.now() || !getSession(t.sessionId)) {
    tokens.delete(token);
    bySession.delete(`${t.sessionId}/${t.repo}`);
    return null;
  }
  return t;
}

// The file a preview URL path points at (decoded and normalized the way
// express.static will), with the repo it sits in, or null when it is not a
// path inside REPOS_ROOT.
function locate(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  // safeResolve reads \ as /, send (on Linux) as part of a name: refuse it so
  // the path checked here is always the file served.
  if (decoded.includes('\\')) return null;
  let abs;
  try { abs = safeResolve(config.REPOS_ROOT, decoded); } catch { return null; }
  const repo = path.relative(path.resolve(config.REPOS_ROOT), abs).split(path.sep)[0];
  return repo ? { abs, repo } : null;
}

// Real-path check before express.static: a symlink in a repo (checked out
// before core.symlinks=false, or put there another way) must not serve a file
// from elsewhere on the server. A folder is served through its index.html
// (only for a path ending in /; send redirects a bare folder there first),
// so that is checked too.
// Checked against the repo's own folder as well, so a link in repo A can't
// serve repo B under A's token (and against REPOS_ROOT, in case the repo
// folder itself is a link).
function leavesRepos(abs, urlPath, repo) {
  const repoRoot = path.join(config.REPOS_ROOT, repo);
  const inside = (p) => isRealInside(config.REPOS_ROOT, p) && isRealInside(repoRoot, p);
  if (!inside(abs)) return true;
  return urlPath.endsWith('/') && !inside(path.join(abs, 'index.html'));
}

const router = express.Router();
// Dotfiles (.git and friends) are ignored by express.static's default.
const liveStatic = express.static(config.REPOS_ROOT, { fallthrough: false });

router.use((req, res, next) => {
  const m = req.path.match(TOKEN_RE);
  if (!m) {
    // First visit (or a token that expired): needs the signed-in session.
    resolveSession(req, res);
    if (!req.user) return res.redirect('/');
    const target = locate(req.path);
    // Tokens only for repos that exist, so made-up names can't pile them up.
    if (!target || !fs.existsSync(path.join(config.REPOS_ROOT, target.repo, '.git'))) return res.status(404).end();
    const token = tokenFor(req.session, target.repo);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, `${req.baseUrl}/_/${token}${req.url}`);
  }

  const rest = m[2] || '/';
  const query = req.url.slice(req.path.length);
  const t = checkToken(m[1]);
  if (!t) {
    // A reload after the token expired still carries the cookie: start over.
    resolveSession(req, res);
    if (!req.user) return res.redirect('/');
    return res.redirect(302, `${req.baseUrl}${rest}${query}`);
  }
  const target = locate(rest);
  if (!target || target.repo !== t.repo) return res.status(404).end();

  res.setHeader('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Requests from the opaque origin are cross-origin: module scripts and
  // fetch() need CORS, and helmet's CORP same-origin would block the rest.
  // The token in the path is the only credential, never a cookie.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (leavesRepos(target.abs, rest, target.repo)) return res.status(404).end();

  // express.static resolves req.url against REPOS_ROOT; its folder redirects
  // use originalUrl, so they keep the token.
  req.url = rest + query;
  liveStatic(req, res, next);
});

module.exports = router;
module.exports.PREVIEW_CSP = PREVIEW_CSP;
