'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Server, utils } = require('ssh2');
const { STATUS_CODE, OPEN_MODE } = utils.sftp;
const config = require('./config');
const { db, audit, getUserByUsername, getUserById, addUsedBytes } = require('./db');
const { validateName } = require('./util/paths');
const { validateUpload } = require('./util/filetype');
const { assertNotReserved, moveIntoPlace } = require('./util/storage');
const locks = require('./util/locks');
const usage = require('./util/usage');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.BCRYPT_COST);

// SFTP shares the web app's tree: every user lands in STORAGE_ROOT/<username>,
// so files synced over SFTP (rclone bisync from Explorer) are the same files
// the web UI shows, under the same checks, quota, uploads list and audit log.
function jailFor(username) {
  return path.join(config.STORAGE_ROOT, username);
}

function loadHostKey() {
  const keyPath = path.join(config.DATA_DIR, 'ssh_host_rsa_key');
  if (!fs.existsSync(keyPath)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    console.log('[sftp] generated host key at', keyPath);
  }
  return fs.readFileSync(keyPath);
}

// An error that is sent to the client as the SFTP status message, so rclone
// logs the real reason (e.g. "Executable files are not allowed").
class SftpError extends Error {
  constructor(code, message) {
    super(message);
    this.sftpCode = code;
  }
}
const denied = (msg) => new SftpError(STATUS_CODE.PERMISSION_DENIED, msg);
const failure = (msg) => new SftpError(STATUS_CODE.FAILURE, msg);

const READDIR_PAGE = 100;
const MAX_OPEN_UPLOADS = 32; // per connection
const REFUSED_GUARD_MS = 60 * 1000;

// SQLite substr() counts characters (code points), JS .length counts UTF-16 units.
const sqlLen = (str) => [...str].length;

const isReservedTop = (name) => String(name).toLowerCase() === 'repos';

// Map a client-supplied virtual path into the user's jail. ".." can never
// climb above "/", which is the jail root. "/repos" (the web app's read-only
// mount of the GitHub puller's sandbox) is not part of SFTP at all: any path
// through a top-level "repos" is refused, so a sync tool can never touch it.
// Locked folders (their paths in lockedPaths) are refused the same way: SFTP
// can't ask for a folder password, so they're web-only.
function resolveVirtual(jail, virtualPath, lockedPaths = []) {
  const norm = path.posix.normalize('/' + String(virtualPath || '').replace(/\\/g, '/'));
  const parts = [];
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  if (parts.some((p) => p.includes('\0'))) throw denied('bad path');
  if (parts.length && isReservedTop(parts[0])) throw denied('/repos is not available over SFTP');
  const abs = path.join(jail, ...parts);
  if (abs !== jail && !abs.startsWith(jail + path.sep)) throw denied('escape');
  const virtual = '/' + parts.join('/');
  if (lockedPaths.some((l) => virtual === l || virtual.startsWith(l + '/'))) {
    throw denied('This folder is locked. Open it in the web app.');
  }
  return { abs, virtual };
}

// The web app's naming rules for anything new (file, folder, rename target).
function checkNewName(abs, jail) {
  const name = path.basename(abs);
  try {
    validateName(name);
    assertNotReserved(path.dirname(abs), jail, name);
  } catch (err) {
    throw failure(err.message);
  }
  return name;
}

function statusFor(err) {
  if (!err) return STATUS_CODE.OK;
  if (err.sftpCode !== undefined) return err.sftpCode;
  if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function toAttrs(stat) {
  return {
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function modeString(stat) {
  const isDir = stat.isDirectory();
  const perms = ['r', 'w', 'x', 'r', '-', 'x', 'r', '-', '-'];
  return (isDir ? 'd' : '-') + perms.join('');
}

function longname(name, stat, username) {
  const d = new Date(stat.mtimeMs);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = `${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${modeString(stat)} 1 ${username} ${username} ${String(stat.size).padStart(10)} ${date} ${name}`;
}

// SETSTAT attrs carry times in seconds. Only times are applied; modes and
// owners belong to the server.
function timesFrom(attrs) {
  if (!attrs || typeof attrs.mtime !== 'number') return null;
  return { atime: typeof attrs.atime === 'number' ? attrs.atime : attrs.mtime, mtime: attrs.mtime };
}

const filesRows = {
  insert: db.prepare('INSERT INTO files (user_id, relpath, size, mime, created_at) VALUES (?, ?, ?, ?, ?)'),
  removeExact: db.prepare('DELETE FROM files WHERE user_id = ? AND relpath = ?'),
  removeUnder: db.prepare('DELETE FROM files WHERE user_id = ? AND substr(relpath, 1, ?) = ?'),
  renameExact: db.prepare('UPDATE files SET relpath = ? WHERE user_id = ? AND relpath = ?'),
  renameUnder: db.prepare('UPDATE files SET relpath = ? || substr(relpath, ?) WHERE user_id = ? AND substr(relpath, 1, ?) = ?'),
};

function startSftpServer() {
  if (!config.SFTP_ENABLED) {
    console.log('[sftp] disabled (SFTP_ENABLED=false)');
    return null;
  }

  const server = new Server({ hostKeys: [loadHostKey()] }, (client, info) => {
    let user = null; // { id, username }
    let jail = null;
    const ip = info.ip;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      const row = getUserByUsername(ctx.username);
      bcrypt.compare(ctx.password, row ? row.password_hash : DUMMY_HASH).then((ok) => {
        if (ok && row) {
          user = { id: row.id, username: row.username };
          jail = jailFor(row.username);
          fs.mkdirSync(jail, { recursive: true });
          audit({ userId: user.id, username: user.username, action: 'sftp.login', ip });
          ctx.accept();
        } else {
          audit({ action: 'sftp.login.fail', detail: `username=${String(ctx.username).slice(0, 40)}`, ip });
          ctx.reject(['password']);
        }
      }).catch(() => ctx.reject(['password']));
    });

    const log = (action, detail) => {
      audit({ userId: user.id, username: user.username, action, detail, ip });
      if (/^sftp\.(upload|delete|rename)$/.test(action)) usage.markDirty(user.id); // home screen sizes
    };
    // Looked up on every request, so a folder locked in the web app is closed
    // to an SFTP connection that's already open.
    const lockedPaths = () => locks.locksOf(user.id).map((l) => l.relpath);
    const resolveHere = (given) => resolveVirtual(jail, given, lockedPaths());

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let nextHandle = 1;

          const makeHandle = (entry) => {
            const id = nextHandle++;
            handles.set(id, entry);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const getHandle = (buf) => (buf && buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);
          const dropHandle = (buf) => handles.delete(buf.readUInt32BE(0));

          // Every request handler runs guarded: a bad request from one client
          // must never throw out of the event loop and take the server down.
          const on = (event, fn) => sftp.on(event, (reqid, ...args) => {
            try {
              fn(reqid, ...args);
            } catch (err) {
              console.error(`[sftp] ${event} failed:`, err && err.message);
              try { sftp.status(reqid, STATUS_CODE.FAILURE); } catch { /* channel gone */ }
            }
          });

          // Paths whose upload was just refused on this connection. Some
          // clients (rclone) delete the target after a failed upload; when the
          // upload went to the real name that would destroy the good copy that
          // was kept, so such a REMOVE is refused for a short while.
          const refused = new Map();
          const recentlyRefused = (virtual) => {
            const at = refused.get(virtual);
            return at !== undefined && Date.now() - at < REFUSED_GUARD_MS;
          };

          const fail = (reqid, err) => {
            const code = statusFor(err);
            sftp.status(reqid, code, err && err.sftpCode !== undefined ? err.message : undefined);
          };

          const quotaLeft = () => {
            const row = getUserById(user.id);
            return row ? row.quota_bytes - row.used_bytes : 0;
          };

          on('REALPATH', (reqid, given) => {
            try {
              const { abs, virtual } = resolveHere(given);
              let stat;
              try { stat = fs.statSync(abs); } catch { stat = null; }
              sftp.name(reqid, [{
                filename: virtual,
                longname: stat ? longname(virtual, stat, user.username) : virtual,
                attrs: stat ? toAttrs(stat) : {},
              }]);
            } catch (err) { fail(reqid, err); }
          });

          on('STAT', (reqid, given) => {
            try {
              const { abs } = resolveHere(given);
              fs.stat(abs, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
            } catch (err) { fail(reqid, err); }
          });

          on('LSTAT', (reqid, given) => {
            try {
              const { abs } = resolveHere(given);
              fs.lstat(abs, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
            } catch (err) { fail(reqid, err); }
          });

          on('FSTAT', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h || h.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.fstat(h.fd, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
          });

          on('OPEN', (reqid, given, flags) => {
            try {
              const { abs, virtual } = resolveHere(given);
              const writing = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0;
              if (!writing) {
                fs.open(abs, 'r', (err, fd) => {
                  if (err) return fail(reqid, err);
                  sftp.handle(reqid, makeHandle({ type: 'file', fd, abs }));
                });
                return;
              }

              // Uploads: same rules as the web upload. Writes go to a staging
              // file in TMP_DIR; the real file only changes on a good CLOSE.
              if (abs === jail) throw failure('Not a file');
              let openUploads = 0;
              for (const x of handles.values()) if (x.type === 'upload') openUploads++;
              if (openUploads >= MAX_OPEN_UPLOADS) throw failure('Too many uploads at once on this connection');
              const name = checkNewName(abs, jail);
              let existing = null;
              try { existing = fs.statSync(abs); } catch (err) { if (err.code !== 'ENOENT') throw err; }
              if (existing && !existing.isFile()) throw failure('A folder with this name already exists');
              if (existing && (flags & OPEN_MODE.EXCL)) throw failure('A file with this name already exists');
              if (!existing && !(flags & OPEN_MODE.CREAT)) throw new SftpError(STATUS_CODE.NO_SUCH_FILE, 'No such file');
              if (!fs.statSync(path.dirname(abs)).isDirectory()) throw failure('Not a folder');

              const tmp = path.join(config.TMP_DIR, crypto.randomBytes(16).toString('hex') + '.part');
              const keep = existing && !(flags & OPEN_MODE.TRUNC);
              let fd;
              try {
                if (keep) fs.copyFileSync(abs, tmp);
                fd = fs.openSync(tmp, keep ? 'r+' : 'wx+', 0o644);
              } catch (err) {
                fs.rmSync(tmp, { force: true });
                throw err;
              }
              sftp.handle(reqid, makeHandle({
                type: 'upload',
                fd,
                tmp,
                abs,
                virtual,
                name,
                size: keep ? existing.size : 0,
                replacedSize: existing ? existing.size : 0,
                append: (flags & OPEN_MODE.APPEND) !== 0,
                failed: null,
                times: null,
              }));
            } catch (err) { fail(reqid, err); }
          });

          on('READ', (reqid, handleBuf, offset, length) => {
            const h = getHandle(handleBuf);
            if (!h || h.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (!Number.isSafeInteger(offset) || offset < 0) return sftp.status(reqid, STATUS_CODE.EOF);
            const buf = Buffer.alloc(Math.max(0, Math.min(length, 1024 * 1024)));
            fs.read(h.fd, buf, 0, buf.length, offset, (err, bytesRead) => {
              if (err) return fail(reqid, err);
              if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.subarray(0, bytesRead));
            });
          });

          on('WRITE', (reqid, handleBuf, offset, data) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'upload') return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (h.failed) return fail(reqid, failure(h.failed));
            if (!h.append && (!Number.isSafeInteger(offset) || offset < 0)) {
              h.failed = 'Bad write offset';
              return fail(reqid, failure(h.failed));
            }
            const at = h.append ? h.size : offset;
            const newSize = Math.max(h.size, at + data.length);
            if (newSize > config.MAX_UPLOAD_BYTES) {
              h.failed = `File is larger than the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`;
              return fail(reqid, failure(h.failed));
            }
            if (newSize - h.replacedSize > quotaLeft()) {
              h.failed = 'Upload exceeds your storage quota';
              return fail(reqid, failure(h.failed));
            }
            h.size = newSize;
            fs.write(h.fd, data, 0, data.length, at, (err) => {
              if (err) {
                h.failed = h.failed || 'Could not store the file';
                return fail(reqid, err);
              }
              sftp.status(reqid, STATUS_CODE.OK);
            });
          });

          // Finish an upload: content check, quota, move into place, then the
          // same bookkeeping as a web upload (files row + audit entry).
          function commitUpload(h) {
            try {
              if (h.failed) throw failure(h.failed);
              const size = fs.statSync(h.tmp).size;
              const check = validateUpload(h.tmp, h.name);
              if (!check.ok) throw failure(check.reason);
              let replaced = 0;
              try {
                const st = fs.statSync(h.abs);
                if (!st.isFile()) throw failure('A folder with this name already exists');
                replaced = st.size;
              } catch (err) { if (err.code !== 'ENOENT') throw err; }
              if (size - replaced > quotaLeft()) throw failure('Upload exceeds your storage quota');
              moveIntoPlace(h.tmp, h.abs);
              addUsedBytes(user.id, size - replaced);
              filesRows.removeExact.run(user.id, h.virtual); // one row per path, newest wins
              filesRows.insert.run(user.id, h.virtual, size, check.mime, Date.now());
              log('sftp.upload', `${h.virtual} (${size} bytes)`);
              refused.delete(h.virtual);
              if (h.times) {
                try { fs.utimesSync(h.abs, h.times.atime, h.times.mtime); } catch (err) { console.error('[sftp utimes]', err.message); }
              }
              return null;
            } catch (err) {
              fs.rmSync(h.tmp, { force: true });
              const reason = err.sftpCode !== undefined ? err.message : 'Could not store the file';
              if (err.sftpCode === undefined) console.error('[sftp upload]', err);
              log('upload.blocked', `${h.virtual}: ${reason} (sftp)`);
              refused.set(h.virtual, Date.now());
              return failure(reason);
            }
          }

          on('CLOSE', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            dropHandle(handleBuf);
            if (h.type === 'dir') return sftp.status(reqid, STATUS_CODE.OK);
            fs.close(h.fd, (closeErr) => {
              if (h.type !== 'upload') return sftp.status(reqid, STATUS_CODE.OK);
              if (closeErr) h.failed = h.failed || 'Could not store the file';
              const err = commitUpload(h);
              return err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK);
            });
          });

          on('OPENDIR', (reqid, given) => {
            try {
              const { abs } = resolveHere(given);
              fs.stat(abs, (err, stat) => {
                if (err) return fail(reqid, err);
                if (!stat.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.handle(reqid, makeHandle({ type: 'dir', path: abs, entries: null, pos: 0 }));
              });
            } catch (err) { fail(reqid, err); }
          });

          on('READDIR', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            // Big folders are sent in pages: one reply must stay under the
            // client's packet limit (about 256 KB for OpenSSH and rclone).
            const sendPage = () => {
              const names = [];
              const hidden = lockedPaths();
              while (h.pos < h.entries.length && names.length < READDIR_PAGE) {
                const e = h.entries[h.pos++];
                if (h.path === jail && isReservedTop(e.name)) continue; // never list a stray top-level "repos"
                if (hidden.length) {
                  const v = '/' + path.relative(jail, path.join(h.path, e.name)).split(path.sep).join('/');
                  if (hidden.includes(v)) continue; // locked folders are web-only
                }
                try {
                  const stat = fs.statSync(path.join(h.path, e.name));
                  names.push({ filename: e.name, longname: longname(e.name, stat, user.username), attrs: toAttrs(stat) });
                } catch { /* entry vanished; skip */ }
              }
              if (names.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.name(reqid, names);
            };
            if (h.entries) return sendPage();
            fs.readdir(h.path, { withFileTypes: true }, (err, entries) => {
              if (err) return fail(reqid, err);
              h.entries = entries;
              h.pos = 0;
              sendPage();
            });
          });

          on('MKDIR', (reqid, given) => {
            try {
              const { abs, virtual } = resolveHere(given);
              if (abs === jail) throw failure('Already exists');
              checkNewName(abs, jail);
              fs.mkdir(abs, (err) => {
                if (!err) log('sftp.mkdir', virtual);
                fail(reqid, err);
              });
            } catch (err) { fail(reqid, err); }
          });

          on('RMDIR', (reqid, given) => {
            try {
              const { abs, virtual } = resolveHere(given);
              if (abs === jail) throw denied('Cannot delete the root folder');
              fs.rmdir(abs, (err) => {
                if (!err) {
                  filesRows.removeUnder.run(user.id, sqlLen(virtual + '/'), virtual + '/');
                  log('sftp.delete', `${virtual}/ (folder)`);
                }
                fail(reqid, err);
              });
            } catch (err) { fail(reqid, err); }
          });

          on('REMOVE', (reqid, given) => {
            try {
              const { abs, virtual } = resolveHere(given);
              if (recentlyRefused(virtual)) {
                throw failure('Not deleted: the last upload of this file was refused, so the stored copy is kept');
              }
              const st = fs.lstatSync(abs);
              if (st.isDirectory()) throw failure('Is a folder');
              fs.unlinkSync(abs);
              addUsedBytes(user.id, -st.size);
              filesRows.removeExact.run(user.id, virtual);
              log('sftp.delete', `${virtual} (${st.size} bytes)`);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) { fail(reqid, err); }
          });

          on('RENAME', (reqid, fromGiven, toGiven) => {
            try {
              const from = resolveHere(fromGiven);
              const to = resolveHere(toGiven);
              if (from.abs === jail || to.abs === jail) throw denied('Cannot rename the root folder');
              if (locks.inside(locks.locksOf(user.id), from.virtual).length) {
                throw denied('This folder holds a locked folder, so it can\'t be renamed over SFTP');
              }
              const st = fs.statSync(from.abs);
              const newName = checkNewName(to.abs, jail);
              // Replacing an existing file is allowed (POSIX rename): sync tools
              // upload to "name.partial" and rename it over the old version.
              // Folders are never replaced.
              let replaced = null;
              try { replaced = fs.statSync(to.abs); } catch (err) { if (err.code !== 'ENOENT') throw err; }
              if (replaced && replaced.ino === st.ino && replaced.dev === st.dev) replaced = null; // same file (case-only rename)
              if (replaced && (!replaced.isFile() || !st.isFile())) throw failure('A file or folder with the new name already exists');
              // A rename can change what a file claims to be (x.png.partial ->
              // x.png), so a file's content is checked against its new name.
              if (st.isFile() && newName !== path.basename(from.abs)) {
                const check = validateUpload(from.abs, newName);
                if (!check.ok) {
                  log('upload.blocked', `${from.virtual} -> ${to.virtual}: ${check.reason} (sftp)`);
                  throw failure(check.reason);
                }
              }
              fs.renameSync(from.abs, to.abs);
              if (st.isDirectory()) {
                const prefix = from.virtual + '/';
                filesRows.renameUnder.run(to.virtual + '/', sqlLen(prefix) + 1, user.id, sqlLen(prefix), prefix);
              } else {
                if (replaced) {
                  addUsedBytes(user.id, -replaced.size);
                  filesRows.removeExact.run(user.id, to.virtual);
                }
                filesRows.renameExact.run(to.virtual, user.id, from.virtual);
              }
              log('sftp.rename', `${from.virtual} -> ${to.virtual}${replaced ? ' (replaced the old file)' : ''}`);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) { fail(reqid, err); }
          });

          // Times are applied so sync tools (rclone bisync) keep modification
          // times; other attributes are accepted and ignored.
          on('SETSTAT', (reqid, given, attrs) => {
            try {
              const { abs } = resolveHere(given);
              const t = timesFrom(attrs);
              if (!t) { fs.statSync(abs); return sftp.status(reqid, STATUS_CODE.OK); }
              fs.utimes(abs, t.atime, t.mtime, (err) => fail(reqid, err));
            } catch (err) { fail(reqid, err); }
          });

          on('FSETSTAT', (reqid, handleBuf, attrs) => {
            const h = getHandle(handleBuf);
            if (!h || h.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            const t = timesFrom(attrs);
            if (!t) return sftp.status(reqid, STATUS_CODE.OK);
            if (h.type === 'upload') { h.times = t; return sftp.status(reqid, STATUS_CODE.OK); } // applied after commit
            fs.utimes(h.abs, t.atime, t.mtime, (err) => fail(reqid, err));
          });

          // Connection gone: close everything, and throw away unfinished
          // uploads so a broken transfer never lands in storage.
          const cleanup = () => {
            for (const h of handles.values()) {
              if (h.type === 'dir') continue;
              try { fs.closeSync(h.fd); } catch { /* already closed */ }
              if (h.type === 'upload') fs.rmSync(h.tmp, { force: true });
            }
            handles.clear();
          };
          // The client is done (EOF): close our side too. Without this, clients
          // like rclone wait forever for the channel to close and never exit.
          sftp.on('end', () => { cleanup(); try { sftp.end(); } catch { /* already closed */ } });
          sftp.on('close', cleanup);
        });
      });
    });

    client.on('error', () => { /* connection reset etc.; nothing to do */ });
  });

  server.listen(config.SFTP_PORT, config.SFTP_HOST, () => {
    console.log(`[sftp] listening on ${config.SFTP_HOST}:${config.SFTP_PORT} (users jailed to ${config.STORAGE_ROOT}${path.sep}<username>, shared with the web app)`);
  });
  server.on('error', (err) => console.error('[sftp] server error:', err.message));
  return server;
}

module.exports = { startSftpServer, resolveVirtual };
