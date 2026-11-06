// Подпись и отправка ордеров в Hyperliquid Exchange API (L1 actions) с помощью
// "API wallet" (agent wallet) — ограниченного ключа без права вывода средств,
// который пользователь сам создаёт в настройках Hyperliquid (Settings → API)
// и вставляет к нам. Мы НИКОГДА не просим и не храним seed/приватный ключ от
// основного кошелька — только этот ограниченный ключ.
//
// Схема подписи (phantom agent), по официальной документации Hyperliquid:
// 1) action сериализуется в msgpack
// 2) к байтам добавляется nonce (мс) и адрес vault (или 16 нулевых байт)
// 3) keccak256 от результата -> connectionId
// 4) агент {source:'a'|'b', connectionId} подписывается как EIP-712 typed data
//    тем же механизмом, что обычная подпись Ethereum-кошелька (secp256k1).
//
// ВАЖНО: это НЕ протестировано против реального API из этой песочницы — сеть
// отсюда не достаёт до api.hyperliquid.xyz (разрешены только npm/GitHub).
// Проверять нужно на testnet Hyperliquid после деплоя, ПЕРЕД тем как включать
// автоторговлю на реальные деньги.
import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';

const MAINNET_API = 'https://api.hyperliquid.xyz';
const TESTNET_API = 'https://api.hyperliquid-testnet.xyz';

function addressToBytes(addr) {
  if (!addr) return new Uint8Array(20);
  return ethers.getBytes(addr);
}

async function signL1Action(privateKey, action, nonce, isMainnet, vaultAddress) {
  const actionBytes = msgpackEncode(action);
  const vaultBytes = vaultAddress ? ethers.concat([new Uint8Array([1]), addressToBytes(vaultAddress)]) : new Uint8Array([0]);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false);
  const data = ethers.concat([actionBytes, nonceBytes, vaultBytes]);
  const connectionId = ethers.keccak256(data);

  const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
  const types = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
  const value = { source: isMainnet ? 'a' : 'b', connectionId };

  const wallet = new ethers.Wallet(privateKey);
  const sig = await wallet.signTypedData(domain, types, value);
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

async function postExchange(isMainnet, payload) {
  const base = isMainnet ? MAINNET_API : TESTNET_API;
  const r = await fetch(base + '/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Hyperliquid HTTP ' + r.status + ': ' + JSON.stringify(j));
  return j;
}

// КРИТИЧНО: Hyperliquid /exchange почти всегда отвечает HTTP 200 даже когда
// отклоняет сам ордер/действие по бизнес-причине (недостаточно маржи,
// невалидный размер, плечо нельзя сменить при открытой позиции и т.п.) —
// сама ошибка лежит внутри JSON-тела (status:'err', или per-order error в
// response.data.statuses[]). Раньше postExchange() проверял только HTTP-код,
// поэтому autotrade.mjs считал ЛЮБОЙ ответ без сетевой ошибки успехом и писал
// "ОТКРЫТА", даже когда ордер реально не исполнился (проверено на practике:
// лог сказал "ОТКРЫТА AAVE long", а в Order History на Hyperliquid — пусто).
function assertExchangeOk(j, actionType) {
  if (!j) throw new Error('Hyperliquid: пустой/невалидный ответ от /exchange');
  if (j.status !== 'ok') throw new Error('Hyperliquid отклонил запрос: ' + (typeof j.response === 'string' ? j.response : JSON.stringify(j.response)));
  if (actionType === 'order' && j.response && j.response.data && Array.isArray(j.response.data.statuses)) {
    const errs = j.response.data.statuses.filter(s => s && s.error);
    if (errs.length) throw new Error('Hyperliquid отклонил ордер: ' + errs.map(s => s.error).join('; '));
  }
  return j;
}

// coinToAssetId: Hyperliquid ордера адресуются индексом актива (не именем),
// его нужно взять из meta() (universe[]), тут принимаем готовый assetId.
export async function placeMarketOrder({ privateKey, isMainnet = true, assetId, isBuy, sizeStr, limitPxStr, reduceOnly = false }) {
  const nonce = Date.now();
  const order = {
    a: assetId, b: isBuy, p: limitPxStr, s: sizeStr, r: reduceOnly,
    t: { limit: { tif: 'Ioc' } } // IOC с ценой-ограничителем = исполняется как маркет-ордер с защитой от слиппеджа
  };
  const action = { type: 'order', orders: [order], grouping: 'na' };
  const signature = await signL1Action(privateKey, action, nonce, isMainnet, null);
  const j = await postExchange(isMainnet, { action, nonce, signature });
  return assertExchangeOk(j, 'order');
}

// Явно выставить плечо для актива ПЕРЕД открытием позиции — раньше бот
// вообще не трогал плечо и ордер открывался с тем, что уже было настроено на
// аккаунте (могло быть что угодно, вплоть до максимального для актива), из-за
// чего цена ликвидации могла оказаться ближе стопа. isCross=true — то же
// кросс-маржинальное плечо, что показывает Hyperliquid UI по умолчанию.
export async function updateLeverage({ privateKey, isMainnet = true, assetId, leverage, isCross = true }) {
  const nonce = Date.now();
  const action = { type: 'updateLeverage', asset: assetId, isCross, leverage: Math.round(leverage) };
  const signature = await signL1Action(privateKey, action, nonce, isMainnet, null);
  const j = await postExchange(isMainnet, { action, nonce, signature });
  return assertExchangeOk(j, 'updateLeverage');
}

// Отдаём не просто индекс актива, а ещё szDecimals (сколько знаков после
// запятой разрешено у размера ордера — у каждого актива своё, от 0 у PUMP/LIT
// до 5 у BTC) и onlyIsolated (некоторые активы, например HYPE на testnet,
// торгуются ТОЛЬКО с изолированной маржой — updateLeverage с isCross:true для
// них Hyperliquid отклоняет с "Cross margin is not allowed for this asset").
// Раньше отдавался только индекс, из-за чего size/price округлялись одним
// и тем же фиксированным числом цифр для всех монет и ловили "Order has
// invalid size"/"invalid price", а плечо всегда пыталось выставиться кросс.
export async function getAssetMeta(isMainnet = true) {
  const base = isMainnet ? MAINNET_API : TESTNET_API;
  const r = await fetch(base + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
  const j = await r.json();
  const out = {};
  (j.universe || []).forEach((u, i) => { out[u.name] = { id: i, szDecimals: u.szDecimals || 0, onlyIsolated: !!u.onlyIsolated }; });
  return out;
}

// Размер ордера должен иметь ровно szDecimals знаков после запятой (не
// больше), иначе Hyperliquid отвечает "Order has invalid size". Округляем
// ВНИЗ (Math.floor), а не до ближайшего — чтобы случайно не запросить размер
// чуть больше того, что позволяет риск/маржа.
export function formatSize(size, szDecimals) {
  const f = Math.pow(10, szDecimals || 0);
  const n = Math.floor(Math.max(0, size) * f) / f;
  return n.toFixed(szDecimals || 0);
}

// Цена у Hyperliquid ограничена 5 значащими цифрами И не более (6 - szDecimals)
// знаков после запятой для перпов — фиксированные toPrecision(6) ломались на
// мелких монетах (PUMP и т.п., szDecimals=0 → максимум 6 знаков после запятой,
// но 5 значащих цифр уже обрезают раньше) и давали "Order has invalid price".
export function formatPrice(price, szDecimals) {
  const maxDecimals = Math.max(0, 6 - (szDecimals || 0));
  let n = Number(price.toPrecision(5));
  n = Number(n.toFixed(maxDecimals));
  return n.toString();
}
