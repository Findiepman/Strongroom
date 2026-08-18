'use strict';
const path = require('path');
const fs = require('fs');

class PathError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Resolve a client-supplied relative path against a root directory and refuse
// anything that escapes it. This is the only way file paths may be built.
function safeResolve(root, relPath) {
  const raw = String(relPath == null ? '' : relPath);
  if (raw.includes('\0')) throw new PathError('Path contains a null byte');
  const cleaned = raw.replace(/\\/g, '/');
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, './' + cleaned.replace(/^\/+/, ''));
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new PathError('Path escapes your storage root');
  }
  return resolved;
}

// A single path segment (file or folder name): no separators, no traversal,
// no control characters, sane length.
function validateName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new PathError('Name is empty');
  if (n.length > 200) throw new PathError('Name is longer than 200 characters');
  if (n === '.' || n === '..') throw new PathError('Name is not allowed');
  if (/[/\\\0]/.test(n)) throw new PathError('Name must not contain slashes');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"|?*]/.test(n)) throw new PathError('Name contains characters that are not allowed');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(n)) throw new PathError('Name is reserved by the OS');
  return n;
}

// Relative posix-style path of `abs` inside `root`, for display and APIs.
function relDisplay(root, abs) {
  const rel = path.relative(path.resolve(root), abs);
  return rel === '' ? '/' : '/' + rel.split(path.sep).join('/');
}

// Total size in bytes of all files under dir (follows nothing, skips symlinks).
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // file vanished mid-walk; skip
    }
  }
  return total;
}

module.exports = { safeResolve, validateName, relDisplay, dirSize, PathError };
