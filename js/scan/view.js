// Canvas views for HUKUM Scan: the fused plan (real-world frame) and the
// meter / NILM chart. Hand-written Canvas 2D, HiDPI aware.
import { applyT, centroid, bbox, pointInPoly } from './geom.js';
import { CAMERAS, FLOORS } from '../building.js';
import { BUILDING_H } from './samples.js';

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: r.width, H: r.height };
}

const STATUS_COL = { accepted: '82,196,26', conflict: '255,77,79', review: '250,173,20', human: '64,169,255' };

// ---------------------------------------------------------------- plan view
export function createPlanView(canvas, { onPick }) {
  const view = { zoom: 1, cx: 0, cy: 0, fitted: false };
  let scan = null, opts = {}, picked = null, shapes = [];

  const toScreen = (p, W, H, k) => [W / 2 + (p[0] - view.cx) * k, H / 2 - (p[1] - view.cy) * k];
  const toWorld = (s, W, H, k) => [(s[0] - W / 2) / k + view.cx, -(s[1] - H / 2) / k + view.cy];
  const scale = (W, H) => Math.min(W, H) / 110 * view.zoom;

  function draw() {
    const { ctx, W, H } = fitCanvas(canvas);
    ctx.fillStyle = '#06090d'; ctx.fillRect(0, 0, W, H);
    shapes = [];
    if (!scan) return;
    const k = scale(W, H);
    const S = (p) => toScreen(p, W, H, k);
    const poly = (pts, fill, stroke, dash = [], lw = 1.2) => {
      if (!pts?.length) return;
      ctx.beginPath();
      pts.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.setLineDash(dash); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); ctx.setLineDash([]); }
    };
    const text = (p, s, col = '#c9d6e3', size = 11, align = 'center') => {
      const q = S(p); ctx.fillStyle = col; ctx.font = `${size}px ${css('--mono') || 'monospace'}`; ctx.textAlign = align; ctx.fillText(s, q[0], q[1]);
    };

    // Grid (10 m)
    ctx.strokeStyle = '#0f151d'; ctx.lineWidth = 1;
    const a = toWorld([0, H], W, H, k), b = toWorld([W, 0], W, H, k);
    for (let x = Math.floor(a[0] / 10) * 10; x < b[0]; x += 10) { const s = S([x, 0]); ctx.beginPath(); ctx.moveTo(s[0], 0); ctx.lineTo(s[0], H); ctx.stroke(); }
    for (let y = Math.floor(a[1] / 10) * 10; y < b[1]; y += 10) { const s = S([0, y]); ctx.beginPath(); ctx.moveTo(0, s[1]); ctx.lineTo(W, s[1]); ctx.stroke(); }

    const R = scan.results;
    if (opts.context && R.osm) {
      if (R.osm.campus) poly(R.osm.campus.poly, 'rgba(105,177,255,.03)', '#1d3550', [6, 6]);
      for (const r of R.osm.roads) {
        ctx.beginPath(); r.line.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.strokeStyle = '#2a3442'; ctx.lineWidth = Math.max(2, 9 * k); ctx.stroke();
        text(centroid(r.line), r.name, '#56677c', 11);
      }
    }
    if (opts.footprint && R.footprint) poly(R.footprint.poly, 'rgba(245,179,1,.06)', 'rgba(245,179,1,.8)', [], 1.6);
    if (opts.roof && R.solar) {
      R.solar.segments.forEach((g) => { if (g.rect) { poly(g.rect, null, 'rgba(255,197,61,.55)', [4, 3]); text(centroid(g.rect), `roof ${g.index + 1}: ${g.pitch} deg, az ${g.azimuth}`, '#ffc53d', 10); } });
    }

    const T = scan.T.bToE;
    const before = opts.before;
    const B2E = (p) => (before || !T ? p : applyT(T, p));
    const P2E = (p) => (before ? p : B2E(scan.T.pToB ? applyT(scan.T.pToB, p) : p));
    const statusOf = (id) => scan.fused.resolved.find((r) => r.subject === id && r.predicate === 'exists')?.status || 'review';

    const floor = opts.floor;
    if (opts.blueprint && R.blueprint && (floor === R.blueprint.floor || before)) {
      if (R.blueprint.outline) poly(R.blueprint.outline.map(B2E), null, before ? '#888' : '#d8dee6', [], 1.4);
      for (const r of R.blueprint.rooms) {
        const st = statusOf(r.id);
        const pts = r.poly.map(B2E);
        const sel = picked === r.id;
        poly(pts, `rgba(${STATUS_COL[st] || '140,140,140'},${sel ? 0.32 : 0.13})`, sel ? '#fff' : `rgba(${STATUS_COL[st] || '140,140,140'},.75)`, [], sel ? 2 : 1);
        shapes.push({ id: r.id, pts });
        if (k > 3.2) text(centroid(pts), r.id, '#e6edf5', 10);
      }
    }
    if (opts.plan && R.plan && floor === R.plan.floor && !before) {
      poly([[0, 0], [52, 0], [52, 32], [44, 32], [44, 29], [0, 29]].map(B2E), null, '#5b6676', [3, 3]);
      for (const r of R.plan.rooms) {
        const st = statusOf(r.id);
        const pts = r.poly.map(B2E);
        poly(pts, `rgba(${STATUS_COL[st]},${picked === r.id ? 0.32 : 0.13})`, `rgba(${STATUS_COL[st]},.75)`);
        shapes.push({ id: r.id, pts });
        if (k > 3.2) text(centroid(pts), r.fixed ? `${r.id} (OCR "${r.raw}")` : r.id, '#e6edf5', 10);
      }
    }
    if (opts.scan && R.scan && (floor === R.scan.floor || before)) {
      for (const r of R.scan.rooms) {
        const pts = r.poly.map(P2E);
        poly(pts, null, '#36cfc9', [5, 3], 1.6);
        if (before && k > 3) text(centroid(pts), r.name, '#36cfc9', 10);
        if (!before && opts.objects) {
          for (const o of r.objects) {
            const s = S(P2E(o.p));
            ctx.fillStyle = o.cat === 'chair' ? 'rgba(54,207,201,.5)' : o.cat === 'table' ? 'rgba(54,207,201,.25)' : 'rgba(255,255,255,.4)';
            const z = o.cat === 'table' ? Math.max(2, k * 0.5) : Math.max(1.5, k * 0.2);
            ctx.fillRect(s[0] - z / 2, s[1] - z / 2, z, z);
          }
        }
      }
    }
    if (opts.cameras && !before && T && R.cctv) {
      for (const c of R.cctv) {
        const cam = c.cam;
        const p = B2E([cam.x, BUILDING_H - cam.y]);
        const ang = -cam.facing + T.th;
        const s = S(p);
        const len = 5 * k, half = (cam.fov || Math.PI / 2) / 2;
        ctx.beginPath(); ctx.moveTo(s[0], s[1]);
        ctx.arc(s[0], s[1], len, -(ang + half), -(ang - half));
        ctx.closePath();
        const bad = (c.accuracy ?? 1) < 0.8;
        ctx.fillStyle = bad ? 'rgba(255,77,79,.18)' : 'rgba(105,177,255,.16)'; ctx.fill();
        ctx.fillStyle = bad ? '#ff4d4f' : '#69b1ff'; ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, Math.PI * 2); ctx.fill();
        if (opts.detections && c.detections) {
          for (const d of c.detections) {
            const q = S(B2E([d.plan[0], BUILDING_H - d.plan[1]]));
            ctx.fillStyle = d.roomId === d.truth ? '#95de64' : '#ff4d4f';
            ctx.beginPath(); ctx.arc(q[0], q[1], 1.8, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
    if (floor === 'MB-2' && R.ifc && !before) {
      poly([[0, 0], [52, 0], [52, 32], [44, 32], [44, 29], [0, 29]].map(B2E), null, '#5b6676', [3, 3]);
      ctx.fillStyle = '#8a9bb0'; ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`IFC: ${R.ifc.spaces.length} spaces on ${R.ifc.storeys[0]?.name || 'this storey'} (names and areas; IFC geometry is not read in this MVP).`, 14, H - 16);
    }
    // North arrow + scale bar
    ctx.save();
    ctx.translate(W - 30, 34);
    ctx.fillStyle = '#c9d6e3'; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(6, 6); ctx.lineTo(0, 2); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
    ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', 0, 20);
    ctx.restore();
    const bar = 10 * k;
    ctx.fillStyle = '#c9d6e3'; ctx.fillRect(14, H - 34, bar, 3);
    ctx.font = '11px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.fillText('10 m', 14, H - 40);
    if (before) { ctx.fillStyle = '#faad14'; ctx.font = '12px Inter, sans-serif'; ctx.fillText('Before alignment: drawing in its own CAD frame, scan in the phone frame', 14, 22); }
  }

  function fit() {
    const R = scan?.results;
    const pts = R?.footprint?.poly || R?.blueprint?.outline;
    if (!pts) return;
    const bb = bbox(pts);
    view.cx = (bb.x0 + bb.x1) / 2; view.cy = (bb.y0 + bb.y1) / 2;
    view.zoom = 110 / Math.max(bb.w, bb.h) * 0.85;
    view.fitted = true;
  }

  // Interaction: drag to pan, wheel to zoom, click to inspect.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const k = scale(r.width, r.height);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.cx = drag.cx - dx / k; view.cy = drag.cy + dy / k;
    draw();
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (d && !d.moved) {
      const r = canvas.getBoundingClientRect();
      const k = scale(r.width, r.height);
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const hit = shapes.find((s) => pointInPoly([sx, sy], s.pts.map((p) => toScreen(p, r.width, r.height, k))));
      picked = hit?.id || null;
      onPick?.(picked);
      draw();
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const before = toWorld([e.clientX - r.left, e.clientY - r.top], r.width, r.height, scale(r.width, r.height));
    view.zoom = Math.max(0.3, Math.min(30, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const after = toWorld([e.clientX - r.left, e.clientY - r.top], r.width, r.height, scale(r.width, r.height));
    view.cx += before[0] - after[0]; view.cy += before[1] - after[1];
    draw();
  }, { passive: false });

  return {
    set(s, o) { scan = s; opts = o; if (!view.fitted) fit(); draw(); },
    refit() { view.fitted = false; fit(); draw(); },
    draw,
    pick(id) { picked = id; draw(); },
  };
}

// ---------------------------------------------------------------- meter chart
const CLUSTER_COLS = ['#ff7a45', '#36cfc9', '#b37feb', '#ffc53d', '#69b1ff', '#95de64', '#ff85c0'];
export function drawMeter(canvas, nilm) {
  const { ctx, W, H } = fitCanvas(canvas);
  ctx.fillStyle = '#06090d'; ctx.fillRect(0, 0, W, H);
  if (!nilm) return;
  const pad = { l: 46, r: 14, t: 14, b: 26 };
  const n = nilm.series.length;
  const max = Math.max(...nilm.series.map((s) => s.kW)) * 1.08;
  const X = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  ctx.strokeStyle = '#1a2330'; ctx.fillStyle = '#8a9bb0'; ctx.font = '10px JetBrains Mono, monospace'; ctx.lineWidth = 1;
  for (let v = 0; v <= max; v += 10) { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(`${v}`, pad.l - 6, Y(v) + 3); }
  for (let hr = 0; hr <= 24; hr += 3) { const i = Math.min(n - 1, (hr * 60 * (n - 1)) / 1439); ctx.textAlign = 'center'; ctx.fillText(`${String(hr).padStart(2, '0')}:00`, X(i), H - 8); }
  ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('kW', 0, 0); ctx.restore();
  // NILM runs as bands
  nilm.appliances.forEach((a, k) => {
    const col = a.roomCircuits ? '#5b6676' : CLUSTER_COLS[k % CLUSTER_COLS.length];
    a.color = col;
    for (let r = 0; r < a.startMinutes.length; r++) {
      const s = a.startMinutes[r];
      const e = s + a.meanMinutes;
      ctx.fillStyle = col + '33'; ctx.fillRect(X(s), pad.t, Math.max(2, X(e) - X(s)), H - pad.t - pad.b);
      ctx.fillStyle = col; ctx.fillRect(X(s), pad.t, Math.max(2, X(e) - X(s)), 3);
    }
  });
  ctx.beginPath(); nilm.series.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.kW)) : ctx.moveTo(X(i), Y(s.kW))));
  ctx.strokeStyle = 'rgba(105,177,255,.45)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); nilm.filtered.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = '#69b1ff'; ctx.lineWidth = 1.5; ctx.stroke();
}

// Small plan of one block floor (tile frame) for the camera tab.
export function drawFloorInset(canvas, floorShort, cal) {
  const { ctx, W, H } = fitCanvas(canvas);
  ctx.fillStyle = '#111821'; ctx.fillRect(0, 0, W, H);
  const f = FLOORS.find((x) => x.short === floorShort);
  if (!f) return;
  const k = Math.min(W / 54, H / 31), ox = (W - 52 * k) / 2, oy = (H - 29 * k) / 2;
  const S = (x, y) => [ox + x * k, oy + y * k];
  for (const r of f.rooms) {
    const [x, y] = S(r.x, r.y);
    const on = cal && r.id === cal.cam.roomId;
    ctx.fillStyle = on ? 'rgba(105,177,255,.18)' : 'rgba(255,255,255,.04)'; ctx.fillRect(x, y, r.w * k, r.h * k);
    ctx.strokeStyle = on ? '#69b1ff' : '#2a3442'; ctx.strokeRect(x, y, r.w * k, r.h * k);
  }
  for (const c of CAMERAS.filter((c) => c.floor === f.level && c.kind === 'room')) {
    const [x, y] = S(c.x, c.y);
    ctx.fillStyle = cal && c.id === cal.cam.id ? '#f5b301' : '#56677c'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  if (!cal?.ok) return;
  cal.points.forEach((p, i) => {
    const [x, y] = S(...p.plan);
    ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f5b301'; ctx.font = '9px JetBrains Mono, monospace'; ctx.fillText(String(i + 1), x + 5, y - 4);
  });
  for (const d of cal.detections) {
    const [x, y] = S(...d.plan);
    ctx.fillStyle = d.roomId === d.truth ? '#95de64' : '#ff4d4f'; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
}

export { CLUSTER_COLS };
