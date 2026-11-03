// Zero Scan live build: an isometric model of the Main Block that assembles
// itself while the scan runs. Each pipeline stage plays its own animation:
//   1 Outside      site grid, footprint trace, massing extrudes, roof panels land
//   2 Blueprints   floors explode apart, slabs and room walls rise
//   3 Interior scan  phone scan sweep, furniture and plant appear, nameplate tags
//   4 CCTV         cameras with view cones, detected people
//   5 Electricity  riser and circuits light up, meter trace draws
//   6 Fuse         drawing snaps onto the footprint, rooms take their verdict colour
// Geometry comes from js/building.js (the same building the samples describe);
// counts, statuses and the meter trace come from the scan results.
import { FLOORS, CAMERAS, EQUIPMENT, PANELS } from '../building.js';
import { fitCanvas } from './view.js';

const MB = FLOORS.filter((f) => f.blockId === 'MB');
const STOREY = 3.6;          // m between floors when compact
const WALL = 2.0;            // cutaway wall height
const CX = 26, CY = 13.5;    // orbit centre (tiles)
const OUTLINE = [[0, 0], [44, 0], [44, -3], [52, -3], [52, 29], [0, 29]];   // tile frame, y down; stair tower NE
const STAGE_DUR = 3.4;
const COUNTER_KEYS = [['rooms', 'rooms'], ['panels', 'solar panels'], ['cameras', 'cameras'], ['people', 'students'], ['circuits', 'appliances'], ['facts', 'verified facts']];
const ICONS = {
  rooms: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 21v-5h6v5M8 8h2M14 8h2M8 12h2M14 12h2"/>',
  panels: '<path d="M3 8l2-4h14l2 4M3 8h18v9H3zM9 8v9M15 8v9M3 12.5h18M12 17v3M8 20h8"/>',
  cameras: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5.5a3 3 0 010 5.5M18 14.5c1.8.8 3 2.6 3 5.5"/>',
  circuits: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  facts: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};       // seconds per stage animation

export const STAGE_TEXT = {
  1: ['Site and roof', 'Tracing the footprint and extruding the massing from Open Buildings height. Roof segments from the Solar API get their panels.'],
  2: ['Floor plans', 'Opening the floors. Rooms from the DXF, IFC and scanned plan rise as walls; the single-line diagram ties circuits to rooms.'],
  3: ['Interior scan', 'The phone interior scan fills gaps: furniture is counted, plant is placed and nameplates give real kW ratings.'],
  4: ['Camera mapping', 'Each camera is calibrated to the plan. YOLO foot points land in room ids.'],
  5: ['Power mapping', 'NILM splits the block meter into appliances. Circuits light up from the riser to every room.'],
  6: ['Merge into model', 'ICP snaps the drawing onto the footprint. Every room takes its verdict: accepted, to confirm or conflict.'],
};

const TYPE_COL = {
  classroom: [64, 132, 214], lab: [38, 170, 160], office: [140, 110, 210], library: [200, 150, 70], seminar: [96, 120, 230],
  security: [210, 90, 90], electrical: [235, 170, 40], server: [90, 200, 230], core: [90, 100, 115], lobby: [120, 140, 160],
  roof: [40, 60, 90], plant: [150, 160, 175],
};
const STATUS_COL = { accepted: [82, 196, 26], review: [250, 173, 20], conflict: [255, 77, 79], human: [64, 169, 255] };
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const pop = (x) => { x = clamp01(x); const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Static scene derived once from building.js.
function buildScene() {
  const r = rng(7);
  const floors = MB.map((f, li) => {
    const rooms = f.rooms.map((rm) => {
      const furn = [];
      if (['classroom', 'seminar', 'library', 'lab', 'office'].includes(rm.type)) {
        const step = rm.type === 'lab' ? 3 : rm.type === 'library' ? 2.6 : 2;
        for (let y = rm.y + 1.6; y < rm.y + rm.h - 1.2; y += step) for (let x = rm.x + 1.4; x < rm.x + rm.w - 1; x += step) furn.push([x, y, rm.type === 'lab' ? 2.2 : 1.1, rm.type === 'lab' ? 0.8 : 0.6]);
      }
      const cap = { classroom: 34, lab: 22, seminar: 30, library: 26, office: 6, lobby: 8, security: 2 }[rm.type] || 0;
      const people = [];
      const n = Math.round(cap * (0.45 + r() * 0.5));
      for (let i = 0; i < n; i++) people.push([rm.x + 1 + r() * (rm.w - 2), rm.y + 1 + r() * (rm.h - 2)]);
      return { ...rm, furn, people, load: 0.3 + r() * 0.7 };
    });
    const panels = [];
    if (f.isRoof) for (const rm of f.rooms.filter((x) => x.type === 'roof')) {
      for (let y = rm.y + 0.8; y < rm.y + rm.h - 1.2; y += 1.5) for (let x = rm.x + 0.8; x < rm.x + rm.w - 1.6; x += 2.1) panels.push([x, y]);
    }
    return { f, li, rooms, panels, corridor: f.corridor };
  });
  const cams = CAMERAS.filter((c) => c.blockId === 'MB' && c.kind === 'room').map((c) => ({ ...c, li: MB.findIndex((f) => f.level === c.floor) })).filter((c) => c.li >= 0);
  const equip = EQUIPMENT.filter((e) => e.blockId === 'MB' && e.kind !== 'solar').map((e) => ({ ...e, li: MB.findIndex((f) => f.level === e.floor) })).filter((e) => e.li >= 0);
  const riser = PANELS.find((p) => p.id === 'DB-MB-G') || { x: 49.5, y: 19 };
  return { floors, cams, equip, riser };
}

export function createLiveBuild(host, { onDone } = {}) {
  const scene = buildScene();
  const canvas = document.createElement('canvas');
  canvas.className = 'lb-canvas';
  canvas.setAttribute('aria-label', 'Live building model. Drag to rotate, wheel to zoom.');
  const hud = document.createElement('div');
  hud.className = 'lb-hud';
  hud.innerHTML = `
    <div class="lb-top">
      <ol class="lb-steps">${[1, 2, 3, 4, 5, 6].map((n) => `<li data-n="${n}"><b>${n}</b><span>${STAGE_TEXT[n][0]}</span><i></i></li>`).join('')}</ol>
      <div class="lb-ctrl"><button type="button" class="sc-btn sm" data-act="skip" hidden>Skip animation</button><button type="button" class="sc-btn sm" data-act="replay" hidden>Replay build</button></div>
    </div>
    <div class="lb-caption"><div class="lb-cap-h"></div><div class="lb-cap-s"></div></div>
    <div class="lb-done" hidden></div>
    <div class="lb-bignum" aria-hidden="true"><small>Stage</small><b></b><span></span></div>
    <div class="lb-banner" hidden role="status"><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-7"/></svg><div><div class="lb-banner-h">3D model creation- COMPLETE</div><div class="lb-banner-s">Drag to rotate it, scroll to zoom.</div></div></div>
    <div class="lb-hint">Drag to rotate &middot; Scroll to zoom &middot; Double-click to pause spin &middot; F for full screen</div>
    <div class="lb-files" hidden><div class="lb-files-h">Uploading test files</div><ul></ul></div>
    <div class="lb-idle"><div class="lb-idle-h">Zero Scan</div><p>Press <b>Test run</b> to upload the sample files from <code>test-files/</code> and watch the Main Block build itself from the data, stage by stage.</p></div>
    <div class="lb-player">
      <label class="lb-speed" title="Animation speed"><span>Speed</span><input type="range" min="0.1" max="1" step="0.1" value="0.5" aria-label="Animation speed"><output>0.5x</output></label>
      <button type="button" class="lb-fs" data-act="fs" aria-label="Maximize" title="Maximize (F)"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path class="fs-in" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path class="fs-out" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div class="lb-counters"></div>
    <div class="lb-bottom">
      <canvas class="lb-meter" width="260" height="70" hidden></canvas>
    </div>`;
  host.append(canvas, hud);
  const $h = (s) => hud.querySelector(s);
  const steps = [...hud.querySelectorAll('.lb-steps li')];
  const meterCv = $h('.lb-meter');

  // ------------------------------------------------------------- state
  let clock = 0, last = 0, raf = 0, visible = true;
  let speed = 0.5, lastTickWall = 0, bannerT = 0;   // playback speed, 0.1x to 1x
  let st = {};               // stage n -> clock time it started
  let pending = [];          // { until, resolve }
  let data = {};             // per-run data from scan results
  let yaw = 0.42, baseYaw = 0.42, swing = 0, zoom = 1.12, drag = null, autoSpin = true, instant = false;
  const counters = { rooms: 0, panels: 0, cameras: 0, people: 0, circuits: 0, facts: 0 };
  const shown = { ...counters };

  const P = (n, delay = 0, dur = 1) => (st[n] == null ? 0 : clamp01((clock - st[n] - delay) / dur));

  // ------------------------------------------------------------- projection
  let W = 0, H = 0, k = 10, ox = 0, oy = 0;
  function proj(x, y, z) {
    const dx = x - CX, dy = y - CY, c = Math.cos(yaw), s = Math.sin(yaw);
    return [ox + (dx * c - dy * s) * k, oy + (dx * s + dy * c) * 0.56 * k - z * 0.92 * k];
  }
  // Fit the model (footprint + full stack height) into the free area between the HUD bars.
  let fitK = 0, fitX = 0, fitY = 0;
  function fit(e) {
    const hb = hud.getBoundingClientRect();
    let top = 60, bot = 24;
    for (const el of [hud.querySelector('.lb-top'), hud.querySelector('.lb-caption.on'), hud.querySelector('.lb-done:not([hidden])')]) if (el) top = Math.max(top, el.getBoundingClientRect().bottom - hb.top + 10);
    const bb = hud.querySelector('.lb-bottom').getBoundingClientRect();
    if (bb.height > 4) bot = Math.max(bot, hb.bottom - bb.top + 8);
    const side = 24;
    const zTop = floorZ(3, e) + 3;
    k = 1; ox = 0; oy = 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of OUTLINE) for (const z of [0, zTop]) { const q = proj(x, y, z); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    const tk = Math.max(2, Math.min((W - 2 * side) / (x1 - x0), (H - top - bot) / (y1 - y0))) * zoom;
    const tx = W / 2 - ((x0 + x1) / 2) * tk, ty = top + (H - top - bot) / 2 - ((y0 + y1) / 2) * tk;
    // Ease towards the target so the camera glides as floors open and close.
    const a = fitK ? 0.12 : 1;
    fitK += (tk - fitK) * a; fitX += (tx - fitX) * a; fitY += (ty - fitY) * a;
    k = fitK; ox = fitX; oy = fitY;
  }
  function depth(x, y) { return (x - CX) * Math.sin(yaw) + (y - CY) * Math.cos(yaw); }
  function path(ctx, pts) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); }

  // Extruded polygon: visible side faces then the top.
  function prism(ctx, poly, z0, h, col, alpha = 1, opts = {}) {
    if (h <= 0.001 && !opts.flat) return;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let mx = 0, my = 0; for (const p of poly) { mx += p[0]; my += p[1]; } mx /= poly.length; my /= poly.length;
    const top = poly.map((p) => proj(p[0], p[1], z0 + h));
    if (h > 0.001) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        let nx = b[1] - a[1], ny = -(b[0] - a[0]);
        const ex = (a[0] + b[0]) / 2 - mx, ey = (a[1] + b[1]) / 2 - my;
        if (nx * ex + ny * ey < 0) { nx = -nx; ny = -ny; }
        const rnx = nx * c - ny * s, rny = nx * s + ny * c;
        if (rny <= 0) continue;
        const lit = 0.58 + 0.25 * (rny / Math.hypot(rnx, rny)) + (rnx < 0 ? 0.06 : -0.04);
        path(ctx, [proj(a[0], a[1], z0), proj(b[0], b[1], z0), proj(b[0], b[1], z0 + h), proj(a[0], a[1], z0 + h)]);
        ctx.fillStyle = rgba(shade(col, lit), alpha); ctx.fill();
        if (opts.edge) { ctx.strokeStyle = rgba(opts.edge, alpha * 0.6); ctx.lineWidth = 0.6; ctx.stroke(); }
      }
    }
    path(ctx, top);
    ctx.fillStyle = rgba(opts.topCol || col, alpha * (opts.topAlpha ?? 1)); ctx.fill();
    if (opts.edge) { ctx.strokeStyle = rgba(opts.edge, alpha); ctx.lineWidth = opts.edgeW || 0.8; ctx.stroke(); }
  }
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

  // ------------------------------------------------------------- frame
  function explode() {
    const a = ease(P(2, 0, 1.0)), b = ease(P(6, 1.4, 1.2));
    return 1 + 0.8 * a - 0.5 * b;
  }
  const floorZ = (li, e) => li * STOREY * e;

  function roomColour(rm) {
    let col = TYPE_COL[rm.type] || [110, 120, 135];
    const pe = P(5, 0.8 + rm.load * 0.6, 0.8);
    if (pe > 0 && !st[6]) col = mix(col, [255, 190, 60], pe * rm.load * 0.55);
    const status = data.status?.[rm.id];
    if (status && st[6] != null) {
      const t = ease(P(6, 1.6 + (rm.x + rm.y) / 90, 0.7));
      col = mix(mix(col, [255, 190, 60], (1 - t) * rm.load * 0.55), STATUS_COL[status], t);
    }
    return col;
  }

  function drawFloor(ctx, F, e) {
    const li = F.li, z = floorZ(li, e);
    const isRoof = F.f.isRoof;
    // Floors 0..2 come in during stage 2; the roof exists from stage 1 as the massing top.
    const slabP = isRoof ? ease(P(1, 1.5, 0.5)) : ease(P(2, 0.35 + 0.45 * li, 0.5));
    if (slabP <= 0) return;
    const slabA = isRoof && !st[2] ? 0 : slabP;   // during stage 1 the massing draws the roof
    if (slabA > 0) {
      prism(ctx, OUTLINE, z - 0.35, 0.35, [26, 36, 49], slabA, { topCol: [16, 23, 32], edge: [70, 95, 125] });
      if (F.corridor && !isRoof) { path(ctx, rect(F.corridor.x, F.corridor.y, F.corridor.w, F.corridor.h).map((p) => proj(p[0], p[1], z + 0.01))); ctx.fillStyle = `rgba(40,52,68,${0.9 * slabA})`; ctx.fill(); }
    }
    // Room floors, furniture, people, cones.
    const rooms = F.rooms;
    const riseOf = (rm, j) => (isRoof ? ease(P(3, 0.3 + j * 0.08, 0.6)) : ease(P(2, 0.6 + 0.45 * li + j * 0.035, 0.45)));
    for (let j = 0; j < rooms.length; j++) {
      const rm = rooms[j];
      if (rm.type === 'roof') continue;
      const rise = riseOf(rm, j);
      if (rise <= 0) continue;
      path(ctx, rect(rm.x, rm.y, rm.w, rm.h).map((p) => proj(p[0], p[1], z + 0.02)));
      ctx.fillStyle = rgba(roomColour(rm), 0.34 * rise); ctx.fill();
      // furniture (stage 3)
      if (rm.furn.length && st[3] != null) {
        rm.furn.forEach((f, i) => {
          const p = pop(P(3, 0.25 + li * 0.25 + i * 0.006, 0.35));
          if (p <= 0) return;
          prism(ctx, rect(f[0], f[1], f[2], f[3]), z, 0.45 * p, [150, 165, 185], 0.85 * Math.min(1, p));
        });
      }
    }
    // Phone interior-scan sweep (stage 3) on MB-1.
    if (F.f.short === 'MB-1' && st[3] != null && P(3, 0, 2.2) < 1) {
      const t = P(3, 0, 2.2), sx = -2 + t * 56;
      const g = ctx.createLinearGradient(...proj(sx - 6, 14, z), ...proj(sx, 14, z));
      g.addColorStop(0, 'rgba(120,220,255,0)'); g.addColorStop(1, 'rgba(120,220,255,.35)');
      path(ctx, rect(Math.max(0, sx - 6), 0, Math.min(6, sx), 29).map((p) => proj(p[0], p[1], z + 0.05))); ctx.fillStyle = g; ctx.fill();
      const a = proj(sx, 0, z + 0.05), b = proj(sx, 29, z + 0.05);
      ctx.strokeStyle = 'rgba(150,230,255,.9)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    // Camera cones + people (stage 4)
    if (st[4] != null) {
      for (const cam of scene.cams) {
        if (cam.li !== li) continue;
        const rm = rooms.find((r) => r.id === cam.roomId); if (!rm) continue;
        const p = ease(P(4, 0.2 + li * 0.35 + (cam.x / 60), 0.5));
        if (p <= 0) continue;
        ctx.save();
        path(ctx, rect(rm.x, rm.y, rm.w, rm.h).map((q) => proj(q[0], q[1], z + 0.03))); ctx.clip();
        const L = 18 * p, a0 = cam.facing - cam.fov / 2, a1 = cam.facing + cam.fov / 2;
        const pts = [[cam.x, cam.y]]; for (let i = 0; i <= 8; i++) { const a = a0 + (a1 - a0) * (i / 8); pts.push([cam.x + Math.cos(a) * L, cam.y + Math.sin(a) * L]); }
        path(ctx, pts.map((q) => proj(q[0], q[1], z + 0.03)));
        const sweep = 0.12 + 0.06 * Math.sin(clock * 3 + cam.x);
        ctx.fillStyle = `rgba(245,179,1,${sweep * p})`; ctx.fill();
        ctx.restore();
      }
      rooms.forEach((rm) => {
        rm.people.forEach((q, i) => {
          const p = P(4, 0.9 + li * 0.3 + i * 0.012, 0.3);
          if (p <= 0) return;
          const a = proj(q[0], q[1], z), b = proj(q[0], q[1], z + 1.1 * pop(p));
          ctx.strokeStyle = 'rgba(149,222,100,.9)'; ctx.lineWidth = Math.max(2, k * 0.18); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
          ctx.fillStyle = '#b7eb8f'; ctx.beginPath(); ctx.arc(b[0], b[1], Math.max(2.6, k * 0.26), 0, 7); ctx.fill();
        });
      });
    }
    // Circuits from the riser (stage 5)
    if (st[5] != null && !isRoof) {
      const rz = z + 0.06, R0 = [scene.riser.x - 1, scene.riser.y + 1];
      rooms.forEach((rm, j) => {
        if (rm.type === 'core' || rm.id.startsWith('RISER')) return;
        const p = P(5, 0.4 + li * 0.3 + j * 0.05, 0.6);
        if (p <= 0) return;
        const c = [rm.x + rm.w / 2, rm.y + rm.h / 2];
        const mid = [c[0], 14.5];
        const seg = [R0, [R0[0], 14.5], mid, c];
        ctx.strokeStyle = `rgba(255,197,61,${0.8 * Math.min(1, p * 2)})`; ctx.lineWidth = Math.max(1, k * 0.12);
        ctx.setLineDash([k * 0.6, k * 0.5]); ctx.lineDashOffset = -clock * k * 2.5;
        ctx.beginPath();
        const total = seg.length - 1, upto = p * total;
        for (let i = 0; i < total && i < upto; i++) {
          const a = seg[i], b = seg[i + 1], t = Math.min(1, upto - i);
          const A = proj(a[0], a[1], rz), B = proj(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, rz);
          if (i === 0) ctx.moveTo(...A); ctx.lineTo(...B);
        }
        ctx.stroke(); ctx.setLineDash([]);
      });
    }
    // Walls (rise in stage 2; roof plant in stage 3)
    const walls = [];
    rooms.forEach((rm, j) => {
      if (rm.type === 'roof') return;
      const rise = riseOf(rm, j);
      if (rise <= 0) return;
      const col = roomColour(rm), t = 0.22, hgt = (isRoof ? 2.4 : WALL) * rise;
      for (const r of [rect(rm.x, rm.y, rm.w, t), rect(rm.x, rm.y + rm.h - t, rm.w, t), rect(rm.x, rm.y, t, rm.h), rect(rm.x + rm.w - t, rm.y, t, rm.h)]) {
        walls.push({ d: depth(r[0][0] + (r[2][0] - r[0][0]) / 2, r[0][1] + (r[2][1] - r[0][1]) / 2), r, col, hgt, a: Math.min(1, rise * 1.4) });
      }
    });
    walls.sort((a, b) => a.d - b.d);
    for (const w of walls) prism(ctx, w.r, z, w.hgt, w.col, 0.82 * w.a, { topCol: shade(w.col, 1.25) });
    // Roof: solar panels (stage 1) and plant equipment (stage 3)
    if (isRoof) {
      const pz = z + 0.05;
      const shownPanels = data.panelCount ? Math.min(F.panels.length, data.panelCount) : F.panels.length;
      for (let i = 0; i < shownPanels; i++) {
        const q = F.panels[i];
        const p = pop(P(1, 1.9 + (i / shownPanels) * 1.3, 0.25));
        if (p <= 0) continue;
        const lift = (1 - Math.min(1, p)) * 4;
        prism(ctx, [[q[0], q[1]], [q[0] + 1.8, q[1]], [q[0] + 1.8, q[1] + 1.1], [q[0], q[1] + 1.1]], pz + lift, 0.25, [30, 70, 140], Math.min(1, p),
          { topCol: [42, 96, 190], edge: [120, 170, 255], edgeW: 0.5 });
      }
    }
    for (const eq of scene.equip) {
      if (eq.li !== li) continue;
      const p = pop(P(3, 0.8 + eq.x / 40, 0.45));
      if (p <= 0) continue;
      const s = eq.kind === 'hvac' ? 3.2 : eq.kind === 'battery' ? 2.4 : 1.6;
      prism(ctx, rect(eq.x - s / 2, eq.y - s / 2, s, s), z, (eq.kind === 'hvac' ? 2.2 : 1.4) * p, eq.kind === 'battery' ? [82, 196, 26] : [200, 210, 225], Math.min(1, p), { edge: [255, 255, 255] });
      const tagP = P(3, 1.3 + eq.x / 40, 0.4) * (1 - P(4, 0, 0.6));
      if (tagP > 0) tag(ctx, proj(eq.x, eq.y, z + 3.2), `${eq.id} ${eq.ratedKW} kW`, tagP, '#f5b301');
    }
    // Cameras on the wall top
    if (st[4] != null) for (const cam of scene.cams) {
      if (cam.li !== li) continue;
      const p = pop(P(4, 0.2 + li * 0.35 + cam.x / 60, 0.4));
      if (p <= 0) continue;
      const q = proj(cam.x, cam.y, z + WALL + 0.3);
      ctx.fillStyle = '#f5b301'; ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(5, k * 0.6) * Math.min(1.3, p), 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1200'; ctx.fillRect(q[0] - Math.max(2, k * 0.25), q[1] - Math.max(1.5, k * 0.15), Math.max(4, k * 0.5), Math.max(3, k * 0.3));
      ctx.strokeStyle = 'rgba(245,179,1,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(9, k * 1.0) + 7 * ((clock * 1.5 + cam.x) % 1), 0, 7); ctx.stroke();
    }
    // Floor label
    const lab = proj(-1.5, 29, z);
    const la = isRoof ? Math.min(slabP, st[2] != null ? 1 : 0) : slabP;
    if (la > 0) { ctx.fillStyle = `rgba(201,214,227,${0.85 * la})`; ctx.font = `600 ${Math.max(13, Math.min(18, k * 1.5))}px JetBrains Mono, monospace`; ctx.textAlign = 'right'; ctx.fillText(F.f.short, lab[0], lab[1]); }
  }

  function tag(ctx, at, text, a, col) {
    ctx.font = '600 13px JetBrains Mono, monospace';
    const w = ctx.measureText(text).width + 16;
    ctx.globalAlpha = clamp01(a);
    ctx.fillStyle = 'rgba(10,14,20,.88)'; ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(at[0] - w / 2, at[1] - 22, w, 22, 5) : ctx.rect(at[0] - w / 2, at[1] - 22, w, 22); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(text, at[0], at[1] - 6);
    ctx.globalAlpha = 1;
  }

  function draw() {
    const fc = fitCanvas(canvas); const ctx = fc.ctx; W = fc.W; H = fc.H;
    const e = explode();
    fit(e);
    const bg = ctx.createRadialGradient(W / 2, H * 0.55, 10, W / 2, H * 0.55, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#0d1520'); bg.addColorStop(1, '#05080c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Site grid
    const g = ease(P(1, 0, 0.7));
    if (g > 0) {
      ctx.strokeStyle = `rgba(40,64,92,${0.55 * g})`; ctx.lineWidth = 1;
      for (let x = -14; x <= 66; x += 4) { ctx.beginPath(); ctx.moveTo(...proj(x, -14, 0)); ctx.lineTo(...proj(x, 42, 0)); ctx.stroke(); }
      for (let y = -14; y <= 42; y += 4) { ctx.beginPath(); ctx.moveTo(...proj(-14, y, 0)); ctx.lineTo(...proj(66, y, 0)); ctx.stroke(); }
    }
    // Footprint trace
    const tr = P(1, 0.3, 1.1);
    if (tr > 0) {
      const per = OUTLINE.map((p, i) => Math.hypot(OUTLINE[(i + 1) % OUTLINE.length][0] - p[0], OUTLINE[(i + 1) % OUTLINE.length][1] - p[1]));
      const total = per.reduce((a, b) => a + b, 0);
      let left = tr * total;
      ctx.strokeStyle = '#52c41a'; ctx.lineWidth = 2; ctx.shadowColor = '#52c41a'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(...proj(OUTLINE[0][0], OUTLINE[0][1], 0));
      let tip = OUTLINE[0];
      for (let i = 0; i < OUTLINE.length && left > 0; i++) {
        const a = OUTLINE[i], b = OUTLINE[(i + 1) % OUTLINE.length], t = Math.min(1, left / per[i]);
        tip = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        ctx.lineTo(...proj(tip[0], tip[1], 0)); left -= per[i];
      }
      ctx.stroke(); ctx.shadowBlur = 0;
      if (tr < 1) { const q = proj(tip[0], tip[1], 0); ctx.fillStyle = '#d9f7be'; ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, 7); ctx.fill(); }
    }
    // Stage 6: drawing outline snapping onto the footprint (ICP)
    if (st[6] != null) {
      const a = P(6, 0, 1.4), t = ease(a), fade = 1 - P(6, 1.6, 0.6);
      if (fade > 0) {
        const ang = (1 - t) * 0.16, ox = (1 - t) * 7, oy = (1 - t) * -5, s = 1 + (1 - t) * 0.08;
        const pts = OUTLINE.map(([x, y]) => { const dx = (x - CX) * s, dy = (y - CY) * s; return [CX + dx * Math.cos(ang) - dy * Math.sin(ang) + ox, CY + dx * Math.sin(ang) + dy * Math.cos(ang) + oy]; });
        path(ctx, pts.map((p) => proj(p[0], p[1], 0.05)));
        ctx.setLineDash([8, 6]); ctx.strokeStyle = `rgba(64,169,255,${fade})`; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
        if (a > 0.05 && a < 1) tag(ctx, proj(CX, -6, 0), `ICP fit: rotation ${(ang * 57.3).toFixed(1)} deg, offset ${Math.hypot(ox, oy).toFixed(1)} m`, fade, '#40a9ff');
      }
    }
    // Massing (stage 1), fades as the floors open in stage 2
    const mh = ease(P(1, 1.1, 0.9)), mFade = 1 - ease(P(2, 0, 0.8));
    if (mh > 0 && mFade > 0) {
      const H3 = 3 * STOREY;
      prism(ctx, OUTLINE, 0, H3 * mh, [58, 78, 102], 0.95 * mFade, { topCol: [24, 34, 46], edge: [110, 150, 190] });
      for (let i = 1; i < 3; i++) if (H3 * mh > i * STOREY) {
        ctx.strokeStyle = `rgba(140,180,220,${0.35 * mFade})`; ctx.lineWidth = 1;
        path(ctx, OUTLINE.map((p) => proj(p[0], p[1], i * STOREY))); ctx.stroke();
      }
      if (P(1, 1.1, 0.9) < 1) tag(ctx, proj(52, -3, H3 * mh + 1), `height ${(H3 * mh).toFixed(1)} m, ${Math.max(1, Math.round(mh * 3))} storeys`, 1, '#69b1ff');
    }
    // Floors bottom-up
    for (const F of scene.floors) drawFloor(ctx, F, e);
    // Riser glow (stage 5)
    if (st[5] != null) {
      const p = ease(P(5, 0, 0.8));
      const a = proj(scene.riser.x - 1, scene.riser.y + 1, 0), b = proj(scene.riser.x - 1, scene.riser.y + 1, floorZ(3, e) * p);
      ctx.strokeStyle = '#ffc53d'; ctx.lineWidth = Math.max(2, k * 0.3); ctx.shadowColor = '#ffc53d'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.shadowBlur = 0;
    }
  }

  // ------------------------------------------------------------- HUD
  function setCounters() {
    const keys = COUNTER_KEYS;
    let changed = !$h('.lb-counters').children.length;
    for (const [kk] of keys) {
      const target = counters[kk];
      if (shown[kk] !== target) { shown[kk] += Math.sign(target - shown[kk]) * Math.max(1, Math.ceil(Math.abs(target - shown[kk]) * 0.12)); if (Math.abs(target - shown[kk]) < 1) shown[kk] = target; changed = true; }
    }
    if (!changed) return;
    const box = $h('.lb-counters');
    for (const [kk, label] of keys) {
      let el = box.querySelector(`[data-k=${kk}]`);
      if (!el) { el = document.createElement('div'); el.className = 'lb-c'; el.dataset.k = kk; el.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[kk]}</svg><b></b><span>${label}</span>`; box.append(el); }
      el.classList.toggle('zero', counters[kk] <= 0);
      el.querySelector('b').textContent = Math.round(shown[kk]);
    }
  }
  function drawMeter() {
    const s = data.series; if (!s?.length || st[5] == null) { meterCv.hidden = true; return; }
    meterCv.hidden = false;
    const ctx = meterCv.getContext('2d'), w = meterCv.width, h = meterCv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,14,20,.85)'; ctx.fillRect(0, 0, w, h);
    const max = Math.max(...s.map((r) => r.kW)) || 1;
    const upto = Math.floor(s.length * P(5, 0.2, 2.4));
    ctx.strokeStyle = '#ffc53d'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = 0; i < upto; i++) { const x = 6 + (i / (s.length - 1)) * (w - 12), y = h - 8 - (s[i].kW / max) * (h - 26); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = '#8b9bb0'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
    ctx.fillText(`Block meter, 1-min kW  peak ${max.toFixed(0)} kW`, 6, 12);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.5, (now - (last || now)) / 1000) * speed; last = now;
    lastTickWall = performance.now();
    if (!visible) return;
    clock += dt;
    if (autoSpin && !drag) { swing += dt * 0.18; yaw = baseYaw + 0.32 * Math.sin(swing); }
    pending = pending.filter((p) => { if (clock >= p.until) { p.resolve(); return false; } return true; });
    draw(); setCounters(); drawMeter();
  }

  // ------------------------------------------------------------- input
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, yaw }; canvas.setPointerCapture(e.pointerId); });
  const endDrag = () => { if (drag) { baseYaw = yaw - 0.32 * Math.sin(swing); drag = null; } };
  canvas.addEventListener('pointermove', (e) => { if (drag) yaw = drag.yaw + (e.clientX - drag.x) * 0.008; });
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => { autoSpin = !autoSpin; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.max(0.5, Math.min(3, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: false });
  // Speed slider and maximize button.
  const speedIn = $h('.lb-speed input'), speedOut = $h('.lb-speed output'), fsBtn = $h('[data-act=fs]');
  function setSpeed(v) {
    speed = Math.max(0.1, Math.min(1, v));
    speedIn.value = speed; speedOut.textContent = `${speed.toFixed(1)}x`;
    hud.style.setProperty('--stage-dur', `${STAGE_DUR / speed}s`);
  }
  speedIn.addEventListener('input', () => setSpeed(parseFloat(speedIn.value)));
  setSpeed(0.5);
  const fsOn = () => document.fullscreenElement === host;
  function toggleFs() {
    if (fsOn()) document.exitFullscreen?.();
    else (host.requestFullscreen || host.webkitRequestFullscreen)?.call(host);
  }
  fsBtn.addEventListener('click', toggleFs);
  document.addEventListener('fullscreenchange', () => {
    const on = fsOn();
    host.classList.toggle('is-fs', on);
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Maximize');
    fsBtn.title = on ? 'Exit full screen (F)' : 'Maximize (F)';
  });
  host.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input')) return;
    if (e.key === 'f' || e.key === 'F') toggleFs();
  });
  $h('[data-act=skip]').addEventListener('click', () => api.skip());
  $h('[data-act=replay]').addEventListener('click', () => api.replay());

  function caption(n, extra) {
    $h('.lb-cap-h').textContent = n ? `${n}. ${STAGE_TEXT[n][0]}` : '';
    $h('.lb-cap-s').textContent = extra || (n ? STAGE_TEXT[n][1] : '');
    $h('.lb-caption').classList.toggle('on', !!n);
    const bn = $h('.lb-bignum');
    if (n) {
      bn.querySelector('b').textContent = n; bn.querySelector('span').textContent = STAGE_TEXT[n][0] + '  /  6';
      bn.classList.remove('on'); void bn.offsetWidth; bn.classList.add('on');
    } else bn.classList.remove('on');
  }
  function stepState(n, s) { const li = steps[n - 1]; if (li) li.dataset.state = s; }

  // Pull what each stage animation needs out of the scan results.
  function absorb(n, scan) {
    const R = scan.results || {};
    if (n === 1) {
      counters.rooms = 0;
      const segs = R.solar?.segments || [];
      const pc = segs.reduce((a, s) => a + (s.panels || s.panelsCount || 0), 0) || R.solar?.panels?.length || R.solar?.maxPanels || 0;
      data.panelCount = pc || null;
      counters.panels = pc || scene.floors.reduce((a, f) => a + f.panels.length, 0);
    }
    if (n === 2) counters.rooms = scene.floors.reduce((a, f) => a + f.rooms.filter((r) => !['core', 'roof'].includes(r.type)).length, 0);
    if (n === 4) {
      counters.cameras = R.cctv?.length || scene.cams.length;
      counters.people = scene.floors.reduce((a, f) => a + f.rooms.reduce((b, r) => b + r.people.length, 0), 0);
    }
    if (n === 5) { data.series = R.nilm?.series || null; counters.circuits = R.nilm?.appliances?.length || 0; }
    if (n === 6) {
      const rank = { accepted: 0, human: 1, review: 2, conflict: 3 };
      const status = {};
      for (const r of scan.fused?.resolved || []) {
        const ids = [r.subject, typeof r.value === 'string' ? r.value : null].filter(Boolean);
        for (const id of ids) if (rank[r.status] != null && (status[id] == null || rank[r.status] > rank[status[id]])) status[id] = r.status;
      }
      data.status = status;
      counters.facts = scan.fused?.resolved?.length || 0;
    }
  }

  const api = {
    // Start a fresh build (keeps the camera angle).
    reset() {
      st = {}; data = {}; clock = 0; instant = false;
      for (const kk in counters) { counters[kk] = 0; shown[kk] = 0; }
      pending.forEach((p) => p.resolve()); pending = [];
      steps.forEach((s) => (s.dataset.state = 'idle'));
      $h('.lb-done').hidden = true; $h('.lb-banner').hidden = true; $h('.lb-idle').hidden = true;
      $h('[data-act=skip]').hidden = false; $h('[data-act=replay]').hidden = true;
      $h('.lb-counters').innerHTML = '';
      $h('.lb-counters').hidden = false;
      $h('.lb-bottom').hidden = false;
      caption(0);
    },
    // Files arriving during a test run.
    files(list) {
      const box = $h('.lb-files'), ul = box.querySelector('ul');
      box.hidden = !list; if (!list) return;
      $h('.lb-idle').hidden = true;
      ul.innerHTML = list.map((f) => `<li data-key="${f.key}" data-state="${f.state || 'queued'}"><span class="nm">${f.file}</span><span class="sz">${(f.bytes / 1024).toFixed(1)} KB</span><i style="--p:${f.progress || 0}"></i></li>`).join('');
    },
    fileProgress(key, progress, state) {
      const li = $h(`.lb-files li[data-key="${key}"]`); if (!li) return;
      li.querySelector('i').style.setProperty('--p', progress);
      if (state) li.dataset.state = state;
    },
    caption,
    // Go full screen (called from the Test run click so the browser allows it).
    enterFullscreen() { if (!fsOn()) toggleFs(); },
    // Play stage n; resolves when its animation has run.
    stage(n, scan, state = 'done') {
      absorb(n, scan);
      st[n] = clock;
      stepState(n, state === 'error' ? 'error' : 'running');
      caption(n);
      if (n === 1) $h('.lb-files').hidden = true;
      const dur = instant ? 0 : STAGE_DUR;
      if (instant) st[n] = clock - 30;
      return new Promise((resolve) => {
        const item = { until: clock + dur, done: false, resolve: () => { if (item.done) return; item.done = true; stepState(n, state === 'error' ? 'error' : 'done'); resolve(); } };
        pending.push(item);
        // Wall-clock fallback: a hidden or throttled tab must not stall the scan.
        // While frames are still being drawn (slow playback), keep waiting instead.
        const guard = (ms) => setTimeout(() => {
          if (item.done) return;
          if (performance.now() - lastTickWall < 1000 && visible) { guard(Math.max(300, ((item.until - clock) / speed) * 1000 + 1200)); return; }
          clock = Math.max(clock, item.until); pending = pending.filter((p) => p !== item); item.resolve();
        }, ms);
        guard((dur / speed) * 1000 + 1200);
      });
    },
    finish(scan) {
      const s = scan.summary || { total: 0, autoPct: 0, open: 0 };
      caption(0);
      $h('[data-act=skip]').hidden = true; $h('[data-act=replay]').hidden = false;
      const box = $h('.lb-done');
      box.innerHTML = `<div class="lb-done-h">3D model is done</div>
        <div class="lb-done-k"><div><b>${s.total}</b><span>statements</span></div><div><b class="ok">${s.autoPct}%</b><span>accepted on their own</span></div><div><b class="${s.open ? 'warn' : 'ok'}">${s.open}</b><span>need a person</span></div></div>
        <div class="lb-done-n">${[[counters.panels, 'solar panels'], [counters.rooms, 'rooms'], [counters.cameras, 'cameras calibrated'], [counters.people, 'people seen'], [counters.circuits, 'appliances found']].filter((x) => x[0] > 0).map(([v, l]) => `<span><b>${v}</b> ${l}</span>`).join('')}</div>
        <div class="lb-legend"><span><i style="background:#52c41a"></i>accepted</span><span><i style="background:#faad14"></i>to confirm</span><span><i style="background:#ff4d4f"></i>conflict</span><span><i style="background:#5a6473"></i>no source yet</span></div>
        <div class="lb-done-b"><button type="button" class="sc-btn sm primary" data-go="model">Open the fused plan</button><button type="button" class="sc-btn sm" data-go="todo">Answer the to-dos</button></div>`;
      box.hidden = false;
      $h('.lb-bottom').hidden = true;
      const bnr = $h('.lb-banner'); bnr.hidden = false; bnr.classList.remove('on'); void bnr.offsetWidth; bnr.classList.add('on');
      clearTimeout(bannerT); bannerT = setTimeout(() => { bnr.hidden = true; }, 6000);
      box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => onDone && onDone(b.dataset.go)));
      api._last = scan;
    },
    skip() {
      instant = true;
      for (const n in st) st[n] = Math.min(st[n], clock - 30);
      pending.forEach((p) => p.resolve()); pending = [];
    },
    // Re-play the animation for the last finished scan without re-running it.
    async replay() {
      const scan = api._last; if (!scan) return;
      api.reset();
      for (let n = 1; n <= 6; n++) await api.stage(n, scan);
      api.finish(scan);
    },
    setVisible(v) { visible = v; if (v) last = 0; },
    get running() { return pending.length > 0; },
    _last: null,
  };
  raf = requestAnimationFrame(tick);
  return api;
}
