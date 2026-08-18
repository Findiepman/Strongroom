'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Busboy = require('busboy');
const config = require('../config');
const { db, audit, addUsedBytes, setUsedBytes } = require('../db');
const { requireAuth, csrfProtect } = require('../middleware/auth');
const { safeResolve, validateName, relDisplay, dirSize, PathError } = require('../util/paths');
const { validateUpload, previewType, guessMime } = require('../util/filetype');

const router = express.Router();
router.use(requireAuth, csrfProtect);

function userRoot(req) {
  const root = path.join(config.STORAGE_ROOT, req.user.username);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// GET /api/files/list?path=/docs
router.get('/list', (req, res) => {
  const root = userRoot(req);
  const abs = safeResolve(root, req.query.path);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return res.status(404).json({ error: 'Folder not found' });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder' });

  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => {
      const p = path.join(abs, e.name);
      let s;
      try { s = fs.statSync(p); } catch { return null; }
      return {
        name: e.name,
        dir: e.isDirectory(),
        size: e.isDirectory() ? null : s.size,
        mtime: s.mtimeMs,
        mime: e.isDirectory() ? null : guessMime(e.name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));

  res.json({
    path: relDisplay(root, abs),
    entries,
    usedBytes: req.user.used_bytes,
    quotaBytes: req.user.quota_bytes,
  });
});

// POST /api/files/upload?path=/docs&overwrite=0  (multipart, one or many files)
router.post('/upload', (req, res, next) => {
  const root = userRoot(req);
  let destDir;
  try {
    destDir = safeResolve(root, req.query.path);
    if (!fs.statSync(destDir).isDirectory()) throw new PathError('Not a folder');
  } catch (err) {
    return next(err);
  }
  const overwrite = req.query.overwrite === '1';

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { files: 100, fileSize: config.MAX_UPLOAD_BYTES },
    });
  } catch {
    return res.status(400).json({ error: 'Send files as multipart/form-data' });
  }

  const results = [];
  const pending = [];
  const quota = req.user.quota_bytes;
  let usedNow = req.user.used_bytes;

  busboy.on('file', (field, stream, info) => {
    let name;
    try {
      name = validateName(path.basename(info.filename || ''));
    } catch (err) {
      results.push({ name: String(info.filename || '').slice(0, 100), ok: false, error: err.message });
      stream.resume();
      return;
    }

    const tmpPath = path.join(config.TMP_DIR, crypto.randomBytes(16).toString('hex') + '.part');
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
    let written = 0;
    let failed = null;

    stream.on('data', (chunk) => {
      written += chunk.length;
      if (usedNow + written > quota && !failed) {
        failed = 'Upload exceeds your storage quota';
        stream.unpipe(out);
        out.destroy();
        stream.resume();
      }
    });
    stream.on('limit', () => {
      if (!failed) failed = `File is larger than the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`;
    });
    stream.pipe(out);

    const done = new Promise((resolve) => {
      stream.on('close', () => {
        out.end();
        out.on('close', finish);
        out.on('error', finish);
        if (out.destroyed) finish();

        function finish() {
          try {
            if (failed) {
              fs.rmSync(tmpPath, { force: true });
              results.push({ name, ok: false, error: failed });
              return resolve();
            }
            const check = validateUpload(tmpPath, name);
            if (!check.ok) {
              fs.rmSync(tmpPath, { force: true });
              audit({ userId: req.user.id, username: req.user.username, action: 'upload.blocked', detail: `${name}: ${check.reason}`, ip: req.ip });
              results.push({ name, ok: false, error: check.reason });
              return resolve();
            }
            const dest = path.join(destDir, name);
            if (!overwrite && fs.existsSync(dest)) {
              fs.rmSync(tmpPath, { force: true });
              results.push({ name, ok: false, error: 'A file with this name already exists' });
              return resolve();
            }
            const replacedSize = overwrite && fs.existsSync(dest) ? fs.statSync(dest).size : 0;
            fs.renameSync(tmpPath, dest);
            usedNow += written - replacedSize;
            addUsedBytes(req.user.id, written - replacedSize);
            const rel = relDisplay(root, dest);
            db.prepare('INSERT INTO files (user_id, relpath, size, mime, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(req.user.id, rel, written, check.mime, Date.now());
            audit({ userId: req.user.id, username: req.user.username, action: 'upload', detail: `${rel} (${written} bytes)`, ip: req.ip });
            results.push({ name, ok: true, size: written, mime: check.mime });
            resolve();
          } catch (err) {
            fs.rmSync(tmpPath, { force: true });
            results.push({ name, ok: false, error: 'Could not store the file' });
            console.error('[upload]', err);
            resolve();
          }
        }
      });
    });
    pending.push(done);
  });

  busboy.on('close', async () => {
    await Promise.all(pending);
    res.json({ results, usedBytes: usedNow, quotaBytes: quota });
  });
  busboy.on('error', () => res.status(400).json({ error: 'Upload stream failed. Try again.' }));
  req.pipe(busboy);
});

// GET /api/files/download?path=/docs/report.pdf
router.get('/download', (req, res) => {
  const root = userRoot(req);
  const abs = safeResolve(root, req.query.path);
  let stat;
  try { stat = fs.statSync(abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  audit({ userId: req.user.id, username: req.user.username, action: 'download', detail: relDisplay(root, abs), ip: req.ip });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(abs, path.basename(abs));
});

// GET /api/files/preview?path=/notes.txt — inline for image/pdf/text only
router.get('/preview', (req, res) => {
  const root = userRoot(req);
  const abs = safeResolve(root, req.query.path);
  let stat;
  try { stat = fs.statSync(abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  const pv = previewType(abs, path.basename(abs));
  if (!pv) return res.status(415).json({ error: 'No in-browser preview for this file type. Download it instead.' });
  audit({ userId: req.user.id, username: req.user.username, action: 'preview', detail: relDisplay(root, abs), ip: req.ip });
  res.setHeader('Content-Type', pv.contentType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  fs.createReadStream(abs).pipe(res);
});

// POST /api/files/mkdir {path, name}
router.post('/mkdir', (req, res) => {
  const root = userRoot(req);
  const { path: rel, name } = req.body || {};
  const parent = safeResolve(root, rel);
  const cleanName = validateName(name);
  const abs = path.join(parent, cleanName);
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'A file or folder with this name already exists' });
  fs.mkdirSync(abs);
  audit({ userId: req.user.id, username: req.user.username, action: 'mkdir', detail: relDisplay(root, abs), ip: req.ip });
  res.json({ ok: true });
});

// POST /api/files/rename {path, newName}
router.post('/rename', (req, res) => {
  const root = userRoot(req);
  const { path: rel, newName } = req.body || {};
  const abs = safeResolve(root, rel);
  if (abs === path.resolve(root)) return res.status(400).json({ error: 'Cannot rename the root folder' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
  const cleanName = validateName(newName);
  const dest = path.join(path.dirname(abs), cleanName);
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A file with the new name already exists' });
  fs.renameSync(abs, dest);
  audit({ userId: req.user.id, username: req.user.username, action: 'rename', detail: `${relDisplay(root, abs)} -> ${cleanName}`, ip: req.ip });
  res.json({ ok: true });
});

// POST /api/files/delete {paths: ["/a.txt", "/docs"]}
router.post('/delete', (req, res) => {
  const root = userRoot(req);
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) {
    return res.status(400).json({ error: 'Send between 1 and 200 paths' });
  }
  const results = [];
  let freed = 0;
  for (const rel of paths) {
    try {
      const abs = safeResolve(root, rel);
      if (abs === path.resolve(root)) throw new PathError('Cannot delete the root folder');
      const stat = fs.lstatSync(abs);
      const size = stat.isDirectory() ? dirSize(abs) : stat.size;
      fs.rmSync(abs, { recursive: true, force: false });
      freed += size;
      audit({ userId: req.user.id, username: req.user.username, action: 'delete', detail: `${relDisplay(root, abs)} (${size} bytes)`, ip: req.ip });
      results.push({ path: rel, ok: true });
    } catch (err) {
      results.push({ path: String(rel).slice(0, 200), ok: false, error: err.code === 'ENOENT' ? 'Not found' : (err.message || 'Delete failed') });
    }
  }
  if (freed > 0) addUsedBytes(req.user.id, -freed);
  res.json({ results });
});

// Error handler local to file routes: surface PathError messages, hide the rest.
router.use((err, req, res, next) => {
  if (err instanceof PathError) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
