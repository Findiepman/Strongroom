'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Server, utils } = require('ssh2');
const { STATUS_CODE, flagsToString } = utils.sftp;
const config = require('./config');
const { audit, getUserByUsername } = require('./db');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.BCRYPT_COST);

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

// Map a client-supplied virtual path into the user's jail. ".." can never
// climb above "/", which is the jail root.
function resolveVirtual(jail, virtualPath) {
  const norm = path.posix.normalize('/' + String(virtualPath || '').replace(/\\/g, '/'));
  const parts = [];
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  if (parts.some((p) => p.includes('\0'))) throw new Error('bad path');
  const abs = path.join(jail, ...parts);
  if (abs !== jail && !abs.startsWith(jail + path.sep)) throw new Error('escape');
  return { abs, virtual: '/' + parts.join('/') };
}

function statusFor(err) {
  if (!err) return STATUS_CODE.OK;
  if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM' || err.message === 'escape') return STATUS_CODE.PERMISSION_DENIED;
  if (err.code === 'EEXIST') return STATUS_CODE.FAILURE;
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

function startSftpServer() {
  if (!config.SFTP_ENABLED) {
    console.log('[sftp] disabled (SFTP_ENABLED=false)');
    return null;
  }

  const server = new Server({ hostKeys: [loadHostKey()] }, (client, info) => {
    let username = null;
    let jail = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      const user = getUserByUsername(ctx.username);
      bcrypt.compare(ctx.password, user ? user.password_hash : DUMMY_HASH).then((ok) => {
        if (ok && user) {
          username = user.username;
          jail = path.join(config.SFTP_ROOT, username);
          fs.mkdirSync(jail, { recursive: true });
          audit({ userId: user.id, username, action: 'sftp.login', ip: info.ip });
          ctx.accept();
        } else {
          audit({ action: 'sftp.login.fail', detail: `username=${String(ctx.username).slice(0, 40)}`, ip: info.ip });
          ctx.reject(['password']);
        }
      }).catch(() => ctx.reject(['password']));
    });

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

          const fail = (reqid, err) => sftp.status(reqid, statusFor(err));

          sftp.on('REALPATH', (reqid, given) => {
            try {
              const { abs, virtual } = resolveVirtual(jail, given);
              let stat;
              try { stat = fs.statSync(abs); } catch { stat = null; }
              sftp.name(reqid, [{
                filename: virtual,
                longname: stat ? longname(virtual, stat, username) : virtual,
                attrs: stat ? toAttrs(stat) : {},
              }]);
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('STAT', (reqid, given) => {
            try {
              const { abs } = resolveVirtual(jail, given);
              fs.stat(abs, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('LSTAT', (reqid, given) => {
            try {
              const { abs } = resolveVirtual(jail, given);
              fs.lstat(abs, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('FSTAT', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.fstat(h.fd, (err, stat) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(stat))));
          });

          sftp.on('OPEN', (reqid, given, flags) => {
            try {
              const { abs, virtual } = resolveVirtual(jail, given);
              const flagStr = flagsToString(flags) || 'r';
              fs.open(abs, flagStr, 0o644, (err, fd) => {
                if (err) return fail(reqid, err);
                if (/w|a|\+/.test(flagStr)) {
                  audit({ username, action: 'sftp.upload', detail: virtual });
                }
                sftp.handle(reqid, makeHandle({ type: 'file', fd }));
              });
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('READ', (reqid, handleBuf, offset, length) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(Math.min(length, 1024 * 1024));
            fs.read(h.fd, buf, 0, buf.length, offset, (err, bytesRead) => {
              if (err) return fail(reqid, err);
              if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.subarray(0, bytesRead));
            });
          });

          sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.write(h.fd, data, 0, data.length, offset, (err) => {
              if (err) return fail(reqid, err);
              sftp.status(reqid, STATUS_CODE.OK);
            });
          });

          sftp.on('CLOSE', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            dropHandle(handleBuf);
            if (h.type === 'file') {
              fs.close(h.fd, () => sftp.status(reqid, STATUS_CODE.OK));
            } else {
              sftp.status(reqid, STATUS_CODE.OK);
            }
          });

          sftp.on('OPENDIR', (reqid, given) => {
            try {
              const { abs } = resolveVirtual(jail, given);
              fs.stat(abs, (err, stat) => {
                if (err) return fail(reqid, err);
                if (!stat.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.handle(reqid, makeHandle({ type: 'dir', path: abs, done: false }));
              });
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('READDIR', (reqid, handleBuf) => {
            const h = getHandle(handleBuf);
            if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
            h.done = true;
            fs.readdir(h.path, { withFileTypes: true }, (err, entries) => {
              if (err) return fail(reqid, err);
              const names = [];
              for (const e of entries) {
                try {
                  const stat = fs.statSync(path.join(h.path, e.name));
                  names.push({ filename: e.name, longname: longname(e.name, stat, username), attrs: toAttrs(stat) });
                } catch { /* entry vanished; skip */ }
              }
              sftp.name(reqid, names);
            });
          });

          sftp.on('MKDIR', (reqid, given) => {
            try {
              const { abs } = resolveVirtual(jail, given);
              fs.mkdir(abs, (err) => sftp.status(reqid, statusFor(err)));
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('RMDIR', (reqid, given) => {
            try {
              const { abs } = resolveVirtual(jail, given);
              if (abs === jail) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
              fs.rmdir(abs, (err) => sftp.status(reqid, statusFor(err)));
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('REMOVE', (reqid, given) => {
            try {
              const { abs, virtual } = resolveVirtual(jail, given);
              fs.unlink(abs, (err) => {
                if (!err) audit({ username, action: 'sftp.delete', detail: virtual });
                sftp.status(reqid, statusFor(err));
              });
            } catch (err) { fail(reqid, err); }
          });

          sftp.on('RENAME', (reqid, fromGiven, toGiven) => {
            try {
              const { abs: from } = resolveVirtual(jail, fromGiven);
              const { abs: to } = resolveVirtual(jail, toGiven);
              fs.rename(from, to, (err) => sftp.status(reqid, statusFor(err)));
            } catch (err) { fail(reqid, err); }
          });

          // Accept permission/time changes silently: the jail owns real modes.
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

          sftp.on('end', () => {
            for (const h of handles.values()) {
              if (h.type === 'file') fs.close(h.fd, () => {});
            }
            handles.clear();
          });
        });
      });
    });

    client.on('error', () => { /* connection reset etc.; nothing to do */ });
  });

  server.listen(config.SFTP_PORT, config.SFTP_HOST, () => {
    console.log(`[sftp] listening on ${config.SFTP_HOST}:${config.SFTP_PORT} (users jailed to ${config.SFTP_ROOT}${path.sep}<username>)`);
  });
  server.on('error', (err) => console.error('[sftp] server error:', err.message));
  return server;
}

module.exports = { startSftpServer };
