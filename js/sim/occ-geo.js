// Geometry helpers for the occupancy simulation on the multi-block NHCE campus:
// places (rooms, corridors, outdoor zones), doors, seat layouts and walking
// paths: room -> door -> corridor -> stairs/lift core (within a block) ->
// ground-floor entrance -> campus (grid BFS) -> another block's door.
import { FLOORS, ROOM_BY_ID, CORRIDOR, BLOCK_BY_ID, PORTALS, SITE, CAMPUS_FLOOR, COLS, ROWS, TILE, BLOCK_ENTRANCE } from '../building.js';

const COR_TOP = CORRIDOR.y + 0.6;                    // corridor edge in front of top-row doors
const COR_BOT = CORRIDOR.y + CORRIDOR.h - 0.6;       // ... bottom-row doors
const CORE_DOOR_X = 48;                              // centre of the stairs/lift core door pair
const STAIRS = { x: 47, y0: 3, y1: 8.5 };
const LIFT = { x: 50, y: 4.5 };
const ENT_X = BLOCK_ENTRANCE.x + 0.5, ENT_Y = BLOCK_ENTRANCE.y + 0.5;
const PORTAL_TRANSIT = 0.05;                         // ~3 s through a block entrance

// Corridors (and the campus open ground) as pseudo-rooms so people can target them.
export const CORRIDOR_BY_ID = Object.fromEntries(FLOORS.map((f) => [f.corridor.id, {
  ...f.corridor, type: 'corridor', floor: f.level, blockId: f.blockId, campus: !!f.isCampus,
}]));
export const PORTAL_BY_BLOCK = Object.fromEntries(PORTALS.map((p) => [p.blockId, p]));

// Corridors of block floors people actually use (not roofs, not the campus).
export const TEACHING_CORRIDORS = FLOORS.filter((f) => !f.isCampus && !f.isRoof).map((f) => f.corridor.id);
export const GROUND_CORRIDORS = FLOORS.filter((f) => !f.isCampus && f.storey === 0).map((f) => f.corridor.id);

export function placeById(id) {
  return ROOM_BY_ID[id] || CORRIDOR_BY_ID[id] || null;
}

const blockOf = (floor) => (FLOORS[floor] ? FLOORS[floor].blockId : null);
function storeyIndex(floor) {
  const b = BLOCK_BY_ID[blockOf(floor)];
  return b ? b.floors.indexOf(floor) : 0;
}

// ---------------------------------------------------------------- campus gate
const GATE = SITE.zones.find((z) => z.id === 'GATE');
const PARKING = SITE.zones.find((z) => z.id === 'PARKING');
const GATE_X0 = GATE.x + 2, GATE_X1 = GATE.x + GATE.w - 2;      // DOOR tiles on the bottom row
export function gatePoint(rng) {
  return { floor: CAMPUS_FLOOR, x: GATE_X0 + 0.3 + rng() * (GATE_X1 - GATE_X0 - 0.6), y: ROWS - 0.45, placeId: 'GATE' };
}
export function busBayPoint(rng) {
  return { floor: CAMPUS_FLOOR, x: PARKING.x + 1 + rng() * (PARKING.w - 2), y: PARKING.y + PARKING.h - 1.2 + rng() * 0.6, placeId: 'PARKING' };
}
export function carParkPoint(rng) {
  return { floor: CAMPUS_FLOOR, x: PARKING.x + 1 + rng() * (PARKING.w - 2), y: PARKING.y + 0.8 + rng() * 1.5, placeId: 'PARKING' };
}
export function gateGuardPoint() {
  return { x: GATE.x + 1.2, y: GATE.y + 1.5 };
}

// ---------------------------------------------------------------- doors / points
const DOOR_CACHE = new Map();
export function doorsOf(room) {
  let d = DOOR_CACHE.get(room.id);
  if (d) return d;
  d = [];
  for (let i = 0; i + 1 < room.doors.length; i += 2) {
    d.push({
      x: room.doors[i].x + 1,
      yIn: room.top ? room.y + room.h - 0.6 : room.y + 0.6,
      yCor: room.top ? COR_TOP : COR_BOT,
    });
  }
  DOOR_CACHE.set(room.id, d);
  return d;
}

function nearestDoor(room, x) {
  const ds = doorsOf(room);
  let best = ds[0], bd = Infinity;
  for (const d of ds) { const dd = Math.abs(d.x - x); if (dd < bd) { bd = dd; best = d; } }
  return best;
}

export function randomPoint(place, rng, m = 0.9) {
  if (place.type === 'corridor' && !place.campus) {
    return { x: 2.5 + rng() * 41.5, y: COR_TOP + 0.3 + rng() * (COR_BOT - COR_TOP - 0.6) };
  }
  return { x: place.x + m + rng() * (place.w - 2 * m), y: place.y + m + rng() * (place.h - 2 * m) };
}

// Where a teacher / speaker stands (front of the room, away from the door).
export function boardPoint(room) {
  return { x: room.x + room.w / 2, y: room.top ? room.y + 1.1 : room.y + room.h - 1.1, facing: room.top ? Math.PI / 2 : -Math.PI / 2 };
}
// A random spot on the stage band of a hall (rehearsals).
export function stagePoint(room, rng) {
  const y = room.top ? room.y + 0.7 + rng() * 1.4 : room.y + room.h - 0.7 - rng() * 1.4;
  return { x: room.x + 2 + rng() * (room.w - 4), y };
}

// Anchor for staff who stand at a counter / desk / booth.
export function anchorPoint(room) {
  if (room.type === 'library') return { x: room.x + 10.5, y: room.top ? room.y + room.h - 2.2 : room.y + 2.2 };
  if (room.type === 'canteen') return { x: room.x + room.w / 2, y: room.top ? room.y + 1.2 : room.y + room.h - 1.2 };
  if (room.type === 'gate') return gateGuardPoint();
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
}

// ---------------------------------------------------------------- seats
// Seat layouts per room type, in world tiles. Seats face the board (front wall,
// opposite the door) in teaching rooms and face their table elsewhere.
export function makeSeats(room) {
  const seats = [];
  if (!room.doors || room.outdoor) return seats;
  const front = room.top ? room.y : room.y + room.h;
  const sgn = room.top ? 1 : -1;
  const faceBoard = room.top ? -Math.PI / 2 : Math.PI / 2;
  const aisles = doorsOf(room).map((d) => d.x - room.x);
  const nearAisle = (c, gap) => aisles.some((a) => Math.abs(c - a) < gap);
  const add = (x, y, facing) => seats.push({ x, y, facing, taken: null });
  const grid = (dx, rows, gap = 0.7, x0 = 1.0) => {
    for (const r of rows) for (let c = x0; c < room.w - 0.6; c += dx) {
      if (nearAisle(c, gap)) continue;
      add(room.x + c, front + sgn * r, faceBoard);
    }
  };
  const range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-6; v += step) out.push(v); return out; };
  const tables = () => {
    for (let ty = 2.6; ty < room.h - 1.4; ty += 2.3) for (let tx = 2.0; tx < room.w - 1.4; tx += 2.8) {
      if (nearAisle(tx, 1.4)) continue;
      const cy = front + sgn * ty, cx = room.x + tx;
      add(cx - 0.6, cy - 0.55, Math.PI / 2); add(cx + 0.6, cy - 0.55, Math.PI / 2);
      add(cx - 0.6, cy + 0.55, -Math.PI / 2); add(cx + 0.6, cy + 0.55, -Math.PI / 2);
    }
  };
  switch (room.type) {
    case 'classroom': grid(0.9, range(2.4, 8.7, 1.05)); break;                 // 56 per 10 x 10 room
    case 'seminar': grid(0.9, range(2.4, 8.7, 1.05)); break;
    case 'lab': grid(1.2, range(2.6, 9.1, 1.3), 0.7, 1.2); break;              // 36 bench seats
    case 'workshop': grid(1.5, range(2.8, 8.8, 1.5), 0.8, 1.4); break;         // machine stations
    case 'auditorium': grid(0.55, range(2.9, 9.2, 0.7), 0.6, 1.4); break;      // ~700 seats facing the stage
    case 'library': case 'canteen': case 'recreation': tables(); break;
    case 'office': case 'medical': case 'security': {
      const n = Math.max(2, room.seats || 4);
      const rows = range(2.5, 8, n > 8 ? 2.6 : 3.5).slice(0, Math.ceil(n / 4));
      for (const r of rows) for (const c of [1.8, 3.6, 6.4, 8.2]) add(room.x + c, front + sgn * r, faceBoard);
      break;
    }
    default: break;
  }
  return seats;
}

// ---------------------------------------------------------------- campus BFS
const WALK = new Uint8Array(COLS * ROWS);
{
  const g = FLOORS[CAMPUS_FLOOR].grid;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) WALK[y * COLS + x] = g[y][x] !== TILE.WALL ? 1 : 0;
}
const FIELDS = new Map();            // target tile index -> Int16Array distance field
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function field(t) {
  let f = FIELDS.get(t);
  if (f) return f;
  f = new Int16Array(COLS * ROWS).fill(-1);
  const q = new Int32Array(COLS * ROWS);
  let h = 0, tl = 0;
  f[t] = 0; q[tl++] = t;
  while (h < tl) {
    const c = q[h++], cx = c % COLS, cy = (c - cx) / COLS;
    for (const [dx, dy] of NB) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = ny * COLS + nx;
      if (!WALK[n] || f[n] >= 0) continue;
      if (dx && dy && (!WALK[cy * COLS + nx] || !WALK[ny * COLS + cx])) continue;   // no corner cutting
      f[n] = f[c] + 1; q[tl++] = n;
    }
  }
  FIELDS.set(t, f);
  return f;
}

function walkAt(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS && WALK[ty * COLS + tx] === 1;
}
function los(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(d / 0.3);
  for (let i = 1; i < n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (!walkAt(x, y) || !walkAt(x + 0.25, y) || !walkAt(x - 0.25, y) || !walkAt(x, y + 0.25) || !walkAt(x, y - 0.25)) return false;
  }
  return true;
}

// Smoothed route across the campus from (x0,y0) to (x1,y1).
function campusRoute(wps, x0, y0, x1, y1) {
  const t = Math.floor(y1) * COLS + Math.floor(x1);
  const f = field(t);
  let c = Math.floor(y0) * COLS + Math.floor(x0);
  if (!(f[c] > 0)) { wps.push({ floor: CAMPUS_FLOOR, x: x1, y: y1 }); return; }
  const pts = [];
  while (c !== t) {
    const cx = c % COLS, cy = (c - cx) / COLS;
    let best = -1;
    for (const [dx, dy] of NB) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const n = ny * COLS + nx;
      if (f[n] === f[c] - 1 && f[n] >= 0) {
        if (dx && dy && (!WALK[cy * COLS + nx] || !WALK[ny * COLS + cx])) continue;
        best = n; break;
      }
    }
    if (best < 0) break;
    c = best;
    pts.push({ x: (c % COLS) + 0.5, y: Math.floor(c / COLS) + 0.5 });
  }
  pts[pts.length - 1] = { x: x1, y: y1 };
  // String-pulling: keep only the waypoints needed for line of sight.
  let px = x0, py = y0, i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !los(px, py, pts[j].x, pts[j].y)) j--;
    wps.push({ floor: CAMPUS_FLOOR, x: pts[j].x, y: pts[j].y });
    px = pts[j].x; py = pts[j].y; i = j + 1;
  }
}

// ---------------------------------------------------------------- path planning
// Waypoints from the agent's position to `goal` {floor,x,y,placeId}. Each
// waypoint is {floor,x,y}; a waypoint on another floor means "take the
// stairs/lift or walk through the block entrance", spending `transit` minutes.
export function planPath(a, goal, rng) {
  const wps = [];
  let cur = { floor: a.floor, x: a.x, y: a.y, roomId: a.roomId };
  const gBlock = blockOf(goal.floor);
  const lane = a.laneY;
  const j = (rng() - 0.5) * 0.6;
  const curF = FLOORS[cur.floor];

  if (curF && !curF.isCampus && curF.blockId !== gBlock) {
    const b = BLOCK_BY_ID[curF.blockId];
    inBlock(wps, cur, { floor: b.ground, x: ENT_X, y: ENT_Y, placeId: '@ENTRANCE' }, lane, j, rng);
    const P = PORTAL_BY_BLOCK[b.id];
    wps.push({ floor: CAMPUS_FLOOR, x: P.outsideArrive.x, y: P.outsideArrive.y, transit: PORTAL_TRANSIT });
    cur = { floor: CAMPUS_FLOOR, x: P.outsideArrive.x, y: P.outsideArrive.y, roomId: 'COR-CAMPUS' };
  }
  if (FLOORS[cur.floor].isCampus) {
    if (gBlock === 'CAMPUS') { campusRoute(wps, cur.x, cur.y, goal.x, goal.y); return wps; }
    const P = PORTAL_BY_BLOCK[gBlock];
    campusRoute(wps, cur.x, cur.y, P.outside.x + 0.5, P.outside.y + 0.5);
    wps.push({ floor: P.insideArrive.floor, x: P.insideArrive.x, y: P.insideArrive.y, transit: PORTAL_TRANSIT });
    cur = { floor: P.insideArrive.floor, x: P.insideArrive.x, y: P.insideArrive.y, roomId: FLOORS[P.insideArrive.floor].corridor.id };
  }
  inBlock(wps, cur, goal, lane, j, rng);
  return wps;
}

function inBlock(wps, cur, goal, lane, j, rng) {
  let floor = cur.floor, x = cur.x, y = cur.y;
  if (cur.roomId === goal.placeId && floor === goal.floor) { wps.push({ floor, x: goal.x, y: goal.y }); return; }
  const place = cur.roomId ? placeById(cur.roomId) : null;
  if (place && place.type !== 'corridor') {
    const d = nearestDoor(place, x);
    wps.push({ floor, x: d.x + j, y: d.yIn }, { floor, x: d.x + j, y: d.yCor });
    x = d.x + j; y = d.yCor;
  } else if (!place || place.campus) {           // in a doorway or the entrance
    if (x < CORRIDOR.x + 0.3) { x = CORRIDOR.x + 0.6; y = ENT_Y; }
    else y = y < CORRIDOR.y ? COR_TOP : COR_BOT;
    wps.push({ floor, x, y });
  }

  if (goal.floor !== floor) {
    const cx = CORE_DOOR_X + j;
    corridorWalk(wps, floor, x, y, cx, COR_TOP, lane);
    wps.push({ floor, x: cx, y: 10.4 });
    const useLift = rng() < 0.25;
    const sp = useLift ? { x: LIFT.x, y: LIFT.y } : { x: STAIRS.x + (rng() - 0.5) * 0.8, y: STAIRS.y0 + rng() * (STAIRS.y1 - STAIRS.y0) };
    const df = Math.max(1, Math.abs(storeyIndex(goal.floor) - storeyIndex(floor)));
    wps.push({ floor, x: sp.x, y: sp.y });
    wps.push({ floor: goal.floor, x: sp.x, y: sp.y, transit: useLift ? 0.5 + 0.15 * df : 0.3 * df });
    floor = goal.floor;
    wps.push({ floor, x: cx, y: 10.4 }, { floor, x: cx, y: COR_TOP });
    x = cx; y = COR_TOP;
  }

  if (goal.placeId === '@ENTRANCE') {
    corridorWalk(wps, floor, x, y, CORRIDOR.x + 0.6, ENT_Y, lane);
    wps.push({ floor, x: ENT_X, y: ENT_Y });
    return;
  }
  const gp = placeById(goal.placeId);
  if (!gp || gp.type === 'corridor') {
    corridorWalk(wps, floor, x, y, goal.x, goal.y, lane);
  } else {
    const d = nearestDoor(gp, goal.x);
    corridorWalk(wps, floor, x, y, d.x + j, d.yCor, lane);
    wps.push({ floor, x: d.x + j, y: d.yIn });
    wps.push({ floor, x: goal.x, y: goal.y });
  }
}

// Walk along the corridor using the agent's preferred lane.
function corridorWalk(wps, floor, x0, y0, x1, y1, lane) {
  const dx = x1 - x0;
  if (Math.abs(dx) < 3) { wps.push({ floor, x: x1, y: y1 }); return; }
  const s = Math.sign(dx);
  wps.push({ floor, x: x0 + s * 1.2, y: lane }, { floor, x: x1 - s * 1.2, y: lane }, { floor, x: x1, y: y1 });
}
