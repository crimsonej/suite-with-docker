#!/bin/sh
set -e

# Running as root: make sure the writable state dirs (which may be freshly
# mounted, root-owned volumes) belong to `node`, then drop privileges.
if [ "$(id -u)" = "0" ]; then
    for dir in /app/session_auth /app/media ${DATA_DIR:+"$DATA_DIR"}; do
        mkdir -p "$dir"
        chown -R node:node "$dir"
    done
    exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node "$@"
fi

exec "$@"
