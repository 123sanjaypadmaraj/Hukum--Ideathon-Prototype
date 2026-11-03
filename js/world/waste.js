// Waste watch: finds rooms whose lights are on while nobody is inside
// (ground truth from the twin, not the camera), times each episode in sim
// minutes, and raises one batched warning when an episode passes WARN_MIN.
// The x-ray and top-down views paint these rooms red; the HUD lists them.
import { ROOMS, ROOM_BY_ID, FLOORS, AUTO_OFF_TYPES } from '../building.js';
import { CONFIG, tariffAt } from '../config.js';
import { minuteOfDay } from '../state.js';

// Rooms where an empty, lit space is waste. Lobbies, cores, risers, servers
// and security are meant to stay lit.
export const WASTE_TYPES = new Set([...AUTO_OFF_TYPES, 'canteen']);
export const GLOW_MIN = 1;          // ignore someone stepping out for a moment
export const WARN_MIN = 5;          // sim minutes lit and empty before a warning
const TOAST_GAP_MS = 3500;          // batch warnings so a slot change is one toast

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function createWasteWatch({ state, actions = {} }) {
  const since = new Map();          // roomId -> sim minute the episode started
  const warned = new Set();
  let queue = [];
  let lastToast = 0;
  let lastT = null;
  let list = [];
  let totals = { rooms: 0, kW: 0, rsPerHour: 0 };

  // Why nobody has switched the room off yet, in plain words.
  function reason(r, s) {
    const cam = r.camera && state.cameras ? state.cameras[r.camera.id] : null;
    if (s.override === 'on') return 'manual override is holding it on';
    if (!state.scenario || state.scenario.hukumEnabled === false) return 'HUKUM is off, nobody will switch it off';
    if (!r.autoOff) return 'not on HUKUM auto-off, needs a manual switch-off';
    if (cam && cam.online === false) return 'camera offline, fail-safe is holding power on';
    if (state.mode === 'shadow') return 'shadow mode, HUKUM is only logging it';
    if (state.mode === 'approve') return 'waiting for operator approval to switch off';
    return `HUKUM switches it off at ${CONFIG.occupancy.autoOffMinutes} min`;
  }

  function update() {
    const t = Number(state.t);
    if (!Number.isFinite(t) || t === lastT) { flush(); return; }
    lastT = t;
    const rs = state.rooms || {};
    const next = [];
    let kW = 0;
    for (const r of ROOMS) {
      if (!WASTE_TYPES.has(r.type) || r.outdoor) continue;
      const s = rs[r.id];
      const wasting = !!(s && s.lightsOn && !(num(s.occupancy) > 0));
      if (!wasting) { since.delete(r.id); warned.delete(r.id); continue; }
      if (!since.has(r.id)) since.set(r.id, t);
      const min = t - since.get(r.id);
      if (min < GLOW_MIN) continue;
      const load = num(s.loadKW);
      kW += load;
      const f = FLOORS[r.floor];
      next.push({ id: r.id, name: r.name, floor: r.floor, where: f ? f.short : '', min, kW: load, why: reason(r, s) });
      if (min >= WARN_MIN && !warned.has(r.id)) { warned.add(r.id); queue.push(r.id); }
    }
    next.sort((a, b) => b.min - a.min || b.kW - a.kW);
    list = next;
    const tariff = tariffAt(minuteOfDay(t));
    totals = { rooms: next.length, kW, rsPerHour: kW * tariff };
    flush();
  }

  function flush() {
    if (!queue.length) return;
    const now = performance.now();
    if (now - lastToast < TOAST_GAP_MS) return;
    lastToast = now;
    // Drop rooms that recovered while the warning was queued.
    const ids = queue.filter((id) => since.has(id));
    queue = [];
    if (!ids.length) return;
    const rs = state.rooms || {};
    const kw = ids.reduce((a, id) => a + num(rs[id] && rs[id].loadKW), 0);
    let text;
    if (ids.length === 1) {
      const r = ROOM_BY_ID[ids[0]];
      text = `${r.name}: lights on with nobody inside for ${WARN_MIN}+ min (${kw.toFixed(1)} kW). ${cap(reason(r, rs[r.id] || {}))}.`;
    } else {
      const names = ids.slice(0, 3).map((id) => id).join(', ') + (ids.length > 3 ? ` +${ids.length - 3} more` : '');
      text = `${ids.length} rooms lit with nobody inside for ${WARN_MIN}+ min (${kw.toFixed(1)} kW): ${names}`;
    }
    if (typeof actions.toast === 'function') actions.toast('warn', `Waste warning. ${text}`);
    if (Array.isArray(state.copilot)) state.copilot.push({ t: state.t, level: 'warn', engine: 'SEE', text });
  }

  return {
    update,
    // Minutes this room has been lit and empty, or null when it is fine.
    minutes(id) {
      const s0 = since.get(id);
      if (s0 == null) return null;
      const m = Number(state.t) - s0;
      return m >= GLOW_MIN ? m : null;
    },
    get list() { return list; },
    get totals() { return totals; },
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
