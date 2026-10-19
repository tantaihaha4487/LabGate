#!/usr/bin/env bash
set -euo pipefail
# Compatibility entrypoint; all removal logic lives in Go.
exec /usr/local/bin/labgate uninstall --role machine "$@"
