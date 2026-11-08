#!/bin/sh
# Hoshmand Photo Studio — start the local server on Linux.
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1; then exec node server/serve.mjs "$@"
elif command -v python3 >/dev/null 2>&1; then exec python3 server/serve.py "$@"
else echo "Node.js یا Python 3 لازم است. یا index.html را مستقیم باز کنید (بدون هوش مصنوعی)."; fi
