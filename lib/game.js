/* Server helpers: wallet sessions, $RWAEX holder checks, saving islands and the per-epoch ledgers. */
import { createPublicClient, http, fallback, erc20Abi, parseUnits } from 'viem';
import { redis } from './store.js';
import { newIsland, sync, epochOf, DAY } from './island.js';

export const CHAIN = {
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } }
};
export const pub = createPublicClient({ chain: CHAIN, transport: fallback(CHAIN.rpcUrls.default.http.map(u => http(u, { timeout: 15000 }))) });
export const STOCKS = {
  press: { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  refinery: { symbol: 'GLD', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e' }
};
export const message = nonce => `Rwaex\nSign in to build your island. No transaction, no gas.\nNonce: ${nonce}`;
export const nowSec = () => Math.floor(Date.now() / 1000);
export const msToPayday = (t = nowSec()) => ((epochOf(t) + 1) * DAY - t) * 1000;
const KEEP = 86400 * 45;

export async function playerOf(session) {
  if (!/^[a-f0-9]{48}$/.test(String(session || ''))) return null;
  return (await redis().get('ra:sess:' + session)) || null;
}

/* the $RWAEX contract and minimum holding come from env; before launch everyone counts as eligible for payouts
   but nobody gets the holder fuel bonus */
export const token = () => (/^0x[0-9a-fA-F]{40}$/.test(process.env.RWAEX_CA || '') ? process.env.RWAEX_CA : null);
export const minHold = () => parseUnits(String(process.env.RWAEX_MIN_HOLD || '1000000'), 18);

export async function holderStatus(address) {
  const ca = token();
  if (!ca) return { launched: false, holder: false, eligible: true, balance: '0' };
  const R = redis(), k = 'ra:hold:' + address, c = await R.get(k);
  if (c) return JSON.parse(c);
  let bal = 0n;
  try { bal = await pub.readContract({ address: ca, abi: erc20Abi, functionName: 'balanceOf', args: [address] }); } catch {}
  const s = { launched: true, holder: bal >= minHold(), eligible: bal >= minHold(), balance: bal.toString() };
  await R.set(k, JSON.stringify(s), { ex: 300 });
  return s;
}

export async function loadIsland(address) {
  const s = await redis().get('ra:isl:' + address);
  return s ? JSON.parse(s) : null;
}

/* syncs production into the island and writes this epoch's ledgers; returns the gain */
export async function syncAndSave(address, isl, now, extra) {
  const R = redis(), gain = sync(isl, now), ep = epochOf(now);
  const writes = [];
  if (gain.press > 0) writes.push(R.zincrby(`ra:pts:${ep}:press`, gain.press, address));
  if (gain.refinery > 0) writes.push(R.zincrby(`ra:pts:${ep}:refinery`, gain.refinery, address));
  if (gain.power > 0) writes.push(R.zincrby(`ra:pts:${ep}:power`, gain.power, address));
  for (const f of ['power', 'coins', 'press', 'refinery']) if (gain[f] > 0) writes.push(R.hincrbyfloat(`ra:tot:${ep}`, f, gain[f]));
  writes.push(R.sadd(`ra:players:${ep}`, address));
  await Promise.all(writes);
  if (extra) extra(isl);
  await R.set('ra:isl:' + address, JSON.stringify(isl));
  await Promise.all([`ra:pts:${ep}:press`, `ra:pts:${ep}:refinery`, `ra:pts:${ep}:power`, `ra:tot:${ep}`, `ra:players:${ep}`].map(k => R.expire(k, KEEP)));
  return gain;
}

export async function ensureIsland(address, now) {
  let isl = await loadIsland(address);
  if (!isl) {
    isl = newIsland(now);
    await redis().set('ra:isl:' + address, JSON.stringify(isl));
    await redis().sadd('ra:islands', address);
  }
  return isl;
}

export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v));
}
export const body = req => typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
export const ipOf = req => String(req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
