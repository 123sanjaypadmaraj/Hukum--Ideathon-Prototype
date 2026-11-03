// Per-frame top-down (2.5D) renderer. Static floor art comes pre-rendered
// from art.js; this draws the dynamic layers in order:
//   base -> vehicles/equipment rings -> people -> wall tops -> darkness map
//   -> lamp glows -> camera cones/icons -> equipment + room labels -> player
import { FLOORS, CAMERAS, EQUIPMENT, PANELS, ROOM_BY_ID, BLOCKS, SITE } from '../building.js';
import { fmtTime } from '../config.js';
import { PPT } from './art.js';
import { LAMPS, blockGeom, ROAD } from './campus.js';
import { drawFigure, personColor, PLAYER_COLOR } from './people.js';

const TAU = Math.PI * 2;
const KIND_COL = { solar: '#ffc53d', battery: '#95de64', hvac: '#69b1ff', pump: '#40a9ff', ev: '#5cdbd3', ebus: '#5cdbd3' };
const CAR_COLS = ['#8c9db5', '#c0504d', '#e6edf5', '#3f6fb5', '#5a6b7d', '#b08d57'];
const SANS = 'Inter, system-ui, sans-serif';
const MONO = "'JetBrains Mono', ui-monospace, monospace";

let glowSprite = null;
function getGlow() {
  if (glowSprite) return glowSprite;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,214,140,0.55)');
  gr.addColorStop(0.4, 'rgba(255,190,110,0.18)');
  gr.addColorStop(1, 'rgba(255,190,110,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowSprite = c;
  return c;
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const widthCache = new Map();
function tw(ctx, font, s) {
  const k = font + '|' + s;
  let w = widthCache.get(k);
  if (w === undefined) {
    ctx.font = font; w = ctx.measureText(s).width;
    if (widthCache.size > 2000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

export function fmtKW(kw) {
  const a = Math.abs(kw);
  if (!Number.isFinite(a)) return '0 kW';
  return a >= 100 ? `${Math.round(a)} kW` : `${a.toFixed(1)} kW`;
}

// g: { ctx, lightCtx, lightCv, W, H, dpr, z, cx, cy, level, time, state, art, tracker,
//      lights: Map(roomId -> light), corridorLight, dl, duskAmt, hoverRoomId, target, player }
export function drawTopDown(g) {
  const { ctx, W, H, z, cx, cy, level, state, art, time } = g;
  const floor = FLOORS[level];
  const X = (x) => (x - cx) * z + W / 2;
  const Y = (y) => (y - cy) * z + H / 2;

  // Ground / campus backdrop
  ctx.fillStyle = '#06090d';
  ctx.fillRect(0, 0, W, H);
  const step = 2 * z;
  if (step > 8) {
    ctx.strokeStyle = 'rgba(105,177,255,0.035)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ((X(0) % step) + step) % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = ((Y(0) % step) + step) % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  // Static base
  const bw = art.base.width / PPT * z, bh = art.base.height / PPT * z;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art.base, X(art.x0), Y(art.y0), bw, bh);
  const traffic = floor.isCampus ? roadTraffic(time) : null;
  if (traffic) for (const v of traffic) drawRoadVehicle(ctx, v, X, Y, z, 0);

  // Vehicles at chargers, equipment rings
  for (const e of EQUIPMENT) {
    if (e.floor !== level || e.x == null) continue;
    const es = (state.equipment && state.equipment[e.id]) || {};
    if ((e.kind === 'ev' || e.kind === 'ebus') && es.connected) drawVehicle(ctx, e, es, X, Y, z, time);
  }

  // People on this floor
  const people = Array.isArray(state.people) ? state.people : [];
  const vis = [];
  for (const p of people) {
    if (!p || p.floor !== level || !Number.isFinite(p.x)) continue;
    const sx = X(p.x), sy = Y(p.y);
    if (sx < -30 || sy < -30 || sx > W + 30 || sy > H + 30) continue;
    vis.push(p);
  }
  vis.sort((a, b) => a.y - b.y);
  for (const p of vis) {
    const tr = g.tracker.get(p.id);
    const mv = p.seated ? 0 : tr ? tr.moving : (p.moving ? 1 : 0);
    const ang = (mv < 0.3 || p.seated) && Number.isFinite(p.facing) ? p.facing : tr ? tr.ang : Math.PI / 2;
    drawFigure(ctx, X(p.x), Y(p.y), z * 1.12, ang, tr ? tr.phase : 0, mv, personColor(p), { seated: !!p.seated });
  }

  // Wall tops occlude people standing just north of a wall
  ctx.drawImage(art.tops, X(art.x0), Y(art.y0), bw, bh);

  // Darkness map: night-blue over everything, per-room darkness by lighting.
  const L = g.lightCtx;
  L.setTransform(g.lightScale, 0, 0, g.lightScale, 0, 0);
  L.globalCompositeOperation = 'source-over';
  L.clearRect(0, 0, W, H);
  const outsideDark = (1 - g.dl) * 0.68;
  L.fillStyle = `rgba(3,6,16,${outsideDark})`;
  L.fillRect(0, 0, W, H);
  const area = (r, dark) => {
    const x = X(r.x), y = Y(r.y), w = r.w * z, h = r.h * z;
    L.clearRect(x, y, w, h);
    if (dark > 0.005) { L.fillStyle = `rgba(3,6,16,${dark})`; L.fillRect(x, y, w, h); }
  };
  area(floor.corridor, g.corridorLight.dark);
  for (const r of floor.rooms) {
    const li = g.lights.get(r.id);
    area(r, li ? li.dark : 0.5);
    for (const d of r.doors) area({ x: d.x, y: d.y, w: 1, h: 1 }, g.corridorLight.dark);
  }
  ctx.drawImage(g.lightCv, 0, 0, W, H);
  if (g.duskAmt > 0.02) {
    ctx.fillStyle = `rgba(255,128,48,${g.duskAmt * 0.07})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Lamps: warm glow for lit rooms, dim fixtures when dark
  const glow = getGlow();
  for (const r of floor.rooms) {
    const li = g.lights.get(r.id);
    if (!li || li.outdoor) continue;
    drawLamps(ctx, r, li, X, Y, z, glow, g.dl);
  }
  if (floor.isCampus) drawCampusLights(ctx, g, X, Y, z, traffic);
  if (!floor.isRoof && !floor.isCampus && g.corridorLight.lit) {
    ctx.globalCompositeOperation = 'lighter';
    const c = floor.corridor;
    for (let x = c.x + 2; x < c.x + c.w; x += 4) {
      const s = 2.4 * z;
      ctx.globalAlpha = 0.35;
      ctx.drawImage(glow, X(x) - s / 2, Y(c.y + c.h / 2) - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Hover outline
  if (g.hoverRoomId) {
    const r = ROOM_BY_ID[g.hoverRoomId];
    if (r && r.floor === level) {
      ctx.strokeStyle = 'rgba(245,179,1,0.55)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(X(r.x) + 1, Y(r.y) + 1, r.w * z - 2, r.h * z - 2);
      ctx.setLineDash([]);
    }
  }

  // CCTV
  const camS = state.cameras || {};
  for (const c of CAMERAS) {
    if (c.floor !== level) continue;
    drawCameraCone(ctx, c, camS[c.id], floor, X, Y, z);
  }
  if (z >= 16) {
    for (const c of CAMERAS) {
      if (c.floor !== level) continue;
      const cs = camS[c.id];
      if (!cs || cs.online === false || !Array.isArray(cs.detections)) continue;
      drawDetections(ctx, cs.detections, X, Y, z);
    }
  }
  for (const c of CAMERAS) {
    if (c.floor !== level) continue;
    drawCameraIcon(ctx, c, camS[c.id], X, Y, z, time, g.target && g.target.kind === 'camera' && g.target.id === c.id);
  }

  // Panels
  for (const p of PANELS) {
    if (p.floor !== level) continue;
    drawTag(ctx, X(p.x), Y(p.y + 0.55), p.id, 'AR lens', '#f5b301', z);
  }

  // Equipment glyphs
  for (const e of EQUIPMENT) {
    if (e.floor !== level || e.x == null) continue;
    drawEquipment(ctx, e, (state.equipment && state.equipment[e.id]) || {}, state, X, Y, z, time);
  }

  // Room labels and power state
  for (const r of floor.rooms) drawRoomLabel(ctx, r, g.lights.get(r.id), state, X, Y, z, g.camOnline);
  if (floor.isCampus) drawCampusLabels(ctx, g, X, Y, z);

  // Interaction target highlight
  if (g.target && g.target.x != null && g.target.kind !== 'room') {
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    ctx.strokeStyle = `rgba(245,179,1,${0.5 + pulse * 0.4})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(g.target.x), Y(g.target.y), Math.max(10, z * (0.62 + pulse * 0.08)), 0, TAU); ctx.stroke();
  }

  // Player: always drawn last so it stays visible in dark rooms
  const P = g.player;
  const px = X(P.x), py = Y(P.y);
  const pulse = 0.5 + 0.5 * Math.sin(time * 3);
  ctx.strokeStyle = `rgba(245,179,1,${0.25 + 0.25 * pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(px, py, z * (0.42 + 0.06 * pulse), 0, TAU); ctx.stroke();
  // facing wedge
  const a = P.dir || 0;
  ctx.fillStyle = 'rgba(245,179,1,0.18)';
  ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, z * 1.4, a - 0.45, a + 0.45); ctx.closePath(); ctx.fill();
  drawFigure(ctx, px, py, Math.max(z, 12), a, g.playerPhase, g.playerMoving, PLAYER_COLOR, { scale: 1.25, outline: '#fff3c4' });
  const tip = Math.max(z, 12) * 0.42;
  ctx.fillStyle = '#ffd666';
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(a) * (tip + 6), py + Math.sin(a) * (tip + 6));
  ctx.lineTo(px + Math.cos(a + 2.5) * 5 + Math.cos(a) * tip, py + Math.sin(a + 2.5) * 5 + Math.sin(a) * tip);
  ctx.lineTo(px + Math.cos(a - 2.5) * 5 + Math.cos(a) * tip, py + Math.sin(a - 2.5) * 5 + Math.sin(a) * tip);
  ctx.closePath(); ctx.fill();
  if (z >= 14) {
    ctx.font = `700 10px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(11,15,20,0.8)';
    const lw = tw(ctx, ctx.font, 'YOU') + 8;
    rrect(ctx, px - lw / 2, py - z * 0.62 - 16, lw, 14, 4); ctx.fill();
    ctx.fillStyle = PLAYER_COLOR;
    ctx.fillText('YOU', px, py - z * 0.62 - 3.5);
  }
  return { X, Y };
}

function drawLamps(ctx, r, li, X, Y, z, glow, dl) {
  const nx = Math.max(1, Math.round(r.w / 3.4)), ny = Math.max(1, Math.round(r.h / 3.4));
  const lw = Math.min(1.1, r.w / nx * 0.4) * z, lh = Math.max(2, 0.18 * z);
  if (li.lit) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,200,120,${0.025 + (1 - dl) * 0.04})`;
    ctx.fillRect(X(r.x), Y(r.y), r.w * z, r.h * z);
    const s = Math.min(r.w / nx, r.h / ny) * 1.25 * z;
    ctx.globalAlpha = 0.25 + (1 - dl) * 0.35;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = X(r.x + (i + 0.5) * r.w / nx), y = Y(r.y + (j + 0.5) * r.h / ny);
      ctx.drawImage(glow, x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  if (z < 10) return;
  ctx.fillStyle = li.lit ? 'rgba(255,240,205,0.85)' : 'rgba(150,160,175,0.16)';
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x = X(r.x + (i + 0.5) * r.w / nx), y = Y(r.y + (j + 0.5) * r.h / ny);
    ctx.fillRect(x - lw / 2, y - lh / 2, lw, lh);
  }
}

function drawCameraCone(ctx, c, cs, floor, X, Y, z) {
  const online = !cs || cs.online !== false;
  const area = c.kind === 'corridor' ? floor.corridor : ROOM_BY_ID[c.roomId];
  if (!area) return;
  const rad = (c.kind === 'corridor' ? 22 : Math.hypot(area.w, area.h)) * z;
  const x = X(c.x), y = Y(c.y);
  const fov = c.fov || Math.PI / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(X(area.x), Y(area.y), area.w * z, area.h * z); ctx.clip();
  const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
  if (online) { gr.addColorStop(0, 'rgba(64,169,255,0.22)'); gr.addColorStop(1, 'rgba(64,169,255,0)'); }
  else { gr.addColorStop(0, 'rgba(255,77,79,0.2)'); gr.addColorStop(1, 'rgba(255,77,79,0)'); }
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, rad, c.facing - fov / 2, c.facing + fov / 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = online ? 'rgba(64,169,255,0.28)' : 'rgba(255,77,79,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(c.facing - fov / 2) * rad, y + Math.sin(c.facing - fov / 2) * rad);
  ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(c.facing + fov / 2) * rad, y + Math.sin(c.facing + fov / 2) * rad);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawDetections(ctx, dets, X, Y, z) {
  const s = 0.34 * z, k = s * 0.45;
  ctx.lineWidth = 1.25;
  for (const d of dets) {
    if (!d || !Number.isFinite(d.x)) continue;
    const x = X(d.x), y = Y(d.y);
    const a = Math.max(0.35, Math.min(1, d.conf || 0.8));
    ctx.strokeStyle = `rgba(64,169,255,${a})`;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s + k); ctx.lineTo(x - s, y - s); ctx.lineTo(x - s + k, y - s);
    ctx.moveTo(x + s - k, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x + s, y - s + k);
    ctx.moveTo(x + s, y + s - k); ctx.lineTo(x + s, y + s); ctx.lineTo(x + s - k, y + s);
    ctx.moveTo(x - s + k, y + s); ctx.lineTo(x - s, y + s); ctx.lineTo(x - s, y + s - k);
    ctx.stroke();
  }
}

function drawCameraIcon(ctx, c, cs, X, Y, z, time, active) {
  const online = !cs || cs.online !== false;
  const x = X(c.x), y = Y(c.y);
  const s = Math.max(9, z * 0.42);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(1.5, 2, s * 0.7, 0, TAU); ctx.fill();
  ctx.fillStyle = active ? '#3a3520' : '#1b2532';
  ctx.strokeStyle = active ? '#f5b301' : online ? '#9fb3c8' : '#ff4d4f';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.rotate(c.facing);
  ctx.fillStyle = '#c9d3df';
  rrect(ctx, -s * 0.38, -s * 0.22, s * 0.6, s * 0.44, 2); ctx.fill();
  ctx.fillStyle = '#0b0f14';
  ctx.beginPath(); ctx.arc(s * 0.22, 0, s * 0.17, 0, TAU); ctx.fill();
  ctx.restore();
  const blink = online ? (Math.sin(time * 3) > -0.2) : (Math.sin(time * 8) > 0);
  if (blink) {
    ctx.fillStyle = online ? '#52c41a' : '#ff4d4f';
    ctx.beginPath(); ctx.arc(x - s * 0.45, y - s * 0.45, Math.max(2, s * 0.13), 0, TAU); ctx.fill();
  }
  const n = cs && online ? cs.count | 0 : 0;
  if (n > 0 && z >= 12) {
    const label = String(n);
    ctx.font = `700 10px ${MONO}`;
    const w = Math.max(14, tw(ctx, ctx.font, label) + 7);
    ctx.fillStyle = '#40a9ff';
    rrect(ctx, x + s * 0.4, y - s * 0.95, w, 13, 6.5); ctx.fill();
    ctx.fillStyle = '#04121f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + s * 0.4 + w / 2, y - s * 0.95 + 6.8);
  }
  if (!online && z >= 14) drawTag(ctx, x, y + s + 14, 'OFFLINE', null, '#ff4d4f', z);
}

function drawTag(ctx, x, y, a, b, col, z) {
  if (z < 14) return;
  const f1 = `700 10px ${MONO}`, f2 = `500 10px ${SANS}`;
  const w1 = tw(ctx, f1, a), w2 = b ? tw(ctx, f2, b) : 0;
  const w = w1 + (b ? w2 + 8 : 0) + 12;
  ctx.fillStyle = 'rgba(11,15,20,0.82)';
  rrect(ctx, x - w / 2, y - 9, w, 18, 5); ctx.fill();
  ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = f1; ctx.fillStyle = col; ctx.fillText(a, x - w / 2 + 6, y + 0.5);
  if (b) { ctx.font = f2; ctx.fillStyle = '#8a9bb0'; ctx.fillText(b, x - w / 2 + 6 + w1 + 8, y + 0.5); }
}

// Parked vehicle at a charger: cars stand nose-in above their charger,
// college buses lie across their bay above the bus charger.
function drawVehicle(ctx, e, es, X, Y, z, time) {
  const bus = e.kind === 'ebus';
  const len = bus ? 3.4 : 1.9, wid = bus ? 1.3 : 1.15;
  const cx = e.x, cy = bus ? e.y + 1.0 : e.y - 0.3 - len / 2;
  const col = bus ? '#d9a521' : CAR_COLS[(e.id.charCodeAt(e.id.length - 1) + 1) % CAR_COLS.length];
  ctx.save();
  ctx.translate(X(cx), Y(cy));
  if (bus) ctx.rotate(Math.PI / 2);
  drawCarBody(ctx, wid * z, len * z, col, bus, z);
  ctx.restore();
  // Charging cable
  const kw = Number(es.kW) || 0;
  const charging = kw > 0.1;
  ctx.strokeStyle = charging ? `rgba(92,219,211,${0.6 + 0.4 * Math.sin(time * 6)})` : 'rgba(138,155,176,0.6)';
  ctx.lineWidth = Math.max(1.5, z * 0.06);
  const endY = bus ? Y(cy - wid / 2) + 2 : Y(cy + len / 2) - 2;
  ctx.beginPath();
  ctx.moveTo(X(e.x), Y(e.y));
  ctx.quadraticCurveTo(X(e.x + 0.5), (Y(e.y) + endY) / 2, X(e.x + 0.2), endY);
  ctx.stroke();
}

// Vehicle body centred on the origin, length along +y (front at -y).
function drawCarBody(ctx, W, H, col, bus, z, headlights = 0) {
  const x = -W / 2, y = -H / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; rrect(ctx, x + 3, y + 4, W, H, z * 0.22); ctx.fill();
  ctx.fillStyle = col; rrect(ctx, x, y, W, H, z * 0.22); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = 'rgba(14,22,32,0.85)';
  if (bus) {
    rrect(ctx, x + W * 0.1, y + H * 0.04, W * 0.8, H * 0.1, 3); ctx.fill();
    for (let k = 0; k < 5; k++) { ctx.fillRect(x + W * 0.06, y + H * (0.2 + k * 0.14), W * 0.12, H * 0.1); ctx.fillRect(x + W * 0.82, y + H * (0.2 + k * 0.14), W * 0.12, H * 0.1); }
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x + W * 0.3, y + H * 0.2, W * 0.4, H * 0.7);
  } else {
    rrect(ctx, x + W * 0.14, y + H * 0.14, W * 0.72, H * 0.2, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; rrect(ctx, x + W * 0.18, y + H * 0.38, W * 0.64, H * 0.3, 3); ctx.fill();
  }
  if (headlights > 0.05) {
    ctx.fillStyle = `rgba(255,240,200,${headlights})`;
    ctx.fillRect(x + W * 0.1, y - 1, W * 0.2, 3); ctx.fillRect(x + W * 0.7, y - 1, W * 0.2, 3);
  }
}

const ICONS = {
  solar(ctx, s) {
    ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, TAU); ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.07);
    for (let k = 0; k < 8; k++) { const a = k * TAU / 8; ctx.beginPath(); ctx.moveTo(Math.cos(a) * s * 0.32, Math.sin(a) * s * 0.32); ctx.lineTo(Math.cos(a) * s * 0.46, Math.sin(a) * s * 0.46); ctx.stroke(); }
  },
  battery(ctx, s, es) {
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.strokeRect(-s * 0.34, -s * 0.2, s * 0.62, s * 0.4);
    ctx.fillRect(s * 0.28, -s * 0.08, s * 0.08, s * 0.16);
    const soc = Math.max(0, Math.min(1, Number(es.soc) || 0));
    ctx.fillRect(-s * 0.28, -s * 0.14, s * 0.5 * soc, s * 0.28);
  },
  hvac(ctx, s, es, t) {
    ctx.save(); ctx.rotate(t);
    for (let k = 0; k < 3; k++) { ctx.rotate(TAU / 3); ctx.beginPath(); ctx.ellipse(s * 0.2, 0, s * 0.2, s * 0.09, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.07, 0, TAU); ctx.fill();
  },
  pump(ctx, s) {
    ctx.beginPath(); ctx.moveTo(0, -s * 0.36);
    ctx.bezierCurveTo(s * 0.3, -s * 0.02, s * 0.3, s * 0.32, 0, s * 0.32);
    ctx.bezierCurveTo(-s * 0.3, s * 0.32, -s * 0.3, -s * 0.02, 0, -s * 0.36); ctx.fill();
  },
  ev(ctx, s) {
    ctx.beginPath(); ctx.moveTo(s * 0.06, -s * 0.38); ctx.lineTo(-s * 0.2, s * 0.05); ctx.lineTo(-s * 0.01, s * 0.05);
    ctx.lineTo(-s * 0.08, s * 0.38); ctx.lineTo(s * 0.2, -s * 0.06); ctx.lineTo(s * 0.01, -s * 0.06); ctx.closePath(); ctx.fill();
  },
};
ICONS.ebus = ICONS.ev;

function drawEquipment(ctx, e, es, state, X, Y, z, time) {
  const col = KIND_COL[e.kind] || '#9fb3c8';
  let kw = Number(es.kW) || 0;
  if (e.kind === 'solar') kw = Math.abs(Number(state.energy && state.energy.solarKW) || Math.abs(kw));
  const active = Math.abs(kw) > 0.05 || (es.status && es.status !== 'idle' && es.status !== 'off' && es.status !== 'deferred');
  const x = X(e.x), y = Y(e.y);
  const s = Math.max(16, z * 0.9);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.arc(1.5, 2.5, s * 0.52, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(11,15,20,0.92)';
  ctx.beginPath(); ctx.arc(0, 0, s * 0.5, 0, TAU); ctx.fill();
  ctx.strokeStyle = col; ctx.globalAlpha = active ? 1 : 0.45; ctx.lineWidth = 2;
  ctx.stroke();
  if (active) {
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.5;
    const a0 = time * 2.2;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.62, a0, a0 + 1.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.62, a0 + Math.PI, a0 + Math.PI + 1.4); ctx.stroke();
  }
  ctx.globalAlpha = active ? 1 : 0.6;
  ctx.fillStyle = col; ctx.strokeStyle = col;
  (ICONS[e.kind] || ICONS.ev)(ctx, s, es, active ? time * 6 : 0);
  ctx.restore();
  ctx.globalAlpha = 1;

  if (z < ((e.kind === 'ev' || e.kind === 'ebus') ? 24 : 14)) return;
  let line1 = `${e.id}  ${fmtKW(kw)}`;
  let line2 = es.status || (active ? 'running' : 'idle');
  if (e.kind === 'battery') {
    const soc = Number(es.soc);
    line1 = `${e.id}  ${kw > 0.05 ? '+' : kw < -0.05 ? '-' : ''}${fmtKW(kw)}`;
    line2 = `${es.status || 'idle'}${Number.isFinite(soc) ? `  SOC ${Math.round(soc * 100)}%` : ''}`;
  } else if (e.kind === 'pump' && Number.isFinite(Number(es.tankLevel))) {
    line2 = `${es.status || 'idle'}  tank ${Math.round(es.tankLevel * 100)}%`;
  } else if ((e.kind === 'ev' || e.kind === 'ebus') && !es.connected) {
    line2 = 'no vehicle';
  } else if (e.kind === 'solar') {
    line1 = `PV  ${fmtKW(kw)}`;
    line2 = 'campus 900 kWp';
  }
  const compact = (e.kind === 'ev' || e.kind === 'ebus') && z < 44;
  if (compact) { line1 = `${e.id.replace('EBUS', 'BUS')} ${fmtKW(kw)}`; line2 = ''; }
  const f1 = `700 10px ${MONO}`, f2 = `500 10px ${SANS}`;
  const w = Math.max(tw(ctx, f1, line1), line2 ? tw(ctx, f2, line2) : 0) + 12;
  const ly = y + s * 0.5 + 4;
  ctx.fillStyle = 'rgba(11,15,20,0.85)';
  rrect(ctx, x - w / 2, ly, w, line2 ? 30 : 17, 5); ctx.fill();
  ctx.strokeStyle = col; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = f1; ctx.fillStyle = active ? col : '#c9d3df'; ctx.fillText(line1, x, ly + 4);
  if (line2) { ctx.font = f2; ctx.fillStyle = '#8a9bb0'; ctx.fillText(line2, x, ly + 16); }
}

function drawRoomLabel(ctx, r, li, state, X, Y, z) {
  if (!li) return;
  const s = li.s || {};
  const x = X(r.x) + 6;
  // Keep the label inside the visible part of the room while scrolling.
  const y = Math.max(Y(r.y) + 6, Math.min(8, Y(r.y + r.h) - 44));
  const name = r.name;
  const parts = [];
  const occ = Number(s.occupancy);
  if (r.seats > 0 || occ > 0) parts.push(`${Number.isFinite(occ) ? occ : 0} ppl`);
  if (r.loads && r.loads.acKW > 0 && Number.isFinite(Number(s.tempC))) parts.push(`${Number(s.tempC).toFixed(1)} C`);
  if (Number.isFinite(Number(s.loadKW)) && s.loadKW > 0.05 && r.type !== 'core') parts.push(`${Number(s.loadKW).toFixed(1)} kW`);
  const sub = parts.join('  ');
  const f1 = `600 11px ${SANS}`, f2 = `500 10px ${MONO}`;
  if (z >= 11) {
    const w = Math.max(tw(ctx, f1, name), sub ? tw(ctx, f2, sub) : 0) + 24;
    const h = sub && z >= 15 ? 32 : 19;
    ctx.fillStyle = 'rgba(11,15,20,0.8)';
    rrect(ctx, x, y, w, h, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = li.lit ? '#ffd666' : li.autoOff || li.manualOff ? '#ff7a45' : '#56657d';
    ctx.beginPath(); ctx.arc(x + 9, y + 9.5, 3.2, 0, TAU); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = f1; ctx.fillStyle = '#e6edf5'; ctx.fillText(name, x + 17, y + 10);
    if (h > 20) { ctx.font = f2; ctx.fillStyle = '#8a9bb0'; ctx.fillText(sub, x + 17, y + 24); }
  }

  // Centre status badge
  let badge = null, small = null, col = '#8a9bb0';
  if (li.manualOff) { badge = 'OFF'; small = 'manual override'; col = '#faad14'; }
  else if (li.autoOff) { badge = 'AUTO-OFF'; small = s.offSince != null ? `empty, off since ${fmtTime(s.offSince)}` : 'no one detected'; col = '#8a9bb0'; }
  else if (li.camOffline && r.autoOff) { badge = 'CAMERA OFFLINE'; small = 'fail-safe: power held ON'; col = '#ff4d4f'; }
  if (!badge || z < 9) return;
  const cx = X(r.x + r.w / 2), cy = Y(r.y + r.h / 2);
  const fb = `700 11px ${MONO}`, fs = `500 10px ${SANS}`;
  const w = Math.max(tw(ctx, fb, badge) + 20, small && z >= 14 ? tw(ctx, fs, small) + 16 : 0);
  const h = small && z >= 14 ? 34 : 20;
  ctx.fillStyle = 'rgba(6,9,13,0.72)';
  rrect(ctx, cx - w / 2, cy - h / 2, w, h, 4); ctx.fill();
  ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = fb; ctx.fillStyle = col; ctx.fillText(badge, cx, cy - (h > 20 ? 7 : 0));
  if (h > 20) { ctx.font = fs; ctx.fillStyle = '#8a9bb0'; ctx.fillText(small, cx, cy + 9); }
}

// ---------------------------------------------------------------- campus
// A few vehicles running along the Outer Ring Road (pure decoration).
function roadTraffic(time) {
  const out = [];
  const laneY = [ROAD.y0 + 1.6, ROAD.y1 - 1.05];
  const cols = ['#c9d3df', '#8c9db5', '#c0504d', '#3f6fb5', '#e0b04a', '#5a6b7d', '#d9a521'];
  for (let k = 0; k < 7; k++) {
    const lane = k % 2, sp = 3.2 + (k * 0.9) % 2.4, span = 64;
    const p = ((time * sp + k * 9.7) % span + span) % span - 6;
    out.push({ x: lane ? 52 - p : p, y: laneY[lane], dir: lane ? Math.PI : 0, col: cols[k], bus: k === 6 });
  }
  return out;
}
function drawRoadVehicle(ctx, v, X, Y, z, lights) {
  ctx.save();
  ctx.translate(X(v.x), Y(v.y));
  ctx.rotate(v.dir + Math.PI / 2);
  drawCarBody(ctx, (v.bus ? 1.2 : 0.95) * z, (v.bus ? 3.2 : 1.7) * z, v.col, v.bus, z, lights);
  ctx.restore();
}

function blockStats(g, id) { return (g.blockInfo && g.blockInfo[id]) || { kw: 0, storeyLit: [], lit: 0 }; }

function drawCampusLights(ctx, g, X, Y, z, traffic) {
  const night = 1 - g.dl;
  const glow = getGlow();
  // Lit windows follow how many rooms on each storey have lights on.
  for (const b of BLOCKS) {
    const gm = blockGeom(b.id);
    if (!gm) continue;
    const st = blockStats(g, b.id);
    let i = 0;
    for (const w of gm.windows) {
      i++;
      const frac = st.storeyLit[w.s] || 0;
      const h = ((i * 2654435761) >>> 0) / 4294967296;
      if (h >= frac) continue;
      ctx.fillStyle = `rgba(255,214,140,${0.35 + night * 0.6})`;
      ctx.fillRect(X(w.x), Y(w.y), w.w * z, w.h * z);
    }
    if (night > 0.3 && st.lit > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, st.lit * night * 0.6);
      const fp = gm.fp, s = fp.w * z * 0.9;
      ctx.drawImage(glow, X(fp.x + fp.w / 2) - s / 2, Y(fp.y + fp.h) - s * 0.25, s, s * 0.5);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  if (night < 0.15) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const l of LAMPS) {
    const s = (l.kind === 'flood' ? 7 : 3.4) * z;
    ctx.globalAlpha = night * (l.kind === 'flood' ? 0.55 : 0.75);
    ctx.drawImage(glow, X(l.x) - s / 2, Y(l.y) - s / 2, s, s);
  }
  if (traffic) {
    for (const v of traffic) {
      const s = 2.2 * z;
      ctx.globalAlpha = night * 0.6;
      ctx.drawImage(glow, X(v.x + Math.cos(v.dir) * 1.6) - s / 2, Y(v.y) - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(255,236,190,${night})`;
  for (const l of LAMPS) {
    if (l.kind === 'flood') ctx.fillRect(X(l.x - 0.25), Y(l.y - 0.95), 0.5 * z, Math.max(2, 0.18 * z));
    else { ctx.beginPath(); ctx.arc(X(l.x), Y(l.y - 0.58), Math.max(1.5, 0.1 * z), 0, TAU); ctx.fill(); }
  }
}

function drawCampusLabels(ctx, g, X, Y, z) {
  if (z < 9) return;
  for (const b of BLOCKS) {
    const gm = blockGeom(b.id);
    if (!gm) continue;
    const fp = gm.fp;
    const st = blockStats(g, b.id);
    const cx = X(fp.x + fp.w / 2), cy = Y(fp.y - gm.H + fp.h / 2);
    const f1 = `700 12px ${SANS}`, f2 = `600 10.5px ${MONO}`;
    const name = b.name;
    const sub = `${fmtKW(st.kw)}  ·  ${gm.storeys} ${gm.storeys === 1 ? 'storey' : 'storeys'}`;
    const w = Math.max(tw(ctx, f1, name), tw(ctx, f2, sub)) + 22;
    ctx.fillStyle = 'rgba(11,15,20,0.84)';
    rrect(ctx, cx - w / 2, cy - 17, w, 34, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(245,179,1,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = f1; ctx.fillStyle = '#e6edf5'; ctx.fillText(name, cx, cy - 6);
    ctx.font = f2; ctx.fillStyle = st.kw > 0.05 ? '#ffc53d' : '#8a9bb0'; ctx.fillText(sub, cx, cy + 8);
  }
  for (const s of SITE.structures) drawTag(ctx, X(s.x + s.w / 2), Y(s.y + s.h + 0.45), s.id === 'SUBSTATION' ? 'SUBSTATION' : 'STP', s.id === 'SUBSTATION' ? '11 kV' : 'water', s.id === 'SUBSTATION' ? '#faad14' : '#40a9ff', z);
}
