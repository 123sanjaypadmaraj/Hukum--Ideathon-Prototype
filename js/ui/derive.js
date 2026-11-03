// Read-only derivations from the live state. Every read is defensive: the
// simulation modules may not have populated a field yet.
import { CONFIG } from '../config.js';
import { ROOMS, ROOM_BY_ID, PANELS, PANEL_BY_ID, EQUIPMENT, EQUIPMENT_BY_ID, FLOORS, BLOCKS, BLOCK_BY_ID, SITE } from '../building.js';
import { minuteOfDay } from '../state.js';
import { safe, isNum } from './util.js';

export const ENGINES = ['SEE', 'PREDICT', 'DISCOVER', 'DECIDE', 'ACT', 'PROVE'];
export const ENGINE_INFO = {
  SEE: 'Occupancy from existing CCTV, processed on the edge box',
  PREDICT: 'Solar and demand forecast with P10 / P50 / P90 range',
  DISCOVER: 'Learns how much each machine can shift, and how reliably',
  DECIDE: 'Internal flexibility market: cheapest dependable mix wins',
  ACT: 'MPC dispatch within comfort and safety limits',
  PROVE: 'Verified savings against the do-nothing baseline',
};

// Rooms worth listing in tables (skip stair cores and risers).
export const LIST_ROOMS = ROOMS.filter((r) => r.type !== 'core' && !r.id.startsWith('RISER-'));

export const roomState = (state, id) => (state && state.rooms && state.rooms[id]) || {};
export const equipState = (state, id) => (state && state.equipment && state.equipment[id]) || {};

export function roomCentre(room) {
  return { floor: room.floor, x: room.x + room.w / 2, y: room.y + room.h / 2 };
}

export function roomPower(state, id) {
  const rs = roomState(state, id);
  if (rs.override === 'off') return { key: 'override-off', label: 'MANUAL OFF', tone: 'info' };
  if (rs.override === 'on') return { key: 'override-on', label: 'MANUAL ON', tone: 'info' };
  if (rs.powered === false) return { key: 'auto-off', label: 'AUTO-OFF', tone: 'off' };
  const any = rs.lightsOn || rs.fansOn || rs.acOn || safe(rs.loadKW) > 0.05;
  return any ? { key: 'on', label: 'ON', tone: 'on' } : { key: 'idle', label: 'IDLE', tone: 'idle' };
}

export function cameraForRoom(state, roomId) {
  const room = ROOM_BY_ID[roomId];
  const cam = room && room.camera;
  if (!cam) return null;
  const cs = (state.cameras && state.cameras[cam.id]) || {};
  return { id: cam.id, online: cs.online !== false, count: safe(cs.count) };
}

// ---------- circuits (AR lens) ----------
export function circuitKW(state, c) {
  if (c.roomId) {
    const room = ROOM_BY_ID[c.roomId];
    const rs = roomState(state, c.roomId);
    if (!room) return 0;
    const L = room.loads || {};
    if (rs.powered === false && rs.override !== 'on') return 0;
    if (c.kind === 'lighting') return (rs.lightsOn ? safe(L.lightsKW) : 0) + (rs.fansOn ? safe(L.fansKW) : 0);
    if (c.kind === 'ac') return rs.acOn ? safe(L.acKW) : 0;
    if (c.kind === 'equipment') {
      const lit = (rs.lightsOn ? safe(L.lightsKW) : 0) + (rs.fansOn ? safe(L.fansKW) : 0) + (rs.acOn ? safe(L.acKW) : 0);
      if (isNum(rs.loadKW)) return Math.max(0, Math.min(safe(L.equipKW), rs.loadKW - lit));
      return safe(L.equipKW) * 0.5;
    }
    return 0;
  }
  const e = state.energy || {};
  switch (c.kind) {
    case 'incomer': return safe(e.gridKW);
    case 'solar': return safe(e.solarKW);
    case 'battery': return safe(equipState(state, 'BAT-1').kW, safe(e.batteryKW));
    case 'ev': return EQUIPMENT.filter((q) => q.kind === 'ev' || q.kind === 'ebus').reduce((s, q) => s + Math.max(0, safe(equipState(state, q.id).kW)), 0);
    case 'feeder': return feederKW(state, c.label, c);
    default: return 0;
  }
}

function panelKW(state, panelId) {
  const p = PANEL_BY_ID[panelId];
  if (!p) return 0;
  return p.circuits.reduce((s, c) => s + circuitKW(state, c), 0);
}

function feederKW(state, label, c) {
  const e = state.energy || {};
  const meters = e.blockMeters || {};
  if (c && c.blockId) return blockMeter(state, c.blockId).kW;
  if (/hostel/i.test(label || '')) {
    const m = meters.HOSTELS;
    if (m && isNum(m.kW)) return m.kW;
    return CONFIG.campus.otherBlocksBaseKW + Math.max(0, safe(equipState(state, 'HVAC-BD').kW));
  }
  if (/floodlight|campus/i.test(label || '')) {
    const m = meters.CAMPUS;
    if (m && isNum(m.kW)) return m.kW;
    return roomsOfBlock('CAMPUS').reduce((s, r) => s + safe(roomState(state, r.id).loadKW), 0);
  }
  return 0;
}

// ---------- blocks ----------
const ROOMS_BY_BLOCK = {};
for (const r of LIST_ROOMS) (ROOMS_BY_BLOCK[r.blockId || 'CAMPUS'] = ROOMS_BY_BLOCK[r.blockId || 'CAMPUS'] || []).push(r);
export const roomsOfBlock = (blockId) => ROOMS_BY_BLOCK[blockId] || [];

// Per-block meter from state.energy.blockMeters, or derived from room loads.
export function blockMeter(state, blockId) {
  const m = (state.energy && state.energy.blockMeters && state.energy.blockMeters[blockId]) || null;
  const rooms = roomsOfBlock(blockId);
  let kW = 0, base = 0, ppl = 0, off = 0;
  for (const r of rooms) {
    const rs = roomState(state, r.id);
    kW += safe(rs.loadKW); base += safe(rs.baselineLoadKW); ppl += safe(rs.occupancy);
    if (rs.powered === false && rs.override !== 'on') off++;
  }
  for (const q of EQUIPMENT) {
    if (q.blockId === blockId && q.kind !== 'solar' && q.kind !== 'battery') { const v = Math.max(0, safe(equipState(state, q.id).kW)); kW += v; base += v; }
  }
  const solar = solarOfBlock(state, blockId);
  return {
    derived: !m,
    kW: m && isNum(m.kW) ? m.kW : kW,
    baselineKW: m && isNum(m.baselineKW) ? m.baselineKW : base,
    kWhToday: m ? m.kWhToday : null,
    baselineKWhToday: m ? m.baselineKWhToday : null,
    solarKW: m && isNum(m.solarKW) && m.solarKW > 0.05 ? m.solarKW : solar.kW,
    solar, people: ppl, autoOff: off, rooms: rooms.length,
  };
}

// Rooftop solar for a block from state.energy.solarSplit [{blockId,kWp,kW,existing}].
export function solarOfBlock(state, blockId) {
  const all = (state.energy && Array.isArray(state.energy.solarSplit)) ? state.energy.solarSplit : [];
  const list = all.filter((x) => x && x.blockId === blockId);
  const sum = (arr, k) => arr.reduce((s, x) => s + safe(x[k]), 0);
  const ex = list.filter((x) => x.existing), nw = list.filter((x) => !x.existing);
  return { list, kWp: sum(list, 'kWp'), kW: sum(list, 'kW'), existingKWp: sum(ex, 'kWp'), existingKW: sum(ex, 'kW'), newKWp: sum(nw, 'kWp'), newKW: sum(nw, 'kW') };
}

export const blockName = (id) => (BLOCK_BY_ID[id] ? BLOCK_BY_ID[id].name : id === 'CAMPUS' ? 'Campus zones' : id === 'HOSTELS' ? 'Other blocks & hostels' : id === 'PLANT' ? 'Central plant' : id || '');

export function circuitState(state, c) {
  if (c.roomId) {
    const rs = roomState(state, c.roomId);
    if (rs.override === 'off') return 'override';
    if (rs.override === 'on') return 'override';
    if (rs.powered === false) return 'off';
    return circuitKW(state, c) > 0.05 ? 'live' : 'idle';
  }
  if (c.equipId) {
    const es = equipState(state, c.equipId);
    if (es.override) return 'override';
  }
  if (c.kind === 'incomer' && state.scenario && state.scenario.outage) return 'off';
  return Math.abs(circuitKW(state, c)) > 0.05 ? 'live' : 'idle';
}

export function capacityKW(c) {
  // Single-phase 230 V for final circuits, three-phase 415 V for panel-level ways.
  const threePhase = !c.roomId;
  return threePhase ? (1.732 * 415 * c.ratingA * 0.95) / 1000 : (230 * c.ratingA) / 1000;
}

// ---------- KPIs ----------
const ratio = (a, b) => (isNum(a) && isNum(b) && b > 1e-9 ? a / b : null);

export function kpis(state) {
  const T = (state.energy && state.energy.totals) || {};
  const base = T.costBaseline;
  return {
    costHukum: T.costHukum, costBaseline: base, costBatteryOnly: T.costBatteryOnly,
    savingRs: isNum(base) && isNum(T.costHukum) ? base - T.costHukum : null,
    savingPct: base > 1 ? (base - T.costHukum) / base : null,
    batteryOnlyPct: base > 1 && isNum(T.costBatteryOnly) ? (base - T.costBatteryOnly) / base : null,
    peakHukum: T.peakHukumKW, peakBaseline: T.peakBaselineKW,
    peakCutPct: T.peakBaselineKW > 1 ? (T.peakBaselineKW - T.peakHukumKW) / T.peakBaselineKW : null,
    solarSelfUse: ratio(T.solarUsedKWh, T.solarGenKWh),
    classroomSavedPct: T.classroomKWhBaseline > 0.1 ? 1 - T.classroomKWhHukum / T.classroomKWhBaseline : null,
    co2: T.co2AvoidedKg,
    kWhHukum: T.kWhHukum, kWhBaseline: T.kWhBaseline,
    exportKWh: T.exportKWh, solarGenKWh: T.solarGenKWh, solarUsedKWh: T.solarUsedKWh,
    batteryThroughputKWh: T.batteryThroughputKWh,
    flex: safe(state.flexScore && state.flexScore.score, null),
  };
}

export function tariffBand(mod) {
  const h = mod / 60, t = CONFIG.tariff;
  if (h >= t.peakHours[0] && h < t.peakHours[1]) return 'peak';
  if (h >= t.solarHours[0] && h < t.solarHours[1]) return 'solar';
  return 'normal';
}

// Engine active in the 15-minute loop (each takes 2.5 sim minutes).
export function activeEngine(state) {
  const m = minuteOfDay(safe(state.t)) % CONFIG.slotMinutes;
  return ENGINES[Math.min(5, Math.floor(m / (CONFIG.slotMinutes / 6)))];
}

export const floorShort = (lvl) => (FLOORS[lvl] ? FLOORS[lvl].short : String(lvl));

// Find a room, block or equipment mentioned in free text (ids exact, names fuzzy).
const STOP = new Set(['the', 'is', 'a', 'an', 'in', 'on', 'off', 'of', 'why', 'what', 'how', 'much', 'many', 'does', 'do', 'it', 'right', 'now', 'status', 'room', 'block', 'and', 'are', 'there', 'which', 'who', 'using', 'use', 'uses', 'power', 'energy', 'kw', 'class', 'about', 'tell', 'me', 'still', 'whats', 'with', 'for', 'to', 'at', 'most', 'least', 'today', 'produce', 'produces', 'solar']);
const norm = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (t) => norm(t).split(/[ -]/).filter((w) => w && !STOP.has(w));
const ROOM_TOKENS = LIST_ROOMS.filter((r) => r.type !== 'roof' && r.type !== 'plant' && r.type !== 'electrical').map((r) => ({ r, name: new Set(tokens(r.name)), id: new Set(tokens(r.id)) }));
const ALIASES = [['auditorium', 'AUD-HALL'], ['canteen', 'CAFE'], ['cafeteria', 'CAFE'], ['food court', 'CAFE'], ['medical', 'SANJEEVINI'], ['clinic', 'SANJEEVINI'], ['library', 'MB-LIB'],
  ['gym', 'GYM'], ['atm', 'BANK'], ['bank', 'BANK'], ['data centre', 'MB-SERVER'], ['server', 'MB-SERVER'], ['idea lab', 'IDEA-LAB'], ['exam hall', 'NSC-EXAM'], ['placement', 'PLACEMENT'],
  ['gpu', 'AIML-LAB'], ['conference', 'MB-CONF'], ['main gate', 'GATE'], ['parking', 'PARKING']];
const EQ_ALIASES = [['pump', 'PUMP-1'], ['chiller', 'AHU-A'], ['ahu', 'AHU-A'], ['e-bus', 'EBUS-1'], ['bus charger', 'EBUS-1'], ['battery', 'BAT-1']];

export function findBlock(text) {
  const q = ` ${norm(text)} `;
  for (const b of BLOCKS) {
    if (q.includes(` ${b.id.toLowerCase()} `) || q.includes(` ${norm(b.name)} `)) return b;
  }
  if (/ main /.test(q) && !/ main gate /.test(q)) return BLOCK_BY_ID.MB || null;
  if (/ amenit/.test(q)) return BLOCK_BY_ID.AMN || null;
  return null;
}

export function findMention(text) {
  const q = ` ${norm(text)} `;
  for (const e of EQUIPMENT) if (q.includes(` ${e.id.toLowerCase()} `)) return { type: 'equipment', item: e };
  for (const r of ROOMS) if (q.includes(` ${r.id.toLowerCase()} `)) return { type: 'room', item: r };
  for (const [word, id] of ALIASES) if (q.includes(` ${word}`) && ROOM_BY_ID[id]) return { type: 'room', item: ROOM_BY_ID[id] };
  // Fuzzy: score rooms by overlapping name / id tokens ("ai & ml lab", "cse classroom 103", "ece 201").
  const qt = tokens(text);
  if (qt.length) {
    let best = null, bestScore = 0;
    for (const { r, name, id } of ROOM_TOKENS) {
      let sc = 0;
      for (const w of qt) if (name.has(w) || id.has(w)) sc += /^\d+$/.test(w) ? 2 : 1;
      if (sc > 0) sc -= name.size * 0.01;
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    if (best && bestScore >= 1.5) return { type: 'room', item: best };
  }
  for (const [word, id] of EQ_ALIASES) if (q.includes(word) && EQUIPMENT_BY_ID[id]) return { type: 'equipment', item: EQUIPMENT_BY_ID[id] };
  return null;
}

export { ROOMS, ROOM_BY_ID, PANELS, PANEL_BY_ID, EQUIPMENT, EQUIPMENT_BY_ID, FLOORS, BLOCKS, BLOCK_BY_ID, SITE };
