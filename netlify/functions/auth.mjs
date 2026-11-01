// Регистрация и вход. Пароли хранятся только как соль+хэш (scrypt, встроено
// в Node, без внешних пакетов). Токен — подписанный HMAC, не JWT-библиотека,
// тоже без зависимостей, чтобы Netlify Drop мог задеплоить это одним файлом.
//
// ВАЖНО: @netlify/blobs импортируется НЕ статически вверху файла (static
// import), а динамически внутри функции (await import(...)), и только
// когда реально нужен доступ к хранилищу (регистрация/вход не-админа).
// Если модуль по какой-то причине не загружается при ручной заливке —
// статический import уронил бы ВСЮ функцию ещё на старте (502 без текста,
// до любых try/catch). Динамический import этого не делает: ошибку
// загрузки можно поймать и показать как обычный текст ошибки.
import crypto from 'node:crypto';

const APP_SECRET = process.env.APP_SECRET || '';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'damir').trim().toLowerCase();
// Вход для админа работает НАПРЯМУЮ по паролю из переменной окружения,
// без обращения к Netlify Blobs вообще — чтобы Damir всегда мог зайти,
// даже если хранилище для остальных пользователей сломано.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

async function getBlobStore(name) {
  let mod;
  try {
    mod = await import('@netlify/blobs');
  } catch (e) {
    throw new Error('Модуль @netlify/blobs не загрузился: ' + (e && e.message ? e.message : String(e)));
  }
  return mod.getStore(name);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function hashPw(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Таймаут на шаге: ' + label)), ms))
  ]);
}

// Защита от подбора пароля: после MAX_ATTEMPTS неверных попыток подряд
// (в окне WINDOW_MS) блокируем вход для этого имени на LOCK_MS.
// Если Blobs недоступен — ограничение просто не применяется (fail-open),
// чтобы поломка хранилища никогда не заблокировала твой собственный вход.
const RL_MAX_ATTEMPTS = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_LOCK_MS = 15 * 60 * 1000;

async function rlCheck(username) {
  try {
    const store = await getBlobStore('hyper-trader-ratelimit');
    const rec = await withTimeout(store.get('rl:' + username, { type: 'json' }), 3000, 'rate-limit read');
    if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
      const minutes = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      return { store, rec, blocked: true, minutes };
    }
    return { store, rec, blocked: false };
  } catch (e) {
    return { store: null, rec: null, blocked: false };
  }
}
async function rlRecordFail(store, username, rec) {
  if (!store) return;
  try {
    const now = Date.now();
    let count = 1, firstAttempt = now;
    if (rec && rec.firstAttempt && now - rec.firstAttempt < RL_WINDOW_MS) {
      count = (rec.count || 0) + 1;
      firstAttempt = rec.firstAttempt;
    }
    const next = { count, firstAttempt };
    if (count >= RL_MAX_ATTEMPTS) next.lockedUntil = now + RL_LOCK_MS;
    await withTimeout(store.setJSON('rl:' + username, next), 3000, 'rate-limit write');
  } catch (e) { /* не критично */ }
}
async function rlReset(store, username) {
  if (!store) return;
  try { await withTimeout(store.delete('rl:' + username), 3000, 'rate-limit reset'); } catch (e) { /* не критично */ }
}

async function handle(req) {
  if (!APP_SECRET) return json({ error: 'APP_SECRET не настроен на сайте (Site settings → Environment variables)' }, 500);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad body' }, 400); }
  const action = body.action;
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');

  // Вход админа — напрямую по ADMIN_PASSWORD, без Blobs вообще (кроме
  // необязательной проверки лимита попыток, которая не блокирует вход
  // при недоступности хранилища).
  if (action === 'login' && ADMIN_USERNAME && username === ADMIN_USERNAME) {
    if (!ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD не настроен на сайте (Site settings → Environment variables)' }, 500);
    const rl = await rlCheck(username);
    if (rl.blocked) return json({ error: `Слишком много попыток входа. Попробуйте через ${rl.minutes} мин.` }, 429);
    if (password !== ADMIN_PASSWORD) { await rlRecordFail(rl.store, username, rl.rec); return json({ error: 'Неверный пароль' }, 400); }
    await rlReset(rl.store, username);
    const token = sign({ u: username, isAdmin: true, exp: Date.now() + 90 * 86400000 });
    return json({ token, username, isAdmin: true });
  }

  let store;
  try {
    store = await getBlobStore('hyper-trader-users');
  } catch (e) {
    return json({ error: (e && e.message ? e.message : String(e)) }, 500);
  }

  if (action === 'signup') {
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: 'Имя: 3-20 символов, латиница/цифры/_' }, 400);
    if (password.length < 6) return json({ error: 'Пароль минимум 6 символов' }, 400);
    if (ADMIN_USERNAME && username === ADMIN_USERNAME) return json({ error: 'Это имя зарезервировано' }, 400);
    const existing = await withTimeout(store.get('u:' + username, { type: 'json' }), 8000, 'проверка занятости имени');
    if (existing) return json({ error: 'Такое имя уже занято' }, 400);
    const { salt, hash } = hashPw(password);
    const user = { username, salt, hash, createdAt: Date.now(), lastLogin: Date.now(), isAdmin: false };
    await withTimeout(store.setJSON('u:' + username, user), 8000, 'запись пользователя');
    const idx = (await withTimeout(store.get('index', { type: 'json' }), 8000, 'чтение индекса')) || [];
    if (!idx.includes(username)) { idx.push(username); await withTimeout(store.setJSON('index', idx), 8000, 'запись индекса'); }
    const token = sign({ u: username, isAdmin: false, exp: Date.now() + 90 * 86400000 });
    return json({ token, username, isAdmin: false });
  }

  if (action === 'login') {
    const rl = await rlCheck(username);
    if (rl.blocked) return json({ error: `Слишком много попыток входа. Попробуйте через ${rl.minutes} мин.` }, 429);
    const user = await withTimeout(store.get('u:' + username, { type: 'json' }), 8000, 'чтение пользователя');
    if (!user) { await rlRecordFail(rl.store, username, rl.rec); return json({ error: 'Нет такого пользователя' }, 400); }
    const { hash } = hashPw(password, user.salt);
    if (hash !== user.hash) { await rlRecordFail(rl.store, username, rl.rec); return json({ error: 'Неверный пароль' }, 400); }
    await rlReset(rl.store, username);
    user.lastLogin = Date.now();
    user.isAdmin = false;
    await withTimeout(store.setJSON('u:' + username, user), 8000, 'обновление пользователя');
    const token = sign({ u: username, isAdmin: false, exp: Date.now() + 90 * 86400000 });
    return json({ token, username, isAdmin: false });
  }

  return json({ error: 'unknown action' }, 400);
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 5) : undefined }, 500);
  }
};
