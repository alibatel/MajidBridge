/* تست خودکار MajidBridge v2 — ۱۴ تست اصلی (+۱ تست سایت واقعی وقتی اینترنت و Chromium هست)
 *
 * اجرا با مرورگر واقعی:
 *   ALLOW_EVAL=true PASSWORD=testpass node server.js          # ترمینال ۱
 *   TEST_URL=http://127.0.0.1:3000 PASSWORD=testpass npm test # ترمینال ۲
 *
 * اجرا بدون Chromium (تست کامل پروتکل و رابط با مرورگر مجازی):
 *   MOCK_BROWSER=true ALLOW_EVAL=true PASSWORD=testpass node server.js
 *   PASSWORD=testpass npm test
 */
const BASE = process.env.TEST_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const PASSWORD = process.env.PASSWORD || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let checks = 0;
let skipped = 0;
const ok = (name) => {
  checks++;
  console.log(`  ✅ ${name}`);
};
const fail = (name, why) => {
  checks++;
  failures++;
  console.log(`  ❌ ${name}${why ? ' — ' + why : ''}`);
};
const skip = (name, why) => {
  skipped++;
  console.log(`  ⏭️ ${name}${why ? ' — ' + why : ''}`);
};

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('وصل نشد (timeout)')), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('خطای اتصال وب‌سوکت'));
    };
  });
}

// منتظر پیامی که شرط را پاس کند
function waitFor(ws, pred, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('timeout'));
    }, timeoutMs);
    function onMsg(ev) {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(m);
      }
    }
    ws.addEventListener('message', onMsg);
  });
}

// مثل waitFor ولی به‌جای شکست، null برمی‌گرداند
async function waitForOrNull(ws, pred, timeoutMs = 15000) {
  try {
    return await waitFor(ws, pred, timeoutMs);
  } catch {
    return null;
  }
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

let evalId = 0;
async function remoteEval(ws, js, timeoutMs = 15000) {
  const id = ++evalId;
  send(ws, { type: '__eval', id, js });
  const res = await waitFor(ws, (m) => m.type === '__evalResult' && m.id === id, timeoutMs);
  if (!res.ok) throw new Error(res.error || 'eval failed');
  return res.result;
}

// صفحه‌ی آزمایشی محلی (بدون نیاز به اینترنت)
const LOCAL_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<meta charset="utf-8"><body style="margin:0;background:#fff">` +
      `<input id="t" style="position:absolute;left:100px;top:120px;width:400px;height:40px;font-size:24px">` +
      `<div style="position:absolute;left:100px;top:220px;width:600px;height:400px;background:#eee">scroll area</div>` +
      `</body>`
  );

async function main() {
  console.log('🧪 تست MajidBridge v2 →', BASE);

  // ۱) سلامت سرور + گزارش نسخه/حالت
  let health = null;
  try {
    const r = await fetch(BASE + '/health');
    health = await r.json();
    if (health.ok && health.version === 2)
      ok(
        `سرور سالم است (/health v2) — headful:${!!health.headful} stealth:${!!health.stealth} persistent:${!!health.persistent}`
      );
    else fail('سرور سالم است', JSON.stringify(health));
  } catch (e) {
    fail('سرور سالم است', e.message);
    process.exit(1);
  }

  // ۲) صفحه وب سرو می‌شود؟ (با اجزای جدید v2)
  try {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    const need = ['MajidBridge', 'id="screen"', 'id="panel-history"', 'id="panel-bookmarks"', 'id="panel-settings"'];
    const missing = need.filter((n) => !html.includes(n));
    if (!missing.length) ok('رابط وب v2 سرو می‌شود (تب‌های تاریخچه/نشان‌ها/تنظیمات)');
    else fail('رابط وب v2 سرو می‌شود', 'کم دارد: ' + missing.join(', '));
  } catch (e) {
    fail('رابط وب v2 سرو می‌شود', e.message);
  }

  // ۳) وب‌سوکت
  const ws = await connect().catch((e) => {
    fail('اتصال وب‌سوکت', e.message);
    process.exit(1);
  });
  ok('اتصال وب‌سوکت برقرار شد');

  // ۴) پیام hello با فیلدهای v2 (وضوح/زوم/حالت)
  const hello = await waitForOrNull(ws, (m) => m.type === 'hello');
  if (!hello) {
    fail('پیام hello با فیلدهای v2', 'timeout');
    process.exit(1);
  }
  const helloMissing = ['w', 'h', 'zoom', 'quality'].filter((k) => hello[k] === undefined);
  if (!helloMissing.length)
    ok(`پیام hello رسید (${hello.w}×${hello.h}، زوم ${hello.zoom}، کیفیت ${hello.quality}، رمز: ${hello.needAuth ? 'لازم' : 'لازم نیست'})`);
  else fail('پیام hello با فیلدهای v2', 'کم دارد: ' + helloMissing.join(', '));

  // ۵) احراز هویت
  if (hello.needAuth) {
    send(ws, { type: 'auth', password: PASSWORD });
    const a = await waitForOrNull(ws, (m) => m.type === 'authed');
    if (a && a.ok) ok('احراز هویت با رمز درست شد');
    else {
      fail('احراز هویت', 'رمز قبول نشد (PASSWORD را چک کن)');
      process.exit(1);
    }
  } else {
    ok('احراز هویت لازم نبود (PASSWORD خالی است)');
  }

  // ۶) باز کردن یک صفحه (اینترنت لازم ندارد)
  send(ws, { type: 'navigate', url: LOCAL_PAGE });
  const nav1 = await waitForOrNull(ws, (m) => m.type === 'nav' && m.url && m.url.startsWith('data:'), 30000);
  if (nav1) ok('ناوبری به صفحه‌ی آزمایشی درست کار کرد');
  else fail('ناوبری به صفحه‌ی آزمایشی', 'پیام nav برنگشت');
  await sleep(700);

  // ۷) فریم زنده JPEG
  const frames = [];
  const frameListener = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'frame' && m.data) frames.push(m.data);
    } catch {
      /* نادیده */
    }
  };
  ws.addEventListener('message', frameListener);
  for (let i = 0; i < 40 && frames.length < 2; i++) await sleep(250);
  if (frames.length >= 1 && frames[0].startsWith('/9j/')) {
    const avgKB = Math.round(
      frames.reduce((a, f) => a + Math.round((f.length * 3) / 4 / 1024), 0) / frames.length
    );
    ok(`فریم زنده JPEG رسید (${frames.length} فریم، میانگین ~${avgKB}KB)`);
  } else if (frames.length >= 1) {
    fail('فریم زنده', 'فرمت فریم JPEG نیست');
  } else {
    fail('فریم زنده', 'هیچ فریمی نیامد');
  }

  // ۸) کلیک + تایپ فارسی
  send(ws, { type: 'mouse', action: 'down', x: 300, y: 140, button: 0 });
  await sleep(150);
  send(ws, { type: 'mouse', action: 'up', x: 300, y: 140, button: 0 });
  await sleep(350);
  const typed = 'hello سلام 123';
  send(ws, { type: 'key', action: 'type', text: typed });
  await sleep(700);
  try {
    const val = await remoteEval(
      ws,
      `document.getElementById('t') ? document.getElementById('t').value : 'NO_INPUT'`
    );
    if (val === typed) ok(`کلیک + تایپ فارسی درست کار کرد («${val}»)`);
    else fail('کلیک + تایپ فارسی', `مقدار فیلد: «${val}» (انتظار: «${typed}»)`);
  } catch (e) {
    fail('کلیک + تایپ فارسی', e.message + ' (سرور با ALLOW_EVAL=true روشن است؟)');
  }

  // ۹) اسکرول + عقب/جلو/تازه‌سازی
  try {
    send(ws, { type: 'mouse', action: 'wheel', x: 400, y: 320, deltaX: 0, deltaY: 300 });
    await sleep(250);
    send(ws, { type: 'back' });
    await sleep(450);
    send(ws, { type: 'forward' });
    await sleep(450);
    send(ws, { type: 'reload' });
    await sleep(700);
    ok('اسکرول + عقب/جلو/تازه‌سازی بدون خطا');
  } catch (e) {
    fail('اسکرول + عقب/جلو/تازه‌سازی', e.message);
  }

  // ۱۰) تغییر کیفیت
  try {
    send(ws, { type: 'quality', value: 'low' });
    const q1 = await waitFor(ws, (m) => m.type === 'quality' && m.value === 'low', 15000);
    send(ws, { type: 'quality', value: 'high' });
    const q2 = await waitFor(ws, (m) => m.type === 'quality' && m.value === 'high', 15000);
    send(ws, { type: 'quality', value: 'medium' });
    await waitForOrNull(ws, (m) => m.type === 'quality' && m.value === 'medium', 15000);
    if (q1 && q2) ok('تغییر کیفیت تصویر (low → high → medium)');
    else fail('تغییر کیفیت تصویر', 'پیام quality برنگشت');
  } catch (e) {
    fail('تغییر کیفیت تصویر', e.message);
  }

  // ۱۱) تغییر وضوح زنده
  try {
    send(ws, { type: 'viewport', w: 1024, h: 768 });
    const v = await waitFor(ws, (m) => m.type === 'viewport', 20000);
    if (v && v.w === 1024 && v.h === 768) ok(`تغییر وضوح زنده کار کرد (${v.w}×${v.h})`);
    else fail('تغییر وضوح زنده', v ? `مقدار برگشتی ${v.w}×${v.h}` : 'پیام viewport برنگشت');
    send(ws, { type: 'viewport', w: 1280, h: 800 });
    await waitForOrNull(ws, (m) => m.type === 'viewport' && m.w === 1280, 20000);
  } catch (e) {
    fail('تغییر وضوح زنده', e.message);
  }

  // ۱۲) زوم
  try {
    send(ws, { type: 'zoom', value: 1.5 });
    const z = await waitFor(ws, (m) => m.type === 'zoom', 20000);
    if (z && Math.abs(Number(z.value) - 1.5) < 0.01) ok(`زوم زنده کار کرد (${Math.round(z.value * 100)}%)`);
    else fail('زوم زنده', z ? `مقدار برگشتی ${z.value}` : 'پیام zoom برنگشت');
    send(ws, { type: 'zoom', value: 1 });
    await waitForOrNull(ws, (m) => m.type === 'zoom', 15000);
  } catch (e) {
    fail('زوم زنده', e.message);
  }

  // ۱۳) تاریخچه
  try {
    send(ws, { type: 'getHistory' });
    const h = await waitFor(ws, (m) => m.type === 'history', 15000);
    const items = h.items || [];
    if (items.length >= 1 && items[0].url)
      ok(`تاریخچه ثبت می‌شود (${items.length} مورد، آخرین: ${items[0].url.slice(0, 40)}…)`);
    else fail('تاریخچه ثبت می‌شود', 'لیست خالی بود');
  } catch (e) {
    fail('تاریخچه ثبت می‌شود', e.message);
  }

  // ۱۴) نشان‌ها (افزودن + حذف)
  try {
    send(ws, { type: 'bookmarkAdd' });
    const b1 = await waitFor(
      ws,
      (m) => m.type === 'bookmarks' && Array.isArray(m.items) && m.items.length >= 1,
      15000
    );
    const added = b1.items[0];
    send(ws, { type: 'bookmarkRemove', url: added.url });
    const b2 = await waitFor(
      ws,
      (m) => m.type === 'bookmarks' && Array.isArray(m.items) && !m.items.some((x) => x.url === added.url),
      15000
    );
    if (b1 && b2) ok('نشان‌ها: افزودن و حذف کار کرد ⭐');
    else fail('نشان‌ها', 'حذف انجام نشد');
  } catch (e) {
    fail('نشان‌ها', e.message);
  }

  // ۱۵) کلیپبورد دوطرفه (کپی از سرور + چسباندن در سرور)
  try {
    let copyOk = false;
    if (health && health.stealth) {
      // مرورگر واقعی: متن را انتخاب کن بعد Ctrl+C
      await remoteEval(ws, `(function(){ var i=document.getElementById('t'); if(i){ i.focus(); i.select(); } })()`);
      await sleep(300);
      send(ws, { type: 'combo', combo: 'copy' });
      const c = await waitForOrNull(ws, (m) => m.type === 'clipboard' && m.text, 15000);
      copyOk = !!c && String(c.text).length > 0;
    } else {
      // حالت mock: مسیر «چیزی انتخاب نشده» باید پیام دهد
      send(ws, { type: 'copyText' });
      const t = await waitForOrNull(ws, (m) => m.type === 'toast' || m.type === 'clipboard', 15000);
      copyOk = !!t;
    }

    const secret = 'paste-test-1234';
    send(ws, { type: 'pasteText', text: secret });
    await sleep(800);
    const clip = await remoteEval(
      ws,
      `navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText().catch(function(){return ''}) : ''`
    );
    const pasteOk = String(clip).includes(secret);
    if (copyOk && pasteOk) ok('کلیپبورد دوطرفه: کپی از سرور + چسباندن در سرور 📋');
    else fail('کلیپبورد دوطرفه', `copy=${copyOk} paste=${pasteOk} (clip=«${clip}»)`);
  } catch (e) {
    fail('کلیپبورد دوطرفه', e.message);
  }

  ws.removeEventListener('message', frameListener);

  // ۱۶) سایت عمومی واقعی — فقط وقتی اینترنت و Chromium واقعی در دسترس باشد
  if (health && health.stealth) {
    console.log('  🌐 باز کردن https://example.com ...');
    send(ws, { type: 'navigate', url: 'https://example.com/' });
    const nav = await waitForOrNull(
      ws,
      (m) => m.type === 'nav' && m.url && m.url.includes('example.com'),
      45000
    );
    if (nav) ok(`سایت عمومی باز شد: ${nav.url} («${nav.title}»)`);
    else fail('باز کردن سایت عمومی', 'آدرس example.com برنگشت (اینترنت سرور چک شود)');
  } else {
    skip('سایت عمومی واقعی', 'حالت MOCK است (اینترنت/Chromium لازم دارد)');
  }

  ws.close();

  console.log(
    failures === 0
      ? `\n🎉 همه‌ی ${checks} تست پاس شد!${skipped ? ` (${skipped} مورد رد شد چون Chromium/اینترنت در دسترس نبود)` : ''}`
      : `\n⚠️ ${failures} از ${checks} تست شکست خورد`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('خطای تست:', e);
  process.exit(1);
});
