// Run the in-browser HUKUM Scan pipeline in Node with every sample input and
// write the fused building model to agents/data/scan_model.json, which the
// Python Mapping Agent reads offline.
//
//   node agents/tools/export_scan.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);

const SM = await imp('js/scan/samples.js');
const P = await imp('js/scan/pipeline.js');
const B = await imp('js/scan/brick.js');
const G = await imp('js/scan/geom.js');
const BLD = await imp('js/building.js');

const site = SM.SITE_DEFAULT;
const scan = P.createScan(site);
const inputs = {
  solar: [SM.sampleSolarInsights(site)],
  openBuildings: [SM.sampleOpenBuildingsCSV(site)],
  osm: [SM.sampleOsmJSON(site)],
  irradiance: [{ ghiKWhPerDay: 5.35, source: 'Bengaluru long-term mean (NASA POWER)' }],
  dxf: [SM.sampleDXF(), { floor: 'MB-1' }],
  ifc: [SM.sampleIFC()],
  plan: [SM.samplePlanRecognition(), { floor: 'MB-G' }],
  sld: [SM.sampleSLDText()],
  roomplan: [SM.sampleRoomPlan()],
  nameplates: [SM.sampleNameplates()],
  cctvCounts: [SM.sampleCctvCounts()],
  meter: [SM.sampleMeterCSV()],
  wifi: [SM.sampleWifiCSV()],
  timetable: [SM.sampleTimetableCSV()],
};
for (const [k, [data, meta]] of Object.entries(inputs)) scan.inputs[k] = { origin: 'sample', label: 'sample', data, meta };

const origErr = console.error;
const errors = [];
console.error = (...a) => errors.push(a.map(String).join(' '));
await P.runAll(scan);
console.error = origErr;

const model = B.buildModel(scan);
const R = scan.results;
const sol = R.solar || {};
const round = (x, d = 2) => (typeof x === 'number' ? +x.toFixed(d) : x ?? null);

const sourceCounts = {};
for (const f of scan.store.facts) sourceCounts[f.source] = (sourceCounts[f.source] || 0) + 1;

const review = scan.fused.review.filter((r) => !r.decided).map((r) => ({
  key: r.key, kind: r.kind || 'review', title: r.title, detail: r.detail,
  options: (r.options || []).map((o) => o.label),
}));

const planted = [
  { code: 'STORE_WALL', text: 'The old blueprint still shows a store room (CSE-STORE) whose wall the phone walkthrough does not find.' },
  { code: 'CIRCUIT_TAG', text: 'One circuit tag on the blueprint sits in a different room than the single-line diagram says.' },
  { code: 'PUMP_DERATED', text: 'A 15 kW pump nameplate, but the block meter only ever sees an 8.25 kW step (impeller trimmed or wrong nameplate).' },
  { code: 'CAMERA_BLOCKED', text: 'Wi-Fi sees a full lab while the camera counts nobody: the camera is obstructed.' },
  { code: 'GHOST_ROOM', text: 'The timetable books a room that is not in any drawing.' },
  { code: 'OCR_MISREAD', text: 'OCR on the scanned ground-floor plan misread one room label (O/0, I/1).' },
];

const out = {
  generated_by: 'agents/tools/export_scan.mjs (HUKUM Scan pipeline, all samples)',
  site,
  model: { ...model, transforms: undefined, rooms: model.rooms.map((r) => ({ ...r, type: BLD.ROOM_BY_ID[r.id]?.type || null })) },
  roof_plant: ['MB-PUMP', 'MB-AHU'].map((id) => { const r = BLD.ROOM_BY_ID[id]; return { id, name: r.name, w_m: r.w, h_m: r.h, area_m2: r.w * r.h }; }),
  solar: {
    segments: (sol.segments || []).map((s) => ({ index: s.index, pitch_deg: s.pitch, azimuth_deg: s.azimuth, area_m2: round(s.area, 1), sunshine_hours: s.sunshineMedian })),
    roofArea: round(sol.roofArea, 1), maxPanels: sol.maxPanels, panelWatts: sol.panelWatts, maxKWp: round(sol.maxKWp, 1),
    yearlyDcKWh: sol.yearlyDcKWh, sunshineHours: sol.sunshineHours, quality: sol.quality, imageryDate: sol.imageryDate,
  },
  pvwatts: R.pvwatts || null,
  irradiance: R.irradiance || null,
  footprint: R.footprint ? { area_m2: round(G.polyArea(R.footprint.poly), 1), source: R.footprint.source, height_m: R.footprint.heightM ?? null, vertices: R.footprint.poly.length } : null,
  osm: R.osm ? { buildings: R.osm.buildings.length, roads: (R.osm.roads || []).map((r) => r.name || 'road'), campus: R.osm.campus?.name || null } : null,
  align: {
    drawing_to_footprint_rms_m: round(R.align?.rms, 3),
    drawing_rotation_deg: R.align?.T ? round((R.align.T.th * 180) / Math.PI, 2) : null,
    drawing_scale: R.align?.T ? round(R.align.T.s, 4) : null,
    walkthrough_to_drawing_rms_m: round(R.scan?.rms, 3),
  },
  counts: {
    dxf_rooms: R.blueprint?.rooms?.length ?? 0, ifc_spaces: R.ifc?.spaces?.length ?? R.ifc?.rooms?.length ?? 0,
    plan_rooms: R.plan?.rooms?.length ?? 0, sld_lines: R.sld?.length ?? 0, roomplan_rooms: R.scan?.rooms?.length ?? 0,
    nameplates: R.plates?.length ?? 0, cameras: R.cctv?.length ?? 0, nilm_events: R.nilm?.events ?? 0, nilm_paired: R.nilm?.paired ?? 0,
    wifi_aps: R.wifi ? Object.keys(R.wifi).length : 0, timetable_sessions: R.timetable?.length ?? 0, cross_checks: (R.cross || []).length,
  },
  summary: scan.summary,
  review,
  planted,
  source_fact_counts: sourceCounts,
  log: scan.log.map((l) => ({ stage: l.stage, level: l.level, text: l.text })),
  errors,
};

const dest = resolve(root, 'agents', 'data', 'scan_model.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`Wrote ${dest}: ${model.rooms.length} rooms, ${model.circuits.length} circuits, ${model.equipment.length} equipment, ${review.length} open questions, ${scan.summary?.autoPct}% auto-accepted${errors.length ? `, ${errors.length} stage errors` : ''}`);
