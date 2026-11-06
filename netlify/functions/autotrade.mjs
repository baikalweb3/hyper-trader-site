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
import { placeMarketOrder, getAssetMeta, updateLeverage, formatSize, formatPrice } from './lib/hlExchange.mjs';
import { decryptKey } from './wallet.mjs';

const API = 'https://api.hyperliquid.xyz/info';
const DEFAULT_MIN_CONF = 55;
const DEFAULT_MAX_POS = 3;
// Плечо по умолчанию для новых позиций, если пользователь не задал своё —
// намеренно консервативное (кросс-маржа). Выставляется явно на аккаунте
// перед КАЖДЫМ новым ордером (см. блок открытия позиции ниже), а не
// предполагается — раньше бот вообще не трогал плечо и использовал то, что
// уже было настроено на Hyperliquid для актива, что могло быть чем угодно.
const DEFAULT_LEVERAGE = 3;
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

// Дневной лимит потерь — раньше проверялся только на клиенте при РУЧНОМ
// нажатии "Взять сделку" (index.html), а сама автоторговля (эта функция)
// его вообще не видела и могла открывать новые позиции весь день подряд,
// сколько бы ни было уже слито с утра. Теперь считаем сегодняшний убыток по
// уже закрытым авто-сделкам из того же журнала, которым эта функция сама и
// пишет записи (auto:true), и останавливаем поиск новых входов, если дневной
// бюджет потерь исчерпан — до следующего календарного дня (UTC).
async function todayLossUsd(username) {
  const jStore = getStore('hyper-trader-journal');
  const rows = (await jStore.get('j:' + username, { type: 'json' })) || [];
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const cutoff = dayStart.getTime();
  let loss = 0;
  for (const r of rows) {
    if (!r.auto || !r.closedAt || r.closedAt < cutoff) continue;
    if (typeof r.pnlUsd === 'number' && r.pnlUsd < 0) loss += -r.pnlUsd;
  }
  return loss;
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
    const settings = Object.assign({ riskPct: 1, horizon: 'short', maxPositions: DEFAULT_MAX_POS, minConf: DEFAULT_MIN_CONF, watchN: 15, dailyLimitPct: 5, leverage: DEFAULT_LEVERAGE }, rec.settings || {});
    const assetIds = assetIdsByNet[rec.isMainnet !== false ? 'main' : 'test'];
    const posStore = getStore('hyper-trader-autopos');
    let positions = (await posStore.get('p:' + username, { type: 'json' })) || [];

    let apiKey;
    try { apiKey = decryptKey(rec); } catch (e) { continue; }

    // 1) управление открытыми позициями: частичное закрытие на 1R → стоп в
    // безубыток → трейлинг-стоп по ATR на остатке, и обычное закрытие по
    // стопу/цели/тайм-ауту.
    //
    // Раньше позиция всегда закрывалась целиком либо по фиксированному стопу,
    // либо по фиксированной цели (rr×risk) — трейд с сильным движением давал
    // ровно 2R и ни центом больше, а трейд с слабым движением не давал забрать
    // частичную прибыль перед разворотом. Теперь: как только цена доходит до
    // 1R — закрываем половину объёма рынком, подтягиваем стоп на оставшуюся
    // половину в безубыток (entry), и дальше ведём его трейлингом (экстремум
    // цены за время удержания минус/плюс 1.5×ATR, подтягивается только в
    // выгодную сторону) — так сильный тренд сам "довозит" сделку дальше
    // фиксированных 2R, а слабый выбивает раньше на меньшем, но всё равно
    // положительном результате. Фиксированный target после частичного
    // закрытия больше не используется — его заменяет трейлинг.
    const stillOpen = [];
    for (const p of positions) {
      const mark = ctx[p.coin] ? ctx[p.coin].mark : null;
      if (mark == null) { stillOpen.push(p); continue; }
      const long = p.side === 'long';
      const origStop = p.origStop != null ? p.origStop : p.stop;
      const risk = Math.abs(p.entry - origStop);

      // 1a) частичное закрытие на 1R (один раз за сделку)
      if (!p.partialTaken && risk > 0) {
        const oneR = long ? p.entry + risk : p.entry - risk;
        const hit1R = long ? mark >= oneR : mark <= oneR;
        if (hit1R) {
          try {
            const am = assetIds[p.coin];
            if (!am) throw new Error('монета пропала из списка активов биржи');
            const half = (parseFloat(p.size) / 2);
            const halfStr = formatSize(half, am.szDecimals);
            const closePx = formatPrice(long ? mark * (1 - SLIP) : mark * (1 + SLIP), am.szDecimals);
            await placeMarketOrder({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId: am.id, isBuy: !long, sizeStr: halfStr, limitPxStr: closePx, reduceOnly: true });
            const pnlUsd = (long ? mark - p.entry : p.entry - mark) * half;
            await journalWrite(username, { id: 'atp' + Date.now().toString(36), coin: p.coin, side: p.side, entry: p.entry, stop: p.stop, target: p.target, exit: mark, R: 1, pnlUsd, closedAt: Date.now(), auto: true, reason: 'autotrade-partial', partial: true });
            p.size = formatSize(parseFloat(p.size) - half, am.szDecimals);
            p.partialTaken = true;
            p.stop = p.entry; // безубыток на остатке
            p.trailExtreme = mark;
            results.push(username + ': ' + p.coin + ' частично закрыт 50% на 1R ($' + pnlUsd.toFixed(2) + '), стоп переведён в безубыток, остаток идёт трейлингом');
          } catch (e) { results.push(username + ': ОШИБКА частичного закрытия ' + p.coin + ': ' + e.message); }
        }
      }

      // 1b) трейлинг-стоп на остатке после частичного закрытия
      if (p.partialTaken && p.atr) {
        p.trailExtreme = long ? Math.max(p.trailExtreme != null ? p.trailExtreme : mark, mark) : Math.min(p.trailExtreme != null ? p.trailExtreme : mark, mark);
        const trailCandidate = long ? p.trailExtreme - 1.5 * p.atr : p.trailExtreme + 1.5 * p.atr;
        if (long && trailCandidate > p.stop) p.stop = trailCandidate;
        if (!long && trailCandidate < p.stop) p.stop = trailCandidate;
      }

      // 1c) закрытие по стопу / (не-частичной) цели / тайм-ауту
      const hitStop = long ? mark <= p.stop : mark >= p.stop;
      const hitTarget = !p.partialTaken && (long ? mark >= p.target : mark <= p.target);
      const timedOut = !hitStop && !hitTarget && p.openedAt && (Date.now() - p.openedAt > MAX_HOLD_MS);
      if (hitStop || hitTarget || timedOut) {
        try {
          const am = assetIds[p.coin];
          if (!am) throw new Error('монета пропала из списка активов биржи');
          const closePx = formatPrice(long ? mark * (1 - SLIP) : mark * (1 + SLIP), am.szDecimals);
          await placeMarketOrder({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId: am.id, isBuy: !long, sizeStr: formatSize(parseFloat(p.size), am.szDecimals), limitPxStr: closePx, reduceOnly: true });
          const R = hitTarget ? p.rr : timedOut ? ((long ? mark - p.entry : p.entry - mark) / (risk || 1)) : (p.partialTaken ? ((long ? mark - p.entry : p.entry - mark) / (risk || 1)) : -1);
          const reason = timedOut ? 'autotrade-timeout' : (p.partialTaken ? 'autotrade-trail' : 'autotrade');
          // Реальный $-результат сделки (не только R) — нужен, чтобы считать
          // комиссию/процент с заработка пользователя в админке, не оценивая
          // его на глаз через риск%, который мог меняться со временем.
          const pnlUsd = (long ? mark - p.entry : p.entry - mark) * parseFloat(p.size);
          await journalWrite(username, { id: 'at' + Date.now().toString(36), coin: p.coin, side: p.side, entry: p.entry, stop: p.stop, target: p.target, exit: mark, R, pnlUsd, closedAt: Date.now(), auto: true, reason });
          results.push(username + ': закрыт ' + p.coin + ' ' + (hitTarget ? 'по цели' : timedOut ? 'по тайм-ауту (5 дней)' : p.partialTaken ? 'по трейлинг-стопу' : 'по стопу'));
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
      const lossToday = balance != null ? await todayLossUsd(username).catch(() => 0) : 0;
      const lossBudget = balance != null ? balance * settings.dailyLimitPct / 100 : 0;
      if (balance == null) {
        results.push(username + ': не смог получить баланс счёта с Hyperliquid (сеть/адрес?) — пропуск');
      } else if (balance <= 5) {
        results.push(username + ': баланс счёта $' + balance.toFixed(2) + ' слишком мал (нужно > $5) — пропуск');
      } else if (lossToday >= lossBudget) {
        results.push(username + ': дневной лимит потерь исчерпан (-$' + lossToday.toFixed(2) + ' из допустимых $' + lossBudget.toFixed(2) + ') — новые сделки до завтра не открываются');
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
          const am = assetIds[best.coin];
          // Проверка "не ближе ли ликвидация, чем стоп": при кросс-марже точная
          // цена ликвидации зависит от всего аккаунта, но грубая безопасная
          // оценка для отдельной позиции — расстояние до ликвидации ≈ entry/leverage.
          // Если стоп дальше этой дистанции (с запасом 20%), цена, скорее всего,
          // дойдёт до ликвидации раньше стопа — такую сделку не открываем вообще,
          // а не просто рискуем получить убыток больше расчётного 1R.
          const stopPct = best.entry ? risk / best.entry : 1;
          const liqSafetyPct = settings.leverage ? (1 / settings.leverage) * 0.8 : 1;
          const liqTooClose = stopPct >= liqSafetyPct;
          if (liqTooClose) {
            results.push(username + ': лучший сигнал ' + best.coin + ' ' + best.side + ' (conf ' + best.conf + '%), но стоп (' + (stopPct * 100).toFixed(2) + '% от цены) дальше безопасной дистанции до ликвидации при плече ' + settings.leverage + 'x — пропуск');
          } else if (!(size > 0 && am != null)) {
            results.push(username + ': лучший сигнал ' + best.coin + ' ' + best.side + ' (conf ' + best.conf + '%), но ' + (am == null ? 'не нашли id монеты на бирже' : 'нулевой размер позиции') + ' — пропуск');
          } else {
            const long = best.side === 'long';
            const limitPx = formatPrice(long ? best.entry * (1 + SLIP) : best.entry * (1 - SLIP), am.szDecimals);
            const sizeStr = formatSize(size, am.szDecimals);
            try {
              if (parseFloat(sizeStr) <= 0) throw new Error('размер позиции после округления под точность актива (' + am.szDecimals + ' знаков) стал нулевым — риск% слишком мал для этой монеты при текущем балансе');
              // Плечо выставляем явно перед КАЖДЫМ новым ордером — не
              // полагаемся на то, что уже настроено на аккаунте для актива.
              // isCross берём из meta: некоторые активы (например HYPE на
              // testnet) торгуются ТОЛЬКО с изолированной маржой, и Hyperliquid
              // отклоняет updateLeverage с isCross:true для них ("Cross margin
              // is not allowed for this asset") — раньше всегда слали true.
              // Ошибку выставления плеча не считаем фатальной для сделки (биржа
              // могла уже иметь такое же плечо и просто не дать его "обновить"),
              // но логируем, чтобы было видно в логах Netlify.
              await updateLeverage({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId: am.id, leverage: settings.leverage, isCross: !am.onlyIsolated }).catch(e => results.push(username + ': не удалось выставить плечо ' + settings.leverage + 'x для ' + best.coin + ': ' + e.message));
              await placeMarketOrder({ privateKey: apiKey, isMainnet: rec.isMainnet !== false, assetId: am.id, isBuy: long, sizeStr, limitPxStr: limitPx });
              // origStop/atr нужны для частичного закрытия на 1R и трейлинг-стопа
              // (см. блок 1a/1b выше) — origStop фиксирует исходный риск сделки,
              // т.к. p.stop после частичного закрытия двигается (безубыток, трейлинг).
              positions.push({ coin: best.coin, side: best.side, entry: best.entry, stop: best.stop, origStop: best.stop, target: best.target, rr: best.rr, atr: best.atr, size: sizeStr, openedAt: Date.now(), partialTaken: false, trailExtreme: null });
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
