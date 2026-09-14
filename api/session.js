/* Wallet sign-in. GET returns a one-time nonce; POST { address, nonce, signature } checks the signature (no gas, no
   transaction) and returns a session token that identifies the wallet for 30 days. */
import crypto from 'node:crypto';
import { verifyMessage, getAddress } from 'viem';
import { redis } from '../lib/store.js';
import { json, body, message, ipOf } from '../lib/game.js';

export default async function handler(req, res) {
  try {
    const R = redis();
    if (req.method === 'GET') {
      const rl = 'ra:rl:nonce:' + ipOf(req), n = await R.incr(rl);
      if (n === 1) await R.expire(rl, 60);
      if (n > 30) throw Error('Too many sign-in attempts, wait a minute.');
      const nonce = crypto.randomBytes(12).toString('hex');
      await R.set('ra:nonce:' + nonce, '1', { ex: 600 });
      return json(res, 200, { nonce, message: message(nonce) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const b = body(req);
    if (!/^0x[0-9a-fA-F]{40}$/.test(b.address || '') || !/^[a-f0-9]{24}$/.test(b.nonce || '') || !/^0x[0-9a-fA-F]+$/.test(b.signature || '')) throw Error('Sign-in data is incomplete.');
    if (!(await R.get('ra:nonce:' + b.nonce))) throw Error('Sign-in expired, try again.');
    await R.del('ra:nonce:' + b.nonce);
    const address = getAddress(b.address);
    if (!(await verifyMessage({ address, message: message(b.nonce), signature: b.signature }))) throw Error('Signature does not match this wallet.');
    const session = crypto.randomBytes(24).toString('hex');
    await R.set('ra:sess:' + session, address.toLowerCase(), { ex: 86400 * 30 });
    json(res, 200, { session, address });
  } catch (e) { json(res, 400, { error: e.message }); }
}
