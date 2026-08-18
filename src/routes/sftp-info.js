'use strict';
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/sftp/info — connection details for the signed-in user
router.get('/info', requireAuth, (req, res) => {
  const host = config.SFTP_PUBLIC_HOST || req.hostname;
  res.json({
    enabled: config.SFTP_ENABLED,
    host,
    port: config.SFTP_PORT,
    username: req.user.username,
    // Virtual path: every user lands in their own jail and cannot leave it.
    root: '/',
    serverPath: `${config.SFTP_ROOT.replace(/\\/g, '/')}/${req.user.username}/`,
  });
});

module.exports = router;
