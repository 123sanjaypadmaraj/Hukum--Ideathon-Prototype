// Equipment tab: battery gauge + one card per flexible asset with overrides.
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, setStyle, segmented, fmtKW, fmtPct, safe, isNum, tokens } from './util.js';
import { EQUIPMENT, equipState } from './derive.js';
import { drawRing } from './charts.js';

const KIND_LABEL = { solar: 'Solar', battery: 'Battery', hvac: 'HVAC', pump: 'Pump', ev: 'EV', ebus: 'E-bus' };

export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (/discharg/.test(s)) return 'p-batt';
  if (/charg|pre-cool|running|generat|filling/.test(s)) return 'p-on';
  if (/defer|shed/.test(s)) return 'p-warn';
  if (/off/.test(s)) return 'p-off';
  return 'p-idle';
}

export function createEquipment({ state, actions, onInspect }) {
  const el = h('section.tab-panel.eq');

  // ----- battery hero -----
  const ring = h('canvas.ring');
  const bKW = h('div.stat-v.num', '—');
  const bStatus = h('span.pill', 'idle');
  const bCap = h('div.stat-s.num', '');
  const bPlan = h('div.eq-plan', '');
  const batt = h('div.card.eq-batt', ring, h('div.eq-batt-info',
    h('div.tile-l', 'Battery storage BAT-1'), h('div.eq-batt-row', bKW, bStatus), bCap, bPlan));

  const list = h('div.eq-list');
  const cards = [];
  for (const e of EQUIPMENT) {
    if (e.kind === 'solar') continue;
    const kw = h('span.eq-kw.num', '—');
    const status = h('span.pill', '—');
    const flex = h('span.num', '—');
    const relFill = h('div.bar-fill');
    const relV = h('span.num', '—');
    const lvlFill = h('div.bar-fill.bar-lvl');
    const lvlV = h('span.num', '');
    const lvlLabel = h('span', e.kind === 'pump' ? 'Tank' : 'SOC');
    const hasLevel = e.kind === 'pump' || e.kind === 'ev' || e.kind === 'ebus' || e.kind === 'battery';
    const seg = segmented([
      { value: 'auto', label: 'Auto', title: 'Let HUKUM dispatch' },
      { value: 'on', label: 'On', title: 'Manual override: force on' },
      { value: 'off', label: 'Off', title: 'Manual override: force off' },
    ], (v) => actions.setEquipmentOverride(e.id, v === 'auto' ? null : v), 'seg-sm');
    const conn = h('span.eq-conn', '');
    const card = h('div.eq-card', [
      h('div.eq-top',
        h('div', h('button.link.eq-name', { type: 'button', onclick: () => onInspect('equipment', e.id) }, e.name),
          h('div.cell-sub', `${e.id} · ${KIND_LABEL[e.kind] || e.kind} · rated ${fmtKW(e.ratedKW)}`)),
        h('div.eq-right', kw, status)),
      h('div.eq-metrics',
        h('div.eq-m', h('span.eq-ml', 'Flex now'), flex),
        h('div.eq-m.eq-wide', h('span.eq-ml', 'Reliability'), h('div.bar', relFill), relV),
        hasLevel ? h('div.eq-m.eq-wide', h('span.eq-ml', lvlLabel), h('div.bar', lvlFill), lvlV) : null),
      h('div.eq-bottom', conn, seg.el),
    ]);
    list.append(card);
    cards.push({ e, kw, status, flex, relFill, relV, lvlFill, lvlV, seg, conn, card, hasLevel });
  }

  el.append(batt, h('div.section-h', 'Flexible assets'), list);

  return {
    el,
    update() {
      const C = tokens();
      const b = equipState(state, 'BAT-1');
      const cap = safe(state.scenario && state.scenario.batteryKWh, 400);
      drawRing(ring, b.soc, C.battery, isNum(b.soc) ? `${Math.round(b.soc * 100)}%` : '—', 'SOC');
      const bk = safe(b.kW);
      setText(bKW, bk > 0.5 ? `+${fmtKW(bk)}` : bk < -0.5 ? `-${fmtKW(-bk)}` : '0 kW');
      setText(bStatus, b.status || 'idle');
      bStatus.className = `pill ${statusTone(b.status)}`;
      setText(bCap, `${Math.round(safe(b.soc) * cap)} of ${cap} kWh · wear Rs 1.5/kWh`);
      setText(bPlan, bk > 0.5 ? 'Charging on surplus solar for the evening peak.' : bk < -0.5 ? 'Discharging to shave the grid peak.' : 'Holding charge until it is cheapest to use.');

      for (const c of cards) {
        const s = equipState(state, c.e.id);
        const k = safe(s.kW);
        setText(c.kw, fmtKW(k));
        setText(c.status, s.status || 'idle');
        const cls = `pill ${statusTone(s.status)}`;
        if (c.status.className !== cls) c.status.className = cls;
        setText(c.flex, fmtKW(isNum(s.flexKW) ? s.flexKW : c.e.flexKW));
        setStyle(c.relFill, 'width', `${safe(s.reliability) * 100}%`);
        setText(c.relV, fmtPct(s.reliability));
        if (c.hasLevel) {
          const lvl = c.e.kind === 'pump' ? s.tankLevel : s.soc;
          setStyle(c.lvlFill, 'width', `${safe(lvl) * 100}%`);
          setText(c.lvlV, fmtPct(lvl));
        }
        c.seg.set(s.override || 'auto');
        setClass(c.card, 'overridden', !!s.override);
        setClass(c.card, 'active', Math.abs(k) > 0.5);
        let connText = s.override ? `Manual ${s.override}` : '';
        if (c.e.kind === 'ev' || c.e.kind === 'ebus') {
          const ss = s.session;
          if (s.connected && ss && isNum(ss.needKWh)) {
            connText = `${Math.round(safe(ss.deliveredKWh))} / ${Math.round(ss.needKWh)} kWh${isNum(ss.departT) ? `, leaves ${fmtTime(minuteOfDay(ss.departT))}` : ''}`;
          } else connText = s.connected ? 'Vehicle plugged in' : 'No vehicle';
        }
        if (s.intent && !s.override) connText = connText ? `${connText} · ${s.intent}` : String(s.intent);
        setText(c.conn, connText);
      }
    },
  };
}
