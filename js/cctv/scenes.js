// 3D description of what each CCTV camera sees: the room shell (floor,
// walls, ceiling, doors, windows, lamps) plus furnishings per room type.
// Units are metres = tiles; z is height above the floor.
import { FLOORS, ROOM_BY_ID, EQUIPMENT, SITE, BLOCK_BY_ID } from '../building.js';
import { mulberry32 } from '../config.js';
import { getSeats } from '../sim/occupancy.js';

export const CEIL = 3.2;

const LDIR = (() => { const v = [-0.35, -0.25, 0.9]; const m = Math.hypot(...v); return v.map((c) => c / m); })();
export const normalFactor = (n) => 0.8 + 0.2 * (n[0] * LDIR[0] + n[1] * LDIR[1] + n[2] * LDIR[2]);
export const FACE_N = {
  'x-': [-1, 0, 0], 'x+': [1, 0, 0], 'y-': [0, -1, 0], 'y+': [0, 1, 0], 'z+': [0, 0, 1],
};
export const FACE_NF = Object.fromEntries(Object.entries(FACE_N).map(([k, n]) => [k, normalFactor(n)]));

const PAL = {
  classroom:  { floor: [176, 170, 158], wall: [226, 218, 196], dado: [150, 140, 118], ceil: [226, 226, 220], pattern: 'checker' },
  lab:        { floor: [184, 192, 192], wall: [222, 228, 230], dado: [128, 158, 170], ceil: [232, 234, 234], pattern: 'checker' },
  seminar:    { floor: [118, 60, 56],   wall: [198, 178, 152], dado: [110, 80, 60],   ceil: [210, 206, 200], pattern: 'carpet' },
  library:    { floor: [150, 112, 78],  wall: [216, 202, 174], dado: [116, 86, 58],   ceil: [226, 222, 212], pattern: 'planks' },
  office:     { floor: [170, 162, 150], wall: [224, 218, 206], dado: [136, 126, 114], ceil: [230, 230, 226], pattern: 'checker' },
  lobby:      { floor: [216, 210, 202], wall: [228, 222, 210], dado: [140, 110, 82],  ceil: [234, 232, 226], pattern: 'marble' },
  canteen:    { floor: [198, 186, 166], wall: [238, 214, 170], dado: [186, 118, 66],  ceil: [232, 228, 216], pattern: 'checker' },
  server:     { floor: [160, 166, 172], wall: [190, 196, 200], dado: [118, 126, 134], ceil: [204, 208, 210], pattern: 'raised' },
  electrical: { floor: [140, 142, 136], wall: [198, 198, 190], dado: [108, 110, 106], ceil: [206, 206, 200], pattern: 'plain' },
  parking:    { floor: [120, 120, 118], wall: [178, 176, 170], dado: [206, 176, 44],  ceil: [172, 172, 168], pattern: 'concrete' },
  corridor:   { floor: [188, 178, 162], wall: [216, 210, 194], dado: [146, 132, 106], ceil: [226, 224, 216], pattern: 'checker' },
};

const WOOD = [150, 104, 64], WOOD_D = [112, 78, 48], STEEL = [172, 176, 180], DARK = [42, 44, 48];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

class Builder {
  constructor(rect, top, type, id) {
    this.rect = rect; this.top = top; this.type = type; this.id = id;
    this.pal = PAL[type] || PAL.office;
    this.shell = []; this.decals = []; this.furn = []; this.fans = []; this.winPlanes = [];
    this.rng = mulberry32(hashStr(id));
    this.winGain = 0.6;
    this.ceil = CEIL;
    this.extra = {};
  }
  X(u) { return this.rect.x + u; }
  Y(v) { return this.top ? this.rect.y + v : this.rect.y + this.rect.h - v; }
  // Local side names -> world wall side.
  side(s) {
    if (s === 'outer') return this.top ? 'N' : 'S';
    if (s === 'door') return this.top ? 'S' : 'N';
    return s === 'west' ? 'W' : 'E';
  }
  // Local wall coordinate along the wall -> world coordinate.
  wa(s, a) { return (s === 'outer' || s === 'door') ? this.X(a) : this.Y(a); }

  quad(list, pts, c, n, extra = {}) {
    const cen = [0, 0, 0];
    for (const p of pts) { cen[0] += p[0]; cen[1] += p[1]; cen[2] += p[2]; }
    cen[0] /= pts.length; cen[1] /= pts.length; cen[2] /= pts.length;
    list.push({ pts, c, n, nf: normalFactor(n), cen, ...extra });
  }
  // World-space wall quad. side N/S: a = x ; W/E: a = y.
  wallPts(side, a0, a1, z0, z1, e) {
    const r = this.rect;
    if (a0 > a1) [a0, a1] = [a1, a0];
    if (side === 'N') { const y = r.y + e; return [[a0, y, z0], [a1, y, z0], [a1, y, z1], [a0, y, z1]]; }
    if (side === 'S') { const y = r.y + r.h - e; return [[a0, y, z0], [a1, y, z0], [a1, y, z1], [a0, y, z1]]; }
    if (side === 'W') { const x = r.x + e; return [[x, a0, z0], [x, a1, z0], [x, a1, z1], [x, a0, z1]]; }
    const x = r.x + r.w - e; return [[x, a0, z0], [x, a1, z0], [x, a1, z1], [x, a0, z1]];
  }
  static wallN(side) { return side === 'N' ? [0, 1, 0] : side === 'S' ? [0, -1, 0] : side === 'W' ? [1, 0, 0] : [-1, 0, 0]; }
  // Decal on a wall in world coordinates.
  wdecalW(side, a0, a1, z0, z1, c, extra = {}, e = 0.012) {
    this.quad(this.decals, this.wallPts(side, a0, a1, z0, z1, e), c, Builder.wallN(side), extra);
  }
  // Decal on a wall in local coordinates.
  wdecal(s, a0, a1, z0, z1, c, extra = {}, e = 0.012) {
    this.wdecalW(this.side(s), this.wa(s, a0), this.wa(s, a1), z0, z1, c, extra, e);
  }
  floorDecal(u0, v0, u1, v1, c, extra = {}) {
    const x0 = this.X(u0), x1 = this.X(u1), ya = this.Y(v0), yb = this.Y(v1);
    const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
    this.quad(this.decals, [[x0, y0, 0.006], [x1, y0, 0.006], [x1, y1, 0.006], [x0, y1, 0.006]], c, [0, 0, 1], extra);
  }
  window(s, a0, a1, z0 = 1.0, z1 = 2.4) {
    const side = this.side(s);
    const A0 = this.wa(s, a0), A1 = this.wa(s, a1);
    this.wdecalW(side, A0 - 0.06, A1 + 0.06, z0 - 0.08, z1 + 0.06, [235, 235, 230], {}, 0.01);
    this.wdecalW(side, A0, A1, z0, z1, 'sky', { em: 'sky' }, 0.016);
    const lo = Math.min(A0, A1), hi = Math.max(A0, A1);
    const panes = Math.max(2, Math.round((hi - lo) / 0.8));
    for (let i = 1; i < panes; i++) {
      const a = lo + (hi - lo) * i / panes;
      this.wdecalW(side, a - 0.025, a + 0.025, z0, z1, [90, 96, 100], {}, 0.02);
    }
    this.wdecalW(side, lo, hi, (z0 + z1) / 2 + 0.25, (z0 + z1) / 2 + 0.29, [90, 96, 100], {}, 0.02);
    const r = this.rect;
    if (side === 'N') this.winPlanes.push({ a: 1, v: r.y });
    else if (side === 'S') this.winPlanes.push({ a: 1, v: r.y + r.h });
    else if (side === 'W') this.winPlanes.push({ a: 0, v: r.x });
    else this.winPlanes.push({ a: 0, v: r.x + r.w });
  }
  doorW(side, a0, a1, lit) {
    this.wdecalW(side, a0 - 0.08, a1 + 0.08, 0, 2.2, [78, 66, 54], {}, 0.01);
    this.wdecalW(side, a0, a1, 0, 2.12, [134, 94, 58], {}, 0.016);
    this.wdecalW(side, (a0 + a1) / 2 - 0.015, (a0 + a1) / 2 + 0.015, 0, 2.12, [70, 50, 34], {}, 0.02);
    const glass = lit ? [236, 222, 186] : [36, 38, 44];
    this.wdecalW(side, a0 + 0.25, a0 + 0.55, 1.3, 1.85, glass, { em: lit ? 'always' : undefined }, 0.02);
    this.wdecalW(side, a1 - 0.55, a1 - 0.25, 1.3, 1.85, glass, { em: lit ? 'always' : undefined }, 0.02);
    this.wdecalW(side, a0 + 0.12, a0 + 0.2, 0.95, 1.05, [200, 200, 196], {}, 0.024);
  }
  lamp(u, v, len = 1.2, alongU = true) {
    const hu = alongU ? len / 2 : 0.09, hv = alongU ? 0.09 : len / 2;
    const xs = [this.X(u - hu), this.X(u + hu)], ya = this.Y(v - hv), yb = this.Y(v + hv);
    const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb), z = this.ceil - 0.015;
    this.quad(this.decals, [[xs[0] - 0.05, y0 - 0.05, z + 0.005], [xs[1] + 0.05, y0 - 0.05, z + 0.005], [xs[1] + 0.05, y1 + 0.05, z + 0.005], [xs[0] - 0.05, y1 + 0.05, z + 0.005]], [200, 200, 196], [0, 0, -1]);
    this.quad(this.decals, [[xs[0], y0, z], [xs[1], y0, z], [xs[1], y1, z], [xs[0], y1, z]], [120, 122, 124], [0, 0, -1], { em: 'lamp' });
  }
  fan(u, v) { this.fans.push([this.X(u), this.Y(v), this.rng() * 6.28]); }

  // Furniture: local box (u along x, v from the outer wall).
  box(u0, v0, u1, v1, z0, z1, c, o = {}) {
    const x0 = this.X(Math.min(u0, u1)), x1 = this.X(Math.max(u0, u1));
    const ya = this.Y(v0), yb = this.Y(v1);
    const b = [x0, Math.min(ya, yb), z0, x1, Math.max(ya, yb), z1];
    const fm = this.faceMap();
    const mapObj = (obj) => obj && Object.fromEntries(Object.entries(obj).map(([k, val]) => [fm[k] || k, val]));
    const item = { k: 'box', b, c, top: o.top, cf: mapObj(o.cf), em: mapObj(o.em), shadow: o.shadow !== false && z0 < 0.02 };
    if (o.decals) item.decals = o.decals.map((d) => ({ ...d, f: fm[d.f] || d.f }));
    if (o.leds) item.leds = o.leds.map((d) => ({ ...d, f: fm[d.f] || d.f }));
    item.cen = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    this.furn.push(item);
    return item;
  }
  // World-space box.
  boxW(x0, y0, x1, y1, z0, z1, c, o = {}) {
    const b = [Math.min(x0, x1), Math.min(y0, y1), z0, Math.max(x0, x1), Math.max(y0, y1), z1];
    const item = { k: 'box', b, c, top: o.top, cf: o.cf, em: o.em, decals: o.decals, leds: o.leds, shadow: o.shadow !== false && z0 < 0.02 };
    item.cen = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    this.furn.push(item);
    return item;
  }
  faceMap() {
    return { 'u-': 'x-', 'u+': 'x+', 'v-': this.top ? 'y-' : 'y+', 'v+': this.top ? 'y+' : 'y-', top: 'z+' };
  }
  blob(u, v, z, r, c) { this.furn.push({ k: 'blob', p: [this.X(u), this.Y(v), z], r, c, cen: [this.X(u), this.Y(v), z] }); }
  plant(u, v, h = 1.0) {
    this.box(u - 0.2, v - 0.2, u + 0.2, v + 0.2, 0, 0.42, [150, 92, 60], { top: [70, 50, 34] });
    this.blob(u, v, h, 0.42, [62, 128, 64]);
  }
  chair(u, v, c = [60, 64, 72], backSide = 'u-') {
    this.box(u - 0.22, v - 0.22, u + 0.22, v + 0.22, 0.42, 0.48, c, { shadow: false });
    this.box(u - 0.04, v - 0.04, u + 0.04, v + 0.04, 0, 0.42, DARK, { shadow: true });
    if (backSide === 'u-') this.box(u - 0.26, v - 0.22, u - 0.2, v + 0.22, 0.48, 0.92, c);
    else if (backSide === 'u+') this.box(u + 0.2, v - 0.22, u + 0.26, v + 0.22, 0.48, 0.92, c);
    else if (backSide === 'v-') this.box(u - 0.22, v - 0.26, u + 0.22, v - 0.2, 0.48, 0.92, c);
    else this.box(u - 0.22, v + 0.2, u + 0.22, v + 0.26, 0.48, 0.92, c);
  }
  table(u0, v0, u1, v1, h = 0.75, c = WOOD) {
    this.box(u0, v0, u1, v1, h - 0.05, h, c, { shadow: false });
    const lw = 0.06;
    for (const [a, b] of [[u0 + 0.05, v0 + 0.05], [u1 - 0.05 - lw, v0 + 0.05], [u0 + 0.05, v1 - 0.05 - lw], [u1 - 0.05 - lw, v1 - 0.05 - lw]]) {
      this.box(a, b, a + lw, b + lw, 0, h - 0.05, mul(c, 0.7), { shadow: false });
    }
    // Soft shadow under the table top.
    this.floorDecal(u0 + 0.05, v0 + 0.05, u1 - 0.05, v1 - 0.05, [0, 0, 0], { alpha: 0.16 });
  }
  monitor(u, v, facing = 'u-') {
    // Thin screen facing the seated user, emissive when powered.
    if (facing === 'u-') {
      this.box(u, v - 0.27, u + 0.05, v + 0.27, 0.82, 1.16, [30, 32, 36], {
        shadow: false,
        decals: [{ f: 'u-', s0: 0.05, s1: 0.95, t0: 0.08, t1: 0.94, c: [70, 132, 210], em: 'screen' }],
      });
      this.box(u + 0.01, v - 0.05, u + 0.04, v + 0.05, 0.76, 0.82, [30, 32, 36], { shadow: false });
    } else {
      this.box(u - 0.27, v, u + 0.27, v + 0.05, 0.82, 1.16, [30, 32, 36], {
        shadow: false,
        decals: [{ f: facing, s0: 0.05, s1: 0.95, t0: 0.08, t1: 0.94, c: [70, 132, 210], em: 'screen' }],
      });
    }
  }

  shellRoom() {
    const r = this.rect, p = this.pal;
    // Floor tiles with subtle pattern + ambient occlusion near walls.
    for (let i = 0; i < r.w; i++) {
      for (let j = 0; j < r.h; j++) {
        const x = r.x + i, y = r.y + j;
        let k = 1;
        if (p.pattern === 'checker') k = (i + j) % 2 ? 0.94 : 1.02;
        else if (p.pattern === 'planks') k = 0.9 + 0.12 * ((Math.sin(j * 12.9898 + i * 0.3) * 43758.5453) % 1 + 1) % 1;
        else if (p.pattern === 'marble') k = (i + j) % 2 ? 0.95 : 1.03;
        else if (p.pattern === 'concrete') k = 0.94 + this.rng() * 0.1;
        else if (p.pattern === 'carpet') k = 0.97 + this.rng() * 0.05;
        else if (p.pattern === 'raised') k = 1;
        const dw = Math.min(i + 0.5, r.w - i - 0.5, j + 0.5, r.h - j - 0.5);
        const ao = 1 - 0.22 * Math.exp(-dw / 0.8);
        const grout = p.pattern === 'checker' || p.pattern === 'raised' || p.pattern === 'marble' ? 'grout' : 'seam';
        this.quad(this.shell, [[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]], mul(p.floor, k), [0, 0, 1], { ao, [grout]: true });
      }
    }
    // Walls: skirting, dado band, paint, split into 1 m strips for falloff.
    const walls = [['N', r.x, r.x + r.w], ['S', r.x, r.x + r.w], ['W', r.y, r.y + r.h], ['E', r.y, r.y + r.h]];
    for (const [side, a0, a1] of walls) {
      const n = Builder.wallN(side);
      for (let a = a0; a < a1; a++) {
        const b = Math.min(a + 1, a1);
        this.quad(this.shell, this.wallPts(side, a, b, 0, 0.1, 0), mul(p.dado, 0.6), n, { seam: true });
        this.quad(this.shell, this.wallPts(side, a, b, 0.1, 1.05, 0), p.dado, n, { seam: true });
        this.quad(this.shell, this.wallPts(side, a, b, 1.05, this.ceil, 0), p.wall, n, { seam: true });
      }
    }
    // Ceiling in 2 m panels.
    for (let i = 0; i < r.w; i += 2) {
      for (let j = 0; j < r.h; j += 2.5) {
        const x0 = r.x + i, y0 = r.y + j, x1 = Math.min(r.x + r.w, x0 + 2), y1 = Math.min(r.y + r.h, y0 + 2.5);
        const C = this.ceil;
        this.quad(this.shell, [[x0, y0, C], [x1, y0, C], [x1, y1, C], [x0, y1, C]], p.ceil, [0, 0, -1], { grout: true });
      }
    }
  }

  roomDoors(room, litCorridor = true) {
    const side = this.side('door');
    for (let i = 0; i + 1 < room.doors.length; i += 2) {
      const d = room.doors[i];
      this.doorW(side, d.x, d.x + 2, litCorridor);
    }
  }

  done(extra = {}) {
    return {
      rect: this.rect, type: this.type, top: this.top,
      shell: [...this.shell, ...this.decals], furn: this.furn, fans: this.fans,
      winPlanes: this.winPlanes, winGain: this.winGain, ceil: this.ceil, ...this.extra, ...extra,
    };
  }
}

// ---- seat-driven helpers: seats come from the occupancy layer so desks sit under real seats
const faceTo = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'x+' : 'x-') : (dy > 0 ? 'y+' : 'y-'));
function seatsOf(room) {
  try {
    return (getSeats(room.id) || []).filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)).map((s) => {
      const f = Number.isFinite(s.facing) ? s.facing : (room.top ? -Math.PI / 2 : Math.PI / 2);
      return { x: s.x, y: s.y, dx: Math.round(Math.cos(f)), dy: Math.round(Math.sin(f)) };
    });
  } catch (err) { return []; }
}
// Box centred at (cx, cy): w across the facing direction, d along it.
function boxC(S, cx, cy, w, d, z0, z1, c, o, dx) {
  const along = Math.abs(dx) > 0.5;
  const hx = along ? d / 2 : w / 2, hy = along ? w / 2 : d / 2;
  return S.boxW(cx - hx, cy - hy, cx + hx, cy + hy, z0, z1, c, o);
}
// Seats in the same row and on the same side of the centre aisle form one run.
function seatRows(seats, room, gap = 1.5, maxRun = 99) {
  const rows = new Map();
  for (const s of seats) {
    const key = `${Math.round(s.y * 10)}|${s.dx}|${s.dy}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(s);
  }
  const out = [];
  for (const list of rows.values()) {
    list.sort((a, b) => a.x - b.x);
    let g = null;
    for (const s of list) {
      if (!g || s.x - g.x1 > gap || g.seats.length >= maxRun) {
        g = { x0: s.x, x1: s.x, y: s.y, dx: s.dx, dy: s.dy, seats: [] };
        out.push(g);
      }
      g.x1 = s.x; g.seats.push(s);
    }
  }
  return out;
}
function chairW(S, s, c = [60, 64, 72]) {
  boxC(S, s.x, s.y, 0.42, 0.42, 0.42, 0.48, c, { shadow: false }, s.dx);
  S.boxW(s.x - 0.04, s.y - 0.04, s.x + 0.04, s.y + 0.04, 0, 0.42, DARK);
  boxC(S, s.x - s.dx * 0.22, s.y - s.dy * 0.22, 0.42, 0.06, 0.48, 0.92, c, {}, s.dx);
}
function monitorW(S, x, y, s) {
  boxC(S, x, y, 0.55, 0.05, 0.8, 1.15, [30, 32, 36], {
    shadow: false, decals: [{ f: faceTo(-s.dx, -s.dy), s0: 0.05, s1: 0.95, t0: 0.08, t1: 0.94, c: [70, 132, 210], em: 'screen' }],
  }, s.dx);
}
function seatDesks(S, room, monitors) {
  for (const s of seatsOf(room)) {
    boxC(S, s.x + s.dx * 0.55, s.y + s.dy * 0.55, 1.1, 0.7, 0, 0.76, [150, 150, 146], { top: [196, 170, 130] }, s.dx);
    if (monitors) monitorW(S, s.x + s.dx * 0.75, s.y + s.dy * 0.75, s);
    chairW(S, s, [40, 44, 52]);
  }
}
// Tables shared by four seats at (tx +- 0.6, ty +- 0.55): library, canteen.
function seatTables(S, room, topC, chairC) {
  const seats = seatsOf(room);
  const done = new Set();
  for (const s of seats) {
    if (s.dy <= 0) continue;
    const partner = seats.find((o) => o !== s && o.dy > 0 && Math.abs(o.y - s.y) < 0.05 && Math.abs(o.x - s.x - 1.2) < 0.05);
    if (!partner) continue;
    const tx = s.x + 0.6, ty = s.y + 0.55, k = `${tx.toFixed(1)}|${ty.toFixed(1)}`;
    if (done.has(k)) continue;
    done.add(k);
    S.boxW(tx - 1.05, ty - 0.38, tx + 1.05, ty + 0.38, 0.72, 0.76, topC, { shadow: false });
    S.boxW(tx - 0.95, ty - 0.3, tx - 0.85, ty + 0.3, 0, 0.72, mul(topC, 0.55), { shadow: false });
    S.boxW(tx + 0.85, ty - 0.3, tx + 0.95, ty + 0.3, 0, 0.72, mul(topC, 0.55), { shadow: false });
    S.quad(S.decals, [[tx - 1.0, ty - 0.34, 0.006], [tx + 1.0, ty - 0.34, 0.006], [tx + 1.0, ty + 0.34, 0.006], [tx - 1.0, ty + 0.34, 0.006]], [0, 0, 0], [0, 0, 1], { alpha: 0.16 });
  }
  for (const s of seats) chairW(S, s, typeof chairC === 'function' ? chairC(s) : chairC);
}
function board(S, a0 = 2.4, a1 = 7.6) {
  S.wdecal('outer', a0, a1, 0.92, 2.18, [86, 88, 92]);
  S.wdecal('outer', a0 + 0.1, a1 - 0.1, 0.98, 2.12, [238, 240, 238], {}, 0.018);
  const ink = [[40, 70, 160], [170, 50, 50], [40, 120, 70]];
  for (let i = 0; i < 5; i++) {
    const z = 1.95 - i * 0.17, a = a0 + 0.4 + S.rng() * 0.6, len = 1.0 + S.rng() * 2.2;
    S.wdecal('outer', a, Math.min(a1 - 0.4, a + len), z, z + 0.035, ink[i % ink.length], {}, 0.022);
  }
}

// ---------------------------------------------------------------- layouts

function classroom(S, room) {
  S.window('east', 1.5, 4.3); S.window('east', 5.7, 8.5);
  S.window('door', 0.6, 3.4, 2.25, 2.85); S.window('door', 7.0, 9.4, 2.25, 2.85);
  board(S);
  S.wdecal('door', 4.2, 5.6, 1.3, 2.0, [168, 118, 70]);
  S.wdecal('door', 4.3, 4.8, 1.45, 1.85, [236, 232, 220], {}, 0.02);
  S.wdecal('door', 4.95, 5.45, 1.4, 1.75, [210, 226, 236], {}, 0.02);
  S.roomDoors(room);
  S.box(6.4, 0.9, 7.9, 1.6, 0, 0.78, WOOD_D, { top: WOOD });
  for (const r of seatRows(seatsOf(room), room)) {
    const x0 = r.x0 - 0.55, x1 = r.x1 + 0.55;
    S.boxW(x0, r.y + r.dy * 0.22, x1, r.y + r.dy * 0.64, 0.7, 0.75, WOOD, { shadow: false, top: [166, 118, 74] });
    S.boxW(x0 + 0.05, r.y + r.dy * 0.58, x1 - 0.05, r.y + r.dy * 0.64, 0.3, 0.7, WOOD_D);
    S.boxW(x0 + 0.05, r.y - r.dy * 0.2, x1 - 0.05, r.y + r.dy * 0.1, 0.42, 0.46, [96, 98, 104], { shadow: false });
    S.boxW(x0 + 0.15, r.y - r.dy * 0.08, x1 - 0.15, r.y - r.dy * 0.02, 0, 0.42, [60, 62, 66]);
  }
  S.box(9.2, 9.2, 9.6, 9.6, 0, 0.5, [60, 110, 160]);
  for (const u of [2.5, 6.5]) for (const v of [3, 7.5]) S.fan(u, v);
  for (const u of [2.2, 5.2, 8.2]) for (const v of [3.2, 6.8]) S.lamp(u, v);
}

function lab(S, room) {
  S.window('east', 1.5, 4.3);
  S.window('door', 0.6, 3.4, 2.25, 2.85);
  S.roomDoors(room);
  board(S);
  const id = labKind(room);
  const seats = seatsOf(room);
  if (id === 'LAB-3') {
    for (const r of seatRows(seats, room)) {
      const x0 = r.x0 - 0.55, x1 = r.x1 + 0.55;
      S.boxW(x0, r.y + r.dy * 0.2, x1, r.y + r.dy * 0.9, 0.72, 0.76, [220, 222, 220], { shadow: false });
      S.boxW(x0, r.y + r.dy * 0.84, x1, r.y + r.dy * 0.9, 0.25, 0.72, [180, 182, 182]);
      for (const s of r.seats) {
        monitorW(S, s.x, s.y + s.dy * 0.68, s);
        S.boxW(s.x - 0.2, s.y + s.dy * 0.32, s.x + 0.2, s.y + s.dy * 0.48, 0.76, 0.78, [40, 40, 44], { shadow: false });
        chairW(S, s, [50, 70, 130]);
      }
    }
  } else {
    S.wdecal('east', 5.4, 9.0, 1.2, 2.2, [240, 240, 236]);
    const tones = [[200, 70, 60], [70, 140, 200], [230, 200, 60], [90, 170, 90], [160, 90, 170]];
    for (let i = 0; i < 16; i++) {
      const a = 5.5 + (i % 8) * 0.43, z = 1.3 + Math.floor(i / 8) * 0.42;
      S.wdecal('east', a, a + 0.36, z, z + 0.34, tones[i % tones.length], {}, 0.02);
    }
    for (const r of seatRows(seats, room)) {
      const x0 = r.x0 - 0.55, x1 = r.x1 + 0.55;
      const ya = r.y + r.dy * 0.25, yb = r.y + r.dy * 0.95;
      S.boxW(x0, ya, x1, yb, 0, 0.86, [196, 186, 166]);
      S.boxW(x0 - 0.05, ya - r.dy * 0.05, x1 + 0.05, yb + r.dy * 0.05, 0.86, 0.91, [56, 58, 62], { shadow: false });
      const ym = r.y + r.dy * 0.7;
      for (const s of r.seats) {
        const u = s.x;
        if (id === 'LAB-2') {
          [[60, 150, 210], [210, 140, 40], [120, 190, 90]].forEach((c, k) => S.boxW(u - 0.2 + k * 0.14, ym - 0.05, u - 0.11 + k * 0.14, ym + 0.05, 0.91, 1.12, c, { shadow: false }));
        } else if (id === 'LAB-4') {
          S.boxW(u - 0.2, ym - 0.18, u + 0.2, ym + 0.18, 0.91, 1.15, [70, 76, 84], {
            shadow: false, decals: [{ f: faceTo(-s.dx, -s.dy), s0: 0.1, s1: 0.65, t0: 0.25, t1: 0.85, c: [80, 210, 120], em: 'screen' }],
          });
        } else {
          S.boxW(u - 0.18, ym - 0.14, u + 0.12, ym + 0.14, 0.91, 1.05, [70, 110, 170], { shadow: false });
          S.boxW(u + 0.22, ym - 0.03, u + 0.28, ym + 0.03, 0.91, 1.3, STEEL, { shadow: false });
        }
        S.boxW(s.x - 0.16, s.y - 0.16, s.x + 0.16, s.y + 0.16, 0, 0.62, [60, 64, 70], { top: [40, 42, 46] });
      }
    }
    if (id === 'LAB-2') {
      S.box(9.0, 5.6, 9.95, 8.2, 0, 2.35, [214, 216, 214], {
        decals: [{ f: 'u-', s0: 0.08, s1: 0.92, t0: 0.42, t1: 0.92, c: [190, 214, 222], em: 'screen' }],
      });
    }
    S.box(9.45, 1.2, 9.95, 4.4, 0, 2.0, [200, 196, 186], {
      decals: [{ f: 'u-', s0: 0.05, s1: 0.48, t0: 0.5, t1: 0.95, c: [150, 176, 186] }, { f: 'u-', s0: 0.52, s1: 0.95, t0: 0.5, t1: 0.95, c: [150, 176, 186] }],
    });
  }
  for (const u of [2.5, 6.5]) for (const v of [3, 7.5]) S.fan(u, v);
  for (const u of [2.2, 5.2, 8.2]) for (const v of [3.2, 6.8]) S.lamp(u, v);
}

function seminar(S, room) {
  const W = room.w;
  S.window('east', 2, 8);
  S.roomDoors(room);
  // Stage + projection screen on the front (outer) wall.
  S.box(1.6, 0.25, W - 0.4, 1.7, 0, 0.42, [92, 60, 44], { top: [120, 82, 56] });
  S.wdecal('outer', 6.5, 14.5, 0.95, 2.95, [40, 40, 44]);
  S.wdecal('outer', 6.65, 14.35, 1.05, 2.85, [222, 230, 240], { em: 'screen' }, 0.018);
  S.box(15.5, 0.6, 16.1, 1.1, 0.42, 1.5, [100, 68, 46], { top: [130, 90, 60] });
  for (const r of seatRows(seatsOf(room), room)) {
    const x0 = r.x0 - 0.5, x1 = r.x1 + 0.5;
    S.boxW(x0 + 0.05, r.y - 0.18, x1 - 0.05, r.y + 0.18, 0, 0.4, [60, 34, 34]);
    S.boxW(x0, r.y - 0.24, x1, r.y + 0.24, 0.4, 0.48, [150, 42, 48], { shadow: false });
    S.boxW(x0, r.y - r.dy * 0.24, x1, r.y - r.dy * 0.31, 0.4, 0.98, [130, 36, 42], { shadow: false });
  }
  for (let u = 2; u < W; u += 3) for (const v of [2.5, 5, 7.5]) S.lamp(u, v, 1.0);
}

function library(S, room) {
  const W = room.w;
  S.window('outer', 1.5, 5); S.window('outer', 6, 9.5);
  S.window('door', 1.0, 3.6, 2.25, 2.85);
  S.roomDoors(room);
  seatTables(S, room, [176, 128, 82], [120, 80, 50]);
  const bookC = [[150, 40, 40], [40, 80, 140], [200, 160, 60], [60, 120, 70], [220, 220, 210], [110, 60, 120], [30, 30, 34], [200, 100, 50]];
  const books = (rng) => {
    const d = [];
    for (let L = 0; L < 5; L++) {
      const t0 = 0.04 + L * 0.192, th = 0.13 + rng() * 0.035;
      let s = 0.02;
      while (s < 0.96) {
        const sw = 0.05 + rng() * 0.12;
        if (rng() > 0.1) d.push({ f: 'u-', s0: s, s1: Math.min(0.97, s + sw), t0, t1: t0 + th * (0.75 + rng() * 0.25), c: bookC[Math.floor(rng() * bookC.length)] });
        s += sw + 0.008;
      }
    }
    return d;
  };
  const shelf = (u, v0, v1) => S.box(u, v0, u + 0.5, v1, 0, 2.05, [118, 84, 54], { cf: { 'u-': [62, 44, 30] }, top: [132, 96, 62], decals: books(S.rng) });
  for (const u of [9.6, 11.0]) { shelf(u, 1.0, 4.3); shelf(u, 5.7, 9.0); }
  for (const [v0, v1] of [[0.5, 3.2], [3.4, 6.1], [6.3, 9.0]]) shelf(W - 0.55, v0, v1);
  S.box(15.8, 9.0, 18.4, 9.6, 0, 1.0, [110, 76, 50], { top: [176, 128, 82] });
  for (let u = 2; u < W; u += 3) for (const v of [2.5, 7.5]) S.lamp(u, v, 1.2);
}

function office(S, room) {
  S.window('east', 1.5, 4.5); S.window('east', 5.5, 8.5);
  S.roomDoors(room);
  if (room.id === 'STAFF-1') {
    S.wdecal('outer', 3.0, 7.0, 1.2, 2.0, [168, 118, 70]);
    seatDesks(S, room, false);
    for (let v = 6.2; v < 9.2; v += 0.75) S.box(9.45, v, 9.95, v + 0.7, 0, 1.9, [168, 172, 176], { decals: [{ f: 'u-', s0: 0.75, s1: 0.85, t0: 0.5, t1: 0.56, c: [60, 60, 60] }] });
  } else {
    S.wdecal('outer', 3.0, 7.0, 1.2, 2.0, [210, 214, 220]);
    seatDesks(S, room, true);
    for (let v = 1.0; v < 5.0; v += 0.6) S.box(9.35, v, 9.95, v + 0.55, 0, 1.35, [150, 156, 160], { decals: [{ f: 'u-', s0: 0.3, s1: 0.7, t0: 0.7, t1: 0.75, c: [70, 70, 70] }, { f: 'u-', s0: 0.3, s1: 0.7, t0: 0.35, t1: 0.4, c: [70, 70, 70] }] });
  }
  S.plant(0.7, 9.3, 1.0);
  for (const u of [2.5, 6.5]) for (const v of [3, 7.5]) S.fan(u, v);
  for (const u of [2.5, 7.5]) for (const v of [3, 7]) S.lamp(u, v);
}

function lobby(S, room) {
  S.window('outer', 1.0, 9.0, 0.2, 2.7);
  S.roomDoors(room);
  // Feature wall with the block name strip.
  S.wdecal('east', 2.0, 8.0, 1.0, 2.6, [38, 46, 58]);
  S.wdecal('east', 2.4, 7.6, 1.95, 2.05, [245, 179, 1], { em: 'always' }, 0.02);
  S.wdecal('east', 3.4, 6.6, 1.55, 1.8, [230, 236, 240], { em: 'always' }, 0.02);
  // Reception counter.
  S.box(6.6, 3.2, 7.5, 7.2, 0, 1.05, [120, 80, 50], { top: [214, 206, 196], decals: [{ f: 'u-', s0: 0.05, s1: 0.95, t0: 0.7, t1: 0.78, c: [245, 179, 1] }] });
  S.monitor(7.2, 4.4);
  S.chair(8.3, 5.2, [40, 44, 52], 'u+');
  // Sofas and coffee table.
  for (const v0 of [1.4, 7.6]) {
    S.box(1.6, v0, 4.0, v0 + 0.8, 0, 0.42, [60, 80, 110]);
    S.box(1.6, v0 + (v0 < 5 ? -0.25 : 0.8), 4.0, v0 + (v0 < 5 ? 0 : 1.05), 0, 0.85, [52, 70, 98]);
  }
  S.table(2.1, 4.2, 3.5, 5.6, 0.42, [150, 110, 76]);
  S.plant(0.7, 0.8, 1.0); S.plant(9.2, 0.8, 1.1); S.plant(9.2, 9.0, 1.0);
  S.box(5.0, 8.6, 5.6, 9.0, 0, 1.5, [230, 232, 228], { decals: [{ f: 'v-', s0: 0.1, s1: 0.9, t0: 0.5, t1: 0.9, c: [60, 120, 190] }] });
  for (const u of [2, 5, 8]) for (const v of [2.5, 7.5]) S.lamp(u, v, 0.6);
}

function server(S, room) {
  S.winGain = 0;
  S.roomDoors(room);
  const rack = (u, v0, v1, frontFace) => {
    const decals = [], leds = [];
    for (let i = 0; i < 9; i++) {
      const t0 = 0.08 + i * 0.095;
      decals.push({ f: frontFace, s0: 0.08, s1: 0.92, t0, t1: t0 + 0.07, c: [62, 66, 72] });
      leds.push({ f: frontFace, s: 0.15, t: t0 + 0.035, c: i % 3 ? [80, 255, 140] : [255, 190, 60] });
      leds.push({ f: frontFace, s: 0.22, t: t0 + 0.035, c: [80, 200, 255] });
    }
    S.box(u, v0, u + 0.62, v1, 0, 2.1, [28, 30, 34], { top: [40, 42, 46], decals, leds });
  };
  for (let u = 1.6; u < 7.8; u += 0.66) {
    rack(u, 2.0, 3.0, 'v-');
    rack(u, 5.8, 6.8, 'v-');
  }
  S.box(1.6, 2.3, 7.6, 2.7, 2.5, 2.56, [130, 132, 136], { shadow: false });
  S.box(1.6, 6.1, 7.6, 6.5, 2.5, 2.56, [130, 132, 136], { shadow: false });
  S.box(9.0, 1.0, 9.95, 3.6, 0, 2.2, [214, 216, 218], {
    decals: [{ f: 'u-', s0: 0.1, s1: 0.9, t0: 0.55, t1: 0.9, c: [150, 154, 158] }, { f: 'u-', s0: 0.6, s1: 0.85, t0: 0.4, t1: 0.47, c: [60, 200, 255], em: 'screen' }],
  });
  S.box(9.0, 6.0, 9.95, 8.6, 0, 2.2, [214, 216, 218], {
    decals: [{ f: 'u-', s0: 0.1, s1: 0.9, t0: 0.55, t1: 0.9, c: [150, 154, 158] }, { f: 'u-', s0: 0.6, s1: 0.85, t0: 0.4, t1: 0.47, c: [60, 200, 255], em: 'screen' }],
  });
  S.floorDecal(1.2, 3.6, 8.4, 3.75, [220, 190, 40]);
  S.floorDecal(1.2, 5.05, 8.4, 5.2, [220, 190, 40]);
  for (const u of [2.5, 5.5, 8.5]) for (const v of [1.5, 4.4, 7.5]) S.lamp(u, v, 1.0);
}

function electrical(S, room) {
  S.window('outer', 2, 4, 1.8, 2.5);
  S.roomDoors(room);
  // Panel line-up on the east wall.
  for (let v = 0.8; v < 8.8; v += 1.0) {
    const leds = [{ f: 'u-', s: 0.3, t: 0.82, c: [80, 255, 120] }, { f: 'u-', s: 0.45, t: 0.82, c: [255, 80, 70] }, { f: 'u-', s: 0.6, t: 0.82, c: [255, 190, 60] }];
    S.box(9.3, v, 9.95, v + 0.96, 0, 2.15, [196, 198, 192], {
      top: [180, 182, 176],
      decals: [{ f: 'u-', s0: 0.08, s1: 0.92, t0: 0.08, t1: 0.7, c: [176, 178, 172] }, { f: 'u-', s0: 0.2, s1: 0.8, t0: 0.74, t1: 0.78, c: [50, 52, 56] }],
      leds,
    });
  }
  // Battery cabinets (BAT-1).
  for (let u = 2.2; u < 7.4; u += 1.25) {
    S.box(u, 4.3, u + 1.15, 5.1, 0, 1.9, [226, 228, 224], {
      decals: [{ f: 'v-', s0: 0.1, s1: 0.9, t0: 0.78, t1: 0.86, c: [70, 160, 90] }, { f: 'v+', s0: 0.1, s1: 0.9, t0: 0.78, t1: 0.86, c: [70, 160, 90] }],
      leds: [{ f: 'v-', s: 0.2, t: 0.7, c: [90, 255, 120] }, { f: 'v+', s: 0.2, t: 0.7, c: [90, 255, 120] }],
    });
  }
  S.floorDecal(2.0, 3.8, 7.6, 3.95, [230, 190, 30]);
  S.floorDecal(2.0, 5.45, 7.6, 5.6, [230, 190, 30]);
  S.box(0.5, 9.3, 0.8, 9.6, 0, 0.7, [200, 40, 40]);
  S.wdecal('door', 0.6, 2.0, 1.5, 2.1, [240, 210, 40]);
  for (const u of [2.5, 6.5]) for (const v of [2.5, 7.5]) S.lamp(u, v, 1.2);
}

function corridor(S, floor, state) {
  const r = floor.corridor;
  S.winGain = 0.5;
  const lit = (id) => !!state?.rooms?.[id]?.lightsOn;
  for (const room of floor.rooms) {
    for (let i = 0; i + 1 < room.doors.length; i += 2) {
      const d = room.doors[i];
      const side = d.y < r.y ? 'N' : d.y >= r.y + r.h ? 'S' : null;
      if (!side) continue;
      if (room.type === 'core') {
        S.wdecalW(side, d.x - 0.1, d.x + 2.1, 0, 2.3, [70, 72, 76], {}, 0.01);
        S.wdecalW(side, d.x, d.x + 2, 0, 2.2, [52, 56, 62], {}, 0.016);
        S.wdecalW(side, d.x + 0.3, d.x + 1.7, 2.35, 2.55, [60, 200, 90], { em: 'always' }, 0.016);
      } else {
        S.doorW(side, d.x, d.x + 2, lit(room.id));
        // Room name plate.
        S.wdecalW(side, d.x + 2.2, d.x + 2.8, 1.5, 1.7, [40, 60, 90], {}, 0.016);
      }
    }
  }
  // Notice boards, extinguishers, benches between doors.
  for (const x of [9.5, 20.5, 31.5]) {
    S.wdecalW('N', x - 0.7, x + 0.7, 1.2, 2.0, [168, 118, 70]);
    S.wdecalW('N', x - 0.6, x - 0.1, 1.35, 1.85, [236, 232, 220], {}, 0.02);
    S.wdecalW('N', x + 0.05, x + 0.55, 1.4, 1.8, [214, 228, 238], {}, 0.02);
    S.boxW(x - 0.8, r.y + r.h - 0.45, x + 0.8, r.y + r.h - 0.05, 0.4, 0.46, WOOD);
    S.boxW(x - 0.7, r.y + r.h - 0.4, x - 0.6, r.y + r.h - 0.1, 0, 0.4, DARK);
    S.boxW(x + 0.6, r.y + r.h - 0.4, x + 0.7, r.y + r.h - 0.1, 0, 0.4, DARK);
  }
  for (const x of [11.3, 33.3]) S.boxW(x, r.y + 0.05, x + 0.22, r.y + 0.25, 0.3, 0.9, [200, 36, 36]);
  S.boxW(43.5, r.y + 0.05, 44.2, r.y + 0.6, 0, 1.3, [220, 224, 228], { decals: [{ f: 'y+', s0: 0.2, s1: 0.8, t0: 0.7, t1: 0.85, c: [60, 140, 220] }] });
  // End wall window.
  S.window('east', 0.8, 4.2, 0.9, 2.6);
  for (let x = 3; x < r.x + r.w; x += 3) S.lamp(x - r.x, 2.5, 1.2, true);
}

// ---------------------------------------------------------------- NHCE room types

function labKind(room) {
  const n = `${room.id} ${room.name}`;
  if (/programming|systems|ai & ml|aiml|ise lab|mca|cad|computer/i.test(n)) return 'LAB-3';
  if (/chem/i.test(n)) return 'LAB-2';
  if (/ece|micro|analog|idea|coe|skill|survey|electronic/i.test(n)) return 'LAB-4';
  return 'LAB-1';
}

// 700-seat hall: tiered rows facing a stage + screen. Uses the sim's seats when
// it provides them (flat rows, stage on the wall they face), else its own tiers.
function auditorium(S, room) {
  const W = room.w, H = room.h;
  S.winGain = 0.1;
  S.roomDoors(room);
  for (let a = 1; a < W - 1; a += 2.6) {
    S.wdecal('outer', a, a + 1.8, 1.0, 5.6, [104, 66, 46]);
    S.wdecal('door', a, a + 1.8, 2.4, 5.6, [104, 66, 46]);
  }
  for (let u = 3; u < W - 6; u += 4) for (const v of [2.5, 7.5]) S.lamp(u, v, 0.5);
  const seats = seatsOf(room);
  let side = 'east';
  if (seats.length) {
    let dx = 0, dy = 0;
    for (const s of seats) { dx += s.dx; dy += s.dy; }
    if (Math.abs(dy) > Math.abs(dx)) {
      const towardOuter = room.top ? dy < 0 : dy > 0;
      side = towardOuter ? 'outer' : 'door';
    } else side = dx > 0 ? 'east' : 'west';
  }
  const curtain = [130, 24, 34];
  if (side === 'east') {
    S.box(W - 6, 0.3, W, H - 0.3, 0, 1.0, [66, 44, 32], { top: [112, 78, 52] });
    S.wdecal('east', 0.4, H - 0.4, 1.0, 6.6, [24, 24, 28]);
    S.wdecal('east', 1.6, H - 1.6, 2.0, 5.6, [214, 224, 238], { em: 'screen' }, 0.018);
    S.wdecal('east', 2.4, 5.4, 3.0, 4.8, [40, 90, 170], { em: 'screen' }, 0.024);
    S.wdecal('east', 5.8, 7.6, 3.2, 3.5, [245, 179, 1], { em: 'screen' }, 0.024);
    S.wdecal('east', 5.8, 7.2, 3.8, 4.0, [230, 236, 240], { em: 'screen' }, 0.024);
    S.wdecal('east', 0.4, 1.5, 1.0, 6.6, curtain, {}, 0.02);
    S.wdecal('east', H - 1.5, H - 0.4, 1.0, 6.6, curtain, {}, 0.02);
    S.box(W - 4.8, 6.6, W - 4.2, 7.3, 1.0, 2.15, [96, 64, 44], { top: [130, 90, 60] });
    S.box(W - 4.75, 6.75, W - 4.65, 7.15, 2.15, 2.2, [40, 40, 44], { shadow: false });
    for (const v of [0.6, H - 1.3]) S.box(W - 6.6, v, W - 6.0, v + 0.7, 0, 1.8, [30, 30, 34], { decals: [{ f: 'u-', s0: 0.2, s1: 0.8, t0: 0.55, t1: 0.85, c: [60, 60, 66] }] });
  } else {
    const s0 = side === 'outer' ? 'outer' : side === 'door' ? 'door' : 'west';
    if (s0 === 'outer') {
      S.box(W * 0.2, 0.15, W * 0.8, 2.3, 0, 0.9, [66, 44, 32], { top: [112, 78, 52] });
      S.box(W * 0.62, 1.2, W * 0.62 + 0.6, 1.8, 0.9, 2.05, [96, 64, 44], { top: [130, 90, 60] });
      for (const a of [W * 0.2 - 0.8, W * 0.8 + 0.2]) S.box(a, 0.3, a + 0.6, 0.9, 0, 1.8, [30, 30, 34]);
    }
    S.wdecal(s0, W * 0.2, W * 0.8, 0.9, 6.6, [24, 24, 28]);
    S.wdecal(s0, W * 0.3, W * 0.7, 1.8, 5.6, [214, 224, 238], { em: 'screen' }, 0.018);
    S.wdecal(s0, W * 0.34, W * 0.5, 2.8, 4.6, [40, 90, 170], { em: 'screen' }, 0.024);
    S.wdecal(s0, W * 0.53, W * 0.66, 3.6, 3.9, [245, 179, 1], { em: 'screen' }, 0.024);
    S.wdecal(s0, W * 0.53, W * 0.63, 3.0, 3.2, [230, 236, 240], { em: 'screen' }, 0.024);
    S.wdecal(s0, W * 0.2, W * 0.27, 0.9, 6.6, curtain, {}, 0.02);
    S.wdecal(s0, W * 0.73, W * 0.8, 0.9, 6.6, curtain, {}, 0.02);
  }
  // High camera at the back of the hall, looking at the stage.
  if (side === 'east') {
    S.extra.camZ = 6.0; S.extra.pitch = 0.24; S.extra.depthMode = 'forward';
    S.extra.camXY = [room.x + 0.5, room.y + H / 2]; S.extra.yaw = 0; S.extra.fov = 1.25;
  } else {
    const back = side === 'outer' ? S.Y(H - 0.4) : S.Y(0.4), front = side === 'outer' ? S.Y(1.0) : S.Y(H - 1.0);
    S.extra.camZ = 6.0; S.extra.pitch = 0.3; S.extra.fov = 1.5;
    S.extra.camXY = [room.x + 0.8, back];
    S.extra.yaw = Math.atan2(front - back, W * 0.42);
  }
  if (seats.length) {
    for (const r of seatRows(seats, room, 0.9, 4)) {
      const x0 = r.x0 - 0.26, x1 = r.x1 + 0.26;
      S.boxW(x0, r.y - 0.22, x1, r.y + 0.22, 0.4, 0.47, [150, 36, 44], { shadow: false });
      S.boxW(x0, r.y - r.dy * 0.22, x1, r.y - r.dy * 0.28, 0.4, 0.98, [128, 30, 38]);
    }
    return;
  }
  // Own tiered rows facing the east stage.
  const u0 = 2.6, u1 = W - 7.2, rowW = 0.92;
  const rowTz = (i) => Math.max(0, (u1 - (u0 + i * rowW)) * 0.05);
  const rows = Math.floor((u1 - u0) / rowW);
  const risers = [];
  for (let i = 0; i < rows; i++) {
    const u = u0 + i * rowW, tz = rowTz(i);
    if (tz > 0.02) risers.push([u, tz]);
    for (const [v0, v1] of [[0.6, 4.4], [5.6, 9.4]]) {
      S.box(u + 0.42, v0 + 0.05, u + 0.72, v1 - 0.05, tz, tz + 0.4, [44, 26, 26], { shadow: false });
      S.box(u + 0.32, v0, u + 0.8, v1, tz + 0.4, tz + 0.48, [160, 38, 46], { shadow: false });
      S.box(u + 0.26, v0, u + 0.33, v1, tz + 0.4, tz + 1.0, [134, 30, 38], { shadow: false });
    }
  }
  // Tiers are part of the floor (drawn from the stage backwards) so they never
  // sort in front of the audience.
  for (const [u, tz] of risers.reverse()) {
    const x0 = room.x + u, x1 = x0 + rowW, y0 = room.y + 0.25, y1 = room.y + H - 0.25;
    S.quad(S.decals, [[x0, y0, tz], [x1, y0, tz], [x1, y1, tz], [x0, y1, tz]], [112, 50, 48], [0, 0, 1], { seam: true });
  }
  S.extra.floorZ = (x, y) => {
    const u = x - room.x;
    if (u < u0 || u >= u0 + rows * rowW) return 0;
    return rowTz(Math.floor((u - u0) / rowW));
  };
}

function workshop(S, room) {
  const W = room.w, id = room.id;
  S.window('outer', 1.5, Math.min(W - 1, 4.5)); S.window('outer', 5.5, Math.min(W - 0.5, 8.5));
  S.roomDoors(room);
  // Tool board + safety notice.
  S.wdecal('east', 1.0, 5.0, 1.1, 2.2, [70, 74, 80]);
  for (let i = 0; i < 10; i++) {
    const a = 1.25 + (i % 5) * 0.75, z = 1.25 + Math.floor(i / 5) * 0.5;
    S.wdecal('east', a, a + 0.12 + (i % 3) * 0.12, z, z + 0.32, [190, 192, 196], {}, 0.02);
  }
  S.wdecal('east', 6.0, 7.6, 1.4, 2.2, [240, 200, 30]);
  S.wdecal('east', 6.15, 7.45, 1.55, 2.05, [30, 30, 30], {}, 0.02);
  const green = [62, 120, 96], blue = [50, 90, 150], grey = [150, 154, 158];
  const lathe = (u, v) => {
    S.box(u, v, u + 2.0, v + 0.55, 0, 0.75, green, { top: mul(green, 1.1) });
    S.box(u, v + 0.05, u + 0.55, v + 0.5, 0.75, 1.25, green);
    S.box(u + 0.55, v + 0.18, u + 0.68, v + 0.38, 0.92, 1.08, [180, 182, 186], { shadow: false });
    S.box(u + 1.6, v + 0.12, u + 1.9, v + 0.42, 0.75, 1.05, green, { shadow: false });
    S.box(u + 0.7, v + 0.08, u + 1.55, v + 0.47, 0.75, 0.82, [110, 112, 116], { shadow: false });
  };
  const drill = (u, v) => {
    S.box(u, v, u + 0.6, v + 0.6, 0, 0.12, grey);
    S.box(u + 0.22, v + 0.4, u + 0.36, v + 0.54, 0.12, 1.75, grey);
    S.box(u + 0.12, v + 0.15, u + 0.46, v + 0.6, 1.4, 1.75, blue, { shadow: false });
    S.box(u + 0.15, v + 0.1, u + 0.45, v + 0.4, 0.8, 0.85, [90, 92, 96], { shadow: false });
  };
  const bench = (u, v, len) => {
    S.box(u, v, u + len, v + 0.75, 0, 0.88, [120, 104, 80], { top: [150, 120, 84] });
    for (let k = 0.4; k < len - 0.2; k += 1.4) S.box(u + k, v + 0.05, u + k + 0.22, v + 0.2, 0.88, 1.02, [60, 80, 120], { shadow: false });
  };
  if (/EEE/.test(id)) {
    // Motor-generator sets on plinths with control panels.
    for (const [u, v] of [[1.6, 2.2], [4.6, 2.2], [1.6, 6.0], [4.6, 6.0]]) {
      S.box(u, v, u + 2.0, v + 1.0, 0, 0.3, [120, 120, 116]);
      S.box(u + 0.1, v + 0.15, u + 0.95, v + 0.85, 0.3, 0.95, [40, 90, 150], { top: [50, 104, 168] });
      S.box(u + 1.05, v + 0.2, u + 1.9, v + 0.8, 0.3, 0.85, [170, 60, 40], { top: [190, 70, 50] });
    }
    for (const v of [1.4, 4.4, 7.4]) S.box(8.6, v, 9.6, v + 1.2, 0, 1.9, [200, 200, 196], { decals: [{ f: 'u-', s0: 0.15, s1: 0.85, t0: 0.5, t1: 0.85, c: [40, 44, 50] }], leds: [{ f: 'u-', s: 0.3, t: 0.4, c: [255, 80, 70] }, { f: 'u-', s: 0.7, t: 0.4, c: [80, 255, 120] }] });
  } else if (/CV/.test(id)) {
    // Compression testing machine, sieve shaker, curing tank.
    S.box(2, 2, 3.2, 3.0, 0, 0.6, [60, 90, 150]);
    S.box(2.1, 2.1, 2.25, 2.25, 0.6, 2.4, grey); S.box(2.95, 2.75, 3.1, 2.9, 0.6, 2.4, grey);
    S.box(2.0, 2.0, 3.2, 3.0, 2.4, 2.6, [60, 90, 150], { shadow: false });
    S.box(5, 2.2, 5.6, 2.8, 0, 1.1, [200, 120, 40]);
    S.box(1.6, 6.4, 4.6, 8.2, 0, 0.8, [150, 156, 160], { top: [80, 130, 170] });
    bench(5.6, 6.2, 3.6);
  } else if (/FLUID/.test(id)) {
    for (const u of [1.6, 4.4]) {
      S.box(u, 2.0, u + 2.2, 3.0, 0, 1.0, [150, 156, 160]);
      S.box(u + 0.2, 2.1, u + 1.4, 2.9, 1.0, 1.6, [110, 170, 210], { shadow: false });
      S.box(u + 1.6, 2.4, u + 1.7, 2.5, 1.0, 2.2, [90, 120, 160], { shadow: false });
    }
    S.box(1.6, 6.0, 7.5, 6.4, 0.9, 1.05, [70, 110, 160]);
    bench(1.6, 7.4, 4);
  } else {
    // Mechanical workshop: lathes, drills, benches.
    for (let u = 1.6; u < W - 3; u += 3.2) { lathe(u, 2.0); lathe(u, 5.0); }
    for (let u = 2.0; u < W - 2; u += 4.2) drill(u, 7.6);
    bench(W - 1.0 - 0.75 > 0 ? 1.2 : 1, 8.6, Math.min(W - 2.4, 6));
  }
  for (let u = 0.6; u < W - 0.5; u += 0.9) S.floorDecal(u, 4.05, u + 0.45, 4.15, [230, 190, 30]);
  for (let u = 2.5; u < W; u += 4) for (const v of [3, 7.5]) S.lamp(u, v, 1.4);
}

function medical(S, room) {
  S.window('outer', 1.5, 4.5); S.window('east', 1.5, 4.0);
  S.roomDoors(room);
  // Red cross + notice on the door wall.
  S.wdecal('door', 6.0, 7.0, 1.7, 1.9, [210, 40, 40]);
  S.wdecal('door', 6.4, 6.6, 1.3, 2.3, [210, 40, 40], {}, 0.016);
  S.wdecal('door', 7.4, 8.4, 1.3, 2.1, [236, 238, 240]);
  // Beds along the east wall with curtains between them.
  for (const v of [1.0, 3.6, 6.2]) {
    S.box(7.6, v, 9.7, v + 0.95, 0.0, 0.5, [210, 214, 218], { top: [196, 222, 236] });
    S.box(7.65, v + 0.05, 9.65, v + 0.9, 0.5, 0.62, [196, 222, 236], { shadow: false });
    S.box(9.1, v + 0.15, 9.6, v + 0.8, 0.62, 0.74, [250, 250, 250], { shadow: false });
    S.box(9.65, v, 9.75, v + 0.95, 0.5, 1.1, [190, 194, 198], { shadow: false });
    S.box(7.6, v + 1.2, 9.8, v + 1.25, 0.25, 2.2, [170, 210, 196]);
    S.box(7.2, v + 0.3, 7.3, v + 0.4, 0, 1.8, [180, 184, 188]);
  }
  // Doctor's desk + patient chair + cabinet.
  S.box(2.0, 6.2, 3.6, 7.0, 0, 0.76, [150, 150, 146], { top: [210, 200, 180] });
  S.monitor(2.6, 6.6, 'v+');
  S.chair(2.8, 5.6, [40, 90, 140], 'v-');
  S.chair(2.8, 7.6, [60, 64, 72], 'v+');
  S.box(0.4, 1.0, 0.9, 3.4, 0, 1.9, [226, 228, 230], { decals: [{ f: 'u+', s0: 0.05, s1: 0.95, t0: 0.5, t1: 0.95, c: [180, 210, 220] }] });
  S.box(4.4, 1.0, 6.2, 1.7, 0, 0.7, [210, 214, 218], { top: [196, 222, 236] });
  for (const u of [2.5, 6.5]) for (const v of [3, 7.5]) S.lamp(u, v);
}

// CCTV control room. Monitor wall on the east wall; screens are listed in
// `thumbScreens` so the renderer can paint live thumbnails of other cameras.
function security(S, room) {
  S.winGain = 0.15;
  S.roomDoors(room);
  const cols = 4, rows = 3, v0 = 1.2, v1 = 8.8, z0 = 1.05, z1 = 2.95;
  S.wdecal('east', v0 - 0.15, v1 + 0.15, z0 - 0.12, z1 + 0.1, [22, 24, 28]);
  const screens = [];
  const xw = room.x + room.w - 0.03;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const va = v0 + (v1 - v0) * c / cols + 0.05, vb = v0 + (v1 - v0) * (c + 1) / cols - 0.05;
      const za = z1 - (z1 - z0) * (r + 1) / rows + 0.04, zb = z1 - (z1 - z0) * r / rows - 0.04;
      S.wdecal('east', va, vb, za, zb, [30, 60, 90], { em: 'screen' }, 0.02);
      const ya = Math.min(S.Y(va), S.Y(vb)), yb = Math.max(S.Y(va), S.Y(vb));
      // Seen from inside facing +x: left = north (smaller y).
      screens.push({ tl: [xw, ya, zb], tr: [xw, yb, zb], bl: [xw, ya, za] });
    }
  }
  S.extra.thumbScreens = screens;
  // Operator console facing the wall.
  S.box(7.0, 2.0, 7.9, 8.0, 0, 0.76, [60, 64, 70], { top: [92, 96, 104] });
  for (const v of [3.0, 5.0, 7.0]) {
    S.box(7.55, v - 0.3, 7.6, v + 0.3, 0.8, 1.2, [30, 32, 36], { shadow: false, decals: [{ f: 'u-', s0: 0.05, s1: 0.95, t0: 0.1, t1: 0.92, c: [60, 120, 190], em: 'screen' }] });
    S.box(7.1, v - 0.25, 7.3, v + 0.2, 0.76, 0.78, [30, 30, 34], { shadow: false });
    S.chair(6.4, v, [30, 34, 40]);
  }
  S.box(0.4, 8.7, 1.6, 9.5, 0, 2.0, [40, 42, 46], { leds: [{ f: 'u+', s: 0.3, t: 0.7, c: [80, 255, 140] }, { f: 'u+', s: 0.5, t: 0.7, c: [80, 200, 255] }, { f: 'u+', s: 0.7, t: 0.6, c: [255, 190, 60] }, { f: 'v-', s: 0.3, t: 0.7, c: [80, 255, 140] }, { f: 'v-', s: 0.6, t: 0.6, c: [255, 190, 60] }] });
  S.wdecal('door', 1.8, 4.0, 1.2, 2.3, [210, 214, 206]);
  S.wdecal('door', 1.95, 3.85, 1.35, 2.15, [130, 170, 120], {}, 0.02);
  for (const u of [2.5, 6.5]) for (const v of [3, 7]) S.lamp(u, v, 0.8);
}

function gym(S, room) {
  const W = room.w;
  S.window('east', 1.5, 8.5, 1.6, 2.7);
  S.roomDoors(room);
  // Mirror wall at the outer side, treadmills facing it.
  S.wdecal('outer', 0.6, 9.4, 0.3, 2.4, [176, 196, 210], {}, 0.014);
  for (let u = 1.2; u < 9; u += 1.5) {
    S.box(u, 0.9, u + 0.8, 2.7, 0, 0.22, [44, 46, 50]);
    S.box(u + 0.08, 0.95, u + 0.72, 2.6, 0.22, 0.24, [24, 24, 26], { shadow: false });
    S.box(u + 0.05, 0.8, u + 0.12, 1.0, 0.22, 1.3, [70, 72, 78], { shadow: false });
    S.box(u + 0.68, 0.8, u + 0.75, 1.0, 0.22, 1.3, [70, 72, 78], { shadow: false });
    S.box(u + 0.05, 0.75, u + 0.75, 1.0, 1.15, 1.42, [50, 52, 58], { shadow: false, decals: [{ f: 'v+', s0: 0.2, s1: 0.8, t0: 0.3, t1: 0.8, c: [80, 200, 255], em: 'screen' }] });
  }
  // Dumbbell rack + benches.
  S.box(1.0, 6.0, 5.0, 6.5, 0, 0.75, [50, 52, 56]);
  for (let u = 1.15; u < 4.9; u += 0.36) S.box(u, 6.05, u + 0.24, 6.45, 0.75, 0.9, [30, 30, 32], { shadow: false });
  for (const u of [2.0, 4.0]) {
    S.box(u, 7.6, u + 0.35, 8.9, 0.0, 0.45, [40, 40, 44], { top: [170, 30, 40] });
    S.box(u - 0.4, 7.7, u - 0.32, 7.8, 0, 1.6, [120, 124, 130]); S.box(u + 0.67, 7.7, u + 0.75, 7.8, 0, 1.6, [120, 124, 130]);
    S.box(u - 0.6, 7.72, u + 0.95, 7.78, 1.25, 1.3, [160, 164, 170], { shadow: false });
  }
  // Indoor sports half: badminton court + net.
  if (W > 15) {
    const c0 = 11.5, c1 = W - 1.5, ca = 1.6, cb = 8.4;
    const line = [236, 236, 230];
    S.floorDecal(c0, ca, c1, ca + 0.05, line); S.floorDecal(c0, cb - 0.05, c1, cb, line);
    S.floorDecal(c0, ca, c0 + 0.05, cb, line); S.floorDecal(c1 - 0.05, ca, c1, cb, line);
    S.floorDecal((c0 + c1) / 2 - 2, ca, (c0 + c1) / 2 - 1.95, cb, line); S.floorDecal((c0 + c1) / 2 + 1.95, ca, (c0 + c1) / 2 + 2, cb, line);
    S.floorDecal(c0, 5 - 0.025, c1, 5 + 0.025, line);
    const nu = (c0 + c1) / 2;
    S.box(nu - 0.02, ca - 0.3, nu + 0.02, cb + 0.3, 0.8, 1.55, [60, 64, 70], { shadow: false, cf: { 'x-': [220, 224, 228], 'x+': [220, 224, 228] } });
    S.box(nu - 0.04, ca - 0.35, nu + 0.04, ca - 0.27, 0, 1.6, [200, 200, 200]);
    S.box(nu - 0.04, cb + 0.27, nu + 0.04, cb + 0.35, 0, 1.6, [200, 200, 200]);
  }
  for (let u = 2.5; u < W; u += 4) for (const v of [3, 7]) S.lamp(u, v, 1.2);
}

function recreation(S, room) {
  const W = room.w;
  S.window('outer', 2, 8); S.window('outer', 12, 18);
  S.roomDoors(room);
  // Big TV on the east wall.
  S.wdecal('east', 3.2, 6.8, 1.2, 3.0, [20, 20, 24]);
  S.wdecal('east', 3.3, 6.7, 1.3, 2.9, [60, 120, 190], { em: 'screen' }, 0.018);
  S.wdecal('east', 3.6, 5.0, 1.5, 2.3, [90, 180, 90], { em: 'screen' }, 0.022);
  // Table tennis tables.
  const tt = (u, v) => {
    S.box(u, v, u + 2.74, v + 1.52, 0.72, 0.76, [30, 90, 70], {
      shadow: false,
      decals: [
        { f: 'top', s0: 0, s1: 1, t0: 0.485, t1: 0.515, c: [240, 240, 236] },
        { f: 'top', s0: 0, s1: 0.012, t0: 0, t1: 1, c: [240, 240, 236] }, { f: 'top', s0: 0.988, s1: 1, t0: 0, t1: 1, c: [240, 240, 236] },
      ],
    });
    S.box(u + 1.36, v - 0.1, u + 1.38, v + 1.62, 0.76, 0.92, [30, 30, 30], { shadow: false });
    S.box(u + 0.3, v + 0.6, u + 0.4, v + 0.9, 0, 0.72, [40, 40, 44]); S.box(u + 2.34, v + 0.6, u + 2.44, v + 0.9, 0, 0.72, [40, 40, 44]);
    S.floorDecal(u + 0.1, v + 0.1, u + 2.64, v + 1.42, [0, 0, 0], { alpha: 0.14 });
  };
  tt(1.8, 2.0); tt(1.8, 6.0);
  // Carrom boards.
  for (const [u, v] of [[7.5, 2.2], [7.5, 6.4], [10.5, 4.2]]) {
    S.box(u + 0.35, v + 0.35, u + 0.55, v + 0.55, 0, 0.62, [70, 50, 36]);
    S.box(u, v, u + 0.9, v + 0.9, 0.62, 0.7, [110, 70, 40], { shadow: false, decals: [{ f: 'top', s0: 0.08, s1: 0.92, t0: 0.08, t1: 0.92, c: [226, 196, 140] }, { f: 'top', s0: 0.45, s1: 0.55, t0: 0.45, t1: 0.55, c: [190, 40, 40] }] });
    for (const [du, dv] of [[0.45, -0.4], [0.45, 1.3], [-0.4, 0.45], [1.3, 0.45]]) S.box(u + du - 0.15, v + dv - 0.15, u + du + 0.15, v + dv + 0.15, 0, 0.42, [200, 120, 50]);
  }
  // Sofas, bean bags, chess table.
  if (W > 15) {
    S.box(13.0, 8.4, 17.0, 9.3, 0, 0.42, [70, 90, 130]); S.box(13.0, 9.3, 17.0, 9.6, 0, 0.88, [60, 80, 118]);
    S.box(17.6, 5.0, 18.5, 9.0, 0, 0.42, [70, 90, 130]); S.box(18.5, 5.0, 18.8, 9.0, 0, 0.88, [60, 80, 118]);
    S.table(14.4, 6.2, 15.6, 7.0, 0.42, [150, 110, 76]);
    const bags = [[230, 120, 40], [60, 160, 150], [200, 60, 90], [240, 200, 60]];
    bags.forEach((c, i) => S.blob(13.6 + i * 1.1, 2.0 + (i % 2) * 0.8, 0.32, 0.4, c));
    S.box(15.8, 3.8, 16.6, 4.6, 0.62, 0.7, [220, 220, 214], { shadow: false, decals: [{ f: 'top', s0: 0.1, s1: 0.5, t0: 0.1, t1: 0.5, c: [30, 30, 30] }, { f: 'top', s0: 0.5, s1: 0.9, t0: 0.5, t1: 0.9, c: [30, 30, 30] }] });
    S.box(16.1, 4.1, 16.3, 4.3, 0, 0.62, [60, 60, 64]);
  }
  S.plant(0.7, 9.3, 1.0); S.plant(W - 0.7, 0.7, 1.1);
  for (let u = 2.5; u < W; u += 4) for (const v of [3, 7]) S.lamp(u, v, 1.0);
}

function canteen(S, room) {
  const W = room.w;
  S.window('outer', 1.0, 4.4); S.window('outer', 5.4, 8.8);
  if (W > 15) { S.window('outer', 11, 15); S.window('outer', 16, 19.5); }
  S.roomDoors(room);
  // Cafeteria counter with sneeze guard, trays and a queue rail.
  const cu = W - 1.1;
  S.box(cu, 0.8, W - 0.05, 8.8, 0, 0.95, [176, 178, 182], { top: [200, 202, 206] });
  S.box(cu - 0.02, 1.0, cu + 0.05, 8.6, 1.15, 1.5, [190, 220, 230], { shadow: false });
  const foods = [[220, 160, 60], [200, 80, 50], [240, 230, 200], [110, 160, 70], [230, 200, 120]];
  for (let i = 0; i < 7; i++) S.box(cu + 0.15, 1.1 + i * 1.08, cu + 0.85, 1.8 + i * 1.08, 0.95, 1.02, foods[i % foods.length], { shadow: false });
  S.box(cu - 1.2, 1.2, cu - 1.15, 8.2, 0.9, 0.96, [170, 172, 176], { shadow: false });
  S.box(cu - 1.2, 1.2, cu - 1.15, 1.26, 0, 0.9, [170, 172, 176]); S.box(cu - 1.2, 8.14, cu - 1.15, 8.2, 0, 0.9, [170, 172, 176]);
  S.wdecal('east', 1.0, 9.0, 1.7, 2.9, [30, 60, 48]);
  for (let i = 0; i < 6; i++) S.wdecal('east', 1.5, 3.4 + (i % 3) * 0.6, 2.7 - i * 0.16, 2.74 - i * 0.16, [236, 230, 210], { em: 'always' }, 0.02);
  for (let i = 0; i < 6; i++) S.wdecal('east', 5.2, 6.8 + (i % 2) * 0.5, 2.7 - i * 0.16, 2.74 - i * 0.16, [245, 179, 1], { em: 'always' }, 0.02);
  const stool = (s) => (Math.round(s.x) % 2 ? [230, 120, 50] : [40, 150, 150]);
  seatTables(S, room, [210, 210, 206], stool);
  // Decorative tables where the sim has no seats (wide food court).
  const seats = seatsOf(room);
  const maxX = seats.length ? Math.max(...seats.map((s) => s.x)) : room.x;
  for (let tu = Math.max(2, maxX - room.x + 2.4); tu < cu - 2.4; tu += 2.8) {
    for (const tv of [2.4, 5.0, 7.6]) {
      const tx = room.x + tu, ty = S.Y(tv);
      S.boxW(tx - 1.0, ty - 0.38, tx + 1.0, ty + 0.38, 0.72, 0.76, [210, 210, 206], { shadow: false });
      S.boxW(tx - 0.9, ty - 0.3, tx - 0.8, ty + 0.3, 0, 0.72, [120, 120, 118], { shadow: false });
      S.boxW(tx + 0.8, ty - 0.3, tx + 0.9, ty + 0.3, 0, 0.72, [120, 120, 118], { shadow: false });
      for (const dx of [-0.55, 0.55]) for (const dy of [-0.65, 0.65]) S.boxW(tx + dx - 0.16, ty + dy - 0.16, tx + dx + 0.16, ty + dy + 0.16, 0, 0.45, stool({ x: tx + dx }));
    }
  }
  for (let u = 2.5; u < W; u += 4) for (const v of [2.5, 7.5]) S.fan(u, v);
  for (let u = 2.2; u < W; u += 3) for (const v of [3.2, 6.8]) S.lamp(u, v);
}

function bank(S, room) {
  S.window('outer', 1.5, 4.5);
  S.roomDoors(room);
  // Indian Bank style blue + yellow fascia.
  S.wdecal('east', 1.0, 9.0, 2.3, 2.9, [20, 60, 140]);
  S.wdecal('east', 1.0, 9.0, 2.2, 2.3, [250, 196, 20], {}, 0.016);
  S.wdecal('east', 2.0, 5.0, 2.45, 2.75, [236, 240, 245], {}, 0.02);
  // Teller counter with glass partition.
  S.box(5.6, 1.0, 6.3, 9.0, 0, 1.05, [120, 84, 56], { top: [200, 190, 170] });
  S.box(5.92, 1.0, 5.98, 9.0, 1.05, 2.1, [200, 226, 236], { shadow: false });
  for (const v of [2.0, 4.4, 6.8]) {
    S.box(5.95 - 0.02, v - 0.2, 5.95 + 0.02, v + 0.2, 1.05, 1.2, [60, 60, 64], { shadow: false });
    S.box(7.0, v - 0.6, 7.7, v + 0.6, 0, 0.76, [150, 150, 146], { top: [196, 170, 130] });
    S.monitor(7.45, v, 'u-');
    S.chair(8.2, v, [30, 60, 120], 'u+');
  }
  // ATM booth in the corner + waiting chairs.
  S.box(0.4, 7.6, 1.4, 9.4, 0, 2.2, [20, 60, 140], {
    top: [250, 196, 20],
    decals: [{ f: 'u+', s0: 0.3, s1: 0.7, t0: 0.55, t1: 0.75, c: [80, 180, 240], em: 'screen' }, { f: 'u+', s0: 0.35, s1: 0.65, t0: 0.4, t1: 0.5, c: [150, 150, 156] }],
  });
  for (let v = 1.6; v < 6.0; v += 0.6) S.chair(2.6, v, [40, 70, 130], 'u-');
  S.plant(4.6, 9.3, 1.0);
  for (const u of [2.5, 7.5]) for (const v of [3, 7]) S.lamp(u, v);
}

function greenRoom(S, room) {
  S.roomDoors(room);
  S.wdecal('east', 1.0, 9.0, 1.0, 2.2, [190, 206, 216]);
  for (let a = 1.2; a < 9; a += 0.6) S.wdecal('east', a, a + 0.16, 2.25, 2.35, [255, 240, 200], { em: 'always' }, 0.02);
  S.box(8.8, 1.0, 9.7, 9.0, 0, 0.76, [120, 84, 56], { top: [200, 190, 170] });
  for (let v = 1.8; v < 9; v += 1.6) S.chair(8.2, v, [130, 30, 40], 'u-');
  S.box(1.0, 1.0, 1.9, 4.0, 0, 0.42, [110, 70, 90]); S.box(0.7, 1.0, 1.0, 4.0, 0, 0.88, [96, 60, 80]);
  S.box(2.0, 8.6, 5.0, 8.7, 1.6, 1.65, [150, 150, 150]);
  for (let u = 2.2; u < 4.9; u += 0.4) S.box(u, 8.5, u + 0.25, 8.8, 0.7, 1.6, [80 + (u * 37) % 150, 60, 120]);
  for (const u of [2.5, 7.5]) for (const v of [3, 7]) S.lamp(u, v);
}

function avRoom(S, room) {
  S.roomDoors(room);
  S.window('east', 2.0, 8.0, 1.2, 2.5);
  S.box(7.6, 1.2, 8.6, 8.8, 0, 0.85, [50, 52, 58], {
    top: [40, 42, 46],
    leds: Array.from({ length: 18 }, (_, i) => ({ f: 'top', s: 0.2 + (i % 3) * 0.3, t: 0.05 + Math.floor(i / 3) * 0.16, c: i % 4 ? [80, 255, 140] : [255, 80, 70] })),
  });
  for (const v of [2.5, 5.0, 7.5]) S.monitor(8.4, v, 'u-');
  for (const v of [3.5, 6.0]) S.chair(7.0, v, [30, 34, 40]);
  S.box(0.5, 1.0, 1.2, 3.0, 0, 2.0, [40, 42, 46], { leds: [{ f: 'u+', s: 0.3, t: 0.7, c: [80, 255, 140] }, { f: 'u+', s: 0.6, t: 0.5, c: [80, 200, 255] }] });
  for (const u of [2.5, 7.5]) for (const v of [3, 7]) S.lamp(u, v);
}

// ---------------------------------------------------------------- outdoor campus zones

const ZONE_GROUND = {
  GATE: [178, 172, 160], PARKING: [88, 90, 92], SPORTS: [74, 138, 62], BBALL: [52, 104, 156],
  gate: [178, 172, 160], parking: [88, 90, 92], sports: [74, 138, 62],
};

function buildingBoxes(S) {
  for (const fp of SITE.footprints) {
    const blk = BLOCK_BY_ID[fp.blockId];
    const storeys = blk ? blk.floors.filter((f) => !FLOORS[f].isRoof).length : 2;
    const hgt = storeys * 3.6 + 0.8;
    const decals = [];
    const faces = ['x-', 'x+', 'y-', 'y+'];
    for (const f of faces) {
      for (let s = 0; s < storeys; s++) {
        const t0 = (s * 3.6 + 1.0) / hgt, t1 = (s * 3.6 + 2.6) / hgt;
        const n = Math.max(3, Math.round((f[0] === 'x' ? fp.h : fp.w) / 1.6));
        for (let k = 0; k < n; k++) {
          const s0 = (k + 0.18) / n, s1 = (k + 0.82) / n;
          decals.push({ f, s0, s1, t0, t1, c: [70, 96, 120], em: S.rng() < 0.45 ? 'win' : undefined });
        }
      }
      decals.push({ f, s0: 0, s1: 1, t0: 0.97, t1: 1, c: [245, 179, 1] });
    }
    S.boxW(fp.x, fp.y, fp.x + fp.w, fp.y + fp.h, 0, hgt, [214, 206, 190], { top: [150, 146, 140], decals });
    // Entrance canopy.
    const d = fp.door;
    S.boxW(d.x - 0.6, d.y - 0.1, d.x + 1.6, d.y + 1.1, 2.8, 3.0, [200, 200, 196], { shadow: false });
  }
  for (const st of SITE.structures) {
    S.boxW(st.x, st.y, st.x + st.w, st.y + st.h, 0, st.id === 'SUBSTATION' ? 2.6 : 1.6, st.id === 'SUBSTATION' ? [150, 156, 150] : [170, 176, 180], {
      top: st.id === 'SUBSTATION' ? [90, 96, 100] : [70, 110, 140],
      decals: st.id === 'SUBSTATION' ? [{ f: 'y+', s0: 0.3, s1: 0.7, t0: 0.5, t1: 0.8, c: [240, 200, 30] }] : undefined,
    });
  }
}

function tree(S, x, y, h = 4.5) {
  if (S.camXY && Math.hypot(x - S.camXY[0], y - S.camXY[1]) < 7) return;   // keep the lens clear
  S.boxW(x - 0.12, y - 0.12, x + 0.12, y + 0.12, 0, h * 0.55, [100, 72, 50]);
  S.furn.push({ k: 'blob', p: [x, y, h * 0.72], r: h * 0.3, c: [56, 104 + (Math.round(x * 7) % 30), 52], cen: [x, y, h * 0.72] });
}

function streetLight(S, x, y, h = 6, kind = 'street') {
  if (S.camXY && Math.hypot(x - S.camXY[0], y - S.camXY[1]) < 4.5) {   // keep the lens clear, keep the light
    S.extra.glows.push({ p: [x, y, h], r: kind === 'flood' ? 14 : 7, kind });
    return;
  }
  S.boxW(x - 0.07, y - 0.07, x + 0.07, y + 0.07, 0, h, [120, 124, 128], { shadow: false });
  const em = kind === 'flood' ? 'flood' : 'lamp';
  const big = kind === 'flood';
  S.boxW(x - (big ? 0.7 : 0.3), y - (big ? 0.2 : 0.12), x + (big ? 0.7 : 0.3), y + (big ? 0.2 : 0.12), h, h + (big ? 0.6 : 0.15),
    [200, 200, 190], { shadow: false, em: { 'x-': em, 'x+': em, 'y-': em, 'y+': em, 'z+': em } });
  S.extra.glows.push({ p: [x, y, h], r: big ? 14 : 7, kind });
}

function outdoor(S, zone, state, cam) {
  S.winGain = 0;
  S.extra.outdoor = true;
  S.extra.glows = [];
  S.extra.streetLit = zone.type !== 'sports';
  S.camXY = [cam.x - Math.cos(cam.facing) * 2.5, cam.y - Math.sin(cam.facing) * 2.5];
  const inR = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const groundAt = (x, y) => {
    if (y >= 28.6) {
      if (y < 30) return [158, 154, 146];
      if (y < 38) return [70, 72, 76];
      if (y < 39.5) return [158, 154, 146];
      return [118, 120, 100];
    }
    for (const z of SITE.zones) if (inR(z, x, y)) return ZONE_GROUND[z.id] || ZONE_GROUND[z.type];
    if (x < 0.5 || y < 0.5 || x > 51.5) return [100, 128, 78];
    if ((y >= 10 && y < 13) || (y >= 21 && y < 24) || (x >= 12 && x < 14) || (x >= 36 && x < 40)) return [176, 170, 160];
    return [92, 138, 68];
  };
  // Ground: 2 m quads over a wide area, then 1 m tiles inside this zone.
  for (let x = -8; x < 60; x += 2) {
    for (let y = -6; y < 46; y += 2) {
      const c = groundAt(x + 1, y + 1);
      const k = 0.95 + S.rng() * 0.08;
      S.quad(S.shell, [[x, y, 0], [x + 2, y, 0], [x + 2, y + 2, 0], [x, y + 2, 0]], mul(c, k), [0, 0, 1], { seam: true });
    }
  }
  const zc = ZONE_GROUND[zone.id] || ZONE_GROUND[zone.type];
  for (let i = 0; i < zone.w; i++) for (let j = 0; j < zone.h; j++) {
    const x = zone.x + i, y = zone.y + j;
    const k = zone.id === 'GATE' ? ((i + j) % 2 ? 0.95 : 1.03) : 0.97 + S.rng() * 0.05;
    S.quad(S.shell, [[x, y, 0.002], [x + 1, y, 0.002], [x + 1, y + 1, 0.002], [x, y + 1, 0.002]], mul(zc, k), [0, 0, 1], { [zone.id === 'GATE' ? 'grout' : 'seam']: true });
  }
  const flat = (x0, y0, x1, y1, c, z = 0.008) => S.quad(S.decals, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], c, [0, 0, 1]);
  // Ring road lane markings + median.
  for (let x = -8; x < 60; x += 3) { flat(x, 31.9, x + 1.5, 32.05, [230, 230, 224]); flat(x, 35.9, x + 1.5, 36.05, [230, 230, 224]); }
  S.boxW(-8, 33.7, 60, 34.3, 0, 0.3, [220, 200, 60], { shadow: false, top: [90, 130, 70] });
  // Far side of the road: shops and offices.
  const rng = S.rng;
  for (let x = -8; x < 60; x += 4 + Math.floor(rng() * 3)) {
    const w = 3 + rng() * 2, h = 3.5 + rng() * 7;
    const decals = [];
    for (let z = 1.2; z < h - 1; z += 3.2) decals.push({ f: 'y-', s0: 0.1, s1: 0.9, t0: z / h, t1: (z + 1.4) / h, c: [70, 90, 110], em: rng() < 0.5 ? 'win' : undefined });
    S.boxW(x, 42, x + w, 46, 0, h, [150 + rng() * 60, 140 + rng() * 50, 130 + rng() * 40], { decals });
  }
  // Compound wall with the main gate opening.
  const gate = SITE.zones.find((z) => z.id === 'GATE');
  const gx0 = gate.x + 2, gx1 = gate.x + gate.w - 2;
  S.boxW(0.4, 28.35, gx0 - 0.4, 28.65, 0, 2.2, [210, 200, 180], { top: [170, 160, 140] });
  S.boxW(gx1 + 0.4, 28.35, 51.6, 28.65, 0, 2.2, [210, 200, 180], { top: [170, 160, 140] });
  S.boxW(0.35, 0.4, 0.65, 28.65, 0, 2.2, [210, 200, 180], { top: [170, 160, 140] });
  S.boxW(51.35, 0.4, 51.65, 28.65, 0, 2.2, [210, 200, 180], { top: [170, 160, 140] });
  S.boxW(0.4, 0.35, 51.6, 0.65, 0, 2.2, [210, 200, 180], { top: [170, 160, 140] });
  buildingBoxes(S);
  // Trees and street lights along the avenues.
  for (const [x, y] of [[1.6, 11], [9, 11.5], [15, 11.2], [25, 11.6], [33, 11.2], [37, 22.5], [10.5, 21.2], [1.6, 20.5], [50.4, 11.5], [50.4, 27.4], [39.2, 27.2], [31.5, 27.4], [20.8, 27.4], [1.4, 27.5]]) tree(S, x, y, 4 + (x % 3));
  for (const [x, y] of [[12.6, 21.6], [20.5, 23.6], [31, 23.6], [36.5, 12.2], [24, 12.2], [12.5, 12.2], [3, 21.4]]) streetLight(S, x, y);
  for (let x = -6; x < 60; x += 12) streetLight(S, x, 30.2, 8);

  if (zone.id === 'GATE') {
    // Gate pillars, name arch, boom barrier (animated), security booth.
    S.boxW(gx0 - 0.5, 28.2, gx0, 28.8, 0, 4.6, [196, 186, 170], { top: [150, 140, 120] });
    S.boxW(gx1, 28.2, gx1 + 0.5, 28.8, 0, 4.6, [196, 186, 170], { top: [150, 140, 120] });
    const archDecals = [];
    for (const f of ['y-', 'y+']) {
      archDecals.push({ f, s0: 0.04, s1: 0.96, t0: 0.15, t1: 0.85, c: [24, 54, 120] });
      archDecals.push({ f, s0: 0.04, s1: 0.96, t0: 0.08, t1: 0.15, c: [245, 179, 1] });
      for (let k = 0; k < 14; k++) archDecals.push({ f, s0: 0.12 + k * 0.055, s1: 0.15 + k * 0.055, t0: 0.35, t1: 0.7, c: [236, 236, 240], em: 'win' });
    }
    S.boxW(gx0 - 0.5, 28.25, gx1 + 0.5, 28.75, 4.0, 5.0, [24, 54, 120], { shadow: false, decals: archDecals });
    S.boxW(gate.x + 0.3, 26.0, gate.x + 1.8, 27.6, 0, 2.5, [226, 222, 210], {
      top: [180, 60, 50],
      decals: ['x+', 'y-', 'x-'].map((f) => ({ f, s0: 0.15, s1: 0.85, t0: 0.45, t1: 0.82, c: [120, 150, 170], em: 'win' })),
    });
    S.boxW(gate.x + 0.15, 25.85, gate.x + 1.95, 27.75, 2.5, 2.65, [180, 60, 50], { shadow: false });
    S.boxW(gx0 + 0.05, 27.3, gx0 + 0.45, 27.7, 0, 1.0, [230, 230, 226], { top: [240, 180, 30] });
    S.extra.barrier = { x: gx0 + 0.25, y: 27.5, len: gx1 - gx0 - 0.4 };
    S.extra.traffic = true;
  } else if (zone.id === 'PARKING') {
    const evs = EQUIPMENT.filter((e) => e.roomId === zone.id);
    const eq = (id) => state?.equipment?.[id] || {};
    const charging = (s) => /charg/i.test(s.status || '') || (s.kW || 0) > 0.1;
    const buses = evs.filter((e) => e.kind === 'ebus' && eq(e.id).connected);
    for (const e of evs) {
      const st = eq(e.id), big = e.kind === 'ebus';
      S.boxW(e.x - (big ? 0.35 : 0.16), e.y - 0.2, e.x + (big ? 0.35 : 0.16), e.y + 0.2, 0, big ? 1.9 : 1.45, [236, 238, 236], {
        top: [70, 74, 80],
        decals: [{ f: 'y+', s0: 0.2, s1: 0.8, t0: 0.62, t1: 0.82, c: charging(st) ? [90, 230, 120] : [70, 140, 220], em: 'always' }, { f: 'y+', s0: 0.1, s1: 0.9, t0: 0.92, t1: 0.97, c: [245, 179, 1] }],
      });
    }
    // Bay lines.
    for (let x = 11; x <= 19.1; x += 2) flat(x - 0.04, 23.3, x + 0.04, 27.2, [228, 228, 222]);
    const carColors = [[180, 30, 36], [230, 232, 234], [40, 70, 130], [60, 62, 66], [200, 200, 205]];
    for (const bus of buses) {
      // Minibus-length college e-bus nosed in at its charger.
      const x0 = bus.x - 1.15, x1 = bus.x + 1.15, y0 = bus.y + 0.35, y1 = Math.min(27.9, y0 + 2.4 + 2.2);
      const glass = (f) => [{ f, s0: 0.05, s1: 0.95, t0: 0.55, t1: 0.86, c: [50, 70, 90] }, { f, s0: 0, s1: 1, t0: 0.14, t1: 0.24, c: [245, 179, 1] }];
      S.boxW(x0, y0, x1, y1, 0.35, 2.8, [236, 236, 230], { top: [210, 212, 208], decals: [...glass('y-'), ...glass('y+'), ...glass('x-'), ...glass('x+')] });
      S.boxW(x0 + 0.15, y0 + 0.2, x1 - 0.15, y1 - 0.2, 0, 0.35, [24, 24, 26]);
    }
    evs.filter((e) => e.kind === 'ev').forEach((e, i) => {
      if (!eq(e.id).connected) return;
      if (buses.some((b) => Math.abs(b.x - e.x) < 2.1)) return;
      car(S, e.x, 23.5, 'y', carColors[i % carColors.length]);
    });
    // Two-wheelers along the wall.
    for (let x = 11.3; x < 19.6; x += 0.7) {
      const c = [[30, 30, 34], [160, 30, 30], [40, 60, 120], [200, 200, 204]][Math.floor(rng() * 4)];
      S.boxW(x - 0.12, 27.0, x + 0.12, 28.3, 0.25, 0.75, c, { shadow: true });
      S.boxW(x - 0.08, 27.1, x + 0.08, 27.3, 0.75, 1.05, [40, 40, 44], { shadow: false });
    }
  } else if (zone.id === 'SPORTS') {
    const cx = zone.x + zone.w / 2, cy = zone.y + zone.h / 2;
    const ring = (rx0, ry0, rx1, ry1, c, z) => {
      const n = 40;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        S.quad(S.decals, [
          [cx + Math.cos(a0) * rx0, cy + Math.sin(a0) * ry0, z], [cx + Math.cos(a1) * rx0, cy + Math.sin(a1) * ry0, z],
          [cx + Math.cos(a1) * rx1, cy + Math.sin(a1) * ry1, z], [cx + Math.cos(a0) * rx1, cy + Math.sin(a0) * ry1, z],
        ], c, [0, 0, 1], { seam: true });
      }
    };
    const rx = zone.w / 2 - 0.4, ry = zone.h / 2 - 0.4;
    ring(rx - 1.3, ry - 1.3, rx, ry, [176, 78, 58], 0.006);
    for (const k of [0.33, 0.66]) ring(rx - 1.3 * k - 0.025, ry - 1.3 * k - 0.025, rx - 1.3 * k + 0.025, ry - 1.3 * k + 0.025, [236, 236, 230], 0.01);
    ring(rx - 1.33, ry - 1.33, rx - 1.28, ry - 1.28, [236, 236, 230], 0.01);
    flat(cx - (rx - 1.6), cy - 0.03, cx + (rx - 1.6), cy + 0.03, [236, 236, 230]);
    ring(0.95, 0.95, 1.0, 1.0, [236, 236, 230], 0.01);
    for (const gy of [cy - (ry - 1.7), cy + (ry - 1.7)]) {
      S.boxW(cx - 1.2, gy - 0.05, cx - 1.1, gy + 0.05, 0, 2.0, [240, 240, 240]);
      S.boxW(cx + 1.1, gy - 0.05, cx + 1.2, gy + 0.05, 0, 2.0, [240, 240, 240]);
      S.boxW(cx - 1.2, gy - 0.05, cx + 1.2, gy + 0.05, 1.95, 2.05, [240, 240, 240], { shadow: false });
    }
    for (const [x, y] of [[zone.x + 0.2, zone.y + 0.2], [zone.x + zone.w - 0.2, zone.y + 0.2], [zone.x + 0.2, zone.y + zone.h - 0.2], [zone.x + zone.w - 0.2, zone.y + zone.h - 0.2]]) streetLight(S, x, y, 12, 'flood');
  } else if (zone.id === 'BBALL') {
    const line = [236, 236, 230];
    const x0 = zone.x + 0.2, x1 = zone.x + zone.w - 0.2, y0 = zone.y + 0.2, y1 = zone.y + zone.h - 0.2, cy = (y0 + y1) / 2, cx = (x0 + x1) / 2;
    flat(x0, y0, x1, y0 + 0.05, line); flat(x0, y1 - 0.05, x1, y1, line); flat(x0, y0, x0 + 0.05, y1, line); flat(x1 - 0.05, y0, x1, y1, line);
    flat(cx - 0.025, y0, cx + 0.025, y1, line);
    flat(x0, cy - 0.8, x0 + 1.5, cy + 0.8, [180, 80, 50], 0.007); flat(x1 - 1.5, cy - 0.8, x1, cy + 0.8, [180, 80, 50], 0.007);
    for (const [hx, dir] of [[x0 + 0.1, 1], [x1 - 0.1, -1]]) {
      S.boxW(hx - dir * 0.6 - 0.08, cy - 0.08, hx - dir * 0.6 + 0.08, cy + 0.08, 0, 3.3, [60, 64, 70]);
      S.boxW(Math.min(hx - dir * 0.6, hx), cy - 0.05, Math.max(hx - dir * 0.6, hx), cy + 0.05, 3.1, 3.2, [60, 64, 70], { shadow: false });
      S.boxW(hx - 0.02, cy - 0.9, hx + 0.02, cy + 0.9, 2.9, 3.95, [240, 240, 240], {
        shadow: false, decals: ['x-', 'x+'].map((f) => ({ f, s0: 0.35, s1: 0.65, t0: 0.12, t1: 0.45, c: [200, 50, 40] })),
      });
      const rx0 = hx + dir * 0.03, rx1 = hx + dir * 0.48;
      S.boxW(Math.min(rx0, rx1), cy - 0.23, Math.max(rx0, rx1), cy + 0.23, 3.04, 3.06, [230, 100, 30], { shadow: false });
    }
    for (const [x, y] of [[zone.x + 0.2, zone.y - 0.2], [zone.x + zone.w - 0.2, zone.y - 0.2]]) streetLight(S, x, y, 9, 'flood');
  }
}

function car(S, x, y, axis, c) {
  // Nose at (x, y), body along +y (axis 'y') or +x.
  const L = 3.9, Wd = 1.75;
  const [x0, y0, x1, y1] = axis === 'y' ? [x - Wd / 2, y, x + Wd / 2, y + L] : [x, y - Wd / 2, x + L, y + Wd / 2];
  S.boxW(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 0.32, [22, 22, 24]);
  S.boxW(x0, y0, x1, y1, 0.32, 0.86, c, { shadow: false, top: mul(c, 1.08) });
  const inset = axis === 'y' ? [0.08, 0.9, 0.08, 1.1] : [0.9, 0.08, 1.1, 0.08];
  S.boxW(x0 + inset[0], y0 + inset[1], x1 - inset[2], y1 - inset[3], 0.86, 1.4, [44, 54, 64], { shadow: false, top: mul(c, 0.95) });
}

// Moving road traffic + the boom barrier, rebuilt every frame.
export function dynamicItems(scene, time) {
  const out = [];
  const box = (b, c, o = {}) => out.push({ k: 'box', b, c, top: o.top, decals: o.decals, em: o.em, shadow: o.shadow !== false && b[2] < 0.02, cen: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] });
  if (scene.traffic) {
    const fleet = [
      [0, 9, 31.0, [200, 40, 40], 'car'], [17, 8, 31.0, [230, 232, 234], 'car'], [33, 10, 30.9, [230, 200, 40], 'auto'],
      [51, 7, 31.0, [40, 70, 140], 'bus'], [6, -8, 35.0, [60, 62, 66], 'car'], [28, -9, 35.0, [240, 240, 236], 'car'],
      [44, -7.5, 35.1, [80, 140, 90], 'auto'], [60, -6.5, 34.9, [190, 60, 40], 'bus'],
    ];
    for (const [off, speed, y, c, kind] of fleet) {
      const span = 80;
      let x = ((off + time * speed) % span + span) % span - 12;
      const L = kind === 'bus' ? 10 : kind === 'auto' ? 2.6 : 4.2, Wd = kind === 'bus' ? 2.5 : kind === 'auto' ? 1.3 : 1.8, H = kind === 'bus' ? 3.0 : kind === 'auto' ? 1.7 : 1.45;
      const y0 = y - Wd / 2, y1 = y + Wd / 2;
      box([x, y0, 0, x + L, y1, 0.3], [24, 24, 26]);
      if (kind === 'car') {
        box([x, y0, 0.3, x + L, y1, 0.85], c, { shadow: false });
        box([x + 1.0, y0 + 0.08, 0.85, x + L - 1.1, y1 - 0.08, H], [50, 60, 70], { shadow: false, top: c });
      } else {
        const g = kind === 'bus' ? [{ f: 'y-', s0: 0.05, s1: 0.95, t0: 0.55, t1: 0.85, c: [50, 60, 70] }, { f: 'y+', s0: 0.05, s1: 0.95, t0: 0.55, t1: 0.85, c: [50, 60, 70] }] : [];
        box([x, y0, 0.3, x + L, y1, H], c, { shadow: false, decals: g, top: kind === 'auto' ? [30, 30, 30] : undefined });
      }
      const lead = speed > 0 ? x + L : x;
      box([lead - 0.05, y0 + 0.2, 0.5, lead + 0.05, y0 + 0.45, 0.7], [255, 250, 220], { shadow: false, em: { 'x+': 'lamp', 'x-': 'lamp' } });
      box([lead - 0.05, y1 - 0.45, 0.5, lead + 0.05, y1 - 0.2, 0.7], [255, 250, 220], { shadow: false, em: { 'x+': 'lamp', 'x-': 'lamp' } });
    }
  }
  if (scene.barrier) {
    const b = scene.barrier;
    const open = (time % 24) < 6;
    const stripes = (f) => Array.from({ length: 6 }, (_, i) => ({ f, s0: i / 6, s1: (i + 0.5) / 6, t0: 0, t1: 1, c: [200, 30, 30] }));
    if (open) box([b.x - 0.05, b.y - 0.05, 1.0, b.x + 0.05, b.y + 0.05, 1.0 + b.len], [240, 240, 236], { shadow: false });
    else box([b.x, b.y - 0.05, 0.92, b.x + b.len, b.y + 0.05, 1.04], [240, 240, 236], { shadow: false, decals: [...stripes('y-'), ...stripes('y+'), ...stripes('z+')] });
  }
  return out;
}

export function sceneKey(cam, state) {
  if (cam.kind === 'corridor') {
    const f = FLOORS[cam.floor];
    return f.rooms.map((r) => (state?.rooms?.[r.id]?.lightsOn ? '1' : '0')).join('');
  }
  const room = ROOM_BY_ID[cam.roomId];
  if (room?.id === 'PARKING') {
    return EQUIPMENT.filter((e) => e.roomId === room.id).map((e) => {
      const s = state?.equipment?.[e.id] || {};
      return `${s.connected ? 1 : 0}${/charg/i.test(s.status || '') || (s.kW || 0) > 0.1 ? 1 : 0}`;
    }).join('');
  }
  return '';
}

export function buildScene(cam, state) {
  if (cam.kind === 'corridor') {
    const floor = FLOORS[cam.floor];
    const S = new Builder(floor.corridor, true, 'corridor', cam.id);
    S.shellRoom();
    corridor(S, floor, state);
    return S.done({ name: floor.corridor.name });
  }
  const room = ROOM_BY_ID[cam.roomId];
  if (cam.kind === 'outdoor' || room.outdoor) {
    const S = new Builder(room, true, room.type, cam.id);
    outdoor(S, room, state, cam);
    return S.done({ name: room.name });
  }
  const S = new Builder(room, room.top, room.type, cam.id);
  if (room.type === 'auditorium') S.ceil = 7;
  S.shellRoom();
  switch (room.type) {
    case 'classroom': classroom(S, room); break;
    case 'lab': lab(S, room); break;
    case 'seminar': seminar(S, room); break;
    case 'library': library(S, room); break;
    case 'office':
      if (room.id === 'BANK') bank(S, room);
      else if (room.id === 'AUD-GREEN') greenRoom(S, room);
      else if (room.id === 'AUD-AV') avRoom(S, room);
      else office(S, room);
      break;
    case 'lobby': lobby(S, room); break;
    case 'canteen': canteen(S, room); break;
    case 'server': server(S, room); break;
    case 'electrical': electrical(S, room); break;
    case 'auditorium': auditorium(S, room); break;
    case 'workshop': workshop(S, room); break;
    case 'medical': medical(S, room); break;
    case 'security': security(S, room); break;
    case 'gym': gym(S, room); break;
    case 'recreation': recreation(S, room); break;
    default: S.roomDoors(room);
  }
  return S.done({ name: room.name });
}
