// Один Worker для сайту і адмінки.
// Сайт: усі домени, крім admin.*  |  Адмінка: тільки admin.* і тільки після входу через Cloudflare Access.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAdminHost = url.hostname.startsWith('admin.');

    if (isAdminHost) {
      // Cloudflare Access додає цей заголовок після успішного входу
      if (!request.headers.get('Cf-Access-Jwt-Assertion')) {
        return new Response('Доступ заборонено. Увійдіть через пошту.', { status: 403 });
      }
      const adminUrl = new URL('/admin/', url);
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    // На основному домені та workers.dev адмінки немає
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return new Response('Не знайдено', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  }
};
