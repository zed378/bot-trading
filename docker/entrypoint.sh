#!/bin/sh
set -eu
umask 077
if [ ! -f .env ]; then : > .env; fi
if [ -n "${CODEX_AUTH_FILE:-}" ] && [ -f "$CODEX_AUTH_FILE" ] && [ -n "${CODEX_HOME:-}" ]; then
  mkdir -p "$CODEX_HOME"
  chmod 700 "$CODEX_HOME"
  cp "$CODEX_AUTH_FILE" "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
fi
exec "$@"
