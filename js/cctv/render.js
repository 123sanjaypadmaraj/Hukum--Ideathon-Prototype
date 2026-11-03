// Perspective camera, shading and drawing helpers for the synthetic CCTV feeds.
import { CEIL, FACE_NF } from './scenes.js';

export const NEAR = 0.06;
const K = 0.16;                       // barrel distortion strength (fisheye-ish feel)
const KZ = Math.sqrt(1 + K);          // keeps the frame edge at the nominal FOV
export const FONT = '"JetBrains Mono", ui-monospace, Consolas, monospace';

// ------------------------------------------------------------- camera
export function makeView(cam, W, H, scene = {}) {
  const corridor = cam.kind === 'corridor', out = cam.kind === 'outdoor';
  // Room cameras: ceiling mount ~2.8 m, ~26 deg down. Outdoor: pole mount,
  // pulled back a little so the whole zone is in frame.
  const pitch = scene.pitch ?? (out ? 0.36 : corridor ? 0.2 : 0.46);
  const z = scene.camZ ?? (out ? 5.5 : corridor ? 2.75 : 2.8);
  const fov = scene.fov || cam.fov || Math.PI / 2;
  const yaw = scene.yaw ?? cam.facing;
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const back = out ? 2.5 : 0;
  return {
    C: scene.camXY ? [scene.camXY[0], scene.camXY[1], z] : [cam.x - c * back, cam.y - s * back, z],
    f: [c * cp, s * cp, -sp],
    r: [-s, c, 0],
    u: [c * sp, s * sp, cp],
    fh: [c, s],
    focal: (W / 2) / Math.tan(fov / 2),
    hx: W / 2, hy: H / 2, W, H,
  };
}

function toCam(v, x, y, z) {
  const dx = x - v.C[0], dy = y - v.C[1], dz = z - v.C[2];
  return [
    dx * v.r[0] + dy * v.r[1],
    dx * v.u[0] + dy * v.u[1] + dz * v.u[2],
    dx * v.f[0] + dy * v.f[1] + dz * v.f[2],
  ];
}

function projCam(v, xc, yc, zc, out) {
  const n = v.focal / zc / v.hx;
  const px = xc * n, py = -yc * n;
  const s = KZ / Math.sqrt(1 + K * (px * px + py * py));
  out[0] = v.hx + px * s * v.hx;
  out[1] = v.hy + py * s * v.hx;
  return out;
}

// World point -> [sx, sy, depth] or null when behind the camera.
export function project(v, x, y, z) {
  const c = toCam(v, x, y, z);
  if (c[2] < NEAR) return null;
  const o = projCam(v, c[0], c[1], c[2], [0, 0]);
  o.push(c[2]);
  return o;
}

// Pixels per metre (horizontal) at a world point, including distortion.
export function scaleAt(v, x, y, z) {
  const a = project(v, x, y, z);
  const b = project(v, x + v.r[0] * 0.5, y + v.r[1] * 0.5, z);
  if (!a || !b) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) * 2;
}

const tmp = [0, 0];
// Builds a canvas path for a 3D polygon: near-plane clip, edge subdivision
// (so straight edges bend with the lens), projection. Returns false if empty.
export function pathPoly(ctx, v, pts) {
  const n = pts.length;
  const cam = new Array(n);
  let anyIn = false;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    cam[i] = toCam(v, p[0], p[1], p[2]);
    if (cam[i][2] >= NEAR) anyIn = true;
  }
  if (!anyIn) return false;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = cam[i], b = cam[(i + 1) % n];
    const ain = a[2] >= NEAR, bin = b[2] >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  const m = out.length;
  if (m < 3) return false;
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < m; i++) {
    const a = out[i], b = out[(i + 1) % m];
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
    const seg = Math.min(6, Math.max(1, Math.ceil(len / 1.2)));
    for (let k = 0; k < seg; k++) {
      const t = k / seg;
      projCam(v, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, tmp);
      if (first) { ctx.moveTo(tmp[0], tmp[1]); first = false; } else ctx.lineTo(tmp[0], tmp[1]);
    }
  }
  ctx.closePath();
  return true;
}

// ------------------------------------------------------------- lighting
export function daylight(mod, weather) {
  const rise = 6 * 60, set = 18 * 60 + 30;
  if (mod <= rise || mod >= set) return 0;
  const x = (mod - rise) / (set - rise);
  const w = weather === 'monsoon' ? 0.45 : weather === 'cloudy' ? 0.68 : 1;
  return Math.pow(Math.sin(Math.PI * x), 0.6) * w;
}

function skyColor(mod, day) {
  if (day <= 0.02) return [16, 22, 36];
  const h = mod / 60;
  const dusk = h < 9 ? Math.max(0, (9 - h) / 3) : h > 16 ? Math.max(0, (h - 16) / 2.5) : 0;
  const base = [228, 238, 246], warm = [238, 176, 120];
  const k = Math.min(1, dusk);
  const c = base.map((b, i) => b * (1 - k) + warm[i] * k);
  const lvl = 0.35 + 0.65 * Math.min(1, day * 1.4);
  return c.map((x) => x * lvl);
}

export function makeLight({ mod, weather, lightsOn, powered, fansOn, winGain, alwaysScreens, outdoor, flood, streetLit }) {
  const day = daylight(mod, weather);
  let level, ir, lamps = lightsOn, tint;
  if (outdoor) {
    const night = day < 0.14;
    lamps = night;
    level = night ? 0.1 + (streetLit ? 0.36 : 0.04) + (flood ? 0.5 : 0) : 0.2 + day * 0.9;
    ir = night && level < 0.26;
    tint = night ? [1.12, 0.98, 0.8] : [0.97, 1.0, 1.04];
  } else {
    level = lightsOn ? 1.0 : 0.05 + day * winGain;
    ir = !lightsOn && level < 0.26;
    tint = lightsOn ? [1.03, 1.0, 0.95] : [0.94, 1.0, 1.07];
  }
  return {
    mod, day, lightsOn: lamps, powered, fansOn, ir, level, winGain, outdoor: !!outdoor, flood: !!flood,
    attK: outdoor ? 0.004 : 0.021,
    screens: alwaysScreens || (powered && lightsOn),
    sky: skyColor(mod, day),
    tint,
    key: `${ir ? 1 : 0}|${Math.round(level * 24)}|${Math.round(day * 24)}|${lamps ? 1 : 0}|${powered ? 1 : 0}|${alwaysScreens ? 1 : 0}|${flood ? 1 : 0}`,
  };
}

const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x | 0);
const rgb = (r, g, b) => `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
const lum = (c) => (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255;

// Colour of a surface given the scene light. dist = metres from camera,
// wb = extra light from nearby windows, em = emissive kind.
export function shade(L, c, nf, dist, wb = 0, ao = 1, em) {
  if (c === 'sky') c = L.sky;
  if (em === 'sky') {
    if (L.ir) { const g = 40 + lum(c) * 60; return rgb(g, g, g); }
    return rgb(c[0], c[1], c[2]);
  }
  if (em === 'win' && L.outdoor && L.day < 0.2) {
    if (L.ir) return rgb(190, 190, 190);
    return rgb(236, 206, 140);
  }
  if ((em === 'lamp' && L.lightsOn) || (em === 'flood' && L.flood) || em === 'always' || (em === 'screen' && L.screens)) {
    const cc = em === 'lamp' || em === 'flood' ? [255, 252, 238] : c;
    if (L.ir) { const g = 150 + lum(cc) * 100; return rgb(g, g, g); }
    return rgb(cc[0], cc[1], cc[2]);
  }
  if (em === 'screen') c = [22, 24, 28];
  if (L.ir) {
    const att = Math.max(0.08, Math.min(1.3, 1.75 / (1 + dist * (L.outdoor ? 0.07 : 0.2))));
    const g = (0.2 + 0.8 * lum(c)) * nf * att * ao * 215;
    return rgb(g, g, g * 1.01);
  }
  const att = 1.06 - Math.min(0.34, dist * L.attK);
  const k = (L.level * att + wb) * nf * ao;
  return rgb(c[0] * k * L.tint[0], c[1] * k * L.tint[1], c[2] * k * L.tint[2]);
}

export function toneFn(L, v) {
  return (c, x, y, z = 1, k = 1) => {
    const d = Math.hypot(x - v.C[0], y - v.C[1], z - v.C[2]);
    return shade(L, k === 1 ? c : [c[0] * k, c[1] * k, c[2] * k], 0.95, d, 0, 1);
  };
}

function winBonus(L, scene, cen) {
  if (L.ir || !scene.winPlanes.length || L.day <= 0) return 0;
  let dw = 99;
  for (const p of scene.winPlanes) dw = Math.min(dw, Math.abs(cen[p.a] - p.v));
  return L.day * L.winGain * (L.lightsOn ? 0.25 : 0.7) * Math.exp(-dw / 2.4);
}

const dist3 = (v, p) => Math.hypot(p[0] - v.C[0], p[1] - v.C[1], p[2] - v.C[2]);

// ------------------------------------------------------------- scene drawing
export function drawShell(ctx, v, scene, L) {
  const lw = Math.max(0.6, v.W / 900);
  for (const q of scene.shell) {
    if (!pathPoly(ctx, v, q.pts)) continue;
    if (q.alpha != null) {
      ctx.fillStyle = `rgba(0,0,0,${L.ir ? q.alpha * 1.3 : q.alpha})`;
      ctx.fill();
      continue;
    }
    const col = shade(L, q.c, q.nf, dist3(v, q.cen), winBonus(L, scene, q.cen), q.ao || 1, q.em);
    ctx.fillStyle = col;
    ctx.fill();
    if (q.grout) {
      ctx.strokeStyle = L.ir ? 'rgba(0,0,0,0.18)' : 'rgba(40,30,20,0.16)';
      ctx.lineWidth = lw;
      ctx.stroke();
    } else if (q.seam) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function facePts(b, f, s0, s1, t0, t1, e) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const L = (a, c, t) => a + (c - a) * t;
  switch (f) {
    case 'x-': { const x = x0 - e, ya = L(y0, y1, s0), yb = L(y0, y1, s1), za = L(z0, z1, t0), zb = L(z0, z1, t1); return [[x, ya, za], [x, yb, za], [x, yb, zb], [x, ya, zb]]; }
    case 'x+': { const x = x1 + e, ya = L(y0, y1, s0), yb = L(y0, y1, s1), za = L(z0, z1, t0), zb = L(z0, z1, t1); return [[x, ya, za], [x, yb, za], [x, yb, zb], [x, ya, zb]]; }
    case 'y-': { const y = y0 - e, xa = L(x0, x1, s0), xb = L(x0, x1, s1), za = L(z0, z1, t0), zb = L(z0, z1, t1); return [[xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]]; }
    case 'y+': { const y = y1 + e, xa = L(x0, x1, s0), xb = L(x0, x1, s1), za = L(z0, z1, t0), zb = L(z0, z1, t1); return [[xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]]; }
    default: { const z = z1 + e, xa = L(x0, x1, s0), xb = L(x0, x1, s1), ya = L(y0, y1, t0), yb = L(y0, y1, t1); return [[xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z]]; }
  }
}

function facePoint(b, f, s, t) {
  const p = facePts(b, f, s, s, t, t, 0.01)[0];
  return p;
}

function visibleFaces(v, b) {
  const C = v.C, out = [];
  if (C[0] < b[0]) out.push('x-'); else if (C[0] > b[3]) out.push('x+');
  if (C[1] < b[1]) out.push('y-'); else if (C[1] > b[4]) out.push('y+');
  if (C[2] > b[5]) out.push('z+');
  return out;
}

export function drawBox(ctx, v, scene, L, item, time) {
  const b = item.b;
  if (item.shadow) {
    const e = 0.09;
    if (pathPoly(ctx, v, [[b[0] - e, b[1] - e, 0.004], [b[3] + e, b[1] - e, 0.004], [b[3] + e, b[4] + e, 0.004], [b[0] - e, b[4] + e, 0.004]])) {
      ctx.fillStyle = L.ir ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.2)';
      ctx.fill();
    }
  }
  const faces = visibleFaces(v, b);
  const wb = winBonus(L, scene, item.cen);
  for (const f of faces) {
    const pts = facePts(b, f, 0, 1, 0, 1, 0);
    if (!pathPoly(ctx, v, pts)) continue;
    const fc = item.cf?.[f] || (f === 'z+' ? (item.top || item.c) : item.c);
    const d = dist3(v, item.cen);
    const nf = FACE_NF[f];
    ctx.fillStyle = shade(L, fc, nf, d, wb, 1, item.em?.[f]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (item.decals) {
      for (const dc of item.decals) {
        if (dc.f !== f) continue;
        if (!pathPoly(ctx, v, facePts(b, f, dc.s0, dc.s1, dc.t0, dc.t1, 0.004))) continue;
        ctx.fillStyle = shade(L, dc.c, nf, d, wb, 1, dc.em);
        ctx.fill();
      }
    }
    if (item.leds) {
      const sz = Math.max(1, v.W / 420);
      for (let i = 0; i < item.leds.length; i++) {
        const led = item.leds[i];
        if (led.f !== f) continue;
        const p = facePoint(b, f, led.s, led.t);
        const sp = project(v, p[0], p[1], p[2]);
        if (!sp) continue;
        const hsh = Math.sin((i + 1) * 91.7 + Math.floor(time * (3 + (i % 5))) * 13.1) * 43758.5;
        const on = (hsh - Math.floor(hsh)) > 0.3;
        if (!on) continue;
        const c = led.c;
        ctx.fillStyle = L.ir ? 'rgb(235,235,235)' : rgb(c[0], c[1], c[2]);
        ctx.fillRect(sp[0] - sz / 2, sp[1] - sz / 2, sz, sz);
      }
    }
  }
}

export function drawBlob(ctx, v, L, item) {
  const p = item.p;
  const sp = project(v, p[0], p[1], p[2]);
  if (!sp) return;
  const r = scaleAt(v, p[0], p[1], p[2]) * item.r;
  if (r < 0.5) return;
  const d = dist3(v, p);
  const c = item.c;
  const g = ctx.createRadialGradient(sp[0] - r * 0.3, sp[1] - r * 0.4, r * 0.1, sp[0], sp[1], r);
  g.addColorStop(0, shade(L, [c[0] * 1.35, c[1] * 1.35, c[2] * 1.35], 1, d));
  g.addColorStop(1, shade(L, [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55], 1, d));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(sp[0], sp[1], r, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
}

// Ceiling fans: spin (with blur) when fansOn.
export function drawFans(ctx, v, scene, L, time) {
  for (const [x, y, a0] of scene.fans) {
    const top = project(v, x, y, CEIL), hub = project(v, x, y, 2.88);
    if (!top || !hub) continue;
    const d = Math.hypot(x - v.C[0], y - v.C[1]);
    ctx.strokeStyle = shade(L, [90, 90, 90], 0.8, d);
    ctx.lineWidth = Math.max(1, v.W / 500);
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(hub[0], hub[1]); ctx.stroke();
    const spin = L.fansOn;
    const ang = spin ? a0 + time * 9 : a0;
    const blade = shade(L, [214, 210, 200], 0.75, d);
    if (spin) {
      const disc = [];
      for (let k = 0; k < 14; k++) { const t = k / 14 * Math.PI * 2; disc.push([x + Math.cos(t) * 0.68, y + Math.sin(t) * 0.68, 2.86]); }
      if (pathPoly(ctx, v, disc)) { ctx.fillStyle = L.ir ? 'rgba(200,200,200,0.12)' : 'rgba(210,205,195,0.16)'; ctx.fill(); }
    }
    ctx.globalAlpha = spin ? 0.5 : 1;
    for (let k = 0; k < 3; k++) {
      const a = ang + k * Math.PI * 2 / 3;
      const cx = Math.cos(a), cy = Math.sin(a), px = -cy, py = cx;
      const pts = [
        [x + cx * 0.1 + px * 0.04, y + cy * 0.1 + py * 0.04, 2.86],
        [x + cx * 0.68 + px * 0.075, y + cy * 0.68 + py * 0.075, 2.86],
        [x + cx * 0.68 - px * 0.075, y + cy * 0.68 - py * 0.075, 2.86],
        [x + cx * 0.1 - px * 0.04, y + cy * 0.1 - py * 0.04, 2.86],
      ];
      if (pathPoly(ctx, v, pts)) { ctx.fillStyle = blade; ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    const hr = Math.max(1.5, scaleAt(v, x, y, 2.88) * 0.1);
    ctx.fillStyle = shade(L, [150, 146, 140], 0.8, d);
    ctx.beginPath(); ctx.ellipse(hub[0], hub[1], hr, hr * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  }
}

// Occupancy heat: coloured floor cells.
export function drawHeat(ctx, v, rect, grid) {
  if (!grid) return;
  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  if (max <= 1e-6) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let j = 0; j < rect.h; j++) {
    for (let i = 0; i < rect.w; i++) {
      const val = grid[j * rect.w + i] / max;
      if (val < 0.04) continue;
      const x = rect.x + i, y = rect.y + j;
      if (!pathPoly(ctx, v, [[x, y, 0.02], [x + 1, y, 0.02], [x + 1, y + 1, 0.02], [x, y + 1, 0.02]])) continue;
      ctx.fillStyle = heatColor(val);
      ctx.fill();
    }
  }
  ctx.restore();
}

function heatColor(t) {
  // blue -> cyan -> green -> yellow -> red
  const stops = [[40, 90, 255], [0, 210, 230], [60, 220, 90], [255, 220, 40], [255, 60, 40]];
  const x = Math.min(0.999, t) * (stops.length - 1), i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return `rgba(${(a[0] + (b[0] - a[0]) * f) | 0},${(a[1] + (b[1] - a[1]) * f) | 0},${(a[2] + (b[2] - a[2]) * f) | 0},${0.22 + 0.4 * t})`;
}

// Sky above the horizon and hazy distant ground below it (outdoor cameras).
export function drawSky(ctx, v, L) {
  const far = 3000;
  const h = project(v, v.C[0] + v.fh[0] * far, v.C[1] + v.fh[1] * far, v.C[2]);
  const hy = h ? Math.max(-10, Math.min(v.H + 10, h[1])) : -10;
  let top, hor, ground;
  const d = L.day;
  if (d <= 0.02) { top = [6, 9, 20]; hor = [26, 32, 50]; ground = [22, 24, 26]; }
  else {
    const dusk = Math.max(0, 1 - d * 2.2);
    top = [96 + 40 * (1 - d), 150 - 20 * dusk, 215 - 40 * dusk].map((x) => x * (0.45 + 0.55 * d));
    hor = [222, 228 - 40 * dusk, 236 - 90 * dusk].map((x) => x * (0.55 + 0.45 * d));
    ground = [120, 128, 110].map((x) => x * (0.4 + 0.6 * d));
  }
  const g2 = (c) => { const y = (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) * 0.6; return [y, y, y]; };
  if (L.ir) { top = g2(top); hor = g2(hor); ground = g2(ground); }
  const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
  g.addColorStop(0, css(top)); g.addColorStop(1, css(hor));
  ctx.fillStyle = g; ctx.fillRect(0, 0, v.W, Math.max(0, hy) + 1);
  ctx.fillStyle = css(ground); ctx.fillRect(0, Math.max(0, hy), v.W, v.H);
  if (d > 0.3 && !L.ir) {
    // A few soft clouds.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 0.23 + 0.07) % 1) * v.W, y = hy * (0.25 + (i % 3) * 0.18);
      ctx.beginPath(); ctx.ellipse(x, y, v.W * 0.08, v.H * 0.025, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// Street lights / floodlights at night: light pools on the ground + halos.
export function drawGlows(ctx, v, scene, L, phase) {
  if (!scene.glows || L.day >= 0.14) return;
  ctx.save();
  ctx.globalCompositeOperation = L.ir ? 'source-over' : 'lighter';
  for (const gl of scene.glows) {
    const on = gl.kind === 'flood' ? L.flood : L.lightsOn;
    if (!on) continue;
    const [x, y, z] = gl.p;
    if (phase === 'pool') {
      const c = project(v, x, y, 0);
      if (!c) continue;
      const r = scaleAt(v, x, y, 0) * gl.r * 0.6;
      if (r < 2) continue;
      const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
      g.addColorStop(0, L.ir ? 'rgba(255,255,255,0.12)' : 'rgba(255,200,120,0.22)');
      g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(c[0], c[1], r, r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      const c = project(v, x, y, z);
      if (!c) continue;
      const r = Math.max(4, scaleAt(v, x, y, z) * (gl.kind === 'flood' ? 2.2 : 1.1));
      const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
      g.addColorStop(0, 'rgba(255,240,210,0.75)');
      g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g;
      ctx.fillRect(c[0] - r, c[1] - r, r * 2, r * 2);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------- post effects
let noiseTiles = null, scanCache = null;
function getNoise() {
  if (noiseTiles) return noiseTiles;
  noiseTiles = [];
  for (let k = 0; k < 3; k++) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    noiseTiles.push(c);
  }
  return noiseTiles;
}
function getScan(ctx, small) {
  if (!scanCache) {
    const make = (h) => {
      const c = document.createElement('canvas');
      c.width = 4; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, h - 1, 4, 1);
      return c;
    };
    scanCache = { small: make(2), large: make(3) };
  }
  const key = small ? 'patSmall' : 'patLarge';
  if (!ctx[key]) ctx[key] = ctx.createPattern(small ? scanCache.small : scanCache.large, 'repeat');
  return ctx[key];
}

export function noiseLayer(ctx, W, H, alpha, scalePx = 1) {
  const tiles = getNoise();
  const t = tiles[(Math.random() * tiles.length) | 0];
  const ox = (Math.random() * 256) | 0, oy = (Math.random() * 256) | 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  const pat = ctx.createPattern(t, 'repeat');
  ctx.translate(-ox, -oy);
  if (scalePx !== 1) ctx.scale(scalePx, scalePx);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, (W + ox) / scalePx + 2, (H + oy) / scalePx + 2);
  ctx.restore();
}

export function postFx(ctx, W, H, L, small) {
  ctx.save();
  // Camera colour response: slightly desaturated, cool.
  if (!L.ir) {
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'rgba(128,128,128,0.28)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = 'rgba(60,110,120,0.18)';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
  noiseLayer(ctx, W, H, L.ir ? 0.16 : 0.06, small ? 1 : 1.5);
  ctx.save();
  ctx.fillStyle = getScan(ctx, small);
  ctx.fillRect(0, 0, W, H);
  // Vignette.
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.56);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, L.ir ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Occasional analogue tear line.
  if (Math.random() < 0.03) {
    const y = Math.random() * H;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, y, W, Math.max(1, H / 90));
  }
  ctx.restore();
}

export function drawNoSignal(ctx, W, H, time, small) {
  ctx.fillStyle = '#0a0b0d';
  ctx.fillRect(0, 0, W, H);
  noiseLayer(ctx, W, H, 0.55, small ? 1 : 2);
  ctx.save();
  // Rolling bands.
  const y = ((time * 60) % (H + 80)) - 40;
  const g = ctx.createLinearGradient(0, y - 30, 0, y + 30);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, y - 30, W, 60);
  const fs = Math.max(11, W / 20);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const bw = Math.min(W * 0.86, fs * 13);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(W / 2 - bw / 2, H / 2 - fs * 1.3, bw, small ? fs * 2.3 : fs * 2.7);
  ctx.fillStyle = '#ff4d4f';
  ctx.font = `700 ${fs}px ${FONT}`;
  ctx.fillText('NO SIGNAL', W / 2, H / 2 - fs * 0.45);
  ctx.fillStyle = '#ffd666';
  ctx.font = `600 ${Math.max(8, fs * 0.42)}px ${FONT}`;
  ctx.fillText('fail-safe: room power held ON', W / 2, H / 2 + fs * 0.55);
  ctx.restore();
}

// ------------------------------------------------------------- overlays
function label(ctx, text, x, y, fs, align, color = '#e6edf5', bg = 'rgba(0,0,0,0.5)') {
  ctx.font = `600 ${fs}px ${FONT}`;
  const w = ctx.measureText(text).width;
  const pad = fs * 0.35;
  const bx = align === 'right' ? x - w - pad * 2 : x;
  ctx.fillStyle = bg;
  ctx.fillRect(bx, y, w + pad * 2, fs * 1.45);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + pad, y + fs * 0.75);
  return w + pad * 2;
}

export function drawOverlays(ctx, W, H, o) {
  const small = o.small;
  const fs = small ? Math.max(8, W / 34) : Math.max(11, W / 70);
  const m = fs * 0.6;
  ctx.save();
  // Top-left: camera id + zone.
  const w1 = label(ctx, o.camId, m, m, fs, 'left', '#ffffff', 'rgba(0,0,0,0.6)');
  if (!small) label(ctx, `ZONE: ${o.zone}`, m + w1 + fs * 0.4, m, fs, 'left', '#ffd666');
  // Top-right: timestamp + REC.
  const ts = `D${o.day} ${o.time}`;
  const w2 = label(ctx, ts, W - m, m, fs, 'right');
  const blink = Math.floor(o.now * 2) % 2 === 0;
  if (!o.offline && blink) {
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath(); ctx.arc(W - m - w2 - fs * 0.7, m + fs * 0.72, fs * 0.36, 0, Math.PI * 2); ctx.fill();
  }
  if (o.ir && !o.offline) label(ctx, 'IR', W - m, m + fs * 1.75, fs, 'right', '#ffffff', 'rgba(0,0,0,0.55)');
  // Bottom-left: privacy statement.
  const by = H - m - fs * 1.45;
  if (small) label(ctx, o.offline ? 'OFFLINE' : 'LIVE', m, by, fs, 'left', o.offline ? '#ff4d4f' : '#52c41a');
  else label(ctx, 'LIVE · edge-processed · frames not stored', m, by, fs, 'left', '#cfe8d0');
  // Bottom-right: count + fps.
  if (!o.offline) {
    const txt = small ? `${o.count} ppl` : `PEOPLE ${o.count} · ${o.fps} FPS`;
    label(ctx, txt, W - m, by, fs, 'right', '#ffffff', 'rgba(0,0,0,0.6)');
    if (!small && o.power) label(ctx, o.power, W - m, by - fs * 1.8, fs, 'right', o.powerColor || '#e6edf5');
    if (!small && o.heat) label(ctx, 'HEATMAP: last 30 min', m, by - fs * 1.8, fs, 'left', '#ffc53d');
    if (!small && o.privacy) label(ctx, 'PRIVACY: faces masked', m, by - fs * (o.heat ? 3.6 : 1.8), fs, 'left', '#69b1ff');
  }
  // Corner brackets for the CCTV feel.
  if (!small) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    const L = Math.min(W, H) * 0.05, e = m * 0.5;
    for (const [x, y, sx, sy] of [[e, e, 1, 1], [W - e, e, -1, 1], [e, H - e, 1, -1], [W - e, H - e, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    }
    // Centre crosshair.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 + 8, H / 2);
    ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 + 8);
    ctx.stroke();
  }
  ctx.restore();
}

// YOLO-style detection boxes. dets: [{box:[x0,y0,x1,y1], conf}]
export function drawDetections(ctx, W, H, boxes, small) {
  const fs = small ? Math.max(7, W / 42) : Math.max(10, W / 84);
  ctx.save();
  ctx.lineWidth = small ? 1 : 1.6;
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const d of boxes) {
    const [x0, y0, x1, y1] = d.box;
    const col = d.conf >= 0.6 ? '#3cf0a0' : '#ffc53d';
    ctx.strokeStyle = col;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // Thicker corners.
    const c = Math.min(8, (x1 - x0) * 0.3, (y1 - y0) * 0.3);
    ctx.lineWidth = small ? 1.5 : 2.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + c); ctx.lineTo(x0, y0); ctx.lineTo(x0 + c, y0);
    ctx.moveTo(x1 - c, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + c);
    ctx.moveTo(x0, y1 - c); ctx.lineTo(x0, y1); ctx.lineTo(x0 + c, y1);
    ctx.moveTo(x1 - c, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - c);
    ctx.stroke();
    ctx.lineWidth = small ? 1 : 1.6;
    if (!small || (x1 - x0) > 14) {
      const txt = small ? d.conf.toFixed(2) : `person ${d.conf.toFixed(2)}`;
      const tw = ctx.measureText(txt).width + fs * 0.6;
      const ly = y0 - fs * 1.3 < 0 ? y0 : y0 - fs * 1.3;
      ctx.fillStyle = col;
      ctx.fillRect(x0 - (small ? 0.5 : 0.8), ly, tw, fs * 1.3);
      ctx.fillStyle = '#0b0f14';
      ctx.fillText(txt, x0 + fs * 0.3, ly + fs * 0.66);
    }
  }
  ctx.restore();
}
