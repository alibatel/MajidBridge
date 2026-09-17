'use strict';
/* ─────────────────────────────────────────────────────────────
 * Mock مرورگر — فقط برای تست در محیط‌هایی که نصب Chromium ممکن نیست
 * فعال‌سازی: MOCK_BROWSER=true
 * رفتار: ناوبری/فریم/ورودی/کلیپبورد/زوم/وضوح را شبیه‌سازی می‌کند تا
 *         پروتکل WS و رابط وب کامل تست شود (۱۴ تست).
 * در hostim و Docker واقعی استفاده نمی‌شود (آنجا Chromium واقعی است).
 * ───────────────────────────────────────────────────────────── */
const { EventEmitter } = require('events');

// بایت‌های JPEG برای تست فرمت (شروع با /9j/ — تصویر واقعی نیست)
const FAKE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const FAKE_JPEG_B64 = FAKE_JPEG.toString('base64');

const MOCK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class FakeFrame {
  constructor() {
    this._main = true;
  }
}

class FakePage extends EventEmitter {
  constructor(ctx) {
    super();
    this.__mbAttached = false;
    this._ctx = ctx || null;
    this._url = 'about:blank';
    this._title = 'Mock Page';
    this._closed = false;
    this._frame = new FakeFrame();
    this._typed = ''; // متن تایپ‌شده در فیلد فرضی (برای تست کلیک+تایپ)
    this._focused = false; // با mousedown فعال می‌شود (مثل فوکس واقعی)
    this._selected = ''; // متن انتخاب‌شده (برای تست کپی)
    this._clipboard = ''; // کلیپبورد سمت سرور
    this._pasted = ''; // آخرین چیزی که در صفحه چسبانده شد
    this._zoom = 1;
    this._viewport = { width: 1280, height: 800 };
    this._history = [];
    this._historyIndex = -1;
    this.mouse = {
      move: async () => {},
      down: async () => {
        this._focused = true;
      },
      up: async () => {},
      wheel: async () => {},
    };
    this.keyboard = {
      type: async (t) => {
        if (this._focused) this._typed += t;
      },
      down: async (k) => {
        if (k === 'Backspace' && this._focused) this._typed = this._typed.slice(0, -1);
      },
      up: async () => {},
      press: async (combo) => {
        const c = String(combo || '');
        if (c === 'Backspace' && this._focused) this._typed = this._typed.slice(0, -1);
        else if (/Control\+[vV]$/.test(c)) this._pasted = this._clipboard; // چسباندن واقعی
        else if (/Control\+[cC]$/.test(c)) this._clipboard = this._selected || this._typed;
      },
    };
  }
  mainFrame() {
    return this._frame;
  }
  isClosed() {
    return this._closed;
  }
  url() {
    return this._url;
  }
  async title() {
    return this._title;
  }
  async setViewportSize(size) {
    this._viewport = {
      width: Math.round(Number(size && size.width) || this._viewport.width),
      height: Math.round(Number(size && size.height) || this._viewport.height),
    };
    if (this._ctx) this._ctx._viewport = { ...this._viewport };
    return this._viewport;
  }
  viewportSize() {
    return { ...this._viewport };
  }
  _pushHistory() {
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(this._url);
    this._historyIndex = this._history.length - 1;
    if (this._history.length > 50) {
      this._history.shift();
      this._historyIndex--;
    }
  }
  async goto(url) {
    this._url = String(url);
    this._title = 'Mock: ' + this._url.slice(0, 60);
    this._typed = '';
    this._focused = false;
    this._selected = '';
    this._pushHistory();
    await new Promise((r) => setTimeout(r, 50));
    this.emit('framenavigated', this._frame);
    this.emit('load');
  }
  async goBack() {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._url = this._history[this._historyIndex];
      this.emit('framenavigated', this._frame);
    }
  }
  async goForward() {
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._url = this._history[this._historyIndex];
      this.emit('framenavigated', this._frame);
    }
  }
  async reload() {
    this.emit('load');
  }
  async screenshot() {
    return FAKE_JPEG;
  }
  async evaluate(js) {
    const s = String(js);
    // کلیپبورد: خواندن
    if (s.includes('readText')) return this._clipboard;
    // کلیپبورد: نوشتن (navigator.clipboard.writeText)
    if (s.includes('writeText')) {
      const m = s.match(/writeText\((".*?"|'.*?')\)/);
      if (m) {
        try {
          this._clipboard = JSON.parse(m[1]);
        } catch (_) {
          this._clipboard = m[1].slice(1, -1);
        }
      }
      return undefined;
    }
    // رویداد paste
    if (s.includes("ClipboardEvent('paste'") || s.includes('new ClipboardEvent')) {
      const m = s.match(/\}\)\((".*?"|'.*?')\)\s*$/);
      if (m) {
        try {
          this._pasted = JSON.parse(m[1]);
        } catch (_) {
          this._pasted = m[1].slice(1, -1);
        }
      }
      return undefined;
    }
    // متن انتخاب‌شده
    if (s.includes('getSelection') || s.includes('selectionStart')) return this._selected;
    // زوم CSS
    if (s.includes("setProperty('zoom'") || s.includes('style.zoom')) return undefined;
    // USER AGENT
    if (s.includes('navigator.userAgent')) return MOCK_UA;
    if (s.includes('window.stop()')) return true;
    // مقدار فیلد تست
    if (s.includes("getElementById('t')") || s.includes('getElementById("t")')) return this._typed;
    return null;
  }
  async close() {
    this._closed = true;
    this.emit('close');
  }
}

class FakeCDP extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._sid = 0;
    this.calls = [];
  }
  async send(method, params) {
    this.calls.push({ method, params });
    if (method === 'Page.startScreencast') {
      this._stop();
      this._timer = setInterval(() => {
        this._timer &&
          this.emit('Page.screencastFrame', { data: FAKE_JPEG_B64, sessionId: String(++this._sid) });
      }, 400);
    } else if (method === 'Page.stopScreencast') {
      this._stop();
    }
    // Page.screencastFrameAck و Emulation.* نادیده گرفته می‌شوند
  }
  async detach() {
    this._stop();
  }
  _stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

class FakeContext extends EventEmitter {
  constructor() {
    super();
    this._page = new FakePage(this);
    this._viewport = { width: 1280, height: 800 };
    this.grantedPermissions = [];
    this.initScripts = [];
  }
  pages() {
    return this._page.isClosed() ? [] : [this._page];
  }
  async newPage() {
    if (this._page.isClosed()) this._page = new FakePage(this);
    return this._page;
  }
  async newCDPSession() {
    return new FakeCDP();
  }
  async addInitScript(script) {
    this.initScripts.push(script);
  }
  async grantPermissions(perms, opts) {
    this.grantedPermissions.push({ perms, opts });
  }
  async clearPermissions() {
    this.grantedPermissions = [];
  }
  async storageState() {
    return { cookies: [], origins: [] };
  }
  async close() {}
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this._ctx = new FakeContext();
  }
  version() {
    return '130.0.0.0';
  }
  async newContext() {
    return this._ctx;
  }
  async close() {}
}

function createMockBrowser() {
  const browser = new FakeBrowser();
  return { browser, context: browser._ctx };
}

module.exports = { createMockBrowser, MOCK_UA, FAKE_JPEG_B64 };
