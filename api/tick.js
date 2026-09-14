/* Payday service. Runs every few minutes (GitHub Actions cron with CRON_SECRET, or a page poke at most once a minute).
   1. claim   Pons creator fees waiting in the fee escrow for the operator wallet
   2. payday  once per closed epoch: split the operator's ETH (minus a gas reserve) between the NVDA and GLD routes by
              their eligible points, buy each Stock Token, then pay the top 150 islands of each route pro-rata.
   Every step is saved before the next, so a run that times out continues where it stopped. */
import { erc20Abi, parseEther, formatEther } from 'viem';
import { redis, withLocks, asScores } from '../lib/store.js';
import { epochOf } from '../lib/island.js';
import { json, pub, nowSec, STOCKS, token, minHold } from '../lib/game.js';
import { operator, claimCreatorFees, buy, transferStock } from '../lib/payout.js';

const GAS_KEEP = parseEther('0.003'), MIN_POOL = parseEther('0.002'), MAX_RECIPIENTS = 150, BUDGET_MS = 240000;
const LEGS = ['press', 'refinery'];

export default async function handler(req, res) {
  const R = redis(), q = req.query || {}, secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === 'Bearer ' + secret || q.secret === secret);
  if (!authed && !(await R.set('ra:poke', '1', { nx: true, ex: 60 }))) return json(res, 200, { ok: true, skipped: 'recent run' });
  let o;
  try { o = operator(); } catch (e) { return json(res, 200, { ok: false, skipped: e.message }); }
  try {
    const log = await withLocks(['operator'], () => run(o));
    json(res, 200, { ok: true, log });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function eligibleOnly(rows) {
  const ca = token();
  if (!ca || !rows.length) return rows;
  const res = await pub.multicall({ allowFailure: true, contracts: rows.map(r => ({ address: ca, abi: erc20Abi, functionName: 'balanceOf', args: [r.member] })) });
  const min = minHold();
  return rows.filter((r, i) => (res[i].result || 0n) >= min);
}

async function run(o) {
  const R = redis(), started = Date.now(), log = [];
  const save = st => R.set('ra:payday:' + st.epoch, JSON.stringify(st));

  const c = await claimCreatorFees(o).catch(e => ({ error: e.message }));
  if (c) log.push({ claim: c.error || formatEther(c.amount) });

  const E = epochOf(nowSec()) - 1;
  let st = await R.get('ra:payday:' + E);
  st = st ? JSON.parse(st) : null;
  if (st && st.done) return log.concat({ epoch: E, done: true });

  if (!st) {
    const legs = {};
    for (const leg of LEGS) {
      const rows = asScores(await R.zrange(`ra:pts:${E}:${leg}`, 0, -1, { rev: true, withScores: true })).filter(r => r.score > 0);
      const list = (await eligibleOnly(rows)).slice(0, MAX_RECIPIENTS).map(r => ({ a: r.member, p: r.score }));
      legs[leg] = { stock: STOCKS[leg].symbol, pts: list.reduce((s, r) => s + r.p, 0), list, eth: '0', bought: null, swapTx: null, paid: {} };
    }
    const bal = await pub.getBalance({ address: o.address });
    const pool = bal > GAS_KEEP ? bal - GAS_KEEP : 0n;
    const total = legs.press.pts + legs.refinery.pts;
    if (!total || pool < MIN_POOL) {
      st = { epoch: E, done: true, at: nowSec(), pool: pool.toString(), note: !total ? 'No eligible stock points that day' : 'Pool under 0.002 ETH, it rolls into the next payday', legs: {} };
      await save(st);
      await R.lpush('ra:paydays', JSON.stringify(summary(st)));
      await R.ltrim('ra:paydays', 0, 29);
      return log.concat({ epoch: E, note: st.note });
    }
    const ethPress = pool * BigInt(Math.round(legs.press.pts * 1000)) / BigInt(Math.round(total * 1000));
    legs.press.eth = ethPress.toString();
    legs.refinery.eth = (pool - ethPress).toString();
    st = { epoch: E, done: false, at: nowSec(), pool: pool.toString(), legs };
    await save(st);
    log.push({ epoch: E, pool: formatEther(pool), press: formatEther(ethPress), refinery: formatEther(pool - ethPress) });
  }

  for (const leg of LEGS) {
    const L = st.legs[leg];
    if (L.bought == null && BigInt(L.eth) > 0n && L.list.length) {
      const r = await buy(o, leg, BigInt(L.eth));
      L.bought = r.bought.toString(); L.swapTx = r.hash;
      await save(st);
      log.push({ bought: leg, amount: formatEther(r.bought), tx: r.hash });
    }
  }

  for (const leg of LEGS) {
    const L = st.legs[leg];
    if (L.bought == null) continue;
    const pot = BigInt(L.bought), sum = BigInt(Math.round(L.pts * 1000));
    for (const r of L.list) {
      if (L.paid[r.a]) continue;
      if (Date.now() - started > BUDGET_MS) return log.concat({ partial: true });
      const amount = sum > 0n ? pot * BigInt(Math.round(r.p * 1000)) / sum : 0n;
      if (amount === 0n) { L.paid[r.a] = { amount: '0' }; continue; }
      L.paid[r.a] = { amount: amount.toString(), tx: 'pending' };
      await save(st);
      const tx = await transferStock(o, leg, r.a, amount);
      L.paid[r.a].tx = tx;
      await save(st);
      await R.lpush('ra:paid:' + r.a, JSON.stringify({ epoch: E, stock: L.stock, amount: amount.toString(), points: r.p, tx }));
      await R.ltrim('ra:paid:' + r.a, 0, 19);
    }
  }
  st.done = true;
  await save(st);
  await R.lpush('ra:paydays', JSON.stringify(summary(st)));
  await R.ltrim('ra:paydays', 0, 29);
  return log.concat({ epoch: E, done: true });
}

function summary(st) {
  return {
    epoch: st.epoch, at: st.at, pool: st.pool, note: st.note || null,
    legs: Object.fromEntries(Object.entries(st.legs || {}).map(([k, L]) => [k, { stock: L.stock, eth: L.eth, bought: L.bought, swapTx: L.swapTx, recipients: Object.values(L.paid).filter(p => p.amount !== '0').length, points: L.pts }]))
  };
}
