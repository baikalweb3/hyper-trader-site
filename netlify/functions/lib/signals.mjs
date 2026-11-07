// Серверная копия чистых функций анализа из index.html (ema/atr/rsi/trendState/
// pullbackSignal/breakoutSignal/swingSignal/analyzeGeneric + HORIZONS). Нужна,
// чтобы автоторговля считала сигналы САМА на сервере по расписанию, не зависящая
// от того, открыт ли у пользователя браузер — в отличие от обычного сканера,
// который считается в index.html на клиенте.
//
// ВАЖНО: это копия, а не общий импортируемый файл с index.html, потому что
// index.html — это одна HTML-страница без сборки (чтобы Netlify мог отдавать
// её как статику без бандлинга). Если меняешь логику сигналов в index.html —
// не забудь перенести то же самое изменение сюда, иначе автоторговля и обычный
// сканер начнут давать разные сигналы для одной и той же монеты.

export const IV = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 };

export const HORIZONS = {
  short: { tfs: ['15m', '1h', '4h'], entryTf: '15m', rr: 2, lookback: null },
  intraday: { tfs: ['1h', '4h', '1d'], entryTf: '1h', rr: 3, lookback: 24 },
  mid: { tfs: ['4h', '1d', '1w'], entryTf: '4h', rr: 3, lookback: null }
};

function emaFull(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(cl, n = 14) {
  if (cl.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = cl[i] - cl[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n;
  for (let i = n + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(cs, n = 14) {
  if (cs.length <= n) return null;
  const tr = [];
  for (let i = 1; i < cs.length; i++) tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}
function trendState(z) {
  if (z.length < 60) return null;
  const q = z.map(c => c.c), e2 = emaFull(q, 20), e5 = emaFull(q, 50), L = q.length - 1, px = q[L];
  const sc = (px > e2[L] ? 1 : -1) + (e2[L] > e5[L] ? 1 : -1) + (e2[L] > e2[L - 5] ? 1 : -1);
  const v = z.map(c => c.v), av = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return { px, e20: e2[L], e50: e5[L], rsi: rsi(q), atr: atr(z), vr: av ? v[L] / av : null, score: sc };
}
function pullbackSignal(z) {
  if (z.length < 60) return null;
  const q = z.map(c => c.c), e2 = emaFull(q, 20), e5 = emaFull(q, 50), L = z.length - 1, x = z[L], a = atr(z), r = rsi(q);
  if (!a) return null;
  // Фильтр силы тренда: EMA20 и EMA50 должны разойтись хотя бы на 1.2×ATR.
  // Без него "откат к EMA20" ловил вход на любом касании, даже когда тренд
  // ещё слабый/боковой — на реальной истории (642 сигнала, 4 дня) это давало
  // только 28% побед при цели 1:2 (нужно 33% на безубыток), итог -100R.
  // На сигналах, где EMA20/50 разошлись ≥1.2 ATR (зрелый, уже подтверждённый
  // тренд, а не только начавшийся), та же история дала 42% побед и +49R —
  // проверено прогоном реальных цен по всем прошлым сигналам перед деплоем.
  if (Math.abs(e2[L] - e5[L]) < 1.2 * a) return null;
  const u = e2[L] > e5[L], d = e2[L] < e5[L];
  const td = [0, 1, 2].some(i => z[L - i].l <= e2[L - i]), tu = [0, 1, 2].some(i => z[L - i].h >= e2[L - i]);
  if (u && td && x.c > e2[L] && x.c > x.o && (r == null || r < 65)) return { side: 'long', entry: x.c, stop: Math.min(x.l, z[L - 1].l) - 0.2 * a, atr: a, t: x.t };
  if (d && tu && x.c < e2[L] && x.c < x.o && (r == null || r > 35)) return { side: 'short', entry: x.c, stop: Math.max(x.h, z[L - 1].h) + 0.2 * a, atr: a, t: x.t };
  return null;
}
function breakoutSignal(z) {
  if (z.length < 60) return null;
  const L = z.length - 1, x = z[L], a = atr(z);
  if (!a) return null;
  const g = z.slice(L - 20, L), hi = Math.max(...g.map(c => c.h)), lo = Math.min(...g.map(c => c.l));
  const v = z.map(c => c.v), av = v.slice(L - 20, L).reduce((p, q) => p + q, 0) / 20, vr = av ? x.v / av : 1;
  // Порог был 1.2 — на истории (111 сигналов) видно, что сигналы с объёмом
  // 1.2-1.5× от среднего дают 23% побед и -15R, а с 1.5×+ — 51% и +33R. Почти
  // весь плюс breakout-паттерна шёл именно от сильнообъёмных пробоев.
  if (vr < 1.5) return null;
  if (x.c > hi) return { side: 'long', entry: x.c, stop: x.c - 1.5 * a, atr: a, t: x.t, vr };
  if (x.c < lo) return { side: 'short', entry: x.c, stop: x.c + 1.5 * a, atr: a, t: x.t, vr };
  return null;
}
function swingSignal(z, hz) {
  const lb = hz.lookback || 24;
  if (z.length < lb + 65) return null;
  const st = trendState(z);
  if (!st || !st.atr) return null;
  const L = z.length - 1, x = z[L], a = st.atr, g = z.slice(L - lb, L), hi = Math.max(...g.map(c => c.h)), lo = Math.min(...g.map(c => c.l));
  // Объёмный фильтр — раньше его тут не было (в отличие от breakoutSignal,
  // где он есть), поэтому "интрадей" ловил много ложных пробоев диапазона
  // без реального интереса рынка: цена чуть высовывалась за хай/лоу на
  // тихом объёме и тут же разворачивалась. Тот же порог ×1.2, что и в
  // breakoutSignal, для единообразия.
  const v = z.map(c => c.v), av = v.slice(L - lb, L).reduce((a, b) => a + b, 0) / lb, vr = av ? x.v / av : 1;
  if (vr < 1.2) return null;
  if (st.score >= 2 && x.c > hi) return { side: 'long', entry: x.c, stop: Math.min(lo, x.l) - 0.5 * a, atr: a, t: x.t, brk: true, vr };
  if (st.score <= -2 && x.c < lo) return { side: 'short', entry: x.c, stop: Math.max(hi, x.h) + 0.5 * a, atr: a, t: x.t, brk: true, vr };
  return null;
}
const SIG_FNS = {
  short: [['pullback', pullbackSignal], ['breakout', breakoutSignal]],
  intraday: [['breakout_1d_range', z => swingSignal(z, { lookback: 24 })]],
  mid: [['pullback', pullbackSignal], ['breakout', breakoutSignal]]
};
const closed = cs => cs.filter(c => c.T < Date.now());

// Тот же порог отбора сигналов, что и в analyzeGeneric() на клиенте: совпадение
// со старшими таймфреймами, объём, RSI, funding — иначе цифры и поведение
// автоторговли разойдутся с тем, что пользователь видит в сканере.
export function analyzeGeneric(coin, horizonKey, tfData, fundingPct8h) {
  const hz = HORIZONS[horizonKey], R = hz.rr, T = hz.tfs, E = hz.entryTf;
  const O = { coin, tf: {}, align: 0, sigs: [] };
  for (const tf of T) {
    const c = tfData[tf];
    if (!c) return null;
    const st = trendState(closed(c));
    O.tf[tf] = st; O.align += st ? st.score : 0;
  }
  O.bias = O.align >= 4 ? 'long' : O.align <= -4 ? 'short' : 'mixed';
  const hA = O.tf[T[1]], hB = O.tf[T[2]];
  O.htf = (hA && hB && hA.score >= 2 && hB.score >= 0) ? 'long' : (hA && hB && hA.score <= -2 && hB.score <= 0) ? 'short' : null;
  const ce = closed(tfData[E]);
  const f8 = fundingPct8h || 0;
  for (const [kind, fn] of SIG_FNS[horizonKey]) {
    const s = fn(ce);
    if (!s) continue;
    if (O.htf && O.htf !== s.side) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!risk) continue;
    let w = 40, notes = [];
    if (O.htf === s.side) { w += 15; notes.push('старшие ТФ в ту же сторону'); }
    if ((s.side === 'long' && O.align >= 6) || (s.side === 'short' && O.align <= -6)) { w += 10; notes.push('все три ТФ согласны'); }
    const vr = O.tf[E] ? O.tf[E].vr : null;
    if (vr && vr > 1.3) { w += 10; notes.push('объём выше среднего'); }
    const r = O.tf[E] ? O.tf[E].rsi : null;
    if (r != null && ((s.side === 'long' && r > 72) || (s.side === 'short' && r < 28))) { w -= 15; notes.push('RSI перегрет'); }
    if ((s.side === 'long' && f8 > 0.03) || (s.side === 'short' && f8 < -0.03)) { w -= 10; notes.push('funding против позиции'); }
    w = Math.max(5, Math.min(95, w));
    const target = s.side === 'long' ? s.entry + R * risk : s.entry - R * risk;
    // atr сохраняем в сигнал — нужен автоторговле для трейлинг-стопа после
    // частичного закрытия на 1R (см. autotrade.mjs): без него пришлось бы
    // пересчитывать ATR заново при каждой проверке позиции.
    O.sigs.push({ id: coin + '|' + E + '|' + kind + '|' + s.side + '|' + s.t, coin, kind, side: s.side, entry: s.entry, stop: s.stop, target, rr: R, conf: w, notes, t: s.t, horizon: horizonKey, atr: s.atr });
  }
  return O;
}
