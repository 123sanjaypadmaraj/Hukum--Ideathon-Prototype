// Simulation assumptions, taken from the HUKUM deck speaker notes (slide 5).
export const CONFIG = {
  slotMinutes: 15,
  slotsPerDay: 96,
  startMinute: 8 * 60 + 30,          // sim starts at 08:30

  tariff: {
    normal: 8.0,                      // Rs/kWh
    solar: 6.4,                       // 09:00-17:00 (-20%)
    peak: 9.6,                        // 18:00-22:00 (+20%)
    export: 3.0,                      // Rs/kWh exported
    solarHours: [9, 17],
    peakHours: [18, 22],
    demandChargePerKVAMonth: 400,
  },

  solar: { kWp: 900 },                // whole campus
  battery: { capacityKWh: 400, maxKW: 150, wearCostPerKWh: 1.5, minSoc: 0.1, maxSoc: 0.95, eff: 0.92 },

  // The modelled block has explicit rooms; the rest of the campus is aggregated
  // so totals match the 60-classroom model campus of the deck.
  campus: { classrooms: 60, otherBlocksBaseKW: 140 },

  occupancy: {
    classStart: 8 * 60 + 45,
    classEnd: 17 * 60 + 45,
    slotOccupancyProb: 0.75,
    autoOffMinutes: 10,               // empty for 10+ min -> power off
  },

  comfort: { minC: 22, maxC: 27, setpointC: 24 },

  precool: { maxKW: 35, maxMinutes: 90, reliability: 0.8, rebound: 0.10 },

  speeds: [1, 10, 60, 300],           // sim seconds per real second
  defaultSpeed: 1,
};

export function tariffAt(minuteOfDay) {
  const h = minuteOfDay / 60;
  const t = CONFIG.tariff;
  if (h >= t.peakHours[0] && h < t.peakHours[1]) return t.peak;
  if (h >= t.solarHours[0] && h < t.solarHours[1]) return t.solar;
  return t.normal;
}

// Deterministic PRNG so a scenario replays identically.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtTime(minuteOfDay) {
  const m = Math.floor(((minuteOfDay % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
