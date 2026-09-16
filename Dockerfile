# MajidBridge — ایمیج داکر (Chromium + Node آماده، بدون دسکتاپ)
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    VIEWPORT_W=1280 \
    VIEWPORT_H=800 \
    QUALITY=medium \
    START_URL=https://example.com

EXPOSE 3000

CMD ["node", "server.js"]
