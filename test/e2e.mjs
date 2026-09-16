/* تست خودکار MajidBridge — بدون نیاز به مرورگر واقعی
 * اجرا: سرور را با ALLOW_EVAL=true روشن کن، بعد: npm test
 *   ALLOW_EVAL=true PASSWORD=testpass node server.js
 *   TEST_URL=http://127.0.0.1:3000 PASSWORD=testpass npm test
 */
const BASE = process.env.TEST_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const PASSWORD = process.env.PASSWORD || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const fail = (name, why) => {
  failures++;
  console.log(`  ❌ ${name}${why ? ' — ' + why : ''}`);
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

async function main() {
  console.log('🧪 تست MajidBridge →', BASE);

  // ۱) سلامت سرور
  try {
    const r = await fetch(BASE + '/health');
    const j = await r.json();
    if (j.ok) ok('سرور سالم است (/health)');
    else fail('سرور سالم است', JSON.stringify(j));
  } catch (e) {
    fail('سرور سالم است', e.message);
    process.exit(1);
  }

  // ۲) صفحه وب سرو می‌شود؟
  try {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    if (html.includes('MajidBridge') && html.includes('id="screen"')) ok('رابط وب سرو می‌شود');
    else fail('رابط وب سرو می‌شود', 'محتوای غیرمنتظره');
  } catch (e) {
    fail('رابط وب سرو می‌شود', e.message);
  }

  // ۳) وب‌سوکت + احراز هویت
  const ws = await connect().catch((e) => {
    fail('اتصال وب‌سوکت', e.message);
    process.exit(1);
  });
  ok('اتصال وب‌سوکت برقرار شد');

  const hello = await waitFor(ws, (m) => m.type === 'hello').catch(() => null);
  if (!hello) {
    fail('دریافت hello', 'timeout');
    process.exit(1);
  }
  ok(`پیام hello رسید (صفحه ${hello.w}×${hello.h}، رمز: ${hello.needAuth ? 'لازم' : 'لازم نیست'})`);

  if (hello.needAuth) {
    send(ws, { type: 'auth', password: PASSWORD });
    const a = await waitFor(ws, (m) => m.type === 'authed').catch(() => null);
    if (a && a.ok) ok('احراز هویت با رمز درست شد');
    else {
      fail('احراز هویت', 'رمز قبول نشد (PASSWORD را چک کن)');
      process.exit(1);
    }
  }

  // ۴) باز کردن یک سایت عمومی واقعی
  console.log('  🌐 باز کردن https://example.com ...');
  send(ws, { type: 'navigate', url: 'https://example.com/' });
  const nav = await waitFor(
    ws,
    (m) => m.type === 'nav' && m.url && m.url.includes('example.com'),
    40000
  ).catch(() => null);
  if (nav) ok(`سایت عمومی باز شد: ${nav.url} («${nav.title}»)`);
  else fail('باز کردن سایت عمومی', 'آدرس example.com برنگشت');

  // ۵) گرفتن فریم زنده (باید JPEG واقعی باشد)
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
  // چند ثانیه صبر کن تا فریم بیاید
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

  // ۶) کلیک + تایپ فارسی روی یک صفحه آزمایشی
  const testHtml = `<meta charset="utf-8"><body style="margin:0;background:#fff">` +
    `<input id="t" style="position:absolute;left:100px;top:120px;width:400px;height:40px;font-size:24px"></body>`;
  send(ws, { type: 'navigate', url: 'data:text/html,' + encodeURIComponent(testHtml) });
  await waitFor(ws, (m) => m.type === 'nav' && m.url && m.url.startsWith('data:'), 20000).catch(() => null);
  await sleep(800); // صبر برای رندر

  send(ws, { type: 'mouse', action: 'down', x: 300, y: 140, button: 0 });
  await sleep(150);
  send(ws, { type: 'mouse', action: 'up', x: 300, y: 140, button: 0 });
  await sleep(400);
  const typed = 'hello سلام 123';
  send(ws, { type: 'key', action: 'type', text: typed });
  await sleep(800);

  try {
    const val = await remoteEval(ws, `document.getElementById('t') ? document.getElementById('t').value : 'NO_INPUT'`);
    if (val === typed) ok(`کلیک + تایپ فارسی درست کار کرد («${val}»)`);
    else fail('کلیک + تایپ فارسی', `مقدار فیلد: «${val}» (انتظار: «${typed}»)`);
  } catch (e) {
    fail('کلیک + تایپ فارسی', e.message + ' (سرور با ALLOW_EVAL=true روشن است؟)');
  }

  // ۷) اسکرول + کیفیت + عقب/جلو (فقطcrash نکند)
  try {
    send(ws, { type: 'mouse', action: 'wheel', x: 640, y: 400, deltaX: 0, deltaY: 300 });
    await sleep(300);
    send(ws, { type: 'quality', value: 'low' });
    await waitFor(ws, (m) => m.type === 'quality' && m.value === 'low', 10000);
    send(ws, { type: 'quality', value: 'medium' });
    await waitFor(ws, (m) => m.type === 'quality' && m.value === 'medium', 10000);
    send(ws, { type: 'back' });
    await sleep(500);
    send(ws, { type: 'forward' });
    await sleep(500);
    send(ws, { type: 'reload' });
    await sleep(1000);
    ok('اسکرول + تغییر کیفیت + عقب/جلو/تازه‌سازی بدون خطا');
  } catch (e) {
    fail('اسکرول/کیفیت/ناوبری', e.message);
  }

  ws.removeEventListener('message', frameListener);
  ws.close();

  console.log(failures === 0 ? '\n🎉 همه تست‌ها پاس شد!' : `\n⚠️ ${failures} تست شکست خورد`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('خطای تست:', e);
  process.exit(1);
});
