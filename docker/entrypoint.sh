#!/bin/sh
set -e
# Started as root: make sure /data belongs to the unprivileged "node" user
# (a host folder mounted at /data is usually owned by root), then drop to it.
# Only the top folder is checked so a large library isn't re-chowned on every start.
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /data)" != "$(id -u node)" ]; then
    chown -R node:node /data 2>/dev/null || echo "[strongroom] could not chown /data; make it writable for uid $(id -u node)"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
