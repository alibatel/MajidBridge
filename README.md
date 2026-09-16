# 🌉 MajidBridge — مرورگر ابری شخصی

یک مرورگر Chromium واقعی روی سرور (بدون هیچ دسکتاپی) که از داخل مرورگر خودت می‌بینی و کنترلش می‌کنی: آدرس بزن، کلیک کن، تایپ کن (فارسی هم)، اسکرول کن. همه‌ی سایت‌ها **IP سرور** را می‌بینند، نه IP تو را.

## 🚀 اجرای سریع

### روی hostim (پیشنهادی)
1. این ریپو را به hostim بده (Deploy from Git) — خودش از `Dockerfile` می‌سازد.
2. متغیر محیطی `PASSWORD` را ست کن (رمز ورود — خیلی مهم چون آدرس عمومی است).
3. Deploy کن و آدرسی که داد (مثل `xxx.hostim.dev`) را در مرورگرت باز کن.

| متغیر | لازم؟ | پیش‌فرض | توضیح |
|---|---|---|---|
| `PASSWORD` | ✅ بله | خالی | رمز ورود به مرورگر ابری |
| `QUALITY` | نه | `medium` | کیفیت تصویر: `low` / `medium` / `high` |
| `START_URL` | نه | `https://example.com` | صفحه‌ی شروع |
| `VIEWPORT_W` / `VIEWPORT_H` | نه | `1280` / `800` | اندازه صفحه سرور |

حداقل رم: حدود **۱ گیگ** (Chromium کمی سنگین است).

### روی کامپیوتر خودت (تست)
```bash
docker compose up --build
# بعد باز کن: http://localhost:3000
```

### بدون داکر
```bash
npm install
npx playwright install --with-deps chromium
PASSWORD=mypass node server.js
```

## 🧪 تست خودکار
```bash
ALLOW_EVAL=true PASSWORD=testpass node server.js  # ترمینال ۱
PASSWORD=testpass npm test                          # ترمینال ۲
```
روی سیستمی که Chromium ندارد (تست پروتکل/رابط با مرورگر مجازی):
```bash
MOCK_BROWSER=true ALLOW_EVAL=true PASSWORD=testpass node server.js  # ترمینال ۱
PASSWORD=testpass npm test                                            # ترمینال ۲
```

## ⚙️ معماری (خلاصه)
- `Node.js` + `Playwright` + `Chromium Headless` + `WebSocket` + `Express`
- تصویر زنده: **CDP Screencast** (فقط وقتی صفحه عوض شود فریم JPEG می‌فرستد → مصرف کم وقتی داری متن می‌خوانی) با حالت جایگزین اسکرین‌شات دوره‌ای.
- ورودی: مختصات موس روی عکس به مختصات واقعی سرور تبدیل و با Playwright اجرا می‌شود؛ تایپ با `keyboard.type` (پشتیبانی کامل فارسی).
- تک‌پورت (پیش‌فرض `3000`) و تک‌کانتینر — مناسب PaaS مثل hostim. بدون Xvfb/VNC/دسکتاپ.

## ⚠️ محدودیت‌ها
- فیلم روان و صدا ندارد (عکس پشت سر هم است) — برای وب‌گردی عادی عالی است.
- کمی تأخیر (~نیم ثانیه) دارد.
- تک‌کاربره است (همه‌ی وصل‌شونده‌ها همان یک صفحه را می‌بینند).
