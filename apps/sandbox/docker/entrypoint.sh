#!/usr/bin/env bash
# Starts Xvfb on $DISPLAY, then hands over to the daemon (tini is PID 1).
set -euo pipefail

display="${DISPLAY:-:99}"
num="${display#:}"
num="${num%%.*}"

rm -f "/tmp/.X${num}-lock" "/tmp/.X11-unix/X${num}" 2>/dev/null || true
Xvfb "$display" -screen 0 "${XVFB_SCREEN:-1280x800x24}" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &

for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${num}" ] && break
  sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${num}" ]; then
  echo "[sandbox] Xvfb did not start; see /tmp/xvfb.log" >&2
  cat /tmp/xvfb.log >&2 || true
fi

cd /app/apps/sandbox
exec node src/index.ts
