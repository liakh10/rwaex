/* The player's island. GET ?session= returns the island projected to now (nothing is saved). POST { session, action,
   pad, kind, route } syncs production into the ledgers, applies one action and saves. */
import { redis, withLocks } from '../lib/store.js';
import { act, stats, rates, epochOf } from '../lib/island.js';
import { json, body, playerOf, holderStatus, ensureIsland, syncAndSave, nowSec, msToPayday, STOCKS } from '../lib/game.js';

function view(address, isl, holder, now, result) {
  return { address, now, epoch: epochOf(now), msToPayday: msToPayday(now), island: isl, stats: stats(isl), rates: rates(isl), holder, stocks: STOCKS, result: result || null };
}

export default async function handler(req, res) {
  try {
    const b = req.method === 'POST' ? body(req) : (req.query || {});
    const address = await playerOf(b.session);
    if (!address) return json(res, 401, { error: 'Sign in with your wallet first.' });
    const holder = await holderStatus(address);
    if (req.method === 'GET') {
      /* the saved island, not projected: the page runs the same rules every second from `last` */
      const now = nowSec(), isl = await ensureIsland(address, now);
      return json(res, 200, view(address, isl, holder, now));
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const R = redis(), rl = 'ra:rl:act:' + address, n = await R.incr(rl);
    if (n === 1) await R.expire(rl, 60);
    if (n > 90) throw Error('Slow down a little.');
    const out = await withLocks([address], async () => {
      const now = nowSec(), isl = await ensureIsland(address, now);
      let result;
      await syncAndSave(address, isl, now, i => { result = act(i, String(b.action || ''), b, now, holder); });
      return view(address, isl, holder, now, result);
    });
    json(res, 200, out);
  } catch (e) { json(res, 400, { error: e.message }); }
}
