// HUKUM Zero Scan UI: inputs per stage (sample / file / live), run the pipeline,
// show the fused model, camera calibration, NILM, facts, Brick, and the
// short review queue for a person.
import * as SM from './samples.js';
import { fetchSolarInsights, fetchOverpass, fetchIrradiance } from './parsers.js';
import { createScan, setSite, runFuse, loadRender, runOutside, runBlueprints, runWalkthrough, runCctv, runElectricity } from './pipeline.js';
import { createLiveBuild } from './livebuild.js';
import { SOURCES, fmtValue } from './facts.js';
import { buildModel, toTurtle } from './brick.js';
import { createPlanView, drawMeter, drawFloorInset } from './view.js';
import { fitHomography, applyH } from './geom.js';
import { FLOORS } from '../building.js';
import { createState } from '../state.js';

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- sources
const STAGES = [
  { n: 1, title: 'Outside: footprint, roof, solar', sub: 'Solar API roof segments, Open Buildings outline and height, OSM names, irradiance.' },
  { n: 2, title: 'Inside: blueprints', sub: 'CAD (DXF), BIM (IFC), scanned plans + OCR, single-line diagram.' },
  { n: 3, title: 'Interior scan', sub: 'RoomPlan scan fills the gaps; nameplate photos give kW ratings.' },
  { n: 4, title: 'CCTV to rooms', sub: 'One frame per camera, homography to the plan, detections land in room ids.' },
  { n: 5, title: 'Electricity and occupancy', sub: 'NILM on the block meter, Wi-Fi AP logs, timetable export.' },
  { n: 6, title: 'Align, fuse, ask', sub: 'ICP alignment, Brick graph, confidence per fact, a short to-do list for a person.' },
];

const SRC = [
  { key: 'solar', stage: 1, name: 'Google Solar API (buildingInsights)', accept: '.json', kind: 'json', sample: () => SM.sampleSolarInsights(scan.site),
    live: async () => { const k = $('#sc-key')?.value.trim(); if (!k) throw new Error('Enter a Maps Platform API key first'); return fetchSolarInsights(scan.site.lat, scan.site.lon, k); },
    extra: () => h('div', { class: 'src-extra' }, 'Key', h('input', { id: 'sc-key', type: 'password', placeholder: 'Maps Platform API key (stays in this browser)', value: store.get('hukum-scan-key') || '', onchange: (e) => store.set('hukum-scan-key', e.target.value.trim()) })) },
  { key: 'openBuildings', stage: 1, name: 'Open Buildings + 2.5D height (CSV)', accept: '.csv', kind: 'text', sample: () => SM.sampleOpenBuildingsCSV(scan.site) },
  { key: 'osm', stage: 1, name: 'OpenStreetMap (Overpass JSON)', accept: '.json', kind: 'json', sample: () => SM.sampleOsmJSON(scan.site), live: () => fetchOverpass(scan.site.lat, scan.site.lon) },
  { key: 'irradiance', stage: 1, name: 'Irradiance (Open-Meteo / NASA POWER)', kind: 'none', sample: () => ({ ghiKWhPerDay: 5.35, source: 'Bengaluru long-term mean (NASA POWER)' }), live: () => fetchIrradiance(scan.site.lat, scan.site.lon) },
  { key: 'dxf', stage: 2, name: 'CAD floor plan (DXF)', accept: '.dxf', kind: 'text', sample: () => SM.sampleDXF(), meta: { floor: 'MB-1' }, floorPick: true },
  { key: 'ifc', stage: 2, name: 'BIM model (IFC)', accept: '.ifc', kind: 'text', sample: () => SM.sampleIFC() },
  { key: 'plan', stage: 2, name: 'Scanned plan: room segmentation + OCR (JSON)', accept: '.json', kind: 'json', sample: () => SM.samplePlanRecognition(), meta: { floor: 'MB-G' } },
  { key: 'sld', stage: 2, name: 'Single-line diagram OCR (text)', accept: '.txt', kind: 'text', sample: () => SM.sampleSLDText() },
  { key: 'roomplan', stage: 3, name: 'Interior scan, RoomPlan (JSON)', accept: '.json', kind: 'json', sample: () => SM.sampleRoomPlan() },
  { key: 'nameplates', stage: 3, name: 'Nameplate photos, OCR text (JSON)', accept: '.json', kind: 'json', sample: () => SM.sampleNameplates() },
  { key: 'cctvCounts', stage: 4, name: 'SEE engine people counts (JSON)', accept: '.json', kind: 'json', sample: () => SM.sampleCctvCounts() },
  { key: 'meter', stage: 5, name: 'Block energy meter, 1-min kW (CSV)', accept: '.csv', kind: 'text', sample: () => SM.sampleMeterCSV() },
  { key: 'wifi', stage: 5, name: 'Wi-Fi AP client counts (CSV)', accept: '.csv', kind: 'text', sample: () => SM.sampleWifiCSV() },
  { key: 'timetable', stage: 5, name: 'Timetable / lab bookings (CSV)', accept: '.csv', kind: 'text', sample: () => SM.sampleTimetableCSV() },
];

let scan = createScan(SM.SITE_DEFAULT);
const stageEls = {};
const srcEls = {};

function describe(key) {
  const inp = scan.inputs[key];
  if (!inp) return 'not loaded';
  const d = inp.data;
  const size = typeof d === 'string' ? `${(d.length / 1024).toFixed(1)} KB` : Array.isArray(d) ? `${d.length} items` : d && typeof d === 'object' ? `${Object.keys(d).length} keys` : '';
  return `${inp.label || inp.origin}${size ? ' · ' + size : ''}`;
}

function setInput(key, origin, data, label, meta) {
  const def = SRC.find((s) => s.key === key);
  scan.inputs[key] = { origin, data, label, meta: meta || (def.meta ? { ...def.meta, ...(scan.inputs[key]?.meta || {}) } : undefined) };
  renderSrc(key);
}

function renderSrc(key) {
  const el = srcEls[key];
  if (!el) return;
  const inp = scan.inputs[key];
  el.chip.className = `chip ${inp ? inp.origin : 'none'}`;
  el.chip.textContent = inp ? inp.origin : 'empty';
  el.stat.textContent = describe(key);
}

function buildStages() {
  const root = $('#sc-stages');
  root.textContent = '';
  for (const st of STAGES) {
    const card = h('section', { class: 'st', 'data-state': 'idle' },
      h('div', { class: 'st-head' }, h('div', { class: 'st-num' }, st.n), h('div', { class: 'st-title' }, st.title)),
      h('div', { class: 'st-sub' }, st.sub));
    stageEls[st.n] = card;
    for (const s of SRC.filter((x) => x.stage === st.n)) {
      const chip = h('span', { class: 'chip none' }, 'empty');
      const stat = h('div', { class: 'src-stat' }, 'not loaded');
      const file = h('input', { type: 'file', accept: s.accept || '', hidden: true, onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const txt = await f.text();
          setInput(s.key, 'file', s.kind === 'json' ? JSON.parse(txt) : txt, f.name);
        } catch (err) { logLine(st.n, `${f.name}: ${err.message}`, 'error'); }
        e.target.value = '';
      } });
      const btns = h('div', { class: 'src-btns' },
        h('button', { class: 'sc-btn sm', type: 'button', title: 'Use the generated sample', onclick: () => setInput(s.key, 'sample', s.sample(), 'sample') }, 'Sample'),
        s.kind !== 'none' ? h('button', { class: 'sc-btn sm', type: 'button', title: `Upload ${s.accept}`, onclick: () => file.click() }, 'File') : null,
        s.live ? h('button', { class: 'sc-btn sm', type: 'button', title: 'Fetch live from the network', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; stat.textContent = 'fetching...';
          try { setInput(s.key, 'live', await s.live(), 'live'); }
          catch (err) { stat.textContent = `live fetch failed: ${err.message}`; logLine(st.n, `${s.name}: ${err.message}`, 'error'); }
          b.disabled = false;
        } }, 'Live') : null,
        file);
      const row = h('div', { class: 'src' }, h('div', { class: 'src-name' }, s.name, chip), btns, stat);
      if (s.floorPick) {
        const sel = h('select', { onchange: (e) => { if (scan.inputs[s.key]) scan.inputs[s.key].meta = { floor: e.target.value }; } },
          ...['MB-G', 'MB-1', 'MB-2'].map((f) => h('option', { value: f, selected: f === s.meta.floor }, f)));
        row.append(h('div', { class: 'src-extra' }, 'Drawing is floor', sel));
      }
      if (s.extra) row.append(s.extra());
      srcEls[s.key] = { chip, stat, row };
      card.append(row);
    }
    if (st.n === 6) card.append(h('div', { class: 'src' }, h('div', { class: 'src-stat' }, 'Runs on whatever is loaded above. Missing sources lower confidence; nothing is required.')));
    root.append(card);
  }
}

function loadAllSamples() {
  for (const s of SRC) setInput(s.key, 'sample', s.sample(), 'sample');
}

// ---------------------------------------------------------------- tabs
const TABS = [['live', 'Live build'], ['model', 'Model'], ['cameras', 'Cameras'], ['meter', 'Meter (NILM)'], ['facts', 'Facts'], ['brick', 'Brick graph']];
let tab = 'live';
const views = {};
function buildTabs() {
  const nav = $('#sc-tabs'), host = $('#sc-views');
  for (const [id, label] of TABS) {
    nav.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === tab), 'data-tab': id, onclick: () => showTab(id) }, label));
    const v = h('div', { class: `view${id === tab ? ' on' : ''}`, 'data-view': id });
    views[id] = v;
    host.append(v);
  }
}
function showTab(id) {
  tab = id;
  live && live.setVisible(id === 'live');
  document.querySelectorAll('#sc-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  Object.entries(views).forEach(([k, v]) => v.classList.toggle('on', k === id));
  renderTab();
}

// Model tab
const layer = { floor: 'MB-1', context: true, footprint: true, roof: true, blueprint: true, plan: true, scan: true, objects: false, cameras: true, detections: false, before: false };
let plan = null, inspectEl = null;
function buildModelView() {
  const v = views.model;
  const chk = (key, label) => h('label', {}, h('input', { type: 'checkbox', checked: layer[key], onchange: (e) => { layer[key] = e.target.checked; plan.set(scan, layer); } }), label);
  const bar = h('div', { class: 'view-bar' },
    h('label', {}, 'Floor ', h('select', { onchange: (e) => { layer.floor = e.target.value; plan.set(scan, layer); } }, ...['MB-G', 'MB-1', 'MB-2'].map((f) => h('option', { value: f, selected: f === layer.floor }, f)))),
    chk('footprint', 'Footprint'), chk('roof', 'Roof segments'), chk('blueprint', 'Blueprint'), chk('plan', 'Scanned plan'), chk('scan', 'Interior scan'), chk('objects', 'Furniture'), chk('cameras', 'Cameras'), chk('detections', 'Detections'), chk('context', 'Campus'),
    chk('before', 'Before alignment'),
    h('button', { class: 'sc-btn sm', type: 'button', onclick: () => plan.refit() }, 'Fit'),
    h('span', { class: 'legend' }, h('span', {}, h('i', { style: 'background:#52c41a' }), 'accepted'), h('span', {}, h('i', { style: 'background:#faad14' }), 'to confirm'), h('span', {}, h('i', { style: 'background:#ff4d4f' }), 'conflict'), h('span', {}, h('i', { style: 'background:#40a9ff' }), 'decided')));
  const canvas = h('canvas', { 'aria-label': 'Fused building model, drag to pan, wheel to zoom, click a room' });
  inspectEl = h('div', { class: 'inspect' });
  v.append(bar, h('div', { class: 'view-body' }, canvas, inspectEl));
  plan = createPlanView(canvas, { onPick: inspectRoom });
}
function inspectRoom(id) {
  inspectEl.textContent = '';
  if (!id) return;
  const rows = scan.fused.resolved.filter((r) => r.subject === id || r.value === id);
  inspectEl.append(h('h3', {}, id), h('table', { class: 'facts' },
    h('tbody', {}, ...rows.map((r) => h('tr', {},
      h('td', {}, r.subject === id ? r.predicate.replace(/_/g, ' ') : `${r.subject} ${r.predicate}`),
      h('td', { class: 'mono' }, fmtValue(r.value)),
      h('td', {}, h('span', { class: `status ${r.status}` }, r.status), ' ', h('span', { class: 'mono' }, `${Math.round(r.confidence * 100)}%`)),
      h('td', {}, r.sources.map((s) => SOURCES[s]?.label || s).join(', ')))))));
}

// Cameras tab
let camSel = 0, cctv = null, camCal = null;
async function renderCameras() {
  const v = views.cameras;
  v.textContent = '';
  const cals = scan.results.cctv;
  if (!cals?.length) { v.append(h('div', { class: 'empty' }, 'Run the scan to calibrate cameras.')); return; }
  await loadRender();
  if (!cctv) {
    const { createCctv } = await import('../cctv/cctv.js');
    cctv = { make: createCctv };
  }
  const list = h('div', { class: 'cam-list' }, ...cals.map((c, i) => h('button', { class: `sc-btn sm${i === camSel ? ' primary' : ''}`, type: 'button', onclick: () => { camSel = i; renderCameras(); } }, c.cam.id.replace('CAM-', ''))));
  camCal = structuredCloneCal(cals[camSel]);
  const base = h('canvas', { width: 960, height: 540 });
  const over = h('canvas', { class: 'overlay', width: 960, height: 540 });
  const inset = h('canvas');
  const info = h('dl', { class: 'kv' });
  v.append(h('div', { class: 'view-bar' }, 'Floor points (yellow) are proposed automatically; drag any of them to correct it and the homography refits.'),
    h('div', { class: 'view-scroll' }, list, h('div', { class: 'cam-grid' },
      h('div', { class: 'cam-frame' }, base, over),
      h('div', { class: 'cam-side' }, inset, info))));
  // Render the camera frame with the same people the detections came from.
  const st = createState();
  st.t = 11 * 60; st.people = camCal.people;
  const room = camCal.cam.roomId;
  Object.assign(st.rooms[room], { lightsOn: true, fansOn: true, acOn: true, powered: true, occupancy: camCal.people.length, detected: camCal.people.length });
  st.cameras[camCal.cam.id].detections = camCal.people.map((p) => ({ personId: p.id, conf: 0.82 + (p.id.length % 7) / 50, x: p.x, y: p.y }));
  st.cameras[camCal.cam.id].count = camCal.people.length;
  const c = cctv.make({ state: st });
  c.renderFeed(base, camCal.cam.id, { boxes: true });
  setTimeout(() => c.renderFeed(base, camCal.cam.id, { boxes: true }), 400);   // fonts/scene caches warm up
  const redraw = () => { drawCamOverlay(over); drawFloorInset(inset, FLOORS[camCal.cam.floor].short, camCal); camInfo(info); };
  redraw();
  let dragI = -1;
  const pos = (e) => { const r = over.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 960, ((e.clientY - r.top) / r.height) * 540]; };
  over.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    dragI = camCal.points.findIndex((q) => Math.hypot(q.img[0] - p[0], q.img[1] - p[1]) < 16);
    if (dragI >= 0) over.setPointerCapture(e.pointerId);
  });
  over.addEventListener('pointermove', (e) => {
    if (dragI < 0) return;
    camCal.points[dragI].img = pos(e);
    refit(camCal);
    redraw();
  });
  over.addEventListener('pointerup', () => { dragI = -1; });
}
function structuredCloneCal(c) {
  return { ...c, points: c.points.map((p) => ({ ...p, img: [...p.img] })), detections: c.detections.map((d) => ({ ...d })) };
}
function refit(cal) {
  cal.H = fitHomography(cal.points.map((p) => p.img), cal.points.map((p) => p.plan));
  if (!cal.H) return;
  const f = FLOORS[cal.cam.floor];
  for (const d of cal.detections) {
    d.plan = applyH(cal.H, d.img);
    d.roomId = f.rooms.find((r) => d.plan[0] >= r.x && d.plan[0] < r.x + r.w && d.plan[1] >= r.y && d.plan[1] < r.y + r.h)?.id || null;
  }
  cal.accuracy = cal.detections.filter((d) => d.roomId === d.truth).length / Math.max(1, cal.detections.length);
}
function drawCamOverlay(cv) {
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  camCal.points.forEach((p, i) => {
    ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.img[0], p.img[1], 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.img[0] - 14, p.img[1]); ctx.lineTo(p.img[0] + 14, p.img[1]); ctx.moveTo(p.img[0], p.img[1] - 14); ctx.lineTo(p.img[0], p.img[1] + 14); ctx.stroke();
    ctx.fillStyle = '#f5b301'; ctx.font = '600 13px JetBrains Mono, monospace'; ctx.fillText(`${i + 1} ${p.kind}`, p.img[0] + 11, p.img[1] - 9);
  });
  for (const d of camCal.detections) {
    ctx.fillStyle = d.roomId === d.truth ? '#95de64' : '#ff4d4f';
    ctx.beginPath(); ctx.arc(d.img[0], d.img[1], 4, 0, Math.PI * 2); ctx.fill();
  }
}
function camInfo(dl) {
  dl.textContent = '';
  const add = (k, v) => dl.append(h('dt', {}, k), h('dd', {}, v));
  add('Camera', camCal.cam.id);
  add('Room', camCal.cam.roomId);
  add('Floor points', String(camCal.points.length));
  add('Plan error', camCal.meanErrM != null ? `${camCal.meanErrM.toFixed(2)} m (at fit)` : '-');
  add('Detections', String(camCal.detections.length));
  add('Land in room', camCal.accuracy != null ? `${Math.round(camCal.accuracy * 100)}%` : '-');
  dl.append(h('dt', {}, ''), h('dd', { style: 'font-family:inherit;color:var(--muted)' }, 'Green dots are YOLO foot points that map into the right room; red ones land elsewhere. Lens distortion is not modelled, so edge points carry most of the error.'));
}

// Meter tab
function renderMeter() {
  const v = views.meter;
  v.textContent = '';
  const n = scan.results.nilm;
  if (!n) { v.append(h('div', { class: 'empty' }, 'Load a meter CSV and run the scan.')); return; }
  const canvas = h('canvas');
  const matches = n.matches || [];
  const idFor = (a) => {
    if (a.roomCircuits) return 'classroom circuits (lines up with timetable bells)';
    const m = matches.find((x) => x.appliance === a);
    if (!m) return 'unidentified';
    return `${m.tags.join(' or ')} (${Math.round(m.ratio * 100)}% of ${m.rated} kW plate)`;
  };
  const body = h('div', { class: 'view-body', style: 'flex: 0 0 300px' }, canvas);
  v.append(h('div', { class: 'view-bar' }, `Main Block meter · ${n.series.length} samples · ${n.events} step events · ${n.paired} on/off pairs`), body);
  drawMeter(canvas, n);
  v.append(h('div', { class: 'view-scroll' }, h('table', { class: 'facts' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Cluster'), h('th', {}, 'kW'), h('th', {}, 'Runs'), h('th', {}, 'Avg min'), h('th', {}, 'Starts'), h('th', {}, 'Identified as'))),
    h('tbody', {}, ...n.appliances.map((a) => h('tr', {},
      h('td', {}, h('i', { style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${a.color}` })),
      h('td', { class: 'mono' }, a.id), h('td', { class: 'mono' }, a.kW), h('td', { class: 'mono' }, a.runs), h('td', { class: 'mono' }, a.meanMinutes),
      h('td', { class: 'mono' }, a.starts.join(', ')), h('td', {}, idFor(a))))))));
}

// Facts tab
let factFilter = '';
function renderFacts() {
  const v = views.facts;
  v.textContent = '';
  const res = scan.fused.resolved;
  if (!res.length) { v.append(h('div', { class: 'empty' }, 'No facts yet. Load sources and run the scan.')); return; }
  const tbody = h('tbody');
  const fill = () => {
    tbody.textContent = '';
    const q = factFilter.toLowerCase();
    for (const r of res) {
      const line = `${r.subject} ${r.predicate} ${r.value} ${r.status} ${r.sources.join(' ')}`.toLowerCase();
      if (q && !line.includes(q)) continue;
      const raw = scan.store.facts.filter((f) => f.subject === r.subject && f.predicate === r.predicate);
      tbody.append(h('tr', { title: raw.map((f) => `${SOURCES[f.source]?.label}: ${fmtValue(f.value)} (${f.confidence}) ${f.evidence}`).join('\n') },
        h('td', { class: 'mono' }, r.subject), h('td', {}, r.predicate.replace(/_/g, ' ')), h('td', { class: 'mono' }, fmtValue(r.value)),
        h('td', {}, h('span', { class: 'bar' }, h('i', { style: `width:${Math.round(r.confidence * 100)}%` })), h('span', { class: 'mono' }, `${Math.round(r.confidence * 100)}%`)),
        h('td', {}, h('span', { class: `status ${r.status}` }, r.status)),
        h('td', {}, r.sources.map((s) => SOURCES[s]?.label || s).join(', '))));
    }
  };
  const input = h('input', { type: 'search', placeholder: 'Filter: room id, predicate, source, status...', value: factFilter, style: 'flex:1', oninput: (e) => { factFilter = e.target.value; fill(); } });
  v.append(h('div', { class: 'view-bar' }, input, `${res.length} statements from ${scan.store.facts.length} raw facts. Hover a row for the evidence.`),
    h('div', { class: 'view-scroll' }, h('table', { class: 'facts' },
      h('thead', {}, h('tr', {}, ...['Subject', 'Predicate', 'Value', 'Confidence', 'Status', 'Sources'].map((t) => h('th', {}, t)))), tbody)));
  fill();
}

// Brick tab
function renderBrick() {
  const v = views.brick;
  v.textContent = '';
  if (!scan.fused.resolved.length) { v.append(h('div', { class: 'empty' }, 'Run the scan to build the graph.')); return; }
  const model = buildModel(scan);
  v.append(h('div', { class: 'view-bar' }, `Brick Schema: ${model.floors.length} floors, ${model.rooms.length} rooms, ${model.circuits.length} circuits, ${model.equipment.length} equipment, ${model.cameras.length} cameras. Open questions stay out until a person answers them.`),
    h('div', { class: 'view-scroll' }, h('pre', { class: 'ttl' }, toTurtle(model))));
}

function renderTab() {
  if (tab === 'live') return;
  if (tab === 'model') plan.set(scan, layer);
  else if (tab === 'cameras') renderCameras();
  else if (tab === 'meter') renderMeter();
  else if (tab === 'facts') renderFacts();
  else if (tab === 'brick') renderBrick();
}

// ---------------------------------------------------------------- right column
function renderSummary() {
  const s = scan.summary || { total: 0, autoPct: 0, open: 0 };
  $('#sc-summary').replaceChildren(
    h('div', { class: 'kpi' }, h('b', {}, s.total), h('span', {}, 'statements')),
    h('div', { class: 'kpi' }, h('b', { style: 'color:var(--ok)' }, `${s.autoPct}%`), h('span', {}, 'accepted on their own')),
    h('div', { class: 'kpi' }, h('b', { style: `color:${s.open ? 'var(--warn)' : 'var(--ok)'}` }, s.open), h('span', {}, 'need a person')));
}

function renderReview() {
  const root = $('#sc-review');
  root.textContent = '';
  const items = scan.fused.review;
  if (!scan.summary) { root.append(h('div', { class: 'empty' }, 'Press Test run to upload the files in test-files/ and scan them, or load your own files on the left and press Run scan.')); return; }
  const open = items.filter((r) => !r.decided);
  if (!open.length) root.append(h('div', { class: 'allclear' }, 'Nothing left to check. Every statement is either confirmed by the sources or decided by a person.'));
  for (const r of [...open, ...items.filter((x) => x.decided)]) {
    const card = h('div', { class: `rv ${r.kind}${r.decided ? ' decided' : ''}` },
      h('div', { class: 'rv-kind' }, r.kind === 'cross-check' ? 'cross-check' : r.kind === 'conflict' ? 'sources disagree' : 'low confidence'),
      h('div', { class: 'rv-title' }, r.title),
      h('div', { class: 'rv-detail' }, r.detail));
    if (r.decided) {
      card.append(h('div', { class: 'rv-done' }, h('span', {}, `Decided: ${r.decided.label}`),
        h('button', { class: 'sc-btn sm', type: 'button', onclick: () => { scan.store.undecide(r.key); refuse(); } }, 'Undo')));
    } else {
      card.append(h('div', { class: 'rv-opts' }, ...r.options.map((o) => h('button', { class: 'sc-btn sm', type: 'button', onclick: () => { scan.store.decide(r.key, { value: o.value, label: o.label, choice: o.id }); refuse(); } }, o.label))));
    }
    const subj = r.subject && !r.subject.includes(' ') ? r.subject : null;
    if (subj) card.addEventListener('mouseenter', () => { if (tab === 'model') plan.pick(subj); });
    root.append(card);
  }
}

function renderExport() {
  const root = $('#sc-export');
  root.textContent = '';
  const ready = scan.fused.resolved.length > 0;
  const dl = (name, type, content) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([content], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
  };
  root.append(
    h('button', { class: 'sc-btn sm', type: 'button', disabled: !ready, onclick: () => dl('nhce-main-block.ttl', 'text/turtle', toTurtle(buildModel(scan))) }, 'Brick graph (.ttl)'),
    h('button', { class: 'sc-btn sm', type: 'button', disabled: !ready, onclick: () => dl('nhce-main-block-model.json', 'application/json', JSON.stringify(buildModel(scan), null, 2)) }, 'Model (.json)'),
    h('button', { class: 'sc-btn sm', type: 'button', disabled: !ready, onclick: () => dl('hukum-scan-facts.json', 'application/json', JSON.stringify({ facts: scan.store.facts, decisions: Object.fromEntries(scan.store.decisions), review: scan.fused.review.map(({ apply, ...r }) => r) }, null, 2)) }, 'Facts + decisions (.json)'),
    h('button', { class: 'sc-btn sm', type: 'button', onclick: () => dl('sample-main-block-MB-1.dxf', 'application/dxf', SM.sampleDXF()) }, 'Sample DXF'));
}

function logLine(stage, text, level = 'info') { scan.log.push({ at: new Date(), stage, text, level }); renderLog(); }
function renderLog() {
  $('#sc-log').replaceChildren(...scan.log.slice(-60).map((l) => h('div', { class: l.level }, h('b', {}, `[${l.stage}] `), l.text)));
}

function refuse() {
  runFuse(scan);
  renderAll();
}
function renderAll() {
  renderSummary(); renderReview(); renderExport(); renderLog(); renderTab();
}

// ---------------------------------------------------------------- run
const PIPE = [
  [1, 'Outside: footprint, roof, solar', runOutside],
  [2, 'Inside: blueprints, BIM, plans, SLD', runBlueprints],
  [3, 'Interior scan + nameplates', runWalkthrough],
  [4, 'CCTV to rooms', runCctv],
  [5, 'Electricity and occupancy', runElectricity],
  [6, 'Align, fuse, review', runFuse],
];
let busy = false;
function setBusy(on, label) {
  busy = on;
  for (const id of ['#sc-run', '#sc-test', '#sc-samples']) $(id).disabled = on;
  $('#sc-run').textContent = on && label ? label : 'Run scan';
}

// Run every stage; each stage waits for its live-build animation.
async function run() {
  if (busy) return;
  setBusy(true, 'Scanning...');
  const decisions = scan.store.decisions;
  const inputs = scan.inputs;
  const site = scan.site;
  scan = createScan(site);
  scan.inputs = inputs;
  for (const [k, v] of decisions) scan.store.decisions.set(k, v);   // keep answers across re-runs
  Object.values(stageEls).forEach((el) => el.setAttribute('data-state', 'idle'));
  showTab('live');
  live.reset();
  live.enterFullscreen();
  for (const [n, name, fn] of PIPE) {
    stageEls[n]?.setAttribute('data-state', 'running');
    stageEls[n]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    let state = 'done';
    try { await fn(scan); }
    catch (err) { state = 'error'; scan.log.push({ at: new Date(), stage: n, text: `${name} failed: ${err.message}`, level: 'error' }); console.error(err); }
    renderLog();
    await live.stage(n, scan, state);
    stageEls[n]?.setAttribute('data-state', state);
  }
  live.finish(scan);
  setBusy(false);
  plan && plan.refit();
  renderAll();
}

// Test run: fetch every file listed in test-files/manifest.json as if a person
// had uploaded it, then run the scan with the live build.
async function testRun() {
  if (busy) return;
  setBusy(true, 'Uploading...');
  showTab('live');
  live.reset();
  live.enterFullscreen();
  let manifest;
  try {
    const r = await fetch('test-files/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = await r.json();
  } catch (err) {
    logLine(1, `Could not read test-files/manifest.json (${err.message}). Serve the folder over HTTP, or run node tools/make-test-files.mjs. Using the in-browser samples instead.`, 'error');
    loadAllSamples();
    setBusy(false);
    return run();
  }
  const files = manifest.files.filter((f) => SRC.some((s) => s.key === f.key));
  for (const s of SRC) { delete scan.inputs[s.key]; renderSrc(s.key); }
  live.files(files.map((f) => ({ ...f, state: 'queued' })));
  logLine(0, `Test run: uploading ${files.length} files from test-files/ (${manifest.building || 'test building'})`);
  const slow = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms * slow));
  // Up to three uploads in flight, like dropping many files at once.
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const f = files[next++];
      const def = SRC.find((s) => s.key === f.key);
      const row = srcEls[f.key]?.row;
      row?.classList.add('uploading');
      row?.scrollIntoView({ block: 'nearest' });
      live.fileProgress(f.key, 0.05, 'up');
      try {
        const res = await fetch(`test-files/${encodeURIComponent(f.file)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        const steps = 4 + Math.min(8, Math.round(f.bytes / 20000));
        for (let i = 1; i <= steps; i++) { live.fileProgress(f.key, i / steps); await wait(90); }
        const data = (def.kind === 'json' || def.kind === 'none') ? JSON.parse(txt) : txt;
        setInput(f.key, 'file', data, f.file, f.meta || undefined);
        live.fileProgress(f.key, 1, 'ok');
      } catch (err) {
        live.fileProgress(f.key, 1, 'err');
        logLine(def.stage, `${f.file}: ${err.message}`, 'error');
      }
      row?.classList.remove('uploading');
      row?.classList.add('flash');
      setTimeout(() => row?.classList.remove('flash'), 900);
    }
  }
  await Promise.all([worker(), worker()]);
  await wait(400);
  setBusy(false);
  return run();
}

const params = new URLSearchParams(location.search);
let live = null;
function buildLiveView() {
  const v = views.live;
  v.classList.add('lb-view');
  live = createLiveBuild(v, { onDone: (go) => {
    if (go === 'model') showTab('model');
    else document.querySelector('#sc-review .rv:not(.decided)')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } });
  live.setVisible(tab === 'live');
}

function init() {
  $('#sc-lat').value = scan.site.lat;
  $('#sc-lon').value = scan.site.lon;
  const onSite = () => { setSite(scan, { lat: +$('#sc-lat').value, lon: +$('#sc-lon').value }); logLine(1, `Site set to ${scan.site.lat}, ${scan.site.lon}. Reload samples or fetch live data for the new point.`); };
  $('#sc-lat').addEventListener('change', onSite);
  $('#sc-lon').addEventListener('change', onSite);
  buildStages();
  buildTabs();
  buildModelView();
  buildLiveView();
  $('#sc-samples').addEventListener('click', loadAllSamples);
  $('#sc-run').addEventListener('click', () => run());
  $('#sc-test').addEventListener('click', testRun);
  window.addEventListener('resize', () => renderTab());
  renderAll();
  if (params.has('autotest')) testRun();
  window.HUKUM_SCAN = { get scan() { return scan; } };
}
init();
