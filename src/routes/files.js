'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Busboy = require('busboy');
const archiver = require('archiver');
const config = require('../config');
const { db, audit, addUsedBytes } = require('../db');
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

// Client paths live in one virtual tree: the user's own storage, plus a
// read-only "/repos" mount that maps onto REPOS_ROOT (the GitHub puller's
// sandbox). Everything resolves through safeResolve against its real root.
function resolveTarget(req, relPath) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  const m = raw.match(/^\/?repos(?:\/(.*))?$/);
  if (m) {
    const abs = safeResolve(config.REPOS_ROOT, m[1] || '');
    return { abs, root: config.REPOS_ROOT, readOnly: true, prefix: '/repos' };
  }
  const root = userRoot(req);
  return { abs: safeResolve(root, raw), root, readOnly: false, prefix: '' };
}

function displayPath(t) {
  const rd = relDisplay(t.root, t.abs);
  if (!t.prefix) return rd;
  return rd === '/' ? t.prefix : t.prefix + rd;
}

// "repos" is reserved at the top level of user storage so a real file or
// folder can never shadow the virtual mount.
function assertNotReserved(destDir, root, name) {
  if (path.resolve(destDir) === path.resolve(root) && name.toLowerCase() === 'repos') {
    throw new PathError('The name "repos" is reserved at the top level');
  }
}

function readOnlyError(res) {
  return res.status(403).json({ error: 'Repos are read-only here. Update them with the GitHub puller.' });
}

// GET /api/files/list?path=/docs
router.get('/list', (req, res) => {
  const t = resolveTarget(req, req.query.path);
  let stat;
  try {
    stat = fs.statSync(t.abs);
  } catch {
    return res.status(404).json({ error: 'Folder not found' });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder' });

  const entries = fs.readdirSync(t.abs, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isDirectory())
    .filter((e) => !(t.readOnly && e.name === '.git'))
    .map((e) => {
      const p = path.join(t.abs, e.name);
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
    .filter(Boolean);

  // The virtual repos mount appears at the top of the user's own root.
  if (!t.readOnly && t.abs === path.resolve(t.root)) {
    entries.push({ name: 'repos', dir: true, size: null, mtime: null, mime: null, repo: true });
  }

  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));

  res.json({
    path: displayPath(t),
    readOnly: t.readOnly,
    entries,
    usedBytes: req.user.used_bytes,
    quotaBytes: req.user.quota_bytes,
  });
});

// POST /api/files/upload?path=/docs&overwrite=0  (multipart, one or many files)
router.post('/upload', (req, res, next) => {
  let target;
  try {
    target = resolveTarget(req, req.query.path);
    if (target.readOnly) return readOnlyError(res);
    // Folder uploads send files one by one with mkdirs=1 so their subtree is
    // created on the fly; every new segment is validated like mkdir would.
    if (req.query.mkdirs === '1' && !fs.existsSync(target.abs)) {
      const segs = path.relative(path.resolve(target.root), target.abs).split(path.sep);
      for (const seg of segs) validateName(seg);
      assertNotReserved(path.resolve(target.root), target.root, segs[0]);
      fs.mkdirSync(target.abs, { recursive: true });
    }
    if (!fs.statSync(target.abs).isDirectory()) throw new PathError('Not a folder');
  } catch (err) {
    return next(err);
  }
  const root = target.root;
  const destDir = target.abs;
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
      assertNotReserved(destDir, root, name);
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
  const t = resolveTarget(req, req.query.path);
  let stat;
  try { stat = fs.statSync(t.abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  audit({ userId: req.user.id, username: req.user.username, action: 'download', detail: displayPath(t), ip: req.ip });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(t.abs, path.basename(t.abs));
});

// GET /api/files/download-zip?path=/docs — stream a folder as a zip
router.get('/download-zip', (req, res) => {
  const t = resolveTarget(req, req.query.path);
  let stat;
  try { stat = fs.statSync(t.abs); } catch {
    return res.status(404).json({ error: 'Folder not found' });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder' });
  const name = path.basename(t.abs) || 'storage';
  audit({ userId: req.user.id, username: req.user.username, action: 'download.zip', detail: displayPath(t), ip: req.ip });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.zip')}`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', () => { /* files vanishing mid-walk are skipped */ });
  archive.on('error', (err) => {
    console.error('[zip]', err);
    res.destroy();
  });
  // res 'close' fires on normal finish too; only abort if the client bailed.
  res.on('close', () => { if (!res.writableFinished) archive.abort(); });
  archive.pipe(res);
  // Repo zips leave out .git internals, matching what the listing shows.
  const gitGlobs = ['.git', '.git/**', '**/.git', '**/.git/**'];
  archive.glob('**/*', {
    cwd: t.abs,
    dot: true,
    follow: false,
    ignore: t.readOnly ? gitGlobs : [],
    skip: t.readOnly ? gitGlobs : [],
  }, { prefix: name });
  archive.finalize();
});

// GET /api/files/preview?path=/notes.txt  (inline for image/pdf/text only)
router.get('/preview', (req, res) => {
  const t = resolveTarget(req, req.query.path);
  let stat;
  try { stat = fs.statSync(t.abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  const pv = previewType(t.abs, path.basename(t.abs));
  if (!pv) return res.status(415).json({ error: 'No in-browser preview for this file type. Download it instead.' });
  audit({ userId: req.user.id, username: req.user.username, action: 'preview', detail: displayPath(t), ip: req.ip });
  res.setHeader('Content-Type', pv.contentType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(t.abs))}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  fs.createReadStream(t.abs).pipe(res);
});

// POST /api/files/mkdir {path, name}
router.post('/mkdir', (req, res) => {
  const { path: rel, name } = req.body || {};
  const t = resolveTarget(req, rel);
  if (t.readOnly) return readOnlyError(res);
  const cleanName = validateName(name);
  assertNotReserved(t.abs, t.root, cleanName);
  const abs = path.join(t.abs, cleanName);
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'A file or folder with this name already exists' });
  fs.mkdirSync(abs);
  audit({ userId: req.user.id, username: req.user.username, action: 'mkdir', detail: relDisplay(t.root, abs), ip: req.ip });
  res.json({ ok: true });
});

// POST /api/files/rename {path, newName}
router.post('/rename', (req, res) => {
  const { path: rel, newName } = req.body || {};
  const t = resolveTarget(req, rel);
  if (t.readOnly) return readOnlyError(res);
  if (t.abs === path.resolve(t.root)) return res.status(400).json({ error: 'Cannot rename the root folder' });
  if (!fs.existsSync(t.abs)) return res.status(404).json({ error: 'File not found' });
  const cleanName = validateName(newName);
  assertNotReserved(path.dirname(t.abs), t.root, cleanName);
  const dest = path.join(path.dirname(t.abs), cleanName);
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A file with the new name already exists' });
  fs.renameSync(t.abs, dest);
  audit({ userId: req.user.id, username: req.user.username, action: 'rename', detail: `${relDisplay(t.root, t.abs)} -> ${cleanName}`, ip: req.ip });
  res.json({ ok: true });
});

// POST /api/files/delete {paths: ["/a.txt", "/docs"]}
router.post('/delete', (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) {
    return res.status(400).json({ error: 'Send between 1 and 200 paths' });
  }
  const results = [];
  let freed = 0;
  for (const rel of paths) {
    try {
      const t = resolveTarget(req, rel);
      if (t.readOnly) throw new PathError('Repos are read-only here');
      if (t.abs === path.resolve(t.root)) throw new PathError('Cannot delete the root folder');
      const stat = fs.lstatSync(t.abs);
      const size = stat.isDirectory() ? dirSize(t.abs) : stat.size;
      fs.rmSync(t.abs, { recursive: true, force: false });
      freed += size;
      audit({ userId: req.user.id, username: req.user.username, action: 'delete', detail: `${relDisplay(t.root, t.abs)} (${size} bytes)`, ip: req.ip });
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
