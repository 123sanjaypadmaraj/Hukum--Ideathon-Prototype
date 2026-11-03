// Top bar: wordmark, clock, transport, pilot mode, weather, scenarios, live KPIs.
import { CONFIG, fmtTime, tariffAt } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, setAttr, segmented, fmtKW, safe } from './util.js';
import { tariffBand } from './derive.js';

export function createTopbar(root, { state, actions, onHelp }) {
  root.textContent = '';

  const wordmark = h('div.tb-brand', [
    h('div.tb-logo', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    h('div.tb-brand-text', [
      h('div.tb-name', 'HUKUM'),
      h('div.tb-site', { title: 'New Horizon College of Engineering, Outer Ring Road, Marathahalli, Bengaluru' }, 'NHCE · Marathahalli'),
    ]),
  ]);

  const clockTime = h('div.tb-time.num', '--:--');
  const clockDay = h('div.tb-day', 'Day 1');
  const clock = h('div.tb-clock', { title: 'Simulation clock' }, clockTime, clockDay);

  const pauseBtn = h('button.tb-btn.tb-play', { type: 'button', title: 'Play / pause', onclick: () => actions.togglePause() });
  const speeds = segmented(CONFIG.speeds.map((s) => ({ value: s, label: `${s}x`, title: `${s} sim seconds per second` })), (v) => actions.setSpeed(v), 'tb-speeds');
  const skip15 = h('button.tb-btn', { type: 'button', title: 'Skip ahead 15 minutes (one market slot)', onclick: () => actions.skipMinutes(15) }, '+15m');
  const skip60 = h('button.tb-btn', { type: 'button', title: 'Skip ahead one hour', onclick: () => actions.skipMinutes(60) }, '+1h');
  const transport = h('div.tb-group', pauseBtn, speeds.el, skip15, skip60);

  const mode = segmented([
    { value: 'shadow', label: 'Shadow', title: 'HUKUM suggests, nothing executes; logs what it would have saved' },
    { value: 'approve', label: 'Approve', title: 'Every action waits for operator approval' },
    { value: 'automate', label: 'Automate', title: 'HUKUM runs on its own within safety limits' },
  ], (v) => actions.setMode(v), 'tb-mode');
  const modeWrap = h('div.tb-field', h('span.tb-label', 'Pilot'), mode.el);

  const weather = h('select.tb-select', { title: 'Weather', onchange: (e) => actions.setWeather(e.target.value) },
    h('option', { value: 'sunny' }, 'Sunny'),
    h('option', { value: 'cloudy' }, 'Cloudy'),
    h('option', { value: 'monsoon' }, 'Monsoon'));
  const weatherWrap = h('div.tb-field', h('span.tb-label', 'Weather'), weather);

  const toggle = (label, title, onclick) => h('button.tb-chip', { type: 'button', title, onclick }, h('span.dot'), label);
  const tOutage = toggle('Grid outage', 'Simulate a grid outage: Resilience Mode', () => actions.setOutage(!state.scenario.outage));
  const tNet = toggle('Internet down', 'Edge box loses internet: runs the local backup schedule', () => actions.setInternetDown(!state.scenario.internetDown));
  const tBatt = toggle('Battery 400', 'Switch battery size between 400 kWh and 50 kWh', () => actions.setBatteryKWh(safe(state.scenario.batteryKWh, 400) >= 400 ? 50 : CONFIG.battery.capacityKWh));
  const tHukum = toggle('HUKUM on', 'Turn HUKUM off to see the do-nothing baseline', () => actions.setHukumEnabled(!(state.scenario.hukumEnabled !== false)));
  const scen = h('div.tb-group.tb-scen', tOutage, tNet, tBatt, tHukum);
  // Narrow screens: the scenario toggles live in a popover under a "Scenarios" button.
  const scenDot = h('span.tb-scen-dot');
  const scenBtn = h('button.tb-btn.tb-scen-btn', {
    type: 'button', title: 'Scenario toggles', 'aria-haspopup': 'true',
    onclick: (e) => { e.stopPropagation(); setPop(!popOpen); }
  }, 'Scenarios', scenDot);
  const scenSlot = h('div.tb-scen-slot', scenBtn);
  let popOpen = false, popMode = null;
  function setPop(open) {
    popOpen = open && popMode;
    setClass(scen, 'open', popOpen);
    setClass(scenBtn, 'on', popOpen);
    if (popOpen) {
      const r = scenBtn.getBoundingClientRect();
      scen.style.left = `${Math.max(8, Math.min(window.innerWidth - 220, r.left))}px`;
      scen.style.top = `${r.bottom + 6}px`;
    }
  }
  function layoutScen() {
    const narrow = window.innerWidth < 1760;
    if (narrow === popMode) return;
    popMode = narrow;
    setClass(scen, 'tb-pop', narrow);
    setClass(scenBtn, 'hide', !narrow);
    if (narrow) document.body.append(scen); else scenSlot.append(scen);
    setPop(false);
  }
  window.addEventListener('resize', layoutScen);
  document.addEventListener('click', (e) => { if (popOpen && !scen.contains(e.target)) setPop(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popOpen) setPop(false); });

  const kpi = (label, cls) => {
    const v = h('div.tb-kpi-v.num', '—');
    const el = h(`div.tb-kpi${cls ? '.' + cls : ''}`, h('div.tb-kpi-l', label), v);
    return { el, v };
  };
  const kGrid = kpi('Grid', 'k-grid'), kSolar = kpi('Solar', 'k-solar'), kTariff = kpi('Tariff', 'k-tariff');
  const kpis = h('div.tb-kpis', kGrid.el, kSolar.el, kTariff.el);

  const help = h('button.tb-btn.tb-help', { type: 'button', title: 'Controls and how HUKUM works', onclick: () => onHelp && onHelp() }, '?');

  root.append(wordmark, clock, transport, h('div.tb-sep'), modeWrap, weatherWrap, scenSlot, h('div.tb-spacer'), kpis,
    h('a.tb-btn', { href: 'scan.html', title: 'HUKUM Scan: build the building model from Solar API, blueprints, a phone walkthrough, CCTV and meters', style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, 'Scan'), help);

  layoutScen();

  return {
    update() {
      const mod = minuteOfDay(safe(state.t));
      setText(clockTime, fmtTime(mod));
      setText(clockDay, `Day ${safe(state.day, 1)}${state.paused ? ' · paused' : ''}`);
      setText(pauseBtn, state.paused ? 'Play' : 'Pause');
      setClass(pauseBtn, 'paused', state.paused);
      speeds.set(state.speed);
      mode.set(state.mode);
      if (document.activeElement !== weather && weather.value !== state.scenario.weather) weather.value = state.scenario.weather || 'sunny';

      const sc = state.scenario || {};
      setClass(tOutage, 'on', sc.outage); setClass(tOutage, 'danger', sc.outage);
      setClass(tNet, 'on', sc.internetDown); setClass(tNet, 'warn', sc.internetDown);
      const big = safe(sc.batteryKWh, 400) >= 400;
      setText(tBatt.lastChild, `Battery ${Math.round(safe(sc.batteryKWh, 400))}`);
      setClass(tBatt, 'on', true); setClass(tBatt, 'warn', !big);
      const hk = sc.hukumEnabled !== false;
      setText(tHukum.lastChild, hk ? 'HUKUM on' : 'HUKUM off');
      setClass(tHukum, 'on', hk); setClass(tHukum, 'accent', hk);
      const nActive = (sc.outage ? 1 : 0) + (sc.internetDown ? 1 : 0) + (big ? 0 : 1) + (hk ? 0 : 1);
      setText(scenDot, nActive ? String(nActive) : '');
      setClass(scenBtn, 'alert', !!sc.outage);

      const E = state.energy || {};
      setText(kGrid.v, sc.outage ? 'OFF' : fmtKW(E.gridKW));
      setClass(kGrid.el, 'alert', sc.outage);
      setText(kSolar.v, fmtKW(E.solarKW));
      const band = tariffBand(mod);
      setText(kTariff.v, `Rs ${(safe(E.tariff, 0) > 0 ? E.tariff : tariffAt(mod)).toFixed(1)}`);
      setAttr(kTariff.el, 'data-band', band);
      setAttr(kTariff.el, 'title', band === 'peak' ? 'Peak tariff 18:00-22:00' : band === 'solar' ? 'Solar-hours tariff 09:00-17:00' : 'Normal tariff');
    },
  };
}
