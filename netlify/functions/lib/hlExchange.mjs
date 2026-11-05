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
  return postExchange(isMainnet, { action, nonce, signature });
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
  return postExchange(isMainnet, { action, nonce, signature });
}

export async function getAssetMeta(isMainnet = true) {
  const base = isMainnet ? MAINNET_API : TESTNET_API;
  const r = await fetch(base + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
  const j = await r.json();
  const out = {};
  (j.universe || []).forEach((u, i) => { out[u.name] = i; });
  return out;
}
