// Tab renderers for the agents control room: Overview, one tab per agent, Trace.
// Every field may be missing; nothing here may throw on partial data.
import {
  h, AGENTS, agentMeta, colorOf, num, arr, obj, str, fmtNum, fmtRs, fmtUnit, fmtPct, fmtRatio, fmtByKey,
  humanize, fmtClock, safeJson,
} from './util.js';
import { scheduleChart, barChart } from './charts.js';

// ---------------------------------------------------------------- building blocks
export const chip = (text, tone = '') => h('span', { class: `ag-chip ${tone}` }, text);
const card = (title, ...kids) => h('section', { class: 'ag-card' }, title ? h('h3', {}, title) : null, ...kids);
const empty = (text) => h('div', { class: 'ag-empty' }, text);
const para = (text) => (text ? h('p', { class: 'ag-summary' }, text) : null);

function tiles(list) {
  const items = list.filter((t) => t && t[1] != null && t[1] !== '-' && t[1] !== '');
  if (!items.length) return null;
  return h('div', { class: 'ag-tiles' }, ...items.map(([label, value, tone]) => h('div', { class: `ag-tile ${tone || ''}` }, h('b', {}, value), h('span', {}, label))));
}
function kv(pairs) {
  const items = pairs.filter((p) => p && p[1] != null && p[1] !== '' && p[1] !== '-');
  if (!items.length) return null;
  return h('dl', { class: 'ag-kv' }, ...items.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : String(v))]));
}
// cols: [{label, get(row) -> string|Node, cls}]
function table(cols, rows, { max = 60, emptyText = 'Nothing to show.' } = {}) {
  const list = arr(rows).filter((r) => r != null);
  if (!list.length) return empty(emptyText);
  const shown = list.slice(0, max);
  const t = h('table', { class: 'ag-table' },
    h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { class: c.cls || '' }, c.label)))),
    h('tbody', {}, ...shown.map((r) => h('tr', {}, ...cols.map((c) => {
      let v;
      try { v = c.get(r); } catch { v = '-'; }
      return h('td', { class: c.cls || '' }, v == null || v === '' ? '-' : v);
    })))));
  const wrap = h('div', { class: 'ag-table-wrap' }, t);
  if (list.length > max) wrap.append(h('div', { class: 'ag-more' }, `and ${list.length - max} more`));
  return wrap;
}
function bullets(list) {
  const items = arr(list).map((x) => str(x)).filter(Boolean);
  return items.length ? h('ul', { class: 'ag-bullets' }, ...items.map((t) => h('li', {}, t))) : null;
}
function meter(ratio, tone) {
  const r = Math.max(0, Math.min(1, num(ratio, 0)));
  return h('span', { class: `ag-meter ${tone || ''}` }, h('i', { style: { width: `${(r * 100).toFixed(0)}%` } }));
}
const TONE = {
  ok: 'ok', approved: 'ok', executed: 'ok', pass: 'ok', passed: 'ok', fair: 'ok', done: 'ok',
  degraded: 'warn', warn: 'warn', warning: 'warn', pending_approval: 'warn', planned: 'info', shadow: 'muted', review: 'warn', medium: 'warn',
  fault: 'bad', block: 'bad', rejected: 'bad', error: 'bad', high: 'bad', critical: 'bad', short: 'bad', shortfall: 'bad', underpaid: 'bad', dispute: 'bad',
  P1: 'bad', P2: 'warn', P3: 'info', low: 'info',
};
export const toneOf = (v) => TONE[v] || TONE[String(v || '').toLowerCase()] || '';
const statusChip = (v) => chip(humanize(str(v, 'unknown')).toLowerCase(), toneOf(v));
// Control actions: in approve mode an approved action comes back as status "executed" + approval "approved".
export function actionState(a) {
  const o = obj(a);
  if (o.approval === 'rejected' || o.status === 'rejected') return 'rejected';
  if (o.approval === 'approved' || o.status === 'approved') return 'approved';
  return str(o.status, 'planned');
}
function actionChip(a) {
  const o = obj(a); const st = actionState(o);
  return h('span', { class: 'ag-chipset' }, statusChip(st), st === 'approved' && o.status === 'executed' ? h('span', { class: 'muted mono sm' }, 'executed') : null);
}
const riskTone = (v) => { const n = num(v); if (n == null) return toneOf(v) || 'warn'; const r = n > 1 ? n / 100 : n; return r > 0.6 ? 'bad' : r > 0.3 ? 'warn' : 'info'; };
function exportTone(ex) { return num(ex.shortfall_rs, 0) > 0 || /under|short|dispute/i.test(str(ex.verdict)) ? 'bad' : (ex.verdict ? 'ok' : ''); }

// ---------------------------------------------------------------- overview
export function renderOverview(R, { openAgent } = {}) {
  const st = R.state || {};
  const rep = obj(st.report);
  const root = h('div', { class: 'ag-pane' });
  if (!R.started && !Object.keys(rep).length) {
    root.append(empty('No run yet. Set a goal on the left and press Run, or replay the recorded run.'));
    return root;
  }
  if (rep.headline) root.append(h('div', { class: 'ag-headline' }, str(rep.headline)));
  else root.append(h('div', { class: 'ag-headline muted' }, R.finished ? 'Run finished without a report.' : 'The report appears here when the reporter finishes. Live results so far:'));

  const k = obj(rep.kpis);
  const kTiles = Object.entries(k).slice(0, 16).map(([key, v]) => [humanize(key).replace(/\s(Rs|kWp|kWh year|kWh|kW|years|pct|t year)$/, ''), fmtByKey(key, v)]);
  if (kTiles.length) root.append(tiles(kTiles));

  const secs = arr(rep.sections);
  if (secs.length) {
    root.append(h('div', { class: 'ag-sections' }, ...secs.map((sec) => {
      const s = obj(sec);
      const id = str(s.agent);
      return h('section', { class: 'ag-card ag-sec', style: { borderLeftColor: colorOf(id) } },
        h('h3', {}, h('button', { class: 'ag-link', type: 'button', onclick: () => openAgent && openAgent(id) }, str(s.title) || agentMeta(id).label)),
        bullets(s.bullets) || empty('No bullets.'));
    })));
  } else {
    // No report yet: one line per agent that has produced output.
    const rows = AGENTS.filter((a) => st[a.key] != null).map((a) => {
      const slice = obj(st[a.key]);
      return h('section', { class: 'ag-card ag-sec', style: { borderLeftColor: colorOf(a.id) } },
        h('h3', {}, h('button', { class: 'ag-link', type: 'button', onclick: () => openAgent && openAgent(a.id) }, a.label)),
        para(str(slice.summary) || quickFacts(a.id, st)) || empty('Output received.'));
    });
    root.append(rows.length ? h('div', { class: 'ag-sections' }, ...rows) : empty('Waiting for the first agent to finish.'));
  }
  if (arr(st.approvals).length) root.append(card('Human decisions', approvalsTable(st.approvals)));
  return root;
}

// One-sentence fallback summary per agent (also used for offline "Ask").
export function quickFacts(id, st) {
  const S = obj(st && st[agentMeta(id).key]);
  switch (id) {
    case 'mapping': {
      const roof = obj(S.roof);
      return `Mapped ${obj(S.building).name || 'the building'}: ${arr(S.rooms).length} rooms, ${arr(S.equipment).length} equipment items, roof usable ${fmtUnit(roof.usable_m2, 'm2', 0)}, up to ${fmtUnit(roof.max_kwp, 'kWp')}. ${arr(S.open_questions).length} open questions.`;
    }
    case 'solar_planner':
      return `Plan pass ${S.iteration ?? '-'}: ${fmtUnit(S.kwp, 'kWp')} with ${fmtNum(S.panels, 0)} panels, ${fmtUnit(S.yield_kwh_year, 'kWh a year')}, capex ${fmtRs(S.capex_rs)}, payback ${fmtUnit(S.payback_years, 'years')}.`;
    case 'environment':
      return `Review pass ${S.iteration ?? '-'}: ${S.approved ? 'approved' : 'sent back'} with ${arr(S.issues).length} issues. CO2 avoided ${fmtUnit(S.co2_avoided_t_year, 't a year')}, carbon payback ${fmtUnit(S.carbon_payback_years, 'years')}.`;
    case 'solar_health':
      return `PR ${fmtRatio(S.pr)}, ${arr(S.strings).filter((x) => obj(x).status && obj(x).status !== 'ok').length} strings need attention, soiling loss ${fmtPct(S.soiling_loss_pct)}${S.cleaning_due ? ', cleaning due' : ''}.`;
    case 'fault_maintenance':
      return `${arr(S.work_orders).length} work orders (${arr(S.work_orders).filter((w) => obj(w).priority === 'P1').length} P1) and ${arr(S.predictive).length} predicted failures.`;
    case 'bill_auditor':
      return `${arr(S.findings).length} findings across ${arr(S.bills).length} bills; overcharge ${fmtRs(S.overcharge_rs)}, recoverable ${fmtRs(S.recoverable_rs)}.`;
    case 'negotiator': {
      const ex = obj(S.export_check);
      return `${arr(S.trades).length} trades between campuses; export credit verdict: ${ex.verdict || '-'} (shortfall ${fmtRs(ex.shortfall_rs)}).`;
    }
    case 'control':
      return `${arr(S.actions).length} actions in ${S.pilot_mode || '-'} mode: ${countBy(arr(S.actions).map((a) => ({ s: actionState(a) })), 's')}.`;
    case 'optimiser':
      return `Optimised the next 24 h: cost ${fmtRs(obj(S.baseline).cost_rs)} to ${fmtRs(obj(S.optimised).cost_rs)} (saving ${fmtPct(S.saving_pct)}), peak ${fmtUnit(obj(S.optimised).peak_kw, 'kW')}.`;
    default:
      return '';
  }
}
function countBy(list, key) {
  const m = {};
  for (const x of list) { const k = str(obj(x)[key], 'unknown'); m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).map(([k, v]) => `${v} ${humanize(k).toLowerCase()}`).join(', ') || 'none';
}

// ---------------------------------------------------------------- per agent
const RENDER = {
  mapping(S) {
    const site = obj(S.site), b = obj(S.building), roof = obj(S.roof), irr = obj(S.irradiance);
    const out = [];
    out.push(tiles([
      ['Rooms', arr(S.rooms).length || null], ['Circuits', arr(S.circuits).length || null], ['Equipment', arr(S.equipment).length || null],
      ['Roof usable', fmtUnit(roof.usable_m2, 'm2', 0)], ['Max solar', fmtUnit(roof.max_kwp, 'kWp')], ['Model confidence', S.confidence != null ? fmtRatio(S.confidence, 0) : null],
    ]));
    out.push(h('div', { class: 'ag-grid2' },
      card('Site and building', kv([
        ['Site', site.name], ['Location', site.lat != null ? `${fmtNum(site.lat, 4)}, ${fmtNum(site.lon, 4)}` : null],
        ['Building', b.name || b.id], ['Floors', b.floors], ['Footprint', fmtUnit(b.footprint_m2, 'm2', 0)], ['Height', fmtUnit(b.height_m, 'm')],
        ['Irradiance', irr.ghi_kwh_m2_day != null ? `${fmtNum(irr.ghi_kwh_m2_day, 2)} kWh/m2/day` : null], ['Irradiance source', irr.source],
      ]) || empty('No site data.')),
      card('Roof', kv([
        ['Roof area', fmtUnit(roof.area_m2, 'm2', 0)], ['Usable', fmtUnit(roof.usable_m2, 'm2', 0)], ['Max panels', roof.max_panels],
        ['Panel', roof.panel_watts != null ? `${fmtNum(roof.panel_watts, 0)} W` : null], ['Max size', fmtUnit(roof.max_kwp, 'kWp')], ['Source', roof.source],
      ]) || empty('No roof data.'))));
    if (arr(roof.segments).length) {
      out.push(card('Roof segments', table([
        { label: '#', get: (r) => str(r.index), cls: 'mono' }, { label: 'Pitch', get: (r) => fmtUnit(r.pitch_deg, 'deg'), cls: 'mono' },
        { label: 'Azimuth', get: (r) => fmtUnit(r.azimuth_deg, 'deg', 0), cls: 'mono' }, { label: 'Area', get: (r) => fmtUnit(r.area_m2, 'm2', 0), cls: 'mono' },
        { label: 'Sun hours / yr', get: (r) => fmtNum(r.sunshine_hours, 0), cls: 'mono' },
      ], roof.segments)));
    }
    out.push(card('Rooms', table([
      { label: 'Room', get: (r) => str(r.id), cls: 'mono' }, { label: 'Floor', get: (r) => str(r.floor) }, { label: 'Name', get: (r) => str(r.name) },
      { label: 'Type', get: (r) => str(r.type) }, { label: 'Area', get: (r) => fmtUnit(r.area_m2, 'm2', 0), cls: 'mono' }, { label: 'Seats', get: (r) => fmtNum(r.seats, 0), cls: 'mono' },
      { label: 'Confidence', get: (r) => (r.confidence == null ? '-' : h('span', {}, meter(num(r.confidence, 0) > 1 ? num(r.confidence) / 100 : r.confidence, num(r.confidence, 0) < 0.7 ? 'warn' : 'ok'), fmtRatio(r.confidence, 0))) },
    ], S.rooms, { max: 40, emptyText: 'No rooms mapped yet.' })));
    if (arr(S.equipment).length) {
      out.push(card('Equipment', table([
        { label: 'Id', get: (r) => str(r.id), cls: 'mono' }, { label: 'Kind', get: (r) => str(r.kind) }, { label: 'Room', get: (r) => str(r.room), cls: 'mono' },
        { label: 'Rated', get: (r) => fmtUnit(r.rated_kw, 'kW'), cls: 'mono' }, { label: 'Measured', get: (r) => fmtUnit(r.measured_kw, 'kW'), cls: 'mono' },
      ], S.equipment, { max: 30 })));
    }
    if (arr(S.circuits).length) {
      out.push(card(`Circuits (${arr(S.circuits).length})`, table([
        { label: 'Circuit', get: (r) => str(r.id), cls: 'mono' }, { label: 'Panel', get: (r) => str(r.panel), cls: 'mono' }, { label: 'Room', get: (r) => str(r.room), cls: 'mono' },
        { label: 'Confidence', get: (r) => fmtRatio(r.confidence, 0), cls: 'mono' },
      ], S.circuits, { max: 20 })));
    }
    out.push(h('div', { class: 'ag-grid2' },
      card('Sources', arr(S.sources).length ? h('div', { class: 'ag-chips' }, ...arr(S.sources).map((x) => chip(str(x), 'info'))) : empty('No sources listed.')),
      card('Open questions for a person', bullets(S.open_questions) || empty('None. The model is confident enough.'))));
    return out;
  },

  solar_planner(S, R) {
    const st = R.state || {};
    const out = [];
    out.push(tiles([
      ['Size', fmtUnit(S.kwp, 'kWp')], ['Panels', S.panels != null ? fmtNum(S.panels, 0) : null], ['Yield / yr', fmtUnit(S.yield_kwh_year, 'kWh')],
      ['Specific yield', S.specific_yield != null ? `${fmtNum(S.specific_yield, 0)} kWh/kWp` : null], ['Capex', fmtRs(S.capex_rs)], ['Savings / yr', fmtRs(S.savings_rs_year), 'good'],
      ['Payback', fmtUnit(S.payback_years, 'yr')], ['Self consumption', S.self_consumption_pct != null ? fmtPct(S.self_consumption_pct, 0) : null], ['Battery', fmtUnit(S.battery_kwh, 'kWh')],
    ]));
    out.push(card('Layout', kv([
      ['Pass', S.iteration ?? st.plan_iterations], ['Tilt', fmtUnit(S.tilt_deg, 'deg')], ['Azimuth', fmtUnit(S.azimuth_deg, 'deg', 0)],
      ['Roof segments used', arr(S.segments_used).length ? arr(S.segments_used).join(', ') : null], ['Edge setback', fmtUnit(S.setback_m, 'm')],
    ]) || empty('No layout yet.')));
    out.push(card('Plan and review history (Solar Planner and Environmental Engineer loop)', planHistoryTable(S, R)));
    const hist = mergedPlanHistory(S, R);
    if (hist.length > 1) out.push(card('Size by pass', barChart(hist.map((x) => ({ label: `Pass ${x.iteration}`, value: x.kwp, color: x.review && x.review.approved ? '#52c41a' : '#ffc53d' })), { unit: 'kWp', height: 110 })));
    return out;
  },

  environment(S, R) {
    const out = [];
    const approved = S.approved === true;
    out.push(h('div', { class: 'ag-verdict' }, chip(approved ? 'approved' : S.approved === false ? 'sent back to planner' : 'pending', approved ? 'ok' : S.approved === false ? 'warn' : 'muted'),
      h('span', {}, `Review pass ${S.iteration ?? '-'}`)));
    out.push(tiles([
      ['CO2 avoided / yr', fmtUnit(S.co2_avoided_t_year, 't'), 'good'], ['Embodied CO2', fmtUnit(S.embodied_co2_t, 't')],
      ['Carbon payback', fmtUnit(S.carbon_payback_years, 'yr')], ['Cleaning water / yr', fmtUnit(S.water_l_year, 'L', 0)],
    ]));
    if (arr(S.conditions).length) out.push(card('Conditions attached to the approval', bullets(arr(S.conditions).map((c) => (typeof c === 'object' ? [c.code, c.text || c.fix].filter(Boolean).join(': ') : c)))));
    out.push(card('Issues in this pass', issuesTable(S.issues)));
    const passes = arr(R.envHistory);
    if (passes.length > 1) {
      out.push(card('Every review pass', table([
        { label: 'Pass', get: (r) => str(r.iteration), cls: 'mono' },
        { label: 'Verdict', get: (r) => chip(r.approved ? 'approved' : 'sent back', r.approved ? 'ok' : 'warn') },
        { label: 'Issues', get: (r) => issueList(r.issues) },
      ], passes)));
    }
    if (arr(S.notes).length) out.push(card('Notes', bullets(S.notes)));
    return out;
  },

  solar_health(S) {
    const out = [];
    out.push(tiles([
      ['Performance ratio', S.pr != null ? fmtRatio(S.pr) : null, num(S.pr, 1) < 0.75 && num(S.pr, 100) <= 1 ? 'warn' : ''],
      ['Expected', fmtUnit(S.expected_kwh, 'kWh')], ['Actual', fmtUnit(S.actual_kwh, 'kWh')],
      ['Soiling loss', S.soiling_loss_pct != null ? fmtPct(S.soiling_loss_pct) : null], ['Cleaning', S.cleaning_due == null ? null : S.cleaning_due ? 'due now' : 'not due', S.cleaning_due ? 'warn' : ''],
      ['Money lost / day', S.lost_rs_day != null ? fmtRs(S.lost_rs_day) : null, 'bad'],
    ]));
    const lb = obj(S.loss_breakdown_kwh);
    const lbItems = Object.entries(lb).filter(([, v]) => num(v) != null);
    if (lbItems.length) out.push(card('Where the energy is lost (kWh today)', barChart(lbItems.map(([k, v]) => ({ label: humanize(k), value: v, color: '#ff7a45' })), { unit: 'kWh', height: 120 })));
    else if (Array.isArray(S.loss_breakdown_kwh) && S.loss_breakdown_kwh.length) out.push(card('Where the energy is lost', bullets(S.loss_breakdown_kwh.map((x) => (typeof x === 'object' ? safeJson(x, 200) : x)))));
    const strings = arr(S.strings).filter((x) => x && typeof x === 'object').slice()
      .sort((a, b) => num(a.ratio, 9) - num(b.ratio, 9));
    out.push(card('Strings by output ratio (actual / expected)', strings.length ? h('div', { class: 'ag-strings' }, ...strings.map((x) => {
      const r = num(x.ratio, null);
      const tone = x.status === 'fault' ? 'bad' : x.status === 'degraded' ? 'warn' : 'ok';
      return h('div', { class: 'ag-string' },
        h('span', { class: 'mono' }, str(x.id)), h('span', { class: 'muted mono' }, str(x.inverter)),
        h('span', { class: `ag-sbar ${tone}` }, h('i', { style: { width: `${Math.max(2, Math.min(100, (r == null ? 0 : (r > 1.5 ? r / 100 : r)) * 100 / 1.1))}%` } }), h('em', { style: { left: `${100 / 1.1}%` } })),
        h('span', { class: 'mono' }, r == null ? '-' : fmtRatio(r, 0)), statusChip(x.status),
        h('span', { class: 'ag-diag', title: str(x.diagnosis) }, str(x.diagnosis)));
    })) : empty('No string data.')));
    out.push(card('Inverters', table([
      { label: 'Inverter', get: (r) => str(r.id), cls: 'mono' }, { label: 'Status', get: (r) => statusChip(r.status) },
      { label: 'Efficiency', get: (r) => fmtRatio(r.efficiency), cls: 'mono' }, { label: 'Temp', get: (r) => fmtUnit(r.temp_c, 'C', 0), cls: 'mono' },
      { label: 'Alarms', get: (r) => arr(r.alarms).join('; ') || 'none' },
    ], S.inverters, { emptyText: 'No inverter data.' })));
    return out;
  },

  fault_maintenance(S) {
    const out = [];
    const wos = arr(S.work_orders).filter((x) => x && typeof x === 'object').slice()
      .sort((a, b) => str(a.priority, 'P9').localeCompare(str(b.priority, 'P9')) || num(b.energy_at_risk_kwh, 0) - num(a.energy_at_risk_kwh, 0));
    out.push(tiles([
      ['Work orders', wos.length || null], ['P1 urgent', wos.filter((w) => w.priority === 'P1').length || null, 'bad'],
      ['Est. cost', wos.length ? fmtRs(wos.reduce((a, w) => a + num(w.est_cost_rs, 0), 0)) : null],
      ['Energy at risk', wos.length ? fmtUnit(wos.reduce((a, w) => a + num(w.energy_at_risk_kwh, 0), 0), 'kWh') : null],
      ['Money at risk / month', wos.some((w) => w.rs_at_risk_month != null) ? fmtRs(wos.reduce((a, w) => a + num(w.rs_at_risk_month, 0), 0)) : null, 'bad'],
    ]));
    out.push(card('Work orders by priority', wos.length ? h('div', { class: 'ag-wos' }, ...wos.map((w) => h('div', { class: `ag-wo ${toneOf(w.priority)}` },
      h('div', { class: 'ag-wo-head' }, chip(str(w.priority, '-'), toneOf(w.priority)), h('b', {}, str(w.asset) || str(w.id)), h('span', { class: 'mono muted' }, str(w.id)),
        h('span', { class: 'ag-wo-due' }, w.due ? `due ${str(w.due)}` : '')),
      h('div', {}, str(w.issue)),
      w.evidence ? h('div', { class: 'muted' }, `Evidence: ${str(w.evidence)}`) : null,
      w.action ? h('div', {}, `Action: ${str(w.action)}`) : null,
      h('div', { class: 'mono muted' }, [`cost ${fmtRs(w.est_cost_rs)}`, num(w.energy_at_risk_kwh) ? fmtUnit(w.energy_at_risk_kwh, 'kWh at risk') : null, w.rs_at_risk_month != null ? `${fmtRs(w.rs_at_risk_month)} a month at risk` : null].filter(Boolean).join('  |  '))))) : empty('No work orders.')));
    out.push(card('Predicted failures', table([
      { label: 'Asset', get: (r) => str(r.asset) },
      { label: 'Risk', get: (r) => { const v = num(r.risk); return v == null ? chip(str(r.risk, '-'), riskTone(r.risk)) : h('span', {}, meter(v > 1 ? v / 100 : v, riskTone(v)), fmtRatio(v, 0)); } },
      { label: 'Remaining life', get: (r) => fmtUnit(r.rul_days, 'days', 0), cls: 'mono' }, { label: 'Signal', get: (r) => str(r.signal) },
    ], S.predictive, { emptyText: 'No predictions.' })));
    return out;
  },

  bill_auditor(S) {
    const out = [];
    const findings = arr(S.findings).filter((x) => x && typeof x === 'object').slice().sort((a, b) => num(b.impact_rs, 0) - num(a.impact_rs, 0));
    out.push(tiles([
      ['Overcharge found', fmtRs(S.overcharge_rs), 'bad'], ['Recoverable', fmtRs(S.recoverable_rs), 'good'],
      ['Findings', findings.length || null], ['Bills checked', arr(S.bills).length || null],
    ]));
    out.push(card('Findings (largest impact first)', table([
      { label: 'Code', get: (r) => chip(str(r.code), 'info') }, { label: 'Month', get: (r) => str(r.month), cls: 'mono' }, { label: 'Finding', get: (r) => str(r.text) },
      { label: 'Impact', get: (r) => fmtRs(r.impact_rs), cls: 'mono num' }, { label: 'Evidence', get: (r) => str(r.evidence) }, { label: 'Action', get: (r) => str(r.action) },
    ], findings, { emptyText: 'No findings. The bills match the meter and the tariff.' }),
    findings.length ? h('div', { class: 'ag-total' }, `Total impact ${fmtRs(findings.reduce((a, f) => a + num(f.impact_rs, 0), 0))}`) : null));
    const bills = arr(S.bills).filter((x) => x && typeof x === 'object');
    if (bills.length) {
      const flagged = new Set(findings.map((f) => str(f.month)));
      out.push(card('Bills', barChart(bills.map((b) => ({ label: str(b.month), value: b.amount_rs, color: flagged.has(str(b.month)) ? '#ff4d4f' : '#69b1ff' })), { height: 120, format: (v) => fmtRs(v).replace('Rs ', '') }),
        table([
          { label: 'Month', get: (r) => str(r.month), cls: 'mono' }, { label: 'Units', get: (r) => fmtUnit(r.units_kwh, 'kWh', 0), cls: 'mono num' },
          { label: 'Amount', get: (r) => fmtRs(r.amount_rs), cls: 'mono num' }, { label: 'Demand', get: (r) => fmtUnit(r.demand_kva, 'kVA', 0), cls: 'mono num' },
          { label: '', get: (r) => (flagged.has(str(r.month)) ? chip('finding', 'bad') : '') },
        ], bills)));
    }
    if (S.claim != null) {
      const c = S.claim;
      if (typeof c === 'object' && !Array.isArray(c)) {
        out.push(h('section', { class: 'ag-card ag-claim' }, h('h3', {}, 'Claim letter, ready to send'),
          kv([['To', c.to ? str(c.to) : null], ['Amount', c.amount_rs != null ? fmtRs(c.amount_rs) : null], ['Subject', c.subject ? str(c.subject) : null]]),
          bullets(c.items), arr(c.attachments).length ? h('div', { class: 'ag-chips' }, h('span', { class: 'muted' }, 'Attach:'), ...arr(c.attachments).map((x) => chip(str(x), 'info'))) : null,
          c.text || c.body ? h('p', { class: 'ag-summary' }, str(c.text || c.body)) : null));
      } else out.push(card('Claim', Array.isArray(c) ? bullets(c) : para(str(c))));
    }
    const tc = obj(S.tariff_check);
    if (Object.keys(tc).length) out.push(card('Tariff check', kv(Object.entries(tc).map(([k, v]) => [humanize(k), Array.isArray(v) ? v.map((x) => str(x)).join('; ') : fmtByKey(k, v)]))));
    return out;
  },

  negotiator(S) {
    const out = [];
    const trades = arr(S.trades).filter((x) => x && typeof x === 'object');
    out.push(tiles([
      ['Export price', S.export_price_rs != null ? `Rs ${fmtNum(S.export_price_rs, 2)}/kWh` : null], ['Grid import', S.grid_import_rs != null ? `Rs ${fmtNum(S.grid_import_rs, 2)}/kWh` : null],
      ['Trades', trades.length || null], ['Gain from trades', trades.length ? fmtRs(trades.reduce((a, t) => a + num(t.gain_rs, 0), 0)) : null, 'good'],
    ]));
    const ex = obj(S.export_check);
    if (Object.keys(ex).length) {
      const tone = exportTone(ex);
      out.push(h('section', { class: `ag-card ag-export ${tone}` }, h('h3', {}, `Export credit check${ex.period ? ', ' + str(ex.period) : ''}`),
        h('div', { class: 'ag-verdict' }, chip(tone === 'bad' ? 'under-credited' : tone === 'ok' ? 'credited correctly' : 'unknown', tone), h('span', {}, str(ex.verdict))),
        kv([['Metered export', fmtUnit(ex.metered_export_kwh, 'kWh')], ['Credited', fmtUnit(ex.credited_kwh, 'kWh')], ['Credited amount', fmtRs(ex.credited_rs)], ['Expected amount', fmtRs(ex.expected_rs)],
          ['Shortfall', fmtRs(ex.shortfall_rs)], ['Gap', ex.gap_pct != null ? fmtPct(ex.gap_pct) : null], ['Action', ex.action ? str(ex.action) : null], ['Related', ex.related ? str(ex.related) : null]])));
    }
    out.push(card('Trades between campuses', table([
      { label: 'Seller', get: (r) => str(r.seller) }, { label: 'Buyer', get: (r) => str(r.buyer) }, { label: 'Energy', get: (r) => fmtUnit(r.kwh, 'kWh'), cls: 'mono num' },
      { label: 'Price', get: (r) => (r.price_rs != null ? `Rs ${fmtNum(r.price_rs, 2)}` : '-'), cls: 'mono num' }, { label: 'Window', get: (r) => str(r.window), cls: 'mono' },
      { label: 'Gain', get: (r) => fmtRs(r.gain_rs), cls: 'mono num' },
    ], trades, { emptyText: 'No trades.' })));
    out.push(card('Campuses', table([
      { label: 'Campus', get: (r) => str(r.name || r.id) }, { label: 'Surplus', get: (r) => fmtUnit(r.surplus_kwh, 'kWh'), cls: 'mono num' },
      { label: 'Deficit', get: (r) => fmtUnit(r.deficit_kwh, 'kWh'), cls: 'mono num' }, { label: 'Bid', get: (r) => (r.bid_rs != null ? `Rs ${fmtNum(r.bid_rs, 2)}` : '-'), cls: 'mono num' },
      { label: 'Ask', get: (r) => (r.ask_rs != null ? `Rs ${fmtNum(r.ask_rs, 2)}` : '-'), cls: 'mono num' },
    ], S.campuses, { emptyText: 'No campus data.' })));
    return out;
  },

  control(S, R) {
    const out = [];
    const acts = arr(S.actions).filter((x) => x && typeof x === 'object');
    out.push(h('div', { class: 'ag-verdict' }, h('span', {}, 'Pilot mode'), chip(str(S.pilot_mode, '-'), 'info'), h('span', { class: 'muted' }, countBy(acts.map((a) => ({ s: actionState(a) })), 's'))));
    out.push(card('Actions', acts.length ? h('div', { class: 'ag-actions' }, ...acts.map((a) => h('div', { class: 'ag-act' },
      h('span', { class: 'mono muted' }, str(a.t)), h('b', {}, str(a.asset)), h('span', {}, str(a.action)),
      h('span', { class: 'mono' }, a.kw != null ? fmtUnit(a.kw, 'kW') : ''), actionChip(a),
      a.reason ? h('div', { class: 'ag-act-why' }, str(a.reason)) : null))) : empty('No actions planned.')));
    out.push(card('Safety checks', bullets(S.safety) || empty('No safety notes.')));
    if (arr((R.state || {}).approvals).length) out.push(card('Human decisions', approvalsTable(R.state.approvals)));
    return out;
  },

  optimiser(S) {
    const out = [];
    const b = obj(S.baseline), o = obj(S.optimised);
    out.push(tiles([
      ['Saving', S.saving_pct != null ? fmtPct(S.saving_pct) : null, 'good'], ['Cost after', fmtRs(o.cost_rs)], ['Peak after', fmtUnit(o.peak_kw, 'kW')],
      ['Evening peak after', o.evening_peak_kw != null ? fmtUnit(o.evening_peak_kw, 'kW') : S.evening_peak_kw != null ? fmtUnit(obj(S.evening_peak_kw).optimised ?? S.evening_peak_kw, 'kW') : null],
      ['Horizon', S.horizon_slots != null ? `${S.horizon_slots} x 15 min` : null],
    ]));
    if (S.objective) out.push(para(`Objective: ${str(S.objective)}`));
    out.push(card('Next 24 hours, optimised', scheduleChart(S.schedule)));
    const keys = ['cost_rs', 'peak_kw', 'evening_peak_kw', 'co2_kg', 'import_kwh', 'export_kwh'];
    const bo = S.battery_only && typeof S.battery_only === 'object' ? S.battery_only : null;
    const extra = Object.keys({ ...b, ...o }).filter((k) => !keys.includes(k));
    out.push(card('Baseline vs optimised', table([
      { label: 'Measure', get: (k) => humanize(k) }, { label: 'Baseline', get: (k) => fmtByKey(k, b[k]), cls: 'mono num' },
      ...(bo ? [{ label: 'Battery only', get: (k) => fmtByKey(k, bo[k]), cls: 'mono num' }] : []),
      { label: 'Optimised', get: (k) => fmtByKey(k, o[k]), cls: 'mono num' },
      { label: 'Change', get: (k) => { const x = num(b[k]), y = num(o[k]); if (x == null || y == null || x === 0) return '-'; const d = ((y - x) / Math.abs(x)) * 100; return chip(`${d > 0 ? '+' : ''}${d.toFixed(1)}%`, (k === 'export_kwh' ? d >= 0 : d <= 0) ? 'ok' : 'warn'); } },
    ], [...keys, ...extra].filter((k) => b[k] != null || o[k] != null), { emptyText: 'No comparison yet.' })));
    const ws = S.with_new_solar;
    if (ws && typeof ws === 'object') out.push(card('With the new rooftop plan added', kv(Object.entries(ws).map(([k, v]) => [humanize(k), fmtByKey(k, v)]))));
    else if (S.battery_only != null && !bo) out.push(card('Battery only', para(str(S.battery_only))));
    if (arr(S.moves).length) {
      out.push(card('Load moves', table([
        { label: 'Asset', get: (r) => str(r.asset), cls: 'mono' }, { label: 'Power', get: (r) => fmtUnit(r.kw, 'kW'), cls: 'mono num' },
        { label: 'From', get: (r) => str(r.from), cls: 'mono' }, { label: 'To', get: (r) => str(r.to), cls: 'mono' },
        { label: 'Energy', get: (r) => fmtUnit(r.kwh, 'kWh'), cls: 'mono num' }, { label: 'Why', get: (r) => str(r.why) },
      ], S.moves)));
    }
    out.push(card('Constraints respected', bullets(S.constraints) || empty('None listed.')));
    return out;
  },
};

function issueList(issues) {
  const list = arr(issues).filter((x) => x != null);
  if (!list.length) return h('span', { class: 'muted' }, 'none');
  return h('ul', { class: 'ag-issues' }, ...list.map((i) => {
    const o = typeof i === 'object' ? i : { text: String(i) };
    return h('li', {}, chip(str(o.severity, 'note'), toneOf(o.severity)), ' ', h('span', {}, str(o.text) || str(o.code)), o.fix ? h('span', { class: 'muted' }, ` Fix: ${str(o.fix)}`) : null);
  }));
}
function issuesTable(issues) {
  return table([
    { label: 'Severity', get: (r) => chip(str(r.severity, 'note'), toneOf(r.severity)) }, { label: 'Code', get: (r) => str(r.code), cls: 'mono' },
    { label: 'Issue', get: (r) => str(r.text) }, { label: 'Fix', get: (r) => str(r.fix) },
  ], arr(issues).map((i) => (typeof i === 'object' ? i : { text: String(i) })), { emptyText: 'No issues. The plan passes every check.' });
}
function mergedPlanHistory(S, R) {
  const byIt = new Map();
  for (const p of arr(R.planHistory)) { const it = num(p.iteration); if (it != null) byIt.set(it, { iteration: it, kwp: p.kwp, panels: p.panels, payback: p.payback_years }); }
  for (const hst of arr(S.history)) {
    const x = obj(hst); const it = num(x.iteration); if (it == null) continue;
    byIt.set(it, { ...(byIt.get(it) || { iteration: it }), kwp: x.kwp ?? byIt.get(it)?.kwp, change: x.change, reason: x.reason });
  }
  for (const rv of arr(R.envHistory)) { const it = num(rv.iteration); if (it != null) byIt.set(it, { ...(byIt.get(it) || { iteration: it }), review: rv }); }
  return [...byIt.values()].sort((a, b) => a.iteration - b.iteration);
}
function planHistoryTable(S, R) {
  return table([
    { label: 'Pass', get: (r) => str(r.iteration), cls: 'mono' }, { label: 'Size', get: (r) => fmtUnit(r.kwp, 'kWp'), cls: 'mono num' },
    { label: 'Planner change', get: (r) => [str(r.change), r.reason ? h('div', { class: 'muted' }, str(r.reason)) : null] },
    { label: 'Engineer verdict', get: (r) => (r.review ? chip(r.review.approved ? 'approved' : 'sent back', r.review.approved ? 'ok' : 'warn') : h('span', { class: 'muted' }, 'not reviewed')) },
    { label: 'Engineer issues', get: (r) => (r.review ? issueList(r.review.issues) : '') },
  ], mergedPlanHistory(S, R), { emptyText: 'No plan yet.' });
}
function approvalsTable(list) {
  return table([
    { label: 'Decision', get: (r) => statusChip(r.decision) }, { label: 'Actions', get: (r) => arr(r.ids).join(', ') || 'none' },
    { label: 'When', get: (r) => fmtClock(r.t) || str(r.at) },
  ], arr(list).filter((x) => x && typeof x === 'object'));
}

// Agent tab: header, summary, rich body, trace lines, ask box.
export function renderAgent(id, R, { askBox, status } = {}) {
  const meta = agentMeta(id);
  const st = R.state || {};
  const S = obj(st[meta.key]);
  const root = h('div', { class: 'ag-pane' });
  root.append(h('div', { class: 'ag-agent-head', style: { borderLeftColor: colorOf(id) } },
    h('div', {}, h('h2', {}, meta.label), h('div', { class: 'muted' }, meta.role)),
    status ? statusChip(status === 'active' ? 'working' : status === 'interrupt' ? 'needs approval' : status) : null));
  const has = st[meta.key] != null;
  if (!has) {
    root.append(empty(R.started ? (status === 'skipped' ? 'This agent is not in the route for this run.' : 'No output yet. It appears here when the agent finishes.') : 'No run yet.'));
  } else {
    root.append(para(str(S.summary) || quickFacts(id, st)));
    let body = [];
    try { body = (RENDER[id] || genericRender)(S, R); } catch (err) { console.error('agents: render failed for', id, err); body = [genericRender(S)]; }
    for (const b of arr(body)) if (b) root.append(b);
  }
  const lines = arr(R.messages).filter((m) => m.agent === id);
  root.append(card(`Trace (${lines.length})`, lines.length ? h('div', { class: 'ag-trace' }, ...lines.slice(-200).map(traceLine)) : empty('No trace lines yet.')));
  if (askBox) root.append(askBox);
  return root;
}
function genericRender(S) {
  return card('Output', h('pre', { class: 'ag-pre' }, safeJson(S, 6000)));
}

export function traceLine(m) {
  const kind = str(m.kind, 'note');
  return h('div', { class: `ag-line k-${kind}` },
    h('span', { class: 'ag-time' }, fmtClock(m.t)),
    h('span', { class: 'ag-who', style: { color: colorOf(m.agent) } }, agentMeta(m.agent).short),
    h('span', { class: `ag-kind k-${kind}` }, kind),
    h('span', { class: 'ag-text' }, str(m.text)),
    m.data != null && kind !== 'thought' ? h('details', { class: 'ag-data' }, h('summary', {}, 'data'), h('pre', {}, safeJson(m.data, 1500))) : null);
}

