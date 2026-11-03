// Energy layer: PREDICT (forecast), DISCOVER (flexibility), DECIDE (market),
// ACT (dispatch), PROVE (verification). See CONTRACT.md section B.
//
// Three parallel worlds are simulated every step:
//   HUKUM        - what actually happens (state.equipment, state.energy.*)
//   baseline     - "do nothing": baseline room loads, EVs charge on arrival,
//                  pumps on a fixed evening schedule, no pre-cool, no battery
//   battery-only - baseline loads + the same battery doing simple peak shaving
// plus a fixed 400 kWh battery-only reference so "50 kWh + HUKUM" can be
// compared with "400 kWh battery-only".
// NHCE campus (v2): every room in building.js is metered directly; hostels,
// faculty quarters, street lights and any classrooms beyond the explicit ones
// are aggregated (energy-model.js). Per-block meters: state.energy.blockMeters.
import { CONFIG, tariffAt, fmtTime } from '../config.js';
import { EQUIPMENT, ROOMS } from '../building.js';
import { minuteOfDay, slotOf } from '../state.js';
import { bus } from '../bus.js';
import * as M from './energy-model.js';
import { buildBids, clearMarket, decideText } from './energy-market.js';

const { clamp, num, inPeak, inSolarTariff } = M;
const B = CONFIG.battery;
const SLOTS = CONFIG.slotsPerDay;
const PEAK0 = CONFIG.tariff.peakHours[0] * 60, PEAK1 = CONFIG.tariff.peakHours[1] * 60;
const SOLAR1 = CONFIG.tariff.solarHours[1] * 60;
// Pre-cool on the afternoon solar surplus, then coast through the 17:00-18:30
// ramp (classes still on, sun fading, hostels and the peak tariff starting).
const PRECOOL0 = 14 * 60 + 15, PRECOOL1 = 16 * 60 + 15, COAST0 = 17 * 60;
// From 16:00 the battery follows the evening flattening plan.
const PLAN0 = 16 * 60;

const BAT = EQUIPMENT.find((e) => e.kind === 'battery');
const PV = EQUIPMENT.find((e) => e.kind === 'solar');
const HVACS = EQUIPMENT.filter((e) => e.kind === 'hvac');
const PUMPS = EQUIPMENT.filter((e) => e.kind === 'pump');
const VEHICLES = EQUIPMENT.filter((e) => e.kind === 'ev' || e.kind === 'ebus');
// Sports floodlights are not in EQUIPMENT; the energy layer dispatches them as a virtual asset.
const FLOOD = { id: 'FLOOD', name: 'Sports floodlights', kind: 'lighting', ratedKW: M.FLOOD_KW };
const FLEX_INTENTS = new Set(['dim', 'lights-off', 'night-charge', 'precool', 'coast', 'run-solar', 'pause', 'run-offpeak', 'charge-solar', 'defer', 'smart-charge', 'battery-charge', 'battery-discharge', 'grid-charge']);

const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

// ---------- internal state (non-enumerable so JSON exports stay small) ----------
function I(state) { return state.energy && state.energy._; }

function batteryCaps(state) {
  const cap = Math.max(1, num(state.scenario && state.scenario.batteryKWh, B.capacityKWh));
  return { cap, maxKW: Math.min(B.maxKW, cap * (B.maxKW / B.capacityKWh)) };
}

function ensureEnergyShape(state) {
  const E = state.energy || (state.energy = {});
  E.forecast = E.forecast || { solar: { p10: [], p50: [], p90: [] }, demand: { p10: [], p50: [], p90: [] }, issuedAt: null };
  E.history = Array.isArray(E.history) ? E.history : [];
  E.pastDays = Array.isArray(E.pastDays) ? E.pastDays : [];
  E.baseline = E.baseline || { demandKW: 0, gridKW: 0 };
  E.totals = freshTotals(state);
  state.market = state.market || { slot: null, needKW: 0, bids: [], clearingPrice: 0, history: [] };
  state.market.history = Array.isArray(state.market.history) ? state.market.history : [];
  state.pendingActions = Array.isArray(state.pendingActions) ? state.pendingActions : [];
  state.copilot = Array.isArray(state.copilot) ? state.copilot : [];
  state.alerts = Array.isArray(state.alerts) ? state.alerts : [];
  state.flexScore = state.flexScore || { score: 0, delivered: 0, promised: 0, rebound: 0, safetyViolations: 0 };
  return E;
}

function freshTotals(state) {
  return {
    costHukum: 0, costBaseline: 0, costBatteryOnly: 0,
    kWhHukum: 0, kWhBaseline: 0,
    peakHukumKW: 0, peakBaselineKW: 0,
    solarUsedKWh: 0, solarGenKWh: 0, exportKWh: 0,
    classroomKWhHukum: 0, classroomKWhBaseline: 0,
    co2AvoidedKg: 0, batteryThroughputKWh: 0,
    // added by the energy module
    energyCostHukum: 0, energyCostBaseline: 0, energyCostBatteryOnly: 0, energyCostBatteryOnlyRef: 0,
    demandChargeHukum: 0, demandChargeBaseline: 0, demandChargeBatteryOnly: 0,
    costBatteryOnlyRef: 0, peakBatteryOnlyKW: 0, peakBatteryOnlyRefKW: 0,
    peakEveningHukumKW: 0, peakEveningBaselineKW: 0,      // 18:00-22:00 window only
    kWhBatteryOnly: 0, exportKWhBaseline: 0, solarUsedKWhBaseline: 0,
    wearCostRs: 0, exportCreditRs: 0, dieselKWh: 0, dieselCostRs: 0, dieselKWhBaseline: 0, shedKWh: 0,
    flexPromisedKWh: 0, flexDeliveredKWh: 0, reboundKWh: 0,
    shadowWouldSaveRs: 0, minutes: 0, startMinute: state ? minuteOfDay(state.t) : 0,
  };
}

function newInternal(state) {
  const learnedInflex = new Float64Array(SLOTS), learnedTotal = new Float64Array(SLOTS), learnedBase = new Float64Array(SLOTS);
  for (let s = 0; s < SLOTS; s++) {
    const m = s * 15 + 7.5;
    learnedInflex[s] = M.priorInflexKW(m);
    learnedTotal[s] = learnedInflex[s] + HVACS.reduce((a, h) => a + M.hvacBaselineKW(h.id, m, 'sunny'), 0)
      + (m >= 11 * 60 && m < 14 * 60 ? 60 : 0) + (m >= 22 * 60 || m < 6 * 60 ? 35 : 0);
    const cls = m >= CONFIG.occupancy.classStart && m < CONFIG.occupancy.classEnd;
    learnedBase[s] = learnedInflex[s] * (cls ? 1.15 : 1) + HVACS.reduce((a, h) => a + M.hvacBaselineKW(h.id, m, 'sunny'), 0)
      + (m >= 9 * 60 && m < 11 * 60 ? 25 : 0) + (m >= 11 * 60 && m < 13 * 60 ? 60 : 0)
      + (m >= 18 * 60 && m < 20 * 60 + 15 ? 30 : 0) + (m >= 18 * 60 + 30 && m < 21 * 60 ? 120 : 0);
  }
  return {
    dayIdx: -1, curves: {}, sessions: {},
    hvac: Object.fromEntries(HVACS.map((h) => [h.id, { precoolMin: 0, precoolOn: false, coastStart: null, coastEnd: null, coastKW: 0, coastFrac: 1, coastPlannedKW: 0, reboundEnd: null, reboundKW: 0, coastedToday: false }])),
    pumpAct: Object.fromEntries(PUMPS.map((p) => [p.id, { bRun: false, bSafe: false, safety: false, night: false }])),
    pumpTwin: Object.fromEntries(PUMPS.map((p) => [p.id, { tank: num(state.equipment[p.id] && state.equipment[p.id].tankLevel, 0.55), bRun: false, bSafe: false }])),
    battOnly: { soc: num(state.equipment[BAT.id] && state.equipment[BAT.id].soc, 0.5) },
    battRef: { soc: num(state.equipment[BAT.id] && state.equipment[BAT.id].soc, 0.5) },
    plan: {}, L: 230, gridChargeKW: 0, nightChargeKWh: 0, battPrice: CONFIG.tariff.export,
    learned: { inflex: learnedInflex, total: learnedTotal, base: learnedBase },
    today: newToday(),
    Lbo: 300, LboRef: 300,
    fc: null,
    approvals: new Map(), actionIndex: new Map(), seq: 0,
    flags: {}, lastMin: Math.floor(state.t),
    prev: { outage: !!state.scenario.outage, internetDown: !!state.scenario.internetDown, mode: state.mode },
    last: { inflexH: 0, solar: 0, netH: 0 },
    relSum: 0, relN: 0, violationsToday: 0, violationKeys: new Set(),
    meterH: Object.fromEntries(M.METER_IDS.map((id) => [id, 0])),
    meterB: Object.fromEntries(M.METER_IDS.map((id) => [id, 0])),
    flood: { kW: 0, baselineKW: 0, intent: null },
  };
}

function newToday() {
  return { inflex: new Float64Array(SLOTS), total: new Float64Array(SLOTS), base: new Float64Array(SLOTS), solar: new Float64Array(SLOTS), n: new Float64Array(SLOTS) };
}

// ---------- copilot / alerts ----------
function say(state, engine, level, text) {
  state.copilot.push({ t: state.t, level, engine, text });
  if (state.copilot.length > 900) state.copilot.splice(0, state.copilot.length - 700);
}
function alert(state, level, text) {
  const a = { id: `en-${state.alerts.length}-${Math.floor(state.t)}`, t: state.t, level, text };
  state.alerts.push(a);
  if (state.alerts.length > 300) state.alerts.splice(0, 100);
  bus.emit('alert', a);
}

// ---------- day bookkeeping ----------
function ensureDay(state) {
  const _ = I(state);
  const dayIdx = Math.floor(state.t / 1440);
  if (dayIdx === _.dayIdx) return;
  _.dayIdx = dayIdx;
  _.curves = {};
  const fresh = M.makeSessions(state.seed, dayIdx, VEHICLES);
  for (const v of VEHICLES) {
    const keep = (_.sessions[v.id] || []).filter((s) => s.departT > state.t);
    const add = (fresh[v.id] || []).filter((s) => s.departT > state.t).map((s) => ({ ...s, actKWh: 0, baseKWh: 0, announced: false, missed: false }));
    _.sessions[v.id] = [...keep, ...add];
  }
  for (const h of Object.values(_.hvac)) Object.assign(h, { precoolMin: 0, precoolOn: false, coastedToday: false });
  _.flags = {};
}

function solarNow(state, mod) {
  const _ = I(state);
  const w = state.scenario.weather in M.WEATHER_FACTOR ? state.scenario.weather : 'sunny';
  if (!_.curves[w]) _.curves[w] = M.makeCloudCurve(state.seed, _.dayIdx, w);
  return CONFIG.solar.kWp * M.clearSky(mod) * _.curves[w][Math.floor(mod) % 1440];
}

function activeSession(_, id, t) {
  const list = _.sessions[id] || [];
  for (const s of list) if (s.arriveT <= t && t < s.departT) return s;
  return null;
}

// ---------- mode gating & pending actions ----------
function untilFor(intent, t, mod, extra) {
  const day0 = t - mod;
  let u;
  switch (intent) {
    case 'charge-solar': u = Math.min(extra && extra.departT || day0 + SOLAR1, day0 + SOLAR1); break;
    case 'defer': case 'smart-charge': u = (extra && extra.departT) || t + 120; break;
    case 'run-solar': u = day0 + SOLAR1; break;
    case 'pause': u = day0 + PEAK1; break;
    case 'run-offpeak': u = day0 + (mod >= 360 ? 1440 + 360 : 360); break;
    case 'precool': u = day0 + PRECOOL1; break;
    case 'coast': u = (extra && extra.coastEnd) || day0 + PEAK1; break;
    default: u = day0 + 1440;
  }
  return u > t ? u : t + 15;
}

const INTENT_TEXT = {
  'charge-solar': (n, kW) => `Charge ${n} now at ${r1(kW)} kW from solar surplus`,
  'defer': (n) => `Defer ${n} charging to cheaper hours (deadline kept)`,
  'smart-charge': (n) => `Smart-charge ${n}: minimum rate now, the rest from solar or off-peak hours, ready before departure`,
  'run-solar': (n, kW) => `Run ${n} on solar surplus (${r1(kW)} kW) to fill the tank`,
  'pause': (n) => `Pause ${n} during the evening peak (tank stays above 20%)`,
  'run-offpeak': (n, kW) => `Run ${n} overnight at off-peak (${r1(kW)} kW)`,
  'precool': (n, kW) => `Pre-cool ${n} by ${r1(kW)} kW on solar (setpoint -2 C, within 22-27 C)`,
  'coast': (n, kW) => `Let ${n} coast on pre-cool through the peak (-${r1(kW)} kW)`,
  'battery-charge': () => 'Charge the battery from solar surplus today',
  'battery-discharge': () => 'Discharge the battery to hold the grid peak down today',
  'grid-charge': () => 'Top up the battery from the grid at the Rs 6.4 solar-hours tariff',
  'night-charge': () => 'Charge the battery off-peak overnight to shave the 08:45 class-start peak',
  'dim': () => 'Dim the sports floodlights to 70% during the evening peak',
  'lights-off': () => 'Switch off the sports floodlights: nobody on the ground or court',
};
const INTENT_VALUE = {   // rough Rs saved per kWh shifted, for the pending-action card
  'charge-solar': 3.4, 'defer': 1.6, 'smart-charge': 1.6, 'run-solar': 6.6, 'pause': 1.6, 'run-offpeak': 1.6,
  'precool': 4.0, 'coast': 6.0, 'battery-charge': 4.8, 'battery-discharge': 4.8, 'grid-charge': 0.9,
  'dim': 9.6, 'lights-off': 9.0, 'night-charge': 1.0,
};

function ensureAction(state, eq, intent, kW, reason, extra) {
  const _ = I(state);
  const key = `${eq.id}:${intent}`;
  const ex = _.actionIndex.get(key);
  if (ex && ex.untilT > state.t && ex.status !== 'expired') return ex;
  const mod = minuteOfDay(state.t);
  const untilT = untilFor(intent, state.t, mod, extra);
  const hours = Math.max(0.25, Math.min(4, (untilT - state.t) / 60));
  const kWh = Math.abs(kW) * (intent.startsWith('battery') ? Math.min(hours, 3) : Math.min(hours, 2));
  const status = state.mode === 'shadow' ? 'shadow' : 'pending';
  const a = {
    id: `ea-${++_.seq}`, t: state.t,
    text: (INTENT_TEXT[intent] || ((n) => `${intent} ${n}`))(eq.name, Math.abs(kW)),
    target: { type: 'equipment', id: eq.id }, action: intent,
    kW: r1(Math.abs(kW)), savingRs: r0(kWh * (INTENT_VALUE[intent] || 1)),
    reason: reason || '', status, untilT,
  };
  state.pendingActions.push(a);
  if (state.pendingActions.length > 400) {
    const idx = state.pendingActions.findIndex((p) => p.status !== 'pending');
    state.pendingActions.splice(idx >= 0 ? idx : 0, 1);
  }
  _.actionIndex.set(key, a);
  if (status === 'shadow') {
    state.energy.totals.shadowWouldSaveRs += a.savingRs;
    say(state, 'ACT', 'info', `Shadow mode: would ${a.text.charAt(0).toLowerCase() + a.text.slice(1)} (about Rs ${a.savingRs}). Not executed.`);
  }
  return a;
}

// Returns the kW that actually executes for HUKUM's choice vs the do-nothing fallback.
function gate(state, eq, intent, hukumKW, fallbackKW, reason, extra) {
  if (state.scenario.hukumEnabled === false) return { kW: fallbackKW, executed: false };
  if (!intent || intent === 'safety' || Math.abs(hukumKW - fallbackKW) < 0.3) return { kW: hukumKW, executed: true };
  if (state.mode === 'automate' || !state.mode) return { kW: hukumKW, executed: true };
  // Don't bother the operator with trivial moves (a few kW of battery jitter).
  if (eq.kind === 'battery' && Math.abs(hukumKW - fallbackKW) < 10) return { kW: fallbackKW, executed: false };
  const _ = I(state);
  const key = `${eq.id}:${intent}`;
  if (state.mode === 'approve' && (_.approvals.get(key) || -Infinity) > state.t) return { kW: hukumKW, executed: true };
  ensureAction(state, eq, intent, hukumKW - fallbackKW, reason, extra);
  return { kW: fallbackKW, executed: false };
}

function applyOverride(es, kW, ratedKW, canRun = true) {
  if (es.override === 'off') return 0;
  if (es.override === 'on') return canRun ? ratedKW : kW;
  return kW;
}

// ---------- controllers ----------
function pumpBaseline(p, tank, ratedKW, mod) {
  if (tank >= 0.98) { p.bRun = false; p.bSafe = false; return 0; }
  if (tank < 0.2) p.bSafe = true;
  if (p.bSafe && tank < 0.32) return ratedKW;
  p.bSafe = false;
  return mod >= 18 * 60 && mod < 20 * 60 + 15 ? ratedKW : 0;
}

function pumpHukum(p, tank, ratedKW, mod, plan) {
  if (tank >= 0.97) { p.safety = false; p.night = false; return [0, null]; }
  if (tank < 0.22) p.safety = true;
  if (p.safety && tank < 0.3) return [ratedKW, 'safety'];
  p.safety = false;
  if (plan && plan.intent === 'run-solar') return [ratedKW, 'run-solar'];
  if (inPeak(mod)) return [0, 'pause'];
  const night = mod >= PEAK1 || mod < 6 * 60;
  if (night && tank < 0.5) p.night = true;
  if (night && p.night && tank < 0.75) return [ratedKW, 'run-offpeak'];
  if (!night) p.night = false;
  return [0, null];
}

// ---------- the per-step simulation ----------
export function stepEnergy(state, dtMin) {
  if (!I(state)) initEnergy(state);
  const _ = I(state);
  if (!(dtMin > 0)) return;
  ensureDay(state);
  const E = state.energy, T = E.totals, sc = state.scenario;
  const t = state.t, mod = minuteOfDay(t), dtH = dtMin / 60;
  const weather = sc.weather in M.WEATHER_FACTOR ? sc.weather : 'sunny';
  const tariff = tariffAt(mod);
  const outage = !!sc.outage;
  const hukumOn = sc.hukumEnabled !== false;
  const { cap, maxKW } = batteryCaps(state);
  const slot = slotOf(t);
  const peak = inPeak(mod);

  scenarioEdges(state, _);

  // --- solar ---
  const solar = solarNow(state, mod);

  // --- rooms (from the occupancy module; read defensively) ---
  let roomsH = 0, roomsB = 0, classH = 0, classB = 0, timetH = 0, timetB = 0, critRooms = 0;
  const mH = _.meterH, mB = _.meterB;
  for (const k in mH) { mH[k] = 0; mB[k] = 0; }
  let sportsPeople = 0, sportsKnown = false;
  for (const r of ROOMS) {
    const rs = state.rooms && state.rooms[r.id];
    if (!rs) continue;
    // Resilience Mode: non-critical rooms shed (occupancy turns AC + fans off); cleared when the grid returns.
    const shedRoom = outage && !M.CRITICAL_TYPES.has(r.type);
    if (rs.shed !== shedRoom) rs.shed = shedRoom;
    let lh = Math.max(0, num(rs.loadKW));
    const lb = Math.max(0, num(rs.baselineLoadKW, lh));
    if (!hukumOn) lh = lb;
    roomsH += lh; roomsB += lb;
    if (r.type === 'classroom') { classH += lh; classB += lb; }
    if (r.timetabled) { timetH += lh; timetB += lb; }
    if (M.CRITICAL_TYPES.has(r.type)) critRooms += lh;
    const bid = r.blockId || 'CAMPUS';
    if (bid in mH) { mH[bid] += lh; mB[bid] += lb; }
    if (r.type === 'sports') {
      const occ = typeof rs.detected === 'number' ? rs.detected : rs.occupancy;
      if (typeof occ === 'number') { sportsKnown = true; sportsPeople += occ; }
    }
  }
  // Aggregated extra classrooms have no HUKUM cameras yet: they draw their baseline in both worlds
  // (shed only in Resilience Mode). Set M.AGG_AUTO_OFF to let them follow the explicit classrooms.
  const aggB = classB * M.AGG_CLASS_FACTOR;
  const aggH = outage ? 0 : M.AGG_AUTO_OFF && hukumOn ? classH * M.AGG_CLASS_FACTOR : aggB;
  for (const b in M.AGG_CLASS_SPLIT) if (b in mH) { mH[b] += aggH * M.AGG_CLASS_SPLIT[b]; mB[b] += aggB * M.AGG_CLASS_SPLIT[b]; }
  const hostels = M.hostelsKW(mod), street = M.streetLightsKW(mod);
  const other = hostels + street;
  mH.HOSTELS += hostels; mB.HOSTELS += hostels; mH.CAMPUS += street; mB.CAMPUS += street;

  // --- sports floodlights: camera-gated (off when the ground is empty), dimmed in the peak ---
  const floodB = outage ? 0 : M.floodBaselineKW(mod);
  let floodH = floodB, floodIntent = null;
  if (floodB > 0) {
    if (sportsKnown && sportsPeople < 1) { floodH = 0; floodIntent = 'lights-off'; }
    else if (_.plan.FLOOD && _.plan.FLOOD.intent === 'dim') { floodH = floodB * 0.7; floodIntent = 'dim'; }
  }
  {
    const g = gate(state, FLOOD, floodIntent, floodH, floodB, floodIntent === 'lights-off' ? 'No one on the sports ground or court (camera count 0)' : 'Evening peak: dim to 70%, above the play minimum');
    if (g.executed && floodIntent) flexAcc(state.energy.totals, floodB - floodH, floodB - g.kW, dtH);
    floodH = g.kW;
    _.flood = { kW: floodH, baselineKW: floodB, intent: g.executed ? floodIntent : null };
  }
  mH.CAMPUS += floodH; mB.CAMPUS += floodB;
  const inflexH = roomsH + aggH + other + floodH;
  const inflexB = roomsB + aggB + other + floodB;

  // --- HVAC ---
  let hvacH = 0, hvacB = 0;
  const precoolRooms = { 'AHU-A': false, 'HVAC-BD': false };
  for (const h of HVACS) {
    const es = state.equipment[h.id]; const hs = _.hvac[h.id];
    const base = M.hvacBaselineKW(h.id, mod, weather);
    hvacB += base;
    let kW = base, intent = null, planned = 0;
    const plan = _.plan[h.id];
    if (!outage && plan && plan.intent === 'precool' && hs.precoolMin < CONFIG.precool.maxMinutes && mod >= PRECOOL0 && mod < PRECOOL1) {
      planned = Math.min(num(h.flexKW, 35), num(plan.kW, num(h.flexKW, 35))); kW = base + planned; intent = 'precool';
    } else if (!outage && plan && plan.intent === 'coast' && hs.coastEnd && t < hs.coastEnd) {
      planned = hs.coastPlannedKW; kW = Math.max(0, base - planned * hs.coastFrac); intent = 'coast';
    }
    if (hs.reboundEnd && t < hs.reboundEnd && intent !== 'coast') kW += hs.reboundKW;
    const g = gate(state, h, intent, kW, base, plan && plan.reason, { coastEnd: hs.coastEnd });
    let act = applyOverride(es, g.kW, base);
    if (outage) act = 0;
    if (g.executed && intent === 'precool' && act > base) {
      hs.precoolMin += dtMin; hs.precoolOn = true;
      precoolRooms[h.id] = true;
      flexAcc(T, planned, act - base, dtH);
    } else hs.precoolOn = false;
    if (g.executed && intent === 'coast') flexAcc(T, planned, Math.max(0, base - act), dtH);
    if (hs.reboundEnd && t < hs.reboundEnd) T.reboundKWh += hs.reboundKW * dtH;
    es.kW = act; es.intent = g.executed ? intent : null;
    es.status = outage ? 'shed' : es.override === 'off' ? 'off' : g.executed && intent === 'precool' ? 'pre-cooling' : g.executed && intent === 'coast' ? 'coasting' : act > 1 ? 'running' : 'idle';
    hvacH += act;
    if (h.id === 'AHU-A') { mH.PLANT += act; mB.PLANT += base; }
    else for (const b in M.HVAC_BD_SPLIT) if (b in mH) { mH[b] += act * M.HVAC_BD_SPLIT[b]; mB[b] += base * M.HVAC_BD_SPLIT[b]; }
  }
  for (const hid in M.PRECOOL_ROOMS_BY_HVAC) {
    const on = !!precoolRooms[hid];
    for (const id of M.PRECOOL_ROOMS_BY_HVAC[hid]) if (state.rooms && state.rooms[id] && state.rooms[id].precool !== on) state.rooms[id].precool = on;
  }

  // --- pumps ---
  let pumpsH = 0, pumpsB = 0;
  for (const p of PUMPS) {
    const es = state.equipment[p.id];
    const tw = _.pumpTwin[p.id];
    const use = M.waterUsePerMin(mod) * dtMin;
    const fill = (kW) => (kW / p.ratedKW) * M.PUMP_FILL_PER_HOUR * dtH;
    // baseline twin
    const bk = outage ? (tw.tank < 0.25 ? p.ratedKW : 0) : pumpBaseline(tw, tw.tank, p.ratedKW, mod);
    tw.tank = clamp(tw.tank + fill(bk) - use, 0, 1);
    pumpsB += bk;
    // HUKUM
    const tank = num(es.tankLevel, 0.55);
    const fallback = pumpBaseline(_.pumpAct[p.id], tank, p.ratedKW, mod);
    let [hk, intent] = pumpHukum(_.pumpAct[p.id], tank, p.ratedKW, mod, _.plan[p.id]);
    if (outage) { hk = tank < 0.25 ? p.ratedKW : 0; intent = 'safety'; }
    const g = gate(state, p, intent, hk, fallback, _.plan[p.id] && _.plan[p.id].reason);
    let act = applyOverride(es, g.kW, p.ratedKW, tank < 0.99);
    if (g.executed && intent && intent !== 'safety' && FLEX_INTENTS.has(intent)) flexAcc(T, Math.abs(hk - fallback), Math.abs(act - fallback), dtH);
    es.tankLevel = clamp(tank + fill(act) - use, 0, 1);
    if (es.tankLevel < 0.2 && hukumOn) violation(state, _, `${p.id}-low`, `${p.name} tank fell below 20%`);
    es.kW = act; es.intent = g.executed ? intent : null;
    es.status = act > 0.5 ? (intent === 'safety' ? 'running (safety)' : 'running') : es.override === 'off' ? 'off' : (g.executed && intent === 'pause' && fallback > 0) ? 'deferred' : 'idle';
    pumpsH += act;
    mH.PLANT += act; mB.PLANT += bk;
  }

  // --- EVs and e-buses ---
  // First pass: floors (deadline-feasible minimum) and baseline twin.
  let vehB = 0;
  const veh = [];
  for (const v of VEHICLES) {
    const es = state.equipment[v.id];
    const s = activeSession(_, v.id, t);
    es.connected = !!s;
    if (!s) {
      es.kW = 0; es.intent = null; es.status = 'not connected'; es.session = null;
      continue;
    }
    if (!s.announced) announceArrival(state, _, v, s);
    const remB = s.needKWh - s.baseKWh;
    const bk = remB > 0.01 && !outage ? Math.min(v.ratedKW, remB / dtH) : 0;   // outage: chargers shed in every world
    s.baseKWh += bk * dtH; vehB += bk;
    const rem = Math.max(0, s.needKWh - s.actKWh);
    const hoursLeft = (s.departT - t) / 60;
    const floorKW = rem > 0.01 ? Math.min(v.ratedKW, rem / Math.max(0.05, hoursLeft - 0.5)) : 0;
    const fallback = rem > 0.01 ? Math.min(v.ratedKW, rem / dtH) : 0;
    veh.push({ v, es, s, rem, hoursLeft, floorKW, fallback, kW: floorKW, intent: rem > 0.01 ? 'smart-charge' : null });
  }
  // Second pass: plan + valley filling.
  const capKW = Math.max(_.L, T.peakHukumKW);
  let netSoFar = inflexH + hvacH + pumpsH - solar;
  const valleyOK = !peak && !inSolarTariff(mod);
  veh.sort((a, b) => (a.hoursLeft - a.rem / a.v.ratedKW) - (b.hoursLeft - b.rem / b.v.ratedKW));
  for (const x of veh) netSoFar += x.floorKW;
  for (const x of veh) {
    if (x.rem <= 0.01) continue;
    const plan = _.plan[x.v.id];
    if (x.floorKW >= x.v.ratedKW * 0.9) { x.kW = x.v.ratedKW; x.intent = 'safety'; }
    else if (plan && plan.intent === 'charge-solar') { x.kW = x.v.ratedKW; x.intent = 'charge-solar'; }
    else if (plan && plan.intent === 'defer') { x.kW = x.floorKW; x.intent = 'defer'; }
    else if (valleyOK || (inSolarTariff(mod) && !solarWindowAhead(_, mod, x.s.departT))) {
      const head = Math.max(0, capKW - netSoFar);
      const add = Math.min(x.v.ratedKW - x.floorKW, head);
      x.kW = x.floorKW + add; netSoFar += add;
    }
    x.kW = Math.min(x.kW, x.rem / dtH);
  }
  let vehH = 0;
  for (const x of veh) {
    const g = gate(state, x.v, x.intent, x.kW, x.fallback, `${r0(x.rem)} kWh needed before ${fmtTime(minuteOfDay(x.s.departT))}`, { departT: x.s.departT });
    let act = applyOverride(x.es, g.kW, Math.min(x.v.ratedKW, x.rem / dtH), x.rem > 0.01);
    if (outage) act = 0;
    if (g.executed && FLEX_INTENTS.has(x.intent) && x.intent !== 'safety') flexAcc(T, Math.abs(x.kW - x.fallback), Math.abs(act - x.fallback), dtH);
    x.s.actKWh += act * dtH;
    x.es.kW = act; x.es.intent = g.executed ? x.intent : null;
    x.es.soc = clamp(x.s.socArrive + x.s.actKWh / x.s.packKWh, 0, 1);
    x.es.session = { arriveT: x.s.arriveT, departT: x.s.departT, needKWh: r1(x.s.needKWh), deliveredKWh: r1(x.s.actKWh) };
    x.es.status = outage ? 'paused (outage)' : act > 0.3 ? 'charging' : x.rem <= 0.01 ? 'full' : x.es.override === 'off' ? 'off' : 'deferred';
    vehH += act;
  }
  checkDepartures(state, _);

  // --- demand & battery ---
  const demandH = inflexH + hvacH + pumpsH + vehH;
  const demandB = inflexB + hvacB + pumpsB + vehB;
  const bes = state.equipment[BAT.id];
  let soc = num(bes.soc, 0.5);
  let batKW = 0, gridH = 0, exportH = 0, diesel = 0, curtail = 0, served = demandH, shed = 0, critical = 0;
  let gridB = 0, exportB = 0, dieselB = 0;
  let gridBO, exportBO, dieselBO, gridRef, exportRef, dieselRef;

  if (outage) {
    critical = critRooms + 0.3 * hostels + street + pumpsH;
    served = critical; shed = Math.max(0, demandH - critical);
    // HUKUM Resilience Mode: solar + battery serve critical loads, diesel last.
    const avail = Math.max(0, (soc - B.minSoc) * cap);
    if (solar >= critical) {
      const room = Math.max(0, (B.maxSoc - soc) * cap);
      batKW = Math.min(solar - critical, maxKW, room / (B.eff * dtH));
      curtail = solar - critical - batKW;
    } else {
      const dis = Math.min(critical - solar, maxKW, avail / dtH);
      batKW = -dis;
      diesel = critical - solar - dis;
    }
    if (bes.override === 'off') { if (batKW < 0) diesel -= batKW; batKW = 0; }
    // Baseline: grid-tied PV trips, diesel carries the critical load.
    dieselB = critical;
    // Battery-only: battery then diesel, PV tripped.
    [dieselBO] = outageBatteryOnly(_.battOnly, critical, cap, maxKW, dtH);
    [dieselRef] = outageBatteryOnly(_.battRef, critical, B.capacityKWh, B.maxKW, dtH);
    gridBO = 0; exportBO = 0; gridRef = 0; exportRef = 0;
    gridB = 0; exportB = 0;
  } else {
    const net = demandH - solar;
    const g = batteryHukum(state, _, net, mod, soc, cap, maxKW, dtH);
    const gb = gate(state, BAT, g.intent, g.kW, 0, g.reason);
    batKW = applyOverride(bes, gb.kW, 0);
    if (gb.executed && g.intent) flexAcc(T, Math.abs(g.kW), Math.abs(batKW), dtH);
    const after = net + batKW;
    gridH = Math.max(0, after); exportH = Math.max(0, -after);
    const netB = demandB - solar;
    gridB = Math.max(0, netB); exportB = Math.max(0, -netB);
    [gridBO, exportBO] = batteryOnlyStep(_.battOnly, netB, mod, cap, maxKW, dtH, _.Lbo);
    [gridRef, exportRef] = batteryOnlyStep(_.battRef, netB, mod, B.capacityKWh, B.maxKW, dtH, _.LboRef);
    dieselBO = 0; dieselRef = 0;
  }

  // battery state update
  if (batKW > 0) soc += (batKW * B.eff * dtH) / cap;
  else soc += (batKW * dtH) / cap;
  soc = clamp(soc, 0, 1);
  bes.soc = soc; bes.kW = batKW;
  bes.status = batKW > 0.5 ? (_.lastBatIntent === 'grid-charge' || _.lastBatIntent === 'night-charge' ? 'charging (grid)' : 'charging') : batKW < -0.5 ? 'discharging' : bes.override === 'off' ? 'off' : 'idle';
  bes.intent = Math.abs(batKW) > 0.5 ? _.lastBatIntent : null;
  const pvs = state.equipment[PV.id];
  if (pvs) { pvs.kW = -(solar - curtail); pvs.status = solar > 1 ? (curtail > 1 ? 'curtailed' : 'generating') : 'idle'; }

  // --- publish instantaneous values ---
  Object.assign(E, {
    solarKW: solar, demandKW: served, gridKW: gridH, batteryKW: batKW, exportKW: exportH, dieselKW: diesel, tariff,
    resilience: outage, criticalKW: critical, shedKW: shed, curtailKW: curtail,
    peakTargetKW: _.L,
  });
  E.baseline = { demandKW: demandB, gridKW: gridB, exportKW: exportB, dieselKW: dieselB };
  E.batteryOnly = { soc: _.battOnly.soc, gridKW: gridBO, exportKW: exportBO, capacityKWh: cap };
  E.breakdown = { roomsKW: roomsH, aggClassKW: aggH, otherBlocksKW: other, hostelsKW: hostels, streetLightsKW: street, floodlightsKW: floodH, hvacKW: hvacH, pumpsKW: pumpsH, vehiclesKW: vehH };
  mH.CAMPUS += vehH; mB.CAMPUS += vehB;
  publishMeters(state, _, solar, curtail, outage, critical, dtH);

  // --- totals ---
  const exp = CONFIG.tariff.export;
  const wear = batKW < 0 ? -batKW * B.wearCostPerKWh * dtH : 0;
  T.energyCostHukum += gridH * tariff * dtH - exportH * exp * dtH + wear + diesel * M.DIESEL_RS * dtH;
  T.energyCostBaseline += gridB * tariff * dtH - exportB * exp * dtH + dieselB * M.DIESEL_RS * dtH;
  T.energyCostBatteryOnly += gridBO * tariff * dtH - exportBO * exp * dtH + dieselBO * M.DIESEL_RS * dtH + _.battOnly.wear;
  T.energyCostBatteryOnlyRef += gridRef * tariff * dtH - exportRef * exp * dtH + dieselRef * M.DIESEL_RS * dtH + _.battRef.wear;
  T.peakHukumKW = Math.max(T.peakHukumKW, gridH);
  T.peakBaselineKW = Math.max(T.peakBaselineKW, gridB);
  T.peakBatteryOnlyKW = Math.max(T.peakBatteryOnlyKW, gridBO);
  T.peakBatteryOnlyRefKW = Math.max(T.peakBatteryOnlyRefKW, gridRef);
  if (peak) { T.peakEveningHukumKW = Math.max(T.peakEveningHukumKW, gridH); T.peakEveningBaselineKW = Math.max(T.peakEveningBaselineKW, gridB); }
  const dc = M.DEMAND_CHARGE_PER_KW_DAY;
  T.demandChargeHukum = T.peakHukumKW * dc;
  T.demandChargeBaseline = T.peakBaselineKW * dc;
  T.demandChargeBatteryOnly = T.peakBatteryOnlyKW * dc;
  T.costHukum = T.energyCostHukum + T.demandChargeHukum;
  T.costBaseline = T.energyCostBaseline + T.demandChargeBaseline;
  T.costBatteryOnly = T.energyCostBatteryOnly + T.demandChargeBatteryOnly;
  T.costBatteryOnlyRef = T.energyCostBatteryOnlyRef + T.peakBatteryOnlyRefKW * dc;
  T.kWhHukum += gridH * dtH; T.kWhBaseline += gridB * dtH; T.kWhBatteryOnly += gridBO * dtH;
  T.solarGenKWh += solar * dtH;
  T.solarUsedKWh += Math.max(0, solar - exportH - curtail) * dtH;
  T.solarUsedKWhBaseline += (outage ? 0 : Math.max(0, solar - exportB)) * dtH;
  T.exportKWh += exportH * dtH; T.exportKWhBaseline += exportB * dtH;
  T.exportCreditRs += exportH * exp * dtH;
  T.classroomKWhHukum += (timetH + aggH) * dtH;
  T.classroomKWhBaseline += (timetB + aggB) * dtH;
  T.co2AvoidedKg = Math.max(0, (T.kWhBaseline + T.dieselKWhBaseline - T.kWhHukum - T.dieselKWh) * M.CO2_KG_PER_KWH);
  T.batteryThroughputKWh += Math.abs(batKW) * dtH;
  T.wearCostRs += wear;
  T.dieselKWh += diesel * dtH; T.dieselKWhBaseline += dieselB * dtH;
  T.dieselCostRs += diesel * M.DIESEL_RS * dtH;
  T.shedKWh += shed * dtH;
  T.minutes += dtMin;

  // learning accumulators
  _.today.inflex[slot] += inflexH * dtMin;
  _.today.total[slot] += demandH * dtMin;
  _.today.base[slot] += demandB * dtMin;
  _.today.solar[slot] += solar * dtMin;
  _.today.n[slot] += dtMin;
  _.last = { inflexH, solar, netH: demandH - solar, hvacH, pumpsH, vehH, demandH };

  if (diesel > 0.5 && !_.flags.diesel) {
    _.flags.diesel = true;
    say(state, 'ACT', 'warn', `Battery empty in Resilience Mode: diesel genset started for ${r0(diesel)} kW of critical load.`);
    alert(state, 'warn', 'Diesel genset running: battery depleted during grid outage');
  }

  // --- one history row per sim minute ---
  const whole = Math.floor(t);
  if (whole > _.lastMin) {
    _.lastMin = whole;
    E.history.push({
      t: whole, solarKW: r1(solar), demandKW: r1(served), gridKW: r1(gridH), batteryKW: r1(batKW), soc: Math.round(soc * 1000) / 1000,
      exportKW: r1(exportH), dieselKW: r1(diesel),
      baselineGridKW: r1(gridB), baselineDemandKW: r1(demandB), batteryOnlyGridKW: r1(gridBO),
      tariff, costHukum: r0(T.costHukum), costBaseline: r0(T.costBaseline), costBatteryOnly: r0(T.costBatteryOnly),
    });
    if (E.history.length > 1500) E.history.splice(0, E.history.length - 1500);
  }
}

// Per-block energy meters and the per-array solar split.
function publishMeters(state, _, solar, curtail, outage, critical, dtH) {
  const E = state.energy;
  const BM = E.blockMeters || (E.blockMeters = {});
  const gen = Math.max(0, solar - curtail);
  const perKWp = gen / Math.max(1, CONFIG.solar.kWp);
  const solarBy = {};
  const split = E.solarSplit || (E.solarSplit = M.SOLAR_SPLIT.map((x) => ({ ...x, kW: 0 })));
  for (const x of split) { x.kW = r1(x.kWp * perKWp); solarBy[x.blockId] = (solarBy[x.blockId] || 0) + x.kWp * perKWp; }
  // In Resilience Mode only critical loads are served: scale every meter down to that.
  let totH = 0;
  for (const k in _.meterH) totH += _.meterH[k];
  const servedScale = outage && totH > 0 ? Math.min(1, critical / totH) : 1;
  for (const id of M.METER_IDS) {
    const m = BM[id] || (BM[id] = { kW: 0, baselineKW: 0, kWhToday: 0, baselineKWhToday: 0, solarKW: 0 });
    const kW = _.meterH[id] * servedScale, bkW = _.meterB[id];
    m.kW = r1(kW); m.baselineKW = r1(bkW); m.solarKW = r1(solarBy[id] || 0);
    m.kWhToday += kW * dtH; m.baselineKWhToday += bkW * dtH;
  }
}

function flexAcc(T, promisedKW, deliveredKW, dtH) {
  T.flexPromisedKWh += Math.max(0, promisedKW) * dtH;
  T.flexDeliveredKWh += Math.max(0, Math.min(promisedKW, deliveredKW)) * dtH;
}

function violation(state, _, key, text) {
  if (_.violationKeys.has(key)) return;
  _.violationKeys.add(key);
  _.violationsToday += 1;
  say(state, 'ACT', 'warn', `Safety limit hit: ${text}.`);
  alert(state, 'warn', text);
}

function solarWindowAhead(_, mod, departT) {
  // Is a forecast solar surplus coming before this vehicle leaves today?
  const fc = _.fc;
  if (!fc) return false;
  const s0 = Math.floor(mod / 15) + 1;
  const sEnd = Math.min(SLOTS, Math.floor(minuteOfDay(departT) / 15));
  for (let s = s0; s < sEnd; s++) if (fc.solar50[s] - fc.total[s] > 20) return true;
  return false;
}

function announceArrival(state, _, v, s) {
  s.announced = true;
  const mod = minuteOfDay(s.arriveT);
  const dep = fmtTime(minuteOfDay(s.departT));
  if (v.kind === 'ebus' && mod >= 17 * 60) {
    say(state, 'ACT', 'action', `${v.name}: bus back at ${fmtTime(mod)} needing ${r0(s.needKWh)} kWh. Charging moved out of the Rs 9.6 peak to overnight, ready by ${dep}.`);
  } else if (v.kind === 'ebus') {
    say(state, 'ACT', 'info', `${v.name}: bus in for a midday top-up (${r0(s.needKWh)} kWh, leaves ${dep}); charging on solar.`);
  }
  // DISCOVER: plug-in reliability learns from actual arrivals.
  const es = state.equipment[v.id];
  if (es) es.reliability = clamp(num(es.reliability, 0.9) * 0.9 + 0.1 * 0.96, 0.5, 0.99);
}

function checkDepartures(state, _) {
  for (const v of VEHICLES) {
    const list = _.sessions[v.id] || [];
    for (const s of list) {
      if (s.departT <= state.t && !s.checked) {
        s.checked = true;
        if (s.needKWh - s.actKWh > 1 && state.scenario.hukumEnabled !== false && !state.scenario.outage) {
          violation(state, _, `${v.id}-${s.departT}`, `${v.name} left with ${r0(s.needKWh - s.actKWh)} kWh short of its target`);
        }
      }
    }
    _.sessions[v.id] = list.filter((s) => s.departT > state.t - 5);
  }
}

// HUKUM battery: absorb surplus, discharge above the planned grid target L,
// morning shaving above today's peak, afternoon grid top-up when the forecast
// surplus will not fill it before the peak.
function batteryHukum(state, _, net, mod, soc, cap, maxKW, dtH) {
  const avail = Math.max(0, (soc - B.minSoc) * cap);
  const room = Math.max(0, (B.maxSoc - soc) * cap);
  let kW = 0, intent = null, reason = '';
  if (net < 0) {
    kW = Math.min(-net, maxKW, room / (B.eff * dtH));
    intent = 'battery-charge'; reason = `Solar surplus ${r0(-net)} kW would export at Rs 3`;
  } else {
    const peak = inPeak(mod);
    const thr = mod >= PLAN0 ? _.L : Math.max(_.L, state.energy.totals.peakHukumKW);
    const morning = mod >= 6 * 60 && mod < 12 * 60;
    const allowed = mod >= PLAN0 || mod < 6 * 60 || morning || soc > 0.35;
    if (net > thr + 0.5 && allowed && avail > 0.1) {
      kW = -Math.min(net - thr, maxKW, avail / dtH);
      intent = 'battery-discharge'; reason = `Grid would hit ${r0(net)} kW; target ${r0(thr)} kW`;
    } else if ((mod >= 23 * 60 || mod < 7 * 60 + 30) && avail < _.nightChargeKWh && room > 0.5) {
      // off-peak top-up for the morning class-start peak, valley-filling under the target
      kW = Math.max(0, Math.min(maxKW, thr - net, (_.nightChargeKWh - avail) / (B.eff * dtH), room / (B.eff * dtH)));
      if (kW > 0.3) { intent = 'night-charge'; reason = `Morning peak forecast needs about ${r0(_.nightChargeKWh)} kWh in the battery at 08:45`; } else kW = 0;
    } else if (_.gridChargeKW > 0 && mod >= 11 * 60 && mod < PLAN0 && room > 0.5) {
      kW = Math.max(0, Math.min(_.gridChargeKW, thr - net, maxKW, room / (B.eff * dtH)));
      if (kW > 0.3) { intent = 'grid-charge'; reason = 'Forecast surplus will not fill the battery before the 18:00 peak'; } else kW = 0;
    }
  }
  if (intent) _.lastBatIntent = intent;
  return { kW, intent: kW !== 0 ? intent : null, reason };
}

// Simple peak shaving: charge from surplus, timer top-up 14:00-17:00, spread
// the stored energy evenly over 18:00-22:00.
// Simple peak shaving on the do-nothing load: charge from surplus, timer
// top-up from the grid 12:00-16:00, then shave everything above a flat level
// from 16:00 to midnight. No load shifting, no forecasting of flexible loads.
function batteryOnlyStep(b, net, mod, cap, maxKW, dtH, L) {
  b.wear = 0;
  let kW = 0;
  const avail = Math.max(0, (b.soc - B.minSoc) * cap);
  const room = Math.max(0, (B.maxSoc - b.soc) * cap);
  b.peak = b.peak || 0;
  if (net < 0) kW = Math.min(-net, maxKW, room / (B.eff * dtH));
  else if (mod >= PLAN0) {
    if (net > L) kW = -Math.min(net - L, maxKW, avail / dtH);
  } else if (mod >= 12 * 60 && room > 0.5) {
    const hLeft = Math.max(dtH, (PLAN0 - mod) / 60);
    kW = Math.max(0, Math.min(maxKW, room / B.eff / hLeft, room / (B.eff * dtH), Math.max(L, b.peak) - net));
  }
  b.peak = Math.max(b.peak, net + kW);
  if (kW > 0) b.soc += (kW * B.eff * dtH) / cap;
  else { b.soc += (kW * dtH) / cap; b.wear = -kW * B.wearCostPerKWh * dtH; }
  b.soc = clamp(b.soc, 0, 1);
  const after = net + kW;
  return [Math.max(0, after), Math.max(0, -after)];
}

function outageBatteryOnly(b, critical, cap, maxKW, dtH) {
  b.wear = 0;
  const avail = Math.max(0, (b.soc - B.minSoc) * cap);
  const dis = Math.min(critical, maxKW, avail / dtH);
  b.soc = clamp(b.soc - (dis * dtH) / cap, 0, 1);
  b.wear = dis * B.wearCostPerKWh * dtH;
  return [critical - dis];
}

function scenarioEdges(state, _) {
  const sc = state.scenario;
  if (!!sc.outage !== _.prev.outage) {
    _.prev.outage = !!sc.outage;
    if (sc.outage) {
      const soc = num(state.equipment[BAT.id].soc, 0.5);
      say(state, 'ACT', 'warn', `Grid outage: Resilience Mode. Battery (${Math.round(soc * 100)}%) and solar now serve critical loads (server room, corridors, labs, water); classrooms, EV charging and non-critical HVAC shed. Diesel only if the battery runs out.`);
    } else {
      _.flags.diesel = false;
      say(state, 'ACT', 'info', 'Grid restored: leaving Resilience Mode, resuming the market schedule.');
    }
  }
  if (!!sc.internetDown !== _.prev.internetDown) {
    _.prev.internetDown = !!sc.internetDown;
    say(state, 'ACT', sc.internetDown ? 'warn' : 'info', sc.internetDown
      ? 'Internet down: weather feed lost, running local backup schedule from the last plan. Rooms and safety limits still controlled on the edge box.'
      : 'Internet back: weather feed restored, re-forecasting.');
  }
  if (state.mode !== _.prev.mode) {
    _.prev.mode = state.mode;
    say(state, 'ACT', 'info', state.mode === 'shadow'
      ? 'Shadow mode: HUKUM will suggest and log every action, nothing executes.'
      : state.mode === 'approve' ? 'Approve mode: every equipment action waits for operator approval.' : 'Automate mode: HUKUM dispatches on its own within safety limits.');
  }
}

// ---------- PREDICT ----------
function issueForecast(state, slot) {
  const _ = I(state), E = state.energy;
  const sc = state.scenario;
  const weather = sc.weather in M.WEATHER_FACTOR ? sc.weather : 'sunny';
  const kWp = CONFIG.solar.kWp;
  const fac = M.WEATHER_FACTOR[weather], spread = M.WEATHER_SPREAD[weather];
  const td = _.today;
  // persistence correction from the last hour
  let obs = 0, expd = 0, dObs = 0, dExp = 0;
  for (let s = Math.max(0, slot - 4); s < slot; s++) {
    if (td.n[s] <= 0) continue;
    const m = s * 15 + 7.5;
    const cs = M.clearSky(m);
    if (cs > 0.05) { obs += td.solar[s] / td.n[s]; expd += kWp * cs * fac; }
    dObs += td.inflex[s] / td.n[s]; dExp += _.learned.inflex[s];
  }
  const sRatio = expd > 10 ? clamp(obs / expd, 0.3, 1.6) : 1;
  const dRatio = dExp > 10 ? clamp(dObs / dExp, 0.6, 1.5) : 1;
  const sp10 = [], sp50 = [], sp90 = [], dp10 = [], dp50 = [], dp90 = [];
  const base = new Float64Array(SLOTS);
  const inflex = new Float64Array(SLOTS), total = new Float64Array(SLOTS), solar50 = new Float64Array(SLOTS), solar10 = new Float64Array(SLOTS), inflex90 = new Float64Array(SLOTS);
  for (let s = 0; s < SLOTS; s++) {
    const m = s * 15 + 7.5;
    const hz = (s - slot) * 0.25;
    if (s < slot && td.n[s] > 0) {
      const sv = td.solar[s] / td.n[s], dv = td.total[s] / td.n[s];
      sp10.push(r1(sv)); sp50.push(r1(sv)); sp90.push(r1(sv));
      dp10.push(r1(dv)); dp50.push(r1(dv)); dp90.push(r1(dv));
      inflex[s] = td.inflex[s] / td.n[s]; total[s] = dv; solar50[s] = sv; solar10[s] = sv; inflex90[s] = inflex[s]; base[s] = td.base[s] / td.n[s];
      continue;
    }
    const h = Math.max(0, hz);
    const w = Math.exp(-h / 3);
    const cs = M.clearSky(m);
    const p50 = kWp * cs * fac * (1 + (sRatio - 1) * w);
    const spr = spread * (0.35 + 0.65 * Math.min(1, h / 6));
    const p10 = Math.max(0, p50 * (1 - spr * 1.4));
    const p90 = Math.max(p50, Math.min(kWp * cs * 0.88, p50 * (1 + spr)));
    sp10.push(r1(p10)); sp50.push(r1(p50)); sp90.push(r1(p90));
    solar50[s] = p50; solar10[s] = p10;
    const dc = 1 + (dRatio - 1) * Math.exp(-h / 2);
    inflex[s] = _.learned.inflex[s] * dc;
    total[s] = _.learned.total[s] * dc;
    base[s] = _.learned.base[s];
    const dspr = 0.03 + 0.07 * Math.min(1, h / 8);
    inflex90[s] = inflex[s] * (1 + dspr);
    dp10.push(r1(total[s] * (1 - dspr))); dp50.push(r1(total[s])); dp90.push(r1(total[s] * (1 + dspr)));
  }
  E.forecast = {
    solar: { p10: sp10, p50: sp50, p90: sp90 },
    demand: { p10: dp10, p50: dp50, p90: dp90 },
    issuedAt: state.t, weather, slot,
    solarKWh: r0(sp50.reduce((a, b) => a + b, 0) * 0.25),
  };
  _.fc = { inflex, inflex90, total, base, solar50, solar10, weather };
}

// Battery plan: grid target L so the stored energy flattens 18:00-24:00.
function planBattery(state, slot) {
  const _ = I(state), fc = _.fc;
  if (!fc) return;
  const mod = minuteOfDay(state.t);
  const weather = fc.weather;
  const { cap, maxKW } = batteryCaps(state);
  const soc = num(state.equipment[BAT.id].soc, 0.5);
  const startS = Math.max(slot, PLAN0 / 15);
  const nets = [];
  // expected overnight vehicle floor
  let vehNeed = 0;
  for (const v of VEHICLES) for (const s of _.sessions[v.id] || []) if (minuteOfDay(s.arriveT) >= 17 * 60 || s.departT - s.arriveT > 600) vehNeed += Math.max(0, s.needKWh - s.actKWh);
  const vehFloor = vehNeed / 8;
  for (let s = startS; s < SLOTS; s++) {
    const m = s * 15 + 7.5;
    let hv = 0;
    for (const h of HVACS) {
      hv += M.hvacBaselineKW(h.id, m, weather);
      const hs = _.hvac[h.id];
      if (hs.coastEnd && state.t - mod + m < hs.coastEnd && state.t - mod + m >= hs.coastStart) hv -= hs.coastPlannedKW * hs.coastFrac;
      else if (!hs.coastedToday && m >= COAST0 && m < COAST0 + 90 && mod < COAST0) hv -= num(h.flexKW, 35) * 0.6 * num(state.equipment[h.id].reliability, 0.8);
    }
    const net = fc.inflex90[s] + hv + (m >= PEAK1 ? vehFloor : 0) - fc.solar10[s];
    nets.push(net);
  }
  let deliverable;
  if (mod < PLAN0) deliverable = (B.maxSoc - B.minSoc) * cap;
  else deliverable = Math.max(0, (soc - B.minSoc) * cap);
  const f = (L) => nets.reduce((a, n) => a + Math.min(maxKW, Math.max(0, n - L)) * 0.25, 0);
  let lo = 0, hi = Math.max(50, ...nets);
  if (!nets.length) { lo = hi = _.L; }
  for (let i = 0; i < 40 && nets.length; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > deliverable) lo = mid; else hi = mid;
  }
  _.L = Math.max(60, hi);
  // overnight top-up sized to shave the 08:45 class-start peak down to the same level
  if (mod >= PEAK1 || mod < 8 * 60) {
    let need = 0;
    for (let s = 33; s < 48; s++) {
      const m = s * 15 + 7.5;
      let hv = 0;
      for (const h of HVACS) hv += M.hvacBaselineKW(h.id, m, weather);
      need += Math.max(0, fc.inflex90[s] + hv - fc.solar10[s] - _.L) * 0.25;
    }
    _.nightChargeKWh = Math.min((B.maxSoc - B.minSoc) * cap, need * 1.15);
  }
  // late-morning / early-afternoon grid top-up at the Rs 6.4 tariff
  _.gridChargeKW = 0;
  if (mod >= 11 * 60 && mod < PLAN0) {
    const need = Math.max(0, (B.maxSoc - soc) * cap / B.eff);
    let exp = 0;
    for (let s = slot; s < PLAN0 / 15; s++) exp += Math.max(0, fc.solar50[s] - fc.total[s]) * 0.25 * 0.8;
    const short = need - exp;
    if (short > 5) _.gridChargeKW = Math.min(maxKW, short / Math.max(0.25, (PLAN0 - mod) / 60));
  }
  // battery-only comparison: same flattening on the baseline forecast
  _.Lbo = flattenLevel(fc.base, fc.solar10, startS, mod, num(_.battOnly.soc, 0.5), cap, maxKW);
  _.LboRef = flattenLevel(fc.base, fc.solar10, startS, mod, num(_.battRef.soc, 0.5), B.capacityKWh, B.maxKW);
  // what is the stored energy worth (for the battery's reduce bid)
  _.battPrice = state.energy.totals.exportKWh > 1 ? CONFIG.tariff.export : CONFIG.tariff.solar;
}

function flattenLevel(load, solar, startS, mod, soc, cap, maxKW) {
  const nets = [];
  for (let s = startS; s < SLOTS; s++) nets.push(load[s] * 1.03 - solar[s]);
  if (!nets.length) return 300;
  const deliverable = mod < PLAN0 ? (B.maxSoc - B.minSoc) * cap : Math.max(0, (soc - B.minSoc) * cap);
  const f = (L) => nets.reduce((a, n) => a + Math.min(maxKW, Math.max(0, n - L)) * 0.25, 0);
  let lo = 0, hi = Math.max(50, ...nets);
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) > deliverable) lo = mid; else hi = mid; }
  return Math.max(60, hi);
}

// ---------- DISCOVER ----------
function discover(state) {
  const _ = I(state);
  const { cap, maxKW } = batteryCaps(state);
  const mod = minuteOfDay(state.t);
  for (const e of EQUIPMENT) {
    const es = state.equipment[e.id];
    if (!es) continue;
    if (e.kind === 'battery') {
      const soc = num(es.soc, 0.5);
      es.flexKW = r1(Math.min(maxKW, Math.max(0, (soc - B.minSoc) * cap * 4)));
      es.rebound = r1(1 - B.eff);
      es.capacityKWh = cap; es.maxKW = r1(maxKW);
    } else if (e.kind === 'hvac') {
      const base = M.hvacBaselineKW(e.id, mod, state.scenario.weather);
      es.flexKW = base > 15 ? num(e.flexKW, 35) : 0;
      es.rebound = CONFIG.precool.rebound;
    } else if (e.kind === 'pump') {
      const tk = num(es.tankLevel, 0.5);
      es.flexKW = tk > 0.3 && tk < 0.95 ? e.ratedKW : 0;
      es.rebound = 0;
    } else if (e.kind === 'ev' || e.kind === 'ebus') {
      const s = activeSession(_, e.id, state.t);
      es.flexKW = s && s.needKWh - s.actKWh > 0.5 ? e.ratedKW : 0;
      es.rebound = 0;
    } else if (e.kind === 'solar') {
      es.flexKW = 0; es.reliability = 1;
    }
  }
}

function buildFleet(state) {
  const _ = I(state);
  const t = state.t, mod = minuteOfDay(t);
  const { cap, maxKW } = batteryCaps(state);
  const fleet = [];
  for (const e of EQUIPMENT) {
    const es = state.equipment[e.id];
    if (!es || e.kind === 'solar') continue;
    const f = { id: e.id, name: e.name, kind: e.kind, ratedKW: e.ratedKW, reliability: num(es.reliability, 0.9), override: es.override, flexKW: num(es.flexKW) };
    if (e.kind === 'ev' || e.kind === 'ebus') {
      const s = activeSession(_, e.id, t);
      f.connected = !!s;
      if (s) {
        f.remainingKWh = Math.max(0, s.needKWh - s.actKWh);
        const hl = (s.departT - t) / 60;
        f.floorKW = Math.min(e.ratedKW, f.remainingKWh / Math.max(0.05, hl - 0.5));
        f.slackH = Math.max(0, hl - f.remainingKWh / e.ratedKW);
        f.departLabel = fmtTime(minuteOfDay(s.departT));
      }
    } else if (e.kind === 'pump') {
      f.tank = num(es.tankLevel, 0.5);
      f.baselineWouldRun = mod >= 18 * 60 && mod < 20 * 60 + 15;
    } else if (e.kind === 'hvac') {
      const hs = _.hvac[e.id];
      f.precoolLeftMin = Math.max(0, CONFIG.precool.maxMinutes - hs.precoolMin);
      f.precoolAllowed = mod >= PRECOOL0 && mod < PRECOOL1 && f.precoolLeftMin > 5 && f.flexKW > 0 && !state.scenario.outage;
      f.coastKW = hs.coastEnd && t < hs.coastEnd && t >= hs.coastStart ? hs.coastPlannedKW : 0;
    } else if (e.kind === 'battery') {
      const soc = num(es.soc, 0.5);
      f.availKWh = Math.max(0, (soc - B.minSoc) * cap);
      f.roomKWh = Math.max(0, (B.maxSoc - soc) * cap);
      f.maxKW = maxKW;
    }
    fleet.push(f);
  }
  const fl = _.flood || {};
  if (num(fl.baselineKW) > 0 && fl.intent !== 'lights-off') {
    fleet.push({ id: FLOOD.id, name: FLOOD.name, kind: 'lighting', ratedKW: FLOOD.ratedKW, reliability: 0.97, override: null, flexKW: num(fl.baselineKW) * 0.3, dimKW: num(fl.baselineKW) * 0.3 });
  }
  return fleet;
}

// Starts the HVAC coast window once pre-cool has been banked.
function startCoast(state, mod) {
  const _ = I(state);
  if (mod < COAST0 || mod >= PEAK1) return;
  for (const h of HVACS) {
    const hs = _.hvac[h.id];
    if (hs.coastedToday || hs.precoolMin < 5) continue;
    hs.coastedToday = true;
    const es = state.equipment[h.id];
    const rel = num(es.reliability, CONFIG.precool.reliability);
    const rng = Math.sin(state.t * 12.9898 + h.ratedKW) * 43758.5453;
    const noise = (rng - Math.floor(rng)) * 0.16 - 0.08;
    hs.coastFrac = clamp(rel + noise, 0.5, 1);
    hs.coastPlannedKW = num(h.flexKW, 35);
    hs.coastStart = state.t;
    hs.coastEnd = state.t + Math.min(CONFIG.precool.maxMinutes, hs.precoolMin);
    const coastKWh = hs.coastPlannedKW * hs.coastFrac * (hs.coastEnd - hs.coastStart) / 60;
    hs.reboundEnd = hs.coastEnd + 30;
    hs.reboundKW = (coastKWh * CONFIG.precool.rebound) / 0.5;
    // DISCOVER: reliability drifts with what was actually delivered
    es.reliability = clamp(rel * 0.85 + hs.coastFrac * 0.15, 0.5, 0.98);
  }
}

// ---------- DECIDE + ACT plan (every 15 min) ----------
export function onSlot(state, slot) {
  if (!I(state)) initEnergy(state);
  const _ = I(state);
  ensureDay(state);
  scenarioEdges(state, _);
  const mod = minuteOfDay(state.t);
  const sc = state.scenario;
  if (!sc.internetDown || !_.fc) issueForecast(state, slot);
  discover(state);
  startCoast(state, mod);
  planBattery(state, slot);
  // expire stale approvals
  for (const [k, u] of _.approvals) if (u <= state.t) _.approvals.delete(k);

  const tariff = tariffAt(mod);
  const peak = inPeak(mod);
  const fc = _.fc;
  // uncontrolled net for this slot: measured inflexible load + HVAC baseline + vehicle floors - solar estimate
  const fleet = buildFleet(state);
  const solarEst = 0.5 * num(_.last.solar, fc.solar50[slot]) + 0.5 * fc.solar50[slot];
  const inflexNow = _.last.inflexH > 0 ? _.last.inflexH : fc.inflex[slot];
  let net = inflexNow - solarEst;
  for (const h of HVACS) net += M.hvacBaselineKW(h.id, mod + 7.5, fc.weather);
  for (const f of fleet) {
    if ((f.kind === 'ev' || f.kind === 'ebus') && f.connected) net += num(f.floorKW);
    if (f.kind === 'pump' && f.tank < 0.25) net += f.ratedKW;
  }
  const futureSurplus = (() => { for (let s = slot + 1; s < SOLAR1 / 15; s++) if (fc.solar50[s] - fc.total[s] > 20) return true; return false; })();
  const target = peak ? _.L : (inSolarTariff(mod) && futureSurplus ? 0 : _.L);
  const surplus = net < -5 ? -net : 0;
  const pumpsBaselineNow = mod >= 18 * 60 && mod < 20 * 60 + 15 ? PUMPS.reduce((a, p) => a + p.ratedKW, 0) : 0;
  const vehBaselineNow = fleet.filter((f) => f.connected && f.remainingKWh > 0.5).reduce((a, f) => a + f.ratedKW, 0);
  // need relative to what "do nothing" would draw: vehicles at full rate, pumps on schedule
  const grossNet = net + vehBaselineNow - fleet.filter((f) => f.connected).reduce((a, f) => a + num(f.floorKW), 0) + pumpsBaselineNow;
  const need = surplus > 0 ? 0 : Math.max(0, grossNet - target);
  const ctx = { need, surplus, mod, tariff, inPeak: peak, battPrice: _.battPrice, targetKW: target, netKW: grossNet };

  const outage = !!sc.outage;
  const bids = outage ? [] : buildBids(fleet, ctx);
  const { clearingPrice } = clearMarket(bids, surplus > 0 ? surplus : need);
  // Pre-cool already banked is sunk cost: always take the coast while importing.
  for (const b of bids) if (b.intent === 'coast' && !b.accepted && grossNet > 0) { b.accepted = true; b.acceptedKW = b.kW; b.reason += ' (pre-cool already banked)'; }

  // plan for this slot
  const plan = {};
  for (const b of bids) if (b.accepted) plan[b.equipId] = { intent: b.intent, kW: num(b.acceptedKW, b.kW), reason: b.reason };
  _.plan = plan;

  const m = state.market;
  Object.assign(m, { slot, t: state.t, needKW: surplus > 0 ? -r1(surplus) : r1(need), bids, clearingPrice, targetKW: r0(target), tariff });
  m.history.push({ slot, t: state.t, needKW: m.needKW, clearingPrice, accepted: bids.filter((b) => b.accepted).length });
  if (m.history.length > SLOTS * 3) m.history.splice(0, m.history.length - SLOTS * 3);

  // copilot
  if (outage) {
    const E = state.energy;
    say(state, 'DECIDE', 'warn', `Resilience Mode: market suspended. Serving ${r0(E.criticalKW || 0)} kW critical load from solar ${r0(E.solarKW || 0)} kW and battery ${Math.round(num(state.equipment[BAT.id].soc) * 100)}%; ${r0(E.shedKW || 0)} kW shed.`);
  } else if (sc.hukumEnabled === false) {
    say(state, 'DECIDE', 'info', 'HUKUM is switched off: every machine runs its default schedule (baseline).');
  } else {
    const note = state.mode === 'shadow' ? ' (Shadow mode: logged, not executed.)'
      : state.mode === 'approve' && bids.some((b) => b.accepted) ? ' (Approve mode: waiting for the operator where it changes a machine.)' : '';
    say(state, 'DECIDE', bids.some((b) => b.accepted) ? 'action' : 'info', decideText(ctx, bids, note));
  }
  predictNotes(state, slot);
  updateFlexScore(state);
}

function predictNotes(state, slot) {
  const _ = I(state), E = state.energy, fc = _.fc, F = _.flags;
  if (!fc) return;
  const s50 = E.forecast.solar.p50, s10 = E.forecast.solar.p10, s90 = E.forecast.solar.p90;
  if (state.scenario.internetDown && !F.backup) { F.backup = true; say(state, 'PREDICT', 'warn', 'Internet down: forecast frozen at the last issue; running local backup schedule.'); }
  if (slot === 34 && !F.discover) {
    F.discover = true;
    const parts = EQUIPMENT.filter((e) => e.kind === 'hvac' || e.kind === 'ebus').map((e) => `${e.id} ${Math.round(num(state.equipment[e.id].reliability) * 100)}%`);
    say(state, 'DISCOVER', 'info', `Flexibility learned so far: ${parts.join(', ')} reliable; pre-cool rebound ${Math.round(CONFIG.precool.rebound * 100)}%; pumps can shift 30 kW while tanks stay above 20%.`);
  }
  if (slot === 36 && !F.p9) {
    F.p9 = true;
    let pk = 0, pkS = 0;
    for (let s = 0; s < SLOTS; s++) if (s50[s] > pk) { pk = s50[s]; pkS = s; }
    say(state, 'PREDICT', 'info', `Forecast issued (${fc.weather}): solar peak ${r0(pk)} kW around ${fmtTime(pkS * 15)} (P10 ${r0(s10[pkS])} - P90 ${r0(s90[pkS])}), ${E.forecast.solarKWh} kWh today. Evening grid target ${r0(_.L)} kW.`);
  }
  if (slot === 44 && !F.p11) {
    F.p11 = true;
    let kwh = 0, mx = 0, s0 = -1, s1 = -1;
    for (let s = slot; s < 72; s++) {
      const sur = fc.solar50[s] - fc.total[s];
      if (sur > 20) { kwh += sur * 0.25; mx = Math.max(mx, sur); if (s0 < 0) s0 = s; s1 = s; }
    }
    say(state, 'PREDICT', kwh > 20 ? 'action' : 'info', kwh > 20
      ? `Solar surplus spotted: up to ${r0(mx)} kW from ${fmtTime(s0 * 15)} to ${fmtTime(s1 * 15 + 15)}, about ${r0(kwh)} kWh. Lining up pumps, e-buses, EVs, pre-cooling and the battery to soak it up.`
      : `No real solar surplus expected today (${fc.weather}); the battery will be topped up from the grid at Rs 6.4 before the peak.`);
  }
  if (slot === 64 && !F.p16) {
    F.p16 = true;
    let pk = 0, pkS = 72;
    for (let s = 72; s < 88; s++) { const n = fc.total[s] - fc.solar50[s]; if (n > pk) { pk = n; pkS = s; } }
    say(state, 'PREDICT', 'info', `Evening re-forecast: net demand peaks near ${r0(pk)} kW at ${fmtTime(pkS * 15)} (P90 ${r0(pk * 1.06)}). Battery at ${Math.round(num(state.equipment[BAT.id].soc) * 100)}% plus pre-cool can hold the grid at about ${r0(_.L)} kW.`);
  }
}

function updateFlexScore(state) {
  const T = state.energy.totals, _ = I(state);
  let rel = 0, n = 0;
  for (const e of EQUIPMENT) {
    if (e.kind === 'solar') continue;
    rel += num(state.equipment[e.id] && state.equipment[e.id].reliability, 0.9); n++;
  }
  const avgRel = n ? rel / n : 0.9;
  const ratio = T.flexPromisedKWh > 1 ? T.flexDeliveredKWh / T.flexPromisedKWh : 0;
  const reb = T.flexDeliveredKWh > 1 ? T.reboundKWh / T.flexDeliveredKWh : 0;
  if (T.flexPromisedKWh <= 1) return;     // nothing dispatched yet today: keep the last score
  const score = clamp(100 * ratio * avgRel - 100 * reb - 8 * _.violationsToday, 0, 100);
  Object.assign(state.flexScore, {
    score: r0(score), delivered: r0(T.flexDeliveredKWh), promised: r0(T.flexPromisedKWh),
    rebound: r1(T.reboundKWh), safetyViolations: _.violationsToday, reliability: Math.round(avgRel * 100) / 100,
    deliveredRatio: Math.round(ratio * 100) / 100,
  });
}

// ---------- PROVE ----------
export function onDayEnd(state) {
  if (!I(state)) initEnergy(state);
  const _ = I(state), E = state.energy, T = E.totals;
  updateFlexScore(state);
  const pct = (a, b) => (b > 1 ? Math.round(((b - a) / b) * 1000) / 10 : 0);
  const summary = {
    day: state.day, weather: state.scenario.weather, batteryKWh: batteryCaps(state).cap,
    partial: T.startMinute > 10 || T.minutes < 1400,
    costHukum: r0(T.costHukum), costBaseline: r0(T.costBaseline), costBatteryOnly: r0(T.costBatteryOnly), costBatteryOnlyRef: r0(T.costBatteryOnlyRef),
    savingRs: r0(T.costBaseline - T.costHukum), savingPct: pct(T.costHukum, T.costBaseline),
    batteryOnlySavingPct: pct(T.costBatteryOnly, T.costBaseline), batteryOnlyRefSavingPct: pct(T.costBatteryOnlyRef, T.costBaseline),
    peakHukum: r0(T.peakHukumKW), peakBaseline: r0(T.peakBaselineKW), peakBatteryOnly: r0(T.peakBatteryOnlyKW),
    peakEveningHukum: r0(T.peakEveningHukumKW), peakEveningBaseline: r0(T.peakEveningBaselineKW),
    peakEveningHukumKW: r0(T.peakEveningHukumKW), peakEveningBaselineKW: r0(T.peakEveningBaselineKW),
    kWhHukum: r0(T.kWhHukum), kWhBaseline: r0(T.kWhBaseline),
    solarGenKWh: r0(T.solarGenKWh), solarSelfUsePct: T.solarGenKWh > 1 ? Math.round((T.solarUsedKWh / T.solarGenKWh) * 1000) / 10 : 0,
    exportKWh: r0(T.exportKWh), classroomSavedPct: T.classroomKWhBaseline > 1 ? Math.round((1 - T.classroomKWhHukum / T.classroomKWhBaseline) * 1000) / 10 : 0,
    co2AvoidedKg: r0(T.co2AvoidedKg), batteryThroughputKWh: r0(T.batteryThroughputKWh),
    dieselKWh: r0(T.dieselKWh), shedKWh: r0(T.shedKWh),
    flexScore: state.flexScore.score, flexPromisedKWh: r0(T.flexPromisedKWh), flexDeliveredKWh: r0(T.flexDeliveredKWh),
    reboundKWh: r1(T.reboundKWh), safetyViolations: _.violationsToday, mode: state.mode,
    shadowWouldSaveRs: r0(T.shadowWouldSaveRs),
    demandChargeHukum: r0(T.demandChargeHukum), demandChargeBaseline: r0(T.demandChargeBaseline),
    blockKWh: Object.fromEntries(Object.entries(E.blockMeters || {}).map(([id, m]) => [id, { hukum: r0(m.kWhToday), baseline: r0(m.baselineKWhToday) }])),
  };
  E.pastDays.push(summary);
  if (E.pastDays.length > 30) E.pastDays.splice(0, E.pastDays.length - 30);
  say(state, 'PROVE', 'saving', `Day ${summary.day} verified${summary.partial ? ' (partial day)' : ''}: Rs ${summary.costHukum.toLocaleString('en-IN')} vs Rs ${summary.costBaseline.toLocaleString('en-IN')} baseline, ${summary.savingPct}% saved (battery-only would save ${summary.batteryOnlySavingPct}%). Peak ${summary.peakHukum} kW vs ${summary.peakBaseline} kW. Rebound ${summary.reboundKWh} kWh counted. Flex Score ${summary.flexScore}.`);

  // learn today's profile
  const L = _.learned, td = _.today;
  for (let s = 0; s < SLOTS; s++) {
    if (td.n[s] < 5) continue;
    L.inflex[s] = 0.4 * L.inflex[s] + 0.6 * (td.inflex[s] / td.n[s]);
    L.total[s] = 0.4 * L.total[s] + 0.6 * (td.total[s] / td.n[s]);
    L.base[s] = 0.4 * L.base[s] + 0.6 * (td.base[s] / td.n[s]);
  }
  _.today = newToday();
  _.violationsToday = 0; _.violationKeys = new Set();
  _.battOnly.peak = 0; _.battRef.peak = 0;
  E.history = [];
  E.totals = freshTotals(state);
  E.totals.startMinute = 0;
  for (const m of Object.values(E.blockMeters || {})) { m.kWhToday = 0; m.baselineKWhToday = 0; }
  _.lastMin = Math.floor(state.t);
  ensureDay(state);
}

// ---------- init / actions ----------
export function initEnergy(state) {
  const E = ensureEnergyShape(state);
  Object.defineProperty(E, '_', { value: newInternal(state), enumerable: false, configurable: true, writable: true });
  for (const e of EQUIPMENT) {
    const es = state.equipment[e.id];
    if (!es) continue;
    es.intent = null; es.rebound = 0;
    if (e.kind === 'ev' || e.kind === 'ebus') es.session = null;
  }
  E.blockMeters = Object.fromEntries(M.METER_IDS.map((id) => [id, { kW: 0, baselineKW: 0, kWhToday: 0, baselineKWhToday: 0, solarKW: 0 }]));
  E.solarSplit = M.SOLAR_SPLIT.map((x) => ({ ...x, kW: 0 }));
  ensureDay(state);
  issueForecast(state, slotOf(state.t));
  discover(state);
  planBattery(state, slotOf(state.t));
}

export function applyEquipmentAction(state, action) {
  if (!I(state) || !action || !action.target) return;
  const _ = I(state);
  const key = `${action.target.id}:${action.action}`;
  const until = num(action.untilT, state.t + 120);
  _.approvals.set(key, until);
  action.executedAt = state.t;
  say(state, 'ACT', 'action', `Operator approved: ${action.text}. Executing until ${fmtTime(minuteOfDay(until))}.`);
}

export function setEquipmentOverride(state, equipId, mode) {
  const es = state.equipment && state.equipment[equipId];
  if (!es) return;
  es.override = mode === 'on' || mode === 'off' ? mode : null;
  const name = (EQUIPMENT.find((e) => e.id === equipId) || (equipId === FLOOD.id ? FLOOD : {})).name || equipId;
  say(state, 'ACT', 'info', es.override ? `Manual override: ${name} forced ${es.override.toUpperCase()}. HUKUM will plan around it.` : `Override cleared: ${name} back under HUKUM control.`);
}
