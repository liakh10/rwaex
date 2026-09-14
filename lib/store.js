/* Storage: Upstash Redis provisioned through the Vercel Marketplace.
   RWAEX_MEMORY=1 is only for the local dev server; production never sets it. */
import { Redis } from '@upstash/redis';

let client = null;
export function redis() {
  if (client) return client;
  if (process.env.RWAEX_MEMORY === '1') return (client = memory());
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw Error('Storage is not connected yet.');
  return (client = new Redis({ url, token, automaticDeserialization: false }));
}

/* Upstash returns hashes and scored ranges as flat arrays when deserialization is off */
export const asHash = o => { if (!Array.isArray(o)) return o || {}; const m = {}; for (let i = 0; i < o.length; i += 2) m[o[i]] = o[i + 1]; return m; };
export const asScores = arr => { const out = []; for (let i = 0; i < (arr || []).length; i += 2) out.push({ member: arr[i], score: Number(arr[i + 1]) }); return out; };

export async function withLocks(keys, fn) {
  const R = redis(), tok = Math.random().toString(36).slice(2), held = [];
  try {
    for (const k of keys) {
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        if (await R.set('ra:lock:' + k, tok, { nx: true, px: 8000 })) ok = true;
        else await new Promise(r => setTimeout(r, 80));
      }
      if (!ok) throw Error('The island is busy, try again.');
      held.push(k);
    }
    return await fn();
  } finally {
    for (const k of held) { try { if ((await R.get('ra:lock:' + k)) === tok) await R.del('ra:lock:' + k); } catch {} }
  }
}

function memory() {
  const kv = new Map(), exp = new Map(), zs = new Map(), hs = new Map(), sets = new Map(), lists = new Map();
  const alive = k => { const e = exp.get(k); if (e && e < Date.now()) { kv.delete(k); zs.delete(k); hs.delete(k); sets.delete(k); lists.delete(k); exp.delete(k); } return true; };
  const z = k => { alive(k); if (!zs.has(k)) zs.set(k, new Map()); return zs.get(k); };
  const h = k => { alive(k); if (!hs.has(k)) hs.set(k, new Map()); return hs.get(k); };
  return {
    async get(k) { alive(k); return kv.has(k) ? kv.get(k) : null; },
    async set(k, v, o = {}) { alive(k); if (o.nx && kv.has(k)) return null; kv.set(k, String(v)); if (o.px) exp.set(k, Date.now() + o.px); else if (o.ex) exp.set(k, Date.now() + o.ex * 1000); else exp.delete(k); return 'OK'; },
    async del(k) { kv.delete(k); zs.delete(k); hs.delete(k); sets.delete(k); lists.delete(k); exp.delete(k); return 1; },
    async incr(k) { alive(k); const v = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(v)); return v; },
    async expire(k, s) { exp.set(k, Date.now() + s * 1000); return 1; },
    async zincrby(k, by, m) { const s = z(k); s.set(m, (s.get(m) || 0) + Number(by)); return s.get(m); },
    async zscore(k, m) { const s = z(k); return s.has(m) ? String(s.get(m)) : null; },
    async zrange(k, a, b, o = {}) { let e = [...z(k).entries()].sort((x, y) => o.rev ? y[1] - x[1] : x[1] - y[1]); e = e.slice(a, b < 0 ? e.length + b + 1 : b + 1); return o.withScores ? e.flatMap(([m, sc]) => [m, String(sc)]) : e.map(x => x[0]); },
    async zcard(k) { return z(k).size; },
    async hincrbyfloat(k, f, by) { const s = h(k); s.set(f, (Number(s.get(f)) || 0) + Number(by)); return String(s.get(f)); },
    async hgetall(k) { const s = h(k); return s.size ? Object.fromEntries(s) : null; },
    async sadd(k, ...m) { alive(k); if (!sets.has(k)) sets.set(k, new Set()); const s = sets.get(k); const n = s.size; m.flat().forEach(x => s.add(x)); return s.size - n; },
    async scard(k) { alive(k); return sets.has(k) ? sets.get(k).size : 0; },
    async lpush(k, ...v) { alive(k); const a = lists.get(k) || []; a.unshift(...v.flat().reverse()); lists.set(k, a); return a.length; },
    async lrange(k, s, e) { alive(k); const a = lists.get(k) || []; return a.slice(s, e < 0 ? a.length + e + 1 : e + 1); },
    async ltrim(k, s, e) { alive(k); const a = lists.get(k) || []; lists.set(k, a.slice(s, e + 1)); return 'OK'; }
  };
}
