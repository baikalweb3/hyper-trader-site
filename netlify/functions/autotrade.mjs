// Автоторговля — запускается по расписанию на сервере Netlify (не зависит от
// того, открыт ли у пользователя браузер). Для каждого пользователя, у кого
// включена автоторговля и подключён API-кошелёк:
//  1) проверяет открытые управляемые позиции — закрывает по стопу/цели;
//  2) если есть свободный "слот" — ищет новый сигнал (та же логика, что в
//     сканере на клиенте) и открывает позицию реальным ордером на Hyperliquid.
//
// РАЗМЕР счёта для расчёта риска берётся НЕ из введённого пользователем числа,
// а напрямую с Hyperliquid (clearinghouseState основного адреса) — так риск %
// считается от реального текущего баланса, а не от устаревшей ручной цифры.
//
// ВНИМАНИЕ: код не проверен против живого Hyperliquid API — из песочницы, где
// это писалось, нет сетевого доступа к api.hyperliquid.xyz (разрешены только
// npm/GitHub). Перед включением на реальные деньги ОБЯЗАТЕЛЬНО проверить на
// testnet (isMainnet:false в настройках кошелька) на маленьком размере.
import { getStore } from '@netlify/blobs';
import { analyzeGeneric, HORIZONS, IV } from './lib/signals.mjs';
import { placeMarketOrder, getAssetMeta } from './lib/hlExchange.mjs';
import { decryptKey } from './wallet.mjs';

const API = 'https://api.hyperliquid.xyz/info';
const DEFAULT_MIN_CONF = 55;
const DEFAULT_MAX_POS = 3;
const SLIP = 0.003; // допустимое проскальзывание на IOC-ордере, защита от аномальной цены
const MAX_HOLD_MS = 5 * 86400000; // принудительно закрыть реальную позицию, если за 5 дней цена не дошла ни до стопа, ни до цели (позиция не должна висеть бесконечно)

async function post(body, base) {
  const r = await fetch((base || API), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function getCandles(coin, tf, n) {
  const end = Date.now(), start = end - n * IV[tf];
  const raw = await post({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: start, endTime: end } });
  return raw.map(x => ({ t: x.t, T: x.T, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}
async function pLimit(items, n, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(() => null); } }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
async function accountValue(mainAddress, isMainnet) {
  const base = isMainnet ? API : 'https://api.hyperliquid-testnet.xyz/info';
  const st = await post({ type: 'clearinghouseState', user: mainAddress }, base);
  return st && st.marginSummary ? +st.marginSummary.accountValue : null;
}

async function journalWrite(username, entry) {
  const jStore = getStore('hyper-trader-journal');
  const rows = (await jStore.get('j:' + username, { type: 'json' })) || [];
  rows.unshift(entry);
  await jStore.setJSON('j:' + username, rows.slice(0, 500));
}

export default async () => {
  const wStore = getStore('hyper-trader-wallets');
  const index = (await wStore.get('windex', { type: 'json' })) || [];
  if (!index.length) return new Response('нет подключённых кошельков', { status: 200 });

  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  const ctx = {};
  meta.universe.forEach((u, i) => { const c = ctxs[i]; if (!c || u.isDelisted) return; ctx[u.name] = { funding: +c.funding, vol: +c.dayNtlVlm, mark: +c.markPx }; });
  // Индексы активов у mainnet и testnet Hyperliquid могут отличаться — тянем
  // оба списка один раз, а не угадываем по одному из них для всех пользователей.
  const assetIdsByNet = {
    main: await getAssetMeta(true).catch(() => ({})),
    test: await getAssetMeta(false).catch(() => ({}))
  };

  const results = [];
  for (const username of index) {
    const rec = await wStore.get('w:' + username, { type: 'json' });
    if (!rec || !rec.autoTrade) continue;
    const settings = Object.assign({ riskPct: 1, horizon: 'short', maxPositions: DEFAULT_MAX_POS, minConf: DEFAULT_MIN_CONF, watchN: 15 }, rec.settings || {});
    const assetIds = assetIdsByNet[rec.isMainnet !== false ? 'main' : 'test'];
    const posStore = getStore('hyper-trader-autopos');
    let positions = (await posStore.get('p:' + username, { type: 'json' })) || [];

    let apiKey;
    try { apiKey = decryptKey(rec); } catch (e) { continue; }

    // 1) закрыть то, что уже достигло стопа/цели
    const stillOpen = [];
    for (const p of positions) {
      const mark = ctx[p.coin] ? ctx[p.coin].mark : null;
      if (mark == null) { stillOpen.push(p); continue; }
      const long = p.side === 'long';
      const hitStop = long ? mark <= p.stop : mark >= p.stop;
      const hitTarget = long ? mark >= p.target : mark <= p.target;
      const timedOut = !hitStop && !hitTarget && p.openedAt && (Date.now() - p.openedAt > MAX_HOLD_MS);
      if (hitStop || hitTarget || timedOut) {
        try {
          const assetId = assetIds[p.coin];
          const closePx = long ? (mark * (1 - SLIP)).toPrecision(6) : (mark * (1 + SLIP)).toPrecision(6);
          await placeMarketOrder({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId, isBuy: !long, sizeStr: p.size, limitPxStr: closePx, reduceOnly: true });
          const risk = Math.abs(p.entry - p.stop);
          const R = hitTarget ? p.rr : timedOut ? ((long ? mark - p.entry : p.entry - mark) / (risk || 1)) : -1;
          const reason = timedOut ? 'autotrade-timeout' : 'autotrade';
          // Реальный $-результат сделки (не только R) — нужен, чтобы считать
          // комиссию/процент с заработка пользователя в админке, не оценивая
          // его на глаз через риск%, который мог меняться со временем.
          const pnlUsd = (long ? mark - p.entry : p.entry - mark) * parseFloat(p.size);
          await journalWrite(username, { id: 'at' + Date.now().toString(36), coin: p.coin, side: p.side, entry: p.entry, stop: p.stop, target: p.target, exit: mark, R, pnlUsd, closedAt: Date.now(), auto: true, reason });
          results.push(username + ': закрыт ' + p.coin + ' ' + (hitTarget ? 'по цели' : timedOut ? 'по тайм-ауту (5 дней)' : 'по стопу'));
        } catch (e) { stillOpen.push(p); results.push(username + ': ОШИБКА закрытия ' + p.coin + ': ' + e.message); }
      } else stillOpen.push(p);
    }
    positions = stillOpen;

    // 2) если есть свободный слот — искать новый сигнал
    if (positions.length < settings.maxPositions) {
      const balance = await accountValue(rec.mainAddress, rec.isMainnet !== false).catch(() => null);
      // Раньше при balance==null/<=5 функция просто молча ничего не делала —
      // в логах не оставалось никакого следа, почему бот "не торговал". Теперь
      // explicit-сообщение на каждую причину пропуска, видно в логах Netlify.
      if (balance == null) {
        results.push(username + ': не смог получить баланс счёта с Hyperliquid (сеть/адрес?) — пропуск');
      } else if (balance <= 5) {
        results.push(username + ': баланс счёта $' + balance.toFixed(2) + ' слишком мал (нужно > $5) — пропуск');
      } else {
        const coins = Object.entries(ctx).sort((a, b) => b[1].vol - a[1].vol).slice(0, settings.watchN).map(e => e[0]).filter(c => !positions.some(p => p.coin === c));
        const hz = HORIZONS[settings.horizon] || HORIZONS.short;
        const tfSet = new Set(hz.tfs);
        const cache = {};
        const jobs = []; for (const coin of coins) for (const tf of tfSet) jobs.push({ coin, tf });
        await pLimit(jobs, 5, async ({ coin, tf }) => { cache[coin + tf] = await getCandles(coin, tf, 220); });

        let best = null, scanned = 0, candidates = 0;
        for (const coin of coins) {
          const tfData = {}; let ok = true;
          for (const tf of tfSet) { if (!cache[coin + tf]) { ok = false; break; } tfData[tf] = cache[coin + tf]; }
          if (!ok) continue;
          scanned++;
          const f8 = ctx[coin] ? ctx[coin].funding * 800 : 0;
          const a = analyzeGeneric(coin, settings.horizon, tfData, f8);
          if (!a) continue;
          for (const s of a.sigs) { candidates++; if (s.conf >= settings.minConf && (!best || s.conf > best.conf)) best = s; }
        }

        if (!best) {
          results.push(username + ': баланс $' + balance.toFixed(2) + ', просканировано ' + scanned + '/' + coins.length + ' монет, найдено сигналов ' + candidates + ' — ни один не прошёл порог уверенности ' + settings.minConf + '% — пропуск');
        } else {
          const risk = Math.abs(best.entry - best.stop);
          const riskUsd = balance * settings.riskPct / 100;
          const size = risk ? riskUsd / risk : 0;
          const assetId = assetIds[best.coin];
          if (!(size > 0 && assetId != null)) {
            results.push(username + ': лучший сигнал ' + best.coin + ' ' + best.side + ' (conf ' + best.conf + '%), но ' + (assetId == null ? 'не нашли id монеты на бирже' : 'нулевой размер позиции') + ' — пропуск');
          } else {
            const long = best.side === 'long';
            const limitPx = (long ? best.entry * (1 + SLIP) : best.entry * (1 - SLIP)).toPrecision(6);
            try {
              await placeMarketOrder({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId, isBuy: long, sizeStr: size.toPrecision(5), limitPxStr: limitPx });
              positions.push({ coin: best.coin, side: best.side, entry: best.entry, stop: best.stop, target: best.target, rr: best.rr, size: size.toPrecision(5), openedAt: Date.now() });
              results.push(username + ': ОТКРЫТА ' + best.coin + ' ' + best.side + ' (conf ' + best.conf + '%)');
            } catch (e) { results.push(username + ': ОШИБКА открытия ' + best.coin + ': ' + e.message); }
          }
        }
      }
    } else {
      results.push(username + ': все ' + settings.maxPositions + ' слота заняты открытыми позициями — пропуск поиска новых');
    }

    await posStore.setJSON('p:' + username, positions);
  }

  console.log('autotrade run: ' + (results.length ? results.join(' | ') : '(нет подключённых пользователей с автоторговлей)'));
  return new Response(JSON.stringify({ ok: true, log: results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// Раз в 15 минут — совпадает с самым коротким входным таймфреймом (15m) у
// краткосрочного горизонта, чаще не имеет смысла. Это добавляет постоянную
// фоновую нагрузку на кредиты Netlify (как раньше делал monitor.mjs) — если
// кредиты снова начнут заканчиваться раньше цикла, первое, что надо сделать —
// увеличить интервал здесь (например до */30).
export const config = { schedule: '*/15 * * * *' };
