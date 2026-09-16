'use strict';
/* MajidBridge — کلاینت وب: نمایش فریم زنده + ارسال کلیک/تایپ/اسکرول */

const $ = (id) => document.getElementById(id);
const screenImg = $('screen');
const viewer = $('viewer');
const dot = $('dot');
const statusText = $('statusText');
const urlInput = $('urlInput');
const goBtn = $('goBtn');
const backBtn = $('backBtn');
const fwdBtn = $('fwdBtn');
const reloadBtn = $('reloadBtn');
const overlay = $('overlay');
const passInput = $('passInput');
const authBtn = $('authBtn');
const authErr = $('authErr');
const loadingEl = $('loading');
const toastEl = $('toast');
const pageInfo = $('pageInfo');
const fpsEl = $('fps');
const kbdInput = $('kbd');
const kbdBtn = $('kbdBtn');
const fsBtn = $('fsBtn');

let ws = null;
let authed = false;
let VW = 1280; // اندازه واقعی صفحه سرور (از hello می‌آید)
let VH = 800;
let framesThisSec = 0;
let reconnectDelay = 1000;
let reconnectTimer = null;
let lastX = 0;
let lastY = 0;
let lastMoveSent = 0;
let toastTimer = null;

// شمارش فریم در ثانیه
setInterval(() => {
  fpsEl.textContent = authed ? framesThisSec + ' fps' : '—';
  framesThisSec = 0;
}, 1000);

function setStatus(mode, text) {
  dot.className = 'dot ' + mode;
  statusText.textContent = text;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4000);
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {
      /* نادیده */
    }
  }
}

function setAuthed(v) {
  authed = v;
  if (v) {
    overlay.classList.add('hidden');
    setStatus('on', 'وصل شد ✅');
    reconnectDelay = 1000;
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setStatus('wait', 'در حال اتصال…');
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = () => {
    // منتظر پیام hello می‌مانیم
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    switch (msg.type) {
      case 'hello':
        VW = msg.w || 1280;
        VH = msg.h || 800;
        markQuality(msg.quality);
        if (!msg.needAuth) {
          setAuthed(true);
        } else {
          const saved = sessionStorage.getItem('mb_pass');
          if (saved) {
            send({ type: 'auth', password: saved });
          } else {
            overlay.classList.remove('hidden');
            setStatus('wait', 'منتظر رمز…');
            passInput.focus();
          }
        }
        if (msg.url && document.activeElement !== urlInput) urlInput.value = msg.url;
        break;

      case 'authed':
        if (msg.ok) {
          sessionStorage.setItem('mb_pass', passInput.value || sessionStorage.getItem('mb_pass') || '');
          authErr.textContent = '';
          setAuthed(true);
        } else {
          sessionStorage.removeItem('mb_pass');
          authErr.textContent = msg.message || 'رمز اشتباه است';
          overlay.classList.remove('hidden');
          setStatus('wait', 'رمز اشتباه ❌');
        }
        break;

      case 'frame':
        screenImg.src = 'data:image/jpeg;base64,' + msg.data;
        framesThisSec++;
        break;

      case 'nav':
        if (document.activeElement !== urlInput) urlInput.value = msg.url || '';
        pageInfo.textContent = (msg.title ? msg.title + ' — ' : '') + (msg.url || '');
        pageInfo.title = msg.url || '';
        break;

      case 'loading':
        loadingEl.classList.toggle('hidden', !msg.value);
        break;

      case 'quality':
        markQuality(msg.value);
        break;

      case 'error':
        toast(msg.message || 'خطا');
        break;

      case 'pong':
        break;

      default:
        break;
    }
  };

  ws.onclose = () => scheduleReconnect('قطع شد، تلاش مجدد…');
  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {
      /* نادیده */
    }
  };
}

function scheduleReconnect(text) {
  setAuthedSilent(false);
  setStatus('off', text);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

function setAuthedSilent(v) {
  authed = v;
}

// زنده نگه داشتن اتصال (مهم پشت proxy)
setInterval(() => send({ type: 'ping' }), 25000);

// ── ناوبری ──────────────────────────────────────────
function doGo() {
  const u = urlInput.value.trim();
  if (!u) return;
  urlInput.blur();
  send({ type: 'navigate', url: u });
}
goBtn.onclick = doGo;
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doGo();
  } else if (e.key === 'Escape') {
    urlInput.blur();
  }
});
backBtn.onclick = () => send({ type: 'back' });
fwdBtn.onclick = () => send({ type: 'forward' });
reloadBtn.onclick = () => send({ type: 'reload' });

// ── ورود ────────────────────────────────────────────
function doAuth() {
  authErr.textContent = '';
  send({ type: 'auth', password: passInput.value });
}
authBtn.onclick = doAuth;
passInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doAuth();
  }
});

// ── کیفیت ───────────────────────────────────────────
function markQuality(q) {
  document.querySelectorAll('.quality button').forEach((b) => {
    b.classList.toggle('active', b.dataset.q === q);
  });
}
document.querySelectorAll('.quality button').forEach((b) => {
  b.onclick = () => {
    markQuality(b.dataset.q);
    send({ type: 'quality', value: b.dataset.q });
  };
});

// ── تمام‌صفحه و کیبورد موبایل ────────────────────────
fsBtn.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else viewer.requestFullscreen().catch(() => {});
};
kbdBtn.onclick = () => {
  kbdInput.focus();
  toast('کیبورد باز شد؛ تایپ کن ⌨️');
};
kbdInput.addEventListener('input', () => {
  const v = kbdInput.value;
  if (v) {
    send({ type: 'key', action: 'type', text: v });
    kbdInput.value = '';
  }
});
kbdInput.addEventListener('keydown', (e) => {
  // کلیدهای خاص موبایل (Enter / Backspace) که input تولید نمی‌کند
  if (e.key === 'Enter') {
    e.preventDefault();
    send({ type: 'key', action: 'press', key: 'Enter' });
  } else if (e.key === 'Backspace' && !kbdInput.value) {
    e.preventDefault();
    send({ type: 'key', action: 'press', key: 'Backspace' });
  }
});

// ── موس: تبدیل مختصات عکس به مختصات واقعی سرور ──────
function toViewport(clientX, clientY) {
  const r = screenImg.getBoundingClientRect();
  const x = ((clientX - r.left) * VW) / Math.max(1, r.width);
  const y = ((clientY - r.top) * VH) / Math.max(1, r.height);
  lastX = Math.round(x);
  lastY = Math.round(y);
  return { x: lastX, y: lastY };
}

screenImg.addEventListener('mousemove', (e) => {
  if (!authed) return;
  const now = performance.now();
  if (now - lastMoveSent < 33) return; // حد ~۳۰ پیام در ثانیه
  lastMoveSent = now;
  const p = toViewport(e.clientX, e.clientY);
  send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
});

screenImg.addEventListener('mousedown', (e) => {
  if (!authed) return;
  e.preventDefault();
  const p = toViewport(e.clientX, e.clientY);
  send({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: e.button });
});

window.addEventListener('mouseup', (e) => {
  if (!authed) return;
  // mouseup روی window تا اگر بیرون عکس رها شد، کلیک گیر نکند
  const p = toViewport(e.clientX, e.clientY);
  send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: e.button });
});

screenImg.addEventListener(
  'wheel',
  (e) => {
    if (!authed) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1; // خط → پیکسل
    toViewport(e.clientX, e.clientY);
    send({
      type: 'mouse',
      action: 'wheel',
      x: lastX,
      y: lastY,
      deltaX: Math.round(e.deltaX * k),
      deltaY: Math.round(e.deltaY * k),
    });
  },
  { passive: false }
);

screenImg.addEventListener('contextmenu', (e) => e.preventDefault());
screenImg.addEventListener('dragstart', (e) => e.preventDefault());

// ── لمسی (موبایل/تبلت) ───────────────────────────────
screenImg.addEventListener(
  'touchstart',
  (e) => {
    if (!authed) return;
    e.preventDefault();
    const t = e.touches[0];
    const p = toViewport(t.clientX, t.clientY);
    send({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: 0 });
  },
  { passive: false }
);
screenImg.addEventListener(
  'touchmove',
  (e) => {
    if (!authed) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastMoveSent < 50) return;
    lastMoveSent = now;
    const t = e.touches[0];
    const p = toViewport(t.clientX, t.clientY);
    send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
  },
  { passive: false }
);
screenImg.addEventListener('touchend', (e) => {
  if (!authed) return;
  e.preventDefault();
  send({ type: 'mouse', action: 'up', x: lastX, y: lastY, button: 0 });
});

// ── کیبورد ──────────────────────────────────────────
function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (!authed) return;
  if (isTypingTarget(e.target)) return; // تایپ داخل آدرس‌بار/رمز محلی است
  if (e.key === 'F12' || e.key === 'F11') return; // اجازه به مرورگر
  e.preventDefault();
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // حرف معمولی (فارسی/انگلیسی/عدد)
    send({ type: 'key', action: 'type', text: e.key });
  } else {
    // کلید خاص یا میانبر (Enter ،Backspace ،Ctrl+C و…)
    send({ type: 'key', action: 'down', key: e.key });
  }
});

window.addEventListener('keyup', (e) => {
  if (!authed) return;
  if (isTypingTarget(e.target)) return;
  if (e.key === 'F12' || e.key === 'F11') return;
  e.preventDefault();
  if (!(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    send({ type: 'key', action: 'up', key: e.key });
  }
});

// اگر پنجره فوکس را از دست داد، کلیدهای نگه‌داشته رها شوند (گیر نکند)
window.addEventListener('blur', () => {
  ['Shift', 'Control', 'Alt', 'Meta'].forEach((k) => send({ type: 'key', action: 'up', key: k }));
});

connect();
