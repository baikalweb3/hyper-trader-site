// Хранение API wallet (agent wallet) ключа пользователя для автоторговли.
// Ключ шифруется (AES-256-GCM) перед записью в Netlify Blobs — сам по себе
// APP_SECRET никогда не покидает сервер, а расшифровать запись может только
// код этой функции. Ключ НИКОГДА не возвращается обратно в ответах (ни в GET,
// ни эхом в POST) — только статус подключения.
import crypto from 'node:crypto';

async function getBlobStore(name) {
  let mod;
  try { mod = await import('@netlify/blobs'); }
  catch (e) { throw new Error('Модуль @netlify/blobs не загрузился: ' + (e && e.message ? e.message : String(e))); }
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
function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
function tokenFrom(req) { const a = req.headers.get('authorization') || ''; return a.replace(/^Bearer\s+/i, ''); }

function encKeyBuf() { return crypto.createHash('sha256').update(APP_SECRET + ':wallet-enc').digest(); }
function encryptKey(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKeyBuf(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}
export function decryptKey(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', encKeyBuf(), Buffer.from(rec.iv, 'base64'));
  d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(rec.enc, 'base64')), d.final()]).toString('utf8');
}

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_KEY_RE = /^(0x)?[a-fA-F0-9]{64}$/;

async function handle(req) {
  const payload = verify(tokenFrom(req));
  if (!payload) return json({ error: 'не авторизован' }, 401);
  let store;
  try { store = await getBlobStore('hyper-trader-wallets'); }
  catch (e) { return json({ error: (e && e.message ? e.message : String(e)) }, 500); }

  if (req.method === 'GET') {
    const rec = await store.get('w:' + payload.u, { type: 'json' });
    if (!rec) return json({ connected: false });
    // Текущие открытые позиции бота — пишет/читает autotrade.mjs в
    // hyper-trader-autopos (p:+username). Отдаём их здесь же, чтобы вкладка
    // "Авто" могла показать, в чём бот сидит ПРЯМО СЕЙЧАС, а не только
    // отчёты по уже закрытым сделкам.
    let positions = [];
    try {
      const posStore = await getBlobStore('hyper-trader-autopos');
      positions = (await posStore.get('p:' + payload.u, { type: 'json' })) || [];
    } catch (e) { /* не критично — просто не покажем позиции */ }
    return json({ connected: true, mainAddress: rec.mainAddress, autoTrade: !!rec.autoTrade, isMainnet: rec.isMainnet !== false, settings: rec.settings || {}, updatedAt: rec.updatedAt, positions });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'bad body' }, 400); }
    const action = body.action;

    if (action === 'connect') {
      const apiWalletKey = String(body.apiWalletKey || '').trim();
      const mainAddress = String(body.mainAddress || '').trim();
      if (!EVM_KEY_RE.test(apiWalletKey)) return json({ error: 'Ключ API-кошелька должен быть 64 hex-символа (с 0x или без)' }, 400);
      if (!EVM_ADDR_RE.test(mainAddress)) return json({ error: 'Адрес основного кошелька должен быть вида 0x...40 hex-символов' }, 400);
      const { enc, iv, tag } = encryptKey(apiWalletKey.startsWith('0x') ? apiWalletKey : '0x' + apiWalletKey);
      const existing = await store.get('w:' + payload.u, { type: 'json' });
      const rec = { enc, iv, tag, mainAddress, autoTrade: false, isMainnet: body.isMainnet !== false, settings: (existing && existing.settings) || {}, updatedAt: Date.now() };
      await store.setJSON('w:' + payload.u, rec);
      // Индекс пользователей с подключённым кошельком — по нему автоторговля
      // (autotrade.mjs) обходит всех на каждом запуске по расписанию, не
      // перечисляя весь store пользователей сайта.
      const idx = (await store.get('windex', { type: 'json' })) || [];
      if (!idx.includes(payload.u)) { idx.push(payload.u); await store.setJSON('windex', idx); }
      return json({ ok: true, connected: true, mainAddress, autoTrade: false });
    }

    if (action === 'toggle') {
      const rec = await store.get('w:' + payload.u, { type: 'json' });
      if (!rec) return json({ error: 'сначала подключите кошелёк' }, 400);
      rec.autoTrade = !!body.autoTrade;
      rec.updatedAt = Date.now();
      await store.setJSON('w:' + payload.u, rec);
      return json({ ok: true, autoTrade: rec.autoTrade });
    }

    if (action === 'settings') {
      const rec = await store.get('w:' + payload.u, { type: 'json' });
      if (!rec) return json({ error: 'сначала подключите кошелёк' }, 400);
      const s = body.settings || {};
      const num = (x, min, max, def) => { const n = parseFloat(x); return (isFinite(n) && n >= min && n <= max) ? n : def; };
      rec.settings = {
        riskPct: num(s.riskPct, 0.1, 5, 1),
        horizon: ['short', 'intraday', 'mid'].includes(s.horizon) ? s.horizon : 'short',
        maxPositions: Math.round(num(s.maxPositions, 1, 10, 3)),
        minConf: Math.round(num(s.minConf, 50, 95, 55)),
        watchN: Math.round(num(s.watchN, 5, 40, 15))
      };
      rec.updatedAt = Date.now();
      await store.setJSON('w:' + payload.u, rec);
      return json({ ok: true, settings: rec.settings });
    }

    if (action === 'disconnect') {
      await store.delete('w:' + payload.u);
      return json({ ok: true, connected: false });
    }

    return json({ error: 'unknown action' }, 400);
  }

  return json({ error: 'method not allowed' }, 405);
}

export default async (req) => {
  try { return await handle(req); }
  catch (e) { return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)) }, 500); }
};
