#!/bin/sh
set -eu
umask 077
if [ ! -f .env ]; then : > .env; fi
exec "$@"
