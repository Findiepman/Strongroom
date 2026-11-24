'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Busboy = require('busboy');
const archiver = require('archiver');
const config = require('../config');
const { db, audit, addUsedBytes, getUserById } = require('../db');
const { requireAuth, csrfProtect } = require('../middleware/auth');
const { safeResolve, assertRealInside, validateName, relDisplay, PathError } = require('../util/paths');
const { validateUpload, previewType, guessMime } = require('../util/filetype');
const { assertNotReserved, moveIntoPlace } = require('../util/storage');
const locks = require('../util/locks');
const usage = require('../util/usage');
const quota = require('../util/quota');

const router = express.Router();
router.use(requireAuth, csrfProtect);

function userRoot(req) {
  const root = path.join(config.STORAGE_ROOT, req.user.username);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Client paths live in one virtual tree: the user's own storage, plus a
// read-only "/repos" mount that maps onto REPOS_ROOT (the GitHub puller's
// sandbox). Everything resolves through safeResolve against its real root,
// then through assertRealInside so a symlink can't lead out of it (pulled
// repos can check them out; on the NAS share they can appear from outside the
// app). { followLeaf: false } is for delete and rename, which act on the entry
// itself: removing or renaming a link never touches what it points at, and a
// stray link must stay removable.
// A path inside a locked folder is refused (423) unless this session opened
// it; { lockCheck: false } is only for the lock routes, which check themselves.
function resolveTarget(req, relPath, { lockCheck = true, followLeaf = true } = {}) {
  const raw = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  const m = raw.match(/^\/?repos(?:\/(.*))?$/);
  if (m) {
    // Repos are read-only, so every access follows the leaf.
    const abs = assertRealInside(config.REPOS_ROOT, safeResolve(config.REPOS_ROOT, m[1] || ''));
    return { abs, root: config.REPOS_ROOT, readOnly: true, prefix: '/repos', rel: null };
  }
  const root = userRoot(req);
  const abs = assertRealInside(root, safeResolve(root, raw), { followLeaf });
  const rel = relDisplay(root, abs);
  if (lockCheck) locks.assertAccess(req, rel);
  return { abs, root, readOnly: false, prefix: '', rel };
}

function displayPath(t) {
  const rd = relDisplay(t.root, t.abs);
  if (!t.prefix) return rd;
  return rd === '/' ? t.prefix : t.prefix + rd;
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

  const lv = t.readOnly ? null : locks.view(req);
  const entries = fs.readdirSync(t.abs, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isDirectory())
    .filter((e) => !(t.readOnly && e.name === '.git'))
    .map((e) => {
      const p = path.join(t.abs, e.name);
      let s;
      try { s = fs.statSync(p); } catch { return null; }
      const entry = {
        name: e.name,
        dir: e.isDirectory(),
        size: e.isDirectory() ? null : s.size,
        mtime: s.mtimeMs,
        mime: e.isDirectory() ? null : guessMime(e.name),
      };
      const lock = lv && e.isDirectory() ? lv.stateOf(relDisplay(t.root, p)) : null;
      if (lock) entry.lock = lock;
      return entry;
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
    // Locked folders this folder is in (all open, or the request was refused).
    lockedBy: lv ? locks.covering(lv.locks, t.rel).map((l) => l.relpath) : [],
    entries,
    usedBytes: req.user.used_bytes,
    quotaBytes: req.user.quota_bytes,
  });
});

// GET /api/files/search?q=invoice — name search across the user's own storage.
// Bounded walk so a huge tree can't stall the server.
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' });
  const root = userRoot(req);
  const lv = locks.view(req);
  const results = [];
  const MAX_RESULTS = 100;
  let budget = 20000;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (--budget < 0 || results.length >= MAX_RESULTS) { truncated = true; break; }
      if (!e.isFile() && !e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      const lock = e.isDirectory() ? lv.stateOf(relDisplay(root, p)) : null;
      // A closed locked folder can be found by its name, but not looked into.
      if (e.isDirectory() && !lv.blocking(relDisplay(root, p))) stack.push(p);
      if (!e.name.toLowerCase().includes(q)) continue;
      let s;
      try { s = fs.statSync(p); } catch { continue; }
      results.push({
        name: e.name,
        path: relDisplay(root, p),
        dir: e.isDirectory(),
        size: e.isDirectory() ? null : s.size,
        mtime: s.mtimeMs,
        mime: e.isDirectory() ? null : guessMime(e.name),
        ...(lock ? { lock } : {}),
      });
    }
    if (truncated) break;
  }
  results.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
  res.json({ results, truncated });
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
  const userId = req.user.id;
  // busboy emits 'error' and then 'close' when it fails; answer only once.
  let answered = false;
  const answer = (status, payload) => {
    if (answered || res.headersSent) return;
    answered = true;
    res.status(status).json(payload);
  };

  busboy.on('file', (field, stream, info) => {
    let name;
    try {
      name = validateName(path.basename(info.filename || ''));
      assertNotReserved(destDir, root, name);
    } catch (err) {
      results.push({ name: String(info.filename || '').slice(0, 100), ok: false, error: err.message });
      stream.on('error', () => { /* aborted mid-skip: nothing to clean up */ });
      stream.resume();
      return;
    }

    const dest = path.join(destDir, name);
    const tmpPath = path.join(config.TMP_DIR, crypto.randomBytes(16).toString('hex') + '.part');
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
    // lstat: a symlink in the way is replaced, never followed, and links
    // aren't counted in used_bytes, so replacing one frees nothing.
    const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
    const prev = overwrite ? lstatOrNull(dest) : null;
    const credit = prev && prev.isFile() ? prev.size : 0;
    let written = 0;
    let reserved = 0; // bytes held in the shared quota ledger for this file
    let failed = null;
    const fail = (msg) => {
      if (failed) return;
      failed = msg;
      stream.unpipe(out);
      out.destroy();
      stream.resume();
    };
    const discard = () => {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    };

    stream.on('data', (chunk) => {
      written += chunk.length;
      if (failed) return;
      // Reserve as the bytes arrive, against used_bytes plus every other
      // unfinished upload (other tabs, SFTP), so parallel uploads can't
      // together pass the quota.
      if (!quota.reserve(userId, chunk.length, credit)) return fail('Upload exceeds your storage quota');
      reserved += chunk.length;
    });
    stream.on('limit', () => {
      if (!failed) failed = `File is larger than the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`;
    });
    // The client went away or the form broke off mid-file: busboy destroys
    // this stream with an error ('close' follows and cleans up).
    stream.on('error', () => fail('The upload was interrupted'));
    out.on('error', () => fail('Could not store the file'));
    stream.pipe(out);

    const done = new Promise((resolve) => {
      let finished = false;
      stream.on('close', () => {
        if (!out.destroyed) out.end();
        // Wait for the temp file to be closed before removing or moving it.
        if (out.closed) finish();
        else out.once('close', finish);

        function finish() {
          if (finished) return;
          finished = true;
          try {
            if (failed) {
              discard();
              results.push({ name, ok: false, error: failed });
              return;
            }
            const check = validateUpload(tmpPath, name);
            if (!check.ok) {
              discard();
              audit({ userId: req.user.id, username: req.user.username, action: 'upload.blocked', detail: `${name}: ${check.reason}`, ip: req.ip });
              results.push({ name, ok: false, error: check.reason });
              return;
            }
            const existing = lstatOrNull(dest);
            if (!overwrite && existing) {
              discard();
              results.push({ name, ok: false, error: 'A file with this name already exists' });
              return;
            }
            const replacedSize = existing && existing.isFile() ? existing.size : 0;
            moveIntoPlace(tmpPath, dest);
            addUsedBytes(req.user.id, written - replacedSize);
            const rel = relDisplay(root, dest);
            db.prepare('INSERT INTO files (user_id, relpath, size, mime, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(req.user.id, rel, written, check.mime, Date.now());
            audit({ userId: req.user.id, username: req.user.username, action: 'upload', detail: `${rel} (${written} bytes)`, ip: req.ip });
            results.push({ name, ok: true, size: written, mime: check.mime });
          } catch (err) {
            discard();
            results.push({ name, ok: false, error: 'Could not store the file' });
            console.error('[upload]', err);
          } finally {
            // After addUsedBytes on success, so the bytes are never uncounted.
            quota.release(userId, reserved);
            reserved = 0;
            resolve();
          }
        }
      });
    });
    pending.push(done);
  });

  busboy.on('close', async () => {
    await Promise.all(pending);
    if (results.some((r) => r.ok)) usage.markDirty(userId);
    const fresh = getUserById(userId) || req.user;
    answer(200, { results, usedBytes: fresh.used_bytes, quotaBytes: fresh.quota_bytes });
  });
  busboy.on('error', () => answer(400, { error: 'Upload stream failed. Try again.' }));
  // A client that disconnects mid-upload never finishes the form, so busboy
  // would wait forever with the file half written and its quota reserved.
  // Destroying it ends the open file stream, which runs the cleanup above.
  res.on('close', () => {
    if (!res.writableFinished) busboy.destroy(new Error('Client went away'));
  });
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
  if (req.query.check === '1') return res.json({ ok: true }); // the page asks first (locked folders)
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
  if (!t.readOnly) locks.assertInsideOpen(req, t.rel); // the zip would include locked folders inside it
  if (req.query.check === '1') return res.json({ ok: true });
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
  // The walk lstat()s and never descends into a linked folder, but archiver
  // would still store each symlink as a zip link entry: that leaks where it
  // points (e.g. /home/...) and recreates the link wherever the zip is
  // unpacked. Symlinks are left out, like the listing leaves them out.
  // Repo zips also leave out .git internals, matching what the listing shows.
  archive.directory(t.abs, name, (entry) => {
    if (entry.stats && entry.stats.isSymbolicLink()) return false;
    if (t.readOnly && entry.name.split('/').includes('.git')) return false;
    return entry;
  });
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
  // Grid thumbnails load many previews at once; only a real open is audited.
  if (req.query.thumb !== '1') audit({ userId: req.user.id, username: req.user.username, action: 'preview', detail: displayPath(t), ip: req.ip });
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
  const t = resolveTarget(req, rel, { followLeaf: false });
  if (t.readOnly) return readOnlyError(res);
  if (t.abs === path.resolve(t.root)) return res.status(400).json({ error: 'Cannot rename the root folder' });
  let exists = true;
  try { fs.lstatSync(t.abs); } catch { exists = false; } // lstat: a dangling link is still renamable
  if (!exists) return res.status(404).json({ error: 'File not found' });
  locks.assertRenamable(req, t.rel);
  const cleanName = validateName(newName);
  assertNotReserved(path.dirname(t.abs), t.root, cleanName);
  const dest = path.join(path.dirname(t.abs), cleanName);
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A file with the new name already exists' });
  fs.renameSync(t.abs, dest);
  audit({ userId: req.user.id, username: req.user.username, action: 'rename', detail: `${relDisplay(t.root, t.abs)} -> ${cleanName}`, ip: req.ip });
  res.json({ ok: true });
});

// POST /api/files/delete {paths: ["/a.txt", "/docs"]}
router.post('/delete', async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) {
    return res.status(400).json({ error: 'Send between 1 and 200 paths' });
  }
  const results = [];
  let freed = 0;
  for (const rel of paths) {
    try {
      const t = resolveTarget(req, rel, { followLeaf: false });
      if (t.readOnly) throw new PathError('Repos are read-only here');
      if (t.abs === path.resolve(t.root)) throw new PathError('Cannot delete the root folder');
      locks.assertInsideOpen(req, t.rel);
      const stat = fs.lstatSync(t.abs);
      // A big folder takes a while to count and remove; both run without
      // blocking the server. rm removes a symlink itself (never its target),
      // and links aren't counted in used_bytes, so removing one frees nothing.
      const size = stat.isDirectory() ? await usage.sizeOf(t.abs) : stat.isFile() ? stat.size : 0;
      await fs.promises.rm(t.abs, { recursive: true, force: false });
      freed += size;
      audit({ userId: req.user.id, username: req.user.username, action: 'delete', detail: `${relDisplay(t.root, t.abs)} (${size} bytes)`, ip: req.ip });
      results.push({ path: rel, ok: true });
    } catch (err) {
      results.push({ path: String(rel).slice(0, 200), ok: false, error: err.code === 'ENOENT' ? 'Not found' : (err.message || 'Delete failed'), ...(err.locked ? { locked: err.locked } : {}) });
    }
  }
  if (freed > 0) addUsedBytes(req.user.id, -freed);
  if (results.some((r) => r.ok)) usage.markDirty(req.user.id);
  res.json({ results });
});

// ---- Locked folders (see src/util/locks.js) ----

const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const body = (req) => req.body || {};

// The folder a lock request is about, in the user's own storage.
function lockTarget(req, { mustExist = false } = {}) {
  const t = resolveTarget(req, body(req).path, { lockCheck: false });
  if (t.readOnly) throw new PathError('Repos are never locked');
  if (mustExist) {
    let stat;
    try { stat = fs.statSync(t.abs); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) throw new PathError('Folder not found');
  }
  return t;
}

// POST /api/files/lock {path, password}: put a password on a folder
router.post('/lock', wrap((req, res) => {
  const t = lockTarget(req, { mustExist: true });
  res.json({ ok: true, ...locks.createLock(req, t.rel, body(req).password) });
}));

// POST /api/files/unlock {path, password}: open a locked folder for this session
router.post('/unlock', wrap(async (req, res) => {
  const t = lockTarget(req);
  res.json({ ok: true, ...(await locks.unlock(req, t.rel, body(req).password)) });
}));

// POST /api/files/relock {path}: close it again now
router.post('/relock', wrap((req, res) => {
  const t = lockTarget(req);
  res.json({ ok: true, ...locks.relock(req, t.rel) });
}));

// POST /api/files/unlock-remove {path, password}: take the password off
router.post('/unlock-remove', wrap(async (req, res) => {
  const t = lockTarget(req);
  res.json({ ok: true, ...(await locks.removeLock(req, t.rel, body(req).password)) });
}));

// Error handler local to file routes: surface PathError and lock messages, hide the rest.
router.use((err, req, res, next) => {
  if (err instanceof PathError) return res.status(err.status).json({ error: err.message });
  if (err instanceof locks.LockedError) return res.status(423).json({ error: err.message, locked: err.locked });
  if (err instanceof locks.LockRequestError) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
