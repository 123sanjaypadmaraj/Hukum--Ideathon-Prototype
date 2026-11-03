// DECIDE: the internal flexibility market. Each flexible machine bids the
// cost of the service it can offer this slot (Rs per kWh, battery wear
// included); bids are derated by learned reliability and cleared in merit order.
import { CONFIG } from '../config.js';

const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;
const pct = (v) => `${Math.round(v * 100)}%`;

// fleet: array of per-machine views built by energy.js (see buildFleet there).
// ctx: { need, surplus, mod, tariff, inPeak, battPrice }
export function buildBids(fleet, ctx) {
  const bids = [];
  const add = (f, direction, kW, priceRs, reason, intent) => {
    if (!(kW > 0.3)) return;
    const reliability = Math.max(0.3, Math.min(1, f.reliability ?? 0.9));
    bids.push({
      id: `${f.id}:${direction}`, equipId: f.id, name: f.name, kind: f.kind, direction, intent,
      kW: r1(kW), priceRs: Math.round(priceRs * 100) / 100,
      effPriceRs: Math.round((priceRs / reliability) * 100) / 100,
      reliability: Math.round(reliability * 100) / 100, accepted: false, reason,
    });
  };
  const wear = CONFIG.battery.wearCostPerKWh;
  const eff = CONFIG.battery.eff;

  if (ctx.surplus > 0) {
    for (const f of fleet) {
      if (f.override) continue;
      if ((f.kind === 'ev' || f.kind === 'ebus') && f.connected && f.remainingKWh > 0.5) {
        add(f, 'absorb', f.ratedKW - f.floorKW, f.kind === 'ev' ? 0.2 : 0.3,
          `${r0(f.remainingKWh)} kWh still needed before ${f.departLabel}; charging now on solar costs nothing extra`, 'charge-solar');
      } else if (f.kind === 'pump' && f.tank < 0.94) {
        add(f, 'absorb', f.ratedKW, 0.4, `Tank at ${pct(f.tank)}; filling on solar keeps it above 20% through the evening`, 'run-solar');
      } else if (f.kind === 'hvac' && f.precoolAllowed) {
        const rb = CONFIG.precool.rebound;
        add(f, 'absorb', f.flexKW, 0.6 + rb * CONFIG.tariff.peak * 0.4,
          `Pre-cool ${f.precoolLeftMin} more min within 22-27 C; coasts through the 17:00-18:30 ramp (${r0(rb * 100)}% rebound)`, 'precool');
      } else if (f.kind === 'battery' && f.roomKWh > 2) {
        add(f, 'absorb', Math.min(f.maxKW, f.roomKWh * 4), wear + (1 - eff) * CONFIG.tariff.export,
          `Store surplus for the evening peak (Rs ${wear}/kWh wear, ${r0((1 - eff) * 100)}% round-trip loss)`, 'battery-charge');
      }
    }
  } else if (ctx.need > 0) {
    for (const f of fleet) {
      if (f.override) continue;
      if ((f.kind === 'ev' || f.kind === 'ebus') && f.connected && f.remainingKWh > 0.5 && f.ratedKW - f.floorKW > 0.5) {
        add(f, 'reduce', f.ratedKW - f.floorKW, f.kind === 'ev' ? 0.3 : 0.4,
          `${r0(f.remainingKWh)} kWh needed by ${f.departLabel}; ${r1(f.slackH)} h of slack, so charging can wait`, 'defer');
      } else if (f.kind === 'pump' && f.baselineWouldRun && f.tank > 0.3) {
        add(f, 'reduce', f.ratedKW, 0.2, `Tank at ${pct(f.tank)}, well above the 20% floor; refill later`, 'pause');
      } else if (f.kind === 'hvac' && f.coastKW > 0.5) {
        add(f, 'reduce', f.coastKW, 0.5 + CONFIG.precool.rebound * CONFIG.tariff.normal,
          `Coasting on pre-cooled thermal mass; rooms stay inside 22-27 C`, 'coast');
      } else if (f.kind === 'lighting' && ctx.inPeak && f.dimKW > 0.5) {
        add(f, 'reduce', f.dimKW, 0.3, 'Dim to 70% while play continues; still above the sports lighting minimum', 'dim');
      } else if (f.kind === 'battery' && f.availKWh > 2) {
        add(f, 'reduce', Math.min(f.maxKW, f.availKWh * 4), wear + ctx.battPrice / eff,
          `${r0(f.availKWh)} kWh available; wear Rs ${wear}/kWh plus stored energy cost`, 'battery-discharge');
      }
    }
  }
  return bids;
}

export function clearMarket(bids, needAbs) {
  bids.sort((a, b) => a.effPriceRs - b.effPriceRs || b.reliability - a.reliability);
  let covered = 0, clearing = 0;
  for (const b of bids) {
    if (covered >= needAbs - 0.5) break;
    b.accepted = true;
    const left = (needAbs - covered) / b.reliability;
    b.acceptedKW = Math.round(Math.min(b.kW, Math.max(left, 0)) * 10) / 10;
    covered += b.acceptedKW * b.reliability;
    clearing = b.effPriceRs;
  }
  return { covered, clearingPrice: clearing };
}

const shortName = (b) => {
  if (b.equipId === 'AHU-A') return 'Main Block AHU';
  if (b.equipId === 'HVAC-BD') return 'Other blocks & hostels';
  if (b.equipId === 'FLOOD') return 'sports floodlights';
  return b.equipId;
};

function group(accepted, kind) {
  return accepted.filter((b) => b.kind === kind);
}

// Plain-English explanation of one slot's clearing.
export function decideText(ctx, bids, modeNote) {
  const acc = bids.filter((b) => b.accepted);
  const parts = [];
  const hv = group(acc, 'hvac');
  const pumps = group(acc, 'pump');
  const evs = group(acc, 'ev');
  const buses = group(acc, 'ebus');
  const bat = acc.find((b) => b.kind === 'battery');
  const sum = (arr) => r0(arr.reduce((s, b) => s + b.kW, 0));
  const tariffTxt = `Rs ${ctx.tariff.toFixed(1)}`;
  let head;
  if (ctx.surplus > 0) {
    head = `Solar surplus ${r0(ctx.surplus)} kW at ${tariffTxt}`;
    for (const b of hv) parts.push(`pre-cooling via the ${shortName(b)} (${r0(num(b.acceptedKW, b.kW))} kW, ${pct(b.reliability)} reliable)`);
    if (pumps.length) parts.push(`pumps ${sum(pumps)} kW`);
    if (buses.length) parts.push(`e-bus ${sum(buses)} kW`);
    if (evs.length) parts.push(`staff EVs ${sum(evs)} kW`);
    const tail = bat ? 'battery absorbs the rest' : (parts.length ? 'the rest is exported at Rs 3' : 'nothing flexible to absorb it, exporting at Rs 3');
    return `${head}: ${parts.length ? parts.join(', ') + '; ' : ''}${tail}.${modeNote}`;
  }
  if (ctx.need > 0) {
    head = ctx.inPeak
      ? `Evening peak at ${tariffTxt}: need to cut ${r0(ctx.need)} kW to hold grid at ${r0(ctx.targetKW)} kW`
      : ctx.tariff <= CONFIG.tariff.solar
        ? `Grid import ${r0(ctx.netKW)} kW at ${tariffTxt}: shifting ${r0(ctx.need)} kW to the solar surplus later today`
        : `Do-nothing load would pull ${r0(ctx.netKW)} kW at ${tariffTxt}: spreading ${r0(ctx.need)} kW to stay under the ${r0(ctx.targetKW)} kW target`;
    if (buses.length) parts.push(`e-bus charging deferred (${sum(buses)} kW)`);
    if (evs.length) parts.push(`staff EVs deferred to solar (${sum(evs)} kW)`);
    if (pumps.length) parts.push(`pumps paused (${sum(pumps)} kW)`);
    for (const b of hv) parts.push(`${shortName(b)} coasting on pre-cool (${r0(b.kW)} kW)`);
    const fl = acc.find((b) => b.kind === 'lighting');
    if (fl) parts.push(`sports floodlights dimmed (${r1(fl.kW)} kW)`);
    if (bat) parts.push(`battery covers up to ${r0(bat.kW)} kW`);
    if (!parts.length) parts.push('no machine can shift right now, so the grid covers it');
    return `${head}. ${cap(parts.join(', '))}.${modeNote}`;
  }
  return `No flexibility needed: grid ${r0(Math.max(0, ctx.netKW))} kW at ${tariffTxt} is under the ${r0(ctx.targetKW)} kW target; machines on their normal schedule.${modeNote}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
