#!/bin/sh
set -e
# Started as root: make sure /data belongs to the unprivileged "node" user
# (a host folder mounted at /data is usually owned by root), then drop to it.
# Only /data and its direct children are checked (catches a fresh host folder
# and a restore done as root) so a large library isn't walked on every start.
if [ "$(id -u)" = "0" ]; then
  if [ -n "$(find /data -maxdepth 1 ! -user node -print -quit)" ]; then
    chown -R node:node /data 2>/dev/null || echo "[strongroom] could not chown /data; make it writable for uid $(id -u node)"
  fi
  # setpriv keeps root's HOME; git (GitHub puller) must not look in /root.
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
