# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately
through GitHub: **Security** tab → **Report a vulnerability**
(<https://github.com/Findiepman/Strongroom/security/advisories/new>).

Include what you found, how to reproduce it and which version or commit you
tested. You can expect a first reply within a week. Once a fix is released the
advisory is published, with credit if you want it.

## Supported versions

Fixes go into the latest release. Please update before reporting.

## Scope

In scope: the web app, its API, the SFTP server, the GitHub puller and the
Docker image. Out of scope: problems that need an already compromised server
or admin account, and missing hardening of your own reverse proxy or host.

Note that files are stored unencrypted on disk by design; see the
[Security section of the README](README.md#security).
