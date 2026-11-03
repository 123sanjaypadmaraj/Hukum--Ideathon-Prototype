// NHCE campus site plan (FLOORS[0], isCampus): ground classification,
// paths, trees, street lamps, block massing (2.5D extrusion by storeys),
// and the static drawing of the outdoor floor. Drawing helpers are passed
// in from art.js as `kit` so there is no import cycle.
import { COLS, ROWS, TILE, SITE, BLOCKS, BLOCK_BY_ID, FLOORS, EQUIPMENT } from '../building.js';
import { mulberry32 } from '../config.js';

export const ROAD = { y0: 28.95, y1: 33.6 };       // Outer Ring Road strip below the boundary (tiles)
export const CAMPUS_EXTRA_ROWS = 5;                 // art canvas extends this far below the grid

// Paved walkways and drives [x, y, w, h].
export const PATHS = [
  [1, 10, 50, 2],                 // central avenue
  [24, 21, 4, 8],                 // drive: Main Block door -> main gate
  [5, 9, 3, 1], [17, 9, 3, 1], [29, 9, 3, 1],   // door aprons
  [12, 15, 5, 2],                 // Amenities door -> Main Block
  [13, 12, 2, 3],                 // link avenue -> amenities path
  [20, 23, 4, 3],                 // parking access
  [35, 12, 1, 9],                 // service lane to substation and STP
  [39, 12, 1.2, 2],               // avenue -> sports ground
  [2, 21, 7, 1],                  // walk to the basketball court
];

const zone = (id) => SITE.zones.find((z) => z.id === id) || null;

// Stadium-shaped synthetic track inside the SPORTS zone.
export function trackGeom() {
  const z = zone('SPORTS');
  if (!z) return null;
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const rOut = Math.min(z.w / 2 - 0.45, 4.4);
  const rIn = rOut - 1.15;
  const half = Math.max(0, z.h / 2 - 0.45 - rOut);
  return { cx, cy, rOut, rIn, half };
}
function trackDist(t, x, y) {
  const dy = Math.max(0, Math.abs(y - t.cy) - t.half);
  return Math.hypot(x - t.cx, dy);
}

// Ground codes: 0 grass, 1 paver path, 2 asphalt, 3 track, 4 infield,
// 5 court, 6 gate plaza, 7 building/structure, 8 boundary hedge.
export const G = { GRASS: 0, PATH: 1, ASPHALT: 2, TRACK: 3, INFIELD: 4, COURT: 5, PLAZA: 6, SOLID: 7, HEDGE: 8 };
const SUB = 4;
let groundGrid = null;
function computeGround(x, y) {
  const campus = FLOORS[0];
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx <= 0 || ty <= 0 || tx >= COLS - 1 || ty >= ROWS - 1) {
    if (ty === ROWS - 1 && campus.grid[ty] && campus.grid[ty][tx] === TILE.DOOR) return G.PLAZA;
    return G.HEDGE;
  }
  if (campus.grid[ty][tx] === TILE.WALL) return G.SOLID;
  const t = trackGeom();
  const sp = zone('SPORTS');
  if (t && sp && x >= sp.x && x < sp.x + sp.w && y >= sp.y && y < sp.y + sp.h) {
    const d = trackDist(t, x, y);
    if (d <= t.rOut && d >= t.rIn) return G.TRACK;
    if (d < t.rIn) return G.INFIELD;
    return G.GRASS;
  }
  const bb = zone('BBALL');
  if (bb && x >= bb.x + 0.25 && x < bb.x + bb.w - 0.25 && y >= bb.y + 0.25 && y < bb.y + bb.h - 0.25) return G.COURT;
  const pk = zone('PARKING');
  if (pk && x >= pk.x && x < pk.x + pk.w && y >= pk.y && y < pk.y + pk.h) return G.ASPHALT;
  const gt = zone('GATE');
  if (gt && x >= gt.x && x < gt.x + gt.w && y >= gt.y && y < gt.y + gt.h) return G.PLAZA;
  for (const [px, py, pw, ph] of PATHS) if (x >= px && x < px + pw && y >= py && y < py + ph) return G.PATH;
  if (campus.grid[ty][tx] === TILE.DOOR) return G.PATH;
  return G.GRASS;
}
export function groundAt(x, y) {
  if (!groundGrid) {
    groundGrid = new Uint8Array(COLS * SUB * ROWS * SUB);
    for (let j = 0; j < ROWS * SUB; j++) for (let i = 0; i < COLS * SUB; i++) {
      groundGrid[j * COLS * SUB + i] = computeGround((i + 0.5) / SUB, (j + 0.5) / SUB);
    }
  }
  const i = Math.floor(x * SUB), j = Math.floor(y * SUB);
  if (i < 0 || j < 0 || i >= COLS * SUB || j >= ROWS * SUB) return G.HEDGE;
  return groundGrid[j * COLS * SUB + i];
}

// Block massing: extrusion height grows with the number of storeys.
const SOLAR_BLOCKS = new Set(['MB', 'SVP', 'NSB']);
const geomCache = new Map();
export function blockGeom(blockId) {
  let gm = geomCache.get(blockId);
  if (gm) return gm;
  const b = BLOCK_BY_ID[blockId];
  if (!b || !b.footprint) return null;
  const fp = b.footprint;
  const storeyFloors = b.floors.filter((i) => FLOORS[i] && !FLOORS[i].isRoof);
  const storeys = Math.max(1, storeyFloors.length);
  const H = blockId === 'AUD' ? 1.45 : 0.32 + storeys * 0.5;
  const sh = (H - 0.22) / storeys;
  const windows = [];
  for (let s = 0; s < storeys; s++) {
    const wy = fp.y + fp.h - 0.08 - (s + 1) * sh + sh * 0.22;
    const wh = sh * 0.5;
    if (blockId === 'AUD') {
      for (let x = fp.x + 0.6; x < fp.x + fp.w - 0.6; x += 1.6) windows.push({ s, x, y: fp.y + fp.h - 0.5, w: 1.0, h: 0.22 });
      continue;
    }
    for (let x = fp.x + 0.35; x < fp.x + fp.w - 0.5; x += 0.82) windows.push({ s, x, y: wy, w: 0.52, h: wh });
  }
  gm = { b, fp, storeys, storeyFloors, H, sh, windows, solar: SOLAR_BLOCKS.has(blockId) };
  geomCache.set(blockId, gm);
  return gm;
}

// Deterministic trees on open lawn.
let trees = null;
export function getTrees() {
  if (trees) return trees;
  const rnd = mulberry32(4242);
  trees = [];
  const clear = (x, y, r) => {
    for (let a = 0; a < 8; a++) {
      const px = x + Math.cos(a * Math.PI / 4) * r, py = y + Math.sin(a * Math.PI / 4) * r;
      if (groundAt(px, py) !== G.GRASS) return false;
    }
    return groundAt(x, y) === G.GRASS;
  };
  const far = (x, y, d) => trees.every((t) => Math.hypot(t.x - x, t.y - y) >= d) && LAMPS.every((l) => Math.hypot(l.x - x, l.y - y) >= 1.2);
  // A row along the south boundary and the avenue edges, then scattered lawn trees.
  for (let x = 2; x < 50; x += 2.3) if (clear(x, 27.3, 0.75) && far(x, 27.3, 1.8)) trees.push({ x, y: 27.3, r: 0.75 + rnd() * 0.2, k: rnd() });
  for (let x = 2.5; x < 50; x += 3.1) if (clear(x, 12.9, 0.7) && far(x, 12.9, 2)) trees.push({ x, y: 12.9, r: 0.7 + rnd() * 0.2, k: rnd() });
  for (let n = 0; n < 900 && trees.length < 70; n++) {
    const x = 1.6 + rnd() * (COLS - 3.2), y = 1.6 + rnd() * (ROWS - 3.2);
    const r = 0.6 + rnd() * 0.45;
    if (clear(x, y, r + 0.25) && far(x, y, r + 1.3)) trees.push({ x, y, r, k: rnd() });
  }
  return trees;
}

export const LAMPS = [
  ...[4, 10, 16, 22, 28, 34, 46].map((x) => ({ x, y: 12.35, kind: 'street' })),
  ...[22.5, 25.5].map((y) => ({ x: 23.55, y, kind: 'street' })),
  ...[22.5, 25.5].map((y) => ({ x: 28.45, y, kind: 'street' })),
  { x: 11.4, y: 21.55, kind: 'street' }, { x: 19.6, y: 21.55, kind: 'street' },
  ...(() => {
    const z = zone('SPORTS');
    return z ? [[z.x + 0.35, z.y + 0.35], [z.x + z.w - 0.35, z.y + 0.35], [z.x + 0.35, z.y + z.h - 0.35], [z.x + z.w - 0.35, z.y + z.h - 0.35]]
      .map(([x, y]) => ({ x, y, kind: 'flood' })) : [];
  })(),
];

// ------------------------------------------------------------------ base
export function drawCampusBase(g, kit) {
  const { PX, rr, box, circ, text, speckle, pvBlock } = kit;
  const rnd = mulberry32(777);

  // Road (below the boundary) first, then the site.
  g.fillStyle = '#2a2f36'; g.fillRect(-1, ROAD.y0, COLS + 2, 0.55);                 // footpath
  g.fillStyle = '#1b1e22'; g.fillRect(-1, ROAD.y0 + 0.55, COLS + 2, ROAD.y1 - ROAD.y0 - 0.55);
  g.fillStyle = 'rgba(230,237,245,0.5)';
  g.fillRect(-1, ROAD.y0 + 0.62, COLS + 2, 0.05);
  g.fillRect(-1, ROAD.y1 - 0.12, COLS + 2, 0.05);
  const mid = (ROAD.y0 + 0.55 + ROAD.y1) / 2;
  g.fillStyle = 'rgba(250,173,20,0.55)'; g.fillRect(-1, mid - 0.04, COLS + 2, 0.08);
  g.fillStyle = 'rgba(230,237,245,0.35)';
  for (let x = -1; x < COLS + 1; x += 2) { g.fillRect(x, (ROAD.y0 + 0.55 + mid) / 2, 1, 0.05); g.fillRect(x + 1, (mid + ROAD.y1) / 2, 1, 0.05); }
  text(g, 'OUTER RING ROAD  -  MARATHAHALLI, BENGALURU', 2, mid - 0.25, 0.36, 'rgba(230,237,245,0.22)', { mono: true });

  // Ground: grass everywhere inside, then paved / special surfaces.
  g.fillStyle = '#1d3024'; g.fillRect(0, 0, COLS, ROWS);
  speckle(g, { x: 0, y: 0, w: COLS, h: ROWS }, rnd, 26, 0.07);
  // mowing stripes
  g.fillStyle = 'rgba(255,255,255,0.018)';
  for (let x = 0; x < COLS; x += 2) g.fillRect(x, 0, 1, ROWS);

  // Paths with paver joints
  for (const [x, y, w, h] of PATHS) {
    g.fillStyle = '#353a42'; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = PX;
    g.beginPath();
    for (let px = x; px <= x + w; px += 0.5) { g.moveTo(px, y); g.lineTo(px, y + h); }
    for (let py = y; py <= y + h; py += 0.5) { g.moveTo(x, py); g.lineTo(x + w, py); }
    g.stroke();
    g.strokeStyle = 'rgba(200,210,220,0.12)'; g.strokeRect(x, y, w, h);
  }
  // Gate apron through the boundary to the road
  const gt = zone('GATE');
  if (gt) {
    g.fillStyle = '#3a3f47'; g.fillRect(gt.x, gt.y, gt.w, gt.h);
    g.fillStyle = '#353a42'; g.fillRect(gt.x + 2, ROWS - 1, gt.w - 4, ROAD.y0 - (ROWS - 1) + 0.55);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = PX;
    g.beginPath();
    for (let px = gt.x; px <= gt.x + gt.w; px += 0.5) { g.moveTo(px, gt.y); g.lineTo(px, gt.y + gt.h); }
    g.stroke();
    // zebra crossing / speed hump at the gate
    g.fillStyle = 'rgba(230,237,245,0.35)';
    for (let x = gt.x + 2.2; x < gt.x + gt.w - 2.2; x += 0.5) g.fillRect(x, ROWS - 0.6, 0.25, 0.5);
  }

  // Parking: asphalt, bays for cars and the college buses
  const pk = zone('PARKING');
  if (pk) {
    g.fillStyle = '#23272c'; g.fillRect(pk.x, pk.y, pk.w, pk.h);
    speckle(g, pk, rnd, 18, 0.05);
    g.strokeStyle = 'rgba(230,237,245,0.3)'; g.lineWidth = 2 * PX;
    for (const e of EQUIPMENT) {
      if (e.floor !== 0 || e.x == null) continue;
      if (e.kind === 'ev') g.strokeRect(e.x - 0.8, e.y - 2.35, 1.6, 2.15);
      if (e.kind === 'ebus') g.strokeRect(e.x - 1.85, e.y + 0.22, 3.7, 1.56);
    }
    text(g, 'BUS BAY', pk.x + pk.w / 2, pk.y + pk.h - 0.55, 0.3, 'rgba(92,219,211,0.35)', { align: 'center', mono: true });
    for (const e of EQUIPMENT) if (e.floor === 0 && e.x != null && (e.kind === 'ev' || e.kind === 'ebus')) {
      box(g, e.x - 0.3, e.y - 0.2, 0.6, 0.4, '#25333a', 0.06, 0.06, 'rgba(92,219,211,0.55)');
    }
  }

  // Basketball court
  const bb = zone('BBALL');
  if (bb) {
    const x = bb.x + 0.25, y = bb.y + 0.25, w = bb.w - 0.5, h = bb.h - 0.5;
    g.fillStyle = '#7a3f22'; g.fillRect(x, y, w, h);
    g.fillStyle = '#2d4f7a'; g.fillRect(x + 0.35, y + 0.35, w - 0.7, h - 0.7);
    g.strokeStyle = 'rgba(240,240,240,0.75)'; g.lineWidth = 2 * PX;
    g.strokeRect(x + 0.35, y + 0.35, w - 0.7, h - 0.7);
    g.beginPath(); g.moveTo(x + w / 2, y + 0.35); g.lineTo(x + w / 2, y + h - 0.35); g.stroke();
    g.beginPath(); g.arc(x + w / 2, y + h / 2, 0.5, 0, Math.PI * 2); g.stroke();
    for (const side of [0, 1]) {
      const kx = side ? x + w - 0.35 : x + 0.35, dir = side ? -1 : 1;
      g.strokeRect(Math.min(kx, kx + dir * 1.1), y + h / 2 - 0.55, 1.1, 1.1);
      g.beginPath(); g.arc(kx, y + h / 2, 1.5, side ? Math.PI / 2 : -Math.PI / 2, side ? Math.PI * 1.5 : Math.PI / 2); g.stroke();
      circ(g, kx + dir * 0.25, y + h / 2, 0.12, 'rgba(255,122,69,0.9)', 0, null);
    }
  }

  // Sports ground + synthetic track
  const sp = zone('SPORTS'), t = trackGeom();
  if (sp && t) {
    g.fillStyle = '#244a2c'; g.fillRect(sp.x, sp.y, sp.w, sp.h);
    const stadium = (r) => {
      g.beginPath();
      g.arc(t.cx, t.cy - t.half, r, Math.PI, 0);
      g.lineTo(t.cx + r, t.cy + t.half);
      g.arc(t.cx, t.cy + t.half, r, 0, Math.PI);
      g.closePath();
    };
    g.fillStyle = '#8f3e2c'; stadium(t.rOut); g.fill();
    g.fillStyle = '#2b5a33'; stadium(t.rIn); g.fill();
    // infield stripes + pitch markings
    g.save(); stadium(t.rIn); g.clip();
    g.fillStyle = 'rgba(255,255,255,0.035)';
    for (let y = t.cy - t.half - t.rIn; y < t.cy + t.half + t.rIn; y += 1.2) g.fillRect(t.cx - t.rIn, y, t.rIn * 2, 0.6);
    g.restore();
    g.strokeStyle = 'rgba(240,240,240,0.6)'; g.lineWidth = 1.2 * PX;
    for (let k = 1; k < 4; k++) { stadium(t.rIn + k * (t.rOut - t.rIn) / 4); g.stroke(); }
    stadium(t.rOut); g.stroke(); stadium(t.rIn); g.stroke();
    g.strokeStyle = 'rgba(240,240,240,0.4)';
    g.strokeRect(t.cx - t.rIn * 0.6, t.cy - t.half - t.rIn * 0.5, t.rIn * 1.2, (t.half + t.rIn * 0.5) * 2);
    g.beginPath(); g.moveTo(t.cx - t.rIn * 0.6, t.cy); g.lineTo(t.cx + t.rIn * 0.6, t.cy); g.stroke();
    g.beginPath(); g.arc(t.cx, t.cy, 0.8, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(240,240,240,0.7)'; g.fillRect(t.cx + t.rIn, t.cy - 0.03, t.rOut - t.rIn, 0.06);   // finish line
  }

  // Structures: substation yard and STP
  for (const s of SITE.structures) {
    if (s.id === 'SUBSTATION') {
      g.fillStyle = '#2f3237'; g.fillRect(s.x, s.y, s.w, s.h);
      speckle(g, s, rnd, 40, 0.08);
      g.strokeStyle = 'rgba(200,210,220,0.55)'; g.lineWidth = 1.5 * PX; g.setLineDash([0.12, 0.08]);
      g.strokeRect(s.x + 0.08, s.y + 0.08, s.w - 0.16, s.h - 0.16); g.setLineDash([]);
    } else {
      g.fillStyle = '#2a3136'; g.fillRect(s.x, s.y, s.w, s.h);
      for (const [cx, cy] of [[s.x + 0.8, s.y + s.h / 2], [s.x + 2.2, s.y + s.h / 2]]) {
        circ(g, cx, cy, 0.62, '#3c4a52', 0.08);
        circ(g, cx, cy, 0.48, '#2e5560', 0, 'rgba(105,177,255,0.35)');
      }
    }
  }

  // Block shadows, cast south-east, scaled with height.
  for (const b of BLOCKS) {
    const gm = blockGeom(b.id);
    if (!gm) continue;
    const { fp, H } = gm;
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.beginPath();
    g.moveTo(fp.x + fp.w, fp.y); g.lineTo(fp.x + fp.w + H * 0.9, fp.y + H * 0.5);
    g.lineTo(fp.x + fp.w + H * 0.9, fp.y + fp.h + H * 0.5); g.lineTo(fp.x + H * 0.9, fp.y + fp.h + H * 0.5);
    g.lineTo(fp.x, fp.y + fp.h); g.lineTo(fp.x + fp.w, fp.y + fp.h); g.closePath(); g.fill();
    g.fillStyle = '#20252c'; g.fillRect(fp.x, fp.y, fp.w, fp.h);
    // Entrance apron with chevrons into the block
    const d = fp.door;
    g.fillStyle = 'rgba(245,179,1,0.10)'; g.fillRect(d.x, d.y, 1, 1);
    g.strokeStyle = 'rgba(245,179,1,0.55)'; g.lineWidth = 2 * PX;
    const into = d.y >= fp.y + fp.h ? [0, -1] : d.y < fp.y ? [0, 1] : d.x >= fp.x + fp.w ? [-1, 0] : [1, 0];
    for (let k = 0; k < 2; k++) {
      const cx = d.x + 0.5 - into[0] * (0.05 - k * 0.3), cy = d.y + 0.5 - into[1] * (0.05 - k * 0.3);
      g.beginPath();
      g.moveTo(cx - into[1] * 0.3 - into[0] * 0.15, cy - into[0] * 0.3 - into[1] * 0.15);
      g.lineTo(cx + into[0] * 0.15, cy + into[1] * 0.15);
      g.lineTo(cx + into[1] * 0.3 - into[0] * 0.15, cy + into[0] * 0.3 - into[1] * 0.15);
      g.stroke();
    }
  }

  // Tree shadows and lamp posts (bases)
  for (const tr of getTrees()) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(tr.x + 0.35, tr.y + 0.3, tr.r * 1.05, tr.r * 0.85, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3b2c20'; g.beginPath(); g.arc(tr.x, tr.y, 0.1, 0, Math.PI * 2); g.fill();
  }
  for (const l of LAMPS) {
    circ(g, l.x, l.y, l.kind === 'flood' ? 0.16 : 0.1, '#56606e', 0.05, null);
  }

  // Benches along the avenue
  for (const x of [7, 19, 31, 41]) box(g, x, 12.15, 1.3, 0.35, '#4a3c30', 0.08, 0.06);
}

// ------------------------------------------------------------------ tops
export function drawCampusTops(g, kit) {
  const { PX, rr, box, circ, text, pvBlock } = kit;

  // Boundary hedge + compound wall line, with the main gate opening.
  const campus = FLOORS[0];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const border = x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
    if (!border || campus.grid[y][x] !== TILE.WALL) continue;
    g.fillStyle = '#1a3a22'; g.fillRect(x, y - 0.25, 1, 1);
    g.fillStyle = 'rgba(120,180,110,0.18)';
    g.beginPath(); g.arc(x + 0.3, y + 0.1, 0.28, 0, Math.PI * 2); g.arc(x + 0.75, y + 0.35, 0.25, 0, Math.PI * 2); g.fill();
  }
  // compound wall on the outer edge
  g.fillStyle = '#5b6370';
  g.fillRect(-0.05, -0.4, COLS + 0.1, 0.18);
  g.fillRect(-0.05, -0.4, 0.18, ROWS + 0.3);
  g.fillRect(COLS - 0.13, -0.4, 0.18, ROWS + 0.3);
  const gt = zone('GATE');
  const gx0 = gt ? gt.x + 2 : 24, gx1 = gt ? gt.x + gt.w - 2 : 28;
  g.fillRect(-0.05, ROWS - 0.2, gx0 + 0.05, 0.18);
  g.fillRect(gx1, ROWS - 0.2, COLS - gx1 + 0.05, 0.18);
  g.fillStyle = '#3d434d';
  g.fillRect(-0.05, ROWS - 0.02, gx0 + 0.05, 0.12);
  g.fillRect(gx1, ROWS - 0.02, COLS - gx1 + 0.05, 0.12);
  // gate pillars, sliding gate (open), name arch
  box(g, gx0 - 0.45, ROWS - 1.05, 0.45, 1.0, '#7a6a52', 0.04, 0.12);
  box(g, gx1, ROWS - 1.05, 0.45, 1.0, '#7a6a52', 0.04, 0.12);
  g.fillStyle = '#8a95a5'; g.fillRect(gx1 + 0.45, ROWS - 0.55, 2.4, 0.08);
  for (let x = gx1 + 0.5; x < gx1 + 2.8; x += 0.25) g.fillRect(x, ROWS - 0.62, 0.03, 0.22);
  g.fillStyle = 'rgba(11,15,20,0.85)'; g.fillRect(gx0 - 0.3, ROWS - 0.15, gx1 - gx0 + 0.6, 0.55);
  text(g, 'NEW HORIZON COLLEGE OF ENGINEERING', (gx0 + gx1) / 2, ROWS + 0.27, 0.27, 'rgba(245,179,1,0.85)', { align: 'center', weight: 700 });

  // Security booth + boom barrier at the gate
  if (gt) {
    const bx = gt.x + 0.3, by = gt.y + gt.h - 1.4;
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(bx + 0.25, by + 0.25, 1.4, 1.1);
    g.fillStyle = '#4a5260'; g.fillRect(bx, by + 0.75, 1.4, 0.4);
    g.fillStyle = '#5d6676'; g.fillRect(bx, by - 0.1, 1.4, 0.85);
    g.fillStyle = 'rgba(105,177,255,0.45)'; g.fillRect(bx + 0.15, by + 0.82, 1.1, 0.18);
    text(g, 'SECURITY', bx + 0.7, by + 0.45, 0.2, 'rgba(230,237,245,0.8)', { align: 'center', mono: true });
    // barrier arm (raised position drawn as short striped stub)
    for (let k = 0; k < 6; k++) { g.fillStyle = k % 2 ? '#e6edf5' : '#d9363e'; g.fillRect(bx + 1.4 + k * 0.3, gt.y + gt.h - 0.3, 0.3, 0.09); }
  }

  // Substation equipment and STP walls (low extrusion)
  for (const s of SITE.structures) {
    if (s.id === 'SUBSTATION') {
      for (const [ox, oy] of [[0.35, 0.4], [1.6, 0.4], [0.35, 1.75]]) {
        g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(s.x + ox + 0.15, s.y + oy + 0.15, 1.0, 0.9);
        g.fillStyle = '#4c535d'; g.fillRect(s.x + ox, s.y + oy + 0.5, 1.0, 0.35);
        g.fillStyle = '#626b78'; g.fillRect(s.x + ox, s.y + oy - 0.05, 1.0, 0.6);
        g.fillStyle = 'rgba(0,0,0,0.3)'; for (let k = 0; k < 4; k++) g.fillRect(s.x + ox + 0.1 + k * 0.22, s.y + oy + 0.05, 0.1, 0.4);
      }
      g.fillStyle = 'rgba(250,173,20,0.85)';
      g.beginPath(); g.moveTo(s.x + 2.3, s.y + 2.0); g.lineTo(s.x + 2.6, s.y + 2.55); g.lineTo(s.x + 2.0, s.y + 2.55); g.fill();
    }
  }

  // Blocks: south facade + roof (2.5D)
  for (const b of BLOCKS) {
    const gm = blockGeom(b.id);
    if (!gm) continue;
    const { fp, H, windows, storeys, sh } = gm;
    // facade
    const gr = g.createLinearGradient(0, fp.y + fp.h - H, 0, fp.y + fp.h);
    gr.addColorStop(0, '#5f6878'); gr.addColorStop(1, '#3b424e');
    g.fillStyle = gr; g.fillRect(fp.x, fp.y + fp.h - H, fp.w, H);
    for (let s = 1; s < storeys; s++) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(fp.x, fp.y + fp.h - 0.08 - s * sh, fp.w, 0.04); }
    for (const w of windows) {
      g.fillStyle = '#1a2533'; g.fillRect(w.x, w.y, w.w, w.h);
      g.fillStyle = 'rgba(160,200,255,0.12)'; g.fillRect(w.x, w.y, w.w, w.h * 0.3);
    }
    // entrance on the facade
    const d = fp.door;
    if (d.y >= fp.y + fp.h) {
      g.fillStyle = '#c99a2e'; g.fillRect(d.x - 0.25, fp.y + fp.h - 0.62, 1.5, 0.12);   // canopy
      g.fillStyle = 'rgba(105,177,255,0.55)'; g.fillRect(d.x + 0.05, fp.y + fp.h - 0.5, 0.9, 0.5);
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(d.x + 0.48, fp.y + fp.h - 0.5, 0.04, 0.5);
    }
    // roof
    const ry = fp.y - H;
    g.fillStyle = '#4a515d'; g.fillRect(fp.x, ry, fp.w, fp.h);
    g.fillStyle = '#5c6575'; g.fillRect(fp.x, ry, fp.w, 0.14); g.fillRect(fp.x, ry, 0.14, fp.h);
    g.fillStyle = '#353b45'; g.fillRect(fp.x + fp.w - 0.14, ry, 0.14, fp.h); g.fillRect(fp.x, ry + fp.h - 0.14, fp.w, 0.14);
    g.fillStyle = '#3f4651'; g.fillRect(fp.x + 0.25, ry + 0.25, fp.w - 0.5, fp.h - 0.5);
    if (b.id === 'AUD') {
      g.fillStyle = '#4b5463'; rr(g, fp.x + 0.5, ry + 0.5, fp.w - 1, fp.h - 1, 1.2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = PX;
      for (let x = fp.x + 0.8; x < fp.x + fp.w - 0.6; x += 0.35) { g.beginPath(); g.moveTo(x, ry + 0.6); g.lineTo(x, ry + fp.h - 0.6); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,0.06)'; rr(g, fp.x + 0.5, ry + 0.5, fp.w - 1, 1.2, 0.6); g.fill();
    } else if (gm.solar) {
      for (let y = ry + 0.55; y + 0.95 < ry + fp.h - 0.4; y += 1.3) {
        for (let x = fp.x + 0.55; x < fp.x + fp.w - 0.8; x += 4.3) {
          pvBlock(g, x, y, Math.min(4.0, fp.x + fp.w - 0.55 - x), 0.95);
        }
      }
    } else {
      // water tanks + condenser units
      circ(g, fp.x + 1.4, ry + 1.4, 0.6, '#2c3640', 0.1);
      circ(g, fp.x + 2.8, ry + 1.4, 0.6, '#2c3640', 0.1);
      for (let k = 0; k < 4; k++) box(g, fp.x + 4.3 + k * 1.2, ry + fp.h - 2.0, 0.9, 0.9, '#58606d', 0.04, 0.08);
      g.fillStyle = 'rgba(105,177,255,0.25)';
      for (let k = 0; k < 3; k++) g.fillRect(fp.x + 1.0 + k * 2.4, ry + fp.h - 3.6, 1.6, 0.9);   // skylights
    }
    // AMN: east entrance canopy
    if (d.x >= fp.x + fp.w) {
      g.fillStyle = '#c99a2e'; g.fillRect(fp.x + fp.w - 0.1, d.y - H - 0.2, 0.35, 1.4);
    }
  }

  // Tree canopies (above people walking under them)
  for (const tr of getTrees()) {
    const base = tr.k < 0.33 ? '#1f4a2a' : tr.k < 0.66 ? '#24532f' : '#2c5a2a';
    g.fillStyle = base;
    g.beginPath(); g.arc(tr.x, tr.y - 0.25, tr.r, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(160,220,120,0.14)';
    g.beginPath(); g.arc(tr.x - tr.r * 0.3, tr.y - 0.25 - tr.r * 0.3, tr.r * 0.55, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath(); g.arc(tr.x + tr.r * 0.35, tr.y - 0.25 + tr.r * 0.3, tr.r * 0.5, 0, Math.PI * 2); g.fill();
  }
  // Lamp heads
  for (const l of LAMPS) {
    g.fillStyle = '#7d8796';
    if (l.kind === 'flood') { g.fillRect(l.x - 0.25, l.y - 0.95, 0.5, 0.18); g.fillRect(l.x - 0.03, l.y - 0.8, 0.06, 0.8); }
    else { g.fillRect(l.x - 0.03, l.y - 0.55, 0.06, 0.55); g.beginPath(); g.arc(l.x, l.y - 0.58, 0.1, 0, Math.PI * 2); g.fill(); }
  }
}

// Minimap colours per ground code.
export const MINI_GROUND = ['#1c2c21', '#3a414b', '#262a30', '#7a3a2a', '#24452b', '#2d4f7a', '#3f454e', '#5a6478', '#183020'];
