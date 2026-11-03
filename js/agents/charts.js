// Small charts for the agent tabs: a canvas 96-slot schedule chart and a
// simple SVG bar chart. Both tolerate missing or partial data.
import { h, s, num, arr, slotTime, fmtNum } from './util.js';

const css = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fallback;

// schedule: [{slot,t,solar_kw,demand_kw,battery_kw,grid_kw,soc}]
export function scheduleChart(schedule, { height = 260 } = {}) {
  const rows = arr(schedule).filter((r) => r && typeof r === 'object');
  const wrap = h('div', { class: 'ag-chart' });
  if (!rows.length) { wrap.append(h('div', { class: 'ag-empty sm' }, 'No schedule yet.')); return wrap; }
  const legend = h('div', { class: 'ag-legend' },
    ...[['Solar', '--solar', '#ffc53d'], ['Demand', '--demand', '#ff7a45'], ['Grid import / export', '--grid', '#69b1ff'], ['Battery power', '--battery', '#95de64'], ['Battery SOC (right axis)', '--accent', '#f5b301']]
      .map(([t, v, f]) => h('span', {}, h('i', { style: { background: css(v, f) } }), t)));
  const canvas = h('canvas', { style: { height: `${height}px` }, 'aria-label': 'Optimised 24 hour schedule' });
  const tip = h('div', { class: 'ag-tip', hidden: true });
  const box = h('div', { class: 'ag-chart-box' }, canvas, tip);
  wrap.append(legend, box);

  const solar = rows.map((r) => num(r.solar_kw, 0));
  const demand = rows.map((r) => num(r.demand_kw, 0));
  const grid = rows.map((r) => num(r.grid_kw, 0));
  const batt = rows.map((r) => num(r.battery_kw, 0));
  let soc = rows.map((r) => num(r.soc, null));
  const socMax = Math.max(0, ...soc.filter((v) => v != null));
  if (socMax > 0 && socMax <= 1.0001) soc = soc.map((v) => (v == null ? null : v * 100));
  const hi = Math.max(1, ...solar, ...demand, ...grid, ...batt);
  const lo = Math.min(0, ...grid, ...batt);
  const n = rows.length;
  const pad = { l: 44, r: 40, t: 20, b: 22 };
  let geom = null;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);
    const pw = w - pad.l - pad.r, ph = hgt - pad.t - pad.b;
    const x = (i) => pad.l + (pw * (i + 0.5)) / n;
    const y = (v) => pad.t + ph * (1 - (v - lo) / (hi - lo || 1));
    const ys = (v) => pad.t + ph * (1 - v / 100);
    geom = { x, pw, pad };
    c.font = '10px "JetBrains Mono", monospace';
    // grid lines
    c.strokeStyle = '#1e2836'; c.fillStyle = '#8a9bb0'; c.lineWidth = 1;
    const step = niceStep((hi - lo) / 6);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      c.beginPath(); c.moveTo(pad.l, y(v) + .5); c.lineTo(w - pad.r, y(v) + .5); c.stroke();
      c.textAlign = 'right'; c.fillText(fmtNum(Math.abs(v) < 1e-9 ? 0 : v, 0), pad.l - 6, y(v) + 3);
    }
    c.textAlign = 'left'; c.fillText('kW', 4, 10);
    c.textAlign = 'right'; c.fillText('SOC %', w - 2, 10);
    for (const p of [0, 50, 100]) { c.textAlign = 'left'; c.fillText(String(p), w - pad.r + 6, ys(p) + 3); }
    c.textAlign = 'center';
    for (let i = 0; i < n; i += Math.max(1, Math.round(n / 8))) {
      const r = rows[i];
      c.fillText(typeof r.t === 'string' && r.t.length <= 5 ? r.t : (typeof r.t === 'string' && /T?\d\d:\d\d/.test(r.t) ? r.t.match(/(\d\d:\d\d)/)[1] : slotTime(r.slot != null ? r.slot : i)), x(i), hgt - 6);
    }
    // zero line
    c.strokeStyle = '#3a4a60'; c.beginPath(); c.moveTo(pad.l, y(0) + .5); c.lineTo(w - pad.r, y(0) + .5); c.stroke();
    // solar area
    area(c, solar, x, y, css('--solar', '#ffc53d'), 0.22);
    // battery bars
    const bw = Math.max(1, pw / n - 1);
    c.fillStyle = css('--battery', '#95de64'); c.globalAlpha = 0.65;
    batt.forEach((v, i) => { if (v) c.fillRect(x(i) - bw / 2, Math.min(y(0), y(v)), bw, Math.abs(y(v) - y(0))); });
    c.globalAlpha = 1;
    line(c, grid, x, y, css('--grid', '#69b1ff'), 1.6);
    line(c, demand, x, y, css('--demand', '#ff7a45'), 2);
    line(c, solar, x, y, css('--solar', '#ffc53d'), 1.6);
    // SOC
    c.setLineDash([4, 3]);
    line(c, soc, x, (v) => ys(Math.max(0, Math.min(100, v))), css('--accent', '#f5b301'), 1.4);
    c.setLineDash([]);
  }

  canvas.addEventListener('mousemove', (e) => {
    if (!geom) return;
    const r = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left - geom.pad.l) / geom.pw) * n)));
    const row = rows[i];
    tip.hidden = false;
    tip.textContent = `${slotTime(row.slot != null ? row.slot : i)}  solar ${fmtNum(solar[i])}  demand ${fmtNum(demand[i])}  grid ${fmtNum(grid[i])}  battery ${fmtNum(batt[i])} kW${soc[i] != null ? `  SOC ${fmtNum(soc[i], 0)}%` : ''}`;
    tip.style.left = `${Math.min(r.width - 300, Math.max(0, e.clientX - r.left + 10))}px`;
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(canvas); else setTimeout(draw, 0);
  return wrap;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
function line(c, vals, x, y, color, width) {
  c.strokeStyle = color; c.lineWidth = width; c.beginPath();
  let pen = false;
  vals.forEach((v, i) => { if (v == null) { pen = false; return; } if (pen) c.lineTo(x(i), y(v)); else { c.moveTo(x(i), y(v)); pen = true; } });
  c.stroke();
}
function area(c, vals, x, y, color, alpha) {
  c.fillStyle = color; c.globalAlpha = alpha; c.beginPath();
  c.moveTo(x(0), y(0));
  vals.forEach((v, i) => c.lineTo(x(i), y(v)));
  c.lineTo(x(vals.length - 1), y(0)); c.closePath(); c.fill(); c.globalAlpha = 1;
}

// Simple vertical bar chart in SVG. items: [{label, value, color?, note?}]
export function barChart(items, { height = 120, unit = '', format = (v) => fmtNum(v) } = {}) {
  const data = arr(items).filter((d) => d && num(d.value) != null);
  if (!data.length) return h('div', { class: 'ag-empty sm' }, 'No data yet.');
  const W = Math.max(240, data.length * 56), Hh = height, pb = 18, pt = 14;
  const max = Math.max(...data.map((d) => Math.abs(num(d.value))), 1e-9);
  const bw = (W / data.length) * 0.62;
  const svg = s('svg', { viewBox: `0 0 ${W} ${Hh}`, class: 'ag-bars', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Bar chart' });
  data.forEach((d, i) => {
    const v = Math.abs(num(d.value));
    const bh = ((Hh - pb - pt) * v) / max;
    const cx = (W / data.length) * (i + 0.5);
    svg.append(
      s('rect', { x: cx - bw / 2, y: Hh - pb - bh, width: bw, height: Math.max(1, bh), rx: 3, fill: d.color || '#69b1ff' }, s('title', {}, `${d.label}: ${format(d.value)}${unit ? ' ' + unit : ''}${d.note ? ' - ' + d.note : ''}`)),
      s('text', { x: cx, y: Hh - pb - bh - 4, 'text-anchor': 'middle', class: 'v' }, format(d.value)),
      s('text', { x: cx, y: Hh - 5, 'text-anchor': 'middle', class: 'l' }, String(d.label).slice(0, 10)));
  });
  return svg;
}
