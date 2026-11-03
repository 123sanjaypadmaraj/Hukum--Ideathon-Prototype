// "Ask HUKUM": rule-based intents answered from the live state in plain English.
import { CONFIG, fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { fmtKW, fmtRs, fmtPct, safe, isNum } from './util.js';
import { BLOCKS, findBlock, blockMeter, blockName, kpis, findMention, roomState, equipState, cameraForRoom, LIST_ROOMS, roomPower } from './derive.js';

export const SUGGESTIONS = [
  'How much did we save today?',
  'Why is the AI & ML lab off?',
  "What's the solar forecast?",
  'Battery status',
  'Which rooms are empty?',
  'What class is in CSE-101?',
  'Which block uses the most power?',
  'How much solar does SVP produce?',
  'Is the auditorium on?',
  'What about the evening peak?',
];

const arr = (a) => (Array.isArray(a) ? a : []);

function explainRoom(state, room) {
  const rs = roomState(state, room.id);
  const cam = cameraForRoom(state, room.id);
  const now = safe(state.t);
  const name = `${room.name} (${room.id})`;
  if (rs.override === 'off') return `${name} is off because an operator set a manual override. Manual override always wins; set it back to Auto in the Rooms tab.`;
  if (rs.override === 'on') return `${name} is held on by a manual override, so HUKUM will not switch it off even if it is empty.`;
  if ((cam && !cam.online) || rs.failSafe) return `The camera in ${name} is offline, so the room is kept powered (fail-safe). HUKUM never switches off a room it cannot see.`;
  if (rs.powered === false) {
    const since = isNum(rs.offSince) ? ` since ${fmtTime(minuteOfDay(rs.offSince))}` : '';
    const empty = isNum(rs.lastSeenT) && Number.isFinite(rs.lastSeenT) ? Math.round(now - rs.lastSeenT) : null;
    const saved = Math.max(0, safe(rs.baselineLoadKW) - safe(rs.loadKW));
    return `${name} has been off${since}: its camera saw nobody for ${empty != null ? `${empty} min` : `more than ${CONFIG.occupancy.autoOffMinutes} min`}, so lights, fans and AC were switched off${saved > 0.05 ? `, saving ${fmtKW(saved)} right now` : ''}. Power comes back the moment someone walks in.`;
  }
  const occ = safe(rs.occupancy);
  const bits = [];
  if (rs.lightsOn) bits.push('lights'); if (rs.fansOn) bits.push('fans'); if (rs.acOn) bits.push(rs.precool ? 'AC (pre-cooling)' : 'AC');
  if (!room.autoOff) return `${name} is a ${room.type} space, which HUKUM never auto-switches. It draws ${fmtKW(rs.loadKW)} now.`;
  return `${name} is on with ${occ} ${occ === 1 ? 'person' : 'people'} inside (camera counts ${isNum(rs.detected) ? rs.detected : 'n/a'}). Running: ${bits.length ? bits.join(', ') : 'nothing heavy'}, ${fmtKW(rs.loadKW)}${isNum(rs.tempC) ? `, ${rs.tempC.toFixed(1)} C` : ''}.`;
}

function explainEquipment(state, e) {
  const s = equipState(state, e.id);
  const parts = [`${e.name} is ${s.status || 'idle'} at ${fmtKW(s.kW)}`];
  if (isNum(s.flexKW)) parts.push(`it can shift about ${fmtKW(s.flexKW)} right now`);
  if (isNum(s.reliability)) parts.push(`learned reliability ${fmtPct(s.reliability)}`);
  if (isNum(s.soc)) parts.push(`state of charge ${fmtPct(s.soc)}`);
  if (isNum(s.tankLevel)) parts.push(`tank ${fmtPct(s.tankLevel)} full`);
  if (s.override) parts.push(`manual override: ${s.override}`);
  return `${parts.join('; ')}.`;
}

function currentClass(state, roomId, mod) {
  const list = state.timetable && state.timetable.rooms && state.timetable.rooms[roomId];
  if (!Array.isArray(list)) return null;
  return list.find((c) => c && isNum(c.start) && isNum(c.end) && mod >= minuteOfDay(c.start) && mod < minuteOfDay(c.end)) || null;
}

function explainClass(state, room, mod) {
  const rs = roomState(state, room.id);
  const c = currentClass(state, room.id, mod);
  const name = `${room.name} (${room.id})`;
  if (c) return `${name}: ${c.subject || 'a class'}${c.group ? ` for ${c.group}` : ''}${c.teacher ? ` with ${c.teacher}` : ''}, ${fmtTime(minuteOfDay(c.start))}-${fmtTime(minuteOfDay(c.end))}${isNum(c.size) ? `, ${c.size} expected` : ''}. ${safe(rs.occupancy)} people are inside now.`;
  if (rs.classLabel) return `${name}: ${rs.classLabel}. ${safe(rs.occupancy)} people inside now.`;
  if (!room.timetabled) return `${name} is not on the class timetable.`;
  return `No class in ${name} right now${isNum(rs.nextClassAt) ? `; the next one starts at ${fmtTime(minuteOfDay(rs.nextClassAt))}` : ''}. Empty slots like this are where camera auto-off saves energy.`;
}

export function answer(state, question) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return 'Ask me about savings, the forecast, the battery, empty rooms, the peak, or why a room is off.';
  const k = kpis(state);
  const E = state.energy || {};
  const mod = minuteOfDay(safe(state.t));

  // ----- blocks (one energy meter per block) -----
  if (/\bblocks?\b/.test(q) && /(most|highest|biggest|largest|top|least|lowest|rank|compare)/.test(q)) {
    const rows = BLOCKS.map((b) => ({ b, m: blockMeter(state, b.id) })).sort((a, b) => b.m.kW - a.m.kW);
    const least = /(least|lowest)/.test(q);
    const top = least ? rows[rows.length - 1] : rows[0];
    if (!top) return 'No block meters yet.';
    const list = rows.slice(0, 4).map((r) => `${r.b.short} ${fmtKW(r.m.kW)}`).join(', ');
    const save = top.m.baselineKW > 0.5 ? ` (baseline ${fmtKW(top.m.baselineKW)}, ${fmtPct(1 - top.m.kW / top.m.baselineKW)} lower)` : '';
    return `${top.b.name} is using the ${least ? 'least' : 'most'} power right now: ${fmtKW(top.m.kW)}${save}. Block meters now: ${list}. ${top.m.autoOff} of its rooms are switched off and ${Math.round(top.m.people)} people are inside.`;
  }
  const blk = findBlock(q);
  if (blk && /(solar|pv|panel|kwp)/.test(q)) {
    const m = blockMeter(state, blk.id);
    const so = m.solar;
    if (so.kWp > 0) {
      const parts = [];
      if (so.existingKWp > 0) parts.push(`the existing ${Math.round(so.existingKWp)} kWp array${blk.id === 'SVP' ? ' (off-grid, with its own battery)' : ''} gives ${fmtKW(so.existingKW)}`);
      if (so.newKWp > 0) parts.push(`the HUKUM expansion (${Math.round(so.newKWp)} kWp) gives ${fmtKW(so.newKW)}`);
      return `${blk.name} rooftop solar is producing ${fmtKW(m.solarKW)} right now: ${parts.join(' and ')}.`;
    }
    return safe(m.solarKW) > 0.05 ? `${blk.name} rooftop solar is producing ${fmtKW(m.solarKW)} right now.` : `${blk.name} has no rooftop solar in the model.`;
  }
  const mention0 = findMention(q);
  if (blk && (!mention0 || /\b(block|building)\b/.test(q)) && /(power|use|using|load|kw|energy|meter|how|status|people|busy)/.test(q)) {
    const m = blockMeter(state, blk.id);
    return `${blk.name}: ${fmtKW(m.kW)} now against a ${fmtKW(m.baselineKW)} baseline${isNum(m.kWhToday) ? `, ${Math.round(m.kWhToday)} kWh today` : ''}. ${Math.round(m.people)} people inside, ${m.autoOff} of ${m.rooms} rooms switched off by camera auto-off.`;
  }

  if (/\b(class|classes|lecture|subject|timetable|teacher|teaching)\b/.test(q)) {
    const m = findMention(q);
    if (m && m.type === 'room') return explainClass(state, m.item, mod);
    const tt = state.timetable && state.timetable.rooms;
    if (tt) {
      const on = LIST_ROOMS.filter((r) => currentClass(state, r.id, mod));
      if (!on.length) return 'No timetabled class is running right now.';
      return `${on.length} classes running now: ${on.slice(0, 6).map((r) => `${r.id} ${currentClass(state, r.id, mod).subject || ''}`.trim()).join(', ')}${on.length > 6 ? ` and ${on.length - 6} more` : ''}.`;
    }
  }

  if (/(on site|onsite|how many people|people in|campus busy)/.test(q)) {
    const os = state.occStats || {};
    if (isNum(os.onSite)) return `${os.onSite} people are on site, ${safe(os.inClass)} of them in class. Cameras triggered ${safe(os.autoOffs)} auto-offs and ${safe(os.powerOns)} power-ons today.`;
  }

  if (/(save|saving|saved|cost|money|bill)/.test(q)) {
    if (!isNum(k.costBaseline) || k.costBaseline <= 0) return 'Not enough data yet today. Let the simulation run a few minutes.';
    return `Today so far HUKUM has spent ${fmtRs(k.costHukum)} against ${fmtRs(k.costBaseline)} for the do-nothing baseline: ${fmtRs(k.savingRs)} saved (${fmtPct(k.savingPct, 1)}). A battery alone would have saved ${fmtPct(k.batteryOnlyPct, 1)}. Classroom energy is down ${fmtPct(k.classroomSavedPct)} from camera auto-off, and ${Math.round(safe(k.co2))} kg CO2 avoided.`;
  }

  if (/(why|off|on\b|status of|what about)/.test(q) || findMention(q)) {
    const m = findMention(q);
    if (m && m.type === 'room') return explainRoom(state, m.item);
    if (m && m.type === 'equipment' && !/battery/.test(q)) return explainEquipment(state, m.item);
  }

  if (/(battery|soc|storage)/.test(q)) {
    const b = equipState(state, 'BAT-1');
    const cap = safe(state.scenario && state.scenario.batteryKWh, 400);
    const kw = safe(b.kW);
    const act = kw > 0.5 ? `charging at ${fmtKW(kw)}` : kw < -0.5 ? `discharging at ${fmtKW(-kw)}` : 'idle';
    return `The ${cap} kWh battery is at ${fmtPct(b.soc)} (${Math.round(safe(b.soc) * cap)} kWh) and ${act}. Plan: charge on surplus solar at Rs ${CONFIG.tariff.solar}, discharge in the ${CONFIG.tariff.peakHours[0]}:00-${CONFIG.tariff.peakHours[1]}:00 peak at Rs ${CONFIG.tariff.peak}. Every bid includes Rs ${CONFIG.battery.wearCostPerKWh}/kWh battery wear.`;
  }

  if (/(forecast|predict|solar|sun|weather|cloud)/.test(q)) {
    const fs = (E.forecast && E.forecast.solar) || {};
    const p50 = arr(fs.p50), p10 = arr(fs.p10), p90 = arr(fs.p90);
    const weather = (state.scenario && state.scenario.weather) || 'sunny';
    if (!p50.length) return `Solar is producing ${fmtKW(E.solarKW)} now (${weather}). The forecast has not been issued yet.`;
    let pk = 0, pi = 0, rest = 0;
    const cur = Math.floor(mod / 15);
    p50.forEach((v, i) => { if (safe(v) > pk) { pk = safe(v); pi = i; } if (i >= cur) rest += safe(v) * 0.25; });
    const nx = Math.min(95, cur + 4);
    return `Weather: ${weather}. Solar now ${fmtKW(E.solarKW)}. The P50 forecast peaks at ${fmtKW(pk)} around ${fmtTime(pi * 15)}; about ${Math.round(rest)} kWh still to come today. In an hour I expect ${fmtKW(p50[nx])} (P10 ${fmtKW(p10[nx])} to P90 ${fmtKW(p90[nx])}). I re-forecast every 15 minutes, so the band narrows as the day goes on.`;
  }

  if (/(empty|vacant|unused|nobody|no one)/.test(q)) {
    const empty = LIST_ROOMS.filter((r) => r.autoOff && safe(roomState(state, r.id).occupancy) === 0);
    if (!empty.length) return 'Every auto-controlled room has people in it right now.';
    const off = empty.filter((r) => roomPower(state, r.id).key === 'auto-off');
    const stillOn = empty.filter((r) => roomPower(state, r.id).key !== 'auto-off');
    const names = (list) => list.slice(0, 8).map((r) => r.id).join(', ') + (list.length > 8 ? ` and ${list.length - 8} more` : '');
    let s = `${empty.length} rooms are empty.`;
    if (off.length) s += ` Already switched off: ${names(off)}.`;
    if (stillOn.length) s += ` Still powered (inside the ${CONFIG.occupancy.autoOffMinutes}-minute grace period, overridden or camera offline): ${names(stillOn)}.`;
    return s;
  }

  if (/(peak|evening|demand|max)/.test(q)) {
    const inPeak = mod >= CONFIG.tariff.peakHours[0] * 60 && mod < CONFIG.tariff.peakHours[1] * 60;
    return `Peak grid draw today is ${fmtKW(k.peakHukum)} with HUKUM against ${fmtKW(k.peakBaseline)} for the baseline${isNum(k.peakCutPct) ? ` (${fmtPct(k.peakCutPct)} lower)` : ''}. ${inPeak ? 'We are in the peak tariff window now: the battery is discharging and deferrable loads (pumps, EV and e-bus charging) are held back.' : `The peak tariff window is ${CONFIG.tariff.peakHours[0]}:00-${CONFIG.tariff.peakHours[1]}:00; HUKUM pre-cools, fills tanks and charges vehicles on solar beforehand so less is needed then.`}`;
  }

  if (/(market|bid|price|clear)/.test(q)) {
    const m = state.market || {};
    const acc = arr(m.bids).filter((b) => b && b.accepted);
    return `This slot needs ${fmtKW(Math.abs(safe(m.needKW)))} ${safe(m.needKW) < 0 ? 'of surplus absorbed' : 'cut or shifted'}. ${acc.length} bid${acc.length === 1 ? '' : 's'} won${acc.length ? `: ${acc.slice(0, 5).map((b) => b.name || b.equipId).join(', ')}` : ''}. Clearing price Rs ${safe(m.clearingPrice).toFixed(2)}/kWh.`;
  }

  if (/(mode|shadow|approve|automate|pilot)/.test(q)) {
    const mode = state.mode;
    return `Pilot mode is ${mode}. Shadow: HUKUM only suggests and logs what it would have saved. Approve: each action waits for you in Copilot. Automate: it acts on its own, always inside the 22-27 C comfort limits and manual overrides.`;
  }

  if (/(flex|score|reliab)/.test(q)) {
    const f = state.flexScore || {};
    return `Flex Score is ${Math.round(safe(f.score))}/100: delivered ${Math.round(safe(f.delivered))} of ${Math.round(safe(f.promised))} kWh promised, rebound ${Math.round(safe(f.rebound))} kWh, ${safe(f.safetyViolations)} safety violations.`;
  }

  if (/(outage|resilien|diesel|grid down)/.test(q)) {
    return state.scenario && state.scenario.outage
      ? `Resilience Mode is active: battery and solar serve critical loads (server, corridors, labs), non-critical loads are shed${safe(E.dieselKW) > 0 ? ` and diesel is supplying ${fmtKW(E.dieselKW)}` : ', diesel only if the battery runs out'}.`
      : 'The grid is up. In an outage HUKUM switches to Resilience Mode: battery and solar serve critical loads, non-critical loads are shed, diesel last.';
  }

  return `I can answer: how much did we save, why a room is off (for example "why is the AI & ML lab off"), which block uses the most power, solar per block, the solar forecast, battery status, which rooms are empty, the evening peak, the market, the pilot mode and the Flex Score.`;
}
