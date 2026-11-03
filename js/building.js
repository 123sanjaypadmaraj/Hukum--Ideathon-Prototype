// Static model of the New Horizon College of Engineering (NHCE) campus,
// Outer Ring Road, Marathahalli, Bengaluru: an outdoor site plan plus
// enterable blocks with floors, rooms, cameras, distribution boards and
// flexible equipment. Everything else (simulation, world view, CCTV, UI)
// reads from this module.
//
// Facilities named on NHCE's own infrastructure pages: 700-seat Auditorium,
// Library & Information Centre, Conference Hall, Video Conference Hall,
// Seminar Hall, CCTV control room / security, Sanjeevini Medical Facility,
// Nirvana Recreation Centre, Indian Bank & ATM, fitness gym, indoor sports,
// sports ground, synthetic athletic track, basketball court, electrical
// substation, AICTE Idea Lab, Industry Skill Labs (CoE). NHCE's green audit
// lists rooftop solar on the SVP and NSB blocks (SVP: 25 kWp, off-grid with
// battery) and separate energy meters per block.
// ASSUMED (edit BLOCK_SPECS / SITE below to match the real campus): which
// department sits in which block, block positions, floor counts, room lists.
//
// FLOORS is a flat list. A floor's index in FLOORS is its `level` (kept for
// older code: FLOORS[f.level] === f). Use `blockId`, `storey`, `up`, `down`,
// `isCampus`, `isRoof` instead of assuming level numbers.
// Coordinates are in TILES. One tile ~ 1 m inside blocks; the campus floor is
// a schematic site plan (not to scale) on the same 52 x 29 grid.

export const COLS = 52;
export const ROWS = 29;

export const TILE = { WALL: 0, ROOM: 1, CORRIDOR: 2, DOOR: 3, CORE: 4 };

const SLOT_X = [1, 12, 23, 34];
const TOP_Y = 1, BOT_Y = 18, ROOM_H = 10, ROOM_W = 10;
export const CORRIDOR = { x: 1, y: 12, w: 50, h: 5 };
// Each block's ground-floor main entrance: west end of the corridor.
export const BLOCK_ENTRANCE = { x: 0, y: 14 };

// Default electrical loads per room type (kW).
const LOADS = {
  classroom:  { lightsKW: 0.6, fansKW: 0.5, acKW: 3.0 },
  lab:        { lightsKW: 0.8, fansKW: 0.5, acKW: 4.5, equipKW: 3.0 },
  workshop:   { lightsKW: 1.2, fansKW: 1.0, acKW: 0, equipKW: 12.0 },
  seminar:    { lightsKW: 1.6, fansKW: 0.8, acKW: 9.0 },
  auditorium: { lightsKW: 6.0, fansKW: 0, acKW: 45.0, equipKW: 4.0 },
  library:    { lightsKW: 1.6, fansKW: 1.0, acKW: 8.0 },
  office:     { lightsKW: 0.5, fansKW: 0.3, acKW: 2.5, equipKW: 0.8 },
  medical:    { lightsKW: 0.5, fansKW: 0.3, acKW: 2.5, equipKW: 1.0 },
  security:   { lightsKW: 0.4, fansKW: 0.2, acKW: 2.0, equipKW: 2.5 },
  gym:        { lightsKW: 1.0, fansKW: 1.0, acKW: 0, equipKW: 2.0 },
  recreation: { lightsKW: 0.8, fansKW: 0.6, acKW: 3.0 },
  lobby:      { lightsKW: 0.8, fansKW: 0.4, acKW: 0 },
  canteen:    { lightsKW: 1.2, fansKW: 1.2, acKW: 0, equipKW: 8.0 },
  server:     { lightsKW: 0.2, fansKW: 0, acKW: 6.0, equipKW: 8.0 },
  electrical: { lightsKW: 0.2, fansKW: 0.2, acKW: 0 },
  core:       { lightsKW: 0.2, fansKW: 0, acKW: 0 },
  plant:      { lightsKW: 0.2, fansKW: 0, acKW: 0 },
  roof:       { lightsKW: 0, fansKW: 0, acKW: 0 },
  // campus zones
  gate:       { lightsKW: 0.6, fansKW: 0, acKW: 0, equipKW: 0.3 },
  parking:    { lightsKW: 0.8, fansKW: 0, acKW: 0 },
  sports:     { lightsKW: 0, fansKW: 0, acKW: 0, equipKW: 0 },   // floodlights modelled by the energy layer
};

// Room types where camera auto-off applies. Server/electrical/security/medical/core never switch off.
export const AUTO_OFF_TYPES = new Set(['classroom', 'lab', 'workshop', 'seminar', 'auditorium', 'library', 'office', 'recreation', 'gym']);
// Room types that follow the class timetable.
export const TIMETABLE_TYPES = new Set(['classroom', 'lab', 'workshop', 'seminar']);
// Outdoor campus zone types (no walls, no auto-off).
export const ZONE_TYPES = new Set(['gate', 'parking', 'sports']);

// ---------------------------------------------------------------- blocks
// Floor specs: `storey` 0 = ground, 'R' = roof. Rooms use the slot grid:
// T0..T3 (north side of the corridor), B0..B3 (south side); `span` merges slots.
const BLOCK_SPECS = [
  {
    id: 'MB', name: 'Main Block', short: 'MB',
    about: 'Administration, Library & Information Centre, CSE, ISE and AI & ML (department placement assumed)',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', id: 'MB-LOBBY', name: 'Main Lobby & Reception', type: 'lobby' },
        { slot: 'T1', id: 'MB-ADMIN', name: 'Principal & Admin Office', type: 'office', seats: 10 },
        { slot: 'T2', span: 2, id: 'MB-LIB', name: 'Library & Information Centre', type: 'library', seats: 80 },
        { slot: 'B0', id: 'MB-CCTV', name: 'CCTV Control Room & Security', type: 'security', seats: 3 },
        { slot: 'B1', id: 'MB-ELEC', name: 'Main Electrical Room (LT panel, battery)', type: 'electrical' },
        { slot: 'B2', id: 'MB-SERVER', name: 'Data Centre', type: 'server' },
        { slot: 'B3', id: 'MB-CONF', name: 'Conference Hall', type: 'seminar', seats: 40 },
      ] },
      { storey: 1, rooms: [
        { slot: 'T0', id: 'CSE-101', name: 'CSE Classroom 101', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'CSE-102', name: 'CSE Classroom 102', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'CSE-103', name: 'CSE Classroom 103', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'CSE-104', name: 'CSE Classroom 104', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'CSE-LAB1', name: 'CSE Programming Lab', type: 'lab', seats: 36 },
        { slot: 'B1', id: 'CSE-LAB2', name: 'CSE Systems Lab', type: 'lab', seats: 36 },
        { slot: 'B2', id: 'CSE-105', name: 'CSE Classroom 105', type: 'classroom', seats: 60 },
        { slot: 'B3', id: 'CSE-DEPT', name: 'CSE Department & HoD', type: 'office', seats: 14 },
      ] },
      { storey: 2, rooms: [
        { slot: 'T0', id: 'ISE-201', name: 'ISE Classroom 201', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'ISE-202', name: 'ISE Classroom 202', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'AIML-203', name: 'AI & ML Classroom 203', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'AIML-204', name: 'AI & ML Classroom 204', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'AIML-LAB', name: 'AI & ML Lab (GPU)', type: 'lab', seats: 36 },
        { slot: 'B1', id: 'ISE-LAB', name: 'ISE Lab', type: 'lab', seats: 36 },
        { slot: 'B2', span: 2, id: 'MB-VC', name: 'Video Conference Hall', type: 'seminar', seats: 80 },
      ] },
      { storey: 'R', rooms: [
        { slot: 'T0', span: 4, id: 'MB-PV-N', name: 'Main Block Solar Array', type: 'roof' },
        { slot: 'B0', id: 'MB-PUMP', name: 'Pump House', type: 'plant' },
        { slot: 'B1', id: 'MB-AHU', name: 'Chiller / AHU Plant', type: 'plant' },
        { slot: 'B2', span: 2, id: 'MB-PV-S', name: 'Main Block Solar Array (south)', type: 'roof' },
      ] },
    ],
  },
  {
    id: 'SVP', name: 'SVP Block', short: 'SVP',
    about: 'ECE and EEE, AICTE Idea Lab, Industry Skill Lab (CoE); existing 25 kWp off-grid rooftop solar',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', id: 'ECE-LAB1', name: 'ECE Analog & Digital Lab', type: 'lab', seats: 30 },
        { slot: 'T1', id: 'ECE-LAB2', name: 'ECE Microcontrollers Lab', type: 'lab', seats: 30 },
        { slot: 'T2', id: 'EEE-LAB', name: 'EEE Machines Lab', type: 'workshop', seats: 30 },
        { slot: 'T3', id: 'SVP-SEM', name: 'SVP Seminar Hall', type: 'seminar', seats: 60 },
        { slot: 'B0', id: 'ECE-101', name: 'ECE Classroom 101', type: 'classroom', seats: 60 },
        { slot: 'B1', id: 'ECE-102', name: 'ECE Classroom 102', type: 'classroom', seats: 60 },
        { slot: 'B2', id: 'EEE-103', name: 'EEE Classroom 103', type: 'classroom', seats: 60 },
        { slot: 'B3', id: 'ECE-DEPT', name: 'ECE & EEE Departments', type: 'office', seats: 14 },
      ] },
      { storey: 1, rooms: [
        { slot: 'T0', id: 'ECE-201', name: 'ECE Classroom 201', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'ECE-202', name: 'ECE Classroom 202', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'EEE-203', name: 'EEE Classroom 203', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'EEE-204', name: 'EEE Classroom 204', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'IDEA-LAB', name: 'AICTE Idea Lab', type: 'lab', seats: 30 },
        { slot: 'B1', id: 'COE-LAB', name: 'Industry Skill Lab (CoE)', type: 'lab', seats: 30 },
        { slot: 'B2', id: 'ECE-205', name: 'ECE Classroom 205', type: 'classroom', seats: 60 },
        { slot: 'B3', id: 'EEE-206', name: 'EEE Classroom 206', type: 'classroom', seats: 60 },
      ] },
      { storey: 'R', rooms: [
        { slot: 'T0', span: 4, id: 'SVP-PV', name: 'SVP Solar Array (existing 25 kWp, off-grid + battery)', type: 'roof' },
        { slot: 'B0', id: 'SVP-PUMP', name: 'SVP Pump House', type: 'plant' },
        { slot: 'B2', span: 2, id: 'SVP-PV-S', name: 'SVP Solar Array (HUKUM expansion)', type: 'roof' },
      ] },
    ],
  },
  {
    id: 'NSB', name: 'NSB Block', short: 'NSB',
    about: 'Mechanical and Civil Engineering, workshops; existing rooftop solar',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', span: 2, id: 'ME-WS', name: 'Mechanical Workshop', type: 'workshop', seats: 40 },
        { slot: 'T2', id: 'ME-CAD', name: 'CAD / CAM Lab', type: 'lab', seats: 36 },
        { slot: 'T3', id: 'CV-LAB', name: 'Civil Materials Testing Lab', type: 'workshop', seats: 30 },
        { slot: 'B0', id: 'ME-101', name: 'ME Classroom 101', type: 'classroom', seats: 60 },
        { slot: 'B1', id: 'ME-102', name: 'ME Classroom 102', type: 'classroom', seats: 60 },
        { slot: 'B2', id: 'CV-103', name: 'Civil Classroom 103', type: 'classroom', seats: 60 },
        { slot: 'B3', id: 'ME-DEPT', name: 'Mechanical & Civil Departments', type: 'office', seats: 14 },
      ] },
      { storey: 1, rooms: [
        { slot: 'T0', id: 'ME-201', name: 'ME Classroom 201', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'ME-202', name: 'ME Classroom 202', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'CV-203', name: 'Civil Classroom 203', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'CV-204', name: 'Civil Classroom 204', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'FLUID-LAB', name: 'Fluid Mechanics Lab', type: 'workshop', seats: 30 },
        { slot: 'B1', id: 'SURVEY-LAB', name: 'Surveying Lab', type: 'lab', seats: 30 },
        { slot: 'B2', id: 'ME-205', name: 'ME Classroom 205', type: 'classroom', seats: 60 },
        { slot: 'B3', id: 'NSB-FAC', name: 'NSB Faculty Room', type: 'office', seats: 12 },
      ] },
      { storey: 'R', rooms: [
        { slot: 'T0', span: 4, id: 'NSB-PV', name: 'NSB Solar Array (existing rooftop PV)', type: 'roof' },
        { slot: 'B0', id: 'NSB-PUMP', name: 'NSB Pump House', type: 'plant' },
      ] },
    ],
  },
  {
    id: 'NSC', name: 'NSC Block', short: 'NSC',
    about: 'MBA, MCA, Basic Sciences, Placement & Training, Exam Hall',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', id: 'MBA-101', name: 'MBA Classroom 101', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'MBA-102', name: 'MBA Classroom 102', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'MCA-103', name: 'MCA Classroom 103', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'MCA-104', name: 'MCA Classroom 104', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'MCA-LAB', name: 'MCA Computer Lab', type: 'lab', seats: 36 },
        { slot: 'B1', id: 'PHY-LAB', name: 'Engineering Physics Lab', type: 'lab', seats: 30 },
        { slot: 'B2', id: 'CHEM-LAB', name: 'Engineering Chemistry Lab', type: 'lab', seats: 30 },
        { slot: 'B3', id: 'NSC-DEPT', name: 'MBA / MCA / Basic Sciences Offices', type: 'office', seats: 14 },
      ] },
      { storey: 1, rooms: [
        { slot: 'T0', id: 'BS-201', name: 'First Year Classroom 201', type: 'classroom', seats: 60 },
        { slot: 'T1', id: 'BS-202', name: 'First Year Classroom 202', type: 'classroom', seats: 60 },
        { slot: 'T2', id: 'BS-203', name: 'First Year Classroom 203', type: 'classroom', seats: 60 },
        { slot: 'T3', id: 'BS-204', name: 'First Year Classroom 204', type: 'classroom', seats: 60 },
        { slot: 'B0', id: 'BS-205', name: 'Maths Tutorial Room', type: 'classroom', seats: 40 },
        { slot: 'B1', id: 'PLACEMENT', name: 'Placement & Training Cell', type: 'office', seats: 10 },
        { slot: 'B2', span: 2, id: 'NSC-EXAM', name: 'Examination Hall', type: 'seminar', seats: 120 },
      ] },
    ],
  },
  {
    id: 'AUD', name: 'Auditorium', short: 'AUD',
    about: '700-seat auditorium for seminars, workshops, debates and guest lectures',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', span: 4, id: 'AUD-HALL', name: 'Auditorium (700 seats)', type: 'auditorium', seats: 700 },
        { slot: 'B0', id: 'AUD-GREEN', name: 'Green Room', type: 'office', seats: 10 },
        { slot: 'B1', id: 'AUD-AV', name: 'AV & Stage Lighting Control', type: 'office', seats: 3 },
        { slot: 'B2', span: 2, id: 'AUD-FOYER', name: 'Auditorium Foyer', type: 'lobby' },
      ] },
    ],
  },
  {
    id: 'AMN', name: 'Student Amenities', short: 'AMN',
    about: 'Cafeteria, Sanjeevini Medical Facility, Indian Bank & ATM, fitness gym, Nirvana Recreation Centre',
    floors: [
      { storey: 0, rooms: [
        { slot: 'T0', span: 2, id: 'CAFE', name: 'Cafeteria / Food Court', type: 'canteen', seats: 120 },
        { slot: 'T2', id: 'SANJEEVINI', name: 'Sanjeevini Medical Facility', type: 'medical', seats: 6 },
        { slot: 'T3', id: 'BANK', name: 'Indian Bank & ATM', type: 'office', seats: 6 },
        { slot: 'B0', span: 2, id: 'GYM', name: 'Fitness Gym & Indoor Sports', type: 'gym', seats: 40 },
        { slot: 'B2', span: 2, id: 'NIRVANA', name: 'Nirvana Recreation Centre', type: 'recreation', seats: 40 },
      ] },
    ],
  },
];

// ---------------------------------------------------------------- site plan
// Schematic NHCE site on the 52 x 29 grid. Outer Ring Road runs along the
// south edge; the main gate opens onto it. Footprints are solid (walls);
// `door` is the walkable tile in front of the entrance, `arrive` is where you
// land when you walk out of the block.
export const SITE = {
  name: 'NHCE Campus',
  road: 'Outer Ring Road, Marathahalli',
  footprints: [
    { blockId: 'SVP', x: 2,  y: 2,  w: 10, h: 7, door: { x: 6,  y: 9 },  arrive: { x: 6.5,  y: 10.5 } },
    { blockId: 'NSB', x: 14, y: 2,  w: 10, h: 7, door: { x: 18, y: 9 },  arrive: { x: 18.5, y: 10.5 } },
    { blockId: 'NSC', x: 26, y: 2,  w: 10, h: 7, door: { x: 30, y: 9 },  arrive: { x: 30.5, y: 10.5 } },
    { blockId: 'AUD', x: 38, y: 2,  w: 12, h: 8, door: { x: 43, y: 10 }, arrive: { x: 43.5, y: 11.5 } },
    { blockId: 'MB',  x: 17, y: 13, w: 18, h: 8, door: { x: 25, y: 21 }, arrive: { x: 25.5, y: 22.5 } },
    { blockId: 'AMN', x: 2,  y: 13, w: 10, h: 7, door: { x: 12, y: 16 }, arrive: { x: 13.5, y: 16.5 } },
  ],
  // Non-enterable structures drawn on the site plan.
  structures: [
    { id: 'SUBSTATION', name: 'Electrical Substation', x: 36, y: 14, w: 3, h: 3 },
    { id: 'STP', name: 'Sewage Treatment Plant', x: 36, y: 18, w: 3, h: 2 },
  ],
  // Outdoor zones: walkable, labelled, some with cameras.
  zones: [
    { id: 'GATE', name: 'Main Gate & Security', type: 'gate', x: 22, y: 24, w: 8, h: 3 },
    { id: 'PARKING', name: 'Parking, Bus Bay & EV Chargers', type: 'parking', x: 11, y: 22, w: 9, h: 5 },
    { id: 'SPORTS', name: 'Sports Ground & Synthetic Track', type: 'sports', x: 40, y: 13, w: 10, h: 13 },
    { id: 'BBALL', name: 'Basketball Court', type: 'sports', x: 2, y: 22, w: 7, h: 4 },
  ],
  // Off-map loads metered separately (energy layer aggregates them).
  offsite: ['Boys & girls hostels', 'Faculty accommodation'],
};

// ---------------------------------------------------------------- builders
function slotRect(slot, span = 1) {
  const top = slot[0] === 'T';
  const i = Number(slot.slice(1));
  const x = SLOT_X[i];
  const w = ROOM_W * span + (span - 1);           // absorb the wall between slots
  return { x, y: top ? TOP_Y : BOT_Y, w, h: ROOM_H, top };
}

function makeRoom(rs, r, floorIndex, blockId) {
  const loads = { equipKW: 0, ...LOADS[rs.type] };
  const hasCamera = rs.type !== 'roof' && rs.type !== 'plant' && rs.type !== 'electrical';
  const camera = hasCamera
    ? {
        id: `CAM-${rs.id}`,
        x: r.x + 0.6,
        y: r.top ? r.y + 0.6 : r.y + r.h - 0.6,
        facing: r.top ? Math.PI / 4 : -Math.PI / 4,   // radians, 0 = +x, PI/2 = +y (down)
        fov: Math.PI / 2,
      }
    : null;
  return {
    id: rs.id, name: rs.name, type: rs.type, floor: floorIndex, blockId,
    x: r.x, y: r.y, w: r.w, h: r.h, top: r.top,
    doors: r.doors || [], seats: rs.seats || 0, loads, camera,
    autoOff: AUTO_OFF_TYPES.has(rs.type),
    timetabled: TIMETABLE_TYPES.has(rs.type),
  };
}

function storeyName(storey) {
  if (storey === 'R') return 'Roof';
  if (storey === 0) return 'Ground Floor';
  return ['', 'First', 'Second', 'Third', 'Fourth'][storey] + ' Floor';
}

function buildBlockFloor(block, fs, index) {
  const isRoof = fs.storey === 'R';
  const short = `${block.short}-${isRoof ? 'R' : fs.storey === 0 ? 'G' : fs.storey}`;
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(TILE.WALL));
  const fill = (r, code) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = code;
  };
  fill(CORRIDOR, TILE.CORRIDOR);

  const rooms = fs.rooms.map((rs) => {
    const r = slotRect(rs.slot, rs.span);
    fill(r, TILE.ROOM);
    const doors = [];
    for (let s = 0; s < (rs.span || 1); s++) {
      const dx = r.x + s * (ROOM_W + 1) + 4;
      const dy = r.top ? r.y + r.h : r.y - 1;
      doors.push({ x: dx, y: dy }, { x: dx + 1, y: dy });
    }
    doors.forEach((d) => (grid[d.y][d.x] = TILE.DOOR));
    return makeRoom(rs, { ...r, doors }, index, block.id);
  });

  // Vertical core: stairs + lift (top), electrical riser with floor DB (bottom).
  const coreTop = { x: 45, y: TOP_Y, w: 6, h: ROOM_H };
  const coreBot = { x: 45, y: BOT_Y, w: 6, h: ROOM_H };
  fill(coreTop, TILE.CORE);
  fill(coreBot, TILE.ROOM);
  grid[coreTop.y + coreTop.h][47] = TILE.DOOR; grid[coreTop.y + coreTop.h][48] = TILE.DOOR;
  grid[coreBot.y - 1][47] = TILE.DOOR; grid[coreBot.y - 1][48] = TILE.DOOR;
  if (fs.storey === 0) grid[BLOCK_ENTRANCE.y][BLOCK_ENTRANCE.x] = TILE.DOOR;

  const core = {
    id: `CORE-${short}`, name: 'Stairs & Lift', type: 'core', floor: index, blockId: block.id,
    ...coreTop, top: true, doors: [{ x: 47, y: 11 }, { x: 48, y: 11 }],
    seats: 0, loads: { equipKW: 0, ...LOADS.core }, camera: null, autoOff: false, timetabled: false,
  };
  const riser = {
    id: `RISER-${short}`, name: `Electrical Riser ${short}`, type: 'electrical', floor: index, blockId: block.id,
    ...coreBot, top: false, doors: [{ x: 47, y: 17 }, { x: 48, y: 17 }],
    seats: 0, loads: { equipKW: 0, ...LOADS.electrical }, camera: null, autoOff: false, timetabled: false,
  };
  const corridorCam = isRoof ? null : {
    id: `CAM-COR-${short}`, x: 1.5, y: CORRIDOR.y + 2.5, facing: 0, fov: Math.PI / 3,
  };

  return {
    level: index, blockId: block.id, storey: fs.storey, isRoof, isCampus: false,
    name: `${block.name} · ${storeyName(fs.storey)}`, floorName: storeyName(fs.storey), short, grid,
    rooms: [...rooms, core, riser],
    corridor: { ...CORRIDOR, id: `COR-${short}`, name: `${block.name} ${storeyName(fs.storey)} Corridor`, camera: corridorCam },
    stairs: { x: 46, y: 2, w: 2, h: 8 },
    lift: { x: 49, y: 3, w: 2, h: 3 },
    up: null, down: null,                        // filled in below
  };
}

function buildCampus(index) {
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(TILE.CORRIDOR));
  for (let x = 0; x < COLS; x++) { grid[0][x] = TILE.WALL; grid[ROWS - 1][x] = TILE.WALL; }
  for (let y = 0; y < ROWS; y++) { grid[y][0] = TILE.WALL; grid[y][COLS - 1] = TILE.WALL; }
  const solid = (r) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = TILE.WALL; };
  SITE.footprints.forEach(solid);
  SITE.structures.forEach(solid);
  // The main gate opens through the south boundary onto the ring road.
  const gate = SITE.zones.find((z) => z.id === 'GATE');
  for (let x = gate.x + 2; x < gate.x + gate.w - 2; x++) grid[ROWS - 1][x] = TILE.DOOR;

  const rooms = SITE.zones.map((z) => {
    for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) grid[y][x] = TILE.ROOM;
    const r = makeRoom({ ...z, seats: 0 }, { x: z.x, y: z.y, w: z.w, h: z.h, top: true, doors: [] }, index, 'CAMPUS');
    r.autoOff = false; r.timetabled = false; r.outdoor = true;
    if (r.camera) { r.camera.fov = Math.PI / 2.2; }
    return r;
  });
  SITE.footprints.forEach((f) => (grid[f.door.y][f.door.x] = TILE.DOOR));

  return {
    level: index, blockId: 'CAMPUS', storey: 0, isRoof: false, isCampus: true,
    name: SITE.name, floorName: 'Site plan', short: 'CAMPUS', grid,
    rooms,
    corridor: { x: 1, y: 1, w: COLS - 2, h: ROWS - 2, id: 'COR-CAMPUS', name: 'Campus grounds', camera: null },
    stairs: null, lift: null, up: null, down: null,
  };
}

// ---------------------------------------------------------------- assemble
export const FLOORS = [buildCampus(0)];
export const BLOCKS = BLOCK_SPECS.map((b) => {
  const floorIdx = [];
  for (const fs of b.floors) {
    const f = buildBlockFloor(b, fs, FLOORS.length);
    FLOORS.push(f);
    floorIdx.push(f.level);
  }
  for (let i = 0; i < floorIdx.length; i++) {
    FLOORS[floorIdx[i]].up = floorIdx[i + 1] ?? null;
    FLOORS[floorIdx[i]].down = floorIdx[i - 1] ?? null;
  }
  const fp = SITE.footprints.find((f) => f.blockId === b.id);
  return { id: b.id, name: b.name, short: b.short, about: b.about, floors: floorIdx, ground: floorIdx[0], footprint: fp };
});
export const BLOCK_BY_ID = Object.fromEntries(BLOCKS.map((b) => [b.id, b]));
export const CAMPUS_FLOOR = 0;

// Portals between the campus and each block's ground-floor entrance.
// Walk onto `outside` (campus) to enter; walk onto `inside` (block G) to leave.
export const PORTALS = BLOCKS.map((b) => ({
  blockId: b.id,
  outside: { floor: CAMPUS_FLOOR, x: b.footprint.door.x, y: b.footprint.door.y },
  outsideArrive: { floor: CAMPUS_FLOOR, ...b.footprint.arrive },
  inside: { floor: b.ground, x: BLOCK_ENTRANCE.x, y: BLOCK_ENTRANCE.y },
  insideArrive: { floor: b.ground, x: BLOCK_ENTRANCE.x + 1.5, y: BLOCK_ENTRANCE.y + 0.5 },
}));

export const ROOMS = FLOORS.flatMap((f) => f.rooms);
export const ROOM_BY_ID = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

export const CAMERAS = [
  ...ROOMS.filter((r) => r.camera).map((r) => ({ ...r.camera, roomId: r.id, floor: r.floor, blockId: r.blockId, kind: r.outdoor ? 'outdoor' : 'room' })),
  ...FLOORS.filter((f) => f.corridor.camera).map((f) => ({ ...f.corridor.camera, roomId: f.corridor.id, floor: f.level, blockId: f.blockId, kind: 'corridor' })),
];
export const CAMERA_BY_ID = Object.fromEntries(CAMERAS.map((c) => [c.id, c]));

const floorOf = (blockId, storey) => FLOORS.find((f) => f.blockId === blockId && f.storey === storey).level;
export function floorIndex(blockId, storey) { return floorOf(blockId, storey); }
export function blockOfFloor(floor) { return FLOORS[floor] ? BLOCK_BY_ID[FLOORS[floor].blockId] || null : null; }

// Distribution boards: one per block floor in the riser, plus the main LT panel.
function floorPanel(floor) {
  const circuits = [];
  let n = 1;
  for (const r of floor.rooms) {
    if (r.type === 'core' || r.type === 'electrical' || r.type === 'roof') continue;
    circuits.push({ breaker: `C${n++}`, label: `${r.id} lights + fans`, roomId: r.id, kind: 'lighting', ratingA: 16 });
    if (r.loads.acKW > 0) circuits.push({ breaker: `C${n++}`, label: `${r.id} AC`, roomId: r.id, kind: 'ac', ratingA: r.loads.acKW > 20 ? 125 : 32 });
    if (r.loads.equipKW > 0) circuits.push({ breaker: `C${n++}`, label: `${r.id} sockets/equipment`, roomId: r.id, kind: 'equipment', ratingA: r.loads.equipKW > 6 ? 63 : 20 });
  }
  return {
    id: `DB-${floor.short}`, name: `Distribution Board ${floor.short}`, floor: floor.level, blockId: floor.blockId,
    roomId: `RISER-${floor.short}`, x: 49.5, y: 19, circuits,
  };
}

const MB_G = floorOf('MB', 0);
export const PANELS = [
  ...FLOORS.filter((f) => !f.isCampus).map(floorPanel),
  {
    id: 'MLT', name: 'Main LT Panel', floor: MB_G, blockId: 'MB', roomId: 'MB-ELEC', x: SLOT_X[1] + 1, y: BOT_Y + 1,
    circuits: [
      { breaker: 'I1', label: 'Grid incomer from campus substation (11 kV / 433 V)', kind: 'incomer', ratingA: 1600 },
      { breaker: 'I2', label: 'Rooftop solar inverters (MB, SVP, NSB)', kind: 'solar', ratingA: 1250, equipId: 'PV' },
      { breaker: 'O1', label: 'Battery inverter BAT-1', kind: 'battery', ratingA: 250, equipId: 'BAT-1' },
      ...BLOCKS.map((b, i) => ({ breaker: `O${i + 2}`, label: `Feeder: ${b.name} (block energy meter)`, kind: 'feeder', ratingA: b.id === 'MB' ? 400 : 250, blockId: b.id })),
      { breaker: `O${BLOCKS.length + 2}`, label: 'Feeder: parking, EV & e-bus chargers', kind: 'ev', ratingA: 250 },
      { breaker: `O${BLOCKS.length + 3}`, label: 'Feeder: hostels & faculty quarters (aggregated)', kind: 'feeder', ratingA: 800 },
      { breaker: `O${BLOCKS.length + 4}`, label: 'Feeder: campus & sports floodlights', kind: 'feeder', ratingA: 125 },
    ],
  },
];
export const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p]));

// Flexible assets that bid into the internal market. ratedKW is max draw
// (battery: max charge/discharge). Position is where they appear in the world.
const MB_R = floorOf('MB', 'R');
export const EQUIPMENT = [
  { id: 'PV', name: 'Rooftop Solar (campus total, HUKUM model 900 kWp)', kind: 'solar', ratedKW: 900, floor: MB_R, x: 20, y: 6, roomId: 'MB-PV-N', blockId: 'MB' },
  { id: 'BAT-1', name: 'Battery Storage', kind: 'battery', ratedKW: 150, capacityKWh: 400, floor: MB_G, x: 18, y: 24, roomId: 'MB-ELEC', blockId: 'MB' },
  { id: 'AHU-A', name: 'Main Block Chiller / AHU', kind: 'hvac', ratedKW: 120, flexKW: 35, floor: MB_R, x: 17, y: 22, roomId: 'MB-AHU', blockId: 'MB' },
  { id: 'HVAC-BD', name: 'Other blocks & hostels HVAC (aggregated)', kind: 'hvac', ratedKW: 260, flexKW: 60, floor: null, x: null, y: null, roomId: null, blockId: null },
  { id: 'PUMP-1', name: 'Water Pump 1 (Main Block)', kind: 'pump', ratedKW: 15, floor: MB_R, x: 4, y: 22, roomId: 'MB-PUMP', blockId: 'MB', tankKL: 50 },
  { id: 'PUMP-2', name: 'Water Pump 2 (Main Block)', kind: 'pump', ratedKW: 15, floor: MB_R, x: 8, y: 22, roomId: 'MB-PUMP', blockId: 'MB', tankKL: 50 },
  { id: 'EV-1', name: 'Staff EV Charger 1', kind: 'ev', ratedKW: 7.4, floor: CAMPUS_FLOOR, x: 12, y: 23, roomId: 'PARKING', blockId: 'CAMPUS' },
  { id: 'EV-2', name: 'Staff EV Charger 2', kind: 'ev', ratedKW: 7.4, floor: CAMPUS_FLOOR, x: 14, y: 23, roomId: 'PARKING', blockId: 'CAMPUS' },
  { id: 'EV-3', name: 'Staff EV Charger 3', kind: 'ev', ratedKW: 7.4, floor: CAMPUS_FLOOR, x: 16, y: 23, roomId: 'PARKING', blockId: 'CAMPUS' },
  { id: 'EV-4', name: 'Staff EV Charger 4', kind: 'ev', ratedKW: 7.4, floor: CAMPUS_FLOOR, x: 18, y: 23, roomId: 'PARKING', blockId: 'CAMPUS' },
  { id: 'EBUS-1', name: 'College Bus Charger 1', kind: 'ebus', ratedKW: 60, floor: CAMPUS_FLOOR, x: 13, y: 25.5, roomId: 'PARKING', blockId: 'CAMPUS' },
  { id: 'EBUS-2', name: 'College Bus Charger 2', kind: 'ebus', ratedKW: 60, floor: CAMPUS_FLOOR, x: 17, y: 25.5, roomId: 'PARKING', blockId: 'CAMPUS' },
];
export const EQUIPMENT_BY_ID = Object.fromEntries(EQUIPMENT.map((e) => [e.id, e]));

// Start just inside the main gate, facing the Main Block.
export const PLAYER_START = { floor: CAMPUS_FLOOR, x: 25.5, y: 25.5 };

export function tileAt(floor, x, y) {
  const f = FLOORS[floor];
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!f || ty < 0 || ty >= ROWS || tx < 0 || tx >= COLS) return TILE.WALL;
  return f.grid[ty][tx];
}

export function isWalkable(floor, x, y) {
  return tileAt(floor, x, y) !== TILE.WALL;
}

// Room (or corridor / campus zone) containing a point, or null when standing in a doorway.
export function roomAt(floor, x, y) {
  const f = FLOORS[floor];
  if (!f) return null;
  for (const r of f.rooms) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  const c = f.corridor;
  if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c;
  return null;
}

// Portal the point is standing on, if any: { portal, to: 'inside'|'outside' }.
export function portalAt(floor, x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  for (const p of PORTALS) {
    if (p.outside.floor === floor && p.outside.x === tx && p.outside.y === ty) return { portal: p, to: 'inside', arrive: p.insideArrive };
    if (p.inside.floor === floor && p.inside.x === tx && p.inside.y === ty) return { portal: p, to: 'outside', arrive: p.outsideArrive };
  }
  return null;
}
