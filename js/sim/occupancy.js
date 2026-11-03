// SEE + room control: timetable, people simulation, simulated YOLO detections
// per camera, camera-driven auto-off / instant power-on, fail-safe, overrides,
// shadow/approve pending actions, a room thermal model, and HUKUM vs baseline
// room loads. Called by engine.js every <= 0.25 sim minutes.
import { CONFIG, mulberry32, fmtTime, tariffAt } from '../config.js';
import { bus } from '../bus.js';
import { ROOMS, ROOM_BY_ID, CAMERAS, CAMERA_BY_ID, FLOORS, roomAt } from '../building.js';
import { minuteOfDay } from '../state.js';
import { placeById, randomPoint, boardPoint, stagePoint, anchorPoint, makeSeats, planPath, gatePoint, busBayPoint, carParkPoint, GROUND_CORRIDORS } from './occ-geo.js';
import { SLOTS, AWAY, DEMO_LAB, createAgents, buildDayPlan, desiredAct } from './occ-plan.js';

const OC = CONFIG.occupancy;
const COMFORT = CONFIG.comfort;
const VISION_EVERY = 2 / 60;        // YOLO frame every 2 sim seconds
const BASELINE_LEFT_ON_MIN = 20;   // baseline after hours: lights left on until someone switches them off
const TAU = 120;                    // envelope time constant (min)
const SIMS = new WeakMap();         // state -> private simulation data

const SEATS = Object.fromEntries(ROOMS.map((r) => [r.id, makeSeats(r)]));
const TEACHING = ROOMS.filter((r) => r.timetabled);
const CAM_OF_ROOM = Object.fromEntries(CAMERAS.filter((c) => c.kind !== 'corridor').map((c) => [c.roomId, c.id]));

// ---------------------------------------------------------------- helpers --

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function outdoorTemp(mod, weather = 'sunny') {
  const [mean, amp] = weather === 'monsoon' ? [26, 2] : weather === 'cloudy' ? [28, 3] : [29.5, 4.5];
  return mean + amp * Math.cos((2 * Math.PI * (mod - 900)) / 1440);     // warmest at 15:00
}

// Normal operating hours: what the room does with nobody optimising it.
function inNormalHours(room, mod) {
  switch (room.type) {
    case 'classroom': case 'lab': case 'workshop': case 'seminar': return mod >= OC.classStart && mod < OC.classEnd;
    case 'auditorium': return mod >= OC.classStart && mod < OC.classEnd;   // kept conditioned all day "in case"
    case 'library': return mod >= 510 && mod < 1200;
    case 'office': return mod >= 510 && mod < 1080;
    case 'medical': return mod >= 510 && mod < 1050;
    case 'gym': return mod >= 420 && mod < 1170;
    case 'recreation': return mod >= 540 && mod < 1200;
    case 'canteen': return mod >= 465 && mod < 1080;
    case 'lobby': return mod >= 390 && mod < 1320;
    default: return true;      // security, server, electrical, core, plant, roof, outdoor zones (lights only after dark)
  }
}

/** Seat layout for a room (world tiles, `facing` in radians). Handy for the world / CCTV renderers. */
export function getSeats(roomId) {
  return (SEATS[roomId] || []).map(({ x, y, facing }) => ({ x, y, facing }));
}

function copilot(state, level, engine, text, roomId) {
  state.copilot.push({ t: state.t, level, engine, text, roomId });
}

function devicesText(room) {
  const l = room.loads, parts = [];
  if (l.lightsKW) parts.push('lights');
  if (l.fansKW) parts.push('fans');
  if (l.acKW) parts.push('AC');
  if (l.equipKW && room.type !== 'server') parts.push(room.type === 'lab' ? 'bench power' : 'sockets');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'power';
}

// ------------------------------------------------------------------ init --

export function initOccupancy(state) {
  const rng = mulberry32(state.seed);
  const S = {
    rng: mulberry32((state.seed ^ 0x5eed1234) >>> 0),     // runtime randomness (movement, choices)
    vis: mulberry32((state.seed ^ 0x0b5e7e) >>> 0),        // vision noise
    agents: createAgents(rng),
    dayIdx: Math.floor(state.t / 1440),
    plan: null,
    bT: {},
    bLastOcc: {},        // baseline: last minute anyone was in the room              // baseline room temperatures
    pend: {},            // roomId -> pending/shadow action for the current empty spell
    buckets: new Map(),
    visAccum: VISION_EVERY,
    summaryKey: null,
    lastHukum: state.scenario.hukumEnabled,
    seq: 0,
  };
  SIMS.set(state, S);
  newDay(state, S);

  const mod = minuteOfDay(state.t);
  state.outdoorC = outdoorTemp(mod, state.scenario.weather);
  state.occStats = { autoOffs: 0, powerOns: 0, pendingCreated: 0, shadowSavedKWh: 0, shadowSavedRs: 0, onSite: 0, inClass: 0 };

  // Put everyone straight where they should be right now (no walking at t0).
  for (const a of S.agents) {
    const act = desiredAct(a, mod, S.plan);
    switchAct(state, S, a, act, mod, true);
  }
  rebuildPeople(state, S);
  countPeople(state, S);
  vision(state, S, true);

  for (const r of ROOMS) {
    const rs = state.rooms[r.id];
    const occ = countOf(S, r.id);
    const warm = state.outdoorC + 1.5;
    rs.tempC = warm; S.bT[r.id] = warm;
    rs.occupancy = occ;
    rs.precool = rs.precool || false;
    rs.precooling = false;
    if (r.autoOff) {
      // Rooms were switched off overnight; the first person in turns them on.
      rs.powered = occ > 0;
      rs.offSince = occ > 0 ? null : state.t;
      rs.lastSeenT = occ > 0 ? state.t : -Infinity;
    } else {
      rs.powered = inNormalHours(r, mod) || occ > 0;
      rs.lastSeenT = state.t;
    }
  }
  controlRooms(state, S, 0, mod);
}

function newDay(state, S) {
  const dayRng = mulberry32((state.seed + 7919 * (S.dayIdx + 1)) >>> 0);
  S.plan = buildDayPlan(S.dayIdx + 1, dayRng, S.agents);
  state.timetable = {
    day: S.dayIdx + 1,
    slots: SLOTS.map((s) => ({ k: s.k, start: s.start, end: s.end, label: `${fmtTime(s.start)}-${fmtTime(s.end)}` })),
    rooms: Object.fromEntries(Object.entries(S.plan.timetable).map(([id, arr]) => [id, arr.map((c) => c && {
      subject: c.subject, group: c.group, size: c.size, teacher: c.teacher, start: SLOTS[c.k].start, end: SLOTS[c.k].end + c.linger,
    })])),
  };
}

// ------------------------------------------------------------------ step --

export function stepOccupancy(state, dtMin) {
  const S = SIMS.get(state);
  if (!S) { initOccupancy(state); return; }
  const mod = minuteOfDay(state.t);
  const dayIdx = Math.floor(state.t / 1440);
  if (dayIdx !== S.dayIdx) { S.dayIdx = dayIdx; newDay(state, S); }
  state.outdoorC = outdoorTemp(mod, state.scenario.weather);

  let dirty = false;
  for (const a of S.agents) {
    if (!a.onSite && (mod < a.arrive || mod >= a.depart)) continue;      // off campus and staying off
    const act = desiredAct(a, mod, S.plan);
    if (act !== a.act) { const was = a.onSite; switchAct(state, S, a, act, mod, false); if (was !== a.onSite) dirty = true; }
    if (!a.onSite) continue;
    if (stepAgent(state, S, a, dtMin)) dirty = true;
  }
  if (dirty) rebuildPeople(state, S);
  countPeople(state, S);

  S.visAccum += dtMin;
  if (S.visAccum >= VISION_EVERY) { S.visAccum = 0; vision(state, S, false); }

  if (state.scenario.hukumEnabled && !S.lastHukum) {
    for (const r of ROOMS) state.rooms[r.id].lastSeenT = Math.max(state.rooms[r.id].lastSeenT, state.t);
  }
  S.lastHukum = state.scenario.hukumEnabled;

  controlRooms(state, S, dtMin, mod);
  slotSummary(state, S, mod);
}

// ---------------------------------------------------------------- people --

function rebuildPeople(state, S) {
  state.people = S.agents.filter((a) => a.onSite);
}

function releaseSeat(a) {
  if (a.seat) { a.seat.taken = null; a.seat = null; }
}

function claimSeat(S, roomId, a) {
  const seats = SEATS[roomId];
  if (!seats || !seats.length) return null;
  const free = [];
  for (const s of seats) if (!s.taken) free.push(s);
  if (!free.length) return null;
  // Big halls fill from the front; classrooms and tables are picked at random.
  const big = seats.length > 150;
  const s = free[Math.floor(S.rng() * (big ? Math.min(free.length, 50) : free.length))];
  s.taken = a.id;
  return s;
}

function chooseGoal(S, a, act) {
  const place = placeById(act.roomId);
  if (!place) return null;
  const floor = place.floor;
  const g = { floor, placeId: place.id, x: 0, y: 0, facing: null };
  const rng = S.rng;
  if (act.kind === 'seat') {
    const s = claimSeat(S, place.id, a);
    if (s) { a.seat = s; g.x = s.x; g.y = s.y; g.facing = s.facing; return g; }
    const p = randomPoint(place, rng); g.x = p.x; g.y = p.y;           // standing at the back
    return g;
  }
  if (act.kind === 'board') {
    const b = boardPoint(place); g.x = b.x + (rng() - 0.5) * 3; g.y = b.y; g.facing = b.facing; return g;
  }
  if (act.kind === 'stage') {
    const b = stagePoint(place, rng); g.x = b.x; g.y = b.y; return g;
  }
  if (act.kind === 'stand') {
    const b = anchorPoint(place); g.x = b.x + (rng() - 0.5) * 2.5; g.y = b.y + (rng() - 0.5) * 0.6; return g;
  }
  const p = randomPoint(place, rng); g.x = p.x; g.y = p.y;
  return g;
}

// Patrol beat: campus zones and every block's ground-floor corridor, plus the Main Block upper floors.
const PATROL_BEAT = ['GATE', ...GROUND_CORRIDORS.slice(0, 1), 'PARKING', 'BBALL', ...GROUND_CORRIDORS.slice(1), 'SPORTS',
  ...FLOORS.filter((f) => f.blockId === 'MB' && !f.isRoof && f.storey !== 0).map((f) => f.corridor.id)].filter((id) => placeById(id));
function patrolGoal(a, rng) {
  a.pIdx = (a.pIdx + 1) % PATROL_BEAT.length;
  const place = placeById(PATROL_BEAT[a.pIdx]);
  const p = randomPoint(place, rng, 1.2);
  const corridor = place.type === 'corridor';
  return { floor: place.floor, placeId: place.id, x: corridor ? (rng() < 0.5 ? 4 : 42) : p.x, y: corridor ? a.laneY : p.y, facing: null };
}

// Where people enter / leave the campus: walkers by the main gate, college
// buses at the bus bay, staff cars in the parking.
function campusEdge(a, rng) {
  return a.via === 'bus' ? busBayPoint(rng) : a.via === 'car' ? carParkPoint(rng) : gatePoint(rng);
}

function setPath(state, S, a, goal) {
  a.path = planPath(a, goal, S.rng);
  a.transitLeft = null;
  a.goal = goal;
  a.targetRoomId = goal.placeId;
  a.seated = false;
  a.dwellUntil = 0;
}

function switchAct(state, S, a, act, mod, warp) {
  releaseSeat(a);
  const prevAct = a.act;
  a.act = act; a.actKey = act.key; a.activity = act.label;
  if (act === AWAY) {
    if (!a.onSite) return;
    if (warp) { a.onSite = false; a.path = []; return; }
    a.activity = 'Heading home';
    setPath(state, S, a, { ...campusEdge(a, S.rng), facing: null });
    a.leaving = true;
    a.waitUntil = state.t + S.rng() * 3;
    return;
  }
  a.leaving = false;
  const arriving = !a.onSite;
  if (arriving) {
    a.onSite = true;
    const p = campusEdge(a, S.rng);
    a.floor = p.floor; a.x = p.x; a.y = p.y; a.roomId = roomAt(p.floor, p.x, p.y)?.id ?? null;
    a.missUntil = -1;
  }
  const goal = act.kind === 'patrol' ? patrolGoal(a, S.rng) : chooseGoal(S, a, act);
  if (!goal) return;
  if (warp) {
    a.floor = goal.floor; a.x = goal.x; a.y = goal.y; a.roomId = goal.placeId; a.path = [];
    a.goal = goal; a.targetRoomId = goal.placeId; a.seated = !!a.seat; a.facing = goal.facing ?? S.rng() * 6.28;
    a.dwellUntil = state.t + S.rng() * 10; a.waitUntil = 0;
    return;
  }
  setPath(state, S, a, goal);
  // People leaving a room at the slot change trickle out instead of moving in lockstep.
  a.waitUntil = !arriving && prevAct && prevAct !== AWAY ? state.t + S.rng() * (act.delay || 0) : 0;
}

// Returns true if the person left the site this step.
function stepAgent(state, S, a, dt) {
  if (a.waitUntil > state.t) { a.moving = false; return false; }
  if (a.path.length) {
    move(a, dt);
    if (!a.path.length) arrived(state, S, a);
    return false;
  }
  if (a.leaving) { a.onSite = false; a.leaving = false; a.roomId = null; a.moving = false; return true; }
  // Idle at the goal: wanderers, teachers, guards and cleaners move on after a while.
  const k = a.act && a.act.kind;
  if (k === 'seat' && a.seat) return false;
  if (!a.dwellUntil) { a.dwellUntil = state.t + dwellFor(a, S.rng); return false; }
  if (state.t >= a.dwellUntil) {
    const goal = k === 'patrol' ? patrolGoal(a, S.rng) : chooseGoal(S, a, a.act);
    if (goal) setPath(state, S, a, goal);
  }
  return false;
}

function dwellFor(a, rng) {
  switch (a.act.kind) {
    case 'patrol': return a.sub === 'patrol-night' ? 1 + rng() * 4 : 0.5 + rng() * 1.5;
    case 'stage': return 0.5 + rng() * 2;
    case 'board': return 0.5 + rng() * 2;
    case 'stand': return 1 + rng() * 4;
    case 'clean': return 0.4 + rng() * 1;
    case 'seat': return 3 + rng() * 8;        // no seat free: stand around, then look again
    default: return a.act.roomId && a.act.roomId.startsWith('COR') ? 2 + rng() * 6 : 3 + rng() * 9;
  }
}

function arrived(state, S, a) {
  a.moving = false;
  if (a.seat) { a.seated = true; a.facing = a.seat.facing; }
  else if (a.goal && a.goal.facing != null) a.facing = a.goal.facing;
}

function move(a, dt) {
  let time = dt;
  let moved = false;
  while (time > 1e-9 && a.path.length) {
    const wp = a.path[0];
    if (wp.floor !== a.floor) {                       // on the stairs / in the lift
      const tl = a.transitLeft ?? (wp.transit || 0.3);
      const use = Math.min(time, tl);
      time -= use;
      if (tl - use <= 1e-9) { a.floor = wp.floor; a.x = wp.x; a.y = wp.y; a.transitLeft = null; a.path.shift(); moved = true; }
      else { a.transitLeft = tl - use; break; }
      continue;
    }
    const dx = wp.x - a.x, dy = wp.y - a.y;
    const d = Math.hypot(dx, dy);
    const step = a.speed * time;
    if (d > 1e-6) a.facing = Math.atan2(dy, dx);
    if (step >= d) { a.x = wp.x; a.y = wp.y; time -= d / a.speed; a.path.shift(); }
    else { a.x += (dx / d) * step; a.y += (dy / d) * step; time = 0; }
    moved = true;
  }
  a.moving = moved;
  const r = roomAt(a.floor, a.x, a.y);
  a.roomId = r ? r.id : null;
}

// Bucket people by the place they stand in; counts and vision both use it.
function countPeople(state, S) {
  const B = S.buckets;
  for (const arr of B.values()) arr.length = 0;
  let inClass = 0;
  for (const p of state.people) {
    if (p.roomId) {
      let arr = B.get(p.roomId);
      if (!arr) B.set(p.roomId, (arr = []));
      arr.push(p);
    }
    if (p.seated && p.act && p.act.kind === 'seat' && p.act.key.startsWith('seat:')) inClass++;
  }
  if (state.occStats) { state.occStats.onSite = state.people.length; state.occStats.inClass = inClass; }
}
const countOf = (S, id) => { const b = S.buckets.get(id); return b ? b.length : 0; };

// ---------------------------------------------------------------- vision --

// Simulated YOLO person detection on the edge box: only people inside the
// camera's room / corridor zone, small miss rate (occlusion, seated people,
// IR at night), confidence noise, and slight box jitter.
function vision(state, S, force) {
  const rng = S.vis;
  const buckets = S.buckets;
  const m = minuteOfDay(state.t);
  const night = m >= 1095 || m < 375;
  for (const cam of CAMERAS) {
    const cs = state.cameras[cam.id];
    if (!cs) continue;
    const room = state.rooms[cam.roomId];
    if (!cs.online) {
      cs.count = 0; cs.detections = [];
      if (room) room.detected = null;
      continue;
    }
    const list = buckets.get(cam.roomId) || EMPTY;
    // Indoor rooms are dark when their lights are off; outdoor zones only at night.
    const dark = room ? (cam.kind === 'outdoor' ? night : !room.lightsOn) : night;
    const n = list.length;
    const dets = [];
    for (const p of list) {
      if (state.t < p.missUntil) continue;
      const pMiss = 0.012 + Math.min(0.05, n * 0.0007) + (p.seated ? 0.01 : 0) + (dark ? 0.02 : 0);
      if (!force && rng() < pMiss) { p.missUntil = state.t + 0.03 + rng() * 0.1; continue; }
      const conf = clamp(p.confBase - (p.seated ? 0.05 : 0) - Math.min(0.15, n * 0.0025) - (dark ? 0.1 : 0) + (rng() - 0.5) * 0.08, 0.3, 0.99);
      if (conf < 0.45) continue;
      dets.push({ personId: p.id, conf: Math.round(conf * 100) / 100, x: p.x + (rng() - 0.5) * 0.12, y: p.y + (rng() - 0.5) * 0.12 });
    }
    cs.detections = dets;
    cs.count = dets.length;
    cs.lastFrameT = state.t;
    if (room) {
      room.detected = dets.length;
      if (dets.length > 0) room.lastSeenT = state.t;
    }
  }
}

// ---------------------------------------------------------- room control --

function cameraOnline(state, roomId) {
  const camId = CAM_OF_ROOM[roomId];
  if (!camId) return false;
  const cs = state.cameras[camId];
  return !!cs && cs.online;
}

function nextClassStart(S, roomId, mod) {
  const tt = S.plan.timetable[roomId];
  if (!tt) return null;
  const k0 = Math.max(0, Math.floor((mod - OC.classStart) / 60) + 1);
  for (let k = mod < OC.classStart ? 0 : k0; k < tt.length; k++) if (tt[k]) return SLOTS[k].start;
  return null;
}

function currentClass(S, roomId, mod) {
  const tt = S.plan.timetable[roomId];
  if (!tt || mod < OC.classStart) return null;
  const k = Math.floor((mod - OC.classStart) / 60);
  const c = tt[k];
  return c && mod < SLOTS[k].end ? c : null;
}

// One thermal + electrical step. Returns the room's draw (kW).
function roomPhysics(room, T, Tout, occ, powered, acOnly, sp, shed, dt, out, dark) {
  const L = room.loads;
  const area = Math.max(20, room.w * room.h);
  const k = 100 / area;
  const lightsOn = powered && L.lightsKW > 0 && (!room.outdoor || dark);     // outdoor zones: lights after dark only
  const fansOn = powered && L.fansKW > 0 && !shed;
  const acOn = (powered || acOnly) && L.acKW > 0 && !shed;
  let equip = 0;
  if (L.equipKW > 0) {
    if (room.type === 'server') equip = L.equipKW;
    else if (powered) equip = L.equipKW * (room.type === 'canteen' ? 1 : occ > 0 ? 0.9 : 0.3);
  }
  const heat = (Tout - T) / TAU + 0.08 * (occ / 30) * k + equip * 0.006 * k + (lightsOn ? L.lightsKW * 0.01 * k : 0);
  const capFull = 0.1 * L.acKW * k;                     // C/min of cooling at full duty
  // Thermostat: feed-forward on the heat load + proportional pull-down.
  // Comfort hard limit: occupied room above 27 C -> full cooling regardless.
  let duty = 0;
  if (acOn) duty = occ > 0 && T > COMFORT.maxC ? 1 : clamp(heat / capFull + (T - sp) * 0.8, 0, 1);
  let Tn = T + (heat - capFull * duty) * dt;
  if (acOn && Tn < COMFORT.minC && T >= COMFORT.minC) Tn = COMFORT.minC;   // never over-cool below the comfort floor
  // Fixed-speed units: indoor fan + cycling losses keep the draw fairly flat.
  const acKW = acOn ? L.acKW * (0.5 + 0.5 * duty) : 0;
  out.lightsOn = lightsOn; out.fansOn = fansOn; out.acOn = acOn; out.T = Tn;
  return (lightsOn ? L.lightsKW : 0) + (fansOn ? L.fansKW : 0) + acKW + equip;
}

const EMPTY = [];
const OUT = { lightsOn: false, fansOn: false, acOn: false, T: 0 };

// Direct references to each room's state and camera state (avoids dictionary lookups per step).
function roomRefs(state, S) {
  if (S.refs && S.refsFor === state.rooms) return S.refs;
  S.refsFor = state.rooms;
  S.refs = ROOMS.map((room) => {
    const camId = CAM_OF_ROOM[room.id];
    return { room, rs: state.rooms[room.id], cs: camId ? state.cameras[camId] : null, bucket: null };
  }).filter((r) => r.rs);
  return S.refs;
}

function controlRooms(state, S, dt, mod) {
  const hukum = state.scenario.hukumEnabled !== false;
  const Tout = state.outdoorC;
  const autoOffMin = OC.autoOffMinutes;
  const dark = mod >= 1095 || mod < 375;
  for (const ref of roomRefs(state, S)) {
    const room = ref.room, rs = ref.rs;
    const occ = countOf(S, room.id);
    rs.occupancy = occ;
    if (!room.camera) rs.detected = null;
    const cls = room.timetabled ? currentClass(S, room.id, mod) : null;
    rs.scheduled = !!cls;
    rs.classLabel = cls ? `${cls.subject} (${cls.group})` : null;
    rs.nextClassAt = room.timetabled ? nextClassStart(S, room.id, mod) : null;

    // Baseline: normal hours, plus whenever someone is in. Outside hours, the last
    // person out leaves things on for a while (~20 min).
    const inHours = inNormalHours(room, mod);
    if (occ > 0) S.bLastOcc[room.id] = state.t;
    const baseP = inHours || occ > 0 || (room.autoOff && state.t - (S.bLastOcc[room.id] ?? -Infinity) < BASELINE_LEFT_ON_MIN);
    const camOk = !!ref.cs && ref.cs.online;
    rs.failSafe = room.autoOff && hukum && !camOk && !!room.camera;

    // ---- relay decision (HUKUM side)
    if (rs.override === 'on') rs.powered = true;
    else if (rs.override === 'off') rs.powered = false;
    else if (!hukum || !room.autoOff) { rs.powered = baseP; rs.hukumOff = false; }
    else if (!camOk) {
      rs.hukumOff = false;
      if (!rs.powered) powerOn(state, S, room, rs, 'failsafe');
    } else if (state.mode === 'automate') {
      if ((rs.detected || 0) > 0) {
        if (!rs.powered) powerOn(state, S, room, rs, 'detected');
        endEmptySpell(S, room.id);
      } else if (rs.powered && state.t - rs.lastSeenT >= autoOffMin) {
        emptyRoom(state, S, room, rs, mod, dt);
      }
    } else {
      // Shadow / approve: nothing happens on its own. The relay follows the
      // normal schedule unless an operator-approved switch-off is in effect.
      if ((rs.detected || 0) > 0) {
        endEmptySpell(S, room.id);
        if (rs.hukumOff) powerOn(state, S, room, rs, 'detected');
        else rs.powered = baseP;
      } else if (rs.hukumOff) {
        rs.powered = false;
      } else {
        rs.powered = baseP;
        if (!baseP) endEmptySpell(S, room.id);
        else if (state.t - rs.lastSeenT >= autoOffMin) emptyRoom(state, S, room, rs, mod, dt);
      }
    }

    // ---- pre-cool request from the energy engine (AC only, within comfort limits)
    const sp = hukum && rs.precool ? Math.max(COMFORT.minC, COMFORT.setpointC - 2) : COMFORT.setpointC;
    rs.setpointC = sp;
    let acOnly = false;
    if (hukum && rs.precool && !rs.powered && rs.override !== 'off' && room.loads.acKW > 0) {
      const nx = rs.nextClassAt;
      acOnly = nx != null && nx - mod <= 45;
    }
    const shed = rs.shed === true;
    const kw = roomPhysics(room, rs.tempC, Tout, occ, rs.powered, acOnly, sp, shed, dt, OUT, dark);
    rs.tempC = OUT.T; rs.lightsOn = OUT.lightsOn; rs.fansOn = OUT.fansOn; rs.acOn = OUT.acOn;
    rs.precooling = !!(rs.precool && OUT.acOn);
    rs.loadKW = kw;

    // ---- baseline ("do nothing") side
    const bkw = roomPhysics(room, S.bT[room.id], Tout, occ, baseP, false, COMFORT.setpointC, shed, dt, OUT, dark);
    S.bT[room.id] = OUT.T;
    rs.baselineLoadKW = bkw;
  }
}

function emptyRoom(state, S, room, rs, mod, dt) {
  const mode = state.mode;
  const existing = S.pend[room.id];
  if (mode === 'automate') {
    if (existing && existing.status === 'pending') existing.status = 'expired';
    autoOff(state, S, room, rs, 'auto');
    return;
  }
  if (existing) {
    if (existing.status === 'shadow') {          // log what HUKUM would have saved
      const kWh = (rs.loadKW * dt) / 60;
      existing.savedKWh = (existing.savedKWh || 0) + kWh;
      existing.savingRs = Math.round(existing.savedKWh * tariffAt(mod) * 10) / 10;
      state.occStats.shadowSavedKWh += kWh;
      state.occStats.shadowSavedRs += kWh * tariffAt(mod);
    }
    return;                                      // never duplicate for the same empty spell
  }
  const kW = Math.round(rs.loadKW * 10) / 10;
  const nx = rs.nextClassAt;
  const horizon = Math.min(60, nx != null ? nx - mod : 60);
  const camId = CAM_OF_ROOM[room.id];
  const status = mode === 'shadow' ? 'shadow' : 'pending';
  const action = {
    id: `occ-${++S.seq}`, t: state.t,
    text: `Switch off ${room.name}: empty for ${OC.autoOffMinutes} min (${kW} kW)`,
    target: { type: 'room', id: room.id }, action: 'off', kW,
    savingRs: status === 'shadow' ? 0 : Math.round(kW * tariffAt(mod) * horizon / 60 * 10) / 10,
    reason: `No person detected by ${camId} ${Number.isFinite(rs.lastSeenT) ? `since ${fmtTime(minuteOfDay(rs.lastSeenT))}` : 'today'}${nx != null ? `; next class ${fmtTime(nx)}` : '; no more classes today'}`,
    status,
  };
  state.pendingActions.push(action);
  S.pend[room.id] = action;
  state.occStats.pendingCreated++;
  copilot(state, 'action', 'ACT', status === 'shadow'
    ? `Shadow mode: would switch off ${room.name} (empty ${OC.autoOffMinutes} min, ${kW} kW) - logged, not executed`
    : `${room.name} empty for ${OC.autoOffMinutes} min - switch-off of ${kW} kW waiting for operator approval`, room.id);
}

function endEmptySpell(S, roomId) {
  const a = S.pend[roomId];
  if (!a) return;
  if (a.status === 'pending') a.status = 'expired';
  S.pend[roomId] = null;
}

function autoOff(state, S, room, rs, why) {
  const kW = Math.round(rs.loadKW * 10) / 10;
  rs.powered = false;
  rs.hukumOff = true;
  rs.offSince = state.t;
  state.occStats.autoOffs++;
  const empty = Math.max(OC.autoOffMinutes, Math.round(state.t - (Number.isFinite(rs.lastSeenT) ? rs.lastSeenT : state.t)));
  const mod = minuteOfDay(state.t);
  let text = why === 'approved'
    ? `Operator approved: ${room.name} switched off - ${devicesText(room)} off (saves ${kW} kW)`
    : `${room.name} empty for ${empty} min - ${devicesText(room)} off (saves ${kW} kW)`;
  if (room.id === DEMO_LAB && mod >= 810 && mod < 870) {
    const nx = state.rooms[room.id].nextClassAt;
    text += `. The 12:45 lab session ran over and finished at ${fmtTime(minuteOfDay(rs.lastSeenT))}; nothing is booked until ${nx != null ? fmtTime(nx) : 'tomorrow'}, so HUKUM holds it off until someone walks in.`;
  }
  if (room.type === 'auditorium') text += ' The hall AC alone is 45 kW.';
  copilot(state, why === 'auto' ? 'saving' : 'action', 'ACT', text, room.id);
  bus.emit('room:auto-off', { roomId: room.id, kW, reason: why });
}

function powerOn(state, S, room, rs, why) {
  rs.powered = true;
  rs.hukumOff = false;
  rs.offSince = null;
  if (why !== 'failsafe') rs.lastSeenT = state.t;
  state.occStats.powerOns++;
  const camId = CAM_OF_ROOM[room.id];
  copilot(state, why === 'failsafe' ? 'warn' : 'info', 'SEE', why === 'failsafe'
    ? `${camId} offline - ${room.name} power held ON (fail-safe)`
    : `Person detected in ${room.name} by ${camId} - power restored instantly`, room.id);
  bus.emit('room:power-on', { roomId: room.id, reason: why });
}

// Hourly SEE summary a few minutes into each teaching slot.
function slotSummary(state, S, mod) {
  for (const s of SLOTS) {
    if (mod < s.start + 5 || mod >= s.start + 6) continue;
    const key = `${S.dayIdx}:${s.k}`;
    if (S.summaryKey === key) return;
    S.summaryKey = key;
    const inUse = TEACHING.filter((r) => (state.rooms[r.id].occupancy || 0) > 0);
    const off = ROOMS.filter((r) => r.autoOff && !state.rooms[r.id].powered);
    const savedKW = off.reduce((a, r) => a + Math.max(0, state.rooms[r.id].baselineLoadKW - state.rooms[r.id].loadKW), 0);
    const names = off.filter((r) => r.timetabled || r.type === 'auditorium').slice(0, 6).map((r) => r.id);
    copilot(state, 'info', 'SEE', `${fmtTime(s.start)} slot: ${inUse.length} of ${TEACHING.length} teaching rooms in use, ${state.people.length} people on campus.`
      + (off.length ? ` ${off.length} empty rooms switched off, ${Math.round(savedKW)} kW below baseline${names.length ? ` (${names.join(', ')}${off.length > names.length ? ' ...' : ''})` : ''}.` : ' No empty rooms.'));
    return;
  }
}

// ------------------------------------------------------------ public API --

export function applyRoomAction(state, action) {
  const S = SIMS.get(state);
  const id = action && action.target && action.target.id;
  const room = ROOM_BY_ID[id], rs = state.rooms[id];
  if (!S || !room || !rs) return;
  if (action.action === 'off') {
    if ((rs.detected || 0) > 0 || (!cameraOnline(state, id) && room.camera)) {
      copilot(state, 'info', 'ACT', `${room.name} is occupied again (or its camera is offline) - switch-off skipped`, id);
      return;
    }
    if (rs.powered) autoOff(state, S, room, rs, 'approved');
  } else if (action.action === 'on') {
    if (!rs.powered) powerOn(state, S, room, rs, 'approved');
  }
}

export function setRoomOverride(state, roomId, mode) {
  const room = ROOM_BY_ID[roomId], rs = state.rooms[roomId];
  if (!room || !rs) return;
  const m = mode === 'on' || mode === 'off' ? mode : null;
  rs.override = m;
  if (m === 'on') { rs.powered = true; rs.offSince = null; }
  else if (m === 'off') { rs.powered = false; rs.offSince = state.t; }
  else rs.lastSeenT = Math.max(rs.lastSeenT, state.t);       // give auto-off a fresh 10 min
  copilot(state, 'action', 'ACT', m === 'on' ? `Manual override: ${room.name} held ON by operator`
    : m === 'off' ? `Manual override: ${room.name} switched OFF by operator`
      : `${room.name} back on automatic camera control`, roomId);
  bus.emit('room:override', { roomId, mode: m });
}

export function setCameraOnline(state, camId, online) {
  const cs = state.cameras[camId];
  const cam = CAMERA_BY_ID[camId];
  if (!cs || !cam) return;
  online = !!online;
  if (cs.online === online) return;
  cs.online = online;
  const rs = state.rooms[cam.roomId];
  const room = ROOM_BY_ID[cam.roomId];
  const name = room ? room.name : cam.roomId;
  if (!online) {
    cs.count = 0; cs.detections = [];
    if (rs) {
      rs.detected = null;
      const S = SIMS.get(state);
      if (S) endEmptySpell(S, cam.roomId);
      if (room && room.autoOff && state.scenario.hukumEnabled !== false && rs.override !== 'off' && !rs.powered && S) {
        powerOn(state, S, room, rs, 'failsafe');
      } else {
        copilot(state, 'warn', 'SEE', `${camId} offline - ${name}${room && room.autoOff ? ' power held ON (fail-safe)' : ' not monitored'}`, cam.roomId);
      }
    } else {
      copilot(state, 'warn', 'SEE', `${camId} offline - ${name} not monitored`, cam.roomId);
    }
  } else {
    if (rs) rs.lastSeenT = Math.max(rs.lastSeenT, state.t);
    copilot(state, 'info', 'SEE', `${camId} back online - ${name}${room && room.autoOff ? ' returns to automatic control' : ' monitored again'}`, cam.roomId);
  }
  bus.emit('camera:status', { id: camId, online });
}
