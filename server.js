'use strict';
/* ─────────────────────────────────────────────────────────────
 * MajidBridge — مرورگر ابری شخصی | Personal Cloud Browser
 *
 * معماری (بدون هیچ Desktop Environment):
 *   Chromium Headless روی سرور اجرا می‌شود ←
 *   هر تغییر صفحه به‌صورت فریم JPEG زنده برای کاربر فرستاده می‌شود ←
 *   کلیک/تایپ/اسکرول کاربر به Chromium روی سرور برمی‌گردد
 *
 * همه‌ی درخواست‌های اینترنتی سایت مقصد با IP خود سرور انجام می‌شود.
 * مرورگر کاربر هیچ‌وقت مستقیم به سایت مقصد وصل نمی‌شود.
 * ───────────────────────────────────────────────────────────── */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

// ── تنظیمات از روی env ─────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const PASSWORD = process.env.PASSWORD || ''; // اگر خالی = بدون رمز (فقط برای تست محلی!)
const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || '1280', 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || '800', 10);
const START_URL = process.env.START_URL || 'https://example.com';
const ALLOW_EVAL = process.env.ALLOW_EVAL === 'true'; // فقط برای تست خودکار، در محصول false

const QUALITY = { low: 40, medium: 60, high: 80 };
let qualityName = (process.env.QUALITY || 'medium').toLowerCase();
if (!QUALITY[qualityName]) qualityName = 'medium';

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// ── وضعیت سراسری ───────────────────────────────────────────────
let browser = null;
let context = null;
let page = null; // صفحه‌ی فعال (تک‌صفحه‌ای نگه می‌داریم تا سبک بماند)
let cdp = null; // نشست CDP برای پخش زنده
let screencastOn = false;
let fallbackTimer = null;
let wss = null;
let frameCount = 0;
let frameBytes = 0;
const startedAt = Date.now();

// صف ورودی: کلیک/تایپ/اسکرول پشت سر هم اجرا می‌شن تا قاطی نشود
let inputChain = Promise.resolve();
function queueInput(fn) {
  inputChain = inputChain.then(fn).catch((e) => log('[input] خطا:', e.message));
  return inputChain;
}

// ── ابزار پیام‌رسانی ───────────────────────────────────────────
function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {
      /* نادیده */
    }
  }
}

function broadcast(obj) {
  if (!wss) return;
  const s = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.authed) continue;
    try {
      c.send(s);
    } catch (_) {
      /* نادیده */
    }
  }
}

function helloState() {
  return {
    type: 'hello',
    needAuth: !!PASSWORD,
    w: VIEWPORT_W,
    h: VIEWPORT_H,
    quality: qualityName,
    url: page && !page.isClosed() ? page.url() : START_URL,
  };
}

async function broadcastNav() {
  try {
    if (!page || page.isClosed()) return;
    const url = page.url();
    let title = '';
    try {
      title = await page.title();
    } catch (_) {
      /* نادیده */
    }
    broadcast({ type: 'nav', url, title });
  } catch (_) {
    /* نادیده */
  }
}

// ── مدیریت صفحه‌ی Chromium ──────────────────────────────────────
async function ensurePage() {
  if (page && !page.isClosed()) return page;
  const pages = context.pages().filter((p) => !p.isClosed());
  if (pages.length > 0) {
    page = pages[pages.length - 1];
  } else {
    page = await context.newPage();
  }
  attachPageListeners(page);
  await restartScreencast();
  return page;
}

function attachPageListeners(p) {
  if (p.__mbAttached) return;
  p.__mbAttached = true;

  p.on('framenavigated', (frame) => {
    if (page === p && frame === p.mainFrame()) {
      broadcast({ type: 'loading', value: false });
      broadcastNav();
    }
  });
  p.on('load', () => {
    if (page === p) broadcast({ type: 'loading', value: false });
  });
  p.on('crash', async () => {
    log('صفحه کرش کرد؛ صفحه‌ی تازه می‌سازم...');
    try {
      await p.close().catch(() => {});
    } catch (_) {
      /* نادیده */
    }
    if (page === p) page = null;
    await ensurePage().catch(() => {});
    await doNavigate(START_URL).catch(() => {});
  });
  p.once('close', () => {
    if (page === p) {
      page = null;
      setTimeout(() => ensurePage().catch(() => {}), 300);
    }
  });
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return null;
  if (/^(https?:\/\/|data:|about:|file:|chrome:)/i.test(u)) return u;
  return 'https://' + u;
}

async function doNavigate(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  await ensurePage();
  broadcast({ type: 'loading', value: true });
  log('رفتن به:', url.length > 120 ? url.slice(0, 120) + '…' : url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log('خطای باز کردن صفحه:', e.message);
    broadcast({ type: 'error', message: 'باز نشد: ' + e.message });
    broadcast({ type: 'loading', value: false });
  }
  broadcastNav();
}

// ── پخش زنده‌ی تصویر ────────────────────────────────────────────
// روش اصلی: CDP Screencast — خود Chromium فقط وقتی صفحه عوض شود فریم
// می‌فرستد (پس وقتی داری متن می‌خوانی تقریباً مصرف اینترنت صفر است).
async function startScreencast() {
  try {
    await ensurePage();
    if (cdp) {
      try {
        await cdp.send('Page.stopScreencast');
      } catch (_) {
        /* نادیده */
      }
      cdp = null;
    }
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      frameCount++;
      frameBytes += Math.round(data.length * 0.75);
      broadcast({ type: 'frame', data, w: VIEWPORT_W, h: VIEWPORT_H });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: QUALITY[qualityName],
      maxWidth: VIEWPORT_W,
      maxHeight: VIEWPORT_H,
      everyNthFrame: 1,
    });
    screencastOn = true;
    stopFallback();
    log(`پخش زنده روشن شد (کیفیت ${qualityName} = ${QUALITY[qualityName]})`);
    sendFreshScreenshot().catch(() => {}); // فریم اول فوری
  } catch (e) {
    log('screencast نشد، حالت جایگزین (اسکرین‌شات دوره‌ای):', e.message);
    screencastOn = false;
    ensureFallback();
  }
}

async function restartScreencast() {
  screencastOn = false;
  await startScreencast();
}

// حالت جایگزین اگر screencast پشتیبانی نشود
function ensureFallback() {
  if (fallbackTimer) return;
  log('حالت جایگزین: اسکرین‌شات هر ۶۰۰ میلی‌ثانیه');
  fallbackTimer = setInterval(() => {
    sendFreshScreenshot().catch(() => {});
  }, 600);
}

function stopFallback() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

async function sendFreshScreenshot() {
  await ensurePage();
  const buf = await page.screenshot({ type: 'jpeg', quality: QUALITY[qualityName] });
  frameCount++;
  frameBytes += buf.length;
  broadcast({ type: 'frame', data: buf.toString('base64'), w: VIEWPORT_W, h: VIEWPORT_H });
}

async function setQuality(name) {
  if (!QUALITY[name] || name === qualityName) return;
  qualityName = name;
  log('تغییر کیفیت به:', name);
  await restartScreencast();
  broadcast({ type: 'quality', value: qualityName });
}

// ── ورودی کاربر ─────────────────────────────────────────────────
const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right', left: 'left', middle: 'middle', right: 'right' };

function mapKey(key) {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if (key === 'Up') return 'ArrowUp';
  if (key === 'Down') return 'ArrowDown';
  if (key === 'Left') return 'ArrowLeft';
  if (key === 'Right') return 'ArrowRight';
  if (key === 'OS') return 'Meta';
  return key;
}

async function handleMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') {
    return sendJson(ws, { type: 'pong', ts: Date.now() });
  }

  if (msg.type === 'auth') {
    if (!PASSWORD || msg.password === PASSWORD) {
      ws.authed = true;
      sendJson(ws, { ...helloState(), type: 'authed', ok: true });
      broadcastNav();
      sendFreshScreenshot().catch(() => {});
    } else {
      sendJson(ws, { type: 'authed', ok: false, message: 'رمز اشتباه است' });
    }
    return;
  }

  if (!ws.authed) return; // بقیه‌ی دستورها نیاز به احراز هویت دارند

  switch (msg.type) {
    case 'navigate':
      queueInput(() => doNavigate(msg.url));
      break;

    case 'back':
      queueInput(async () => {
        await ensurePage();
        await page.goBack({ timeout: 15000 }).catch(() => {});
        broadcastNav();
      });
      break;

    case 'forward':
      queueInput(async () => {
        await ensurePage();
        await page.goForward({ timeout: 15000 }).catch(() => {});
        broadcastNav();
      });
      break;

    case 'reload':
      queueInput(async () => {
        await ensurePage();
        broadcast({ type: 'loading', value: true });
        await page.reload({ timeout: 15000 }).catch(() => {});
        broadcast({ type: 'loading', value: false });
        broadcastNav();
      });
      break;

    case 'stop':
      queueInput(async () => {
        await ensurePage();
        await page.evaluate('window.stop()').catch(() => {});
        broadcast({ type: 'loading', value: false });
      });
      break;

    case 'mouse': {
      const x = clamp(Math.round(Number(msg.x)), 0, VIEWPORT_W - 1);
      const y = clamp(Math.round(Number(msg.y)), 0, VIEWPORT_H - 1);
      const btn = BUTTONS[msg.button] || 'left';
      if (Number.isNaN(x) || Number.isNaN(y)) break;
      queueInput(async () => {
        await ensurePage();
        if (msg.action === 'move') {
          await page.mouse.move(x, y);
        } else if (msg.action === 'down') {
          await page.mouse.move(x, y);
          await page.mouse.down({ button: btn });
        } else if (msg.action === 'up') {
          await page.mouse.move(x, y);
          await page.mouse.up({ button: btn });
        } else if (msg.action === 'wheel') {
          await page.mouse.wheel(
            Math.round(Number(msg.deltaX) || 0),
            Math.round(Number(msg.deltaY) || 0)
          );
        }
      });
      break;
    }

    case 'key':
      queueInput(async () => {
        await ensurePage();
        if (msg.action === 'type' && typeof msg.text === 'string' && msg.text) {
          // تایپ متن معمولی (فارسی/انگلیسی) — بهترین راه برای حروف
          await page.keyboard.type(msg.text.slice(0, 2000));
        } else if (msg.action === 'down' || msg.action === 'up') {
          const k = mapKey(String(msg.key || ''));
          if (!k) return;
          try {
            if (msg.action === 'down') await page.keyboard.down(k);
            else await page.keyboard.up(k);
          } catch (_) {
            /* کلید ناشناخته — نادیده */
          }
        } else if (msg.action === 'press') {
          const k = mapKey(String(msg.key || ''));
          if (!k) return;
          try {
            await page.keyboard.press(k);
          } catch (_) {
            /* نادیده */
          }
        }
      });
      break;

    case 'quality':
      queueInput(() => setQuality(String(msg.value || '').toLowerCase()));
      break;

    case 'getState':
      sendJson(ws, { ...helloState(), type: 'state' });
      broadcastNav();
      break;

    case '__eval': // فقط برای تست خودکار (ALLOW_EVAL=true)
      if (ALLOW_EVAL) {
        try {
          const result = await page.evaluate(msg.js);
          sendJson(ws, { type: '__evalResult', id: msg.id, ok: true, result });
        } catch (e) {
          sendJson(ws, {
            type: '__evalResult',
            id: msg.id,
            ok: false,
            error: String((e && e.message) || e),
          });
        }
      }
      break;

    default:
      break;
  }
}

// ── روشن کردن مرورگر ────────────────────────────────────────────
async function launchBrowser() {
  // حالت Mock فقط برای تست در محیط بدون Chromium (روی hostim استفاده نمی‌شود)
  if (process.env.MOCK_BROWSER === 'true') {
    log('⚠️ حالت MOCK: مرورگر واقعی اجرا نمی‌شود (فقط برای تست پروتکل)');
    const { createMockBrowser } = require('./mock-browser');
    const m = createMockBrowser();
    browser = m.browser;
    context = m.context;
  } else {
    log('در حال روشن کردن Chromium (بدون محیط گرافیکی)...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // مهم برای Docker و رم کم
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      locale: 'en-US',
      ignoreHTTPSErrors: true,
    });
  }

  // لینک‌هایی که تب جدید باز می‌کنند → همان را صفحه‌ی فعال کن
  context.on('page', async (np) => {
    log('تب/پاپ‌آپ جدید → جابه‌جایی به همان صفحه');
    page = np;
    attachPageListeners(np);
    await restartScreencast();
    for (const p of context.pages()) {
      if (p !== np && !p.isClosed()) await p.close().catch(() => {});
    }
    broadcastNav();
  });

  page = await context.newPage();
  attachPageListeners(page);
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('صفحه‌ی شروع باز شد:', START_URL);
  } catch (e) {
    log('صفحه‌ی شروع باز نشد (بعداً تلاش می‌کنیم):', e.message);
  }
  await startScreencast();

  browser.on('disconnected', () => {
    log('مرورگر قطع شد! خروج برای ری‌استارت خودکار کانتینر...');
    process.exit(1);
  });
  log('Chromium آماده است.');
}

// ── وب‌سرور + وب‌سوکت ───────────────────────────────────────────
async function boot() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      frames: frameCount,
      needAuth: !!PASSWORD,
    })
  );

  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

  wss.on('connection', (ws, req) => {
    ws.authed = !PASSWORD;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    log('کاربر وصل شد:', req.socket.remoteAddress);
    sendJson(ws, helloState());
    broadcastNav();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      handleMessage(ws, msg).catch((e) => log('[msg] خطا:', e.message));
    });
    ws.on('close', () => log('کاربر قطع شد'));
    ws.on('error', () => {});
  });

  // ضربان قلب: اتصال‌های مرده را ببند (مهم پشت reverse-proxy)
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch (_) {
          /* نادیده */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_) {
        /* نادیده */
      }
    }
  }, 30000);

  // آمار هر دقیقه (برای دیدن مصرف)
  setInterval(() => {
    const mb = (frameBytes / 1048576).toFixed(1);
    log(`آمار: ${frameCount} فریم، ${mb}MB ارسال شده، ${wss.clients.size} کاربر وصل`);
  }, 60000);

  await launchBrowser();

  server.listen(PORT, '0.0.0.0', () => {
    log(`✅ سرور روشن شد: http://0.0.0.0:${PORT} (رمز: ${PASSWORD ? 'فعال' : 'غیرفعال'})`);
  });
}

async function shutdown() {
  log('خاموش شدن...');
  try {
    stopFallback();
  } catch (_) {
    /* نادیده */
  }
  try {
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  } catch (_) {
    /* نادیده */
  }
  try {
    await browser?.close();
  } catch (_) {
    /* نادیده */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

boot().catch((e) => {
  console.error('خطای راه‌اندازی:', e);
  process.exit(1);
});
