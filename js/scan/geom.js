// Geometry for HUKUM Scan: local projection, polygons, 2D similarity ICP
// (blueprint -> footprint, scan -> blueprint) and plane homographies
// (camera image -> floor plan). Pure functions, no DOM.

// ---------------------------------------------------------------- lat/lon <-> local metres
// Equirectangular projection around an origin. Good to a few cm over a campus.
export function makeProjection(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return {
    lat0, lon0,
    toLocal: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

// ---------------------------------------------------------------- polygons
export function polyArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return Math.abs(a / 2);
}

export function centroid(p) {
  let cx = 0, cy = 0;
  for (const q of p) { cx += q[0]; cy += q[1]; }
  return [cx / p.length, cy / p.length];
}

export function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function pointInPoly(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Intersection-over-union of two polygons by sampling a grid (fine for room-sized shapes).
export function polyIoU(a, b, step = 0.25) {
  const bb = bbox([...a, ...b]);
  let inter = 0, uni = 0;
  for (let y = bb.y0 + step / 2; y < bb.y1; y += step) {
    for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
      const ia = pointInPoly([x, y], a), ib = pointInPoly([x, y], b);
      if (ia && ib) inter++;
      if (ia || ib) uni++;
    }
  }
  return uni ? inter / uni : 0;
}

// Fraction of polygon a that lies inside polygon b.
export function polyCover(a, b, step = 0.25) {
  const bb = bbox(a);
  let ina = 0, both = 0;
  for (let y = bb.y0 + step / 2; y < bb.y1; y += step) {
    for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
      if (!pointInPoly([x, y], a)) continue;
      ina++;
      if (pointInPoly([x, y], b)) both++;
    }
  }
  return ina ? both / ina : 0;
}

// Points every `step` along the closed outline.
export function resample(poly, step) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

// ---------------------------------------------------------------- similarity transforms
// T = { s, th, tx, ty }: p' = s * R(th) * p + t
export const IDENTITY = { s: 1, th: 0, tx: 0, ty: 0 };
export function applyT(T, p) {
  const c = Math.cos(T.th), s = Math.sin(T.th);
  return [T.s * (c * p[0] - s * p[1]) + T.tx, T.s * (s * p[0] + c * p[1]) + T.ty];
}
export function composeT(A, B) {          // A after B
  const t = applyT(A, [B.tx, B.ty]);
  return { s: A.s * B.s, th: A.th + B.th, tx: t[0], ty: t[1] };
}

// Least-squares similarity (Umeyama) mapping src[i] -> dst[i].
export function fitSimilarity(src, dst, allowScale = true) {
  const n = src.length;
  const ms = centroid(src), md = centroid(dst);
  let sxx = 0, sxy = 0, var_s = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i][0] - ms[0], ay = src[i][1] - ms[1];
    const bx = dst[i][0] - md[0], by = dst[i][1] - md[1];
    sxx += ax * bx + ay * by;       // cos part
    sxy += ax * by - ay * bx;       // sin part
    var_s += ax * ax + ay * ay;
  }
  const th = Math.atan2(sxy, sxx);
  const s = allowScale && var_s > 0 ? Math.hypot(sxx, sxy) / var_s : 1;
  const c = Math.cos(th), sn = Math.sin(th);
  return { s, th, tx: md[0] - s * (c * ms[0] - sn * ms[1]), ty: md[1] - s * (sn * ms[0] + c * ms[1]) };
}

function nearest(p, pts) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - p[0], dy = pts[i][1] - p[1];
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  return [bi, best];
}

function principalAngle(pts) {
  const [mx, my] = centroid(pts);
  let a = 0, b = 0, c = 0;
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; a += dx * dx; b += dx * dy; c += dy * dy; }
  return 0.5 * Math.atan2(2 * b, a - c);
}

// Iterative closest point with a similarity model. Tries four starting
// rotations around the principal axis (outlines are often near-symmetric)
// and keeps the one with the lowest RMS. Returns { T, rms, iterations }.
export function icp(srcPoly, dstPoly, { allowScale = true, iters = 40, initScale = null } = {}) {
  const dstBox = bbox(dstPoly);
  const step = Math.max(dstBox.w, dstBox.h) / 120;
  const dst = resample(dstPoly, step);
  const srcArea = polyArea(srcPoly), dstArea = polyArea(dstPoly);
  const s0 = initScale ?? (allowScale && srcArea > 0 ? Math.sqrt(dstArea / srcArea) : 1);
  const src = resample(srcPoly, step / s0);
  const cs = centroid(srcPoly), cd = centroid(dstPoly);
  const base = principalAngle(dst) - principalAngle(src);

  let best = null;
  for (let k = 0; k < 4; k++) {
    const th0 = base + (k * Math.PI) / 2;
    const c = Math.cos(th0), s = Math.sin(th0);
    let T = { s: s0, th: th0, tx: cd[0] - s0 * (c * cs[0] - s * cs[1]), ty: cd[1] - s0 * (s * cs[0] + c * cs[1]) };
    let rms = Infinity, it = 0;
    for (; it < iters; it++) {
      const moved = src.map((p) => applyT(T, p));
      const pairsS = [], pairsD = [];
      let err = 0;
      // Symmetric matching: src->dst and dst->src, so partial overlaps don't collapse.
      for (let i = 0; i < moved.length; i++) { const [j, d] = nearest(moved[i], dst); pairsS.push(src[i]); pairsD.push(dst[j]); err += d; }
      for (let j = 0; j < dst.length; j += 2) {
        const [i] = nearest(dst[j], moved);
        pairsS.push(src[i]); pairsD.push(dst[j]);
      }
      const newRms = Math.sqrt(err / moved.length);
      const delta = Math.abs(rms - newRms);
      rms = newRms;
      T = fitSimilarity(pairsS, pairsD, allowScale);
      if (delta < 1e-6) break;
    }
    const moved = src.map((p) => applyT(T, p));
    let err = 0;
    for (const p of moved) err += nearest(p, dst)[1];
    for (const q of dst) err += nearest(q, moved)[1];
    rms = Math.sqrt(err / (moved.length + dst.length));
    if (!best || rms < best.rms) best = { T, rms, iterations: it, startDeg: Math.round((th0 * 180) / Math.PI) };
  }
  return best;
}

// ICP refinement from a known starting transform (point sets, no resampling).
export function refineICP(src, dst, T0, { allowScale = false, iters = 30, maxDist = 3 } = {}) {
  let T = T0, rms = Infinity;
  for (let it = 0; it < iters; it++) {
    const S = [], D = [];
    let err = 0, n = 0;
    for (const p of src) {
      const q = applyT(T, p);
      const [j, d] = nearest(q, dst);
      if (d > maxDist * maxDist) continue;
      S.push(p); D.push(dst[j]); err += d; n++;
    }
    if (n < 3) break;
    const newRms = Math.sqrt(err / n);
    T = fitSimilarity(S, D, allowScale);
    if (Math.abs(rms - newRms) < 1e-7) { rms = newRms; break; }
    rms = newRms;
  }
  return { T, rms };
}

export function invertT(T) {
  const c = Math.cos(-T.th), s = Math.sin(-T.th);
  const tx = -(c * T.tx - s * T.ty) / T.s, ty = -(s * T.tx + c * T.ty) / T.s;
  return { s: 1 / T.s, th: -T.th, tx, ty };
}

// ---------------------------------------------------------------- homography
// Direct linear transform from 4+ correspondences (image px -> plan metres).
// Solves the 8 unknowns (h33 = 1) by least squares with Gaussian elimination.
export function fitHomography(src, dst) {
  const rows = [], rhs = [];
  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
  }
  // Normal equations A^T A h = A^T b
  const N = 8, M = Array.from({ length: N }, () => new Array(N + 1).fill(0));
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) M[i][j] += rows[r][i] * rows[r][j];
      M[i][N] += rows[r][i] * rhs[r];
    }
  }
  const h = solve(M);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(M) {
  const n = M.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, p) {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

// ---------------------------------------------------------------- misc
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rand) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
