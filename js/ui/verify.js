// Verify tab: PROVE report (today vs baseline vs battery-only), Flex Score,
// past days, gain-sharing estimate, JSON / CSV download.
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, setStyle, fmtKW, fmtRs, fmtPct, fmtNum, safe, isNum, tokens, download } from './util.js';
import { kpis } from './derive.js';
import { drawRing } from './charts.js';

const SHARE = 0.3;   // HUKUM gain-share of verified savings

export function createVerify({ state }) {
  const el = h('section.tab-panel.vf');

  // ----- ribbon -----
  const rSaved = h('div.rib-v.num', '—');
  const rSub = h('div.rib-s', '');
  const rPct = h('div.rib-pct.num', '');
  const ribbon = h('div.ribbon', h('div', h('div.tile-l', 'Verified saving today'), rSaved, rSub), rPct);

  // ----- comparison table -----
  const cell = () => h('td.r.num', '—');
  const rowDefs = [
    ['Energy cost', 'cost'], ['Saving vs baseline', 'pct'], ['Peak grid kW', 'peak'], ['Grid energy', 'kwh'],
  ];
  const cells = {};
  const tbody = h('tbody', rowDefs.map(([label, key]) => {
    cells[key] = [cell(), cell(), cell()];
    return h('tr', h('td', label), ...cells[key]);
  }));
  const cmp = h('table.tbl.cmp', h('thead', h('tr', h('th', ''), h('th.r.c-hukum', 'HUKUM'), h('th.r', 'Baseline'), h('th.r', 'Battery only'))), tbody);
  const extra = h('div.vf-extra');
  const cmpCard = h('div.card', h('div.card-h', h('h3', 'Today so far'), h('span.card-meta.num.vf-asof', '')), cmp, extra);

  // ----- flex score -----
  const ring = h('canvas.ring');
  const fRows = {};
  const fItem = (key, label) => { fRows[key] = h('b.num', '—'); return h('div.fx-r', h('span', label), fRows[key]); };
  const flexCard = h('div.card', h('div.card-h', h('h3', 'Flex Score'), h('span.card-meta', '0-100')),
    h('div.fx', ring, h('div.fx-list', fItem('delivered', 'Delivered flexibility'), fItem('promised', 'Promised'), fItem('ratio', 'Delivery ratio'), fItem('rel', 'Reliability'), fItem('rebound', 'Rebound counted'), fItem('safety', 'Safety violations'))),
    h('div.cp-note', 'Score = delivered / promised flexibility x reliability, minus rebound and any comfort or safety violation.'));

  // ----- gain share -----
  const gToday = h('b.num', '—'), gCampus = h('b.num', '—'), gYear = h('b.num', '—'), gYearH = h('b.num', '—');
  const gainCard = h('div.card', h('div.card-h', h('h3', 'Gain sharing'), h('span.card-meta', `${SHARE * 100}% of verified savings`)),
    h('div.gain',
      h('div.gain-c', h('span', 'HUKUM fee today'), gToday),
      h('div.gain-c', h('span', 'Campus keeps today'), gCampus),
      h('div.gain-c', h('span', 'Campus keeps / year'), gYear),
      h('div.gain-c', h('span', 'HUKUM fee / year'), gYearH)),
    h('div.cp-note', 'Year projection uses the average verified saving of completed days (or today so far), x 365. No saving, no fee.'));

  // ----- past days -----
  const pastBody = h('tbody');
  const pastEmpty = h('div.empty', 'Completed days appear here after midnight. Use +1h to fast forward.');
  const pastTbl = h('table.tbl', h('thead', h('tr', h('th', 'Day'), h('th.r', 'HUKUM'), h('th.r', 'Baseline'), h('th.r', 'Saving'), h('th.r', 'Peak'), h('th.r', 'Flex'))), pastBody);
  const pastCard = h('div.card', h('div.card-h', h('h3', 'Past days')), pastTbl, pastEmpty);

  const dl = h('div.vf-dl',
    h('button.btn.btn-accent', { type: 'button', onclick: () => download(`hukum-report-day${state.day}.json`, JSON.stringify(report(state), null, 2), 'application/json') }, 'Download report (JSON)'),
    h('button.btn', { type: 'button', onclick: () => download(`hukum-report-day${state.day}.csv`, csv(state), 'text/csv') }, 'Download CSV'));

  el.append(ribbon, cmpCard, flexCard, gainCard, pastCard, dl);

  let pastSig = '';
  return {
    el,
    update() {
      const k = kpis(state);
      const T = (state.energy && state.energy.totals) || {};
      setText(rSaved, fmtRs(k.savingRs));
      setText(rSub, isNum(k.costBaseline) ? `${fmtRs(k.costHukum)} with HUKUM vs ${fmtRs(k.costBaseline)} do-nothing baseline, rebound included` : 'waiting for data');
      setText(rPct, isNum(k.savingPct) ? `-${(k.savingPct * 100).toFixed(1)}%` : '');
      setText(el.querySelector('.vf-asof'), `as of ${fmtTime(minuteOfDay(safe(state.t)))}, day ${safe(state.day, 1)}`);

      const [cH, cB, cBo] = cells.cost;
      setText(cH, fmtRs(k.costHukum)); setText(cB, fmtRs(k.costBaseline)); setText(cBo, fmtRs(k.costBatteryOnly));
      const [pH, pB, pBo] = cells.pct;
      setText(pH, isNum(k.savingPct) ? `-${fmtPct(k.savingPct, 1)}` : '—'); setText(pB, '0%'); setText(pBo, isNum(k.batteryOnlyPct) ? `-${fmtPct(k.batteryOnlyPct, 1)}` : '—');
      const [kH, kB, kBo] = cells.peak;
      setText(kH, fmtKW(k.peakHukum, false)); setText(kB, fmtKW(k.peakBaseline, false)); setText(kBo, isNum(T.peakBatteryOnlyKW) ? fmtKW(T.peakBatteryOnlyKW, false) : '—');
      const [eH, eB, eBo] = cells.kwh;
      setText(eH, isNum(k.kWhHukum) ? `${fmtNum(k.kWhHukum)} kWh` : '—'); setText(eB, isNum(k.kWhBaseline) ? `${fmtNum(k.kWhBaseline)} kWh` : '—'); setText(eBo, '—');
      setText(extra, [
        isNum(k.solarSelfUse) ? `Solar self-use ${fmtPct(k.solarSelfUse)}` : null,
        isNum(k.exportKWh) ? `export ${fmtNum(k.exportKWh)} kWh` : null,
        isNum(k.classroomSavedPct) ? `classroom energy -${fmtPct(k.classroomSavedPct)}` : null,
        isNum(k.co2) ? `${fmtNum(k.co2)} kg CO2 avoided` : null,
        isNum(k.batteryThroughputKWh) ? `battery throughput ${fmtNum(k.batteryThroughputKWh)} kWh` : null,
        isNum(T.demandChargeHukum) ? `demand charge ${fmtRs(T.demandChargeHukum)} vs ${fmtRs(T.demandChargeBaseline)}` : null,
        isNum(T.wearCostRs) ? `battery wear ${fmtRs(T.wearCostRs)}` : null,
        isNum(T.exportCreditRs) ? `export credit ${fmtRs(T.exportCreditRs)}` : null,
        safe(T.dieselKWh) > 0 ? `diesel ${fmtNum(T.dieselKWh)} kWh` : null,
        safe(T.shedKWh) > 0 ? `shed ${fmtNum(T.shedKWh)} kWh` : null,
      ].filter(Boolean).join(' · '));

      const f = state.flexScore || {};
      drawRing(ring, safe(f.score) / 100, tokens().accent, isNum(f.score) ? String(Math.round(f.score)) : '—', 'of 100');
      setText(fRows.delivered, isNum(f.delivered) ? `${fmtNum(f.delivered)} kWh` : '—');
      setText(fRows.promised, isNum(f.promised) ? `${fmtNum(f.promised)} kWh` : '—');
      setText(fRows.ratio, isNum(f.deliveredRatio) ? fmtPct(f.deliveredRatio) : safe(f.promised) > 0 ? fmtPct(f.delivered / f.promised) : '—');
      setText(fRows.rel, fmtPct(f.reliability));
      setText(fRows.rebound, isNum(f.rebound) ? `${fmtNum(f.rebound, 1)} kWh` : '—');
      setText(fRows.safety, String(safe(f.safetyViolations)));
      setClass(fRows.safety, 'bad', safe(f.safetyViolations) > 0);

      const today = Math.max(0, safe(k.savingRs));
      setText(gToday, fmtRs(today * SHARE));
      setText(gCampus, fmtRs(today * (1 - SHARE)));
      const past = (state.energy && Array.isArray(state.energy.pastDays) ? state.energy.pastDays : []).filter(Boolean);
      const avg = past.length ? past.reduce((s, d) => s + Math.max(0, safe(d.costBaseline) - safe(d.costHukum)), 0) / past.length : today;
      setText(gYear, fmtRs(avg * 365 * (1 - SHARE)));
      setText(gYearH, fmtRs(avg * 365 * SHARE));

      const sig = past.length + '|' + (past[past.length - 1] ? past[past.length - 1].day : '');
      if (sig !== pastSig) {
        pastSig = sig;
        pastBody.textContent = '';
        for (const d of past.slice().reverse()) {
          const pct = isNum(d.savingPct) ? d.savingPct : safe(d.costBaseline) > 0 ? (d.costBaseline - d.costHukum) / d.costBaseline : null;
          const pctFrac = isNum(pct) && Math.abs(pct) > 1.5 ? pct / 100 : pct;   // accept 0.26 or 26
          pastBody.append(h('tr',
            h('td.num', d.partial ? h('span', `Day ${d.day ?? '?'}`, h('span.cell-sub', 'partial day')) : `Day ${d.day ?? '?'}`), h('td.r.num', fmtRs(d.costHukum)), h('td.r.num', fmtRs(d.costBaseline)),
            h('td.r.num.c-good', isNum(pctFrac) ? `-${fmtPct(pctFrac, 1)}` : '—'),
            h('td.r.num', `${fmtKW(d.peakHukum, false)} / ${fmtKW(d.peakBaseline, false)}`),
            h('td.r.num', isNum(d.flexScore) ? String(Math.round(d.flexScore)) : '—')));
        }
        setClass(pastEmpty, 'hide', past.length > 0);
        setClass(pastTbl, 'hide', past.length === 0);
      }
    },
  };
}

function report(state) {
  const k = kpis(state);
  return {
    generated: new Date().toISOString(),
    site: 'NHCE campus (New Horizon College of Engineering), Outer Ring Road, Marathahalli, Bengaluru',
    simDay: state.day,
    simTime: fmtTime(minuteOfDay(safe(state.t))),
    pilotMode: state.mode,
    scenario: state.scenario,
    today: k,
    flexScore: state.flexScore,
    gainShare: { share: SHARE, hukumFeeRs: Math.max(0, safe(k.savingRs)) * SHARE },
    pastDays: (state.energy && state.energy.pastDays) || [],
    method: 'Savings = baseline (do-nothing) cost - HUKUM cost, with tariff by time of day, export credit, battery wear Rs 1.5/kWh and rebound counted.',
  };
}

function csv(state) {
  const k = kpis(state);
  const rows = [['metric', 'hukum', 'baseline', 'battery_only']];
  rows.push(['cost_rs', k.costHukum, k.costBaseline, k.costBatteryOnly]);
  rows.push(['peak_kw', k.peakHukum, k.peakBaseline, '']);
  rows.push(['grid_kwh', k.kWhHukum, k.kWhBaseline, '']);
  rows.push(['saving_pct', k.savingPct, 0, k.batteryOnlyPct]);
  rows.push([]);
  rows.push(['day', 'cost_hukum', 'cost_baseline', 'cost_battery_only', 'peak_hukum', 'peak_baseline', 'flex_score']);
  for (const d of ((state.energy && state.energy.pastDays) || [])) {
    if (!d) continue;
    rows.push([d.day, d.costHukum, d.costBaseline, d.costBatteryOnly, d.peakHukum, d.peakBaseline, d.flexScore]);
  }
  rows.push([]);
  rows.push(['minute', 'solar_kw', 'demand_kw', 'grid_kw', 'battery_kw', 'baseline_grid_kw', 'tariff']);
  for (const r of ((state.energy && state.energy.history) || [])) {
    if (!r) continue;
    rows.push([fmtTime(minuteOfDay(safe(r.t))), r.solarKW, r.demandKW, r.gridKW, r.batteryKW, r.baselineGridKW, r.tariff]);
  }
  const fmt = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`);
  return rows.map((r) => r.map(fmt).join(',')).join('\n');
}
