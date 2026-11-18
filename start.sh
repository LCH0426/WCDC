#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if [ ! -x target/release/wcdc-server ] && [ ! -x target/debug/wcdc-server ]; then
  echo "Backend binary not found. Build it first with:"
  echo "    cargo build -p wcdc-server"
  exit 1
fi

if [ ! -f web/dist/index.html ]; then
  echo "Frontend dist not found. Build it first with:"
  echo "    cd web && npm install && npm run build"
  exit 1
fi

echo
echo "============================================"
echo "  WCDC  http://127.0.0.1:8787"
echo "  Press Ctrl+C to stop"
echo "============================================"
echo

if [ -x target/release/wcdc-server ]; then
  exec target/release/wcdc-server
else
  exec target/debug/wcdc-server
fi
