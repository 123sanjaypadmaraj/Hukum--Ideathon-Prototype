// Parsers that turn each source's native format into plain geometry and
// records. They work on real files too: Google Solar API buildingInsights
// JSON, Open Buildings CSV rows (WKT), Overpass JSON, ASCII DXF, IFC STEP text,
// plan-recognition JSON, RoomPlan JSON, nameplate/SLD OCR text, and CSVs.
import { makeProjection, levenshtein } from './geom.js';

// ---------------------------------------------------------------- CSV
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------- Google Solar API
export function parseSolarInsights(json, proj) {
  const sp = json.solarPotential || {};
  const quality = json.imageryQuality || 'UNKNOWN';
  const segs = (sp.roofSegmentStats || []).map((s, i) => {
    const bb = s.boundingBox;
    let rect = null;
    if (bb && proj) {
      const a = proj.toLocal(bb.sw.latitude, bb.sw.longitude), b = proj.toLocal(bb.ne.latitude, bb.ne.longitude);
      rect = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    }
    return { index: i, pitch: s.pitchDegrees, azimuth: s.azimuthDegrees, area: s.stats?.areaMeters2, sunshineMedian: s.stats?.sunshineQuantiles?.[5], rect };
  });
  const configs = sp.solarPanelConfigs || [];
  const maxCfg = configs[configs.length - 1] || null;
  const panelW = sp.panelCapacityWatts || 400;
  return {
    quality,
    imageryDate: json.imageryDate ? `${json.imageryDate.year}-${String(json.imageryDate.month).padStart(2, '0')}` : null,
    center: json.center,
    segments: segs,
    roofArea: sp.wholeRoofStats?.areaMeters2 ?? segs.reduce((a, s) => a + (s.area || 0), 0),
    maxPanels: sp.maxArrayPanelsCount || 0,
    panelWatts: panelW,
    maxKWp: ((sp.maxArrayPanelsCount || 0) * panelW) / 1000,
    yearlyDcKWh: maxCfg?.yearlyEnergyDcKwh ?? null,
    sunshineHours: sp.maxSunshineHoursPerYear ?? null,
  };
}

export async function fetchSolarInsights(lat, lon, key) {
  const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lon}&requiredQuality=LOW&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Solar API HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- Open Buildings / OSM
export function parseWKTPolygon(wkt) {
  const m = /POLYGON\s*\(\(([^)]+)\)/i.exec(wkt || '');
  if (!m) return null;
  return m[1].split(',').map((p) => p.trim().split(/\s+/).map(Number)).map(([lon, lat]) => ({ lat, lon }));
}

export function parseOpenBuildings(csvText, proj, near = null) {
  const rows = parseCSV(csvText).map((r) => ({
    lat: +r.latitude, lon: +r.longitude, area: +r.area_in_meters, confidence: +r.confidence,
    ring: parseWKTPolygon(r.geometry), heightM: r.building_height_m ? +r.building_height_m : null, plusCode: r.full_plus_code,
  })).filter((r) => r.ring);
  if (!rows.length) throw new Error('No polygon rows found (expected Open Buildings CSV with a WKT geometry column)');
  // Pick the building closest to the site point.
  const pick = near ? rows.sort((a, b) => Math.hypot(a.lat - near.lat, a.lon - near.lon) - Math.hypot(b.lat - near.lat, b.lon - near.lon))[0] : rows[0];
  let poly = pick.ring.map((p) => proj.toLocal(p.lat, p.lon));
  if (poly.length > 3 && Math.hypot(poly[0][0] - poly.at(-1)[0], poly[0][1] - poly.at(-1)[1]) < 1e-6) poly = poly.slice(0, -1);
  return { ...pick, poly };
}

export function parseOverpass(json, proj) {
  const els = json.elements || [];
  const ways = els.filter((e) => e.type === 'way' && e.geometry);
  const toPoly = (e) => { const p = e.geometry.map((g) => proj.toLocal(g.lat, g.lon)); return p.length > 2 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1] ? p.slice(0, -1) : p; };
  const buildings = ways.filter((w) => w.tags?.building).map((w) => ({ id: w.id, name: w.tags.name || null, levels: w.tags['building:levels'] ? +w.tags['building:levels'] : null, poly: toPoly(w) }));
  const campus = ways.find((w) => w.tags?.amenity === 'college' || w.tags?.amenity === 'university');
  const roads = ways.filter((w) => w.tags?.highway).map((w) => ({ name: w.tags.name || w.tags.highway, line: w.geometry.map((g) => proj.toLocal(g.lat, g.lon)) }));
  return { buildings, campus: campus ? { name: campus.tags.name, poly: toPoly(campus) } : null, roads };
}

export async function fetchOverpass(lat, lon) {
  const q = `[out:json][timeout:25];(way(around:250,${lat},${lon})[building];way(around:400,${lat},${lon})[amenity~"college|university"];);out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

// Daily global horizontal irradiance for last year (kWh/m2/day average) from Open-Meteo.
export async function fetchIrradiance(lat, lon) {
  const y = new Date().getFullYear() - 1;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${y}-01-01&end_date=${y}-12-31&daily=shortwave_radiation_sum&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();
  const v = (j.daily?.shortwave_radiation_sum || []).filter((x) => x != null);
  if (!v.length) throw new Error('Open-Meteo returned no radiation data');
  const mjPerDay = v.reduce((a, b) => a + b, 0) / v.length;          // MJ/m2/day
  return { ghiKWhPerDay: mjPerDay / 3.6, days: v.length, year: y, source: 'Open-Meteo archive (ERA5)' };
}

// ---------------------------------------------------------------- DXF
// Reads LWPOLYLINE, POLYLINE/VERTEX, LINE, CIRCLE, TEXT and MTEXT from the
// ENTITIES section. Enough for room boundaries, labels and electrical tags.
export function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let units = null;
  const ents = [];
  let section = null, cur = null, poly = null;
  const flush = () => { if (cur) ents.push(cur); cur = null; };
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { flush(); section = pairs[i + 1]?.[1]; continue; }
    if (c === 0 && v === 'ENDSEC') { flush(); section = null; continue; }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') { units = parseInt(pairs[i + 1]?.[1], 10); continue; }
    if (section !== 'ENTITIES') continue;
    if (c === 0) {
      if (v === 'VERTEX' && poly) { flush(); cur = { type: 'VERTEX', _parent: poly }; continue; }
      if (v === 'SEQEND') { flush(); if (poly) { ents.push(poly); poly = null; } continue; }
      flush();
      cur = { type: v, layer: '0', pts: [], text: '' };
      if (v === 'POLYLINE') { poly = cur; cur = null; }
      continue;
    }
    const tgt = cur || poly;
    if (!tgt) continue;
    if (tgt.type === 'VERTEX') {
      if (c === 10) tgt._x = +v;
      if (c === 20) { tgt._parent.pts.push([tgt._x, +v]); }
      continue;
    }
    if (c === 8) tgt.layer = v;
    else if (c === 10) tgt.pts.push([+v, NaN]);
    else if (c === 20 && tgt.pts.length) tgt.pts[tgt.pts.length - 1][1] = +v;
    else if (c === 11) tgt.p2 = [+v, NaN];
    else if (c === 21 && tgt.p2) tgt.p2[1] = +v;
    else if (c === 40) tgt.r = +v;
    else if (c === 70) tgt.flags = +v;
    else if (c === 1 || c === 3) tgt.text += v.replace(/\\P/g, ' ').replace(/\{\\[^;]*;|\}/g, '');
  }
  flush();
  // $INSUNITS: 1 in, 2 ft, 4 mm, 5 cm, 6 m.
  const scale = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 }[units] ?? null;
  return {
    units, scaleToM: scale,
    polylines: ents.filter((e) => (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.pts.length > 2).map((e) => ({ layer: e.layer, closed: !!(e.flags & 1), pts: e.pts })),
    lines: ents.filter((e) => e.type === 'LINE' && e.p2).map((e) => ({ layer: e.layer, a: e.pts[0], b: e.p2 })),
    circles: ents.filter((e) => e.type === 'CIRCLE').map((e) => ({ layer: e.layer, c: e.pts[0], r: e.r })),
    texts: ents.filter((e) => e.type === 'TEXT' || e.type === 'MTEXT').map((e) => ({ layer: e.layer, p: e.pts[0], text: e.text.trim() })),
  };
}

// ---------------------------------------------------------------- IFC
export function parseIFC(text) {
  // Split STEP arguments on top-level commas; strings unquoted, $ -> null.
  const strs = (args) => {
    const out = [];
    let cur = '', depth = 0, q = false;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (q) { if (ch === "'" && args[i + 1] === "'") { cur += "'"; i++; } else if (ch === "'") q = false; else cur += ch; continue; }
      if (ch === "'") { q = true; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out.map((v) => (v === '$' || v === '' ? null : v));
  };
  const spaces = [], storeys = [];
  let building = null;
  for (const m of text.matchAll(/#(\d+)\s*=\s*(IFC[A-Z]+)\s*\((.*)\);/g)) {
    const [, , type, args] = m;
    const s = strs(args);
    // IfcSpace(GlobalId, OwnerHistory, Name, Description, ObjectType, Placement, Representation, LongName, ...)
    if (type === 'IFCSPACE') spaces.push({ guid: s[0], name: s[2], longName: s[7] ?? s[3] ?? null });
    else if (type === 'IFCBUILDINGSTOREY') storeys.push({ guid: s[0], name: s[2] });
    else if (type === 'IFCBUILDING') building = s[2];
  }
  // Areas: IFCQUANTITYAREA lines that follow each space in exports like ours.
  const areas = [...text.matchAll(/IFCQUANTITYAREA\('NetFloorArea',[^,]*,[^,]*,([\d.]+)\)/g)].map((m) => +m[1]);
  spaces.forEach((s, i) => { s.area = areas[i] ?? null; });
  return { building, storeys, spaces };
}

// ---------------------------------------------------------------- plan recognition (scanned PDFs / photos)
export function parsePlanRecognition(json, knownIds = []) {
  const ppm = json.pixelsPerMetre || 1;
  const H = json.imageHeightPx || 0;
  return (json.rooms || []).map((r) => {
    const poly = r.polygonPx.map(([x, y]) => [x / ppm, (H - y) / ppm]);
    const raw = (r.ocr?.text || '').toUpperCase();
    let id = raw, fixed = null, editDistance = 0;
    if (knownIds.length && !knownIds.includes(raw)) {
      // OCR confusions: O/0, I/1, S/5, B/8. Fuzzy-match against known ids.
      const norm = (s) => s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
      let best = null;
      for (const k of knownIds) {
        const d = levenshtein(norm(raw), norm(k));
        if (!best || d < best.d) best = { k, d };
      }
      if (best && best.d <= 1) { fixed = best.k; editDistance = levenshtein(raw, best.k); id = best.k; }
    }
    return { id, raw, fixed, editDistance, poly, segScore: r.segmentationScore ?? 0.8, ocrScore: r.ocr?.score ?? 0.8 };
  });
}

// ---------------------------------------------------------------- Apple RoomPlan
const catOf = (c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? Object.keys(c)[0] : 'unknown');
export function parseRoomPlan(json) {
  const rooms = Array.isArray(json.rooms) ? json.rooms : [json];
  return rooms.map((room, i) => {
    const walls = (room.walls || []).map((w) => {
      const t = w.transform, len = w.dimensions[0];
      const dx = t[0], dz = t[2], cx = t[12], cz = t[14];
      const a = [cx - (dx * len) / 2, -(cz - (dz * len) / 2)];
      const b = [cx + (dx * len) / 2, -(cz + (dz * len) / 2)];
      return { a, b, len, conf: catOf(w.confidence) };
    });
    const pos = (o) => [o.transform[12], -o.transform[14]];
    const objects = (room.objects || []).map((o) => ({ cat: catOf(o.category), p: pos(o) }));
    const count = (c) => objects.filter((o) => o.cat === c).length;
    return {
      name: room.name || `Scan room ${i + 1}`, walls, objects,
      doors: (room.doors || []).length, windows: (room.windows || []).length,
      chairs: count('chair'), tables: count('table'), storage: count('storage'),
      poly: wallsToPoly(walls),
      highConf: walls.filter((w) => w.conf === 'high').length / Math.max(1, walls.length),
    };
  });
}

// Wall segments of one room -> ordered polygon (chain endpoints; fall back to hull).
function wallsToPoly(walls) {
  if (!walls.length) return [];
  const pts = walls.map((w) => w.a);
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  return pts.sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
}

// ---------------------------------------------------------------- nameplates (OCR text)
// A rule-based extractor standing in for "OCR + small language model".
const KIND_WORDS = [
  ['pump', /PUMP/], ['chiller', /CHILLER/], ['ahu', /AIR HANDLING|AHU/], ['battery', /BATTERY|BESS|ENERGY STORAGE/],
  ['ev-charger', /EV CHARG|CHARGING STATION|EVSE/], ['inverter', /INVERTER/], ['motor', /MOTOR/], ['transformer', /TRANSFORMER/],
];
export function parseNameplate(text) {
  const T = text.toUpperCase();
  const num = (re) => { const m = re.exec(T); return m ? parseFloat(m[1]) : null; };
  let kW = num(/(?:RATED|INPUT|OUTPUT|POWER)[^\n]*?([\d.]+)\s*KW\b/) ?? num(/([\d.]+)\s*KW\b(?!H)/);
  const hp = num(/([\d.]+)\s*HP\b/);
  const kva = num(/([\d.]+)\s*KVA\b/);
  let basis = 'kW on plate';
  if (kW == null && hp != null) { kW = +(hp * 0.746).toFixed(1); basis = 'converted from HP'; }
  if (kW == null && kva != null) { kW = +(kva * 0.8).toFixed(1); basis = 'kVA x 0.8 pf'; }
  const kWh = num(/([\d.]+)\s*KWH\b/);
  const volts = num(/([\d.]+)\s*V(?:DC|AC)?\b/);
  const amps = num(/([\d.]+)\s*A\b/);
  const model = (/(?:MODEL|TYPE)\s*[:.]?\s*([A-Z0-9][A-Z0-9+\-/.]+)/.exec(T) || [])[1] || null;
  const serial = (/SR\.?\s*NO\.?\s*[:.]?\s*([A-Z0-9]+)/.exec(T) || [])[1] || null;
  const make = text.split('\n')[0].trim();
  const kind = (KIND_WORDS.find(([, re]) => re.test(T)) || ['unknown'])[0];
  const fields = [kW, model, make, kind !== 'unknown'].filter(Boolean).length;
  return { make, model, serial, kind, kW, kWh, volts, amps, basis, confidence: +(0.55 + fields * 0.1).toFixed(2) };
}

// ---------------------------------------------------------------- single-line diagram (OCR text)
export function parseSLD(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /(DB-[A-Z0-9-]+)\s+(C\d+)\s+(\d+)A\b.*?->\s*([A-Z0-9-]+)\s+(.+)$/i.exec(line.trim());
    if (m) out.push({ panel: m[1].toUpperCase(), breaker: m[2].toUpperCase(), ratingA: +m[3], roomId: m[4].toUpperCase(), what: m[5].trim() });
  }
  return out;
}

export { makeProjection };
