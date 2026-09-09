#!/bin/sh
set -eu
if [ "${OAUTH_ENABLED:-0}" = "1" ]; then
  # This exact directory is dedicated to the Railway volume mounted at /data.
  mkdir -p /data/oauth
  chown appuser:appgroup /data/oauth
  chmod 700 /data/oauth
fi
exec su-exec appuser:appgroup "$@"
