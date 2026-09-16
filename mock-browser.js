'use strict';
/* ─────────────────────────────────────────────────────────────
 * Mock مرورگر — فقط برای تست در محیط‌هایی که نصب Chromium ممکن نیست
 * فعال‌سازی: MOCK_BROWSER=true
 * رفتار: ناوبری/فریم/ورودی را شبیه‌سازی می‌کند تا پروتکل WS و UI تست شود.
 * در hostim و Docker واقعی استفاده نمی‌شود (آنجا Chromium واقعی است).
 * ───────────────────────────────────────────────────────────── */
const { EventEmitter } = require('events');

// بایت‌های JPEG برای تست فرمت (شروع با /9j/ — تصویر واقعی نیست)
const FAKE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const FAKE_JPEG_B64 = FAKE_JPEG.toString('base64');

class FakeFrame {
  constructor() {
    this._main = true;
  }
}

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.__mbAttached = false;
    this._url = 'about:blank';
    this._title = 'Mock Page';
    this._closed = false;
    this._frame = new FakeFrame();
    this._typed = ''; // متن تایپ‌شده در فیلد فرضی (برای تست کلیک+تایپ)
    this._focused = false; // با mousedown فعال می‌شود (مثل فوکس واقعی)
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
      press: async (k) => {
        if (k === 'Backspace' && this._focused) this._typed = this._typed.slice(0, -1);
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
  async goto(url) {
    this._url = String(url);
    this._title = 'Mock: ' + this._url.slice(0, 60);
    this._typed = '';
    this._focused = false;
    await new Promise((r) => setTimeout(r, 50));
    this.emit('framenavigated', this._frame);
    this.emit('load');
  }
  async goBack() {
    this.emit('framenavigated', this._frame);
  }
  async goForward() {
    this.emit('framenavigated', this._frame);
  }
  async reload() {
    this.emit('load');
  }
  async screenshot() {
    return FAKE_JPEG;
  }
  async evaluate(js) {
    const s = String(js);
    if (s.includes("getElementById('t')") || s.includes('getElementById("t")')) return this._typed;
    if (s === 'window.stop()') return true;
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
  }
  async send(method) {
    if (method === 'Page.startScreencast') {
      this._stop();
      this._timer = setInterval(() => {
        this._timer && this.emit('Page.screencastFrame', { data: FAKE_JPEG_B64, sessionId: String(++this._sid) });
      }, 400);
    } else if (method === 'Page.stopScreencast') {
      this._stop();
    }
    // Page.screencastFrameAck نادیده گرفته می‌شود
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
    this._page = new FakePage();
  }
  pages() {
    return this._page.isClosed() ? [] : [this._page];
  }
  async newPage() {
    if (this._page.isClosed()) this._page = new FakePage();
    return this._page;
  }
  async newCDPSession() {
    return new FakeCDP();
  }
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this._ctx = new FakeContext();
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

module.exports = { createMockBrowser };
