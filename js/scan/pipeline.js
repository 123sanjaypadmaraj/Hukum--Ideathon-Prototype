// HUKUM Scan pipeline: six stages that turn raw sources into facts, align
// every drawing and scan into one real-world frame, and fuse the result.
// Frames used:
//   E  local east/north metres around the site point (footprint, Solar API)
//   B  building frame in metres, y up (CAD drawing after unit scaling)
//   P  phone frame (RoomPlan), arbitrary rotation/offset
// T.bToE (ICP: drawing outline -> footprint) and T.pToB (ICP: scan -> drawing)
// put every room into E.
import { ROOMS, ROOM_BY_ID, CAMERAS, FLOORS } from '../building.js';
import { createState } from '../state.js';
import {
  makeProjection, polyArea, centroid, pointInPoly, polyCover, icp, refineICP, fitSimilarity,
  applyT, composeT, IDENTITY, resample, fitHomography, applyH, mulberry32, gauss, bbox,
} from './geom.js';
import {
  parseCSV, parseSolarInsights, parseOpenBuildings, parseOverpass, parseDXF, parseIFC,
  parsePlanRecognition, parseRoomPlan, parseNameplate, parseSLD,
} from './parsers.js';
import { disaggregate, matchToNameplates } from './nilm.js';
import { createFactStore, fuse, summarize, fmtValue } from './facts.js';
import { sampleCctvCounts, samplePeopleInRoom, BUILDING_H } from './samples.js';

const ID_RE = /^[A-Z]{2,6}(?:-[A-Z0-9]+)+$/;

export function createScan(site) {
  return {
    site: { ...site },
    proj: makeProjection(site.lat, site.lon),
    inputs: {},          // name -> { origin: 'sample'|'file'|'live', label, data, meta }
    results: {},
    T: { bToE: null, pToB: null, planToB: null },
    store: createFactStore(),
    log: [],
    fused: { resolved: [], review: [] },
  };
}

export function setSite(scan, site) {
  scan.site = { ...scan.site, ...site };
  scan.proj = makeProjection(scan.site.lat, scan.site.lon);
}

function log(scan, stage, text, level = 'info') {
  scan.log.push({ at: new Date(), stage, text, level });
}

// ---------------------------------------------------------------- stage 1: outside
export function runOutside(scan) {
  const S = scan.store, R = scan.results;
  for (const s of ['solar-api', 'open-buildings', 'osm', 'irradiance']) S.clearSource(s);
  R.solar = R.footprint = R.osm = null;

  const ob = scan.inputs.openBuildings;
  if (ob) {
    const b = parseOpenBuildings(ob.data, scan.proj, scan.site);
    R.footprint = { poly: b.poly, source: 'open-buildings', heightM: b.heightM, confidence: b.confidence };
    const conf = Math.min(0.92, 0.95 * b.confidence + 0.1);
    S.add('MB', 'footprint_area_m2', +polyArea(b.poly).toFixed(1), 'open-buildings', conf, `Polygon from Open Buildings (row confidence ${b.confidence}).`);
    if (b.heightM) {
      S.add('MB', 'height_m', b.heightM, 'open-buildings', 0.7, 'Open Buildings 2.5D height.');
      const storeys = Math.max(1, Math.floor(b.heightM / 3.5));
      S.add('MB', 'floors', storeys, 'open-buildings', 0.55, `${b.heightM} m / ~3.5 m per storey.`);
    }
    log(scan, 1, `Open Buildings outline: ${b.poly.length} vertices, ${polyArea(b.poly).toFixed(0)} m2, height ${b.heightM ?? '?'} m`);
  }

  const osm = scan.inputs.osm;
  if (osm) {
    const o = parseOverpass(osm.data, scan.proj);
    R.osm = o;
    const near = o.buildings.slice().sort((a, b) => Math.hypot(...centroid(a.poly)) - Math.hypot(...centroid(b.poly)))[0];
    if (near) {
      if (near.name) S.add('MB', 'name', near.name, 'osm', 0.7, 'OpenStreetMap building tag.');
      if (near.levels) S.add('MB', 'floors', near.levels, 'osm', 0.6, 'OSM building:levels.');
      if (!R.footprint) R.footprint = { poly: near.poly, source: 'osm' };
    }
    if (o.campus) S.add('SITE', 'name', o.campus.name, 'osm', 0.8, 'OSM campus boundary.');
    log(scan, 1, `OpenStreetMap: ${o.buildings.length} building(s)${o.campus ? `, campus "${o.campus.name}"` : ''}, ${o.roads.length} road(s)`);
  }

  const sol = scan.inputs.solar;
  if (sol) {
    const s = parseSolarInsights(sol.data, scan.proj);
    R.solar = s;
    const q = { HIGH: 0.9, MEDIUM: 0.8, LOW: 0.65 }[s.quality] ?? 0.6;
    S.add('MB', 'roof_area_m2', +s.roofArea.toFixed(0), 'solar-api', q, `Imagery ${s.quality}, ${s.imageryDate || 'date unknown'}.`);
    S.add('MB', 'roof_kwp', +s.maxKWp.toFixed(1), 'solar-api', q, `${s.maxPanels} panels x ${s.panelWatts} W.`);
    if (s.yearlyDcKWh) S.add('MB', 'yearly_kwh', Math.round(s.yearlyDcKWh * 0.85), 'solar-api', q - 0.05, 'DC yield x 0.85 inverter and wiring losses.');
    s.segments.forEach((g) => {
      S.add(`MB-ROOF-${g.index + 1}`, 'pitch_deg', g.pitch, 'solar-api', q);
      S.add(`MB-ROOF-${g.index + 1}`, 'azimuth_deg', g.azimuth, 'solar-api', q);
      S.add(`MB-ROOF-${g.index + 1}`, 'area_m2', +(g.area || 0).toFixed(1), 'solar-api', q);
    });
    if (!R.footprint && s.segments.length) R.footprint = { poly: s.segments[0].rect, source: 'solar-api' };
    log(scan, 1, `Solar API: ${s.segments.length} roof segment(s), up to ${s.maxPanels} panels = ${s.maxKWp.toFixed(0)} kWp (${s.quality})`);
  }

  // Irradiance + simple PVWatts-style yield as an independent check.
  const ir = scan.inputs.irradiance?.data || { ghiKWhPerDay: 5.35, source: 'Bengaluru climatology (NASA POWER long-term mean)' };
  R.irradiance = ir;
  let kwp = R.solar?.maxKWp, kwpSource = 'Solar API panel layout';
  if (!kwp && R.footprint) {
    // No Solar API coverage: 60% of the roof usable, 1.96 m2 per 400 W panel.
    kwp = (polyArea(R.footprint.poly) * 0.6) / 1.964 * 0.4;
    kwpSource = 'footprint x 60% usable';
    S.add('MB', 'roof_kwp', +kwp.toFixed(1), 'irradiance', 0.5, 'Estimated from the footprint because the Solar API returned nothing for this site.');
  }
  if (kwp) {
    const pr = 0.78, tilt = 1.0;
    const yearly = Math.round(kwp * ir.ghiKWhPerDay * 365 * pr * tilt);
    R.pvwatts = { kwp, yearly, pr, ghi: ir.ghiKWhPerDay, kwpSource };
    S.add('MB', 'yearly_kwh', yearly, 'irradiance', 0.7, `${kwp.toFixed(0)} kWp x ${ir.ghiKWhPerDay.toFixed(2)} kWh/m2/day x 365 x PR ${pr} (${ir.source}).`);
    log(scan, 1, `Yield check: ${kwp.toFixed(0)} kWp x ${ir.ghiKWhPerDay.toFixed(2)} kWh/m2/day -> ${yearly.toLocaleString('en-IN')} kWh/yr`);
  }
}

// ---------------------------------------------------------------- stage 2: blueprints
export function runBlueprints(scan) {
  const S = scan.store, R = scan.results;
  for (const s of ['dxf', 'ifc', 'plan-ocr', 'sld-ocr']) S.clearSource(s);
  R.blueprint = R.ifc = R.plan = R.sld = null;
  scan.T.bToE = null;
  const floorsSeen = new Set();

  const dx = scan.inputs.dxf;
  if (dx) {
    const floor = dx.meta?.floor || 'MB-1';
    const d = parseDXF(dx.data);
    let k = d.scaleToM;
    const closed = d.polylines.filter((p) => p.closed || p.pts.length > 3);
    const outerCand = closed.filter((p) => /WALL-EXT|OUTLINE|EXTERIOR|A-WALL/i.test(p.layer));
    const outline = (outerCand.length ? outerCand : closed).slice().sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0];
    if (!k && outline && R.footprint) k = Math.sqrt(polyArea(R.footprint.poly) / polyArea(outline.pts));   // infer units
    k = k || 1;
    const sc = (p) => [p[0] * k, p[1] * k];
    const roomPolys = closed.filter((p) => p !== outline && /AREA|ROOM|SPACE/i.test(p.layer)).map((p) => p.pts.map(sc));
    const texts = d.texts.map((t) => ({ ...t, p: sc(t.p) }));
    const rooms = roomPolys.map((poly) => {
      const inside = texts.filter((t) => pointInPoly(t.p, poly));
      const idT = inside.find((t) => ID_RE.test(t.text.toUpperCase()) && !/^DB-/i.test(t.text));
      const nameT = inside.find((t) => /NAME/i.test(t.layer)) || inside.find((t) => t !== idT && !/CIRC|^DB-/i.test(t.layer + t.text));
      const lights = d.circles.filter((c) => /LITE|LIGHT/i.test(c.layer) && pointInPoly(sc(c.c), poly)).length;
      const circuits = inside.filter((t) => /^DB-[A-Z0-9-]+\/C\d+$/i.test(t.text)).map((t) => t.text.toUpperCase());
      return { id: idT ? idT.text.toUpperCase() : null, name: nameT?.text || null, poly, area: polyArea(poly), lights, circuits };
    }).filter((r) => r.id);
    R.blueprint = { floor, outline: outline ? outline.pts.map(sc) : null, rooms, units: d.units, scale: k };
    floorsSeen.add(floor);
    for (const r of rooms) {
      S.add(r.id, 'exists', true, 'dxf', 0.8, `Closed room boundary on the ${floor} drawing.`);
      S.add(r.id, 'on_floor', floor, 'dxf', 0.85);
      S.add(r.id, 'area_m2', +r.area.toFixed(1), 'dxf', 0.8);
      if (r.name) S.add(r.id, 'name', r.name, 'dxf', 0.8);
      if (r.lights) S.add(r.id, 'light_fittings', r.lights, 'dxf', 0.75);
      for (const c of r.circuits) S.add(c, 'feeds', r.id, 'dxf', 0.75, `Tag ${c} drawn inside ${r.id} on the lighting layout.`);
    }
    log(scan, 2, `DXF ${floor}: units ${d.units ?? '?'} (x${k}), ${rooms.length} rooms, ${rooms.reduce((a, r) => a + r.circuits.length, 0)} circuit tags, ${d.circles.length} light fittings`);

    // Auto-alignment: drawing outline -> real footprint.
    if (outline && R.footprint) {
      const fit = icp(outline.pts.map(sc), R.footprint.poly, { allowScale: true });
      scan.T.bToE = fit.T;
      R.align = { ...fit, scaleErr: Math.abs(fit.T.s - 1) };
      const conf = fit.rms < 0.6 ? 0.95 : fit.rms < 1.5 ? 0.8 : 0.5;
      S.add(`${floor}-DRAWING`, 'georeference_rms_m', +fit.rms.toFixed(2), 'align', conf,
        `ICP: rotate ${((fit.T.th * 180) / Math.PI).toFixed(1)} deg, scale ${fit.T.s.toFixed(3)}, ${fit.iterations} iterations.`);
      log(scan, 6, `ICP drawing -> footprint: rotation ${((fit.T.th * 180) / Math.PI).toFixed(1)} deg, scale ${fit.T.s.toFixed(3)}, RMS ${fit.rms.toFixed(2)} m`);
    }
  }

  const ifc = scan.inputs.ifc;
  if (ifc) {
    const r = parseIFC(ifc.data);
    const lvl = r.storeys[0]?.name || '';
    const n = (/(\d+)/.exec(lvl) || [])[1];
    const floor = ifc.meta?.floor || (n != null ? `MB-${n === '0' ? 'G' : n}` : 'MB-?');
    R.ifc = { ...r, floor };
    floorsSeen.add(floor);
    for (const s of r.spaces) {
      const id = (s.name || '').toUpperCase();
      if (!id) continue;
      S.add(id, 'exists', true, 'ifc', 0.85, `IfcSpace in ${r.building || 'building'} / ${lvl}.`);
      S.add(id, 'on_floor', floor, 'ifc', 0.85);
      if (s.longName) S.add(id, 'name', s.longName, 'ifc', 0.85);
      if (s.area) S.add(id, 'area_m2', s.area, 'ifc', 0.85);
    }
    log(scan, 2, `IFC: ${r.spaces.length} spaces on ${lvl || 'unknown storey'} (${floor})`);
  }

  const pl = scan.inputs.plan;
  if (pl) {
    const floor = pl.meta?.floor || 'MB-G';
    const known = ROOMS.map((r) => r.id);
    const rooms = parsePlanRecognition(pl.data, known);
    // The scan is north-up with a detected scale bar, so only a translation
    // is needed to sit it in the building frame.
    const bb = bbox(rooms.flatMap((r) => r.poly));
    scan.T.planToB = { s: 1, th: 0, tx: 1 - bb.x0, ty: 1 - bb.y0 };
    R.plan = { floor, rooms: rooms.map((r) => ({ ...r, poly: r.poly.map((p) => applyT(scan.T.planToB, p)) })) };
    floorsSeen.add(floor);
    for (const r of R.plan.rooms) {
      const c = +Math.min(0.9, r.segScore * 0.5 + r.ocrScore * 0.45).toFixed(2);
      S.add(r.id, 'exists', true, 'plan-ocr', c, `Segmented on the scanned plan (${r.segScore}), label OCR ${r.ocrScore}.`);
      S.add(r.id, 'on_floor', floor, 'plan-ocr', c);
      S.add(r.id, 'area_m2', +polyArea(r.poly).toFixed(1), 'plan-ocr', c - 0.05);
      if (r.fixed) S.add(r.id, 'label', r.fixed, 'plan-ocr', 0.55, `OCR read "${r.raw}"; closest id in the campus room register is ${r.fixed} (${r.editDistance} character changed).`);
    }
    log(scan, 2, `Scanned plan ${floor}: ${rooms.length} rooms recognised, ${rooms.filter((r) => r.fixed).length} OCR label(s) corrected`);
  }

  const sld = scan.inputs.sld;
  if (sld) {
    const rows = parseSLD(sld.data);
    R.sld = rows;
    for (const r of rows) S.add(`${r.panel}/${r.breaker}`, 'feeds', r.roomId, 'sld-ocr', 0.8, `SLD line: ${r.breaker} ${r.ratingA}A -> ${r.roomId} ${r.what}.`);
    log(scan, 2, `Single-line diagram: ${rows.length} circuits read`);
  }

  // Storey count from the drawings we have (G, 1, 2 + roof).
  if (floorsSeen.size) S.add('MB', 'floors', floorsSeen.size, 'dxf', 0.65, `Drawings found for ${[...floorsSeen].sort().join(', ')}.`);
}

// ---------------------------------------------------------------- stage 3: walkthrough
export function runWalkthrough(scan) {
  const S = scan.store, R = scan.results;
  for (const s of ['roomplan', 'nameplate']) S.clearSource(s);
  R.scan = R.plates = null;
  scan.T.pToB = null;

  const rp = scan.inputs.roomplan;
  if (rp) {
    const rooms = parseRoomPlan(rp.data);
    const bp = R.blueprint;
    let T = IDENTITY, rms = null;
    if (bp) {
      // Coarse: rooms the scanner named, matched by centroid. Fine: ICP on wall points.
      const pairs = rooms.map((r) => [r, bp.rooms.find((b) => b.id === String(r.name).toUpperCase())]).filter(([, b]) => b);
      if (pairs.length >= 2) T = fitSimilarity(pairs.map(([r]) => centroid(r.poly)), pairs.map(([, b]) => centroid(b.poly)), false);
      else {
        const all = rooms.flatMap((r) => r.poly);
        const hull = [[bbox(all).x0, bbox(all).y0], [bbox(all).x1, bbox(all).y0], [bbox(all).x1, bbox(all).y1], [bbox(all).x0, bbox(all).y1]];
        T = icp(hull, bp.outline || bp.rooms[0].poly, { allowScale: false }).T;
      }
      const src = rooms.flatMap((r) => resample(r.poly, 0.5));
      const dst = bp.rooms.flatMap((b) => resample(b.poly, 0.5));
      ({ T, rms } = refineICP(src, dst, T, { allowScale: false }));
      scan.T.pToB = T;
      S.add('MB-1-WALKTHROUGH', 'registration_rms_m', +rms.toFixed(2), 'align', rms < 0.3 ? 0.95 : 0.75, `Scan -> drawing ICP, rotation ${((T.th * 180) / Math.PI).toFixed(1)} deg.`);
      log(scan, 6, `ICP interior scan -> drawing: rotation ${((T.th * 180) / Math.PI).toFixed(1)} deg, RMS ${rms.toFixed(2)} m`);
    }
    const placed = rooms.map((r) => ({ ...r, polyB: r.poly.map((p) => applyT(T, p)) }));
    R.scan = { floor: bp?.floor || 'MB-1', rooms: placed, rms };
    for (const r of placed) {
      const conf = +(0.8 + 0.12 * r.highConf).toFixed(2);
      const covered = bp ? bp.rooms.filter((b) => polyCover(b.poly, r.polyB) > 0.8) : [];
      const named = String(r.name).toUpperCase();
      const main = covered.find((b) => b.id === named) || covered.slice().sort((a, b) => b.area - a.area)[0];
      const id = main?.id || named;
      r.matched = id;
      S.add(id, 'exists', true, 'roomplan', conf, `Walked and scanned (${r.walls.length} walls, ${r.doors} door).`);
      if (covered.length <= 1) S.add(id, 'area_m2', +polyArea(r.polyB).toFixed(1), 'roomplan', conf);
      if (r.chairs) S.add(id, 'seats', r.chairs, 'roomplan', 0.75, `${r.chairs} chairs and ${r.tables} tables detected.`);
      for (const other of covered) {
        if (other.id === id) continue;
        S.add(other.id, 'exists', false, 'roomplan', conf,
          `The interior scan found one open room (${polyArea(r.polyB).toFixed(0)} m2) covering ${id} and ${other.id}, with no wall between them.`);
      }
    }
    log(scan, 3, `RoomPlan: ${rooms.length} rooms, ${rooms.reduce((a, r) => a + r.walls.length, 0)} walls, ${rooms.reduce((a, r) => a + r.objects.length, 0)} objects`);
  }

  const np = scan.inputs.nameplates;
  if (np) {
    const plates = np.data.map((p) => ({ ...p, ...parseNameplate(p.text) }));
    R.plates = plates;
    for (const p of plates) {
      S.add(p.tag, 'kind', p.kind, 'nameplate', p.confidence);
      if (p.kW != null) S.add(p.tag, 'rated_kw', p.kW, 'nameplate', p.confidence, `${p.photo}: ${p.basis}.`);
      if (p.kWh != null) S.add(p.tag, 'capacity_kwh', p.kWh, 'nameplate', p.confidence);
      if (p.model) S.add(p.tag, 'model', p.model, 'nameplate', p.confidence);
      if (p.make) S.add(p.tag, 'make', p.make, 'nameplate', p.confidence);
      if (p.room) S.add(p.tag, 'located_in', p.room, 'nameplate', 0.9, 'Room chosen during the interior scan.');
    }
    log(scan, 3, `Nameplates: ${plates.length} photos read (${plates.map((p) => `${p.tag} ${p.kW ?? '?'} kW`).join(', ')})`);
  }
}

// ---------------------------------------------------------------- stage 4: CCTV -> rooms
// For each room camera on the scanned floor: propose floor points visible in
// the frame (here: projected from the camera pose, with detector noise),
// fit image -> plan homography, then map YOLO foot points into room ids.
let renderMod = null;
export async function loadRender() {
  if (!renderMod) {
    const [render, scenes] = await Promise.all([import('../cctv/render.js'), import('../cctv/scenes.js')]);
    renderMod = { ...render, ...scenes };
  }
  return renderMod;
}

export function calibrateCamera(cam, W = 960, H = 540, seed = 1, people = null) {
  const { makeView, project, buildScene } = renderMod;
  const room = ROOM_BY_ID[cam.roomId];
  const st = createState();
  const scene = buildScene(cam, st);
  const v = makeView(cam, W, H, scene);
  const rand = mulberry32(seed);
  // Candidate floor points: corners, wall midpoints, door jambs, inset grid.
  const cands = [];
  const { x, y, w, h } = room;
  for (const [px, py, kind] of [[x, y, 'corner'], [x + w, y, 'corner'], [x + w, y + h, 'corner'], [x, y + h, 'corner'],
    [x + w / 2, y, 'wall'], [x + w, y + h / 2, 'wall'], [x + w / 2, y + h, 'wall'], [x, y + h / 2, 'wall'], ...room.doors.map((d) => [d.x + 0.5, room.top ? y + h : y, 'door'])]) {
    const s = project(v, px, py, 0);
    if (s && s[0] > 8 && s[0] < W - 8 && s[1] > 8 && s[1] < H - 8) cands.push({ img: [s[0] + gauss(rand) * 2.5, s[1] + gauss(rand) * 2.5], plan: [px, py], kind });
  }
  const pts = cands.slice(0, 8);
  if (pts.length < 4) return { cam, ok: false, reason: 'fewer than 4 floor points visible' };
  const Hm = fitHomography(pts.map((p) => p.img), pts.map((p) => p.plan));
  // Check on points not used for the fit: a grid inside the room.
  let err = 0, n = 0;
  for (let i = 1; i < 4; i++) for (let j = 1; j < 4; j++) {
    const P = [x + (w * i) / 4, y + (h * j) / 4];
    const s = project(v, P[0], P[1], 0);
    if (!s) continue;
    const back = applyH(Hm, s);
    err += Math.hypot(back[0] - P[0], back[1] - P[1]); n++;
  }
  const meanErrM = n ? err / n : null;
  // Map detections (feet) to rooms.
  const crowd = people || samplePeopleInRoom(room.id, room.type === 'office' ? 7 : 24, seed + 5);
  const dets = [];
  for (const p of crowd) {
    const s = project(v, p.x, p.y, 0);
    if (!s || s[0] < 0 || s[0] > W || s[1] < 0 || s[1] > H) continue;
    const foot = [s[0] + gauss(rand) * 3, s[1] + gauss(rand) * 3];
    const q = applyH(Hm, foot);
    const hit = FLOORS[room.floor].rooms.find((r) => q[0] >= r.x && q[0] < r.x + r.w && q[1] >= r.y && q[1] < r.y + r.h);
    dets.push({ personId: p.id, img: foot, plan: q, roomId: hit?.id || null, truth: p.roomId });
  }
  const correct = dets.filter((d) => d.roomId === d.truth).length;
  return { cam, ok: true, points: pts, H: Hm, meanErrM, detections: dets, accuracy: dets.length ? correct / dets.length : null, people: crowd, view: v };
}

export async function runCctv(scan) {
  const S = scan.store, R = scan.results;
  S.clearSource('cctv');
  await loadRender();
  const floor = R.blueprint?.floor || 'MB-1';
  const fl = FLOORS.find((f) => f.short === floor);
  const cams = CAMERAS.filter((c) => c.kind === 'room' && fl && c.floor === fl.level);
  R.cctv = cams.map((c, i) => calibrateCamera(c, 960, 540, 100 + i));
  for (const c of R.cctv) {
    if (!c.ok) continue;
    const conf = +Math.max(0.4, 0.6 + 0.3 * (c.accuracy ?? 0) - 0.1 * Math.max(0, c.meanErrM - 0.5)).toFixed(2);
    S.add(c.cam.id, 'observes', c.cam.roomId, 'cctv', conf,
      `Homography from ${c.points.length} floor points, mean error ${c.meanErrM.toFixed(2)} m; ${Math.round((c.accuracy ?? 0) * 100)}% of detections land in ${c.cam.roomId}.`);
  }
  // People counts from the SEE engine for the occupancy cross-check.
  const counts = scan.inputs.cctvCounts?.data || sampleCctvCounts();
  R.cctvCounts = counts;
  for (const [camId, series] of Object.entries(counts)) {
    const roomId = camId.replace(/^CAM-/, '');
    const peak = Math.max(0, ...series.map((s) => s.count));
    S.add(roomId, 'peak_occupancy', peak, 'cctv', 0.85, peak === 0 ? `${camId} counted nobody all day.` : `${camId} YOLO peak count.`);
  }
  log(scan, 4, `CCTV: ${R.cctv.filter((c) => c.ok).length}/${cams.length} cameras on ${floor} mapped to the plan, mean floor error ${avg(R.cctv.filter((c) => c.ok).map((c) => c.meanErrM)).toFixed(2)} m`);
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---------------------------------------------------------------- stage 5: electricity + occupancy
export function runElectricity(scan) {
  const S = scan.store, R = scan.results;
  for (const s of ['nilm', 'wifi', 'timetable']) S.clearSource(s);
  R.nilm = R.wifi = R.timetable = null;
  R.cross = [];
  const hhmm = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const ttRows = scan.inputs.timetable ? parseCSV(scan.inputs.timetable.data) : [];

  const me = scan.inputs.meter;
  if (me) {
    const rows = parseCSV(me.data);
    const kcol = Object.keys(rows[0] || {}).find((k) => /kw|power|load/i.test(k));
    const tcol = Object.keys(rows[0] || {}).find((k) => /time|date/i.test(k));
    const series = rows.map((r) => ({ label: (r[tcol] || '').slice(-5), kW: +r[kcol] })).filter((r) => Number.isFinite(r.kW));
    const d = disaggregate(series);
    // Steps that line up with class start/end times are room circuits being
    // switched by HUKUM's relays (or the old manual routine), not plant.
    const bells = new Set();
    for (const r of ttRows) for (const t of [hhmm(r.start), hhmm(r.end)]) if (t != null) for (let k = -12; k <= 12; k++) bells.add(t + k);
    for (const a of d.appliances) {
      const mins = a.starts.map(hhmm).filter((x) => x != null);
      a.roomCircuits = bells.size > 0 && mins.length > 0 && mins.every((x) => bells.has(x));
    }
    const plant = d.appliances.filter((a) => !a.roomCircuits);
    const plates = R.plates || [];
    const m = matchToNameplates(plant, plates);
    R.nilm = { series, ...d, ...m };
    for (const a of d.appliances) {
      S.add(a.id, 'running_kw', a.kW, 'nilm', a.quality, `${a.runs} on/off cycles, ~${a.meanMinutes} min each, starts ${a.starts.slice(0, 4).join(', ')}.`);
      if (a.roomCircuits) S.add(a.id, 'identified_as', 'classroom circuits (timetable-aligned)', 'nilm', 0.75, 'Every start lines up with a class bell in the timetable.');
    }
    for (const x of m.matches) {
      if (!x.appliance) continue;
      const ok = x.ratio >= 0.7 && x.ratio <= 1.15;
      if (ok) {
        const tag = x.ambiguous ? x.tags.join(' or ') : x.tags[0];
        S.add(x.appliance.id, 'identified_as', tag, 'nilm', x.appliance.quality, `${x.appliance.kW} kW step vs ${x.rated} kW nameplate (${Math.round(x.ratio * 100)}%).`);
        continue;
      }
      const key = `nilm:${x.appliance.id}`;
      const opts = x.tags.map((t) => ({ id: t, label: `It is ${t}: use ${x.appliance.kW} kW as its real draw`, value: t }));
      opts.push({ id: 'tech', label: 'Not sure: send a technician, keep nameplate', value: 'technician' });
      R.cross.push({
        key, subject: x.tags.join(' / '), predicate: 'rated_kw',
        title: `Nameplate says ${x.rated} kW, the meter sees ${x.appliance.kW} kW`,
        detail: `${x.tags.join(' and ')} ${x.tags.length > 1 ? 'have identical' : 'has a'} ${x.rated} kW nameplate${x.tags.length > 1 ? 's' : ''}. NILM on the Main Block meter found a ${x.appliance.kW} kW load (${Math.round(x.ratio * 100)}% of rated) running ${x.appliance.runs} times, at ${x.appliance.starts.join(', ')}. ${x.tags.length > 1 ? 'One meter cannot tell identical pumps apart. ' : ''}A throttled valve, a worn impeller or a wrong plate are all possible. HUKUM bids flexibility on real draw, so this changes how much it can shift.`,
        options: opts,
        apply: (dec) => (dec.value && dec.value !== 'technician' ? [{ subject: dec.value, predicate: 'running_kw', value: x.appliance.kW }] : [{ subject: x.tags.join(' / '), predicate: 'site_visit', value: 'requested' }]),
      });
    }
    log(scan, 5, `NILM: ${d.events} step events, ${d.paired} on/off pairs, ${d.appliances.length} appliance clusters (${d.appliances.map((a) => `${a.kW} kW x${a.runs}`).join(', ')})`);
  }

  const wf = scan.inputs.wifi;
  if (wf) {
    const rows = parseCSV(wf.data);
    const per = {};
    for (const r of rows) {
      const room = (r.ap_name || r.ap || '').replace(/^AP-/i, '').toUpperCase();
      const n = +r.clients;
      if (!room || !Number.isFinite(n)) continue;
      (per[room] ||= []).push({ t: r.time, people: n / 1.45 });
    }
    R.wifi = per;
    for (const [room, s] of Object.entries(per)) {
      const peak = Math.round(Math.max(...s.map((x) => x.people)));
      S.add(room, 'peak_occupancy', peak, 'wifi', 0.6, `Peak Wi-Fi clients / 1.45 devices per person on AP-${room}.`);
    }
    log(scan, 5, `Wi-Fi: ${rows.length} rows across ${Object.keys(per).length} access points`);
  }

  if (ttRows.length) {
    const rows = ttRows;
    R.timetable = rows;
    const rooms = [...new Set(rows.map((r) => r.room.toUpperCase()))];
    const known = new Set(scan.store.facts.filter((f) => f.predicate === 'exists' && f.value === true && f.source !== 'timetable').map((f) => f.subject));
    for (const room of rooms) {
      const n = rows.filter((r) => r.room.toUpperCase() === room).length;
      S.add(room, 'timetabled_sessions', n, 'timetable', 0.8);
      if (!known.has(room)) {
        const num = (s) => +((/(\d+)$/.exec(s) || [])[1] ?? NaN);
        const near = [...known].filter((k) => k.split('-')[0] === room.split('-')[0] && Number.isFinite(num(k)))
          .sort((a, b) => Math.abs(num(a) - num(room)) - Math.abs(num(b) - num(room)))[0];
        S.add(room, 'exists', true, 'timetable', 0.5, `Booked ${n} time(s) in the timetable, but no drawing, scan or camera has it${near ? `; the nearest known room is ${near}` : ''}. New room, or a typo?`);
      }
    }
    log(scan, 5, `Timetable: ${rows.length} sessions in ${rooms.length} rooms`);
  }
}

// ---------------------------------------------------------------- stage 6: fuse
export function runFuse(scan) {
  scan.fused = fuse(scan.store, scan.results.cross || []);
  scan.summary = summarize(scan.fused);
  log(scan, 6, `Fused ${scan.store.facts.length} facts into ${scan.summary.total} statements: ${scan.summary.auto} accepted automatically, ${scan.summary.open} waiting for a person`);
  return scan.fused;
}

export async function runAll(scan, onStage = () => {}) {
  const stages = [
    [1, 'Outside: footprint, roof, solar', runOutside],
    [2, 'Inside: blueprints, BIM, plans, SLD', runBlueprints],
    [3, 'Interior scan + nameplates', runWalkthrough],
    [4, 'CCTV to rooms', runCctv],
    [5, 'Electricity and occupancy', runElectricity],
    [6, 'Align, fuse, review', runFuse],
  ];
  for (const [n, name, fn] of stages) {
    onStage(n, name, 'running');
    try { await fn(scan); onStage(n, name, 'done'); }
    catch (err) { log(scan, n, `${name} failed: ${err.message}`, 'error'); onStage(n, name, 'error', err); console.error(err); }
  }
  return scan;
}

// Helpers used by the UI and export.
export function bToE(scan, p) { return scan.T.bToE ? applyT(scan.T.bToE, p) : p; }
export function tilesToB(p) { return [p[0], BUILDING_H - p[1]]; }
export { fmtValue, composeT };
