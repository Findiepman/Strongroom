'use strict';
// Storage helpers shared by the web upload routes and the SFTP server, so both
// paths into STORAGE_ROOT follow the same rules.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PathError } = require('./paths');

// "repos" is reserved at the top level of user storage so a real file or
// folder can never shadow the virtual mount.
function assertNotReserved(destDir, root, name) {
  if (path.resolve(destDir) === path.resolve(root) && String(name).toLowerCase() === 'repos') {
    throw new PathError('The name "repos" is reserved at the top level');
  }
}

// Uploads stage in TMP_DIR and are renamed into place. When storage lives on
// another disk (a NAS mount) and TMP_DIR doesn't, rename fails with EXDEV:
// fall back to copy + delete. Set TMP_DIR on the same mount to keep it atomic.
function moveIntoPlace(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const part = to + '.' + crypto.randomBytes(4).toString('hex') + '.part';
    try {
      fs.copyFileSync(from, part);
      fs.renameSync(part, to); // same disk now, so the final swap is still atomic
    } finally {
      fs.rmSync(part, { force: true });
      fs.rmSync(from, { force: true });
    }
  }
}

module.exports = { assertNotReserved, moveIntoPlace };
