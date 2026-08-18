'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return String(v).toLowerCase() === 'true';
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const config = {
  ROOT,
  DATA_DIR,
  PORT: int(process.env.PORT, 8080),
  HOST: process.env.HOST || '0.0.0.0',

  STORAGE_ROOT: path.resolve(process.env.STORAGE_ROOT || path.join(DATA_DIR, 'storage')),
  SFTP_ROOT: path.resolve(process.env.SFTP_ROOT || path.join(DATA_DIR, 'sftp')),
  REPOS_ROOT: path.resolve(process.env.REPOS_ROOT || path.join(DATA_DIR, 'repos')),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),

  COOKIE_NAME: 'strongroom_session',
  COOKIE_SECURE: bool(process.env.COOKIE_SECURE, true),
  SESSION_TTL_MS: int(process.env.SESSION_TTL_HOURS, 12) * 3600 * 1000,

  BCRYPT_COST: 12,
  MIN_PASSWORD_LENGTH: 10,

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',

  MAX_UPLOAD_BYTES: int(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
  DEFAULT_QUOTA_BYTES: int(process.env.DEFAULT_QUOTA_BYTES, 10 * 1024 * 1024 * 1024),

  SFTP_ENABLED: bool(process.env.SFTP_ENABLED, true),
  SFTP_PORT: int(process.env.SFTP_PORT, 2222),
  SFTP_HOST: process.env.SFTP_HOST || process.env.HOST || '0.0.0.0',
  SFTP_PUBLIC_HOST: process.env.SFTP_PUBLIC_HOST || '',

  GIT_ALLOW_ANY_HTTPS_HOST: bool(process.env.GIT_ALLOW_ANY_HTTPS_HOST, false),
  GIT_TIMEOUT_MS: int(process.env.GIT_TIMEOUT_SECONDS, 300) * 1000,

  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  IS_PROD: process.env.NODE_ENV === 'production',
};

for (const dir of [config.DATA_DIR, config.STORAGE_ROOT, config.SFTP_ROOT, config.REPOS_ROOT, config.TMP_DIR, config.LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// JWT secret: required in production; generated and persisted for dev so
// sessions survive restarts.
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (config.IS_PROD) {
    console.error('JWT_SECRET is required in production. Set it in .env and restart.');
    process.exit(1);
  }
  const secretFile = path.join(config.DATA_DIR, '.jwt-secret');
  if (fs.existsSync(secretFile)) {
    jwtSecret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    jwtSecret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(secretFile, jwtSecret, { mode: 0o600 });
    console.log('[strongroom] generated dev JWT secret at', secretFile);
  }
}
config.JWT_SECRET = jwtSecret;

module.exports = config;
