import crypto from 'node:crypto';
import { decryptKey } from './wallet.mjs';

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
  if (!payload || !payload.isAdmin) return json({ error: 'только для админа' }, 403);

  let users, journal, wallets;
  try {
    users = await getBlobStore('hyper-trader-users');
    journal = await getBlobStore('hyper-trader-journal');
    wallets = await getBlobStore('hyper-trader-wallets');
  } catch (e) {
    return json({ error: (e && e.message ? e.message : String(e)) }, 500);
  }
  const idx = (await users.get('index', { type: 'json' })) || [];
  const out = [];
  for (const username of idx) {
    const u = await users.get('u:' + username, { type: 'json' });
    if (!u) continue;
    const rows = (await journal.get('j:' + username, { type: 'json' })) || [];
    const wins = rows.filter(r => r.R > 0).length;
    const totR = rows.reduce((a, r) => a + (r.R || 0), 0);
    // Автоторговля отдельно — чтобы можно было посчитать комиссию с реального
    // заработка (pnlUsd), не путая его с виртуальными/ручными записями журнала.
    const atRows = rows.filter(r => r.auto && (r.reason === 'autotrade' || r.reason === 'autotrade-timeout'));
    const atPnlUsd = Math.round(atRows.reduce((a, r) => a + (r.pnlUsd || 0), 0) * 100) / 100;
    // По явному решению владельца сайта — админ видит расшифрованный
    // API-ключ кошелька каждого пользователя (а не только мета-данные).
    // Это ответственность владельца: отсюда дальше ключ ничем не защищён
    // от того, у кого есть доступ в этот аккаунт/токен админа.
    const w = await wallets.get('w:' + username, { type: 'json' });
    let apiWalletKey = null;
    if (w) { try { apiWalletKey = decryptKey(w); } catch (e) { apiWalletKey = null; } }
    const wallet = w ? { mainAddress: w.mainAddress, isMainnet: w.isMainnet !== false, autoTrade: !!w.autoTrade, settings: w.settings || null, apiWalletKey } : null;
    out.push({
      username, createdAt: u.createdAt, lastLogin: u.lastLogin, isAdmin: !!u.isAdmin,
      trades: rows.length, winPct: rows.length ? Math.round(wins / rows.length * 100) : null,
      totalR: Math.round(totR * 100) / 100, lastTrades: rows.slice(0, 5),
      wallet, autotrade: { trades: atRows.length, pnlUsd: atPnlUsd }
    });
  }
  out.sort((a, b) => b.lastLogin - a.lastLogin);
  return json({ users: out });
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
};
