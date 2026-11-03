// Overview tab: status banners, KPI tiles, 24 h energy chart, six-engine loop.
import { CONFIG, fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, setStyle, fmtKW, fmtRs, fmtPct, fmtNum, safe, isNum } from './util.js';
import { kpis, ENGINES, ENGINE_INFO, activeEngine } from './derive.js';
import { drawEnergyChart } from './charts.js';

export function createOverview({ state }) {
  const el = h('section.tab-panel.ov');

  // ----- banners -----
  const banners = h('div.ov-banners');

  // ----- hero KPI -----
  const heroCost = h('div.hero-v.num', '—');
  const heroBase = h('div.hero-sub.num', '');
  const heroPct = h('div.hero-pct.num', '—');
  const heroBar = h('div.hero-bar-fill');
  const hero = h('div.tile.tile-hero', [
    h('div.tile-l', 'Cost today with HUKUM'),
    h('div.hero-row', h('div', heroCost, heroBase), heroPct),
    h('div.hero-bar', heroBar),
  ]);

  const tile = (label, hint) => {
    const v = h('div.tile-v.num', '—');
    const s = h('div.tile-s', hint || '');
    return { el: h('div.tile', h('div.tile-l', label), v, s), v, s };
  };
  const tBatt = tile('Battery-only', 'saving vs baseline');
  const tPeak = tile('Peak grid', '');
  const tSolar = tile('Solar self-use', '');
  const tClass = tile('Classrooms', 'saved by auto-off');
  const tCo2 = tile('CO2 avoided', 'at 0.71 kg/kWh');
  const tFlex = tile('Flex Score', 'delivered x reliability');
  const tiles = h('div.tiles', tBatt.el, tPeak.el, tSolar.el, tClass.el, tCo2.el, tFlex.el);

  // ----- chart -----
  const canvas = h('canvas.ov-chart');
  const tip = h('div.chart-tip');
  const legendItem = (cls, label) => h('span.lg', h(`i.${cls}`), label);
  const legend = h('div.legend',
    legendItem('lg-solar', 'Solar'), legendItem('lg-band', 'Forecast P10-P90'), legendItem('lg-demand', 'Demand'),
    legendItem('lg-grid', 'Grid import'), legendItem('lg-base', 'Baseline grid'), legendItem('lg-batt', 'Battery +chg / -dis'));
  const chartWrap = h('div.chart-wrap', canvas, tip);
  let hoverX = null;
  canvas.addEventListener('mousemove', (e) => { hoverX = e.offsetX; draw(); });
  canvas.addEventListener('mouseleave', () => { hoverX = null; draw(); });
  const chartCard = h('div.card', h('div.card-h', h('h3', 'Today, 24 h'), h('span.card-meta.num', 'kW')), chartWrap, legend);

  // ----- loop strip -----
  const loopNodes = {};
  const loopStrip = h('div.loop');
  ENGINES.forEach((eng, i) => {
    const node = h('div.loop-n', { title: ENGINE_INFO[eng] }, h('span.loop-i.num', String(i + 1)), h('span.loop-name', eng));
    loopNodes[eng] = node;
    loopStrip.append(node);
    if (i < ENGINES.length - 1) loopStrip.append(h('span.loop-arrow', { 'aria-hidden': 'true' }));
  });
  const loopProg = h('div.loop-prog-fill');
  const loopDesc = h('div.loop-desc', '');
  const loopNext = h('span.card-meta.num', '');
  const loopCard = h('div.card', h('div.card-h', h('h3', 'Six-engine loop'), loopNext), loopStrip, h('div.loop-prog', loopProg), loopDesc);

  // ----- demand breakdown -----
  const BD = [['roomsKW', 'Modelled rooms', '--demand'], ['aggClassKW', 'Other classrooms', '--warn'], ['hvacKW', 'HVAC', '--info'],
    ['pumpsKW', 'Pumps', '--grid'], ['vehiclesKW', 'EV / e-bus', '--battery'], ['otherBlocksKW', 'Other blocks & hostels', '--baseline']];
  const bdBar = h('div.bd-bar');
  const bdLegend = h('div.bd-legend');
  const bdTotal = h('span.card-meta.num', '');
  const bdParts = BD.map(([key, label, tok]) => {
    const seg = h('div.bd-seg', { style: { background: `var(${tok})` }, title: label });
    const v = h('b.num', '—');
    bdBar.append(seg);
    bdLegend.append(h('div.bd-li', h('i', { style: { background: `var(${tok})` } }), h('span', label), v));
    return { key, seg, v };
  });
  const bdCard = h('div.card', h('div.card-h', h('h3', 'Demand right now'), bdTotal), bdBar, bdLegend);
  el.append(banners, hero, tiles, chartCard, bdCard, loopCard);
  function updateBreakdown() {
    const b = (state.energy && state.energy.breakdown) || null;
    setClass(bdCard, 'hide', !b);
    if (!b) return;
    const tot = bdParts.reduce((s, p) => s + Math.max(0, safe(b[p.key])), 0);
    setText(bdTotal, `${fmtKW(tot)}${safe(state.energy.shedKW) > 0 ? ` · ${fmtKW(state.energy.shedKW)} shed` : ''}`);
    for (const p of bdParts) {
      const v = Math.max(0, safe(b[p.key]));
      setStyle(p.seg, 'flexGrow', String(tot > 0 ? v / tot : 0));
      setText(p.v, fmtKW(v));
    }
  }

  function draw() {
    const res = drawEnergyChart(canvas, state, hoverX);
    if (!res || !res.hover) { setStyle(tip, 'display', 'none'); return; }
    const { hover } = res;
    const r = hover.row || {};
    const rows = [
      ['Solar', r.solarKW, 'solar'], ['Demand', r.demandKW, 'demand'], ['Grid', r.gridKW, 'grid'],
      ['Baseline', r.baselineGridKW, 'base'], ['Battery', r.batteryKW, 'batt'],
    ].filter((x) => isNum(x[1]));
    tip.textContent = '';
    tip.append(h('div.tip-h.num', fmtTime(hover.m)));
    for (const [l, v, c] of rows) tip.append(h('div.tip-r', h(`i.lg-${c}`), h('span', l), h('b.num', fmtKW(v))));
    if (isNum(hover.fc.p50)) tip.append(h('div.tip-r.tip-fc', h('i.lg-band'), h('span', 'Forecast'), h('b.num', `${Math.round(hover.fc.p50)} (${Math.round(safe(hover.fc.p10))}-${Math.round(safe(hover.fc.p90))})`)));
    if (!rows.length && !isNum(hover.fc.p50)) tip.append(h('div.tip-r', h('span.muted', 'No data yet')));
    setStyle(tip, 'display', 'block');
    const left = hover.x > res.plot.w - 170 ? hover.x - 166 : hover.x + 12;
    setStyle(tip, 'left', `${left}px`);
  }

  let bannerSig = '';
  function updateBanners() {
    const sc = state.scenario || {};
    const list = [];
    if (sc.outage) {
      const bat = (state.equipment && state.equipment['BAT-1']) || {};
      const kwh = safe(bat.soc) * safe(sc.batteryKWh, 400);
      const En = state.energy || {};
      const crit = isNum(En.criticalKW) ? ` (${Math.round(En.criticalKW)} kW)` : '';
      const shed = safe(En.shedKW) > 0 ? `; ${Math.round(En.shedKW)} kW non-critical shed` : '; non-critical loads shed';
      list.push(['danger', 'Resilience Mode', `Grid outage. Battery (${Math.round(kwh)} kWh left) and solar serve critical loads${crit}${shed}${safe(En.dieselKW) > 0 ? `; diesel ${Math.round(En.dieselKW)} kW` : ''}.`]);
    }
    if (sc.internetDown) list.push(['warn', 'Internet down', 'Edge box is running the local backup schedule. Nothing changes for the building.']);
    if (sc.hukumEnabled === false) list.push(['muted', 'HUKUM off', 'Building runs as it does today: the do-nothing baseline.']);
    if (state.mode === 'shadow') list.push(['info', 'Shadow mode', 'HUKUM suggests and logs what it would have saved. Nothing executes.']);
    if (state.mode === 'approve') {
      const n = (state.pendingActions || []).filter((a) => a && a.status === 'pending').length;
      list.push(['info', 'Approve mode', `${n} action${n === 1 ? '' : 's'} waiting for your approval in Copilot.`]);
    }
    const sig = JSON.stringify(list);
    if (sig === bannerSig) return;
    bannerSig = sig;
    banners.textContent = '';
    for (const [tone, title, text] of list) banners.append(h(`div.banner.b-${tone}`, h('b', title), h('span', text)));
  }

  return {
    el,
    update() {
      updateBanners();
      updateBreakdown();
      const k = kpis(state);
      setText(heroCost, fmtRs(k.costHukum));
      setText(heroBase, isNum(k.costBaseline) ? `vs ${fmtRs(k.costBaseline)} baseline` : 'waiting for the first minutes of data');
      // Midday export credit can push the running cost below zero; then show the rupee gap instead of a percentage.
      const gapRs = isNum(k.costBaseline) && isNum(k.costHukum) ? k.costBaseline - k.costHukum : null;
      setText(heroPct, isNum(k.savingPct) ? `${k.savingPct >= 0 ? '-' : '+'}${Math.abs(k.savingPct * 100).toFixed(1)}%`
        : isNum(gapRs) ? `${gapRs >= 0 ? '-' : '+'}${fmtRs(Math.abs(gapRs))}` : '—');
      setClass(heroPct, 'neg', isNum(k.savingPct) && k.savingPct < 0);
      setStyle(heroBar, 'width', `${Math.max(0, Math.min(100, (1 - safe(k.savingPct)) * 100))}%`);

      const boGap = isNum(k.costBaseline) && isNum(k.costBatteryOnly) ? k.costBaseline - k.costBatteryOnly : null;
      setText(tBatt.v, isNum(k.batteryOnlyPct) ? `-${(k.batteryOnlyPct * 100).toFixed(1)}%` : isNum(boGap) ? `${boGap >= 0 ? "-" : "+"}${fmtRs(Math.abs(boGap))}` : '—');
      setText(tBatt.s, isNum(k.costBatteryOnly) ? `${fmtRs(k.costBatteryOnly)} vs HUKUM ${fmtRs(k.costHukum)}` : 'saving vs baseline');
      setText(tPeak.v, fmtKW(k.peakHukum));
      setText(tPeak.s, isNum(k.peakBaseline) ? `baseline ${fmtKW(k.peakBaseline)}${isNum(k.peakCutPct) ? ` (-${(k.peakCutPct * 100).toFixed(0)}%)` : ''}` : '');
      setText(tSolar.v, fmtPct(k.solarSelfUse));
      setText(tSolar.s, isNum(k.solarGenKWh) ? `${fmtNum(k.solarUsedKWh)} of ${fmtNum(k.solarGenKWh)} kWh` : '');
      setText(tClass.v, isNum(k.classroomSavedPct) ? `-${(k.classroomSavedPct * 100).toFixed(0)}%` : '—');
      setText(tCo2.v, isNum(k.co2) ? `${fmtNum(k.co2)} kg` : '—');
      setText(tFlex.v, isNum(k.flex) ? String(Math.round(k.flex)) : '—');
      setClass(tFlex.el, 'accent', isNum(k.flex));

      // loop
      const act = activeEngine(state);
      for (const eng of ENGINES) setClass(loopNodes[eng], 'active', eng === act);
      const mod = minuteOfDay(safe(state.t));
      const inSlot = mod % CONFIG.slotMinutes;
      setStyle(loopProg, 'width', `${(inSlot / CONFIG.slotMinutes) * 100}%`);
      const left = CONFIG.slotMinutes - inSlot;
      setText(loopNext, `next market clear ${fmtTime(mod + left)}`);
      const cp = state.copilot || [];
      let last = null;
      for (let i = cp.length - 1; i >= 0 && i >= cp.length - 300; i--) if (cp[i] && cp[i].engine === act) { last = cp[i]; break; }
      setText(loopDesc, `${act}: ${last ? last.text : ENGINE_INFO[act]}`);

      draw();
    },
  };
}

