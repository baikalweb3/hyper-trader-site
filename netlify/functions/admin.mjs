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
  if (!payload || !payload.isAdmin) return json({ error: 'только для админа' }, 403);

  let users, journal;
  try {
    users = await getBlobStore('hyper-trader-users');
    journal = await getBlobStore('hyper-trader-journal');
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
    out.push({
      username, createdAt: u.createdAt, lastLogin: u.lastLogin, isAdmin: !!u.isAdmin,
      trades: rows.length, winPct: rows.length ? Math.round(wins / rows.length * 100) : null,
      totalR: Math.round(totR * 100) / 100, lastTrades: rows.slice(0, 5)
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
