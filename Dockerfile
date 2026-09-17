# MajidBridge v2 — ایمیج داکر (Chromium + Node + Xvfb برای حالت HEADFUL)
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Xvfb و فونت‌ها (فارسی/عربی هم پوشش داده شود) — فقط برای حالت HEADFUL لازم است
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      dbus-x11 \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
      fonts-vazirmatn \
      fonts-dejavu \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libasound2 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .
RUN chmod +x scripts/entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    VIEWPORT_W=1280 \
    VIEWPORT_H=800 \
    QUALITY=medium \
    ZOOM=1 \
    HEADFUL=false \
    PROFILE_DIR=/data/profile \
    START_URL=https://example.com

# پروفایل ماندگار مرورگر (لاگین‌ها/کوکی‌ها) اینجا ذخیره می‌شود
VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
