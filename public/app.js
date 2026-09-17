'use strict';
/* MajidBridge v2 — کلاینت وب
 * نمایش فریم زنده + ارسال کلیک/تایپ/اسکرول + تاریخچه/نشان‌ها/تنظیمات
 * + کلیپبورد دوطرفه + زوم + تغییر وضوح زنده
 */

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
const homeBtn = $('homeBtn');
const starBtn = $('starBtn');
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
const panel = $('panel');
const panelClose = $('panelClose');
const histList = $('histList');
const bmList = $('bmList');
const clearHistBtn = $('clearHistBtn');
const zoomVal = $('zoomVal');
const zoomIn = $('zoomIn');
const zoomOut = $('zoomOut');
const zoomReset = $('zoomReset');
const copyBtn = $('copyBtn');
const pasteBtn = $('pasteBtn');
const clipInfo = $('clipInfo');
const resInfo = $('resInfo');
const srvInfo = $('srvInfo');
const modeTag = $('modeTag');
const setQuality = $('setQuality');
const setRes = $('setRes');
const customResRow = $('customResRow');
const setW = $('setW');
const setH = $('setH');
const applyResBtn = $('applyResBtn');
const setZoom = $('setZoom');
const setZoomVal = $('setZoomVal');
const setClipSync = $('setClipSync');
const setStartUrl = $('setStartUrl');
const saveStartBtn = $('saveStartBtn');

let ws = null;
let authed = false;
let VW = 1280; // اندازه واقعی صفحه سرور (از hello می‌آید)
let VH = 800;
let zoom = 1;
let framesThisSec = 0;
let reconnectDelay = 1000;
let reconnectTimer = null;
let lastX = 0;
let lastY = 0;
let lastMoveSent = 0;
let toastTimer = null;
let currentUrl = '';
let currentTitle = '';
let activeTab = null;

// تنظیمات محلی کاربر (مرورگر خودش)
const prefs = JSON.parse(localStorage.getItem('mb_prefs') || '{}');
let clipSync = prefs.clipSync !== false; // پیش‌فرض روشن
let autoViewport = prefs.autoViewport === true; // پیش‌فرض خاموش (وضوح سرور ثابت)
function savePrefs() {
  localStorage.setItem('mb_prefs', JSON.stringify({ clipSync, autoViewport }));
}

// شمارش فریم در ثانیه
setInterval(() => {
  fpsEl.textContent = authed ? framesThisSec + ' fps' : '—';
  framesThisSec = 0;
}, 1000);

function setStatus(mode, text) {
  dot.className = 'dot ' + mode;
  statusText.textContent = text;
}

function toast(msg, ok) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('ok', !!ok);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
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

// ── اتصال ───────────────────────────────────────────
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
      case 'info':
      case 'state':
      case 'authed':
        if (msg.type === 'authed') {
          if (!msg.ok) {
            sessionStorage.removeItem('mb_pass');
            authErr.textContent = msg.message || 'رمز اشتباه است';
            overlay.classList.remove('hidden');
            setStatus('wait', 'رمز اشتباه ❌');
            break;
          }
          sessionStorage.setItem(
            'mb_pass',
            passInput.value || sessionStorage.getItem('mb_pass') || ''
          );
          authErr.textContent = '';
          setAuthed(true);
        }
        if (msg.w) VW = msg.w;
        if (msg.h) VH = msg.h;
        if (msg.quality) markQuality(msg.quality);
        if (msg.zoom) setZoomUi(msg.zoom);
        if (typeof msg.headful === 'boolean') {
          modeTag.textContent = msg.headful ? '🖥️ headful' : '🛡️ stealth';
          modeTag.classList.toggle('headful', msg.headful);
          modeTag.title =
            (msg.headful ? 'Chromium با پنجره واقعی روی Xvfb' : 'Chromium headless با stealth') +
            (msg.persistent ? ' + پروفایل ماندگار' : '') +
            (msg.stealth ? ' + ضدشناسایی Cloudflare' : '');
        }
        if (msg.stealth === false) modeTag.textContent = '🧪 mock';
        updateResInfo();
        if (msg.url && document.activeElement !== urlInput) urlInput.value = msg.url;
        if (msg.type === 'hello' && msg.needAuth && !authed) {
          const saved = sessionStorage.getItem('mb_pass');
          if (saved) send({ type: 'auth', password: saved });
          else {
            overlay.classList.remove('hidden');
            setStatus('wait', 'منتظر رمز…');
            passInput.focus();
          }
        } else if (msg.type === 'hello' && !msg.needAuth) {
          setAuthed(true);
        }
        break;

      case 'frame':
        screenImg.src = 'data:image/jpeg;base64,' + msg.data;
        framesThisSec++;
        break;

      case 'nav':
        currentUrl = msg.url || '';
        currentTitle = msg.title || '';
        if (document.activeElement !== urlInput) urlInput.value = currentUrl;
        pageInfo.textContent = (currentTitle ? currentTitle + ' — ' : '') + currentUrl;
        pageInfo.title = currentUrl;
        break;

      case 'loading':
        loadingEl.classList.toggle('hidden', !msg.value);
        break;

      case 'quality':
        markQuality(msg.value);
        break;

      case 'viewport':
        VW = msg.w || VW;
        VH = msg.h || VH;
        updateResInfo();
        toast(`وضوح سرور: ${VW}×${VH}`, true);
        break;

      case 'zoom':
        setZoomUi(msg.value);
        break;

      case 'history':
        renderHistory(msg.items || []);
        break;

      case 'bookmarks':
        renderBookmarks(msg.items || []);
        break;

      case 'settings':
        applySettings(msg.settings || {});
        break;

      case 'clipboard':
        onRemoteClipboard(msg.text || '');
        break;

      case 'toast':
        toast(msg.message || '');
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
homeBtn.onclick = () => send({ type: 'home' });
starBtn.onclick = () => send({ type: 'bookmarkAdd' });

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
  if (setQuality && setQuality.value !== q) setQuality.value = q;
}
document.querySelectorAll('.quality button').forEach((b) => {
  b.onclick = () => {
    markQuality(b.dataset.q);
    send({ type: 'quality', value: b.dataset.q });
  };
});

// ── تب‌ها: تاریخچه / نشان‌ها / تنظیمات ───────────────
function openTab(name) {
  if (activeTab === name) return closePanel();
  activeTab = name;
  panel.classList.remove('hidden');
  panelClose.classList.remove('hidden');
  ['history', 'bookmarks', 'settings'].forEach((t) => {
    $('panel-' + t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('.tabbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'history') send({ type: 'getHistory' });
  if (name === 'bookmarks') send({ type: 'getBookmarks' });
  if (name === 'settings') send({ type: 'getSettings' });
}
function closePanel() {
  activeTab = null;
  panel.classList.add('hidden');
  panelClose.classList.add('hidden');
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.remove('active'));
}
document.querySelectorAll('.tabbtn').forEach((b) => {
  b.onclick = () => openTab(b.dataset.tab);
});
panelClose.onclick = closePanel;

function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' ثانیه پیش';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' دقیقه پیش';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ساعت پیش';
  return Math.round(h / 24) + ' روز پیش';
}

function renderHistory(items) {
  histList.innerHTML = '';
  if (!items.length) {
    histList.innerHTML = '<li class="empty">هنوز چیزی نیست</li>';
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title || it.url;
    t.title = it.url;
    t.onclick = () => send({ type: 'navigate', url: it.url });
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = it.url;
    const when = document.createElement('span');
    when.className = 'u';
    when.style.maxWidth = '90px';
    when.textContent = timeAgo(it.ts || Date.now());
    li.append(t, u, when);
    histList.appendChild(li);
  });
}

function renderBookmarks(items) {
  bmList.innerHTML = '';
  if (!items.length) {
    bmList.innerHTML = '<li class="empty">با ☆ صفحه‌ی جاری را نشان کن</li>';
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title || it.url;
    t.title = it.url;
    t.onclick = () => send({ type: 'navigate', url: it.url });
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = it.url;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.title = 'حذف';
    rm.onclick = () => send({ type: 'bookmarkRemove', url: it.url });
    li.append(t, u, rm);
    bmList.appendChild(li);
  });
}

clearHistBtn.onclick = () => send({ type: 'clearHistory' });

// ── تنظیمات ─────────────────────────────────────────
function applySettings(s) {
  if (s.quality && setQuality.value !== s.quality) {
    setQuality.value = s.quality;
    markQuality(s.quality);
  }
  if (s.zoom) setZoomUi(s.zoom);
  if (s.w && s.h) {
    VW = s.w;
    VH = s.h;
    updateResInfo();
    const v = `${s.w}x${s.h}`;
    const has = Array.from(setRes.options).some((o) => o.value === v);
    if (has) setRes.value = v;
    else if (!autoViewport) setRes.value = 'custom';
    setW.value = s.w;
    setH.value = s.h;
  }
  if (s.startUrl && document.activeElement !== setStartUrl) setStartUrl.value = s.startUrl;
  if (srvInfo) {
    srvInfo.textContent = `stealth:${modeTag.textContent.trim()} | ${VW}×${VH} | zoom ${Math.round(
      zoom * 100
    )}%`;
  }
}

function updateResInfo() {
  resInfo.textContent = VW + '×' + VH;
}

setQuality.onchange = () => send({ type: 'quality', value: setQuality.value });

setRes.onchange = () => {
  const v = setRes.value;
  if (v === 'custom') {
    customResRow.classList.remove('hidden');
    return;
  }
  if (v === 'auto') {
    autoViewport = true;
    savePrefs();
    sendViewport(window.innerWidth, Math.max(400, window.innerHeight - 210));
    return;
  }
  autoViewport = false;
  savePrefs();
  customResRow.classList.add('hidden');
  const [w, h] = v.split('x');
  sendViewport(w, h);
};

applyResBtn.onclick = () => sendViewport(setW.value, setH.value);

function sendViewport(w, h) {
  w = Math.round(Number(w));
  h = Math.round(Number(h));
  if (!w || !h) return;
  send({ type: 'viewport', w, h });
}

// اگر «خودکار» انتخاب شده، با تغییر اندازه پنجره وضوح سرور هم عوض شود
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!autoViewport || !authed) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(
    () => sendViewport(window.innerWidth, Math.max(400, window.innerHeight - 210)),
    600
  );
});

saveStartBtn.onclick = () => {
  const u = (setStartUrl.value || '').trim();
  if (!u) return;
  send({ type: 'setStartUrl', value: u });
  toast('صفحه‌ی شروع ذخیره شد ✅', true);
};

setClipSync.onclick = () => {
  clipSync = !clipSync;
  savePrefs();
  setClipSync.textContent = clipSync ? 'روشن' : 'خاموش';
  setClipSync.classList.toggle('on', clipSync);
  toast(clipSync ? 'همگام‌سازی کلیپبورد روشن شد' : 'همگام‌سازی کلیپبورد خاموش شد', clipSync);
};
setClipSync.textContent = clipSync ? 'روشن' : 'خاموش';
setClipSync.classList.toggle('on', clipSync);

// ── زوم ─────────────────────────────────────────────
function setZoomUi(z) {
  zoom = Number(z) || 1;
  const pct = Math.round(zoom * 100) + '%';
  zoomVal.textContent = pct;
  if (setZoomVal) setZoomVal.textContent = pct;
  if (setZoom) setZoom.value = String(Math.round(zoom * 100));
  if (srvInfo)
    srvInfo.textContent = `stealth:${modeTag.textContent.trim()} | ${VW}×${VH} | zoom ${Math.round(
      zoom * 100
    )}%`;
}
zoomIn.onclick = () => send({ type: 'zoom', value: Math.min(3, zoom + 0.1) });
zoomOut.onclick = () => send({ type: 'zoom', value: Math.max(0.5, zoom - 0.1) });
zoomReset.onclick = () => send({ type: 'zoom', value: 1 });
setZoom.oninput = () => {
  const pct = Math.round(Number(setZoom.value));
  setZoomVal.textContent = pct + '%';
};
setZoom.onchange = () => send({ type: 'zoom', value: Number(setZoom.value) / 100 });

// ── کلیپبورد دوطرفه ─────────────────────────────────
// سرور → مرورگر تو
async function onRemoteClipboard(text) {
  if (!text) return;
  clipInfo.textContent = '📋 ' + text.replace(/\s+/g, ' ').slice(0, 80);
  clipInfo.classList.remove('hidden');
  clipInfo.title = text;
  let written = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      written = true;
    }
  } catch (_) {
    written = false;
  }
  if (!written) {
    // راه جایگزین: textarea موقت + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01;width:1px;height:1px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      written = true;
    } catch (_) {
      written = false;
    }
  }
  toast(written ? 'کپی شد ✅ (Ctrl+V بزن)' : 'متن انتخاب شد — دکمه کپی مرورگرت را بزن', written);
}

// مرورگر تو → سرور
async function readLocalClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const t = await navigator.clipboard.readText();
      if (t) return t;
    }
  } catch (_) {
    /* اجازه داده نشد */
  }
  return prompt('متن را اینجا paste کن (Ctrl+V) تا در صفحه سرور چسبانده شود:') || '';
}

copyBtn.onclick = () => send({ type: 'copyText' });
pasteBtn.onclick = async () => {
  const t = await readLocalClipboard();
  if (t) send({ type: 'pasteText', text: t });
};

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
    // Ctrl+چرخ = زوم (مثل مرورگر واقعی)
    if (e.ctrlKey) {
      const next = Math.max(0.5, Math.min(3, zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
      send({ type: 'zoom', value: next });
      return;
    }
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

  const mod = e.ctrlKey || e.metaKey;

  // میانبرهای v2
  if (mod && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    if (clipSync) send({ type: 'combo', combo: 'copy' });
    else send({ type: 'key', action: 'down', key: e.key });
    return;
  }
  if (mod && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    if (!clipSync) return send({ type: 'key', action: 'down', key: e.key });
    readLocalClipboard().then((t) => {
      if (t) send({ type: 'combo', combo: 'paste', text: t });
      else send({ type: 'combo', combo: 'paste' }); // از کلیپبورد خود سرور
    });
    return;
  }
  if (mod && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault();
    if (clipSync) send({ type: 'combo', combo: 'cut' });
    return;
  }
  if (mod && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    send({ type: 'zoom', value: Math.min(3, zoom + 0.1) });
    return;
  }
  if (mod && (e.key === '-' || e.key === '_')) {
    e.preventDefault();
    send({ type: 'zoom', value: Math.max(0.5, zoom - 0.1) });
    return;
  }
  if (mod && (e.key === '0')) {
    e.preventDefault();
    send({ type: 'zoom', value: 1 });
    return;
  }
  if (mod && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    urlInput.focus();
    urlInput.select();
    return;
  }
  if (mod && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault();
    openTab('history');
    return;
  }
  if (e.key === 'Escape' && activeTab) {
    closePanel();
    return;
  }

  e.preventDefault();
  if (e.key.length === 1 && !mod && !e.altKey) {
    // حرف معمولی (فارسی/انگلیسی/عدد)
    send({ type: 'key', action: 'type', text: e.key });
  } else {
    // کلید خاص یا میانبر (Enter ،Backspace ،Ctrl+A و…)
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

setZoomUi(1);
updateResInfo();
connect();
