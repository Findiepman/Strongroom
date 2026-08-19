'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./src/config');
const { cleanupExpiredSessions } = require('./src/db');
const { resolveSession } = require('./src/middleware/auth');
const { startSftpServer } = require('./src/sftp');

const app = express();
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'self'"], // same-origin PDF preview
      frameSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      // Helmet adds this by default; it breaks plain-http LAN access by
      // forcing every asset request to https. TLS is the proxy's job.
      upgradeInsecureRequests: null,
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
}));

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// A modest global backstop; auth endpoints carry their own stricter limits.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
}));

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/user', require('./src/routes/user'));
app.use('/api/files', require('./src/routes/files'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/github', require('./src/routes/github'));
app.use('/api/sftp', require('./src/routes/sftp-info'));

// --- Pages ---
const PUBLIC_DIR = path.join(config.ROOT, 'public');
const page = (name) => path.join(PUBLIC_DIR, name);

// Server-side gate for app pages: no session, no HTML.
function pageAuth(req, res, next) {
  resolveSession(req, res);
  if (!req.user) return res.redirect('/');
  next();
}

app.get('/', (req, res) => {
  resolveSession(req, res);
  if (req.user) return res.redirect('/files');
  res.sendFile(page('login.html'));
});
app.get('/files', pageAuth, (req, res) => res.sendFile(page('files.html')));
app.get('/github', pageAuth, (req, res) => res.sendFile(page('github.html')));
app.get('/sftp', pageAuth, (req, res) => res.sendFile(page('sftp.html')));
app.get('/settings', pageAuth, (req, res) => res.sendFile(page('settings.html')));
// Admin page: role checked server-side, same as the admin API.
app.get('/admin', pageAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/files');
  res.sendFile(page('admin.html'));
});

app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '1h' }));

// --- Live preview of pulled repos ---
// Serves a repo folder as a static site so frontend-only apps run straight
// from the browser (/live/<repo>/). Same session gate as the app pages.
// Dotfiles (.git and friends) are ignored by express.static's default.
const liveStatic = express.static(config.REPOS_ROOT, { fallthrough: false });
app.use('/live', (req, res, next) => {
  resolveSession(req, res);
  if (!req.user) return res.redirect('/');
  // The app's strict CSP would break previewed code (inline scripts, CDN
  // assets). The preview tab intentionally runs unpoliced.
  res.removeHeader('Content-Security-Policy');
  liveStatic(req, res, next);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));
app.use((req, res) => res.redirect('/'));

// Final error handler: log server-side, never leak internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something broke on the server. Check the logs.' });
});

setInterval(cleanupExpiredSessions, 15 * 60 * 1000).unref();

app.listen(config.PORT, config.HOST, () => {
  console.log(`[strongroom] web ui on http://${config.HOST}:${config.PORT}`);
  console.log(`[strongroom] storage root: ${config.STORAGE_ROOT}`);
});

startSftpServer();
