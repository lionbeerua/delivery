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
