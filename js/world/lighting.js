// Daylight curve and per-room lighting state, shared by the top-down and
// first-person renderers. Reads state defensively: any field may be unset.
import { minuteOfDay } from '../state.js';

// Infrastructure that is lit whenever powered, even if the occupancy model
// never touches its lightsOn flag.
const ALWAYS_ON = new Set(['core', 'electrical', 'server', 'security']);
// Open-air areas: brightness follows the sky only.
const OUTDOOR = new Set(['roof', 'plant', 'gate', 'parking', 'sports']);

const smooth = (x) => x * x * (3 - 2 * x);

// 0 = night, 1 = full day. Sunrise ramps 05:45-07:00, sunset 17:45-19:00.
export function daylight(t) {
  const m = minuteOfDay(Number.isFinite(t) ? t : 720);
  const r0 = 345, r1 = 420, s0 = 1065, s1 = 1140;
  if (m < r0 || m >= s1) return 0;
  if (m < r1) return smooth((m - r0) / (r1 - r0));
  if (m < s0) return 1;
  return 1 - smooth((m - s0) / (s1 - s0));
}

// Peaks around sunrise and sunset; used for a warm orange tint.
export function dusk(dl) { return 4 * dl * (1 - dl); }

export function cameraOnline(state, camId) {
  const c = camId && state.cameras ? state.cameras[camId] : null;
  return !c || c.online !== false;
}

// Lighting description of a room (or corridor) right now.
// dark: 0..1 alpha of the night-blue darkness laid over the room.
// floor: the FLOORS entry the room is on (roof and campus corridors are open air).
export function roomLight(state, room, dl, floor) {
  const isCorridor = room && typeof room.id === 'string' && room.id.startsWith('COR-');
  const s = (!isCorridor && state.rooms && state.rooms[room.id]) || {};
  const type = isCorridor ? 'corridor' : room.type;
  const outdoor = OUTDOOR.has(type) || !!room.outdoor || (isCorridor && !!floor && (floor.isRoof || floor.isCampus));
  const powered = s.powered !== false;
  let lit = !!s.lightsOn;
  if (!lit && powered && ALWAYS_ON.has(type)) lit = true;
  const manualOff = s.override === 'off';
  const autoOff = !manualOff && s.override !== 'on' && !!room.autoOff && (!powered || s.offSince != null) && !lit;
  const camOffline = room.camera ? !cameraOnline(state, room.camera.id) : false;
  const night = 1 - dl;
  let dark;
  if (outdoor) dark = night * 0.62;
  else if (isCorridor) { dark = 0.04 + night * 0.26; lit = night > 0.3 || lit; }
  else if (type === 'parking') dark = lit ? 0.04 + night * 0.14 : 0.1 + night * 0.62;
  else if (lit) dark = 0.02 + night * 0.12;
  else dark = 0.34 + night * 0.52;
  return { lit, powered, autoOff, manualOff, camOffline, outdoor, dark, s, type };
}

// Light factor 0..1 for the raycaster from a darkness alpha.
export const lightFromDark = (dark) => Math.max(0.07, 1 - dark * 0.95);
