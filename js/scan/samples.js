// Sample inputs for HUKUM Scan, generated from the twin's own building model
// (js/building.js, Main Block) so the demo runs offline. Each generator
// returns data in the same format the real source produces (Solar API JSON,
// Open Buildings CSV row, Overpass JSON, DXF text, IFC STEP text, RoomPlan
// JSON, OCR text, meter CSV ...), so the parsers are exercised for real and a
// user can swap any sample for a real file.
//
// A few disagreements are planted on purpose, because they are exactly what
// happens on a real campus and what the review queue is for:
//   - the blueprint still shows a store room (CSE-STORE) whose wall the walkthrough doesn't find;
//   - one circuit tag on the blueprint sits in the wrong room versus the single-line diagram;
//   - a 15 kW pump nameplate, but the meter only ever sees an 8.4 kW step;
//   - Wi-Fi sees a full lab where the camera counts nobody (camera obstructed);
//   - the timetable books a room that isn't in any drawing;
//   - OCR on the scanned ground-floor plan misreads one room label.
import { FLOORS, PANELS, ROOM_BY_ID } from '../building.js';
import { makeProjection, mulberry32, gauss, centroid } from './geom.js';

// Approximate location of NHCE Main Block (editable in the UI).
export const SITE_DEFAULT = { lat: 12.93385, lon: 77.69275, name: 'New Horizon College of Engineering', headingDeg: 17 };

// Building frame: metres, y up (north-ish), origin at the SW corner of the main
// rectangle. The block is 52 x 29 m with a stair tower on the NE corner.
export const BUILDING_H = 29;
export const OUTLINE_LOCAL = [[0, 0], [52, 0], [52, 32], [44, 32], [44, 29], [0, 29]];

const toUp = (r) => [[r.x, BUILDING_H - r.y - r.h], [r.x + r.w, BUILDING_H - r.y - r.h], [r.x + r.w, BUILDING_H - r.y], [r.x, BUILDING_H - r.y]];
const mbFloor = (storey) => FLOORS.find((f) => f.blockId === 'MB' && f.storey === storey);
const realRooms = (f) => f.rooms.filter((r) => r.type !== 'core' && r.type !== 'roof');

// Truth used by several generators: Main Block first floor with the
// department office split into office + store on the old drawing.
function mb1BlueprintRooms() {
  const f = mbFloor(1);
  const out = [];
  for (const r of realRooms(f)) {
    if (r.id === 'CSE-DEPT') {
      out.push({ id: 'CSE-DEPT', name: 'CSE Department & HoD', poly: toUp({ ...r, w: 6 }), type: r.type });
      out.push({ id: 'CSE-STORE', name: 'Department Store Room', poly: toUp({ ...r, x: r.x + 6, w: r.w - 6 }), type: 'office' });
    } else {
      out.push({ id: r.id, name: r.name, poly: toUp(r), type: r.type });
    }
  }
  return out;
}

function buildingToENU(site) {
  const th = (site.headingDeg * Math.PI) / 180;
  const c0 = centroid(OUTLINE_LOCAL);
  const c = Math.cos(th), s = Math.sin(th);
  return (p) => {
    const x = p[0] - c0[0], y = p[1] - c0[1];
    return [c * x - s * y, s * x + c * y];
  };
}

// ---------------------------------------------------------------- 1. outside
export function sampleSolarInsights(site = SITE_DEFAULT) {
  const proj = makeProjection(site.lat, site.lon);
  const enu = buildingToENU(site);
  const ll = (p) => { const [la, lo] = proj.toLatLon(...enu(p)); return { latitude: +la.toFixed(7), longitude: +lo.toFixed(7) }; };
  const corners = OUTLINE_LOCAL.map(enu);
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const sw = proj.toLatLon(Math.min(...xs), Math.min(...ys)), ne = proj.toLatLon(Math.max(...xs), Math.max(...ys));
  const seg = (poly, pitch, az, area, sun) => {
    const bx = poly.map(enu);
    const bxs = bx.map((p) => p[0]), bys = bx.map((p) => p[1]);
    const a = proj.toLatLon(Math.min(...bxs), Math.min(...bys)), b = proj.toLatLon(Math.max(...bxs), Math.max(...bys));
    return {
      pitchDegrees: pitch, azimuthDegrees: az,
      stats: { areaMeters2: area, sunshineQuantiles: sun, groundAreaMeters2: area * Math.cos((pitch * Math.PI) / 180) },
      center: ll(centroid(poly)),
      boundingBox: { sw: { latitude: a[0], longitude: a[1] }, ne: { latitude: b[0], longitude: b[1] } },
      planeHeightAtCenterMeters: 912.4,
    };
  };
  const sun = (k) => Array.from({ length: 11 }, (_, i) => Math.round((1150 + i * 62) * k));
  const panels = 452;
  return {
    name: 'buildings/sample-nhce-main-block',
    center: ll(centroid(OUTLINE_LOCAL)),
    imageryDate: { year: 2024, month: 2, day: 11 },
    imageryProcessedDate: { year: 2024, month: 6, day: 3 },
    regionCode: 'IN',
    imageryQuality: 'HIGH',
    boundingBox: { sw: { latitude: sw[0], longitude: sw[1] }, ne: { latitude: ne[0], longitude: ne[1] } },
    solarPotential: {
      maxArrayPanelsCount: panels,
      maxArrayAreaMeters2: +(panels * 1.879 * 1.045).toFixed(1),
      maxSunshineHoursPerYear: 1798.6,
      carbonOffsetFactorKgPerMwh: 708.9,
      panelCapacityWatts: 400, panelHeightMeters: 1.879, panelWidthMeters: 1.045, panelLifetimeYears: 20,
      wholeRoofStats: { areaMeters2: 1530.5, sunshineQuantiles: sun(1), groundAreaMeters2: 1528.2 },
      roofSegmentStats: [
        seg([[0, 0], [52, 0], [52, 29], [0, 29]], 3.1, 197, 1504.2, sun(1)),
        seg([[44, 29], [52, 29], [52, 32], [44, 32]], 2.4, 17, 24.3, sun(0.93)),
      ],
      solarPanelConfigs: [100, 200, 300, 400, panels].map((n) => ({
        panelsCount: n, yearlyEnergyDcKwh: Math.round(n * 0.4 * 1745 * (1 - (n / panels) * 0.03)),
        roofSegmentSummaries: [{ pitchDegrees: 3.1, azimuthDegrees: 197, panelsCount: n, yearlyEnergyDcKwh: Math.round(n * 0.4 * 1745 * (1 - (n / panels) * 0.03)), segmentIndex: 0 }],
      })),
    },
  };
}

export function sampleOpenBuildingsCSV(site = SITE_DEFAULT) {
  const proj = makeProjection(site.lat, site.lon);
  const enu = buildingToENU(site);
  const rand = mulberry32(7);
  // Open Buildings outlines are slightly coarse: jitter each vertex ~0.5 m.
  const pts = OUTLINE_LOCAL.map(enu).map(([x, y]) => proj.toLatLon(x + gauss(rand) * 0.45, y + gauss(rand) * 0.45));
  pts.push(pts[0]);
  const wkt = `POLYGON((${pts.map(([la, lo]) => `${lo.toFixed(7)} ${la.toFixed(7)}`).join(', ')}))`;
  const c = proj.toLatLon(0, 0);
  return [
    'latitude,longitude,area_in_meters,confidence,geometry,full_plus_code,building_height_m',
    `${c[0].toFixed(7)},${c[1].toFixed(7)},1531.8,0.8312,"${wkt}",7J4RWMMV+GW,11.6`,
  ].join('\n');
}

export function sampleOsmJSON(site = SITE_DEFAULT) {
  const proj = makeProjection(site.lat, site.lon);
  const enu = buildingToENU(site);
  const geom = (poly) => [...poly, poly[0]].map((p) => { const [lat, lon] = proj.toLatLon(...enu(p)); return { lat: +lat.toFixed(7), lon: +lon.toFixed(7) }; });
  return {
    version: 0.6, generator: 'Overpass API (sample)',
    elements: [
      { type: 'way', id: 1001, tags: { building: 'college', name: 'Main Block', 'building:levels': '3' }, geometry: geom(OUTLINE_LOCAL) },
      { type: 'way', id: 1002, tags: { amenity: 'college', name: site.name }, geometry: geom([[-60, -90], [190, -90], [190, 120], [-60, 120]]) },
      { type: 'way', id: 1003, tags: { highway: 'trunk', name: 'Outer Ring Road' }, geometry: geom([[-80, -110], [220, -110]]) },
    ],
  };
}

// ---------------------------------------------------------------- 2. blueprints
// Minimal ASCII DXF, millimetres ($INSUNITS 4), y up, axis-aligned like a real drawing.
export function sampleDXF() {
  const mm = (v) => (v * 1000).toFixed(0);
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const lw = (layer, poly) => {
    out.push('0', 'LWPOLYLINE', '8', layer, '90', String(poly.length), '70', '1');
    for (const [x, y] of poly) out.push('10', mm(x), '20', mm(y));
  };
  const text = (layer, x, y, s, hgt = 0.35) => out.push('0', 'TEXT', '8', layer, '10', mm(x), '20', mm(y), '40', mm(hgt), '1', s);
  const circle = (layer, x, y, r) => out.push('0', 'CIRCLE', '8', layer, '10', mm(x), '20', mm(y), '40', mm(r));

  lw('A-WALL-EXT', OUTLINE_LOCAL);
  const rooms = mb1BlueprintRooms();
  for (const r of rooms) {
    lw('A-AREA', r.poly);
    const [cx, cy] = centroid(r.poly);
    text('A-AREA-IDEN', cx - 1.5, cy + 0.6, r.id, 0.5);
    text('A-AREA-NAME', cx - 3, cy - 0.4, r.name, 0.3);
    // Ceiling lights, one per ~8 m2.
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1]);
    for (let x = Math.min(...xs) + 1.5; x < Math.max(...xs) - 0.5; x += 3) for (let y = Math.min(...ys) + 1.5; y < Math.max(...ys) - 0.5; y += 3) circle('E-LITE', x, y, 0.3);
  }
  // Circuit tags: "DB-MB-1/C3" written inside the room each circuit feeds.
  const panel = PANELS.find((p) => p.id === 'DB-MB-1');
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
  panel.circuits.forEach((c, i) => {
    let target = c.roomId;
    if (c.roomId === 'CSE-103' && c.kind === 'ac') target = 'CSE-104';          // drafting error on the old drawing
    const r = byId[target];
    if (!r) return;
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1]);
    text('E-CIRC', Math.min(...xs) + 0.4, Math.min(...ys) + 0.4 + (i % 3) * 0.6, `DB-MB-1/${c.breaker}`, 0.25);
  });
  text('E-DB', 49.5, BUILDING_H - 19, 'DB-MB-1', 0.4);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

// IFC (STEP) with spaces for the Main Block second floor.
export function sampleIFC() {
  const f = mbFloor(2);
  let n = 100;
  const lines = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('nhce-main-block.ifc','2023-08-14T10:20:00',('Facilities'),('NHCE'),'IFC2X3','Revit','');", "FILE_SCHEMA(('IFC2X3'));", 'ENDSEC;', 'DATA;',
    "#10=IFCBUILDING('2hQBAVPOr5VxhS3Jl0O47h',#2,'Main Block',$,$,#11,$,$,.ELEMENT.,$,$,$);",
    "#20=IFCBUILDINGSTOREY('0w984V0GL6yR4z75YWgVfX',#2,'Level 2',$,$,#21,$,$,.ELEMENT.,7200.);",
  ];
  for (const r of realRooms(f)) {
    lines.push(`#${n++}=IFCSPACE('${guid(n)}',#2,'${r.id}','${r.name}',$,#${n + 500},$,'${r.name}',.ELEMENT.,.INTERNAL.,$);`);
    lines.push(`#${n++}=IFCQUANTITYAREA('NetFloorArea',$,$,${(r.w * r.h).toFixed(1)});`);
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return lines.join('\n');
}
function guid(n) { const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'; let s = ''; let x = n * 2654435761; for (let i = 0; i < 22; i++) { s += a[x % 64]; x = Math.floor(x / 7) + i * 31; } return s; }

// Output of a floor-plan recognition model (CubiCasa5K / DeepFloorplan style)
// plus OCR on a scanned PDF of the ground floor. Pixel coordinates, y down.
export function samplePlanRecognition() {
  const f = mbFloor(0);
  const pxPerM = 40;
  const rand = mulberry32(11);
  return {
    model: 'cubicasa5k-hrnet (sample output)', image: 'MB-ground-floor-scan.pdf#page=1', pixelsPerMetre: pxPerM, imageHeightPx: BUILDING_H * pxPerM,
    rooms: realRooms(f).filter((r) => r.type !== 'electrical').map((r) => {
      const misread = r.id === 'MB-CONF';
      return {
        polygonPx: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => [Math.round(x * pxPerM + gauss(rand) * 6), Math.round(y * pxPerM + gauss(rand) * 6)]),
        segmentationScore: +(0.86 + rand() * 0.1).toFixed(2),
        ocr: { text: misread ? 'MB-C0NF' : r.id, score: misread ? 0.71 : +(0.9 + rand() * 0.08).toFixed(2) },
      };
    }),
  };
}

// OCR text of the electrical single-line diagram for DB-MB-1 (the correct wiring).
export function sampleSLDText() {
  const panel = PANELS.find((p) => p.id === 'DB-MB-1');
  const lines = ['SINGLE LINE DIAGRAM - DB-MB-1 (MAIN BLOCK FIRST FLOOR)', 'INCOMER 100A TPN MCCB FROM MLT/O2', '---'];
  for (const c of panel.circuits) {
    const room = c.roomId;
    const what = c.kind === 'ac' ? 'AC' : c.kind === 'equipment' ? 'SOCKETS' : 'LTG+FANS';
    lines.push(`${panel.id} ${c.breaker} ${c.ratingA}A SPN MCB -> ${room} ${what}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 3. phone walkthrough
// Apple RoomPlan CapturedRoom-style JSON for the first floor. The phone's frame
// is arbitrary (rotated and offset from the drawing); walls carry 4x4
// column-major transforms with y up; horizontal plane is X/Z.
export function sampleRoomPlan() {
  const f = mbFloor(1);
  const rand = mulberry32(21);
  const yaw = 1.07, ox = -31.5, oz = 12.2;
  const toPhone = ([x, y]) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const X = c * x - s * y + ox, Y = s * x + c * y + oz;
    return [X + gauss(rand) * 0.03, -Y + gauss(rand) * 0.03];         // phone X, Z (Z points "south")
  };
  const wall = (a, b) => {
    const A = toPhone(a), B = toPhone(b);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dx = (B[0] - A[0]) / len, dz = (B[1] - A[1]) / len;
    return {
      identifier: uuid(rand), category: { wall: {} }, confidence: { high: {} }, dimensions: [len, 2.85, 0],
      transform: [dx, 0, dz, 0, 0, 1, 0, 0, -dz, 0, dx, 0, (A[0] + B[0]) / 2, 1.425, (A[1] + B[1]) / 2, 1],
    };
  };
  const object = (cat, p, dims) => {
    const P = toPhone(p);
    return { identifier: uuid(rand), category: { [cat]: {} }, confidence: { high: {} }, dimensions: dims, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, P[0], dims[1] / 2, P[1], 1] };
  };
  const scanned = ['CSE-101', 'CSE-102', 'CSE-103', 'CSE-LAB1', 'CSE-LAB2', 'CSE-DEPT'];
  const rooms = scanned.map((id) => {
    const r = f.rooms.find((q) => q.id === id);
    const p = toUp(r);
    const walls = p.map((a, i) => wall(a, p[(i + 1) % 4]));
    const objects = [];
    const isLab = r.type === 'lab', isOffice = r.type === 'office';
    const rows = isOffice ? 2 : 5, cols = isOffice ? 3 : isLab ? 4 : 6;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const x = p[0][0] + 1.5 + (j * (r.w - 3)) / Math.max(1, cols - 1);
      const y = p[0][1] + 1.6 + (i * (r.h - 3.5)) / Math.max(1, rows - 1);
      objects.push(object('table', [x, y], [1.2, 0.75, 0.6]));
      if (rand() < 0.93) objects.push(object('chair', [x - 0.3, y - 0.5], [0.45, 0.85, 0.45]));
      if (rand() < 0.9) objects.push(object('chair', [x + 0.3, y - 0.5], [0.45, 0.85, 0.45]));
    }
    if (isOffice) objects.push(object('storage', [p[1][0] - 0.6, p[0][1] + 5], [0.9, 2.0, 0.5]));
    return {
      name: id,                                  // typed or spoken by the person scanning
      story: 1, version: 2,
      walls,
      doors: [{ identifier: uuid(rand), category: { door: { isOpen: true } }, dimensions: [0.9, 2.1, 0], transform: wall(...(r.top ? [p[0], p[1]] : [p[3], p[2]])).transform }],
      windows: [], openings: [], objects,
    };
  });
  return { capturedWith: 'RoomPlan (sample)', device: 'iPhone 15 Pro', capturedAt: '2026-10-28T10:42:00+05:30', rooms };
}
function uuid(rand) { const h = () => Math.floor(rand() * 16).toString(16); return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h).toUpperCase(); }

// Nameplate photos: OCR text plus the asset tag and room typed during the walkthrough.
export function sampleNameplates() {
  return [
    { photo: 'IMG_0412.jpg', tag: 'PUMP-1', room: 'MB-PUMP', text: 'KIRLOSKAR BROTHERS LIMITED\nMONOBLOCK CENTRIFUGAL PUMP\nTYPE KDS-2040+  SR.NO. 23A7741\nOUTPUT 15 kW / 20 HP\n415 V 3 PH 50 Hz  27.5 A\n2900 RPM  INS CL F  IP55' },
    { photo: 'IMG_0415.jpg', tag: 'PUMP-2', room: 'MB-PUMP', text: 'KIRLOSKAR BROTHERS LIMITED\nMONOBLOCK CENTRIFUGAL PUMP\nTYPE KDS-2040+  SR.NO. 23A7752\nOUTPUT 15 kW / 20 HP\n415 V 3 PH 50 Hz  27.5 A\n2900 RPM  INS CL F  IP55' },
    { photo: 'IMG_0430.jpg', tag: 'AHU-A', room: 'MB-AHU', text: 'BLUE STAR LTD\nAIR COOLED SCREW CHILLER\nMODEL BS-ACS-120R\nNOMINAL CAPACITY 105 TR\nRATED INPUT POWER 120 kW\n415V / 3PH / 50HZ   REFRIGERANT R134a' },
    { photo: 'IMG_0441.jpg', tag: 'BAT-1', room: 'MB-ELEC', text: 'EXICOM\nLITHIUM ION BATTERY ENERGY STORAGE SYSTEM\nMODEL ELB-400\nUSABLE ENERGY 400 kWh\nRATED POWER 150 kW\nNOMINAL VOLTAGE 768 VDC' },
  ];
}

// ---------------------------------------------------------------- 5. electricity and occupancy
const TT = [
  // room, start, end, course, students
  ['CSE-101', '09:00', '10:00', 'Data Structures', 58], ['CSE-101', '11:15', '13:15', 'Operating Systems', 55],
  ['CSE-102', '09:00', '11:00', 'Computer Networks', 60], ['CSE-102', '14:00', '16:00', 'DBMS', 52],
  ['CSE-103', '10:00', '12:00', 'Discrete Maths', 57], ['CSE-103', '14:00', '15:00', 'Soft Skills', 40],
  ['CSE-104', '09:00', '10:00', 'Compiler Design', 49], ['CSE-104', '15:00', '17:00', 'Cloud Computing', 50],
  ['CSE-105', '11:15', '12:15', 'Python Lab Theory', 45],
  ['CSE-LAB1', '09:00', '12:00', 'Programming Lab (A1)', 34], ['CSE-LAB1', '14:00', '17:00', 'Programming Lab (A2)', 33],
  ['CSE-LAB2', '10:00', '13:00', 'Systems Lab (B1)', 32],
  ['CSE-106', '15:00', '16:00', 'Elective: Blockchain', 38],
];
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export function sampleTimetableCSV() {
  return ['room,day,start,end,course,students', ...TT.map(([r, s, e, c, n]) => `${r},MON,${s},${e},${c},${n}`)].join('\n');
}

// Ground truth people per room at minute m (from the timetable, small absences).
function occupancyAt(roomId, m, rand) {
  let n = 0;
  for (const [r, s, e, , k] of TT) if (r === roomId && m >= hm(s) && m < hm(e)) n = Math.round(k * (0.9 + rand() * 0.08));
  if (roomId === 'CSE-DEPT' && m >= 9 * 60 && m < 17 * 60 + 30) n = 6 + Math.round(rand() * 4);
  return n;
}

// Wi-Fi controller export: associated clients per access point every 15 minutes.
export function sampleWifiCSV() {
  const rand = mulberry32(31);
  const aps = ['CSE-101', 'CSE-102', 'CSE-103', 'CSE-104', 'CSE-105', 'CSE-LAB1', 'CSE-LAB2', 'CSE-DEPT'];
  const rows = ['time,ap_name,clients'];
  for (let m = 8 * 60; m <= 18 * 60; m += 15) {
    for (const r of aps) {
      const people = occupancyAt(r, m, rand);
      const clients = Math.max(0, Math.round(people * (1.45 + gauss(rand) * 0.12) + (rand() < 0.3 ? 1 : 0)));
      rows.push(`2026-10-26 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},AP-${r},${clients}`);
    }
  }
  return rows.join('\n');
}

// People counts reported by the SEE engine (YOLO per room camera), 15-minute peaks.
// CAM-CSE-LAB2 is obstructed by a projector screen and sees nobody.
export function sampleCctvCounts() {
  const rand = mulberry32(41);
  const out = {};
  for (const r of ['CSE-101', 'CSE-102', 'CSE-103', 'CSE-104', 'CSE-105', 'CSE-LAB1', 'CSE-LAB2', 'CSE-DEPT']) {
    out[`CAM-${r}`] = [];
    for (let m = 8 * 60; m <= 18 * 60; m += 15) {
      const n = r === 'CSE-LAB2' ? 0 : Math.max(0, Math.round(occupancyAt(r, m, rand) * (0.96 + gauss(rand) * 0.03)));
      out[`CAM-${r}`].push({ m, count: n });
    }
  }
  return out;
}

// Main Block energy meter, 1-minute kW for one weekday. Contains: base load,
// classroom circuits switching with the timetable, two pumps filling tanks,
// lab equipment, and noise. PUMP-1 really draws 8.4 kW (throttled valve).
export function sampleMeterCSV() {
  const rand = mulberry32(51);
  const rows = ['timestamp,kW'];
  const on = (m, a, b) => m >= a && m < b;
  for (let m = 0; m < 1440; m++) {
    let kW = 16.5 + Math.sin((m / 1440) * Math.PI * 2) * 0.6;                      // server room, corridors, riser
    if (on(m, 6 * 60 + 2, 7 * 60 + 7) || on(m, 18 * 60 + 41, 19 * 60 + 33)) kW += 8.4;   // PUMP-1 (throttled)
    if (on(m, 6 * 60 + 21, 7 * 60 + 16) || on(m, 13 * 60 + 5, 13 * 60 + 52)) kW += 14.6; // PUMP-2
    for (const [r, s, e] of TT) {
      if (r === 'CSE-106') continue;
      const room = ROOM_BY_ID[r];
      if (!room) continue;
      const L = room.loads;
      if (on(m, hm(s) - 5, hm(e) + 10)) kW += L.lightsKW + L.fansKW + L.acKW;     // relay switches the room circuits together
    }
    if (on(m, 9 * 60, 17 * 60 + 30)) kW += 0.8 + 0.8;                              // department office
    if (rand() < 0.01) kW += 1.8;                                                    // kettles, printers (short)
    kW += gauss(rand) * 0.18;
    rows.push(`2026-10-26 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},${kW.toFixed(2)}`);
  }
  return rows.join('\n');
}

// For the CCTV calibration demo: people sitting in a room at 11:00.
export function samplePeopleInRoom(roomId, n, seed = 61) {
  const r = ROOM_BY_ID[roomId];
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `P-${roomId}-${i}`, name: `Student ${i + 1}`, role: 'student', floor: r.floor,
      x: r.x + 1.2 + rand() * (r.w - 2.4), y: r.y + 1.5 + rand() * (r.h - 2.8),
      roomId, targetRoomId: roomId, path: [], seated: rand() < 0.85,
      color: ['#4a6fa5', '#a54a4a', '#4aa57a', '#a5904a', '#7a4aa5'][i % 5],
    });
  }
  return out;
}

export const SAMPLE_INFO = {
  blueprintFloor: 'MB-1', ifcFloor: 'MB-2', planFloor: 'MB-G',
};
export { mb1BlueprintRooms, toUp, mbFloor, realRooms };
