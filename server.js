'use strict';
/* ─────────────────────────────────────────────────────────────
 * MajidBridge v2 — مرورگر ابری شخصی | Personal Cloud Browser
 *
 * معماری:
 *   Chromium روی سرور (Headless یا HEADFUL روی Xvfb) ←
 *   هر تغییر صفحه به‌صورت فریم JPEG زنده برای کاربر فرستاده می‌شود ←
 *   کلیک/تایپ/اسکرول کاربر به Chromium روی سرور برمی‌گردد
 *
 * چه چیزهایی در v2 اضافه شد:
 *   • Stealth ضدشناسایی (Cloudflare و …) — navigator.webdriver و
 *     plugins/permissions/WebGL/UA-Client-Hints همه مثل مرورگر واقعی
 *   • حالت HEADFUL روی Xvfb (قوی‌ترین راه عبور از تیک امنیتی)
 *   • پروفایل ماندگار مرورگر (لاگین‌ها بعد از ری‌استارت می‌مانند)
 *   • تب‌های تاریخچه / نشان‌ها / تنظیمات در وب‌UI
 *   • کلیپبورد دوطرفه (Ctrl+C از سرور → مرورگر تو، Ctrl+V برعکس)
 *   • زوم زنده و تغییر وضوح (viewport) بدون ری‌استارت
 * ───────────────────────────────────────────────────────────── */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

// ── تنظیمات از روی env ─────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const PASSWORD = process.env.PASSWORD || ''; // اگر خالی = بدون رمز (فقط برای تست محلی!)
const START_URL = process.env.START_URL || 'https://example.com';
const ALLOW_EVAL = process.env.ALLOW_EVAL === 'true'; // فقط برای تست خودکار، در محصول false
const MOCK = process.env.MOCK_BROWSER === 'true';

// HEADFUL=true → Chromium با پنجره‌ی واقعی روی Xvfb (ضدشناسایی قوی‌تر)
const HEADFUL = String(process.env.HEADFUL || '').toLowerCase() === 'true';

// پروفایل ماندگار: کوکی/لاگین/تاریخچه بین ری‌استارت‌ها می‌ماند
const PROFILE_DIR =
  process.env.PROFILE_DIR || (MOCK ? '' : path.join(__dirname, '.profile'));
const PERSISTENT = !!PROFILE_DIR && !MOCK;

// اندازه‌ی صفحه (زنده قابل تغییر است)
const VIEW = {
  w: clampInt(process.env.VIEWPORT_W, 320, 3840, 1280),
  h: clampInt(process.env.VIEWPORT_H, 240, 2160, 800),
};

const QUALITY = { low: 40, medium: 60, high: 80 };
let qualityName = String(process.env.QUALITY || 'medium').toLowerCase();
if (!QUALITY[qualityName]) qualityName = 'medium';

let zoomLevel = clampNum(process.env.ZOOM, 0.5, 3, 1);

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

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

// داده‌های ماندگار
let history = []; // [{url,title,ts}]
let bookmarks = []; // [{url,title,ts}]
let settings = {};

// صف ورودی: کلیک/تایپ/اسکرول پشت سر هم اجرا می‌شن تا قاطی نشود
let inputChain = Promise.resolve();
function queueInput(fn) {
  inputChain = inputChain.then(fn).catch((e) => log('[input] خطا:', e.message));
  return inputChain;
}

// ── ذخیره‌سازی ماندگار (JSON ساده، بدون وابستگی اضافه) ─────────
function dataPath() {
  return PROFILE_DIR || path.join(__dirname, '.data');
}
function dataFile(name) {
  return path.join(dataPath(), name);
}
function loadJson(name, dflt) {
  try {
    const p = dataFile(name);
    if (!fs.existsSync(p)) return dflt;
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v == null ? dflt : v;
  } catch (_) {
    return dflt;
  }
}
const saveTimers = {};
function saveJson(name, value) {
  // debounce تا دیسک در ناوبری‌های پشت‌سرهم شلوغ نشود
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    try {
      fs.mkdirSync(dataPath(), { recursive: true });
      fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 1));
    } catch (e) {
      log('ذخیره‌ی', name, 'ناموفق:', e.message);
    }
  }, 400);
}
function persistAll() {
  saveJson('history.json', history.slice(0, 100));
  saveJson('bookmarks.json', bookmarks);
  saveJson('settings.json', settings);
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
    w: VIEW.w,
    h: VIEW.h,
    quality: qualityName,
    zoom: zoomLevel,
    headful: HEADFUL,
    stealth: !MOCK,
    persistent: PERSISTENT,
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
    recordHistory(url, title);
  } catch (_) {
    /* نادیده */
  }
}

// ── تاریخچه / نشان‌ها ──────────────────────────────────────────
function recordHistory(url, title) {
  if (!url || url === 'about:blank') return;
  const last = history[0];
  if (last && last.url === url && Date.now() - last.ts < 1500) {
    last.title = title || last.title;
    last.ts = Date.now();
  } else {
    history.unshift({ url, title: title || '', ts: Date.now() });
  }
  if (history.length > 200) history.length = 200;
  saveJson('history.json', history.slice(0, 100));
  broadcast({ type: 'history', items: history.slice(0, 60) });
}

function sendHistory(ws) {
  sendJson(ws, { type: 'history', items: history.slice(0, 60) });
}
function sendBookmarks(ws) {
  sendJson(ws, { type: 'bookmarks', items: bookmarks });
}
function sendSettings(ws) {
  sendJson(ws, { type: 'settings', settings });
}

// ── Stealth: ضدشناسایی Cloudflare و سامانه‌های مشابه ───────────
// این اسکریپت «قبل از هر اسکریپت صفحه» اجرا می‌شود تا هیچ ردی از
// اتوماسیون باقی نماند.
const STEALTH_INIT = `(function () {
  try {
    // ۱) webdriver حذف شود
    try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e) {}
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}

    // ۲) زبان‌ها و پلتفرم مثل مرورگر واقعی
    try { Object.defineProperty(navigator, 'languages', { get: function () { return ['en-US', 'en']; }, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'platform', { get: function () { return 'Win32'; }, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 8; }, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; }, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: function () { return 0; }, configurable: true }); } catch (e) {}

    // ۳) plugins / mimeTypes خالی = نشانه‌ی ربات → پر می‌کنیم
    function mkPlugin(name, desc, filename) {
      var p = { name: name, description: desc, filename: filename, length: 1 };
      p[0] = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: p };
      return p;
    }
    var plugins = [
      mkPlugin('PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
      mkPlugin('Chrome PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
      mkPlugin('Chromium PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
      mkPlugin('Microsoft Edge PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
      mkPlugin('WebKit built-in PDF', 'Portable Document Format', 'internal-pdf-viewer')
    ];
    try { Object.defineProperty(navigator, 'plugins', { get: function () { return plugins; }, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'mimeTypes', { get: function () { return [plugins[0][0]]; }, configurable: true }); } catch (e) {}

    // ۴) window.chrome
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = { connect: function () {}, sendMessage: function () {} };
      if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: {}, RunningState: {} };
      if (!window.chrome.csi) window.chrome.csi = function () { return {}; };
      if (!window.chrome.loadTimes) window.chrome.loadTimes = function () { return {}; };
    } catch (e) {}

    // ۵) Permissions API — در حالت headless «denied» برمی‌گردد که لو می‌دهد
    try {
      var origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = function (parameters) {
          return parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : Promise.resolve({ state: 'prompt', onchange: null });
        };
      }
    } catch (e) {}

    // ۶) WebGL — vendor/renderer واقعی
    function patchWebGL(proto) {
      try {
        var getParam = proto.getParameter;
        proto.getParameter = function (parameter) {
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';
          return getParam.apply(this, arguments);
        };
      } catch (e) {}
    }
    try {
      if (window.WebGLRenderingContext) patchWebGL(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchWebGL(WebGL2RenderingContext.prototype);
    } catch (e) {}

    // ۷) iframe.contentWindow.chrome — یکی از تست‌های معروف شناسایی
    try {
      var origCreate = document.createElement.bind(document);
      document.createElement = function () {
        var el = origCreate.apply(document, arguments);
        try {
          if (String(arguments[0]).toLowerCase() === 'iframe') {
            var origAppend = el.appendChild ? null : null;
            el.addEventListener && el.addEventListener('DOMNodeInserted', function () {
              try { if (el.contentWindow && !el.contentWindow.chrome) el.contentWindow.chrome = window.chrome; } catch (e) {}
            });
          }
        } catch (e) {}
        return el;
      };
    } catch (e) {}

    // ۸) پل کلیپبورد: اگر مرورگر کاربر اجازه‌ی clipboard ندهد،
    //    متن کپی‌شده از راه رویداد copy به سرور می‌رسد.
    try {
      function bridgeCopy() {
        var text = '';
        try {
          var sel = window.getSelection && window.getSelection();
          text = sel ? String(sel) : '';
        } catch (e) {}
        try {
          var ae = document.activeElement;
          if (ae && !text && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
            var s = ae.selectionStart, e2 = ae.selectionEnd, v = ae.value || '';
            if (typeof s === 'number' && typeof e2 === 'number' && e2 > s) text = v.substring(s, e2);
            else if (ae.type === 'password') text = '';
          }
        } catch (e) {}
        if (!text) return;
        try {
          fetch('/__mb_clipboard', {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: String(text).slice(0, 20000),
            keepalive: true
          });
        } catch (e) {}
      }
      document.addEventListener('copy', function () { setTimeout(bridgeCopy, 0); }, true);
      document.addEventListener('cut', function () { setTimeout(bridgeCopy, 0); }, true);
      window.__mbCopyBridge = bridgeCopy;
    } catch (e) {}

    // ۹) حذف نشانه‌های Playwright
    try { delete window.__playwright; delete window.__pw_manual; } catch (e) {}
  } catch (e) { /* هر خطا نباید صفحه را بشکند */ }
})();`;

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
  await applyZoom().catch(() => {});
  return page;
}

function attachPageListeners(p) {
  if (p.__mbAttached) return;
  p.__mbAttached = true;

  p.on('framenavigated', (frame) => {
    if (page === p && frame === p.mainFrame()) {
      broadcast({ type: 'loading', value: false });
      broadcastNav();
      grantClipboard().catch(() => {});
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
  await grantClipboard().catch(() => {});
  broadcastNav();
}

// ── پخش زنده‌ی تصویر ────────────────────────────────────────────
// روش اصلی: CDP Screencast — خود Chromium فقط وقتی صفحه عوض شود فریم
// می‌فرستد (پس وقتی داری متن می‌خوانی تقریباً مصرف اینترنت صفر است).
async function startScreencast() {
  try {
    await ensurePageShallow();
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
      broadcast({ type: 'frame', data, w: VIEW.w, h: VIEW.h });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: QUALITY[qualityName],
      maxWidth: VIEW.w,
      maxHeight: VIEW.h,
      everyNthFrame: 1,
    });
    screencastOn = true;
    stopFallback();
    log(`پخش زنده روشن شد (کیفیت ${qualityName} = ${QUALITY[qualityName]}، ${VIEW.w}×${VIEW.h})`);
    sendFreshScreenshot().catch(() => {}); // فریم اول فوری
  } catch (e) {
    log('screencast نشد، حالت جایگزین (اسکرین‌شات دوره‌ای):', e.message);
    screencastOn = false;
    ensureFallback();
  }
}

// نسخه‌ی سبک ensurePage بدون راه‌اندازی مجدد screencast (برای خودِ screencast)
async function ensurePageShallow() {
  if (page && !page.isClosed()) return page;
  const pages = context.pages().filter((p) => !p.isClosed());
  page = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
  attachPageListeners(page);
  return page;
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
  await ensurePageShallow();
  const buf = await page.screenshot({ type: 'jpeg', quality: QUALITY[qualityName] });
  frameCount++;
  frameBytes += buf.length;
  broadcast({ type: 'frame', data: buf.toString('base64'), w: VIEW.w, h: VIEW.h });
}

async function setQuality(name) {
  name = String(name || '').toLowerCase();
  if (!QUALITY[name] || name === qualityName) return;
  qualityName = name;
  settings.quality = name;
  saveJson('settings.json', settings);
  log('تغییر کیفیت به:', name);
  await restartScreencast();
  broadcast({ type: 'quality', value: qualityName });
  broadcast({ type: 'settings', settings });
}

// ── زوم ─────────────────────────────────────────────────────────
async function applyZoom() {
  if (!page || page.isClosed()) return;
  // روش اصلی: CDP (در headless و headful هر دو کار می‌کند)
  if (cdp) {
    try {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: zoomLevel });
      return;
    } catch (_) {
      /* fallthrough */
    }
  }
  // روش جایگزین: CSS zoom روی خود صفحه
  try {
    await page.evaluate(
      `(function(){ try { document.documentElement.style.setProperty('zoom', String(${zoomLevel})); } catch(e){} })()`
    );
  } catch (_) {
    /* نادیده */
  }
}

async function setZoom(v) {
  const z = clampNum(v, 0.5, 3, zoomLevel);
  if (Math.abs(z - zoomLevel) < 0.01) return;
  zoomLevel = z;
  settings.zoom = z;
  saveJson('settings.json', settings);
  await applyZoom().catch(() => {});
  log('زوم:', zoomLevel);
  broadcast({ type: 'zoom', value: zoomLevel });
  sendFreshScreenshot().catch(() => {});
}

// ── تغییر وضوح زنده ─────────────────────────────────────────────
async function setViewport(w, h) {
  const nw = clampInt(w, 320, 3840, VIEW.w);
  const nh = clampInt(h, 240, 2160, VIEW.h);
  if (nw === VIEW.w && nh === VIEW.h) return;
  VIEW.w = nw;
  VIEW.h = nh;
  settings.w = nw;
  settings.h = nh;
  saveJson('settings.json', settings);
  log(`وضوح زنده: ${nw}×${nh}`);
  try {
    await ensurePageShallow();
    if (typeof page.setViewportSize === 'function') {
      await page.setViewportSize({ width: nw, height: nh });
    }
  } catch (e) {
    log('تغییر اندازه صفحه ناموفق:', e.message);
  }
  await restartScreencast();
  await applyZoom().catch(() => {});
  broadcast({ type: 'viewport', w: VIEW.w, h: VIEW.h });
}

// ── کلیپبورد دوطرفه ─────────────────────────────────────────────
// مسیر ۱: اجازه‌ی clipboard به origin صفحه (پاک‌ترین راه)
async function grantClipboard() {
  try {
    if (!context || typeof context.grantPermissions !== 'function') return;
    if (!page || page.isClosed()) return;
    const u = new URL(page.url());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: u.origin });
  } catch (_) {
    /* بعضی صفحه‌ها اجازه نمی‌گیرند — مسیر جایگزین فعال است */
  }
}

const JS_SELECTION = `(function () {
  var t = '';
  try { var s = window.getSelection(); t = s ? String(s) : ''; } catch (e) {}
  try {
    var a = document.activeElement;
    if (!t && a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      var st = a.selectionStart, en = a.selectionEnd, v = a.value || '';
      if (typeof st === 'number' && typeof en === 'number' && en > st) t = v.substring(st, en);
    }
  } catch (e) {}
  return t;
})()`;

const JS_CLIP_READ =
  "navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText().catch(function(){return ''}) : ''";

const JS_CLIP_WRITE_FALLBACK = `(function (text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) { return false; }
})`;

// Ctrl+C در صفحه‌ی سرور → متن به مرورگر کاربر می‌رود
async function doCopy() {
  await ensurePageShallow();
  let text = '';
  try {
    const sel = await page.evaluate(JS_SELECTION);
    if (sel) text = String(sel);
  } catch (_) {
    /* نادیده */
  }
  if (!text) {
    try {
      text = String((await page.evaluate(JS_CLIP_READ)) || '');
    } catch (_) {
      text = '';
    }
  }
  text = String(text || '').slice(0, 20000);
  if (!text) {
    broadcast({ type: 'toast', message: 'چیزی برای کپی انتخاب نشده است' });
    return;
  }
  broadcast({ type: 'clipboard', text, source: 'remote' });
  log('کپی از سرور →', text.length, 'نویسه');
}

// Ctrl+V کاربر → متن داخل کلیپبورد صفحه‌ی سرور می‌نشیند
async function doPaste(text) {
  await ensurePageShallow();
  const t = String(text == null ? '' : text).slice(0, 20000);
  if (!t) return;
  try {
    if (typeof page.evaluate === 'function') {
      await page.evaluate(
        `(function(){ try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(${JSON.stringify(
          t
        )}).catch(function(){}); } catch(e){} })()`
      );
    }
  } catch (_) {
    /* نادیده */
  }
  try {
    // رویداد paste واقعی با DataHolder → سایت‌هایی که onPaste دارند هم کار می‌کنند
    if (typeof page.evaluate === 'function') {
      await page.evaluate(
        `(function (text) {
          try {
            var dt = new DataTransfer();
            dt.setData('text/plain', text);
            var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            var target = document.activeElement || document.body;
            target.dispatchEvent(ev);
          } catch (e) {}
        })(${JSON.stringify(t)})`
      );
    }
  } catch (_) {
    /* نادیده */
  }
  try {
    // و در نهایت میانبر واقعی Chromium (اگر کلیپبورد سیستم ست شده باشد)
    await page.keyboard.press('Control+V').catch(() => {});
  } catch (_) {
    /* نادیده */
  }
  log('چسباندن در سرور →', t.length, 'نویسه');
  broadcast({ type: 'toast', message: 'متن در صفحه چسبانده شد' });
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
  if (key === 'Ctrl') return 'Control';
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
      sendHistory(ws);
      sendBookmarks(ws);
      sendSettings(ws);
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

    case 'home':
      queueInput(() => doNavigate(START_URL));
      break;

    case 'mouse': {
      const x = clamp(Math.round(Number(msg.x)), 0, VIEW.w - 1);
      const y = clamp(Math.round(Number(msg.y)), 0, VIEW.h - 1);
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

    // میانبرهای ترکیبی که باید در سمت سرور مدیریت شوند (کلیپبورد)
    case 'combo': {
      const c = String(msg.combo || '').toLowerCase();
      if (c === 'copy') queueInput(() => doCopy());
      else if (c === 'cut') queueInput(() => doCopy());
      else if (c === 'paste') queueInput(() => doPaste(msg.text));
      break;
    }

    // متن کپی‌شده از خودِ صفحه (مسیر جایگزینِ Stealth)
    case 'clipboardPush': {
      const t = String(msg.text || '').slice(0, 20000);
      if (t) broadcast({ type: 'clipboard', text: t, source: 'page' });
      break;
    }

    case 'copyText': // دکمه‌ی «کپی از سرور» در وب‌UI
      queueInput(() => doCopy());
      break;

    case 'pasteText': // دکمه‌ی «چسباندن در سرور» در وب‌UI
      queueInput(() => doPaste(msg.text));
      break;

    case 'quality':
      queueInput(() => setQuality(String(msg.value || '').toLowerCase()));
      break;

    case 'viewport':
      queueInput(() => setViewport(msg.w, msg.h));
      break;

    case 'zoom':
      queueInput(() => setZoom(msg.value));
      break;

    case 'getHistory':
      sendHistory(ws);
      break;

    case 'clearHistory':
      history = [];
      saveJson('history.json', history);
      sendHistory(ws);
      broadcast({ type: 'toast', message: 'تاریخچه پاک شد' });
      break;

    case 'getBookmarks':
      sendBookmarks(ws);
      break;

    case 'bookmarkAdd':
      queueInput(async () => {
        await ensurePageShallow();
        const url = page && !page.isClosed() ? page.url() : START_URL;
        let title = '';
        try {
          title = await page.title();
        } catch (_) {
          /* نادیده */
        }
        if (!url || url === 'about:blank') return;
        if (!bookmarks.some((b) => b.url === url)) {
          bookmarks.unshift({ url, title: title || url, ts: Date.now() });
          if (bookmarks.length > 500) bookmarks.length = 500;
          saveJson('bookmarks.json', bookmarks);
        }
        broadcast({ type: 'bookmarks', items: bookmarks });
        broadcast({ type: 'toast', message: 'به نشان‌ها اضافه شد ⭐' });
      });
      break;

    case 'bookmarkRemove':
      bookmarks = bookmarks.filter((b) => b.url !== msg.url);
      saveJson('bookmarks.json', bookmarks);
      broadcast({ type: 'bookmarks', items: bookmarks });
      break;

    case 'getSettings':
      sendSettings(ws);
      sendJson(ws, { ...helloState(), type: 'info' });
      break;

    case 'setStartUrl': {
      const u = normalizeUrl(msg.value);
      if (u) {
        settings.startUrl = u;
        saveJson('settings.json', settings);
        sendSettings(ws);
        broadcast({ type: 'toast', message: 'صفحه‌ی شروع ذخیره شد' });
      }
      break;
    }

    case 'getState':
      sendJson(ws, { ...helloState(), type: 'state' });
      sendHistory(ws);
      sendBookmarks(ws);
      sendSettings(ws);
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
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // مهم برای Docker و رم کم
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled', // کلید Stealth
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--disable-infobars',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--password-store=basic',
  '--use-mock-keychain',
];

// نسخه‌ی Chrome را از User-Agent واقعی خود Chromium بیرون می‌کشیم
function chromeVersionFrom(ua) {
  const m = String(ua || '').match(/(?:Headless)?Chrome\/(\d+)/);
  return m ? parseInt(m[1], 10) : 130;
}

// UA را «واقعی» می‌کنیم: هیچ ردی از Headless نباید بماند
function realUA(ua, version) {
  let u = String(ua || '')
    .replace(/HeadlessChrome/g, 'Chrome')
    .replace(/\sHeadless\b/g, '');
  if (!u) {
    u = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
  }
  return u;
}

// UA-Client-Hints باید با UA مطابقت کند وگرنه Cloudflare شک می‌کند
function uaMetadata(version) {
  return {
    brands: [
      { brand: 'Chromium', version: String(version) },
      { brand: 'Google Chrome', version: String(version) },
      { brand: 'Not?A_Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: `${version}.0.0.0` },
      { brand: 'Google Chrome', version: `${version}.0.0.0` },
      { brand: 'Not?A_Brand', version: '99.0.0.0' },
    ],
    fullVersion: `${version}.0.0.0`,
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  };
}

// Client Hints را در سطح CDP هم ست می‌کنیم (sec-ch-ua-platform و …)
async function applyClientHints(target) {
  if (!userAgent || !target) return;
  try {
    const s = await context.newCDPSession(target);
    await s.send('Emulation.setUserAgentOverride', {
      userAgent,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Windows',
      userAgentMetadata: uaMetadata(chromeVersion),
    });
    try {
      await s.detach();
    } catch (_) {
      /* نادیده */
    }
  } catch (_) {
    /* نادیده */
  }
}

let userAgent = null;
let chromeVersion = 130;

function contextOptions() {
  const opts = {
    viewport: { width: VIEW.w, height: VIEW.h },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreHTTPSErrors: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  };
  if (userAgent) {
    opts.userAgent = userAgent;
    opts.userAgentMetadata = uaMetadata(chromeVersion);
  }
  return opts;
}

async function launchBrowser() {
  // حالت Mock فقط برای تست در محیط بدون Chromium (روی hostim استفاده نمی‌شود)
  if (MOCK) {
    log('⚠️ حالت MOCK: مرورگر واقعی اجرا نمی‌شود (فقط برای تست پروتکل)');
    const { createMockBrowser } = require('./mock-browser');
    const m = createMockBrowser();
    browser = m.browser;
    context = m.context;
  } else {
    // Playwright فقط در حالت واقعی لازم است (تا نصب سبک بماند)
    const { chromium } = require('playwright');

    const args = LAUNCH_ARGS.slice();
    if (HEADFUL) {
      args.push(`--window-size=${VIEW.w},${VIEW.h}`, '--start-maximized', '--force-device-scale-factor=1');
      log('🖥️ حالت HEADFUL روی Xvfb (ضدشناسایی قوی) — DISPLAY=' + (process.env.DISPLAY || 'نامشخص'));
    } else {
      args.push('--window-size=1920,1080');
      log('در حال روشن کردن Chromium (headless جدید)...');
    }

    if (PERSISTENT) {
      const userDataDir = path.join(PROFILE_DIR, 'userdata');
      fs.mkdirSync(userDataDir, { recursive: true });
      log('پروفایل ماندگار:', userDataDir);
      context = await chromium.launchPersistentContext(userDataDir, { headless: !HEADFUL, args });
      browser = context.browser();
      // UA واقعی را از خودِ مرورگر می‌گیریم و «Headless» را پاک می‌کنیم
      try {
        const tmp = await context.newPage();
        chromeVersion = chromeVersionFrom(await tmp.evaluate('navigator.userAgent'));
        userAgent = realUA(await tmp.evaluate('navigator.userAgent'), chromeVersion);
        await tmp.close();
      } catch (e) {
        log('گرفتن UA ناموفق:', e.message);
      }
    } else {
      browser = await chromium.launch({ headless: !HEADFUL, args });
      // یک context موقت فقط برای خواندن UA واقعی (بدون دستکاری)
      try {
        const tmpCtx = await browser.newContext();
        const tmp = await tmpCtx.newPage();
        const raw = await tmp.evaluate('navigator.userAgent');
        chromeVersion = chromeVersionFrom(raw);
        userAgent = realUA(raw, chromeVersion);
        await tmpCtx.close();
      } catch (e) {
        log('گرفتن UA ناموفق:', e.message);
      }
      context = await browser.newContext(contextOptions());
    }

    // Stealth روی همه‌ی صفحه‌ها و فریم‌ها، قبل از هر اسکریپتی
    try {
      await context.addInitScript({ content: STEALTH_INIT });
    } catch (e) {
      log('addInitScript ناموفق:', e.message);
    }
    log(`Stealth فعال | UA: ${(userAgent || 'پیش‌فرض').slice(0, 90)}…`);
  }

  // لینک‌هایی که تب جدید باز می‌کنند → همان را صفحه‌ی فعال کن
  context.on('page', async (np) => {
    log('تب/پاپ‌آپ جدید → جابه‌جایی به همان صفحه');
    page = np;
    attachPageListeners(np);
    await applyClientHints(np).catch(() => {});
    await restartScreencast();
    for (const p of context.pages()) {
      if (p !== np && !p.isClosed()) await p.close().catch(() => {});
    }
    broadcastNav();
  });

  // با پروفایل ماندگار ممکن است تب‌های قبلی باز باشند → همان‌ها را برمی‌داریم
  const existing = context.pages().filter((p) => !p.isClosed());
  page = existing.length > 0 ? existing[0] : await context.newPage();
  attachPageListeners(page);
  for (const p of existing.slice(1)) await p.close().catch(() => {});

  await applyClientHints(page).catch(() => {});

  if (!page.url() || page.url() === 'about:blank') {
    try {
      await page.goto(settings.startUrl || START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log('صفحه‌ی شروع باز شد:', settings.startUrl || START_URL);
    } catch (e) {
      log('صفحه‌ی شروع باز نشد (بعداً تلاش می‌کنیم):', e.message);
    }
  } else {
    log('ادامه از تب قبلی پروفایل:', page.url().slice(0, 100));
  }

  await grantClipboard().catch(() => {});
  await startScreencast();
  await applyZoom().catch(() => {});

  if (browser && typeof browser.on === 'function') {
    browser.on('disconnected', () => {
      log('مرورگر قطع شد! خروج برای ری‌استارت خودکار کانتینر...');
      persistAll();
      process.exit(1);
    });
  }
  log('Chromium آماده است.');
}

// ── وب‌سرور + وب‌سوکت ───────────────────────────────────────────
async function boot() {
  // بارگذاری داده‌های ماندگار
  const h0 = loadJson('history.json', []);
  const b0 = loadJson('bookmarks.json', []);
  history = Array.isArray(h0) ? h0 : [];
  bookmarks = Array.isArray(b0) ? b0 : [];
  settings = loadJson('settings.json', {}) || {};
  if (settings.quality && QUALITY[settings.quality]) qualityName = settings.quality;
  if (settings.zoom) zoomLevel = clampNum(settings.zoom, 0.5, 3, 1);
  if (settings.w) VIEW.w = clampInt(settings.w, 320, 3840, VIEW.w);
  if (settings.h) VIEW.h = clampInt(settings.h, 240, 2160, VIEW.h);
  settings = {
    quality: qualityName,
    zoom: zoomLevel,
    w: VIEW.w,
    h: VIEW.h,
    startUrl: normalizeUrl(settings.startUrl) || START_URL,
  };
  log(`تنظیمات: ${VIEW.w}×${VIEW.h}، کیفیت ${qualityName}، زوم ${zoomLevel}، headful=${HEADFUL}، persistent=${PERSISTENT}`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      version: 2,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      frames: frameCount,
      needAuth: !!PASSWORD,
      headful: HEADFUL,
      stealth: !MOCK,
      persistent: PERSISTENT,
      viewport: { w: VIEW.w, h: VIEW.h },
      zoom: zoomLevel,
    })
  );

  // مسیر جایگزین کلیپبورد: خودِ صفحه متن کپی‌شده را می‌فرستد
  app.post('/__mb_clipboard', express.text({ type: '*/*', limit: '64kb' }), (req, res) => {
    const t = String(req.body || '').slice(0, 20000);
    if (t) broadcast({ type: 'clipboard', text: t, source: 'page' });
    res.status(204).end();
  });

  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

  wss.on('connection', (ws, req) => {
    ws.authed = !PASSWORD;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    log('کاربر وصل شد:', req.socket.remoteAddress);
    sendJson(ws, helloState());
    if (ws.authed) {
      sendHistory(ws);
      sendBookmarks(ws);
      sendSettings(ws);
    }
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
    persistAll();
  } catch (_) {
    /* نادیده */
  }
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
    await context?.close();
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
