// Shaded human figures for the CCTV feeds, projected from world tile
// positions so they line up with the detection boxes.
import { mulberry32 } from '../config.js';
import { project, scaleAt } from './render.js';

const SHIRTS = [[196, 58, 58], [56, 104, 196], [236, 236, 230], [44, 44, 50], [86, 156, 92], [226, 178, 58],
  [146, 88, 166], [76, 166, 186], [206, 118, 58], [118, 118, 128], [242, 196, 206], [30, 70, 110], [170, 30, 70]];
const PANTS = [[40, 50, 82], [30, 30, 36], [92, 82, 70], [58, 70, 92], [150, 140, 118], [70, 76, 84]];
const SKIN = [[141, 85, 36], [198, 134, 66], [224, 172, 105], [160, 105, 60], [120, 74, 40], [176, 118, 72]];
const HAIR = [[22, 18, 16], [38, 28, 22], [58, 42, 30], [16, 14, 14]];

const looks = new Map();
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function lookOf(p) {
  const key = String(p.id ?? p.name ?? '?');
  let L = looks.get(key);
  if (L && L.role === p.role) return L;
  const r = mulberry32(hashStr(key));
  const pick = (a) => a[Math.floor(r() * a.length)];
  L = {
    role: p.role,
    shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKIN), hair: pick(HAIR),
    longHair: r() < 0.42, longTop: false, shortSleeve: r() < 0.6, cap: false, bag: r() < 0.35,
    bagC: pick([[30, 30, 36], [120, 40, 40], [40, 70, 120], [80, 80, 60]]),
    shoes: pick([[24, 24, 26], [230, 230, 228], [90, 60, 40]]),
    build: 0.92 + r() * 0.16, height: 0.95 + r() * 0.1,
  };
  if (L.longHair && r() < 0.5) { L.longTop = true; L.pants = pick([[236, 232, 220], [40, 50, 82], [150, 40, 60]]); }
  if (p.role === 'staff') { L.shirt = pick([[214, 228, 240], [236, 236, 232], [188, 206, 226], [120, 130, 150]]); L.pants = pick([[34, 36, 44], [60, 62, 70]]); L.bag = false; L.shortSleeve = false; }
  if (p.role === 'guard') { L.shirt = [52, 64, 96]; L.pants = [34, 40, 62]; L.cap = true; L.longHair = false; L.longTop = false; L.bag = false; L.shortSleeve = false; }
  if (p.role === 'cleaner') { L.shirt = [38, 142, 128]; L.pants = [34, 96, 90]; L.bag = false; L.longTop = false; }
  looks.set(key, L);
  return L;
}

// Projected extents of a person: used for figures and detection boxes.
export function personFrame(v, x, y, seated, z0 = 0) {
  const H = seated ? 1.3 : 1.72;
  const feet = project(v, x, y, z0);
  const head = project(v, x, y, z0 + H);
  if (!feet || !head) return null;
  if (feet[2] < 0.35) return null;
  const s = scaleAt(v, x, y, z0 + H * 0.6);
  return { feet, head, s, H, depth: feet[2] };
}

export function personBox(v, x, y, seated, z0 = 0) {
  const H = seated ? 1.32 : 1.76;
  const rx = v.r[0] * 0.27, ry = v.r[1] * 0.27, fx = v.fh[0] * 0.12, fy = v.fh[1] * 0.12;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const z of [z0, z0 + H]) {
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const p = project(v, x + rx * a + fx * b, y + ry * a + fy * b, z);
      if (!p) continue;
      n++;
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
  }
  if (n < 4) return null;
  return [x0, y0, x1, y1];
}

// tone(c, x, y, z, k) -> css colour shaded for the scene light.
export function drawPerson(ctx, v, p, anim, tone, z0 = 0) {
  const seated = !!p.seated;
  const F = personFrame(v, p.x, p.y, seated, z0);
  if (!F) return null;
  const L = lookOf(p);
  const { feet, head } = F;
  const Hpx = feet[1] - head[1];
  if (Hpx < 3) return null;
  const s = F.s * L.build;
  const Htot = F.H;
  const phase = anim?.phase || 0;
  const moving = !seated && anim?.moving;
  const bob = moving ? Math.abs(Math.sin(phase)) * Hpx * 0.015 : 0;
  // Map a height (m) + lateral offset (m) to screen coordinates.
  const Y = (z) => feet[1] - (Hpx * z) / Htot - bob;
  const X = (z, lat) => feet[0] + (head[0] - feet[0]) * (z / Htot) + lat * s;
  const T = (c, k = 1) => tone(c, p.x, p.y, 1, k);

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(feet[0], feet[1], 0.34 * s, Math.max(1, 0.12 * s), 0, 0, Math.PI * 2);
  ctx.fill();

  const sw = moving ? Math.sin(phase) : 0;
  const legW = 0.12 * s;
  const shoulderZ = seated ? 1.03 : 1.42, waistZ = seated ? 0.6 : 0.98, hipZ = seated ? 0.47 : 0.88;
  const headR = Math.max(1.2, Math.min(0.108 * s, Hpx * 0.085));
  const headCY = head[1] + headR - bob;
  const headCX = X(Htot - 0.1, 0);

  // Long hair behind the shoulders.
  if (L.longHair && !L.cap) {
    ctx.fillStyle = T(L.hair);
    ctx.beginPath();
    ctx.ellipse(headCX, headCY + headR * 0.9, headR * 1.05, headR * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Legs.
  ctx.lineCap = 'round';
  if (seated) {
    // Lap (thighs toward the desk) + shins.
    ctx.fillStyle = T(L.pants, 0.9);
    roundRect(ctx, X(hipZ, -0.2), Y(hipZ + 0.08), 0.4 * s, Math.max(2, Y(0.4) - Y(hipZ + 0.08)), 0.06 * s);
    ctx.fill();
    for (const side of [-1, 1]) {
      ctx.strokeStyle = T(L.pants, 0.78);
      ctx.lineWidth = legW;
      ctx.beginPath(); ctx.moveTo(X(0.42, side * 0.09), Y(0.42)); ctx.lineTo(X(0.08, side * 0.11), Y(0.08)); ctx.stroke();
      ctx.fillStyle = T(L.shoes, 0.9);
      ctx.beginPath(); ctx.ellipse(X(0.03, side * 0.11), Y(0.03), legW * 0.6, Math.max(1, legW * 0.35), 0, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    for (const side of [-1, 1]) {
      const swing = side * sw * 0.07;
      const lift = moving ? Math.max(0, side * sw) * 0.07 : 0;
      const hx = X(hipZ, side * 0.085), hy = Y(hipZ);
      const kx = X(0.48 + lift, side * 0.085 + swing * 0.5), ky = Y(0.48 + lift);
      const ax = X(0.07 + lift, side * 0.09 + swing), ay = Y(0.07 + lift);
      ctx.strokeStyle = T(L.pants, side < 0 ? 0.95 : 0.78);
      ctx.lineWidth = legW;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.fillStyle = T(L.shoes, 0.9);
      ctx.beginPath(); ctx.ellipse(ax, ay + legW * 0.25, legW * 0.62, Math.max(1, legW * 0.36), 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Torso (with a kurta-style longer top for some).
  const botZ = L.longTop && !seated ? 0.62 : waistZ - 0.06;
  const sh = 0.22, wa = L.longTop ? 0.21 : 0.17;
  const g = ctx.createLinearGradient(X(shoulderZ, -sh), 0, X(shoulderZ, sh), 0);
  g.addColorStop(0, T(L.shirt, 1.12));
  g.addColorStop(0.55, T(L.shirt, 0.95));
  g.addColorStop(1, T(L.shirt, 0.68));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(X(shoulderZ, -sh * 0.55), Y(shoulderZ + 0.03));
  ctx.quadraticCurveTo(X(shoulderZ, -sh), Y(shoulderZ + 0.02), X(shoulderZ - 0.08, -sh), Y(shoulderZ - 0.08));
  ctx.lineTo(X(botZ, -wa), Y(botZ));
  ctx.lineTo(X(botZ, wa), Y(botZ));
  ctx.lineTo(X(shoulderZ - 0.08, sh), Y(shoulderZ - 0.08));
  ctx.quadraticCurveTo(X(shoulderZ, sh), Y(shoulderZ + 0.02), X(shoulderZ, sh * 0.55), Y(shoulderZ + 0.03));
  ctx.closePath();
  ctx.fill();
  // Belt line / hem.
  ctx.strokeStyle = T(L.shirt, 0.55);
  ctx.lineWidth = Math.max(0.6, s * 0.012);
  ctx.beginPath(); ctx.moveTo(X(botZ, -wa), Y(botZ)); ctx.lineTo(X(botZ, wa), Y(botZ)); ctx.stroke();

  // Backpack strap or bag.
  if (L.bag && !seated) {
    ctx.fillStyle = T(L.bagC, 0.9);
    roundRect(ctx, X(shoulderZ - 0.1, sh * 0.55), Y(shoulderZ - 0.1), 0.1 * s, Math.max(2, Y(waistZ) - Y(shoulderZ - 0.1)), 0.03 * s);
    ctx.fill();
  }

  // Arms.
  const armW = 0.085 * s;
  for (const side of [-1, 1]) {
    const shx = X(shoulderZ - 0.05, side * (sh - 0.03)), shy = Y(shoulderZ - 0.05);
    let ex, ey, hx, hy;
    if (seated) {
      ex = X(shoulderZ - 0.3, side * 0.24); ey = Y(shoulderZ - 0.3);
      hx = X(shoulderZ - 0.38, side * 0.1); hy = Y(shoulderZ - 0.42);
    } else {
      const a = moving ? -side * sw * 0.06 : 0;
      ex = X(shoulderZ - 0.3, side * (sh + 0.02) + a * 0.5); ey = Y(shoulderZ - 0.3);
      hx = X(shoulderZ - 0.58, side * (sh + 0.01) + a); hy = Y(shoulderZ - 0.58);
    }
    ctx.lineWidth = armW;
    ctx.strokeStyle = T(L.shirt, side < 0 ? 1.0 : 0.72);
    ctx.beginPath(); ctx.moveTo(shx, shy); ctx.lineTo(ex, ey);
    if (!L.shortSleeve) ctx.lineTo(hx, hy);
    ctx.stroke();
    if (L.shortSleeve) {
      ctx.strokeStyle = T(L.skin, side < 0 ? 0.95 : 0.75);
      ctx.lineWidth = armW * 0.8;
      ctx.beginPath(); ctx.moveTo(X(shoulderZ - 0.2, side * (sh + 0.01)), Y(shoulderZ - 0.2)); ctx.lineTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
    }
    ctx.fillStyle = T(L.skin, 0.9);
    ctx.beginPath(); ctx.arc(hx, hy, armW * 0.5, 0, Math.PI * 2); ctx.fill();
  }

  // Neck + head.
  ctx.fillStyle = T(L.skin, 0.8);
  ctx.fillRect(headCX - headR * 0.35, headCY + headR * 0.6, headR * 0.7, Math.max(1, Y(shoulderZ) - headCY - headR * 0.5));
  const hg = ctx.createRadialGradient(headCX - headR * 0.35, headCY - headR * 0.3, headR * 0.15, headCX, headCY, headR);
  hg.addColorStop(0, T(L.skin, 1.12));
  hg.addColorStop(1, T(L.skin, 0.72));
  ctx.fillStyle = hg;
  ctx.beginPath(); ctx.arc(headCX, headCY, headR, 0, Math.PI * 2); ctx.fill();
  // Facing away from the camera: back of the head is all hair.
  const f = Number.isFinite(p.facing) ? p.facing : null;
  const away = f != null && (Math.cos(f) * (v.C[0] - p.x) + Math.sin(f) * (v.C[1] - p.y)) < 0;
  if (away && !L.cap) {
    ctx.fillStyle = T(L.hair);
    ctx.beginPath(); ctx.arc(headCX, headCY - headR * 0.04, headR * 1.03, 0, Math.PI * 2); ctx.fill();
    return { hx: headCX, hy: headCY, hr: headR, Hpx };
  }
  if (!away && headR > 3.5) {
    ctx.fillStyle = T([30, 22, 18]);
    const ey = headCY + headR * 0.08, ex = headR * 0.36, er = Math.max(0.6, headR * 0.1);
    ctx.beginPath(); ctx.arc(headCX - ex, ey, er, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(headCX + ex, ey, er, 0, Math.PI * 2); ctx.fill();
  }
  // Hair cap / guard cap.
  ctx.fillStyle = L.cap ? T([30, 38, 64]) : T(L.hair);
  ctx.beginPath();
  ctx.arc(headCX, headCY, headR * 1.03, Math.PI * 1.02, Math.PI * 1.98);
  ctx.quadraticCurveTo(headCX, headCY - headR * 0.15, headCX - headR * 1.03, headCY - headR * 0.05);
  ctx.fill();
  if (L.cap) { ctx.fillRect(headCX - headR * 1.2, headCY - headR * 0.25, headR * 2.4, Math.max(1, headR * 0.25)); }

  return { hx: headCX, hy: headCY, hr: headR, Hpx };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
