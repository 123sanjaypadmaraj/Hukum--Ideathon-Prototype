// Population and daily plan for the NHCE campus occupancy simulation: who is
// on campus, the class timetable, campus events (auditorium, PE, gym ...),
// and where everybody should be at any minute.
import { CONFIG } from '../config.js';
import { ROOMS, ROOM_BY_ID, FLOORS } from '../building.js';
import { TEACHING_CORRIDORS } from './occ-geo.js';

const C = CONFIG.occupancy;
// Nine one-hour teaching slots: 50 min class + 10 min break.
export const SLOTS = Array.from({ length: 9 }, (_, k) => ({ k, start: C.classStart + 60 * k, end: C.classStart + 60 * k + 50 }));
export const PERIOD0 = C.classStart - 10;          // 08:35, first "slot change"

// Relative demand per slot (lunch slot 12:45 is light, late afternoon tapers).
const SLOT_SHAPE = [0.7, 0.95, 0.9, 0.75, 0.3, 0.7, 0.8, 0.55, 0.35];

// The deck's "2 PM: Lab 3 empty 10 min, power off" moment, on this campus.
export const DEMO_LAB = 'AIML-LAB';

const SUBJECTS = {
  CSE: ['Data Structures', 'Operating Systems', 'Computer Networks', 'Compiler Design', 'Software Engineering'],
  ISE: ['Database Systems', 'Web Technologies', 'Cloud Computing', 'Information Security'],
  AIML: ['Machine Learning', 'Deep Learning', 'Natural Language Processing', 'Computer Vision'],
  ECE: ['Signals and Systems', 'Digital Electronics', 'VLSI Design', 'Communication Systems', 'Microcontrollers'],
  EEE: ['Power Systems', 'Electrical Machines', 'Power Electronics', 'Control Systems'],
  ME: ['Thermodynamics', 'Fluid Mechanics', 'Machine Design', 'Manufacturing Processes'],
  CV: ['Structural Analysis', 'Geotechnical Engineering', 'Surveying', 'Concrete Technology'],
  MBA: ['Marketing Management', 'Financial Accounting', 'Organisational Behaviour', 'Business Analytics'],
  MCA: ['Java Programming', 'Data Mining', 'Mobile Applications', 'Python for Analytics'],
  BS: ['Engineering Mathematics I', 'Engineering Physics', 'Engineering Chemistry', 'Basic Electrical Engineering', 'Communicative English'],
};
const LAB_SUBJECT = {
  'CSE-LAB1': 'Programming Lab', 'CSE-LAB2': 'Systems Lab', 'AIML-LAB': 'Deep Learning Lab (GPU)', 'ISE-LAB': 'Web Technologies Lab',
  'ECE-LAB1': 'Analog & Digital Lab', 'ECE-LAB2': 'Microcontrollers Lab', 'EEE-LAB': 'Machines Lab', 'IDEA-LAB': 'AICTE Idea Lab: prototyping',
  'COE-LAB': 'Industry Skill Lab', 'ME-WS': 'Workshop Practice', 'ME-CAD': 'CAD / CAM Lab', 'CV-LAB': 'Materials Testing',
  'FLUID-LAB': 'Fluid Mechanics Lab', 'SURVEY-LAB': 'Surveying Practice', 'MCA-LAB': 'Programming Lab', 'PHY-LAB': 'Physics Lab', 'CHEM-LAB': 'Chemistry Lab',
};
const SEMS = ['3rd sem', '5th sem', '7th sem'];

const FIRST = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Rahul', 'Priya', 'Karthik', 'Meera',
  'Aditya', 'Isha', 'Nikhil', 'Pooja', 'Siddharth', 'Riya', 'Varun', 'Neha', 'Harsh', 'Divya', 'Manoj', 'Shruti', 'Tejas',
  'Lakshmi', 'Abhishek', 'Nandini', 'Suresh', 'Anjali', 'Pranav', 'Bhavya', 'Gautam', 'Swathi', 'Kiran', 'Deepa', 'Yash',
  'Ritika', 'Naveen', 'Sanjana', 'Imran', 'Fatima', 'Joseph', 'Sara', 'Gurpreet', 'Harini', 'Chetan', 'Spoorthi', 'Darshan', 'Akshata'];
const LAST = ['Sharma', 'Rao', 'Iyer', 'Reddy', 'Nair', 'Patel', 'Gowda', 'Kumar', 'Singh', 'Menon', 'Das', 'Joshi', 'Hegde', 'Shetty', 'Pillai', 'Khan', 'Murthy', 'Bhat'];
const SHIRTS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab17d', '#f4a261', '#6d597a', '#b56576', '#4d908e', '#577590', '#f28482', '#84a59d', '#c9ada7', '#90be6d', '#43aa8b'];

export const ROLE_COLOR = { staff: '#d4d8de', guard: '#1f3a93', cleaner: '#16a085' };

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const U = (rng, a, b) => a + rng() * (b - a);

// Halls that are booked as events / meetings rather than by the slot timetable.
const MEETING_ROOMS = new Set(['MB-CONF', 'MB-VC']);
const TEACHING_ROOMS = ROOMS.filter((r) => r.timetabled && !MEETING_ROOMS.has(r.id));
const DEPT_OFFICES = ['CSE-DEPT', 'ECE-DEPT', 'ME-DEPT', 'NSB-FAC', 'NSC-DEPT'].filter((id) => ROOM_BY_ID[id]);

function deptOf(roomId) {
  const p = roomId.split('-')[0];
  if (SUBJECTS[p]) return p;
  if (p === 'EEE') return 'EEE';
  if (p === 'IDEA' || p === 'COE') return 'ECE';
  if (p === 'FLUID') return 'ME';
  if (p === 'SURVEY') return 'CV';
  if (p === 'PHY' || p === 'CHEM' || p === 'NSC') return 'BS';
  if (p === 'SVP') return 'ECE';
  return 'BS';
}

export function createAgents(rng) {
  const agents = [];
  let n = 0;
  const mk = (role, sub, name, color, speed, extra = {}) => {
    const a = {
      id: `P${String(++n).padStart(4, '0')}`, name, role, sub, color,
      floor: 0, x: 0, y: 0, roomId: null, targetRoomId: null, path: [], seated: false,
      facing: 0, moving: false, activity: 'Off campus',
      // internal
      onSite: false, speed, laneY: U(rng, 13.0, 16.0), confBase: U(rng, 0.8, 0.95),
      actKey: null, act: null, seat: null, waitUntil: 0, dwellUntil: 0, missUntil: -1, transitLeft: null, pIdx: Math.floor(rng() * 12),
      via: 'gate', home: null, events: [],
      ...extra,
    };
    agents.push(a);
    return a;
  };
  const person = () => `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
  for (let i = 0; i < 760; i++) mk('student', 'student', person(), pick(rng, SHIRTS), U(rng, 20, 27), { via: rng() < 0.3 ? 'bus' : 'gate' });
  for (let i = 0; i < 60; i++) {
    const home = DEPT_OFFICES[i % DEPT_OFFICES.length];
    mk('staff', 'faculty', `${rng() < 0.5 ? 'Dr.' : 'Prof.'} ${pick(rng, FIRST)} ${pick(rng, LAST)}`, ROLE_COLOR.staff, U(rng, 18, 23),
      { via: 'car', home, blockId: ROOM_BY_ID[home].blockId });
  }
  const staff = (count, sub, home, label, color = '#a8b5c4', extra = {}) => {
    for (let i = 0; i < count; i++) mk('staff', sub, `${person()}${label ? ` (${label})` : ''}`, color, U(rng, 17, 22), { via: 'car', home, ...extra });
  };
  staff(8, 'office', 'MB-ADMIN', 'Admin');
  staff(4, 'office', 'PLACEMENT', 'Placement Cell');
  staff(3, 'bank', 'BANK', 'Indian Bank');
  staff(2, 'medical', 'SANJEEVINI', 'Sanjeevini', '#f0f6ff');
  staff(1, 'office', 'AUD-AV', 'AV technician');
  staff(2, 'librarian', 'MB-LIB', 'Librarian', '#c0a6d8');
  staff(5, 'canteen', 'CAFE', 'Cafeteria', '#f1f1f1', { via: 'gate' });
  staff(2, 'control', 'MB-CCTV', 'Security control room', ROLE_COLOR.guard, { role: 'guard', via: 'gate' });
  for (const a of agents.slice(-2)) a.role = 'guard';
  mk('guard', 'gate', 'Basavaraj (Gate security)', ROLE_COLOR.guard, 12, { home: 'GATE' });
  mk('guard', 'patrol-night', 'Ramesh (Security patrol)', ROLE_COLOR.guard, 13);
  mk('guard', 'patrol-day', 'Mahesh (Security patrol)', ROLE_COLOR.guard, 13);
  const routes = cleanRoutes();
  routes.forEach((route, i) => mk('cleaner', 'cleaner', `${['Lakshmamma', 'Gowramma', 'Shanthamma'][i % 3]} (Housekeeping)`, ROLE_COLOR.cleaner, 15, { route }));
  return agents;
}

function cleanRoutes() {
  const groups = [['MB'], ['SVP', 'NSB'], ['NSC', 'AUD', 'AMN']];
  return groups.map((g) => ROOMS.filter((r) => g.includes(r.blockId) && (r.timetabled || r.type === 'office' || r.type === 'auditorium')).map((r) => r.id));
}

// ---------------------------------------------------------------- day plan
export function buildDayPlan(day, rng, agents) {
  const prob = C.slotOccupancyProb;
  const timetable = {};
  for (const r of TEACHING_ROOMS) {
    const dept = deptOf(r.id);
    timetable[r.id] = SLOTS.map((s, k) => {
      let p, size, subject;
      if (r.type === 'seminar') {                    // exam hall / department seminar hall
        p = 0.25;
        size = r.id === 'NSC-EXAM' ? U(rng, 60, 100) : U(rng, 30, 55);
        subject = r.id === 'NSC-EXAM' ? 'Internal Assessment Test' : 'Department Seminar';
      } else if (r.type === 'lab' || r.type === 'workshop') {
        p = prob * SLOT_SHAPE[k] * 0.85;
        size = U(rng, 14, Math.min(28, r.seats || 30));
        subject = LAB_SUBJECT[r.id] || 'Lab session';
      } else {
        p = prob * SLOT_SHAPE[k];
        size = U(rng, 20, 40);
        subject = pick(rng, SUBJECTS[dept] || SUBJECTS.BS);
      }
      if (rng() >= Math.min(0.95, p)) return null;
      const group = `${dept} ${pick(rng, SEMS)} ${'ABC'[Math.floor(rng() * 3)]}`;
      return { k, roomId: r.id, subject, group, size: Math.min(r.seats || 60, Math.round(size)), linger: U(rng, 0, 2.5), teacher: null, students: 0 };
    });
  }
  // Demo moment: the 12:45 AI & ML lab runs over to ~13:49, nothing booked at 13:45.
  if (timetable[DEMO_LAB]) {
    const t = timetable[DEMO_LAB];
    if (!t[4]) t[4] = { k: 4, roomId: DEMO_LAB, subject: LAB_SUBJECT[DEMO_LAB], group: 'AIML 5th sem A', size: 24, linger: 0, teacher: null, students: 0 };
    t[4].linger = 14;
    t[5] = null;
    if (!t[6]) t[6] = { k: 6, roomId: DEMO_LAB, subject: LAB_SUBJECT[DEMO_LAB], group: 'AIML 7th sem B', size: 20, linger: 1, teacher: null, students: 0 };
  }

  const students = agents.filter((a) => a.role === 'student');
  const faculty = agents.filter((a) => a.sub === 'faculty');

  for (const s of students) {
    const startK = Math.min(5, Math.floor(rng() * rng() * 6));
    s.span0 = startK; s.span1 = Math.min(8, startK + 3 + Math.floor(rng() * 6));
    s.cls = new Array(9).fill(null);
    s.free = new Array(11).fill(null);
    s.events = [];
  }
  for (const f of faculty) { f.teach = new Array(9).fill(null); f.events = []; }

  for (let k = 0; k < 9; k++) {
    const order = shuffle(students.slice(), rng);
    order.sort((a, b) => elig(b, k) - elig(a, k));
    let cursor = 0;
    const busy = new Set();
    for (const r of TEACHING_ROOMS) {
      const cls = timetable[r.id][k];
      if (!cls) continue;
      for (let i = 0; i < cls.size && cursor < order.length; i++) { order[cursor++].cls[k] = r.id; cls.students++; }
      // Teacher: prefer faculty of the same block.
      let f = faculty.find((x) => !busy.has(x) && x.blockId === r.blockId && rng() < 0.7) || faculty.find((x) => !busy.has(x));
      if (f) { busy.add(f); f.teach[k] = r.id; cls.teacher = f.name; }
    }
  }

  // ---- campus events
  const events = [];
  // members take part with `kind`; staff take part with `staffKind` (speakers stand at the front).
  const ev = (id, roomId, start, end, kind, label, members, staffList = [], staffKind = 'board') => {
    const e = { id, roomId, start, end, kind, label, count: 0 };
    events.push(e);
    for (const m of members) { m.events.push(e); clearOverlap(m, start, end); e.count++; }
    const se = staffKind === kind ? e : { ...e, kind: staffKind };
    for (const s of staffList) { s.events.push(se); clearOverlap(s, start, end); e.count++; }
    return e;
  };
  const pool = (n, filter = () => true) => shuffle(students.filter(filter), rng).slice(0, n);
  const fpool = (n) => shuffle(faculty.slice(), rng).slice(0, n);
  const lectureTopic = pick(rng, ['Guest Lecture: Smart Grids and Demand Response', 'Guest Lecture: AI at the Edge', 'Industry Talk: EVs and Battery Storage', 'Alumni Talk: Building Startups']);
  ev('aud-lecture', 'AUD-HALL', 600, 720, 'seat', `Attending ${lectureTopic}`, pool(400, (s) => s.span0 <= 2 && s.span1 >= 2), fpool(2));
  ev('aud-rehearsal', 'AUD-HALL', 960, 1020, 'stage', 'Cultural fest rehearsal', pool(80, (s) => s.span1 >= 6));
  ev('pe-1', 'SPORTS', 900, 960, 'wander', 'PE class on the sports ground', pool(35, (s) => s.span1 >= 6), fpool(1));
  ev('pe-2', 'SPORTS', 960, 1050, 'wander', 'Athletics practice on the track', pool(50, (s) => s.span1 >= 7), fpool(1));
  ev('bball', 'BBALL', 1030, 1110, 'wander', 'Playing basketball', pool(14));
  ev('gym-am', 'GYM', 420, 505, 'wander', 'Morning workout at the gym', pool(30, (s) => s.span0 === 0));
  ev('gym-pm', 'GYM', 990, 1140, 'wander', 'Evening workout at the gym', pool(35));
  ev('nirvana', 'NIRVANA', 1035, 1140, 'seat', 'Unwinding at Nirvana', pool(25));
  ev('conf', 'MB-CONF', 660, 720, 'seat', 'Department heads meeting', [], fpool(10), 'seat');
  ev('vc', 'MB-VC', 870, 930, 'seat', 'Video conference with industry partners', [], fpool(8), 'seat');

  // ---- arrival / departure windows
  for (const s of students) {
    let first = Infinity, last = -Infinity;
    s.cls.forEach((c, k) => { if (c) { first = Math.min(first, SLOTS[k].start); last = Math.max(last, SLOTS[k].end + timetable[c][k].linger); } });
    for (const e of s.events) { first = Math.min(first, e.start); last = Math.max(last, e.end); }
    if (!Number.isFinite(first)) {
      if (rng() < 0.12) { s.arrive = U(rng, 600, 840); s.depart = s.arrive + U(rng, 60, 180); }
      else { s.arrive = 9999; s.depart = -1; }
    } else {
      // Walk-ins through the main gate trickle in from 08:00.
      s.arrive = Math.max(first <= 540 && first > 480 ? 480 : 0, first - (first <= 540 ? U(rng, 5, 45) : U(rng, 5, 25)));
      s.depart = Math.min(last + (rng() < 0.2 ? U(rng, 40, 110) : U(rng, 1, 20)), 19 * 60 + 45);
    }
    if (s.via === 'bus') {                          // college buses
      const inBus = [470, 490, 510];
      const outBus = [1075, 1100, 1160];
      if (s.arrive < 600) s.arrive = inBus.filter((b) => b <= s.arrive).pop() ?? inBus[0];
      if (s.depart > 1060) s.depart = outBus.find((b) => b >= s.depart) ?? outBus[outBus.length - 1];
      s.depart = Math.max(s.depart, s.arrive + 1);
    }
    for (let i = 0; i < 11; i++) s.free[i] = freeChoice(rng, i);
  }
  for (const f of faculty) {
    f.arrive = U(rng, 495, 520); f.depart = U(rng, 1050, 1100); f.lunch = rng() < 0.5;
  }
  for (const a of agents) {
    switch (a.sub) {
      case 'office': a.arrive = U(rng, 525, 545); a.depart = U(rng, 1050, 1080); a.lunch = rng() < 0.6; break;
      case 'bank': a.arrive = U(rng, 550, 565); a.depart = U(rng, 990, 1010); a.lunch = rng() < 0.5; break;
      case 'medical': a.arrive = U(rng, 505, 515); a.depart = U(rng, 1045, 1055); break;
      case 'librarian': a.arrive = 500; a.depart = 1190; break;
      case 'canteen': a.arrive = U(rng, 445, 460); a.depart = U(rng, 1075, 1090); break;
      case 'control': case 'gate': case 'patrol-night': a.arrive = 0; a.depart = 1441; break;
      case 'patrol-day': a.arrive = 450; a.depart = 1140; break;
      case 'cleaner': a.arrive = 420; a.depart = 1180; break;
      default: break;
    }
  }
  return { day, timetable, events };
}

function clearOverlap(a, start, end) {
  const list = a.cls || a.teach;
  if (!list) return;
  for (let k = 0; k < 9; k++) if (list[k] && SLOTS[k].start < end && SLOTS[k].end > start) list[k] = null;
}

function elig(s, k) { return s.span0 <= k && k <= s.span1 ? 1 : 0; }

// Where a student goes when they have no class in this period.
// Period index i: 0 = before 08:35, 1..9 = slot periods, 10 = after classes.
function freeChoice(rng, i) {
  const r = rng();
  const w = (table) => { let acc = 0; for (const [p, v] of table) { acc += v; if (r < acc) return p === '@COR' ? pick(rng, TEACHING_CORRIDORS) : p; } return 'MB-LIB'; };
  if (i === 0) return w([['CAFE', 0.45], ['MB-LIB', 0.15], ['MB-LOBBY', 0.12], ['@COR', 0.28]]);
  if (i === 5 || i === 6) return w([['CAFE', 0.45], ['NIRVANA', 0.12], ['MB-LIB', 0.12], ['BBALL', 0.04], ['SPORTS', 0.04], ['AUD-FOYER', 0.03], ['BANK', 0.02], ['SANJEEVINI', 0.01], ['@COR', 0.15], ['MB-LOBBY', 0.02]]);
  if (i === 8) return w([['CAFE', 0.4], ['MB-LIB', 0.25], ['NIRVANA', 0.08], ['@COR', 0.22], ['PARKING', 0.05]]);
  if (i === 10) return w([['MB-LIB', 0.5], ['CAFE', 0.2], ['NIRVANA', 0.15], ['BBALL', 0.08], ['MB-LOBBY', 0.07]]);
  return w([['MB-LIB', 0.35], ['CAFE', 0.15], ['@COR', 0.3], ['NIRVANA', 0.08], ['BANK', 0.02], ['SANJEEVINI', 0.01], ['MB-LOBBY', 0.04], ['PARKING', 0.05]]);
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// ---- desired activity at a given minute of day -------------------------------

export const AWAY = { key: 'away', kind: 'away', roomId: null, label: 'Off campus' };
const SEAT_PLACES = new Set(['MB-LIB', 'CAFE', 'NIRVANA']);
const PLACE_LABEL = {
  'MB-LIB': 'Studying in the Library & Information Centre', CAFE: 'At the cafeteria', NIRVANA: 'At Nirvana Recreation Centre',
  BBALL: 'Shooting hoops on the basketball court', SPORTS: 'Hanging out at the sports ground', 'AUD-FOYER': 'Waiting in the auditorium foyer',
  BANK: 'At the Indian Bank ATM', SANJEEVINI: 'Visiting Sanjeevini medical room', 'MB-LOBBY': 'Hanging out in the Main Block lobby',
  PARKING: 'Waiting at the bus bay',
};
// Two-level cache (kind -> roomId -> label) so the per-step lookup never allocates.
const actCache = new Map();
function cached(kind, roomId, label, make) {
  let byRoom = actCache.get(kind);
  if (!byRoom) actCache.set(kind, (byRoom = new Map()));
  let byLabel = byRoom.get(roomId);
  if (!byLabel) byRoom.set(roomId, (byLabel = new Map()));
  let a = byLabel.get(label);
  if (!a) { a = make(); a.key = `${kind}:${roomId}:${label}`; byLabel.set(label, a); }
  return a;
}

const periodOf = (mod) => (mod < PERIOD0 ? -1 : Math.min(9, Math.floor((mod - PERIOD0) / 60)));

// Cached on the class object itself so labels never leak between days.
function classAct(roomId, c, kind) {
  c.acts ||= {};
  return (c.acts[kind] ||= {
    key: `${kind}:${roomId}:${c.k}`, kind, roomId, delay: kind === 'seat' ? 4 : 1.5,
    label: kind === 'seat' ? `In class: ${c.subject} (${c.group})` : `Teaching ${c.subject} (${c.group})`,
  });
}
function eventAct(e) {
  return (e.act ||= { key: `E:${e.id}:${e.kind}`, kind: e.kind, roomId: e.roomId, label: e.kind === 'board' ? `Speaking: ${e.label.replace(/^Attending /, '')}` : e.label, delay: 2 });
}
function freeAct(place) {
  return cached('F', place, '', () => ({
    kind: SEAT_PLACES.has(place) ? 'seat' : 'wander', roomId: place, delay: 3,
    label: PLACE_LABEL[place] || (place.startsWith('COR-') ? 'Chatting in the corridor' : `At ${place}`),
  }));
}
const seatAct = (roomId, label) => cached('S', roomId, label, () => ({ kind: 'seat', roomId, label, delay: 1 }));
const standAct = (roomId, label) => cached('A', roomId, label, () => ({ kind: 'stand', roomId, label, delay: 0 }));
const wanderAct = (roomId, label) => cached('W', roomId, label, () => ({ kind: 'wander', roomId, label, delay: 1 }));
const cleanAct = (roomId) => cached('K', roomId, '', () => ({ kind: 'clean', roomId, label: `Cleaning ${ROOM_BY_ID[roomId] ? ROOM_BY_ID[roomId].name : roomId}`, delay: 0 }));
const PATROL = { key: 'patrol', kind: 'patrol', roomId: null, label: 'Patrolling the campus', delay: 0 };

function teachingAct(list, mod, plan, kind) {
  const p = periodOf(mod);
  if (p >= 1) {
    const prev = list[p - 1];
    if (prev) { const c = plan.timetable[prev][p - 1]; if (mod < SLOTS[p - 1].end + c.linger) return classAct(prev, c, kind); }
  }
  if (p === -1 && mod < PERIOD0 - 10) return null;     // breakfast first, class from 08:25
  const k = p === -1 ? 0 : p;
  if (k <= 8 && list[k]) return classAct(list[k], plan.timetable[list[k]][k], kind);
  return null;
}

function eventNow(a, mod) {
  for (const e of a.events) if (mod >= e.start && mod < e.end) return eventAct(e);
  return null;
}

export function desiredAct(a, mod, plan) {
  if (!(mod >= a.arrive && mod < a.depart)) return AWAY;
  switch (a.sub) {
    case 'student': {
      const e = a.events.length ? eventNow(a, mod) : null;
      if (e) return e;
      const t = teachingAct(a.cls, mod, plan, 'seat');
      if (t) return t;
      return freeAct(a.free[periodOf(mod) + 1]);
    }
    case 'faculty': {
      const e = a.events.length ? eventNow(a, mod) : null;
      if (e) return e;
      const t = teachingAct(a.teach, mod, plan, 'board');
      if (t) return t;
      if (a.lunch && mod >= 765 && mod < 805) return seatAct('CAFE', 'Lunch at the cafeteria');
      return seatAct(a.home, 'In the department office');
    }
    case 'office': case 'bank':
      if (a.lunch && mod >= 780 && mod < 820) return seatAct('CAFE', 'Lunch at the cafeteria');
      return seatAct(a.home, a.sub === 'bank' ? 'At the bank counter' : 'Working in the office');
    case 'medical': return seatAct(a.home, 'On duty at Sanjeevini');
    case 'control': return seatAct(a.home, 'Watching the CCTV wall');
    case 'librarian': return standAct(a.home, 'At the library desk');
    case 'canteen': return standAct(a.home, 'Serving at the cafeteria counter');
    case 'gate': return standAct('GATE', 'On duty at the main gate');
    case 'patrol-night': case 'patrol-day': return PATROL;
    case 'cleaner': {
      const r = a.route;
      if (mod < 510) return cleanAct(r[Math.floor((mod - 420) / 5) % r.length]);
      if (mod >= 1070) return cleanAct(r[Math.min(r.length - 1, Math.floor((mod - 1070) / 5))]);
      if (mod >= 780 && mod < 810) return seatAct('CAFE', 'Lunch break');
      const cors = a.corridors ||= [...new Set(r.map((id) => FLOORS[ROOM_BY_ID[id].floor].corridor.id))];
      return wanderAct(cors[Math.floor(mod / 45) % cors.length], 'Cleaning the corridor');
    }
    default: return AWAY;
  }
}

