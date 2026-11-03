// The single mutable simulation state. Shape is documented in CONTRACT.md;
// every module reads it, and only the owners listed there write each part.
import { CONFIG } from './config.js';
import { ROOMS, CAMERAS, EQUIPMENT, PLAYER_START } from './building.js';

export function createState(seed = 2026) {
  return {
    seed,
    t: CONFIG.startMinute,           // sim minutes since midnight of day 1 (keeps growing past 1440)
    day: 1,
    speed: CONFIG.defaultSpeed,
    paused: false,

    scenario: {
      weather: 'sunny',              // 'sunny' | 'cloudy' | 'monsoon'
      outage: false,                 // grid outage -> Resilience Mode
      internetDown: false,           // edge runs on local backup schedule
      batteryKWh: CONFIG.battery.capacityKWh,
      hukumEnabled: true,            // false = "do nothing" baseline only
    },
    mode: 'automate',                // 'shadow' | 'approve' | 'automate'

    rooms: Object.fromEntries(ROOMS.map((r) => [r.id, {
      id: r.id,
      occupancy: 0,                  // ground truth people inside
      detected: 0,                   // what the camera says (null if no camera / offline)
      lastSeenT: -Infinity,          // sim minute someone was last detected
      scheduled: false,              // timetable says a class is on
      powered: true,                 // circuit relay state
      override: null,                // null | 'on' | 'off' (manual, always wins)
      tempC: 28,
      setpointC: CONFIG.comfort.setpointC,
      lightsOn: false, fansOn: false, acOn: false,
      loadKW: 0,                     // HUKUM-controlled draw
      baselineLoadKW: 0,             // what it would draw with nobody switching it off
      offSince: null,                // sim minute auto-off happened
    }])),

    people: [],                      // [{ id, floor, x, y, roomId, targetRoomId, path: [{floor,x,y}], role, seated }]

    cameras: Object.fromEntries(CAMERAS.map((c) => [c.id, {
      id: c.id,
      online: true,
      count: 0,
      detections: [],                // [{ personId, conf, x, y }] x/y in world tiles
      fps: 12,
      lastFrameT: 0,
    }])),

    equipment: Object.fromEntries(EQUIPMENT.map((e) => [e.id, {
      id: e.id,
      kW: 0,                         // current draw (+) or supply (-) ; battery: + charging, - discharging
      status: 'idle',                // free text: 'idle' | 'running' | 'pre-cooling' | 'charging' | 'discharging' | 'deferred' | 'off'
      soc: e.kind === 'battery' ? 0.5 : e.kind === 'ev' || e.kind === 'ebus' ? 0.3 : null,
      tankLevel: e.kind === 'pump' ? 0.55 : null,
      connected: e.kind === 'ev' || e.kind === 'ebus' ? false : true,
      reliability: e.kind === 'hvac' ? 0.8 : e.kind === 'battery' ? 0.98 : 0.9,
      flexKW: 0,                     // learned shiftable kW right now
      override: null,
    }])),

    energy: {
      solarKW: 0, demandKW: 0, gridKW: 0, batteryKW: 0, exportKW: 0, dieselKW: 0,
      tariff: CONFIG.tariff.normal,
      baseline: { demandKW: 0, gridKW: 0 },
      forecast: { solar: { p10: [], p50: [], p90: [] }, demand: { p10: [], p50: [], p90: [] }, issuedAt: null },
      history: [],                   // one row per sim minute of today: { t, solarKW, demandKW, gridKW, batteryKW, soc, baselineGridKW, tariff, costHukum, costBaseline }
      totals: {
        costHukum: 0, costBaseline: 0, costBatteryOnly: 0,
        kWhHukum: 0, kWhBaseline: 0,
        peakHukumKW: 0, peakBaselineKW: 0,
        solarUsedKWh: 0, solarGenKWh: 0, exportKWh: 0,
        classroomKWhHukum: 0, classroomKWhBaseline: 0,
        co2AvoidedKg: 0, batteryThroughputKWh: 0,
      },
      pastDays: [],                  // completed day summaries
    },

    market: {
      slot: null,                    // index 0..95 of the slot being cleared
      needKW: 0,                     // + = must cut/shift this much ; - = surplus to absorb
      bids: [],                      // [{ id, equipId, name, kind, direction: 'reduce'|'absorb', kW, priceRs, reliability, accepted, reason }]
      clearingPrice: 0,
      history: [],                   // [{ slot, t, needKW, clearingPrice, accepted: n }]
    },

    pendingActions: [],              // approve/shadow mode queue: [{ id, t, text, target: {type,id}, action, kW, savingRs, reason, status }]
    copilot: [],                     // [{ t, level: 'info'|'action'|'warn'|'saving', engine: 'SEE'|'PREDICT'|'DISCOVER'|'DECIDE'|'ACT'|'PROVE', text }]
    alerts: [],                      // [{ id, t, level, text }]

    flexScore: { score: 0, delivered: 0, promised: 0, rebound: 0, safetyViolations: 0 },

    player: { ...PLAYER_START, dir: 0, moving: false },
    ui: { selectedCamera: null, lensPanel: null, focusRoom: null, modal: null },
  };
}

export const minuteOfDay = (t) => ((t % 1440) + 1440) % 1440;
export const slotOf = (t) => Math.floor(minuteOfDay(t) / 15);
