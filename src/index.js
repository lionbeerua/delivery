// Один Worker для сайту і адмінки.
// Сайт: усі домени, крім admin.*  |  Адмінка: тільки admin.* і тільки після входу за паролем.
// Пароль зберігається в Cloudflare як секрет ADMIN_PASSWORD (не в репозиторії).

const COOKIE = 'lb_admin';
const DAYS = 30;
const enc = new TextEncoder();

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function isLoggedIn(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = await sign(env.ADMIN_PASSWORD, 'admin.' + exp);
  return same(sig, good);
}

function loginPage(error) {
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вхід в адмінку</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f5efe2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:#17171a;border:1px solid #2a2a2e;border-radius:20px;padding:26px}
h1{margin:0 0 6px;font-size:22px}p{margin:0 0 18px;color:#a9a392;font-size:14px}
input{width:100%;height:52px;border-radius:14px;border:1px solid #3a3a40;background:#0f0f11;color:#fff;font-size:17px;padding:0 14px;margin-bottom:12px}
button{width:100%;height:52px;border:0;border-radius:14px;background:#f2c142;color:#1b1403;font-weight:800;font-size:16px;cursor:pointer}
.e{color:#ff8a6b;font-size:14px;margin:0 0 12px}</style></head><body>
<form method="post" action="/login"><h1>Lion Beer</h1><p>Вхід в адмінку</p>${error ? '<p class="e">' + error + '</p>' : ''}
<input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required><button type="submit">Увійти</button></form></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const DEFAULT_BANNERS = [{ id: 'b1', img: '/img/banner1.jpg', kind: '', title: '', sub: '', on: true }];
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });

async function getBanners(env) {
  const v = env.KV ? await env.KV.get('banners', 'json') : null;
  return Array.isArray(v) && v.length ? v : DEFAULT_BANNERS;
}

function cleanBanners(list) {
  if (!Array.isArray(list) || list.length > 20) return null;
  return list.map((b) => ({
    img: typeof b.img === 'string' && /^(\/u\/[a-f0-9]{12}|\/img\/[\w.-]+)$/.test(b.img) ? b.img : '',
    kind: ['', 'Новинка', 'Акція', 'Новини'].includes(b.kind) ? b.kind : '',
    title: String(b.title || '').slice(0, 120),
    sub: String(b.sub || '').slice(0, 200),
    on: b.on !== false
  }));
}

// ---------- Замовлення і Telegram ----------
const STATUS_TXT = { new: '🆕 Нове', acc: '✅ Прийнято', done: '📦 Доставлено / видано', cancel: '❌ Скасовано' };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₴';

function cleanOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const phone = str(o.phone, 20);
  if (phone.replace(/\D/g, '').length < 12 || str(o.name, 60).length < 2) return null;
  if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > 60) return null;
  const mode = o.mode === 'pickup' ? 'pickup' : 'delivery';
  return {
    name: str(o.name, 60), phone, mode,
    city: str(o.city, 40), address: str(o.address, 200), note: str(o.note, 300),
    when: str(o.when, 40), pay: o.pay === 'card' ? 'card' : 'cash', payText: str(o.payText, 60), change: str(o.change, 20),
    lines: o.lines.map((l) => ({ name: str(l.name, 120), vol: str(l.vol, 30), qty: Math.min(99, Number(l.qty) || 1), sum: str(l.sum, 20) })),
    tara: (Array.isArray(o.tara) ? o.tara : []).slice(0, 10).map((l) => ({ vol: str(l.vol, 20), qty: Math.min(99, Number(l.qty) || 1), sum: str(l.sum, 20) })),
    total: Math.max(0, Math.min(1000000, Number(o.total) || 0))
  };
}

function orderText(o, status) {
  const L = [];
  L.push('<b>Замовлення №' + o.n + '</b> · ' + (o.mode === 'pickup' ? '🏪 Самовивіз' : '🚚 Доставка'));
  L.push('👤 ' + esc(o.name) + ', ' + esc(o.phone));
  if (o.mode === 'pickup') L.push('🕒 Забрати: ' + esc(o.when));
  else L.push('📍 ' + esc(o.city) + ', ' + esc(o.address));
  L.push('');
  o.lines.forEach((l) => L.push('• ' + esc(l.name) + ', ' + esc(l.vol) + ' × ' + l.qty + ' = ' + esc(l.sum)));
  o.tara.forEach((l) => L.push('• Тара, ' + esc(l.vol) + ' × ' + l.qty + ' = ' + esc(l.sum)));
  L.push('');
  L.push('💰 Разом: <b>' + money(o.total) + '</b> · ' + esc(o.payText));
  if (o.change) L.push('Решта з: ' + esc(o.change));
  if (o.note) L.push('💬 ' + esc(o.note));
  if (status) L.push('\n' + STATUS_TXT[status]);
  return L.join('\n');
}

const tgKeyboard = (id) => ({ inline_keyboard: [[{ text: 'Прийняти', callback_data: 'acc:' + id }, { text: 'Видано', callback_data: 'done:' + id }, { text: 'Скасувати', callback_data: 'cancel:' + id }]] });

async function tg(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

async function notifyTelegram(env, o) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) return;
  const cat = env.KV ? await env.KV.get('catalog', 'json') : null;
  if (cat && cat.tgOn === false) return;
  const res = await tg(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: orderText(o), parse_mode: 'HTML', reply_markup: tgKeyboard(o.id) });
  if (res && res.result && res.result.message_id) {
    o.tgMsg = res.result.message_id;
    await env.KV.put('order:' + o.id, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 180 });
  }
}

async function setStatus(env, id, status) {
  if (!STATUS_TXT[status] || status === 'new') return null;
  const raw = await env.KV.get('order:' + id);
  if (!raw) return null;
  const o = JSON.parse(raw);
  o.status = status;
  o.updated = Date.now();
  await env.KV.put('order:' + id, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 180 });
  if (env.TG_TOKEN && env.TG_CHAT_ID && o.tgMsg) {
    await tg(env, 'editMessageText', { chat_id: env.TG_CHAT_ID, message_id: o.tgMsg, text: orderText(o, status), parse_mode: 'HTML', reply_markup: tgKeyboard(o.id) }).catch(() => {});
  }
  return o;
}

async function listOrders(env, limit) {
  const keys = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix: 'order:', cursor, limit: 1000 });
    keys.push(...r.keys.map((k) => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && keys.length < 3000);
  keys.sort().reverse();
  const out = [];
  for (const k of keys.slice(0, limit)) {
    const v = await env.KV.get(k, 'json');
    if (v) out.push(v);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAdminHost = url.hostname.startsWith('admin.');

    // Фото, завантажені через адмінку (доступні всім: їх показує сайт)
    const im = url.pathname.match(/^\/u\/([a-f0-9]{12})$/);
    if (im && env.KV) {
      const buf = await env.KV.get('img:' + im[1], 'arrayBuffer');
      if (!buf) return new Response('Не знайдено', { status: 404 });
      return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }
    // Нове замовлення від клієнта
    if (url.pathname === '/api/order' && request.method === 'POST') {
      if (!env.KV) return json({ error: 'Сервер замовлень не налаштований' }, 503);
      const o = cleanOrder(await request.json().catch(() => null));
      if (!o) return json({ error: 'Перевірте дані замовлення' }, 400);
      const rl = 'rl:' + o.phone.replace(/\D/g, '');
      if (await env.KV.get(rl)) return json({ error: 'Забагато замовлень поспіль. Зачекайте хвилину або зателефонуйте нам' }, 429);
      await env.KV.put(rl, '1', { expirationTtl: 60 });
      const n = Math.max(99, Number(await env.KV.get('ordn')) || 0) + 1;
      await env.KV.put('ordn', String(n));
      o.n = n;
      o.id = String(Date.now()) + '-' + n;
      o.status = 'new';
      o.t = Date.now();
      await env.KV.put('order:' + o.id, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 180 });
      try { await notifyTelegram(env, o); } catch (e) { /* замовлення вже збережене */ }
      return json({ ok: true, n });
    }
    // Кнопки в Telegram (адресу вебхука знає тільки власниця)
    if (env.TG_SECRET && url.pathname === '/api/tg/' + env.TG_SECRET && request.method === 'POST') {
      const u = await request.json().catch(() => null);
      const cb = u && u.callback_query;
      if (cb && cb.data && String(cb.message && cb.message.chat && cb.message.chat.id) === String(env.TG_CHAT_ID)) {
        const [st, id] = String(cb.data).split(':');
        const o = await setStatus(env, id, st);
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: o ? STATUS_TXT[st] : 'Замовлення не знайдено' }).catch(() => {});
      }
      return json({ ok: true });
    }
    // Каталог для сайту: що увімкнено, ціни, описи, бейджі
    if (url.pathname === '/api/catalog' && request.method === 'GET') {
      const c = env.KV ? await env.KV.get('catalog', 'json') : null;
      return json(c || {}, 200, { 'Cache-Control': 'public, max-age=30' });
    }
    // Банери для сайту
    if (url.pathname === '/api/banners' && request.method === 'GET') {
      return json(await getBanners(env), 200, { 'Cache-Control': 'public, max-age=30' });
    }

    if (isAdminHost) {
      if (!env.ADMIN_PASSWORD) {
        return new Response('Пароль адмінки ще не налаштований.', { status: 503 });
      }
      if (url.pathname === '/login' && request.method === 'POST') {
        const form = await request.formData();
        const pass = String(form.get('password') || '');
        if (!same(await sign('cmp', pass), await sign('cmp', env.ADMIN_PASSWORD))) {
          await new Promise((r) => setTimeout(r, 1200));
          return loginPage('Неправильний пароль');
        }
        const exp = Date.now() + DAYS * 86400000;
        const sig = await sign(env.ADMIN_PASSWORD, 'admin.' + exp);
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/',
            'Set-Cookie': `${COOKIE}=${exp}.${sig}; Max-Age=${DAYS * 86400}; Path=/; HttpOnly; Secure; SameSite=Strict`
          }
        });
      }
      if (url.pathname === '/logout') {
        return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict` } });
      }
      if (!(await isLoggedIn(request, env))) {
        if (url.pathname.startsWith('/api/')) return json({ error: 'auth' }, 401);
        return loginPage('');
      }
      if (url.pathname === '/api/admin/catalog' && request.method === 'GET') {
        const c = env.KV ? await env.KV.get('catalog', 'json') : null;
        return json(c || {}, 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/api/admin/catalog' && request.method === 'POST') {
        if (!env.KV) return json({ error: 'Сховище KV не підключене' }, 503);
        const txt = await request.text();
        let c = null;
        try { c = JSON.parse(txt); } catch (e) { /* нижче */ }
        if (!c || typeof c !== 'object' || !c.on || txt.length > 400000) return json({ error: 'bad' }, 400);
        await env.KV.put('catalog', JSON.stringify({ on: c.on, edits: c.edits || {}, tara: c.tara || {}, site: c.site || {}, tgOn: c.tgOn !== false }));
        return json({ ok: true });
      }
      if (url.pathname === '/api/admin/poster-price' && request.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!/^\d{1,8}$/.test(id)) return json({ error: 'bad id' }, 400);
        try {
          const r = await fetch('https://lion-beer-proxy.lionbeer-ua.workers.dev/api/menu.getProduct?product_id=' + id);
          const j = await r.json();
          const pr = j && j.response && j.response.price;
          const raw = pr && (pr['1'] != null ? pr['1'] : Object.values(pr)[0]);
          const n = Number(raw);
          if (!isFinite(n) || n <= 0) return json({ error: 'no price' }, 502);
          return json({ price: n / 100 }, 200, { 'Cache-Control': 'no-store' });
        } catch (e) { return json({ error: 'poster unavailable' }, 502); }
      }
      if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
        if (!env.KV) return json([], 200);
        const lim = Math.min(300, Number(url.searchParams.get('limit')) || 60);
        return json(await listOrders(env, lim), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/api/admin/orders/status' && request.method === 'POST') {
        const b = await request.json().catch(() => null);
        const o = b && (await setStatus(env, String(b.id), String(b.status)));
        return o ? json(o) : json({ error: 'not found' }, 404);
      }
      if (url.pathname === '/api/admin/banners' && request.method === 'GET') return json(await getBanners(env), 200, { 'Cache-Control': 'no-store' });
      if (url.pathname === '/api/admin/banners' && request.method === 'POST') {
        if (!env.KV) return json({ error: 'Сховище KV не підключене' }, 503);
        const list = cleanBanners(await request.json().catch(() => null));
        if (!list) return json({ error: 'bad' }, 400);
        await env.KV.put('banners', JSON.stringify(list));
        return json({ ok: true });
      }
      if (url.pathname === '/api/admin/upload' && request.method === 'POST') {
        if (!env.KV) return json({ error: 'Сховище KV не підключене' }, 503);
        const buf = await request.arrayBuffer();
        const b = new Uint8Array(buf);
        if (buf.byteLength < 100 || buf.byteLength > 2_500_000 || b[0] !== 0xff || b[1] !== 0xd8) return json({ error: 'Потрібен JPG до 2,5 МБ' }, 400);
        const id = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('');
        await env.KV.put('img:' + id, buf);
        return json({ url: '/u/' + id });
      }
      const res = await env.ASSETS.fetch(new Request(new URL('/admin/', url), request));
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }

    // На основному домені та workers.dev адмінки немає
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return new Response('Не знайдено', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  }
};
