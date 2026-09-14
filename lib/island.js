/* Rwaex island rules. Pure functions shared by the API and the page: the page runs the same projection every second
   so numbers tick up live, the server is the only place that saves. Time is in seconds, rates are per hour.

   A day (00:00 UTC to 00:00 UTC) is one epoch. Machines produce power; the island's route decides what power becomes:
   grid -> coins to build with, press -> NVDA points, refinery -> GLD points. At payday the reward pool is split
   between the NVDA and GLD routes by their points and paid in those Stock Tokens, pro-rata to each player's points. */

export const PADS = 9;
export const CENTER = 4;
export const UNLOCK = { 1: [1, 2, 6, 7], 2: [1, 2, 3, 5, 6, 7], 3: [0, 1, 2, 3, 5, 6, 7, 8] };
export const VAULT_UPGRADE = { 2: 600, 3: 2400 };
export const MACHINES = {
  mine: { name: 'Gold Mine', cost: 80, power: 4, blurb: '4 power an hour, no fuel' },
  derrick: { name: 'Oil Derrick', cost: 300, power: 12, fuel: 1, blurb: '12 power an hour, burns 1 fuel an hour' },
  warehouse: { name: 'Warehouse', cost: 200, hours: 2, tank: 10, blurb: '+2 hours of offline storage, +10 fuel tank' },
  press: { name: 'Stock Press', cost: 700, convert: 8, route: 'press', blurb: 'Turns up to 8 power an hour into NVDA points' },
  refinery: { name: 'Bullion Refinery', cost: 700, convert: 8, route: 'refinery', blurb: 'Turns up to 8 power an hour into GLD points' }
};
export const ROUTES = {
  grid: { name: 'Sell to grid', gives: 'coins' },
  press: { name: 'Stock Press', gives: 'NVDA points', machine: 'press' },
  refinery: { name: 'Bullion Refinery', gives: 'GLD points', machine: 'refinery' }
};
export const BASE_HOURS = 4;
export const BASE_TANK = 30;
export const CRATE_FUEL = 10;
export const HOLDER_CRATE_FUEL = 20;
export const CRATE_EVERY = 8 * 3600;
export const SPILL_RATE = 0.25;
export const DAY = 86400;

export const epochOf = t => Math.floor(t / DAY);
export const round3 = v => Math.round(v * 1000) / 1000;
const count = (isl, kind) => isl.pads.filter(p => p === kind).length;

export function newIsland(now) {
  const pads = Array(PADS).fill(null);
  pads[CENTER] = 'vault';
  pads[1] = 'mine';
  return {
    v: 1, level: 1, pads, coins: 100, fuel: 10, route: 'grid', routeEpoch: -1, last: now, crateAt: 0, createdAt: now,
    points: { epoch: epochOf(now), press: 0, refinery: 0, power: 0 },
    lifetime: { power: 0, coins: 0, press: 0, refinery: 0 }
  };
}

export function stats(isl) {
  const warehouses = count(isl, 'warehouse');
  return {
    mines: count(isl, 'mine'), derricks: count(isl, 'derrick'), warehouses, presses: count(isl, 'press'), refineries: count(isl, 'refinery'),
    capHours: BASE_HOURS + 2 * (isl.level - 1) + warehouses * MACHINES.warehouse.hours,
    tank: BASE_TANK + warehouses * MACHINES.warehouse.tank,
    unlocked: UNLOCK[isl.level]
  };
}

/* power, coins and points produced since `isl.last`, capped at the storage hours. Mutates and returns the gain. */
export function sync(isl, now) {
  const s = stats(isl);
  const ep = epochOf(now);
  if (isl.points.epoch !== ep) isl.points = { epoch: ep, press: 0, refinery: 0, power: 0 };
  const dt = Math.max(0, Math.min(now - isl.last, s.capHours * 3600)) / 3600;
  const fuelHours = s.derricks ? isl.fuel / (s.derricks * MACHINES.derrick.fuel) : 0;
  const tFuel = Math.min(dt, fuelHours);
  const power = s.mines * MACHINES.mine.power * dt + s.derricks * MACHINES.derrick.power * tFuel;
  isl.fuel = round3(Math.max(0, isl.fuel - s.derricks * MACHINES.derrick.fuel * tFuel));
  const gain = { hours: dt, power, coins: 0, press: 0, refinery: 0 };
  if (isl.route === 'grid') gain.coins = power;
  else {
    const conv = isl.route === 'press' ? s.presses : s.refineries;
    const pts = Math.min(power, conv * MACHINES.press.convert * dt);
    gain[isl.route] = pts;
    gain.coins = (power - pts) * SPILL_RATE;
  }
  isl.coins = round3(isl.coins + gain.coins);
  isl.points.press = round3(isl.points.press + gain.press);
  isl.points.refinery = round3(isl.points.refinery + gain.refinery);
  isl.points.power = round3(isl.points.power + power);
  for (const k of ['power', 'coins', 'press', 'refinery']) isl.lifetime[k] = round3(isl.lifetime[k] + gain[k]);
  isl.last = now;
  return gain;
}

/* live rates for the page */
export function rates(isl) {
  const s = stats(isl);
  const fueled = s.derricks && isl.fuel > 0;
  const power = s.mines * MACHINES.mine.power + (fueled ? s.derricks * MACHINES.derrick.power : 0);
  const conv = isl.route === 'press' ? s.presses : isl.route === 'refinery' ? s.refineries : 0;
  const pts = isl.route === 'grid' ? 0 : Math.min(power, conv * MACHINES.press.convert);
  return {
    power, fuelBurn: fueled ? s.derricks * MACHINES.derrick.fuel : 0,
    coins: isl.route === 'grid' ? power : (power - pts) * SPILL_RATE,
    points: pts, fuelLeftHours: s.derricks ? isl.fuel / s.derricks : Infinity
  };
}

export function act(isl, action, arg, now, ctx = {}) {
  const s = stats(isl);
  switch (action) {
    case 'build': {
      const pad = Number(arg.pad), kind = String(arg.kind);
      const m = MACHINES[kind];
      if (!m) throw Error('Unknown machine');
      if (!s.unlocked.includes(pad)) throw Error('Upgrade the vault to unlock this pad');
      if (isl.pads[pad]) throw Error('This pad is taken');
      if (isl.coins < m.cost) throw Error(`${m.name} costs ${m.cost} coins`);
      isl.coins = round3(isl.coins - m.cost);
      isl.pads[pad] = kind;
      return { built: kind, pad };
    }
    case 'demolish': {
      const pad = Number(arg.pad), kind = isl.pads[pad];
      if (!kind || kind === 'vault') throw Error('Nothing to remove here');
      if (MACHINES[kind].route && isl.route === MACHINES[kind].route && count(isl, kind) === 1) throw Error('Switch the route before removing the last ' + MACHINES[kind].name);
      isl.pads[pad] = null;
      const refund = Math.floor(MACHINES[kind].cost / 2);
      isl.coins = round3(isl.coins + refund);
      if (kind === 'warehouse') isl.fuel = Math.min(isl.fuel, stats(isl).tank);
      return { removed: kind, refund };
    }
    case 'upgrade': {
      const next = isl.level + 1, cost = VAULT_UPGRADE[next];
      if (!cost) throw Error('The vault is at its top level');
      if (isl.coins < cost) throw Error(`Upgrade costs ${cost} coins`);
      isl.coins = round3(isl.coins - cost);
      isl.level = next;
      return { level: next };
    }
    case 'crate': {
      if (now < isl.crateAt) throw Error('The next fuel crate is still on its way');
      const add = ctx.holder ? HOLDER_CRATE_FUEL : CRATE_FUEL;
      isl.fuel = Math.min(s.tank, round3(isl.fuel + add));
      isl.crateAt = now + CRATE_EVERY;
      return { fuel: add };
    }
    case 'route': {
      const route = String(arg.route);
      const r = ROUTES[route];
      if (!r) throw Error('Unknown route');
      if (route === isl.route) return { route };
      if (r.machine && count(isl, r.machine) === 0) throw Error(`Build a ${MACHINES[r.machine].name} first`);
      if (isl.routeEpoch === epochOf(now)) throw Error('You already picked a route today, it unlocks at payday');
      isl.route = route;
      isl.routeEpoch = epochOf(now);
      return { route };
    }
    case 'collect':
      return {};
    default:
      throw Error('Unknown action');
  }
}
