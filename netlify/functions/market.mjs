// Прокси к Yahoo Finance chart API для вкладки TradFi (нефть, золото, индексы,
// акции). Нужен отдельной функцией, потому что сам Yahoo не отдаёт
// Access-Control-Allow-Origin — напрямую из браузера эти данные не достать.
// Без ключа API, без аутентификации — просто проброс публичного эндпоинта
// с нормализацией ответа под тот же формат свечей {t,T,o,h,l,c,v}, что
// использует остальное приложение для крипты.
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

// Длительность свечи в мс — чтобы посчитать T (время закрытия) так же,
// как это делает candleSnapshot у Hyperliquid, и чтобы closed() в
// index.html одинаково работала и для крипты, и для TradFi.
const TF_MS = { '60m': 3600e3, '1d': 86400e3, '1wk': 7 * 86400e3 };

async function handle(req) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol');
  const interval = url.searchParams.get('interval') || '1d';
  const range = url.searchParams.get('range') || '6mo';
  if (!symbol) return json({ error: 'нужен параметр symbol' }, 400);
  if (!TF_MS[interval]) return json({ error: 'неизвестный interval' }, 400);

  const yUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
    + '?interval=' + encodeURIComponent(interval) + '&range=' + encodeURIComponent(range);
  let r;
  try {
    r = await fetch(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HyperTraderBot/1.0)' } });
  } catch (e) {
    return json({ error: 'не удалось связаться с Yahoo Finance: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
  if (!r.ok) return json({ error: 'Yahoo Finance вернул HTTP ' + r.status }, 502);
  let j;
  try { j = await r.json(); } catch (e) { return json({ error: 'Yahoo Finance вернул не-JSON (возможно, символ не существует)' }, 502); }

  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) {
    const msg = j && j.chart && j.chart.error && j.chart.error.description;
    return json({ error: msg || 'нет данных по символу ' + symbol }, 502);
  }
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const dur = TF_MS[interval];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if (o == null || h == null || l == null || c == null) continue; // дырки в данных (нерабочие часы/дни) — пропускаем
    const t = ts[i] * 1000;
    candles.push({ t, T: t + dur, o, h, l, c, v: (q.volume && q.volume[i]) || 0 });
  }
  return json({ meta: res.meta || {}, candles });
}

export default async (req) => {
  try { return await handle(req); }
  catch (e) { return json({ error: 'Сбой функции: ' + (e && e.message ? e.message : String(e)) }, 500); }
};
