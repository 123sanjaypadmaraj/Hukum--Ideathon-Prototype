// Hand-written Canvas 2D charts: 24 h energy chart, merit order, sparkline, ring gauge.
import { CONFIG, fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { fitCanvas, tokens, alpha, safe, isNum } from './util.js';

function niceStep(range, ticks = 4) {
  const raw = range / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function arr(a) { return Array.isArray(a) ? a : []; }

// Returns { plot, hover } where hover holds values under the cursor (or null).
export function drawEnergyChart(canvas, state, hoverX) {
  const fit = fitCanvas(canvas);
  if (!fit) return null;
  const { ctx, w, h } = fit;
  const C = tokens();
  const E = state.energy || {};
  const hist = arr(E.history);
  const fc = E.forecast || {};
  const fs = fc.solar || {}, fd = fc.demand || {};
  const now = minuteOfDay(safe(state.t));

  const L = 38, R = 8, T = 18, B = 20;
  const pw = w - L - R, ph = h - T - B;
  const X = (m) => L + (m / 1440) * pw;

  // ----- scale -----
  let max = 50, min = 0;
  const step = Math.max(1, Math.floor(hist.length / 480));
  for (let i = 0; i < hist.length; i += step) {
    const r = hist[i] || {};
    max = Math.max(max, safe(r.solarKW), safe(r.demandKW), safe(r.gridKW), safe(r.baselineGridKW));
    min = Math.min(min, safe(r.batteryKW), safe(r.gridKW));
  }
  for (const v of arr(fs.p90)) max = Math.max(max, safe(v));
  for (const v of arr(fd.p90)) max = Math.max(max, safe(v));
  const s = niceStep((max - min) * 1.08);
  const yMax = Math.ceil((max * 1.06) / s) * s;
  const yMin = min < 0 ? Math.floor((min * 1.1) / s) * s : 0;
  const Y = (v) => T + ph - ((v - yMin) / (yMax - yMin)) * ph;

  ctx.clearRect(0, 0, w, h);
  ctx.font = `10px ${C.mono}`;
  ctx.textBaseline = 'middle';

  // ----- tariff bands -----
  const t = CONFIG.tariff;
  const band = (h0, h1, col, label) => {
    ctx.fillStyle = alpha(col, 0.07);
    ctx.fillRect(X(h0 * 60), T, X(h1 * 60) - X(h0 * 60), ph);
    ctx.fillStyle = alpha(col, 0.85);
    ctx.textAlign = 'left';
    ctx.fillText(label, X(h0 * 60) + 4, T - 8);
  };
  band(t.solarHours[0], t.solarHours[1], C.solar, `SOLAR Rs ${t.solar}`);
  band(t.peakHours[0], t.peakHours[1], C.danger, `PEAK Rs ${t.peak}`);

  // ----- grid lines + y labels -----
  ctx.strokeStyle = alpha(C.line, 1);
  ctx.lineWidth = 1;
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  for (let v = yMin; v <= yMax + 1e-6; v += s) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.globalAlpha = v === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(Math.round(v)), L - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let hr = 0; hr <= 24; hr += 3) ctx.fillText(String(hr).padStart(2, '0'), X(hr * 60), T + ph + 6);
  ctx.save();
  ctx.translate(9, T + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText('kW', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();

  // ----- forecast -----
  const p10 = arr(fs.p10), p50 = arr(fs.p50), p90 = arr(fs.p90);
  const sx = (i) => X(i * CONFIG.slotMinutes + CONFIG.slotMinutes / 2);
  if (p10.length && p90.length) {
    ctx.beginPath();
    p90.forEach((v, i) => (i ? ctx.lineTo(sx(i), Y(safe(v))) : ctx.moveTo(sx(i), Y(safe(v)))));
    for (let i = p10.length - 1; i >= 0; i--) ctx.lineTo(sx(i), Y(safe(p10[i])));
    ctx.closePath();
    ctx.fillStyle = alpha(C.solar, 0.13);
    ctx.fill();
  }
  const dashed = (vals, col, width = 1.25, dash = [4, 3]) => {
    if (!vals.length) return;
    ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = width;
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(sx(i), Y(safe(v))) : ctx.moveTo(sx(i), Y(safe(v)))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  dashed(arr(fd.p50), alpha(C.demand, 0.45), 1, [2, 3]);
  dashed(p50, alpha(C.solar, 0.9));

  // ----- battery bars (15 min buckets) -----
  if (hist.length) {
    const buckets = new Map();
    for (const r of hist) {
      if (!r) continue;
      const b = Math.floor(minuteOfDay(safe(r.t)) / 15);
      const cur = buckets.get(b) || [0, 0];
      cur[0] += safe(r.batteryKW); cur[1] += 1;
      buckets.set(b, cur);
    }
    const bw = Math.max(1, X(15) - X(0) - 1);
    for (const [b, [sum, n]] of buckets) {
      const v = sum / n;
      if (Math.abs(v) < 0.5) continue;
      const y0 = Y(0), y1 = Y(v);
      ctx.fillStyle = alpha(C.battery, v > 0 ? 0.35 : 0.75);
      ctx.fillRect(X(b * 15) + 0.5, Math.min(y0, y1), bw, Math.abs(y1 - y0));
    }
  }

  // ----- actual lines -----
  const line = (key, col, width, dash) => {
    if (!hist.length) return;
    ctx.strokeStyle = col; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < hist.length; i += step) {
      const r = hist[i];
      if (!r || !isNum(r[key])) continue;
      const x = X(minuteOfDay(safe(r.t))), y = Y(r[key]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    const last = hist[hist.length - 1];
    if (started && last && isNum(last[key])) ctx.lineTo(X(minuteOfDay(safe(last.t))), Y(last[key]));
    ctx.stroke(); ctx.setLineDash([]);
  };
  line('baselineGridKW', alpha(C.baseline, 0.95), 1.25, [5, 4]);
  line('demandKW', C.demand, 1.5);
  line('gridKW', C.grid, 2);
  line('solarKW', C.solar, 2);

  // ----- now line -----
  const nx = Math.round(X(now)) + 0.5;
  ctx.strokeStyle = alpha(C.accent, 0.9); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(nx, T); ctx.lineTo(nx, T + ph); ctx.stroke();
  ctx.restore();

  ctx.fillStyle = C.accent;
  ctx.font = `600 10px ${C.mono}`;
  ctx.textAlign = nx > w - 50 ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`NOW ${fmtTime(now)}`, nx + (nx > w - 50 ? -4 : 4), T + 7);

  // ----- hover -----
  let hover = null;
  if (isNum(hoverX) && hoverX >= L && hoverX <= w - R) {
    const m = Math.round(((hoverX - L) / pw) * 1440);
    let row = null, best = 1e9;
    for (let i = 0; i < hist.length; i++) {
      const r = hist[i]; if (!r) continue;
      const d = Math.abs(minuteOfDay(safe(r.t)) - m);
      if (d < best) { best = d; row = r; }
    }
    const si = Math.min(95, Math.floor(m / 15));
    hover = {
      x: hoverX, m,
      row: best <= 8 ? row : null,
      fc: { p10: p10[si], p50: p50[si], p90: p90[si], d50: arr(fd.p50)[si] },
    };
    ctx.strokeStyle = alpha(C.text, 0.35);
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(Math.round(hoverX) + 0.5, T); ctx.lineTo(Math.round(hoverX) + 0.5, T + ph); ctx.stroke();
    ctx.setLineDash([]);
    if (hover.row) {
      for (const [k, col] of [['solarKW', C.solar], ['gridKW', C.grid], ['demandKW', C.demand]]) {
        if (!isNum(hover.row[k])) continue;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(X(minuteOfDay(safe(hover.row.t))), Y(hover.row[k]), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  return { hover, plot: { L, R, T, B, w, h } };
}

export function relevantBids(market) {
  const bids = arr(market && market.bids).filter((b) => b && isNum(b.kW) && isNum(b.priceRs));
  const need = safe(market && market.needKW);
  const dir = need > 0 ? 'reduce' : need < 0 ? 'absorb' : null;
  let list = dir ? bids.filter((b) => b.direction === dir) : bids;
  if (!list.length) list = bids;
  return list.slice().sort((a, b) => a.priceRs - b.priceRs);
}

export function drawMeritOrder(canvas, market) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, w, h } = fit;
  const C = tokens();
  ctx.clearRect(0, 0, w, h);
  const bids = relevantBids(market);
  const need = Math.abs(safe(market && market.needKW));
  const L = 36, R = 10, T = 14, B = 22;
  const pw = w - L - R, ph = h - T - B;
  ctx.font = `10px ${C.mono}`;
  if (!bids.length) {
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No bids yet. The market clears every 15 minutes.', w / 2, h / 2);
    return;
  }
  const total = bids.reduce((s, b) => s + Math.abs(b.kW), 0);
  const xMax = Math.max(total, need) * 1.05 || 1;
  const pMax = Math.max(...bids.map((b) => b.priceRs), safe(market.clearingPrice), 1);
  const ps = niceStep(pMax * 1.1, 4);
  const yMax = Math.ceil((pMax * 1.1) / ps) * ps;
  const X = (k) => L + (k / xMax) * pw;
  const Y = (p) => T + ph - (p / yMax) * ph;

  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.fillStyle = C.muted;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let p = 0; p <= yMax + 1e-6; p += ps) {
    const y = Math.round(Y(p)) + 0.5;
    ctx.globalAlpha = p === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(p.toFixed(ps < 1 ? 1 : 0), L - 5, y);
  }
  const ks = niceStep(xMax, 4);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let k = 0; k <= xMax; k += ks) ctx.fillText(String(Math.round(k)), X(k), T + ph + 5);

  let cum = 0;
  for (const b of bids) {
    const k = Math.abs(b.kW);
    const x0 = X(cum), x1 = X(cum + k);
    const y = Y(b.priceRs);
    ctx.fillStyle = b.accepted ? alpha(C.accent, 0.8) : alpha(C.muted, 0.22);
    const part = b.accepted && isNum(b.acceptedKW) && b.acceptedKW > 0 && b.acceptedKW < k ? X(cum + b.acceptedKW) : x1;
    ctx.fillRect(x0 + 0.5, y, Math.max(1, part - x0 - 1), T + ph - y);
    if (part < x1) { ctx.fillStyle = alpha(C.muted, 0.22); ctx.fillRect(part, y, Math.max(1, x1 - part - 1), T + ph - y); }
    ctx.strokeStyle = b.accepted ? C.accent : alpha(C.muted, 0.6);
    ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke();
    if (x1 - x0 > 30) {
      ctx.save();
      ctx.fillStyle = b.accepted ? '#1a1300' : C.text;
      ctx.font = `600 9px ${C.mono}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const label = String(b.equipId || b.name || '').slice(0, Math.floor((x1 - x0) / 6));
      if (T + ph - y > 14) ctx.fillText(label, (x0 + x1) / 2, y + 3);
      ctx.restore();
    }
    cum += k;
  }
  if (need > 0) {
    const nx = Math.round(X(need)) + 0.5;
    ctx.strokeStyle = C.text; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(nx, T - 4); ctx.lineTo(nx, T + ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.text; ctx.textBaseline = 'middle';
    ctx.textAlign = nx > w - 90 ? 'right' : 'left';
    ctx.fillText(`need ${Math.round(need)} kW`, nx + (nx > w - 90 ? -4 : 4), T + 2);
  }
  if (isNum(market.clearingPrice) && market.clearingPrice > 0) {
    const y = Math.round(Y(market.clearingPrice)) + 0.5;
    ctx.strokeStyle = alpha(C.accent2, 0.8); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.setLineDash([]);
  }
}

export function drawSparkline(canvas, values, color, opts = {}) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, w, h } = fit;
  ctx.clearRect(0, 0, w, h);
  const v = arr(values).filter(isNum);
  const C = tokens();
  if (v.length < 2) {
    ctx.fillStyle = C.muted; ctx.font = `10px ${C.mono}`; ctx.textBaseline = 'middle';
    ctx.fillText(opts.empty || 'collecting data', 2, h / 2);
    return;
  }
  const mn = Math.min(...v, opts.min ?? Infinity), mx = Math.max(...v, opts.max ?? -Infinity);
  const span = mx - mn || 1;
  const X = (i) => 1 + (i / (v.length - 1)) * (w - 2);
  const Y = (x) => h - 2 - ((x - mn) / span) * (h - 4);
  ctx.beginPath();
  v.forEach((x, i) => (i ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(X(v.length - 1), h); ctx.lineTo(X(0), h); ctx.closePath();
  ctx.fillStyle = alpha(color, 0.12); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(X(v.length - 1), Y(v[v.length - 1]), 2.2, 0, Math.PI * 2); ctx.fill();
}

export function drawRing(canvas, frac, color, big, small) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, w, h } = fit;
  const C = tokens();
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(w, h) / 2 - 6, cx = w / 2, cy = h / 2;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = C.line;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  const f = Math.max(0, Math.min(1, safe(frac)));
  if (f > 0.001) {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * f); ctx.stroke();
  }
  ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(r * 0.5)}px ${C.font}`;
  ctx.fillText(big, cx, cy - 2);
  if (small) {
    ctx.fillStyle = C.muted; ctx.font = `10px ${C.mono}`;
    ctx.fillText(small, cx, cy + r * 0.45);
  }
}
