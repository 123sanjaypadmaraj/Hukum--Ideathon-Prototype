// Small helpers shared by the agents control room. No dependencies.

export const $ = (s, root = document) => root.querySelector(s);

// DOM helper in the same style as js/scan/app.js.
export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}

function setAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv; } }
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
}
function append(n, kids) {
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
}

// ---------------------------------------------------------------- agents
// Mirrors agents/state.py AGENTS (display order, labels, roles).
export const AGENTS = [
  { id: 'mapping', label: 'Mapping Agent', short: 'Mapping', key: 'building', role: 'Builds the building model from blueprints, Google Solar API, Open Buildings, OSM, RoomPlan, CCTV and meters (HUKUM Scan).' },
  { id: 'solar_planner', label: 'Solar Planner', short: 'Solar Planner', key: 'solar_plan', role: 'Sizes and lays out rooftop solar + battery, yield and payback.' },
  { id: 'environment', label: 'Environmental Engineer', short: 'Env. Engineer', key: 'env_review', role: 'Reviews every solar plan in a loop: setbacks, shading, structure, CO2, water, glare. Sends it back until it passes.' },
  { id: 'solar_health', label: 'Solar Health Agent', short: 'Solar Health', key: 'solar_health', role: 'Performance ratio, string-level faults, soiling and inverter health.' },
  { id: 'fault_maintenance', label: 'Fault & Maintenance Agent', short: 'Fault & Maint.', key: 'faults', role: 'Turns anomalies into prioritised work orders and predicts failures.' },
  { id: 'bill_auditor', label: 'Bill Auditor', short: 'Bill Auditor', key: 'bill_audit', role: 'Checks utility bills against meter data and the tariff; finds overcharges.' },
  { id: 'negotiator', label: 'Multi-Campus Negotiator', short: 'Negotiator', key: 'market', role: 'Verifies export credit and trades surplus solar between campuses at a fair price.' },
  { id: 'control', label: 'Control Agent', short: 'Control', key: 'control', role: 'Turns plans into safe actions on rooms, HVAC, pumps, EVs and battery; respects the pilot mode.' },
  { id: 'optimiser', label: 'State Optimiser', short: 'Optimiser', key: 'optimiser', role: 'Solves the next 24 h (96 slots) for minimum cost within comfort and safety limits.' },
];
export const AGENT_IDS = AGENTS.map((a) => a.id);
export const EXTRA = {
  supervisor: { id: 'supervisor', label: 'Supervisor', short: 'Supervisor', role: 'Reads the goal, builds the route and hands work to each agent in turn.' },
  reporter: { id: 'reporter', label: 'Reporter', short: 'Reporter', key: 'report', role: 'Writes the final report: headline, KPIs and one section per agent.' },
};
export const COLORS = {
  supervisor: '#f5b301', reporter: '#bfbfbf',
  mapping: '#40a9ff', solar_planner: '#ffc53d', environment: '#73d13d', solar_health: '#36cfc9',
  fault_maintenance: '#ff7a45', bill_auditor: '#b37feb', negotiator: '#ff85c0', control: '#ffa39e', optimiser: '#85a5ff',
};
export function agentMeta(id) {
  return AGENTS.find((a) => a.id === id) || EXTRA[id] || { id, label: humanize(id || 'system'), short: humanize(id || 'system'), role: '' };
}
export const colorOf = (id) => COLORS[id] || '#8a9bb0';

// ---------------------------------------------------------------- formatting
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const num = (v, d = null) => (isNum(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d));
export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export const str = (v, d = '') => (v == null ? d : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : safeJson(v));

export function safeJson(v, limit = 400) {
  try { const t = JSON.stringify(v); return t && t.length > limit ? t.slice(0, limit) + '...' : (t || ''); } catch { return String(v); }
}
export function fmtNum(v, d = 1) {
  const n = num(v);
  if (n == null) return '-';
  const digits = Math.abs(n) >= 100 ? 0 : d;
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
export function fmtRs(v) {
  const n = num(v);
  if (n == null) return '-';
  const neg = n < 0; const a = Math.abs(n);
  let t;
  if (a >= 1e7) t = `${(a / 1e7).toFixed(2)} Cr`;
  else if (a >= 1e5) t = `${(a / 1e5).toFixed(2)} L`;
  else t = a.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return `${neg ? '-' : ''}Rs ${t}`;
}
export const fmtUnit = (v, unit, d = 1) => (num(v) == null ? '-' : `${fmtNum(v, d)} ${unit}`);
// A value already in percent (e.g. 18.4).
export function fmtPct(v, d = 1) {
  const n = num(v);
  return n == null ? '-' : `${n.toFixed(d)}%`;
}
// A ratio that may be 0..1 (e.g. PR 0.78) or already a percent (78).
export function fmtRatio(v, d = 1) {
  const n = num(v);
  if (n == null) return '-';
  return `${(Math.abs(n) <= 1.5 ? n * 100 : n).toFixed(d)}%`;
}
export function humanize(k) {
  return String(k || '').replace(/_/g, ' ').replace(/\b(rs|kwh|kw|kwp|co2|pr|soc|kva)\b/gi, (m) => ({ rs: 'Rs', kwh: 'kWh', kw: 'kW', kwp: 'kWp', co2: 'CO2', pr: 'PR', soc: 'SOC', kva: 'kVA' }[m.toLowerCase()]))
    .replace(/^./, (c) => c.toUpperCase());
}
// Format a value by its key name (used for KPI tiles and generic key/value lists).
export function fmtByKey(key, v) {
  if (v == null) return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!isNum(v)) return typeof v === 'object' ? safeJson(v, 120) : String(v);
  const k = String(key).toLowerCase();
  if (/(^|_)rs$|_rs_|rs_|rupee|cost|saving.*rs|capex|amount/.test(k) && !/pct|percent/.test(k)) return fmtRs(v);
  if (/pct|percent/.test(k)) return `${fmtNum(v, 1)}%`;
  if (/(^|_)pr$|efficiency|confidence/.test(k)) return fmtRatio(v);
  if (/kwh/.test(k)) return `${fmtNum(v)} kWh`;
  if (/kwp/.test(k)) return `${fmtNum(v)} kWp`;
  if (/kw/.test(k)) return `${fmtNum(v)} kW`;
  if (/years|payback/.test(k)) return `${fmtNum(v)} yr`;
  if (/co2.*_t|_t_year|tonne/.test(k)) return `${fmtNum(v)} t`;
  if (/co2.*kg|_kg/.test(k)) return `${fmtNum(v)} kg`;
  return fmtNum(v, 2);
}
export function fmtClock(t) {
  const n = num(t);
  if (n == null) return '';
  const d = new Date(n > 1e12 ? n : n * 1000);
  return d.toTimeString().slice(0, 8);
}
export function slotTime(slot) {
  const m = (num(slot, 0) * 15) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- icons
// 24x24 stroke icons, one per agent (drawn with currentColor).
export const ICONS = {
  supervisor: 'M9 3h6v5H9zM12 8v4M5 16v-4h14v4M3 16h4v5H3zM10 16h4v5h-4zM17 16h4v5h-4z',
  reporter: 'M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4',
  mapping: 'M4 20V9l8-5 8 5v11M3 20h18M9 20v-5h6v5M8 11h2M14 11h2',
  solar_planner: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
  environment: 'M5 20c0-9 6-15 15-15 0 9-6 15-15 15zM5 20l8-8',
  solar_health: 'M3 12h4l2-5 4 10 2-5h6',
  fault_maintenance: 'M14.5 6.5a4 4 0 00-5.2 5.2L3.5 17.5l3 3 5.8-5.8a4 4 0 005.2-5.2L15 12l-2.6-.4L12 9z',
  bill_auditor: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4',
  negotiator: 'M4 8h14l-4-4M20 16H6l4 4',
  control: 'M12 3v9M6.3 6.3a8 8 0 1011.4 0',
  optimiser: 'M3 3v18h18M7 15l4-4 3 3 6-7',
};
export function iconSvg(id, size = 16) {
  return s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ag-ico' },
    s('path', { d: ICONS[id] || 'M12 12m-8 0a8 8 0 1016 0a8 8 0 10-16 0' }));
}
// Round avatar: agent colour tint with its icon.
export function avatar(id, size = 26) {
  const c = colorOf(id);
  return h('span', { class: 'ag-av', style: { width: `${size}px`, height: `${size}px`, color: c, background: `${c}1f`, borderColor: `${c}66` } }, iconSvg(id, Math.round(size * 0.58)));
}
