// Проверка общего "входного" пароля сайта — теперь на сервере, а не в
// браузере. Раньше хэш пароля (SHA-256) лежал прямо в index.html и
// сравнение шло в JS на странице — значит любой, кто открыл "исходный код
// страницы", видел хэш и мог пытаться подобрать пароль офлайн, без единой
// заметной попытки входа. Теперь сам пароль (точнее его хэш) никогда не
// покидает сервер: браузер просто присылает введённый пароль сюда, функция
// сверяет его сама и в ответ либо отказывает, либо выдаёт подписанный токен.
import crypto from 'node:crypto';

const APP_SECRET = process.env.APP_SECRET || '';
// Тот же хэш, что раньше был зашит в index.html — переносим его сюда без
// изменений (пароль от этого не меняется), просто убираем из кода страницы.
const SITE_HASH = process.env.SITE_PASSWORD_HASH || '52d22b309a6243851b1b0403818cf2d0f5f0896eef56836dce1b580bf347d02e';

async function getBlobStore(name) {
  try { const mod = await import('@netlify/blobs'); return mod.getStore(name); }
  catch (e) { return null; }
}
function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function clientIp(req) {
  return req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown';
}

// Та же защита от подбора, что и в auth.mjs: после 10 неверных попыток с
// одного IP подряд (в окне 15 минут) — блокировка на 15 минут. Порог чуть
// выше, чем для входа в аккаунт, потому что это ещё не чей-то конкретный
// аккаунт — fail-open, если хранилище недоступно.
const RL_MAX = 10, RL_WINDOW_MS = 15 * 60000, RL_LOCK_MS = 15 * 60000;

async function handle(req) {
  if (!APP_SECRET) return json({ error: 'APP_SECRET не настроен на сайте' }, 500);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad body' }, 400); }
  const password = String(body.password || '');
  const ip = clientIp(req);
  const store = await getBlobStore('hyper-trader-ratelimit');
  const rlKey = 'rl:gate:' + ip;

  if (store) {
    try {
      const rec = await store.get(rlKey, { type: 'json' });
      if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
        const minutes = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
        return json({ error: `Слишком много попыток. Попробуйте через ${minutes} мин.` }, 429);
      }
    } catch (e) { /* fail-open */ }
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const hashBuf = Buffer.from(hash, 'hex'), siteBuf = Buffer.from(SITE_HASH, 'hex');
  const ok = hashBuf.length === siteBuf.length && crypto.timingSafeEqual(hashBuf, siteBuf);

  if (!ok) {
    if (store) {
      try {
        const rec = await store.get(rlKey, { type: 'json' });
        const now = Date.now();
        let count = 1, firstAttempt = now;
        if (rec && rec.firstAttempt && now - rec.firstAttempt < RL_WINDOW_MS) { count = (rec.count || 0) + 1; firstAttempt = rec.firstAttempt; }
        const next = { count, firstAttempt };
        if (count >= RL_MAX) next.lockedUntil = now + RL_LOCK_MS;
        await store.setJSON(rlKey, next);
      } catch (e) { /* не критично */ }
    }
    return json({ error: 'Неверный пароль' }, 400);
  }

  if (store) { try { await store.delete(rlKey); } catch (e) {} }
  const token = sign({ gate: true, exp: Date.now() + 90 * 86400000 });
  return json({ ok: true, token });
}

export default async (req) => {
  try { return await handle(req); }
  catch (e) { return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)) }, 500); }
};
