#!/bin/sh
# MajidBridge v2 — نقطه‌ی ورود کانتینر
# اگر HEADFUL=true باشد، اول Xvfb (نمایش مجازی) روشن می‌شود تا Chromium
# مثل یک مرورگر واقعی «با پنجره» اجرا شود — قوی‌ترین راه رد شدن از
# تیک‌های امنیتی مثل Cloudflare.
set -e

W="${VIEWPORT_W:-1280}"
H="${VIEWPORT_H:-800}"
DEPTH="${XVFB_DEPTH:-24}"

if [ "$(echo "$HEADFUL" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
  echo "[entrypoint] HEADFUL=true → راه‌اندازی Xvfb روی ${DISPLAY:-:99} (${W}x${H}x${DEPTH})"
  export DISPLAY="${DISPLAY:-:99}"
  rm -f /tmp/.X99-lock 2>/dev/null || true
  Xvfb "$DISPLAY" -screen 0 "${W}x${H}x${DEPTH}" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  # تا آماده شدن نمایش صبر کن
  i=0
  while [ $i -lt 40 ]; do
    if [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then break; fi
    i=$((i + 1))
    sleep 0.25
  done
  echo "[entrypoint] Xvfb آماده است (pid=$XVFB_PID)"
else
  echo "[entrypoint] حالت headless (برای headful: HEADFUL=true)"
fi

exec node server.js
