import crypto from 'node:crypto';

async function getBlobStore(name) {
  let mod;
  try {
    mod = await import('@netlify/blobs');
  } catch (e) {
    throw new Error('Модуль @netlify/blobs не загрузился: ' + (e && e.message ? e.message : String(e)));
  }
  return mod.getStore(name);
}

const APP_SECRET = process.env.APP_SECRET || '';
function verify(token) {
  if (!token || !APP_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  if (expect !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function tokenFrom(req) {
  const auth = req.headers.get('authorization') || '';
  return auth.replace(/^Bearer\s+/i, '');
}

async function handle(req) {
  const payload = verify(tokenFrom(req));
  if (!payload) return json({ error: 'не авторизован' }, 401);
  let store;
  try {
    store = await getBlobStore('hyper-trader-journal');
  } catch (e) {
    return json({ error: (e && e.message ? e.message : String(e)) }, 500);
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const targetUser = url.searchParams.get('user');
    if (targetUser && targetUser !== payload.u) {
      if (!payload.isAdmin) return json({ error: 'нет прав' }, 403);
      const rows = (await store.get('j:' + targetUser, { type: 'json' })) || [];
      return json({ rows });
    }
    const rows = (await store.get('j:' + payload.u, { type: 'json' })) || [];
    return json({ rows });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'bad body' }, 400); }
    const raw = body.entry;
    if (!raw) return json({ error: 'нет entry' }, 400);
    // Раньше тело запроса писалось в базу как есть, одним Object.assign.
    // Это значит, что admin.mjs потом рендерил entry.coin НАПРЯМУЮ в HTML
    // (см. index.html bindAdmin) без экранирования — то есть любой
    // зарегистрированный пользователь мог прислать сюда coin вида
    // "<img src=x onerror=...>" и выполнить код в браузере админа, когда
    // тот откроет вкладку «Админ» (хранимый XSS). Чиним с двух сторон:
    // здесь — берём только ожидаемые поля и валидируем их форму, на
    // клиенте — дополнительно экранируем при выводе (защита в глубину).
    const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
    const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
    const coin = str(raw.coin, 20);
    if (!coin || !/^[A-Za-z0-9^=._-]{1,20}$/.test(coin)) return json({ error: 'некорректный coin' }, 400);
    const side = raw.side === 'short' ? 'short' : 'long';
    const entry = {
      id: str(raw.id, 40) || ('j' + Date.now().toString(36)),
      coin, side,
      entry: num(raw.entry), stop: num(raw.stop), target: num(raw.target), exit: num(raw.exit),
      R: num(raw.R) ?? 0,
      closedAt: num(raw.closedAt) || Date.now(),
      auto: !!raw.auto, reason: str(raw.reason, 40),
      syncedAt: Date.now()
    };
    const rows = (await store.get('j:' + payload.u, { type: 'json' })) || [];
    rows.unshift(entry);
    await store.setJSON('j:' + payload.u, rows.slice(0, 500));
    return json({ ok: true, n: rows.length });
  }

  return json({ error: 'method not allowed' }, 405);
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
};
