'use strict';
const fs = require('fs');

// Server-side content sniffing. We read the first bytes of the actual file and
// classify by magic numbers, never by the client-supplied extension alone.

const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty zip
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  { mime: 'application/x-7z-compressed', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/x-rar-compressed', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'application/x-bzip2', bytes: [0x42, 0x5a, 0x68] },
  { mime: 'application/x-xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] }, // ID3
  { mime: 'application/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'image/x-icon', bytes: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'application/x-sqlite3', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
  // Executable formats (blocked by default)
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a], executable: true }, // MZ (PE .exe/.dll)
  { mime: 'application/x-elf', bytes: [0x7f, 0x45, 0x4c, 0x46], executable: true },
  { mime: 'application/x-mach-binary', bytes: [0xfe, 0xed, 0xfa, 0xce], executable: true },
  { mime: 'application/x-mach-binary', bytes: [0xfe, 0xed, 0xfa, 0xcf], executable: true },
  { mime: 'application/x-mach-binary', bytes: [0xcf, 0xfa, 0xed, 0xfe], executable: true },
  { mime: 'application/x-mach-binary', bytes: [0xca, 0xfe, 0xba, 0xbe], executable: true },
];

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/plain',
  json: 'text/plain', js: 'text/plain', ts: 'text/plain', css: 'text/plain',
  html: 'text/plain', htm: 'text/plain', xml: 'text/plain', yml: 'text/plain',
  yaml: 'text/plain', ini: 'text/plain', conf: 'text/plain', sh: 'text/plain',
  py: 'text/plain', rb: 'text/plain', go: 'text/plain', rs: 'text/plain',
  c: 'text/plain', h: 'text/plain', cpp: 'text/plain', java: 'text/plain',
  toml: 'text/plain', env: 'text/plain', sql: 'text/plain',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'application/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/x-rar-compressed',
};

function matches(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function sniffBuffer(buf) {
  for (const sig of SIGNATURES) {
    if (matches(buf, sig.bytes)) return { mime: sig.mime, executable: !!sig.executable };
  }
  // RIFF container: WAV / WEBP / AVI
  if (matches(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12) {
    const tag = buf.toString('ascii', 8, 12);
    if (tag === 'WAVE') return { mime: 'audio/wav', executable: false };
    if (tag === 'WEBP') return { mime: 'image/webp', executable: false };
    if (tag === 'AVI ') return { mime: 'video/x-msvideo', executable: false };
  }
  // ISO media container (mp4/mov): "ftyp" at offset 4
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return { mime: 'video/mp4', executable: false };
  }
  // Matroska / WebM
  if (matches(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', executable: false };
  // Shell/script with shebang counts as text, not an executable binary
  // Text heuristic: no null bytes, mostly printable
  const sample = buf.subarray(0, Math.min(buf.length, 1024));
  if (sample.length === 0) return { mime: 'application/x-empty', executable: false };
  let printable = 0;
  for (const b of sample) {
    if (b === 0) return { mime: 'application/octet-stream', executable: false };
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  if (printable / sample.length > 0.95) return { mime: 'text/plain', executable: false };
  return { mime: 'application/octet-stream', executable: false };
}

function sniffFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4100);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return sniffBuffer(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

// Policy: executables are rejected outright, and a file whose extension claims
// image/pdf must actually be one (stops e.g. an .exe renamed to .png).
const STRICT_EXT_FAMILIES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', pdf: 'application/pdf',
};

function validateUpload(filePath, originalName) {
  const sniff = sniffFile(filePath);
  if (sniff.executable) {
    return { ok: false, mime: sniff.mime, reason: 'Executable files are not allowed' };
  }
  const ext = extOf(originalName);
  const expected = STRICT_EXT_FAMILIES[ext];
  if (expected && sniff.mime !== expected) {
    return {
      ok: false,
      mime: sniff.mime,
      reason: `Content does not match .${ext} (detected ${sniff.mime})`,
    };
  }
  return { ok: true, mime: sniff.mime };
}

// Preview classification for the browser: only ever serves image/pdf/text.
function previewType(filePath, name) {
  const sniff = sniffFile(filePath);
  if (sniff.mime.startsWith('image/') && sniff.mime !== 'image/svg+xml') {
    return { kind: 'image', contentType: sniff.mime };
  }
  if (sniff.mime === 'application/pdf') return { kind: 'pdf', contentType: 'application/pdf' };
  if (sniff.mime === 'text/plain' || sniff.mime === 'application/x-empty') {
    // Always serve as text/plain so HTML/SVG can never execute in-origin.
    return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  }
  return null;
}

function guessMime(name) {
  return EXT_MIME[extOf(name)] || 'application/octet-stream';
}

module.exports = { sniffFile, sniffBuffer, validateUpload, previewType, guessMime };
