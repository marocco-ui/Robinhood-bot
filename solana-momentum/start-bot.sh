#!/bin/bash
# Runs the momentum bot in the foreground. Secrets come from .env files, never from this script.
cd "$(dirname "$0")" || exit 1
exec node src/trader.js "$@"
