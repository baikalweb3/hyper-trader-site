// Фоновый мониторинг Hyperliquid — работает на сервере Netlify сам по себе,
// без открытого браузера. Раз в N минут проверяет топ монет по объёму,
// ищет сигналы (короткосрок/интрадей/среднесрок — та же логика, что в
// самом приложении) и шлёт новые в Telegram. Состояние (какие сигналы уже
// присылали) хранится между запусками через Netlify Blobs.
import { getStore } from '@netlify/blobs';

const API = 'https://api.hyperliquid.xyz/info';
const WATCH_N = parseInt(process.env.WATCH_N || '25', 10);
const MIN_CONF = parseInt(process.env.MIN_CONF || '55', 10);
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT || '';

const IV = { '15m': 9e5, '1h': 3.6e6, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8 };

async function post(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function getCandles(coin, tf, n) {
  const end = Date.now(), start = end - n * IV[tf];
  const raw = await post({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: start, endTime: end } });
  return raw.map(x => ({ t: x.t, T: x.T, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}
const closed = cs => cs.filter(c => c.T < Date.now());

/* ===== индикаторы и сигналы — та же логика, что в приложении ===== */
function emaFull(v, n) { const out = new Array(v.length).fill(null); if (v.length < n) return out; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e; for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e } return out }
function rsi(cl, n = 14) { if (cl.length <= n) return null; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = cl[i] - cl[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0) } g /= n; l /= n; for (let i = n + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n } return l === 0 ? 100 : 100 - 100 / (1 + g / l) }
function atr(cs, n = 14) { if (cs.length <= n) return null; const tr = []; for (let i = 1; i < cs.length; i++) tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c))); let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a }
function trendState(cs) { if (cs.length < 60) return null; const cl = cs.map(c => c.c), e20 = emaFull(cl, 20), e50 = emaFull(cl, 50), L = cl.length - 1, px = cl[L]; let score = (px > e20[L] ? 1 : -1) + (e20[L] > e50[L] ? 1 : -1) + (e20[L] > e20[L - 5] ? 1 : -1); const vols = cs.map(c => c.v), avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20; return { px, e20: e20[L], e50: e50[L], rsi: rsi(cl), atr: atr(cs), vr: avg ? vols[L] / avg : null, score } }
function pullbackSignal(cs) { if (cs.length < 60) return null; const cl = cs.map(c => c.c), e20 = emaFull(cl, 20), e50 = emaFull(cl, 50), L = cs.length - 1, last = cs[L], a = atr(cs), r = rsi(cl); if (!a) return null; const up = e20[L] > e50[L], dn = e20[L] < e50[L]; const tDn = [0, 1, 2].some(i => cs[L - i].l <= e20[L - i]), tUp = [0, 1, 2].some(i => cs[L - i].h >= e20[L - i]); if (up && tDn && last.c > e20[L] && last.c > last.o && (r == null || r < 65)) return { side: 'long', entry: last.c, stop: Math.min(last.l, cs[L - 1].l) - 0.2 * a, atr: a, t: last.t }; if (dn && tUp && last.c < e20[L] && last.c < last.o && (r == null || r > 35)) return { side: 'short', entry: last.c, stop: Math.max(last.h, cs[L - 1].h) + 0.2 * a, atr: a, t: last.t }; return null }
function breakoutSignal(cs) { if (cs.length < 60) return null; const L = cs.length - 1, last = cs[L], a = atr(cs); if (!a) return null; const rng = cs.slice(L - 20, L), hi = Math.max(...rng.map(c => c.h)), lo = Math.min(...rng.map(c => c.l)); const vols = cs.map(c => c.v), avg = vols.slice(L - 20, L).reduce((x, y) => x + y, 0) / 20, vr = avg ? last.v / avg : 1; if (vr < 1.2) return null; if (last.c > hi) return { side: 'long', entry: last.c, stop: last.c - 1.5 * a, atr: a, t: last.t, vr }; if (last.c < lo) return { side: 'short', entry: last.c, stop: last.c + 1.5 * a, atr: a, t: last.t, vr }; return null }
function swingSignal(cs, hz) { const lookback = hz.lookback || 24; if (cs.length < lookback + 65) return null; const st = trendState(cs); if (!st || !st.atr) return null; const L = cs.length - 1, last = cs[L], a = st.atr; const ref = cs.slice(L - lookback, L); const hi = Math.max(...ref.map(c => c.h)), lo = Math.min(...ref.map(c => c.l)); if (st.score >= 2 && last.c > hi) return { side: 'long', entry: last.c, stop: Math.min(lo, last.l) - 0.5 * a, atr: a, t: last.t, brk: true }; if (st.score <= -2 && last.c < lo) return { side: 'short', entry: last.c, stop: Math.max(hi, last.h) + 0.5 * a, atr: a, t: last.t, brk: true }; return null }

const HORIZONS = {
  short: { tfs: ['15m', '1h', '4h'], entryTf: '15m', rr: 2, names: { '15m': '15м', '1h': '1ч', '4h': '4ч' }, label: 'краткосрочно', sigFns: [['pullback', pullbackSignal], ['breakout', breakoutSignal]] },
  intraday: { tfs: ['1h', '4h', '1d'], entryTf: '1h', rr: 3, names: { '1h': '1ч', '4h': '4ч', '1d': '1д' }, label: 'интрадей (крупнее движение)', lookback: 24, sigFns: [['breakout_1d_range', cs => swingSignal(cs, { lookback: 24 })]] },
  mid: { tfs: ['4h', '1d', '1w'], entryTf: '4h', rr: 3, names: { '4h': '4ч', '1d': '1д', '1w': '1н' }, label: 'среднесрочно (крупные движения)', sigFns: [['pullback', pullbackSignal], ['breakout', breakoutSignal]] }
};

function analyzeGeneric(coin, hz, key, cache, ctx) {
  const { tfs, entryTf, rr } = hz, out = { coin, tf: {}, align: 0, sigs: [] };
  for (const tf of tfs) {
    const c = cache[coin + tf]; if (!c) return null;
    const st = trendState(closed(c)); out.tf[tf] = st; out.align += st ? st.score : 0;
  }
  const hA = out.tf[tfs[1]], hB = out.tf[tfs[2]];
  out.htf = (hA && hB && hA.score >= 2 && hB.score >= 0) ? 'long' : (hA && hB && hA.score <= -2 && hB.score <= 0) ? 'short' : null;
  const ce = closed(cache[coin + entryTf]), cx = ctx[coin];
  const f8 = cx ? cx.funding * 800 : 0;
  for (const [kind, fn] of hz.sigFns) {
    const s = fn(ce); if (!s) continue;
    if (out.htf && out.htf !== s.side) continue;
    const risk = Math.abs(s.entry - s.stop); if (!risk) continue;
    let conf = 40;
    if (out.htf === s.side) conf += 15;
    if ((s.side === 'long' && out.align >= 6) || (s.side === 'short' && out.align <= -6)) conf += 10;
    const vr = out.tf[entryTf] ? out.tf[entryTf].vr : null;
    if (vr && vr > 1.3) conf += 10;
    const r = out.tf[entryTf] ? out.tf[entryTf].rsi : null;
    if (r != null && ((s.side === 'long' && r > 72) || (s.side === 'short' && r < 28))) conf -= 15;
    if ((s.side === 'long' && f8 > 0.03) || (s.side === 'short' && f8 < -0.03)) conf -= 10;
    conf = Math.max(5, Math.min(95, conf));
    const target = s.side === 'long' ? s.entry + rr * risk : s.entry - rr * risk;
    out.sigs.push({ id: coin + '|' + entryTf + '|' + kind + '|' + s.side + '|' + s.t, coin, kind, side: s.side, entry: s.entry, stop: s.stop, target, rr, conf, horizon: key });
  }
  return out;
}

async function pLimit(items, n, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(() => null) } }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
  } catch (e) {}
}

export default async () => {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('TG_TOKEN / TG_CHAT не заданы в переменных окружения сайта — нечего слать, выхожу.');
    return new Response('no telegram creds configured', { status: 200 });
  }
  const store = getStore('hyper-trader-seen');
  let seen = [];
  try { seen = (await store.get('seen', { type: 'json' })) || []; } catch (e) { seen = []; }
  const seenSet = new Set(seen);

  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  const ctx = {};
  meta.universe.forEach((u, i) => { const c = ctxs[i]; if (!c || u.isDelisted) return; ctx[u.name] = { funding: +c.funding, vol: +c.dayNtlVlm, mark: +c.markPx }; });
  const coins = Object.entries(ctx).sort((a, b) => b[1].vol - a[1].vol).slice(0, WATCH_N).map(e => e[0]);

  const allTfs = new Set();
  Object.values(HORIZONS).forEach(hz => hz.tfs.forEach(tf => allTfs.add(tf)));
  const cache = {};
  const jobs = [];
  for (const coin of coins) for (const tf of allTfs) jobs.push({ coin, tf });
  await pLimit(jobs, 5, async ({ coin, tf }) => {
    const cs = await getCandles(coin, tf, 220);
    cache[coin + tf] = cs;
  });

  const fresh = [];
  for (const [key, hz] of Object.entries(HORIZONS)) {
    for (const coin of coins) {
      const a = analyzeGeneric(coin, hz, key, cache, ctx);
      if (!a) continue;
      for (const s of a.sigs) {
        if (seenSet.has(s.id)) continue;
        seenSet.add(s.id);
        if (s.conf >= MIN_CONF) fresh.push(s);
      }
    }
  }

  for (const s of fresh) {
    const hz = HORIZONS[s.horizon];
    const text = (s.side === 'long' ? '🟢 ЛОНГ ' : '🔴 ШОРТ ') + s.coin + ' · ' + hz.label + '\n'
      + 'вход ≈ ' + s.entry.toPrecision(6) + '\nстоп ' + s.stop.toPrecision(6) + '\nцель (' + s.rr + 'R) ' + s.target.toPrecision(6) + '\nуверенность ' + s.conf + '%'
      + '\n\n(сигнал от фонового монитора сайта, не финансовый совет — проверьте в приложении перед сделкой)';
    await tgSend(text);
  }

  const trimmed = [...seenSet].slice(-3000);
  try { await store.setJSON('seen', trimmed); } catch (e) {}

  return new Response('ok, new signals: ' + fresh.length, { status: 200 });
};

// Расписание ('*/10 * * * *') СНЯТО: TG_TOKEN/TG_CHAT в переменных
// окружения сайта не настроены, а значит каждый из 144 запусков в день
// уходил впустую — функция сразу выходила, но сам запуск всё равно
// списывался с кредитов Netlify (это одна из причин, почему кредиты
// кончились раньше цикла). Как только в Site settings → Environment
// variables появятся TG_TOKEN и TG_CHAT (токен Telegram-бота и chat_id),
// верни строку ниже — и фоновые сигналы в Telegram снова заработают:
// export const config = { schedule: '*/10 * * * *' };
