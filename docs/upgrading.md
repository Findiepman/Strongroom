# Upgrading: SFTP now shares web storage

Older versions kept SFTP files in a separate tree, `SFTP_ROOT/<user>`. SFTP
now serves `STORAGE_ROOT/<user>` instead, so anything still in the old tree
is no longer visible over SFTP. To keep it, stop Strongroom and move it into
the web folder by hand, checking for name clashes first, e.g.
`sudo rsync -a --ignore-existing <SFTP_ROOT>/<user>/ <STORAGE_ROOT>/<user>/`,
then start Strongroom again (the quota is recomputed at the next sign-in).
Nothing is moved or deleted automatically. A top-level `repos` folder in the
old tree would not be reachable afterwards (the name is reserved), so rename
it first.

