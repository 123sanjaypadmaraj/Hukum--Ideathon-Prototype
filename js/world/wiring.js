// Electrical wiring model for the overlays: each block floor's distribution
// board (in the riser) feeds a trunk along the corridor ceiling, and every
// room gets two branch circuits off it (lighting, and fans/AC/sockets).
// On the campus, the substation feeds the Main LT panel, which feeds one
// cable per block. Flow speed follows live kW; lit-but-empty rooms run red.
import { ROOMS, BLOCKS, PANEL_BY_ID, SITE, CORRIDOR, COLS, ROWS } from '../building.js';

export const TRUNK_Y = CORRIDOR.y + CORRIDOR.h / 2;
export const DB_POS = { x: 49.5, y: 19 };
export const WIRE = { light: '#ffc53d', power: '#36cfc9', waste: '#ff4d4f', feed: '#ff9c3a', off: 'rgba(110,125,150,0.5)' };
const NO_WIRE = new Set(['core', 'electrical']);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Branch circuits of one block floor with their live state.
export function floorCircuits(floor, state, waste) {
  const rs = state.rooms || {};
  const branches = [];
  let kW = 0;
  for (const r of floor.rooms) {
    if (NO_WIRE.has(r.type) || r.outdoor) continue;
    const s = rs[r.id] || {};
    const load = num(s.loadKW);
    const lightKW = s.lightsOn ? num(r.loads.lightsKW) : 0;
    branches.push({
      room: r, cx: r.x + r.w / 2, cy: r.y + r.h / 2,
      lightKW, powKW: Math.max(0, load - lightKW),
      waste: !!(waste && waste.minutes(r.id) != null),
    });
    kW += load;
  }
  const minX = branches.length ? Math.min(...branches.map((b) => b.cx)) - 0.4 : DB_POS.x;
  return { branches, kW, minX };
}

// Campus feeders: substation -> Main LT panel -> each block (site-plan tiles).
export function campusFeeders(state, waste) {
  const rs = state.rooms || {};
  const mb = SITE.footprints.find((f) => f.blockId === 'MB');
  const mlt = PANEL_BY_ID.MLT;
  const hub = { x: mb.x + mlt.x / COLS * mb.w, y: mb.y + mlt.y / ROWS * mb.h };
  const sub = SITE.structures.find((s) => s.id === 'SUBSTATION');
  const feeders = [];
  let total = 0;
  for (const b of BLOCKS) {
    let kW = 0, wasteRooms = 0;
    for (const r of ROOMS) {
      if (r.blockId !== b.id) continue;
      kW += num(rs[r.id] && rs[r.id].loadKW);
      if (waste && waste.minutes(r.id) != null) wasteRooms++;
    }
    total += kW;
    const fp = b.footprint;
    const to = { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 };
    // L-shaped run along the paths, not through other blocks.
    const pts = b.id === 'MB' ? [hub, to] : [hub, { x: hub.x, y: fp.y + fp.h + 1.2 }, { x: to.x, y: fp.y + fp.h + 1.2 }, to];
    feeders.push({ blockId: b.id, pts, kW, wasteRooms });
  }
  const incomer = { pts: [{ x: sub.x + sub.w / 2, y: sub.y + sub.h / 2 }, { x: sub.x + sub.w / 2, y: hub.y }, hub], kW: total };
  return { hub, incomer, feeders };
}

// Stroke an animated current-flow line through screen points [[x,y],...].
export function strokeFlow(ctx, pts, { color, on, kW = 0, time = 0, width = 2, alpha = 1 }) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.strokeStyle = on ? color : WIRE.off;
  ctx.lineWidth = on ? width + 2 : width;
  ctx.globalAlpha = alpha * (on ? 0.22 : 0.55);
  ctx.stroke();
  if (on) {
    ctx.setLineDash([Math.max(2, width * 1.6), Math.max(5, width * 3.2)]);
    ctx.lineDashOffset = -((time * (10 + Math.min(kW, 60) * 2.5)) % 1000);
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

export const wireWidth = (kW, base = 1.2) => base + Math.min(3.2, Math.sqrt(Math.max(0, kW)) * 0.45);
