// Static floor art, pre-rendered once per floor into offscreen canvases:
//   base : floors, furniture, wall front faces, floor shadows
//   tops : wall top faces (drawn above people so walls occlude correctly)
//   mini : small minimap base
// Coordinates inside the draw code are tiles; the canvas transform maps
// one tile to PPT pixels with a MARGIN tile border all round.
import { FLOORS, COLS, ROWS, TILE, EQUIPMENT, PANELS } from '../building.js';
import { mulberry32 } from '../config.js';
import { drawCampusBase, drawCampusTops, groundAt, MINI_GROUND, CAMPUS_EXTRA_ROWS } from './campus.js';

export const PPT = 36;          // offscreen pixels per tile
export const MARGIN = 1;        // tiles of border around the floor
export const WALL_H = 0.42;     // wall extrusion height in tiles (2.5D)
export const MINI_PPT = 4;      // minimap css px per tile

const cache = new Map();

// Seat positions from the occupancy model, so desks sit exactly where people
// sit. Loaded lazily and guarded: without it the fixed layouts are used.
let seatsFn = null;
import('../sim/occupancy.js')
  .then((m) => { if (typeof m.getSeats === 'function') { seatsFn = m.getSeats; cache.clear(); } })
  .catch(() => {});
function seatsFor(id) {
  if (!seatsFn) return null;
  try { const s = seatsFn(id); return Array.isArray(s) && s.length ? s : null; } catch { return null; }
}
const SEATED_TYPES = new Set(['classroom', 'lab', 'seminar', 'library', 'canteen', 'office', 'workshop', 'auditorium', 'medical', 'security', 'recreation']);
// Lab flavour from the room name (ids are free-form on the NHCE campus).
const labKind = (r) => /chem/i.test(r.name) ? 'chem' : /comput|programm|system|gpu|mca|ise lab|cad|ai & ml/i.test(r.name) ? 'computer'
  : /ece|electron|micro|analog|idea|skill/i.test(r.name) ? 'electronics' : 'bench';
if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
  // Rebuild once the web fonts are in so stencilled text uses Inter.
  document.fonts.ready.then(() => cache.clear()).catch(() => {});
}

export function getFloorArt(level, dpr = 1) {
  const key = `${level}`;
  let a = cache.get(key);
  if (!a) {
    const floor = FLOORS[level];
    const extra = floor.isCampus ? CAMPUS_EXTRA_ROWS : 0;
    // Tile bounds the art covers (camera clamps to these).
    a = { base: buildBase(floor), tops: buildTops(floor), mini: null, miniDpr: 0,
      x0: -MARGIN, y0: -MARGIN, x1: COLS + MARGIN, y1: ROWS + MARGIN + extra };
    cache.set(key, a);
  }
  if (!a.mini || a.miniDpr !== dpr) { a.mini = buildMini(FLOORS[level], dpr); a.miniDpr = dpr; }
  return a;
}

// ---------------------------------------------------------------- palette
export const FLOOR_COL = {
  classroom: ['#252d3a', '#2a3341'],
  lab: ['#212d36', '#26343e'],
  seminar: ['#28243a', '#2d2940'],
  library: ['#2b251f', '#312a23'],
  office: ['#252b36', '#2a313d'],
  lobby: ['#2a2f37', '#323843'],
  canteen: ['#272a27', '#30342f'],
  server: ['#1b232d', '#222b37'],
  electrical: ['#23262b', '#292d33'],
  parking: ['#1e2124', '#24282c'],
  core: ['#262b34', '#2c323c'],
  plant: ['#23272b', '#2a2f34'],
  roof: ['#24272b', '#2b2f34'],
  corridor: ['#1d2430', '#232b37'],
  workshop: ['#22262a', '#282d32'],
  auditorium: ['#2a2030', '#302536'],
  medical: ['#26303a', '#2c3742'],
  security: ['#1c232d', '#222a35'],
  gym: ['#232a2a', '#293131'],
  recreation: ['#272535', '#2d2b3c'],
  gate: ['#353a42', '#3a3f47'], sports: ['#244a2c', '#2b5a33'],
};
const WALL_TOP = '#3a4659';
const WALL_TOP_OUT = '#334055';
const WALL_EDGE = '#55657d';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}

function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const PX = 1 / PPT;

function box(g, x, y, w, h, fill, r = 0.06, sh = 0.09, edge = 'rgba(255,255,255,0.09)') {
  if (sh > 0) { g.fillStyle = 'rgba(0,0,0,0.38)'; rr(g, x + sh * 0.6, y + sh, w, h, r); g.fill(); }
  g.fillStyle = fill; rr(g, x, y, w, h, r); g.fill();
  if (edge) { g.strokeStyle = edge; g.lineWidth = PX; g.stroke(); }
}

function circ(g, x, y, r, fill, sh = 0.07, edge = 'rgba(255,255,255,0.08)') {
  if (sh > 0) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(x + sh * 0.6, y + sh, r, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  if (edge) { g.strokeStyle = edge; g.lineWidth = PX; g.stroke(); }
}

// Text drawn in pixel space so tiny font sizes stay crisp.
function text(g, str, x, y, sizeT, color, { weight = 600, align = 'left', mono = false, base = 'alphabetic' } = {}) {
  g.save();
  g.setTransform(1, 0, 0, 1, (MARGIN + x) * PPT, (MARGIN + y) * PPT);
  g.font = `${weight} ${Math.round(sizeT * PPT)}px ${mono ? "'JetBrains Mono', ui-monospace, monospace" : "Inter, system-ui, sans-serif"}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
  g.fillText(str, 0, 0);
  g.restore();
}

function isWall(floor, x, y) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  return floor.grid[y][x] === TILE.WALL;
}

// ---------------------------------------------------------------- base
const KIT = { get PX() { return PX; }, rr, box, circ, text, speckle: (g, r, rnd, n, a) => speckle(g, r, rnd, n, a), pvBlock: (...a) => pvBlock(...a) };

function buildBase(floor) {
  const extra = floor.isCampus ? CAMPUS_EXTRA_ROWS : 0;
  const cv = makeCanvas((COLS + 2 * MARGIN) * PPT, (ROWS + 2 * MARGIN + extra) * PPT);
  const g = cv.getContext('2d');
  g.setTransform(PPT, 0, 0, PPT, MARGIN * PPT, MARGIN * PPT);
  const rnd = mulberry32(911 + floor.level * 131);
  if (floor.isCampus) { drawCampusBase(g, KIT); return cv; }

  // Building footprint drop shadow on the ground.
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0.35, 0.6, COLS, ROWS);

  // Under-wall fill (mostly hidden by wall faces).
  g.fillStyle = '#121820';
  g.fillRect(0, 0, COLS, ROWS);

  // Corridor
  const c = floor.corridor;
  floorFill(g, c, floor.isRoof ? 'roof' : 'corridor', rnd);
  if (!floor.isRoof) {
    g.fillStyle = 'rgba(255,255,255,0.025)';
    g.fillRect(c.x, c.y + 1.6, c.w, c.h - 3.2);
    g.strokeStyle = 'rgba(245,179,1,0.12)'; g.lineWidth = 2 * PX;
    g.setLineDash([0.6, 0.6]);
    g.beginPath(); g.moveTo(c.x + 0.5, c.y + c.h / 2); g.lineTo(c.x + c.w - 0.5, c.y + c.h / 2); g.stroke();
    g.setLineDash([]);
  } else {
    // Roof walkway: anti-slip strip.
    g.fillStyle = 'rgba(245,179,1,0.06)';
    g.fillRect(c.x, c.y + 1.7, c.w, c.h - 3.4);
  }

  // Rooms
  for (const r of floor.rooms) floorFill(g, r, r.type, rnd);

  // Doors: threshold strips in the wall line.
  for (const r of floor.rooms) {
    for (const d of r.doors) {
      g.fillStyle = FLOOR_COL.corridor[1];
      g.fillRect(d.x, d.y, 1, 1);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(d.x, d.y + 0.44, 1, 0.12);
    }
  }

  // Soft floor shadows cast by walls (light from top-left).
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!isWall(floor, x, y)) continue;
      if (y + 1 < ROWS && !isWall(floor, x, y + 1)) {
        const gr = g.createLinearGradient(0, y + 1, 0, y + 1.45);
        gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x, y + 1, 1, 0.45);
      }
      if (x + 1 < COLS && !isWall(floor, x + 1, y)) {
        const gr = g.createLinearGradient(x + 1, 0, x + 1.25, 0);
        gr.addColorStop(0, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + 1, y, 0.25, 1);
      }
    }
  }

  // Furniture and fittings.
  for (const r of floor.rooms) furnish(g, r, floor, rnd);
  corridorDecor(g, floor);
  equipmentBases(g, floor);
  panelCabinets(g, floor);

  // Wall front (south) faces.
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!isWall(floor, x, y)) continue;
      if (y + 1 >= ROWS || !isWall(floor, x, y + 1)) {
        const y0 = y + 1 - WALL_H;
        const gr = g.createLinearGradient(0, y0, 0, y + 1);
        gr.addColorStop(0, '#2a3445'); gr.addColorStop(1, '#161c26');
        g.fillStyle = gr; g.fillRect(x, y0, 1, WALL_H);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y + 1 - 0.05, 1, 0.05);
        const outer = y === ROWS - 1;
        if (outer && !floor.isRoof) {
          // Exterior glazing on the south facade.
          g.fillStyle = 'rgba(105,177,255,0.18)';
          g.fillRect(x + 0.08, y0 + 0.07, 0.84, WALL_H * 0.5);
        }
      }
    }
  }
  return cv;
}

function floorFill(g, r, type, rnd) {
  const [a, b] = FLOOR_COL[type] || FLOOR_COL.office;
  g.fillStyle = a; g.fillRect(r.x, r.y, r.w, r.h);
  const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  g.save();
  g.beginPath(); g.rect(x0, y0, r.w, r.h); g.clip();
  switch (type) {
    case 'classroom': case 'office': case 'core': case 'corridor': case 'lab': {
      const s = type === 'lab' ? 0.5 : 1;
      g.fillStyle = b;
      for (let y = y0; y < y1; y += s) for (let x = x0; x < x1; x += s) {
        if (((Math.round((x - x0) / s) + Math.round((y - y0) / s)) & 1) === 0) g.fillRect(x, y, s, s);
      }
      g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = PX;
      g.beginPath();
      for (let x = x0; x <= x1; x += s) { g.moveTo(x, y0); g.lineTo(x, y1); }
      for (let y = y0; y <= y1; y += s) { g.moveTo(x0, y); g.lineTo(x1, y); }
      g.stroke();
      break;
    }
    case 'lobby': {
      g.fillStyle = b;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if ((((x - x0) / 2 + (y - y0) / 2) & 1) === 0) g.fillRect(x, y, 2, 2);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = PX;
      g.beginPath();
      for (let x = x0; x <= x1; x += 2) { g.moveTo(x, y0); g.lineTo(x, y1); }
      for (let y = y0; y <= y1; y += 2) { g.moveTo(x0, y); g.lineTo(x1, y); }
      g.stroke();
      // Marble veins
      g.strokeStyle = 'rgba(255,255,255,0.035)';
      for (let i = 0; i < 14; i++) {
        g.beginPath();
        let x = x0 + rnd() * r.w, y = y0 + rnd() * r.h;
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) { x += (rnd() - 0.3) * 1.6; y += (rnd() - 0.5) * 1.2; g.lineTo(x, y); }
        g.stroke();
      }
      break;
    }
    case 'library': {
      for (let y = y0; y < y1; y += 0.25) {
        let x = x0 - rnd() * 2;
        while (x < x1) {
          const len = 1.2 + rnd() * 1.6;
          const v = rnd();
          g.fillStyle = v < 0.5 ? a : b;
          g.fillRect(x, y, len, 0.25);
          g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y, PX, 0.25);
          x += len;
        }
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0, y, r.w, PX);
      }
      break;
    }
    case 'seminar': speckle(g, r, rnd, 18, 0.05); break;
    case 'canteen': {
      g.fillStyle = b;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (((x - x0 + y - y0) & 1) === 0) g.fillRect(x, y, 1, 1);
      break;
    }
    case 'server': {
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = PX;
      g.beginPath();
      for (let x = x0; x <= x1; x += 0.6) { g.moveTo(x, y0); g.lineTo(x, y1); }
      for (let y = y0; y <= y1; y += 0.6) { g.moveTo(x0, y); g.lineTo(x1, y); }
      g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.3)';
      for (let y = y0 + 0.15; y < y1; y += 0.6) for (let x = x0 + 0.15; x < x1; x += 0.6) {
        if (rnd() < 0.3) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g.fillRect(x + i * 0.11, y + j * 0.11, 0.05, 0.05);
      }
      break;
    }
    case 'electrical': case 'plant': case 'parking': speckle(g, r, rnd, 22, 0.06); break;
    case 'roof': speckle(g, r, rnd, 40, 0.07); break;
    default: break;
  }
  g.restore();
}

function speckle(g, r, rnd, perTile, alpha) {
  const n = Math.floor(r.w * r.h * perTile);
  for (let i = 0; i < n; i++) {
    const light = rnd() < 0.5;
    g.fillStyle = light ? `rgba(255,255,255,${alpha * rnd()})` : `rgba(0,0,0,${alpha * 1.6 * rnd()})`;
    const s = (1 + rnd() * 2) * PX;
    g.fillRect(r.x + rnd() * r.w, r.y + rnd() * r.h, s, s);
  }
}

// Local frame per room: lx along x from the left wall, ly measured from the
// FAR wall (away from the door), so top and bottom rooms mirror correctly.
function frame(r) {
  return {
    X: (lx) => r.x + lx,
    Y: (ly, h = 0) => (r.top ? r.y + ly : r.y + r.h - ly - h),
  };
}

const DESK = '#3b4657', DESK_2 = '#465265', CHAIR = '#1a212c', CHAIR_2 = '#2e3a4c';

function furnish(g, r, floor, rnd) {
  const { X, Y } = frame(r);
  const B = (lx, ly, w, h, fill, rad, sh, edge) => box(g, X(lx), Y(ly, h), w, h, fill, rad, sh, edge);
  const C = (lx, ly, rad, fill, sh, edge) => circ(g, X(lx), Y(ly), rad, fill, sh, edge);

  const seats = SEATED_TYPES.has(r.type) ? seatsFor(r.id) : null;
  if (seats) { furnishFromSeats(g, r, seats, B, C, rnd); return; }

  switch (r.type) {
    case 'classroom': {
      B(2, 0.02, 6, 0.16, '#c9d3df', 0.02, 0.04, null);                // whiteboard
      B(8.4, 0.02, 1.2, 0.12, '#5b6b80', 0.02, 0.03, null);            // notice board
      B(3.9, 0.95, 2.2, 0.7, '#4a4038', 0.06);                          // teacher desk
      C(5.0, 0.55, 0.2, CHAIR_2);
      B(9.0, 1.4, 0.75, 1.3, '#323c4b', 0.04);                          // cabinet
      const cols = [0.7, 2.9, 5.5, 7.7];
      for (let i = 0; i < 5; i++) {
        const ly = 2.5 + i * 1.45;
        for (const lx of cols) {
          B(lx, ly, 1.6, 0.52, DESK, 0.05, 0.08);
          B(lx + 0.18, ly + 0.66, 0.42, 0.38, CHAIR, 0.1, 0.05, 'rgba(255,255,255,0.05)');
          B(lx + 1.0, ly + 0.66, 0.42, 0.38, CHAIR, 0.1, 0.05, 'rgba(255,255,255,0.05)');
        }
      }
      break;
    }
    case 'lab': {
      if (labKind(r) === 'computer') {                                  // computer lab
        B(2.5, 0.02, 5, 0.14, '#c9d3df', 0.02, 0.04, null);
        for (let i = 0; i < 5; i++) {
          const ly = 1.4 + i * 1.65;
          for (const [lx, w] of [[0.5, 4.2], [5.3, 4.2]]) {
            B(lx, ly, w, 0.62, DESK_2, 0.04);
            for (let k = 0; k < 4; k++) {
              const mx = lx + 0.25 + k * 1.02;
              B(mx, ly + 0.06, 0.6, 0.12, '#0c131c', 0.02, 0.03, null);
              g.fillStyle = 'rgba(64,169,255,0.55)'; g.fillRect(X(mx + 0.05), Y(ly + 0.09, 0.05), 0.5, 0.05);
              B(mx + 0.1, ly + 0.76, 0.4, 0.36, CHAIR, 0.1, 0.05);
            }
          }
        }
      } else {
        const chem = labKind(r) === 'chem';
        if (chem) for (let k = 0; k < 3; k++) B(1 + k * 3, 0.02, 2.4, 0.75, '#3a4652', 0.04);   // fume hoods
        else B(2, 0.02, 6, 0.16, '#c9d3df', 0.02, 0.04, null);
        for (let i = 0; i < 3; i++) {
          const ly = 2.0 + i * 2.6;
          B(0.8, ly, 8.4, 1.0, '#3a4651', 0.05);
          g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(X(0.8), Y(ly + 0.48, 0.04), 8.4, 0.04);
          for (let k = 0; k < 4; k++) {
            const bx = 1.3 + k * 2.1;
            if (chem) { B(bx, ly + 0.25, 0.5, 0.5, '#596a7c', 0.08, 0.02); C(bx + 0.25, ly + 0.5, 0.12, '#1d2732', 0, null); }
            else if (labKind(r) === 'electronics') { B(bx, ly + 0.15, 0.7, 0.42, '#202a35', 0.04, 0.03); g.fillStyle = 'rgba(82,196,26,0.6)'; g.fillRect(X(bx + 0.08), Y(ly + 0.22, 0.2), 0.32, 0.2); }
            else { B(bx, ly + 0.2, 0.6, 0.5, '#4d5a6b', 0.04, 0.03); }
          }
          for (let k = 0; k < 7; k++) { C(1.2 + k * 1.25, ly - 0.35, 0.18, CHAIR); C(1.2 + k * 1.25, ly + 1.35, 0.18, CHAIR); }
        }
      }
      break;
    }
    case 'library': {
      for (let i = 0; i < 4; i++) {
        const ly = 0.35 + i * 1.75;
        B(0.6, ly, 9.0, 0.55, '#3b2f25', 0.03, 0.1);
        let x = 0.66;
        while (x < 9.5) {
          const w = 0.07 + rnd() * 0.06;
          const cols = ['#7a4b3a', '#3f5e7a', '#6b6a3a', '#4a6b55', '#7a6a5a', '#5a4a7a', '#8a5a3a'];
          g.fillStyle = cols[Math.floor(rnd() * cols.length)];
          g.fillRect(X(x), Y(ly + 0.06, 0.43), w, 0.43);
          x += w + 0.015;
        }
      }
      for (let rI = 0; rI < 3; rI++) for (let cI = 0; cI < 3; cI++) {
        const lx = 11.2 + cI * 3.2, ly = 0.8 + rI * 2.6;
        B(lx, ly, 2.2, 1.1, '#4a3c30', 0.08);
        for (let k = 0; k < 3; k++) { C(lx + 0.4 + k * 0.7, ly - 0.25, 0.17, CHAIR); C(lx + 0.4 + k * 0.7, ly + 1.35, 0.17, CHAIR); }
        circ(g, X(lx + 1.1), Y(ly + 0.55), 0.12, 'rgba(255,214,102,0.25)', 0, null);
      }
      B(6.2, 8.0, 3.2, 0.75, '#4b3d31', 0.2);                           // circulation desk
      C(7.8, 7.55, 0.2, CHAIR_2);
      B(17.5, 8.6, 2.6, 0.7, '#3d4a5d', 0.25);                          // sofa
      break;
    }
    case 'seminar': {
      B(0.5, 0.0, 20, 1.7, '#352d42', 0.05, 0.05);                      // stage
      B(4.5, 0.02, 12, 0.12, '#d8e0ea', 0.02, 0.02, null);             // screen
      B(9.9, 0.9, 1.2, 0.55, '#5a4a3a', 0.06);                          // podium
      for (let i = 0; i < 6; i++) {
        const base = 2.6 + i * 1.12;
        for (let lx = 0.8; lx < 20.2; lx += 0.58) {
          if ((lx > 6.4 && lx < 7.6) || (lx > 13.4 && lx < 14.6)) continue;
          const curve = -Math.pow((lx - 10.5) / 10.5, 2) * 0.55;
          B(lx, base + curve, 0.44, 0.42, '#4a3b5c', 0.1, 0.04, 'rgba(255,255,255,0.06)');
        }
      }
      break;
    }
    case 'office': {
      const staff = /staff|faculty|department/i.test(r.name);
      for (const ox of [0.8, 5.4]) {
        for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) {
          const lx = ox + k * 1.75, ly = 1.0 + j * 0.85;
          B(lx, ly, 1.65, 0.8, DESK_2, 0.04);
          B(lx + 0.5, ly + (j ? 0.55 : 0.1), 0.6, 0.12, '#0c131c', 0.02, 0.03, null);
        }
        C(ox + 0.9, 0.6, 0.2, CHAIR); C(ox + 2.6, 0.6, 0.2, CHAIR);
        C(ox + 0.9, 3.0, 0.2, CHAIR); C(ox + 2.6, 3.0, 0.2, CHAIR);
      }
      // Meeting table
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(X(3.55), Y(6.05), 2.0, 0.75, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4a3c30'; g.beginPath(); g.ellipse(X(3.5), Y(6.0), 2.0, 0.75, 0, 0, Math.PI * 2); g.fill();
      for (let k = 0; k < 4; k++) { C(2.0 + k * 1.0, 4.95, 0.18, CHAIR); C(2.0 + k * 1.0, 7.05, 0.18, CHAIR); }
      for (let k = 0; k < 4; k++) B(9.15, 4.0 + k * 1.0, 0.65, 0.9, staff ? '#3a4a5c' : '#384252', 0.03, 0.05);
      if (staff) B(6.6, 8.5, 2.2, 0.7, '#3d4a5d', 0.25);               // sofa
      C(0.6, 9.2, 0.35, '#2f5a3a'); C(9.3, 0.6, 0.35, '#2f5a3a');       // plants
      break;
    }
    case 'lobby': {
      g.strokeStyle = 'rgba(245,179,1,0.18)'; g.lineWidth = 2 * PX;
      g.beginPath(); g.arc(X(5), Y(5.2), 2.1, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(X(5), Y(5.2), 1.6, 0, Math.PI * 2); g.stroke();
      text(g, 'NHCE', X(5), Y(5.2) + 0.25, 0.75, 'rgba(245,179,1,0.24)', { align: 'center', weight: 700 });
      B(3.0, 0.02, 4, 0.5, '#2b3a4d', 0.04, 0.03, null);                 // entrance mat
      g.strokeStyle = 'rgba(105,177,255,0.35)'; g.lineWidth = 3 * PX;    // glass doors in the facade
      g.beginPath(); g.moveTo(X(3.2), r.y - 0.05); g.lineTo(X(6.8), r.y - 0.05); g.stroke();
      // Reception
      g.fillStyle = 'rgba(0,0,0,0.38)'; g.beginPath(); g.arc(X(8.0) + 0.06, Y(7.6) + 0.09, 1.5, Math.PI * 0.95, Math.PI * 1.55); g.lineTo(X(8.0) + 0.06, Y(7.6) + 0.09); g.fill();
      g.strokeStyle = '#4a5466'; g.lineWidth = 0.45; g.lineCap = 'round';
      g.beginPath(); g.arc(X(8.6), Y(8.4), 1.6, Math.PI * 1.0, Math.PI * 1.5); g.stroke(); g.lineCap = 'butt';
      C(8.4, 8.6, 0.2, CHAIR_2);
      B(0.6, 3.2, 0.75, 2.6, '#3d4a5d', 0.2); B(0.6, 6.4, 0.75, 2.0, '#3d4a5d', 0.2);   // sofas
      B(1.7, 4.4, 0.8, 0.8, '#4a3c30', 0.1);
      C(0.6, 0.7, 0.38, '#2f5a3a'); C(9.3, 0.7, 0.38, '#2f5a3a'); C(0.6, 9.3, 0.38, '#2f5a3a');
      B(8.7, 2.2, 1.0, 1.8, '#1d2a3a', 0.04);                            // directory board
      g.fillStyle = 'rgba(105,177,255,0.35)'; g.fillRect(X(8.8), Y(2.35, 1.5), 0.8, 1.5);
      break;
    }
    case 'canteen': {
      B(1.0, 0.02, 8, 1.0, '#4a4d52', 0.05);                             // serving counter
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(X(1.3 + k * 1.3), Y(0.25, 0.5), 0.9, 0.5); }
      for (let rI = 0; rI < 3; rI++) for (let cI = 0; cI < 3; cI++) {
        const lx = 1.9 + cI * 3.1, ly = 2.7 + rI * 2.5;
        circ(g, X(lx), Y(ly), 0.6, '#4a4038');
        for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2 + Math.PI / 4;
          circ(g, X(lx) + Math.cos(a) * 0.9, Y(ly) + Math.sin(a) * 0.9, 0.2, CHAIR, 0.04);
        }
      }
      break;
    }
    case 'electrical': {
      if (r.id === 'MB-ELEC') {
        // Battery racks around BAT-1
        for (let k = 0; k < 4; k++) {
          box(g, 16.4 + k * 1.05, 22.4, 0.9, 3.2, '#22332b', 0.04, 0.1);
          g.strokeStyle = 'rgba(149,222,100,0.18)'; g.lineWidth = PX;
          for (let j = 0; j < 8; j++) { g.beginPath(); g.moveTo(16.5 + k * 1.05, 22.6 + j * 0.37); g.lineTo(17.2 + k * 1.05, 22.6 + j * 0.37); g.stroke(); }
        }
        // Transformer with hazard boundary
        hazard(g, 12.3, 24.0, 3.3, 3.6);
        box(g, 12.7, 24.4, 2.5, 2.8, '#3a4048', 0.05, 0.12);
        for (let j = 0; j < 6; j++) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(12.85, 24.6 + j * 0.42, 2.2, 0.16); }
        text(g, 'LT TRANSFORMER', 13.95, 27.55, 0.26, 'rgba(250,173,20,0.6)', { align: 'center', mono: true });
        text(g, 'BATTERY 400 kWh', 18.5, 26.15, 0.26, 'rgba(149,222,100,0.55)', { align: 'center', mono: true });
      } else {
        // Riser: cable trays and hatch
        g.fillStyle = '#1b2129'; g.fillRect(r.x + 0.3, r.y + 1.0, 0.45, r.h - 1.5);
        g.strokeStyle = 'rgba(250,173,20,0.25)'; g.lineWidth = PX;
        for (let y = r.y + 1.1; y < r.y + r.h - 0.5; y += 0.3) { g.beginPath(); g.moveTo(r.x + 0.3, y); g.lineTo(r.x + 0.75, y); g.stroke(); }
        box(g, r.x + 1.6, r.y + 5.0, 2.6, 2.6, '#2a3038', 0.04, 0.05);
        g.strokeStyle = 'rgba(255,255,255,0.08)';
        g.beginPath(); g.moveTo(r.x + 1.6, r.y + 5.0); g.lineTo(r.x + 4.2, r.y + 7.6); g.moveTo(r.x + 4.2, r.y + 5.0); g.lineTo(r.x + 1.6, r.y + 7.6); g.stroke();
        text(g, 'RISER SHAFT', r.x + 2.9, r.y + 8.2, 0.26, 'rgba(138,155,176,0.6)', { align: 'center', mono: true });
      }
      break;
    }
    case 'server': {
      for (let row = 0; row < 3; row++) {
        const y = r.y + 1.6 + row * 2.7;
        for (let k = 0; k < 7; k++) {
          const x = r.x + 1.0 + k * 0.82;
          box(g, x, y, 0.74, 1.05, '#121820', 0.03, 0.1, 'rgba(105,177,255,0.18)');
          for (let j = 0; j < 4; j++) {
            g.fillStyle = rnd() < 0.7 ? 'rgba(82,196,26,0.8)' : 'rgba(64,169,255,0.8)';
            g.fillRect(x + 0.1 + rnd() * 0.5, y + 0.15 + j * 0.22, 0.05, 0.05);
          }
        }
        g.fillStyle = 'rgba(105,177,255,0.05)'; g.fillRect(r.x + 1.0, y + 1.1, 5.7, 0.5);
      }
      box(g, r.x + 7.9, r.y + 1.2, 1.6, 2.4, '#2c3644', 0.05);               // CRAC unit
      circ(g, r.x + 8.7, r.y + 2.0, 0.45, '#1b222b', 0, 'rgba(255,255,255,0.1)');
      circ(g, r.x + 8.7, r.y + 3.0, 0.3, '#1b222b', 0, 'rgba(255,255,255,0.1)');
      text(g, 'CRAC', r.x + 8.7, r.y + 4.1, 0.26, 'rgba(138,155,176,0.6)', { align: 'center', mono: true });
      break;
    }
    case 'parking': {
      g.strokeStyle = 'rgba(230,237,245,0.28)'; g.lineWidth = 2 * PX;
      const bays = [[34.5, 19.4, 3, 3.4], [37.5, 19.4, 3, 3.4], [40.5, 19.4, 3, 3.4], [34.5, 22.6, 3, 4.0], [37.5, 22.6, 3, 4.0], [40.5, 22.6, 3, 4.0]];
      for (const [x, y, w, h] of bays) g.strokeRect(x, y, w, h);
      text(g, 'EV', 36, 22.7, 0.4, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700 });
      text(g, 'EV', 39, 22.7, 0.4, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700 });
      text(g, 'EV', 42, 22.7, 0.4, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700 });
      text(g, 'EV', 36, 23.3, 0.4, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700, base: 'top' });
      text(g, 'E-BUS', 39.25, 23.3, 0.36, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700, base: 'top' });
      text(g, 'E-BUS', 42.25, 23.3, 0.36, 'rgba(92,219,211,0.25)', { align: 'center', weight: 700, base: 'top' });
      // Driving aisle arrow to the ramp
      g.fillStyle = 'rgba(230,237,245,0.12)';
      g.beginPath(); g.moveTo(43.4, 26.9); g.lineTo(43.4, 27.8); g.lineTo(43.9, 27.35); g.fill();
      break;
    }
    case 'core': {
      const s = floor.stairs;
      g.fillStyle = '#20252d'; g.fillRect(s.x, s.y, s.w, s.h);
      g.strokeStyle = 'rgba(230,237,245,0.18)'; g.lineWidth = PX * 1.5;
      for (let y = s.y + 0.35; y < s.y + s.h; y += 0.35) {
        if (y > s.y + s.h / 2 - 0.4 && y < s.y + s.h / 2 + 0.4) continue;      // landing
        g.beginPath(); g.moveTo(s.x + 0.08, y); g.lineTo(s.x + s.w - 0.08, y); g.stroke();
      }
      g.fillStyle = '#4a5466'; g.fillRect(s.x + s.w / 2 - 0.04, s.y, 0.08, s.h);  // balustrade
      g.fillStyle = 'rgba(245,179,1,0.5)';
      arrow(g, s.x + 0.5, s.y + s.h * 0.78, s.y + s.h * 0.58);
      arrow(g, s.x + 1.5, s.y + s.h * 0.22, s.y + s.h * 0.42);
      text(g, 'UP', s.x + 0.5, s.y + s.h * 0.9, 0.3, 'rgba(245,179,1,0.6)', { align: 'center', mono: true });
      text(g, 'DN', s.x + 1.5, s.y + s.h * 0.15, 0.3, 'rgba(245,179,1,0.6)', { align: 'center', mono: true });
      const L = floor.lift;
      box(g, L.x + 0.1, L.y + 0.1, L.w - 0.2, L.h - 0.2, '#2f3744', 0.04, 0.06, 'rgba(255,255,255,0.15)');
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = PX;
      for (let x = L.x + 0.3; x < L.x + L.w - 0.2; x += 0.25) { g.beginPath(); g.moveTo(x, L.y + 0.2); g.lineTo(x, L.y + L.h - 0.2); g.stroke(); }
      g.fillStyle = '#8a9bb0'; g.fillRect(L.x + 0.05, L.y + 0.4, 0.08, L.h - 0.8);  // lift doors
      text(g, 'LIFT', L.x + L.w / 2, L.y + L.h / 2 + 0.14, 0.38, 'rgba(230,237,245,0.55)', { align: 'center', weight: 700 });
      text(g, `${floor.short}  ${(floor.floorName || '').toUpperCase()}`, r.x + r.w / 2, r.y + r.h - 0.5, 0.3, 'rgba(245,179,1,0.45)', { align: 'center', mono: true });
      break;
    }
    case 'gym': {
      for (let k = 0; k < 6; k++) B(1 + k * 3.2, 0.5, 1.0, 2.0, '#2a3038', 0.15, 0.08);   // treadmills
      for (let k = 0; k < 5; k++) { C(2 + k * 3.8, 5.0, 0.45, '#3a414b'); B(1.4 + k * 3.8, 4.95, 1.2, 0.1, '#8a95a5', 0.02, 0); }
      B(1, 7.4, r.w - 2, 2.0, '#1f3b2a', 0.1, 0.03);                    // mats / indoor court
      break;
    }
    case 'workshop': {
      for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) B(0.8 + k * 2.3 * (r.w / 10), 2.0 + i * 2.6, 1.4, 1.1, '#4b525c', 0.06, 0.12);
      break;
    }
    case 'auditorium': case 'medical': case 'security': case 'recreation': {
      furnishFromSeats(g, r, [], B, C, rnd);
      break;
    }
    case 'roof': {
      const rows = r.top ? [0.5, 2.6, 4.7, 6.8] : [0.6, 2.7, 4.8, 6.9];
      for (const oy of rows) {
        for (let x = r.x + 0.6; x < r.x + r.w - 0.6; x += 5.4) {
          const w = Math.min(4.8, r.x + r.w - 0.4 - x);
          if (w < 1) continue;
          pvBlock(g, x, r.y + oy, w, 1.4);
        }
      }
      break;
    }
    case 'plant': {
      if (/PUMP/.test(r.id)) {
        for (const [tx, ty] of [[3.5, 25.4], [8, 25.4]]) {
          circ(g, tx, ty, 1.25, '#2d4256', 0.12);
          g.strokeStyle = 'rgba(105,177,255,0.25)'; g.lineWidth = PX * 1.5;
          g.beginPath(); g.arc(tx, ty, 0.95, 0, Math.PI * 2); g.stroke();
          text(g, '50 kL', tx, ty + 0.12, 0.32, 'rgba(230,237,245,0.5)', { align: 'center', mono: true });
        }
        g.strokeStyle = '#4a5a6c'; g.lineWidth = 0.14;
        g.beginPath(); g.moveTo(4, 22.6); g.lineTo(4, 24.2); g.moveTo(8, 22.6); g.lineTo(8, 24.2);
        g.moveTo(1.5, 20.2); g.lineTo(10, 20.2); g.moveTo(4, 21.4); g.lineTo(4, 20.2); g.moveTo(8, 21.4); g.lineTo(8, 20.2); g.stroke();
        for (const px of [4, 8]) box(g, px - 0.75, 21.5, 1.5, 1.0, '#2f3946', 0.06, 0.08);
      } else {
        box(g, 14.0, 19.8, 6.2, 4.4, '#353e4b', 0.08, 0.15);
        for (const fx of [15.6, 18.6]) {
          circ(g, fx, 22.0, 1.15, '#1b222b', 0, 'rgba(255,255,255,0.14)');
          g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = PX;
          for (let k = 0.3; k < 1.15; k += 0.22) { g.beginPath(); g.arc(fx, 22.0, k, 0, Math.PI * 2); g.stroke(); }
        }
        for (let k = 0; k < 3; k++) box(g, 12.5 + k * 1.6, 25.2, 1.4, 1.9, '#2e3642', 0.05, 0.1);
        text(g, 'CHILLERS', 14.9, 27.6, 0.28, 'rgba(138,155,176,0.6)', { align: 'center', mono: true });
        g.strokeStyle = '#4a5a6c'; g.lineWidth = 0.16;
        g.beginPath(); g.moveTo(17, 24.2); g.lineTo(17, 25.0); g.lineTo(13.2, 25.0); g.stroke();
      }
      break;
    }
    default: break;
  }
}

// Room decor plus one chair per seat and a desk/table in front of it.
// Adjacent desks merge into rows (classrooms) or tables (library, canteen).
function furnishFromSeats(g, r, seats, B, C, rnd) {
  const lab3 = r.type === 'lab' && labKind(r) === 'computer';
  switch (r.type) {
    case 'classroom':
      B(2, 0.02, 6, 0.16, '#c9d3df', 0.02, 0.04, null);
      B(8.4, 0.02, 1.2, 0.12, '#5b6b80', 0.02, 0.03, null);
      B(3.9, 0.85, 2.2, 0.65, '#4a4038', 0.06);
      C(5.0, 0.45, 0.2, CHAIR_2);
      B(0.3, 0.3, 1.2, 0.55, '#323c4b', 0.04);
      break;
    case 'lab':
      if (labKind(r) === 'chem') for (let k = 0; k < 3; k++) B(1 + k * 3, 0.02, 2.4, 0.75, '#3a4652', 0.04);
      else B(2, 0.02, 6, 0.16, '#c9d3df', 0.02, 0.04, null);
      B(3.9, 1.0, 2.2, 0.6, '#3a4651', 0.05);
      break;
    case 'seminar':
      B(0.5, 0.0, 20, 1.7, '#352d42', 0.05, 0.05);
      B(4.5, 0.02, 12, 0.12, '#d8e0ea', 0.02, 0.02, null);
      B(9.9, 0.9, 1.2, 0.55, '#5a4a3a', 0.06);
      break;
    case 'library':
      for (const ly of [0.3, 1.25]) {
        B(0.6, ly, r.w - 1.2, 0.5, '#3b2f25', 0.03, 0.1);
        let x = 0.66;
        const cols = ['#7a4b3a', '#3f5e7a', '#6b6a3a', '#4a6b55', '#7a6a5a', '#5a4a7a', '#8a5a3a'];
        while (x < r.w - 0.7) {
          const w = 0.07 + rnd() * 0.06;
          g.fillStyle = cols[Math.floor(rnd() * cols.length)];
          const fr = frame(r);
          g.fillRect(fr.X(x), fr.Y(ly + 0.05, 0.4), w, 0.4);
          x += w + 0.015;
        }
      }
      break;
    case 'canteen':
      B(1.0, 0.02, 8, 1.0, '#4a4d52', 0.05);
      for (let k = 0; k < 6; k++) { const fr = frame(r); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(fr.X(1.3 + k * 1.3), fr.Y(0.25, 0.5), 0.9, 0.5); }
      break;
    case 'auditorium':
      B(1.0, 0.0, r.w - 2, 2.0, '#3a2d3f', 0.3, 0.06);                  // stage
      B(r.w / 2 - 6, 0.02, 12, 0.14, '#d8e0ea', 0.02, 0.02, null);     // screen
      B(r.w / 2 - 0.6, 1.1, 1.2, 0.55, '#5a4a3a', 0.06);               // lectern
      for (const lx of [1.6, r.w - 2.4]) B(lx, 0.4, 0.8, 0.8, '#202630', 0.1, 0.06);   // speakers
      break;
    case 'security':
      B(0.6, 0.05, 8.8, 0.35, '#0f151d', 0.03, 0.04);                 // CCTV video wall
      for (let k = 0; k < 8; k++) { const fr = frame(r); g.fillStyle = k % 3 ? 'rgba(64,169,255,0.45)' : 'rgba(82,196,26,0.4)'; g.fillRect(fr.X(0.7 + k * 1.09), fr.Y(0.1, 0.25), 0.95, 0.25); }
      break;
    case 'medical':
      for (let k = 0; k < 3; k++) { B(0.5 + k * 3.1, 0.3, 1.0, 2.0, '#cfd8e3', 0.12, 0.08); B(0.55 + k * 3.1, 0.35, 0.9, 0.45, '#ffffff', 0.12, 0, null); }
      { const fr = frame(r); g.fillStyle = 'rgba(255,77,79,0.7)'; g.fillRect(fr.X(8.6), fr.Y(0.5, 0.6), 0.2, 0.6); g.fillRect(fr.X(8.4), fr.Y(0.7, 0.2), 0.6, 0.2); }
      break;
    case 'recreation':
      B(r.w / 2 - 1.2, 0.4, 2.4, 1.3, '#2c6b3f', 0.08);                 // pool / snooker table
      B(r.w - 3.4, 0.3, 2.6, 0.7, '#3d4a5d', 0.25);                     // sofa
      break;
    case 'office':
      for (let k = 0; k < 3; k++) B(9.2, 0.4 + k * 1.0, 0.6, 0.9, '#384252', 0.03, 0.05);
      C(0.6, 9.3, 0.35, '#2f5a3a'); C(9.4, 9.3, 0.35, '#2f5a3a');
      break;
    default: break;
  }
  const deskCol = r.type === 'library' || r.type === 'canteen' || r.type === 'recreation' ? '#4a3c30' : r.type === 'workshop' ? '#4b525c' : r.type === 'lab' && !lab3 ? '#3a4651' : DESK;
  const hasDesk = r.type !== 'seminar' && r.type !== 'auditorium';
  // Desks first (merged look), then screens/kit, then chairs.
  if (hasDesk) {
    for (const s of seats) {
      const f = Number.isFinite(s.facing) ? s.facing : -Math.PI / 2;
      const dx = Math.cos(f) * 0.52, dy = Math.sin(f) * 0.52;
      const vert = Math.abs(Math.sin(f)) > 0.5;
      const w = vert ? 1.22 : 0.5, h = vert ? 0.5 : 1.22;
      box(g, s.x + dx - w / 2, s.y + dy - h / 2, w, h, deskCol, 0.03, 0.07, null);
    }
    for (const s of seats) {
      const f = Number.isFinite(s.facing) ? s.facing : -Math.PI / 2;
      const cx = s.x + Math.cos(f) * 0.62, cy = s.y + Math.sin(f) * 0.62;
      if (lab3 || r.type === 'office') {
        g.fillStyle = '#0c131c'; g.fillRect(cx - 0.3, cy - 0.06, 0.6, 0.12);
        g.fillStyle = 'rgba(64,169,255,0.55)'; g.fillRect(cx - 0.25, cy - 0.03, 0.5, 0.05);
      } else if (r.type === 'lab' && labKind(r) === 'electronics') {
        g.fillStyle = '#202a35'; g.fillRect(cx - 0.2, cy - 0.12, 0.4, 0.24);
        g.fillStyle = 'rgba(82,196,26,0.6)'; g.fillRect(cx - 0.14, cy - 0.07, 0.2, 0.14);
      } else if (r.type === 'lab' && labKind(r) === 'chem') {
        circ(g, cx, cy, 0.1, '#596a7c', 0, null);
      } else if (r.type === 'canteen' && rnd() < 0.5) {
        circ(g, cx, cy - 0.05, 0.1, 'rgba(230,237,245,0.25)', 0, null);
      }
    }
  }
  for (const s of seats) {
    const theatre = r.type === 'seminar' || r.type === 'auditorium';
    const cs = r.type === 'auditorium' ? 0.36 : theatre ? 0.46 : 0.4;
    box(g, s.x - cs / 2, s.y - cs / 2, cs, cs, theatre ? '#4a3b5c' : CHAIR, 0.1, 0.05, 'rgba(255,255,255,0.06)');
  }
}

function arrow(g, x, y0, y1) {
  const d = Math.sign(y1 - y0);
  g.beginPath(); g.moveTo(x - 0.08, y0); g.lineTo(x + 0.08, y0); g.lineTo(x + 0.08, y1 - d * 0.2);
  g.lineTo(x + 0.22, y1 - d * 0.2); g.lineTo(x, y1); g.lineTo(x - 0.22, y1 - d * 0.2); g.lineTo(x - 0.08, y1 - d * 0.2); g.closePath(); g.fill();
}

function hazard(g, x, y, w, h) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.rect(x + 0.18, y + 0.18, w - 0.36, h - 0.36); g.clip('evenodd');
  g.fillStyle = 'rgba(250,173,20,0.5)'; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(20,20,20,0.85)';
  for (let k = -h; k < w + h; k += 0.5) { g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k + 0.25, y); g.lineTo(x + k + 0.25 - h, y + h); g.lineTo(x + k - h, y + h); g.fill(); }
  g.restore();
}

function pvBlock(g, x, y, w, h) {
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x + 0.1, y + 0.18, w, h);
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, '#26487e'); gr.addColorStop(1, '#16305a');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(160,200,255,0.18)'; g.lineWidth = PX;
  g.beginPath();
  for (let cx = x + 0.4; cx < x + w - 0.01; cx += 0.4) { g.moveTo(cx, y); g.lineTo(cx, y + h); }
  for (let cy = y + 0.35; cy < y + h - 0.01; cy += 0.35) { g.moveTo(x, cy); g.lineTo(x + w, cy); }
  g.stroke();
  g.fillStyle = 'rgba(200,225,255,0.35)'; g.fillRect(x, y, w, 0.05);
  g.fillStyle = '#0d1a30'; g.fillRect(x, y + h - 0.06, w, 0.06);
  // sky reflection streak
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.beginPath(); g.moveTo(x + w * 0.2, y); g.lineTo(x + w * 0.35, y); g.lineTo(x + w * 0.25, y + h); g.lineTo(x + w * 0.1, y + h); g.fill();
}

function corridorDecor(g, floor) {
  const c = floor.corridor;
  if (floor.isRoof) {
    text(g, 'ROOF  -  PLANT ACCESS ONLY', c.x + 8, c.y + c.h / 2 + 0.15, 0.36, 'rgba(250,173,20,0.35)', { mono: true });
    return;
  }
  // Benches, water cooler, extinguishers along the walls, avoiding doors.
  for (const bx of [8.5, 19.5, 30.5, 41.0]) box(g, bx, c.y + 0.12, 1.6, 0.42, '#2e3846', 0.1, 0.06);
  for (const bx of [8.5, 30.5]) box(g, bx, c.y + c.h - 0.54, 1.6, 0.42, '#2e3846', 0.1, 0.06);
  box(g, 2.2, c.y + c.h - 0.6, 0.5, 0.5, '#5a7fa6', 0.15, 0.06);   // water cooler
  for (const ex of [11.2, 33.2]) circ(g, ex + 0.5, c.y + 0.3, 0.14, '#c0392b', 0.04);
  for (const px of [16, 27, 38]) circ(g, px, c.y + c.h - 0.4, 0.3, '#2f5a3a', 0.06);
  // Signage
  text(g, 'STAIRS  +  LIFT', 44.2, c.y + 1.1, 0.34, 'rgba(245,179,1,0.5)', { mono: true, align: 'right' });
  g.fillStyle = 'rgba(245,179,1,0.5)';
  g.beginPath(); g.moveTo(44.5, c.y + 0.85); g.lineTo(44.5, c.y + 1.25); g.lineTo(44.9, c.y + 1.05); g.fill();
  text(g, floor.name.toUpperCase(), c.x + (floor.storey === 0 ? 4.2 : 0.5), c.y + c.h - 0.25, 0.3, 'rgba(138,155,176,0.35)', { mono: true });
  if (floor.storey === 0) {
    // Main entrance: glass door in the west facade, exit marker on the floor.
    const ex = 0, ey = 14;
    g.fillStyle = '#2a3442'; g.fillRect(ex, ey, 1, 1);
    g.fillStyle = 'rgba(105,177,255,0.55)'; g.fillRect(ex + 0.38, ey + 0.04, 0.24, 0.92);
    g.fillStyle = 'rgba(230,237,245,0.6)'; g.fillRect(ex + 0.47, ey + 0.04, 0.05, 0.92);
    g.fillStyle = 'rgba(82,196,26,0.16)'; g.fillRect(1, ey - 0.5, 2.6, 2);
    g.fillStyle = 'rgba(82,196,26,0.85)';
    g.beginPath(); g.moveTo(1.25, ey + 0.5); g.lineTo(1.75, ey + 0.15); g.lineTo(1.75, ey + 0.85); g.fill();
    g.fillRect(1.7, ey + 0.4, 1.3, 0.2);
    text(g, 'EXIT TO CAMPUS', 1.2, ey - 0.65, 0.3, 'rgba(82,196,26,0.9)', { mono: true, weight: 700 });
    box(g, 1.15, c.y + 0.1, 2.6, 0.45, '#2b3a4d', 0.04, 0.03, null);   // entrance mat
  }
}

function equipmentBases(g, floor) {
  for (const e of EQUIPMENT) {
    if (e.floor !== floor.level || e.x == null) continue;
    if (e.kind === 'ev' || e.kind === 'ebus') {
      box(g, e.x - 0.3, e.y - 0.2, 0.6, 0.4, '#25333a', 0.06, 0.06, 'rgba(92,219,211,0.45)');
    }
  }
}

function panelCabinets(g, floor) {
  for (const p of PANELS) {
    if (p.floor !== floor.level) continue;
    const isMain = p.id === 'MLT';
    const w = isMain ? 3.6 : 1.8;
    const x = isMain ? p.x - 0.8 : p.x - 0.9;
    const y = p.y - 0.95;
    box(g, x, y, w, 0.6, '#4a5463', 0.03, 0.1, 'rgba(255,255,255,0.18)');
    const n = isMain ? 6 : 3;
    for (let k = 0; k < n; k++) {
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + 0.08 + k * (w - 0.16) / n, y + 0.08, (w - 0.16) / n - 0.06, 0.44);
      g.fillStyle = k % 2 ? 'rgba(82,196,26,0.9)' : 'rgba(250,173,20,0.9)';
      g.fillRect(x + 0.15 + k * (w - 0.16) / n, y + 0.14, 0.06, 0.06);
    }
    hazardFloor(g, x, y + 0.65, w, 0.5);
  }
}

function hazardFloor(g, x, y, w, h) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = 'rgba(250,173,20,0.16)'; g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let k = -h; k < w + h; k += 0.4) { g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k + 0.2, y); g.lineTo(x + k + 0.2 - h, y + h); g.lineTo(x + k - h, y + h); g.fill(); }
  g.restore();
}

// ---------------------------------------------------------------- tops
function buildTops(floor) {
  const extra = floor.isCampus ? CAMPUS_EXTRA_ROWS : 0;
  const cv = makeCanvas((COLS + 2 * MARGIN) * PPT, (ROWS + 2 * MARGIN + extra) * PPT);
  const g = cv.getContext('2d');
  g.setTransform(PPT, 0, 0, PPT, MARGIN * PPT, MARGIN * PPT);
  if (floor.isCampus) { drawCampusTops(g, KIT); return cv; }
  const roof = floor.isRoof;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!isWall(floor, x, y)) continue;
      const outer = x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
      const ty = y - WALL_H;
      g.fillStyle = outer ? WALL_TOP_OUT : WALL_TOP;
      if (roof && !outer) g.fillStyle = '#3d4552';
      // Solid interior (an unused slot on a roof): plain roof slab, no edges.
      if (roof && !outer && isWall(floor, x - 1, y) && isWall(floor, x + 1, y) && isWall(floor, x, y - 1) && isWall(floor, x, y + 1)) {
        g.fillStyle = '#30353d'; g.fillRect(x, ty, 1, 1);
        continue;
      }
      g.fillRect(x, ty, 1, 1);
      g.fillStyle = WALL_EDGE;
      if (!isWall(floor, x, y - 1)) g.fillRect(x, ty, 1, 0.06);
      if (!isWall(floor, x - 1, y)) g.fillRect(x, ty, 0.05, 1);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      if (!isWall(floor, x + 1, y)) g.fillRect(x + 0.95, ty, 0.05, 1);
      if (!isWall(floor, x, y + 1)) { g.fillStyle = '#4b5a70'; g.fillRect(x, ty + 0.94, 1, 0.06); }
      // Exterior glazing strip on the facade walls.
      if (outer && !roof) {
        const horiz = y === 0 || y === ROWS - 1;
        const corner = (x === 0 || x === COLS - 1) && (y === 0 || y === ROWS - 1);
        if (!corner) {
          g.fillStyle = 'rgba(105,177,255,0.28)';
          if (horiz) g.fillRect(x, ty + 0.44, 1, 0.12); else g.fillRect(x + 0.44, ty, 0.12, 1);
          g.fillStyle = 'rgba(0,0,0,0.35)';
          if (horiz && x % 2 === 0) g.fillRect(x, ty + 0.4, 0.05, 0.2);
          if (!horiz && y % 2 === 0) g.fillRect(x + 0.4, ty, 0.2, 0.05);
        }
      }
    }
  }
  // Door name plates on the wall next to each door.
  for (const r of floor.rooms) {
    if (!r.doors.length || r.type === 'roof') continue;
    const d = r.doors[0];
    const label = r.type === 'core' ? 'STAIRS' : r.id.replace(/^G-/, '');
    const px = d.x - 0.12;
    g.fillStyle = 'rgba(11,15,20,0.75)';
    g.fillRect(px - 2.3, d.y - WALL_H + 0.28, 2.2, 0.44);
    text(g, label.slice(0, 10), px - 1.2, d.y - WALL_H + 0.61, 0.3, 'rgba(230,237,245,0.75)', { align: 'center', mono: true });
  }
  return cv;
}

// ---------------------------------------------------------------- minimap
const MINI_COL = {
  wall: '#3a4555', corridor: '#1f2a38', door: '#2b3a4d', core: '#4a3f1c', roof: '#1d3156', plant: '#26303b',
  room: '#18202b', server: '#16212d', electrical: '#1f2328', parking: '#1c1f23',
};

function buildMini(floor, dpr) {
  const s = MINI_PPT * dpr;
  const cv = makeCanvas(COLS * s, ROWS * s);
  const g = cv.getContext('2d');
  g.setTransform(s, 0, 0, s, 0, 0);
  if (floor.isCampus) {
    const q = 2;
    for (let y = 0; y < ROWS * q; y++) for (let x = 0; x < COLS * q; x++) {
      g.fillStyle = MINI_GROUND[groundAt((x + 0.5) / q, (y + 0.5) / q)] || MINI_GROUND[0];
      g.fillRect(x / q, y / q, 1 / q + 0.01, 1 / q + 0.01);
    }
    return cv;
  }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const t = floor.grid[y][x];
    g.fillStyle = t === TILE.WALL ? MINI_COL.wall : t === TILE.DOOR ? MINI_COL.door : t === TILE.CORE ? MINI_COL.core : t === TILE.CORRIDOR ? MINI_COL.corridor : MINI_COL.room;
    g.fillRect(x, y, 1, 1);
  }
  for (const r of floor.rooms) {
    if (r.type === 'core') continue;
    g.fillStyle = MINI_COL[r.type] || MINI_COL.room;
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  return cv;
}
