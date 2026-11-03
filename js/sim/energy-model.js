// Physical / behavioural profiles used by the energy layer for the NHCE
// campus: solar (campus total + per-block split), the aggregated hostels /
// faculty quarters / campus lighting load, HVAC baselines, water use, EV and
// college-bus sessions. Pure functions + small generators, no state mutation.
// Pure functions + small generators, no state mutation here.
import { CONFIG, mulberry32 } from '../config.js';
import { ROOMS, BLOCKS, SITE } from '../building.js';

export const DIESEL_RS = 26;            // Rs/kWh, diesel genset (Resilience Mode, last resort)
export const CO2_KG_PER_KWH = 0.71;
export const DEMAND_CHARGE_PER_KW_DAY = CONFIG.tariff.demandChargePerKVAMonth / 30; // ~Rs 13.3 per kW of daily peak
export const EV_PACK_KWH = 40;
export const BUS_PACK_KWH = 300;

// ---------- static room aggregates ----------
// Every room in building.js is metered directly (its own loadKW from the
// occupancy layer). Only what is not modelled room by room is aggregated:
//  - classrooms beyond the explicit ones, up to CONFIG.campus.classrooms
//    (scaled from the explicit classrooms so camera auto-off shows up there too;
//    assumed mostly fan-cooled, so each draws AGG_LOAD_SHARE of an explicit one),
//  - hostels and faculty quarters (SITE.offsite), campus street lighting,
//  - sports floodlights (17:30-20:30, camera-gated and dimmable by HUKUM).
export const roomFullKW = (r) => (r.loads.lightsKW || 0) + (r.loads.fansKW || 0) + (r.loads.acKW || 0) + (r.loads.equipKW || 0);
export const CLASSROOM_IDS = ROOMS.filter((r) => r.type === 'classroom').map((r) => r.id);
export const TIMETABLED_IDS = ROOMS.filter((r) => r.timetabled).map((r) => r.id);
export const AGG_LOAD_SHARE = 0.5;
export const AGG_CLASSROOMS = Math.max(0, CONFIG.campus.classrooms - CLASSROOM_IDS.length);
// false: the aggregated classrooms have no HUKUM cameras (proposal covers the modelled blocks).
export const AGG_AUTO_OFF = false;
export const AGG_CLASS_FACTOR = AGG_LOAD_SHARE * AGG_CLASSROOMS / Math.max(1, CLASSROOM_IDS.length);
// Kept powered in Resilience Mode (labs: experiments and equipment in progress).
export const CRITICAL_TYPES = new Set(['server', 'core', 'electrical', 'lab', 'medical', 'security', 'gate', 'parking']);
// Rooms whose cooling the two HVAC assets pre-cool.
const coolable = (r) => (r.loads.acKW || 0) > 0 && r.type !== 'server' && !r.outdoor;
export const PRECOOL_ROOMS_BY_HVAC = {
  'AHU-A': ROOMS.filter((r) => coolable(r) && r.blockId === 'MB').map((r) => r.id),
  'HVAC-BD': ROOMS.filter((r) => coolable(r) && r.blockId !== 'MB').map((r) => r.id),
};
export const EXPLICIT_FULL_KW = ROOMS.reduce((s, r) => s + roomFullKW(r), 0);
export const CLASS_FULL_KW = ROOMS.filter((r) => r.type === 'classroom').reduce((s, r) => s + roomFullKW(r), 0);
export const SERVER_KW = ROOMS.filter((r) => r.type === 'server' || r.type === 'core' || r.type === 'electrical' || r.type === 'security').reduce((s, r) => s + roomFullKW(r), 0);

// ---------- per-block metering ----------
// NHCE has one energy meter per block. Extra meters: CAMPUS (outdoor zones,
// street lights, floodlights, EV / bus chargers), HOSTELS (hostels + faculty
// quarters + their share of the aggregated HVAC), PLANT (Main Block roof
// chiller / AHU and water pumps).
export const METER_IDS = [...BLOCKS.map((b) => b.id), 'CAMPUS', 'HOSTELS', 'PLANT'];
const acByBlock = {};
for (const r of ROOMS) if (r.blockId && r.blockId !== 'MB' && r.blockId !== 'CAMPUS') acByBlock[r.blockId] = (acByBlock[r.blockId] || 0) + (r.loads.acKW || 0);
const acTotal = Object.values(acByBlock).reduce((a, b) => a + b, 0) || 1;
export const HVAC_BD_HOSTEL_SHARE = 0.4;
// Share of the aggregated "other blocks & hostels" HVAC per meter.
export const HVAC_BD_SPLIT = Object.fromEntries([
  ['HOSTELS', HVAC_BD_HOSTEL_SHARE],
  ...Object.entries(acByBlock).map(([b, kw]) => [b, (1 - HVAC_BD_HOSTEL_SHARE) * kw / acTotal]),
]);
const classByBlock = {};
for (const r of ROOMS) if (r.type === 'classroom') classByBlock[r.blockId] = (classByBlock[r.blockId] || 0) + 1;
// Aggregated extra classrooms are spread over the blocks that have classrooms.
export const AGG_CLASS_SPLIT = Object.fromEntries(Object.entries(classByBlock).map(([b, n]) => [b, n / Math.max(1, CLASSROOM_IDS.length)]));

// ---------- solar split ----------
// The PV asset stays the campus total (HUKUM model: 900 kWp, a proposal with
// expansion). Existing arrays from NHCE's green audit: SVP 25 kWp (off-grid
// with battery) and NSB (size not published; 30 kWp assumed). The remainder is
// the HUKUM rooftop expansion, spread over MB, SVP, NSB, NSC and AUD by roof area.
export const SOLAR_EXISTING = [
  { blockId: 'SVP', kWp: 25, existing: true },
  { blockId: 'NSB', kWp: 30, existing: true },
];
const EXPANSION_BLOCKS = ['MB', 'SVP', 'NSB', 'NSC', 'AUD'].filter((id) => BLOCKS.some((b) => b.id === id));
const roofArea = (id) => { const f = SITE.footprints.find((x) => x.blockId === id); return f ? f.w * f.h : 1; };
const expansionKWp = Math.max(0, CONFIG.solar.kWp - SOLAR_EXISTING.reduce((a, x) => a + x.kWp, 0));
const areaSum = EXPANSION_BLOCKS.reduce((a, id) => a + roofArea(id), 0) || 1;
export const SOLAR_SPLIT = [
  ...SOLAR_EXISTING,
  ...EXPANSION_BLOCKS.map((id) => ({ blockId: id, kWp: Math.round((expansionKWp * roofArea(id)) / areaSum * 10) / 10, existing: false })),
];

// ---------- helpers ----------
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const inPeak = (mod) => mod >= CONFIG.tariff.peakHours[0] * 60 && mod < CONFIG.tariff.peakHours[1] * 60;
export const inSolarTariff = (mod) => mod >= CONFIG.tariff.solarHours[0] * 60 && mod < CONFIG.tariff.solarHours[1] * 60;

// Piecewise-linear interpolation over 24 hourly points (wraps at midnight).
function hourly(points, mod) {
  const h = (mod / 60) % 24;
  const i = Math.floor(h), f = h - i;
  return points[i] * (1 - f) + points[(i + 1) % 24] * f;
}

// ---------- hostels, faculty quarters, campus lighting (aggregated) ----------
// kW per hour of day. Several thousand residents: big morning (geysers, mess)
// and evening peaks, a substantial base through the day and night (mess
// kitchens, laundry, water heating, common-area lighting, faculty quarters).
const HOSTEL_SHAPE = [
  126, 124, 122, 122, 122, 126, 140, 146, 104, 55, 45, 45,
  48, 46, 45, 45, 48, 60, 78, 92, 108, 118, 124, 126,
];
const STREET_SHAPE = [
  14, 14, 14, 14, 14, 14, 8, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 2, 12, 14, 14, 14, 14, 14,
];
export const HOSTEL_SCALE = CONFIG.campus.otherBlocksBaseKW / 140;
export function hostelsKW(mod) { return HOSTEL_SCALE * hourly(HOSTEL_SHAPE, mod); }
export function streetLightsKW(mod) { return hourly(STREET_SHAPE, mod); }
// Everything aggregated except floodlights (which are dispatchable).
export function otherBlocksKW(mod) { return hostelsKW(mod) + streetLightsKW(mod); }

// Sports ground + basketball floodlights: on 17:30-20:30 in the baseline.
export const FLOOD_KW = 12;
export const FLOOD_ON = 17 * 60 + 30, FLOOD_OFF = 20 * 60 + 30;
export const floodBaselineKW = (mod) => (mod >= FLOOD_ON && mod < FLOOD_OFF ? FLOOD_KW : 0);
export const SPORTS_ZONE_IDS = ROOMS.filter((r) => r.type === 'sports').map((r) => r.id);

// ---------- HVAC baselines ----------
// Main Block central chiller / AHU (library, conference and VC halls).
const AHU_SHAPE = [6, 6, 6, 6, 6, 6, 8, 14, 26, 34, 38, 42, 46, 48, 50, 48, 42, 30, 22, 22, 22, 14, 8, 6];
// Other blocks' common areas + hostels / mess cooling (block rooms carry their own split ACs).
const BD_SHAPE = [22, 20, 20, 20, 20, 22, 26, 28, 24, 22, 22, 24, 26, 26, 26, 24, 24, 26, 30, 32, 34, 32, 28, 24];
const WEATHER_COOL = { sunny: 1, cloudy: 0.86, monsoon: 0.72 };
export function hvacBaselineKW(equipId, mod, weather) {
  const w = WEATHER_COOL[weather] ?? 1;
  const shape = equipId === 'AHU-A' ? AHU_SHAPE : BD_SHAPE;
  const base = hourly(shape, mod);
  // Only the weather-dependent (daytime) part scales.
  const night = shape[3];
  return night + (base - night) * w;
}

// ---------- water use (fraction of tank per minute) ----------
const WATER_SHAPE = [
  0.2, 0.15, 0.15, 0.15, 0.2, 0.6, 1.6, 2.0, 1.6, 1.0, 0.9, 0.9,
  1.2, 1.1, 0.9, 0.9, 1.0, 1.2, 1.4, 1.3, 1.1, 0.8, 0.5, 0.3,
];
const WATER_SUM = WATER_SHAPE.reduce((a, b) => a + b, 0);
export const DAILY_WATER_USE = 0.5;       // tanks drain ~50% per day
export const PUMP_FILL_PER_HOUR = 0.3;    // fraction of tank per hour at rated kW
export function waterUsePerMin(mod) {
  return (DAILY_WATER_USE * hourly(WATER_SHAPE, mod)) / (WATER_SUM * 60);
}

// ---------- solar ----------
export const WEATHER_FACTOR = { sunny: 0.8, cloudy: 0.47, monsoon: 0.2 };   // expected peak / kWp
export const WEATHER_SPREAD = { sunny: 0.07, cloudy: 0.32, monsoon: 0.4 };
export function clearSky(mod) {
  const x = (mod - 380) / 740;               // 06:20 -> 18:40
  if (x <= 0 || x >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * x), 1.2);
}

function smoothNoise(rng, len, every) {
  const knots = Array.from({ length: Math.ceil(len / every) + 2 }, () => rng() * 2 - 1);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const k = i / every, j = Math.floor(k), f = k - j;
    const s = f * f * (3 - 2 * f);
    out[i] = knots[j] * (1 - s) + knots[j + 1] * s;
  }
  return out;
}

// Per-minute cloud multiplier for one day and one weather type.
export function makeCloudCurve(seed, dayIdx, weather) {
  const rng = mulberry32((seed ^ (dayIdx * 7919) ^ (weather.length * 104729)) >>> 0);
  const slow = smoothNoise(rng, 1440, 45);
  const fast = smoothNoise(rng, 1440, 6);
  const out = new Float32Array(1440);
  const peak = WEATHER_FACTOR[weather] ?? 0.8;
  for (let m = 0; m < 1440; m++) {
    let k;
    if (weather === 'sunny') k = 0.985 + 0.012 * slow[m] + 0.006 * fast[m];
    else if (weather === 'cloudy') k = 1.08 + 0.18 * slow[m] + 0.08 * fast[m];
    else k = 1.0 + 0.3 * slow[m] + 0.12 * fast[m];
    out[m] = Math.max(0.05, k) * peak;
  }
  if (weather === 'cloudy' || weather === 'monsoon') {
    const events = weather === 'cloudy' ? 9 : 5;
    for (let e = 0; e < events; e++) {
      const start = 420 + Math.floor(rng() * 640);
      const len = 8 + Math.floor(rng() * 34);
      const depth = 0.35 + rng() * 0.35;
      for (let m = start; m < Math.min(1440, start + len); m++) {
        const edge = Math.min(1, (m - start) / 4, (start + len - m) / 4);
        out[m] *= 1 - (1 - depth) * edge;
      }
    }
  }
  return out;
}

// ---------- EV and e-bus charging sessions ----------
// Returned times are absolute sim minutes. Staff EVs ~09:00-17:00; e-buses come
// back for a midday top-up (~11:00-14:00) and again in the evening, staying overnight.
export function makeSessions(seed, dayIdx, equipment) {
  const rng = mulberry32((seed * 31 + dayIdx * 1013 + 17) >>> 0);
  const dayStart = dayIdx * 1440;
  const out = {};
  let bus = 0;
  for (const e of equipment) {
    if (e.kind === 'ev') {
      out[e.id] = [];
      if (rng() < 0.9) {
        const arrive = dayStart + 8 * 60 + 35 + Math.floor(rng() * 55);
        const depart = dayStart + 16 * 60 + 45 + Math.floor(rng() * 45);
        const socArrive = 0.3 + rng() * 0.3;
        const target = 0.9;
        out[e.id].push({ arriveT: arrive, departT: depart, socArrive, packKWh: EV_PACK_KWH, needKWh: (target - socArrive) * EV_PACK_KWH });
      }
    } else if (e.kind === 'ebus') {
      const k = bus++;
      const midArrive = dayStart + 11 * 60 + k * 70 + Math.floor(rng() * 20);
      const midNeed = 55 + rng() * 20;
      const midSoc = 0.45 + rng() * 0.1;
      const eveArrive = dayStart + 18 * 60 + 25 + k * 25 + Math.floor(rng() * 15);
      const eveSoc = 0.3 + rng() * 0.08;
      const eveNeed = 130 + rng() * 30;
      out[e.id] = [
        { arriveT: midArrive, departT: midArrive + 150, socArrive: midSoc, packKWh: BUS_PACK_KWH, needKWh: midNeed },
        { arriveT: eveArrive, departT: dayStart + 1440 + 6 * 60 + 30, socArrive: eveSoc, packKWh: BUS_PACK_KWH, needKWh: eveNeed },
      ];
    }
  }
  return out;
}

// Prior (day-1) inflexible demand per slot: rooms + aggregated classrooms + hostels / lighting.
export function priorInflexKW(mod) {
  const cls = mod >= CONFIG.occupancy.classStart && mod < CONFIG.occupancy.classEnd;
  const rooms = cls
    ? 0.6 * EXPLICIT_FULL_KW + 0.65 * CLASS_FULL_KW * AGG_CLASS_FACTOR
    : mod >= 7 * 60 && mod < 21 * 60 ? 0.12 * EXPLICIT_FULL_KW : SERVER_KW + 6;
  return rooms + otherBlocksKW(mod) + floodBaselineKW(mod) * 0.6;
}
