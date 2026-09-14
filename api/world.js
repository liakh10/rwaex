/* Public world state: today's totals, top islands, the payday timer, the reward pool and past paydays.
   GET ?address=0x… also returns that wallet's payout history. */
import { formatEther } from 'viem';
import { redis, asHash, asScores } from '../lib/store.js';
import { epochOf } from '../lib/island.js';
import { json, pub, nowSec, msToPayday, STOCKS, token } from '../lib/game.js';
import { operatorAddress } from '../lib/payout.js';

export const GAS_KEEP_ETH = 0.003;

export default async function handler(req, res) {
  try {
    const R = redis(), q = req.query || {}, now = nowSec(), E = epochOf(now);
    let world = await R.get('ra:world');
    if (world) world = JSON.parse(world);
    else {
      const [tot, players, islands, top, paydays] = await Promise.all([
        R.hgetall(`ra:tot:${E}`), R.scard(`ra:players:${E}`), R.scard('ra:islands'),
        R.zrange(`ra:pts:${E}:power`, 0, 9, { rev: true, withScores: true }), R.lrange('ra:paydays', 0, 6)
      ]);
      const t = asHash(tot), op = operatorAddress();
      let eth = null;
      if (op) { try { eth = Number(formatEther(await pub.getBalance({ address: op }))); } catch {} }
      world = {
        epoch: E,
        totals: Object.fromEntries(['power', 'coins', 'press', 'refinery'].map(k => [k, Number(t[k]) || 0])),
        players: Number(players) || 0, islands: Number(islands) || 0,
        top: asScores(top).map(x => ({ address: x.member, power: x.score })),
        paydays: (paydays || []).map(s => typeof s === 'string' ? JSON.parse(s) : s),
        treasury: { address: op, eth, pool: eth == null ? null : Math.max(0, eth - GAS_KEEP_ETH) },
        stocks: STOCKS, token: token(), minHold: process.env.RWAEX_MIN_HOLD || '1000000'
      };
      await R.set('ra:world', JSON.stringify(world), { ex: 15 });
    }
    const out = { ...world, now, msToPayday: msToPayday(now) };
    if (/^0x[0-9a-fA-F]{40}$/.test(q.address || '')) {
      const a = q.address.toLowerCase();
      const [mine, rows] = await Promise.all([
        Promise.all(['press', 'refinery', 'power'].map(r => R.zscore(`ra:pts:${E}:${r}`, a))),
        R.lrange('ra:paid:' + a, 0, 19)
      ]);
      out.me = { press: Number(mine[0]) || 0, refinery: Number(mine[1]) || 0, power: Number(mine[2]) || 0, payouts: (rows || []).map(s => typeof s === 'string' ? JSON.parse(s) : s) };
    }
    json(res, 200, out);
  } catch (e) { json(res, 500, { error: e.message }); }
}
