// HUKUM agent control room: mission form, live agent graph, result tabs,
// activity feed and human approval. Live mode talks to the FastAPI backend
// (agents/CONTRACT.md); replay mode plays agents/data/demo_run.json (or the
// file named by ?replay=<url>) when the backend is not reachable.
import { $, h, AGENTS, AGENT_IDS, agentMeta, colorOf, arr, obj, str, num, fmtUnit, fmtClock, debounce, avatar, iconSvg } from './util.js';
import { getHealth, getGraph, startRun, openStream, resumeRun, askAgent, loadReplay, Player } from './api.js';
import { createGraphView, defaultGraph } from './graph.js';
import { renderSkills } from './skills.js';
import { renderOverview, renderAgent, traceLine, quickFacts, chip, actionState } from './views.js';

const params = new URLSearchParams(location.search);
const REPLAY_URL = params.get('replay') || 'agents/data/demo_run.json';
const DEFAULT_GOAL = 'Plan rooftop solar for the NHCE Main Block and have it reviewed, check the health of the existing panels and inverters, audit the last twelve electricity bills, trade surplus solar between our campuses, and run tomorrow at minimum cost. Ask me before switching anything.';
const KIND_LABEL = { thought: 'thought', tool: 'tool', result: 'result', handoff: 'handoff', warning: 'warning', llm: 'llm' };

// ---------------------------------------------------------------- run state
let R = freshRun();
function freshRun() {
  return { state: {}, messages: [], envHistory: [], planHistory: [], started: false, finished: false, threadId: null, mode: 'idle', statuses: {}, pass: 0, ver: { all: 0 }, llm: '' };
}
let health = { ok: false };
let player = null;
let stream = null;
let interrupt = null; // { actions, resolved, decision, timer }
let decisionLogged = false;
let replayData = null;
let activeTab = 'overview';
let speed = 1;

// ---------------------------------------------------------------- layout
const root = $('#ag-app');
const ui = {};

function buildMission() {
  ui.goal = h('textarea', { id: 'ag-goal', rows: 6, spellcheck: 'false' }, DEFAULT_GOAL);
  ui.mode = h('select', { id: 'ag-mode', onchange: () => { ui.custom.hidden = ui.mode.value !== 'custom'; } },
    ...[['full', 'Full: every agent'], ['plan_solar', 'Plan solar'], ['operate', 'Operate the campus'], ['audit', 'Audit bills and export'], ['custom', 'Custom: pick agents']]
      .map(([v, t]) => h('option', { value: v }, t)));
  ui.custom = h('fieldset', { class: 'ag-custom', hidden: true }, h('legend', {}, 'Agents to run'),
    ...AGENTS.map((a) => h('label', { class: 'ag-check' }, h('input', { type: 'checkbox', value: a.id, checked: a.id !== 'environment' }), h('i', { style: { background: colorOf(a.id) } }), a.label)));
  ui.weather = h('select', { id: 'ag-weather' }, ...[['sunny', 'Sunny'], ['cloudy', 'Cloudy'], ['monsoon', 'Monsoon']].map(([v, t]) => h('option', { value: v }, t)));
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  ui.day = h('input', { id: 'ag-day', type: 'date', value: tomorrow });
  ui.pilot = h('select', { id: 'ag-pilot' },
    ...[['approve', 'Approve: ask me first'], ['shadow', 'Shadow: plan only'], ['automate', 'Automate: act within limits']].map(([v, t]) => h('option', { value: v }, t)));
  ui.run = h('button', { class: 'ag-btn primary', type: 'button', onclick: onRun }, 'Run agents');
  ui.replay = h('button', { class: 'ag-btn', type: 'button', onclick: () => startReplay() }, 'Replay recorded run');
  ui.llm = h('span', { class: 'ag-llm', title: 'Language model used by the agents' }, 'checking');
  ui.speedBtns = [1, 2, 4].map((x) => h('button', { type: 'button', class: 'ag-seg', 'aria-pressed': x === 1 ? 'true' : 'false', onclick: () => setSpeed(x) }, `${x}x`));
  ui.skip = h('button', { class: 'ag-btn sm', type: 'button', onclick: () => player && player.skipToEnd() }, 'Skip to end');
  ui.replayBar = h('div', { class: 'ag-replaybar', hidden: true }, h('span', { class: 'muted' }, 'Speed'), h('div', { class: 'ag-segs' }, ...ui.speedBtns), ui.skip);
  ui.progress = h('div', { class: 'ag-progress' }, h('i'));
  ui.runStatus = h('div', { class: 'ag-runstatus', role: 'status' }, 'Idle.');
  ui.route = h('ol', { class: 'ag-route' });

  return h('aside', { id: 'ag-mission', 'aria-label': 'Mission' },
    h('h2', { class: 'ag-h' }, 'Mission'),
    h('label', { class: 'ag-field', for: 'ag-goal' }, h('span', {}, 'Goal'), ui.goal),
    h('label', { class: 'ag-field', for: 'ag-mode' }, h('span', {}, 'Mode'), ui.mode),
    ui.custom,
    h('div', { class: 'ag-row2' },
      h('label', { class: 'ag-field', for: 'ag-weather' }, h('span', {}, 'Weather'), ui.weather),
      h('label', { class: 'ag-field', for: 'ag-day' }, h('span', {}, 'Day'), ui.day)),
    h('label', { class: 'ag-field', for: 'ag-pilot' }, h('span', {}, 'Pilot mode'), ui.pilot),
    h('div', { class: 'ag-btnrow' }, ui.run, ui.replay),
    h('div', { class: 'ag-llmrow' }, h('span', { class: 'muted' }, 'LLM'), ui.llm),
    ui.replayBar, ui.progress, ui.runStatus,
    h('h2', { class: 'ag-h' }, 'Route'), ui.route);
}

function buildCenter() {
  ui.graph = h('div', { id: 'ag-graph-wrap' });
  ui.banner = h('div', { class: 'ag-banner', hidden: true });
  ui.tabs = h('div', { id: 'ag-tabs', role: 'tablist', 'aria-label': 'Results' });
  ui.panel = h('div', { id: 'ag-panel', role: 'tabpanel', tabindex: '0' });
  const tabs = [['overview', 'Overview'], ...AGENTS.map((a) => [a.id, a.short]), ['skills', 'Skills'], ['trace', 'Trace']];
  ui.tabBtns = {};
  for (const [id, label] of tabs) {
    const b = h('button', { type: 'button', role: 'tab', id: `ag-tab-${id}`, 'aria-selected': id === activeTab ? 'true' : 'false', tabindex: id === activeTab ? '0' : '-1', 'data-id': id, onclick: () => selectTab(id) },
      AGENT_IDS.includes(id) ? h('span', { class: 'ag-tabico', style: { color: colorOf(id) } }, iconSvg(id, 13)) : null, label);
    ui.tabBtns[id] = b;
    ui.tabs.append(b);
  }
  ui.tabs.addEventListener('keydown', (e) => {
    const ids = Object.keys(ui.tabBtns);
    const i = ids.indexOf(activeTab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = ids.length - 1;
    if (j < 0) return;
    e.preventDefault(); selectTab(ids[j]); ui.tabBtns[ids[j]].focus();
  });
  ui.stats = h('div', { class: 'ag-stats', role: 'status', 'aria-live': 'off' });
  return h('section', { id: 'ag-center' }, ui.stats, ui.graph, ui.banner, ui.tabs, ui.panel);
}

function buildRight() {
  ui.approval = h('div', { id: 'ag-approval' });
  ui.feed = h('div', { id: 'ag-feed', 'aria-live': 'off' });
  ui.feedCount = h('span', { class: 'muted' }, '');
  return h('aside', { id: 'ag-right', 'aria-label': 'Activity' }, ui.approval,
    h('h2', { class: 'ag-h' }, 'Live activity ', ui.feedCount), ui.feed);
}

root.append(h('main', { id: 'ag-layout' }, buildMission(), buildCenter(), buildRight()));

// Maximise: the results area fills the whole screen (browser full screen, side columns hidden).
const layoutEl = $('#ag-layout');
const maxIcon = (out) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${out ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const maxBtn = h('button', { type: 'button', id: 'ag-max', class: 'ag-maxbtn', 'aria-label': 'Maximize (F)', title: 'Maximize (F)' });
maxBtn.innerHTML = maxIcon(false);
$('#ag-center').append(maxBtn);
const isMax = () => layoutEl.classList.contains('ag-max');
function setMax(on) {
  layoutEl.classList.toggle('ag-max', on);
  maxBtn.innerHTML = maxIcon(on);
  maxBtn.title = maxBtn.ariaLabel = on ? 'Exit full screen (F)' : 'Maximize (F)';
  if (on && !document.fullscreenElement) layoutEl.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen?.();
}
maxBtn.addEventListener('click', () => setMax(!isMax()));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && isMax()) setMax(false); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isMax()) setMax(false);
  else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) setMax(!isMax());
});
const graphView = createGraphView(ui.graph, { onSelect: (id) => selectTab(id === 'supervisor' ? 'trace' : id === 'reporter' ? 'overview' : id, id === 'supervisor' ? 'supervisor' : null) });
graphView.setGraph(defaultGraph());

// ---------------------------------------------------------------- tabs + panels
const askBoxes = {};
const traceUi = { agent: '', kind: '', q: '' };
let panelCache = { tab: null, content: null, ver: -1 };

function selectTab(id, traceAgent) {
  if (!ui.tabBtns[id]) id = 'overview';
  if (traceAgent != null) { traceUi.agent = traceAgent; if (ui.traceAgent) ui.traceAgent.value = traceAgent; }
  activeTab = id;
  for (const [k, b] of Object.entries(ui.tabBtns)) { b.setAttribute('aria-selected', k === id ? 'true' : 'false'); b.tabIndex = k === id ? 0 : -1; }
  ui.panel.setAttribute('aria-labelledby', `ag-tab-${id}`);
  panelCache = { tab: null, content: null, ver: -1 };
  renderPanel(true);
  ui.panel.scrollTop = 0;
}

function tabVersion(id) {
  if (id === 'overview') return R.ver.all;
  if (id === 'skills') return 0;
  if (id === 'trace') return R.messages.length;
  return `${R.ver[id] || 0}|${R.statuses[id] || ''}|${id === 'solar_planner' || id === 'control' ? R.ver.all : ''}`;
}

function renderPanel(force) {
  const v = tabVersion(activeTab);
  if (!force && panelCache.tab === activeTab && panelCache.ver === v) return;
  let content;
  try {
    if (activeTab === 'overview') content = renderOverview(R, { openAgent: (a) => selectTab(AGENT_IDS.includes(a) ? a : 'overview') });
    else if (activeTab === 'skills') content = renderSkills();
    else if (activeTab === 'trace') content = renderTraceList();
    else content = renderAgent(activeTab, R, { status: R.statuses[activeTab] || (R.started ? 'waiting' : null) });
  } catch (err) {
    console.error('agents: panel render failed', err);
    content = h('div', { class: 'ag-empty' }, 'This view could not be drawn from the data received so far.');
  }
  if (panelCache.tab !== activeTab) {
    // New tab: build the static parts (ask box / trace filters) once.
    ui.panel.textContent = '';
    if (activeTab === 'trace') ui.panel.append(traceFilters());
    const slot = h('div', { class: 'ag-slot' });
    ui.panel.append(slot);
    if (AGENT_IDS.includes(activeTab)) ui.panel.append(askBox(activeTab));
    panelCache.slot = slot;
  }
  panelCache.slot.textContent = '';
  panelCache.slot.append(content);
  panelCache.tab = activeTab; panelCache.ver = v;
}
const schedulePanel = (() => {
  let pending = false;
  return () => { if (pending) return; pending = true; setTimeout(() => { pending = false; renderPanel(false); }, 180); };
})();

function traceFilters() {
  ui.traceAgent = h('select', { onchange: (e) => { traceUi.agent = e.target.value; renderPanel(true); } },
    h('option', { value: '' }, 'All agents'), ...['supervisor', ...AGENT_IDS, 'reporter'].map((id) => h('option', { value: id, selected: traceUi.agent === id }, agentMeta(id).label)));
  const kind = h('select', { onchange: (e) => { traceUi.kind = e.target.value; renderPanel(true); } },
    h('option', { value: '' }, 'All kinds'), ...Object.keys(KIND_LABEL).map((k) => h('option', { value: k, selected: traceUi.kind === k }, k)));
  const q = h('input', { type: 'search', placeholder: 'Filter text', value: traceUi.q, oninput: debounce((e) => { traceUi.q = e.target.value; renderPanel(true); }, 200) });
  return h('div', { class: 'ag-filters' }, ui.traceAgent, kind, q);
}
function renderTraceList() {
  const q = traceUi.q.trim().toLowerCase();
  const list = R.messages.filter((m) => (!traceUi.agent || m.agent === traceUi.agent) && (!traceUi.kind || m.kind === traceUi.kind) && (!q || str(m.text).toLowerCase().includes(q)));
  if (!list.length) return h('div', { class: 'ag-empty' }, R.messages.length ? 'No lines match the filter.' : 'No trace yet.');
  const shown = list.slice(-800);
  return h('div', {}, h('div', { class: 'ag-more' }, `${list.length} of ${R.messages.length} lines${list.length > shown.length ? ', showing the last 800' : ''}`),
    h('div', { class: 'ag-trace big' }, ...shown.map(traceLine)));
}

function askBox(agent) {
  if (askBoxes[agent]) return askBoxes[agent].el;
  const log = h('div', { class: 'ag-asklog' });
  const input = h('input', { type: 'text', placeholder: `Ask the ${agentMeta(agent).label} a question`, 'aria-label': `Question for ${agentMeta(agent).label}` });
  const btn = h('button', { class: 'ag-btn sm', type: 'submit' }, 'Ask');
  const form = h('form', { class: 'ag-askform', onsubmit: async (e) => {
    e.preventDefault();
    const q = input.value.trim(); if (!q) return;
    input.value = ''; btn.disabled = true;
    const a = h('div', { class: 'ag-a muted' }, 'Thinking...');
    log.append(h('div', { class: 'ag-q' }, q), a);
    a.textContent = await answer(agent, q);
    a.classList.remove('muted'); btn.disabled = false;
  } }, input, btn);
  const el = h('section', { class: 'ag-card ag-ask' }, h('h3', {}, 'Ask this agent'), log, form);
  askBoxes[agent] = { el };
  return el;
}

async function answer(agent, q) {
  if (R.mode === 'live' && health.ok) {
    try {
      const j = await askAgent(agent, q, R.threadId);
      if (j && j.answer) return str(j.answer);
    } catch { /* fall back to a local answer */ }
  }
  return localAnswer(agent, q);
}
function localAnswer(agent, q) {
  const meta = agentMeta(agent);
  const slice = obj(R.state[meta.key]);
  if (R.state[meta.key] == null) return `I have not produced any output in this run yet. My job: ${meta.role}`;
  const thoughts = R.messages.filter((m) => m.agent === agent && (m.kind === 'thought' || m.kind === 'llm')).map((m) => str(m.text));
  const parts = [];
  if (slice.summary) parts.push(str(slice.summary));
  const qf = quickFacts(agent, R.state);
  if (qf && qf !== slice.summary) parts.push(qf);
  if (/why|reason|how/i.test(q) && thoughts.length) parts.push(`My reasoning: ${thoughts.slice(-2).join(' ')}`);
  return `${parts.join(' ')} (Answered from the recorded state; the live agent can answer free-form questions when the backend is running.)`;
}

// ---------------------------------------------------------------- feed
let feedLines = 0;
let feedStick = true;
function feedAdd(node) {
  if (!ui.feed.dataset.wired) { ui.feed.dataset.wired = '1'; ui.feed.addEventListener('scroll', () => { feedStick = ui.feed.scrollHeight - ui.feed.scrollTop - ui.feed.clientHeight < 80; }); }
  const nearBottom = feedStick;
  ui.feed.append(node);
  feedLines++;
  while (ui.feed.childElementCount > 500) ui.feed.firstElementChild.remove();
  ui.feedCount.textContent = `(${R.messages.length})`;
  if (nearBottom) ui.feed.scrollTop = ui.feed.scrollHeight;
}
function feedMsg(m) {
  const kind = str(m.kind, 'note');
  const prev = ui.feed.lastElementChild;
  const cont = prev && prev.dataset.agent === str(m.agent) && !prev.classList.contains('sys');
  const line = h('div', { class: `ag-fl k-${kind}${cont ? ' cont' : ''}`, 'data-agent': str(m.agent), style: { '--c': colorOf(m.agent) } },
    cont ? h('span', { class: 'ag-av-gap' }) : avatar(m.agent, 26),
    h('div', { class: 'ag-fl-body' },
      cont ? null : h('div', { class: 'ag-fl-head' }, h('b', { style: { color: colorOf(m.agent) } }, agentMeta(m.agent).short), h('span', { class: 'ag-time' }, fmtClock(m.t))),
      h('div', { class: 'ag-fl-text' }, h('span', { class: `ag-kind k-${kind}` }, KIND_LABEL[kind] || kind), ' ', str(m.text))));
  feedAdd(line);
  if (kind !== 'tool') graphView.say(m.agent, str(m.text));
  else graphView.say(m.agent, `Calling ${str(m.text)}`);
  updateStats();
}
function feedSys(text, tone = '') {
  feedAdd(h('div', { class: `ag-fl sys ${tone}` }, text));
}

// ---------------------------------------------------------------- statuses + route
function setStatus(id, st) {
  if (!id) return;
  R.statuses[id] = st;
  graphView.setStatus(id, st);
  const b = ui.tabBtns[id];
  if (b) b.dataset.status = st;
  renderRoute();
  updateStats();
}
function plannedSet() {
  const st = R.state;
  const set = new Set([...arr(st.route), ...arr(st.done), ...(st.next ? [st.next] : [])]);
  for (const [id, s] of Object.entries(R.statuses)) if (s !== 'idle' && s !== 'skipped') set.add(id);
  if (set.has('solar_planner')) set.add('environment');
  return set;
}
function updateSkipped() {
  if (!arr(R.state.route).length && !arr(R.state.done).length) return;
  const plan = plannedSet();
  for (const a of AGENT_IDS) {
    const s = R.statuses[a] || 'idle';
    if (s === 'idle' && !plan.has(a)) setStatus(a, 'skipped');
    else if (s === 'skipped' && plan.has(a)) setStatus(a, 'idle');
  }
}
function renderRoute() {
  const order = [];
  const st = R.state;
  // Agents that already spoke, in the order they started, then the rest of the plan.
  const spoke = [];
  for (const m of R.messages) if (AGENT_IDS.includes(m.agent) && !spoke.includes(m.agent)) spoke.push(m.agent);
  for (const id of [...arr(st.done), ...spoke, ...(st.next ? [st.next] : []), ...arr(st.route)]) if (AGENT_IDS.includes(id) && !order.includes(id)) order.push(id);
  for (const a of AGENT_IDS) if (!order.includes(a) && R.statuses[a] && R.statuses[a] !== 'skipped' && R.statuses[a] !== 'idle') order.push(a);
  if (order.includes('solar_planner') && !order.includes('environment')) order.splice(order.indexOf('solar_planner') + 1, 0, 'environment');
  ui.route.textContent = '';
  if (!order.length) { ui.route.append(h('li', { class: 'muted' }, R.started ? 'The supervisor is choosing the route.' : 'Run the agents to see the route.')); return; }
  order.forEach((id, i) => {
    const s = R.statuses[id] || 'idle';
    const label = { idle: 'queued', active: 'working', done: 'done', interrupt: 'needs approval', error: 'error', skipped: 'skipped' }[s] || s;
    const n = R.messages.filter((m) => m.agent === id).length;
    ui.route.append(h('li', { 'data-status': s, style: { '--c': colorOf(id) } },
      h('span', { class: 'ag-step' }, String(i + 1)),
      h('button', { type: 'button', class: 'ag-link ag-roster', onclick: () => selectTab(id), title: agentMeta(id).role },
        avatar(id, 28),
        h('span', { class: 'ag-roster-t' }, h('b', {}, agentMeta(id).label),
          h('span', { class: 'muted' }, n ? `${n} line${n === 1 ? '' : 's'}${id === 'solar_planner' && R.pass > 1 ? `, ${R.pass} passes` : ''}` : (s === 'active' ? 'starting' : '')))),
      chip(label, { done: 'ok', active: 'accent', interrupt: 'warn', error: 'bad', skipped: 'muted' }[s] || '')));
  });
}

// ---------------------------------------------------------------- stats strip
let statsTimer = null;
function updateStats() {
  if (!ui.stats) return;
  const planned = [...plannedSet()].filter((id) => AGENT_IDS.includes(id));
  const total = planned.length || AGENT_IDS.length;
  const done = AGENT_IDS.filter((id) => R.statuses[id] === 'done').length;
  const tools = R.messages.filter((m) => m.kind === 'tool').length;
  const warns = R.messages.filter((m) => m.kind === 'warning').length;
  const active = Object.entries(R.statuses).find(([id, st]) => st === 'active' && id !== 'supervisor')?.[0] || (R.statuses.supervisor === 'active' ? 'supervisor' : null);
  const secs = R.t0 ? Math.round(((R.t1 || Date.now()) - R.t0) / 1000) : 0;
  const pct = Math.round((done / Math.max(1, total)) * 100);
  const stat = (v, l, cls = '') => h('div', { class: `ag-stat ${cls}` }, h('b', {}, v), h('span', {}, l));
  ui.stats.replaceChildren(...[
    h('div', { class: 'ag-stat-now' },
      active ? avatar(active, 30) : R.finished ? avatar('reporter', 30) : h('span', { class: 'ag-av idle' }),
      h('div', {}, h('b', {}, active ? agentMeta(active).label : (R.finished ? 'Run complete' : R.started ? 'Between agents' : 'Ready')),
        h('span', { class: 'muted' }, active ? 'working now' : R.finished ? 'report written' : R.started ? 'supervisor routing' : 'press Run agents or Replay'))),
    h('div', { class: 'ag-stat-bar', title: `${done} of ${total} agents done` }, h('i', { style: { width: `${pct}%` } })),
    stat(`${done}/${total}`, 'agents done', done && done === total ? 'ok' : ''),
    stat(String(R.messages.length), 'messages'),
    stat(String(tools), 'tool calls'),
    R.pass > 1 ? stat(String(R.pass), 'review passes', 'warn') : null,
    warns ? stat(String(warns), 'warnings', 'warn') : null,
    stat(`${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`, 'elapsed'),
  ].filter(Boolean));
}
function startClock() { R.t0 = Date.now(); R.t1 = null; clearInterval(statsTimer); statsTimer = setInterval(updateStats, 1000); }
function stopClock() { if (R.t0 && !R.t1) R.t1 = Date.now(); clearInterval(statsTimer); statsTimer = null; updateStats(); }

// ---------------------------------------------------------------- events
function handle(ev) {
  if (!ev || typeof ev !== 'object') return;
  const type = ev.type;
  if (type === 'run_start') {
    const keepMode = R.mode;
    const tid = ev.thread_id || R.threadId;
    resetRun(keepMode);
    R.threadId = tid; R.started = true;
    startClock();
    if (ev.goal && R.mode === 'replay') ui.goal.value = str(ev.goal);
    if (ev.mode && R.mode === 'replay' && [...ui.mode.options].some((o) => o.value === ev.mode)) ui.mode.value = ev.mode;
    if (ev.llm) { R.llm = str(ev.llm); setLlm(); }
    feedSys(`Run started${ev.mode ? ` in ${str(ev.mode)} mode` : ''}${ev.llm ? ` with ${str(ev.llm)}` : ''}.`);
    setRunStatus(R.mode === 'replay' ? 'Replaying the recorded run.' : `Live run ${R.threadId || ''}`.trim());
  } else if (type === 'node_start') {
    R.started = true;
    const id = str(ev.agent);
    for (const [k, s] of Object.entries(R.statuses)) if (s === 'active' && k !== id) setStatus(k, k === 'supervisor' ? 'idle' : 'done');
    if (id === 'solar_planner') { R.pass += 1; graphView.setLoop(R.pass); if (R.pass > 1) feedSys(`Review loop: the Environmental Engineer sent the plan back. Pass ${R.pass}.`, 'warn'); }
    setStatus(id, 'active');
    bump(id);
  } else if (type === 'message') {
    const m = { ...obj(ev.data) };
    if (!m.agent) m.agent = str(ev.agent, 'system');
    if (m.t == null) m.t = Date.now() / 1000;
    if (!m.kind) m.kind = 'thought';
    R.messages.push(m);
    feedMsg(m);
    bump(m.agent, true);
  } else if (type === 'node_end') {
    const id = str(ev.agent);
    const up = obj(ev.update);
    mergeUpdate(up);
    if (interrupt && id === 'control') resolveInterrupt();
    setStatus(id, id === 'supervisor' ? 'idle' : 'done');
    if (id === 'supervisor') updateSkipped();
    bump(id);
  } else if (type === 'interrupt') {
    showInterrupt(ev);
    setStatus(str(ev.agent, 'control'), 'interrupt');
    bump(str(ev.agent, 'control'));
  } else if (type === 'done') {
    const fin = obj(ev.state);
    if (Array.isArray(fin.messages) && !R.messages.length) for (const m of fin.messages) { R.messages.push(m); }
    const { messages, ...rest } = fin;
    mergeUpdate(rest);
    R.finished = true;
    for (const [k, s] of Object.entries(R.statuses)) if (s === 'active' || s === 'interrupt') setStatus(k, k === 'supervisor' ? 'idle' : 'done');
    if (R.state.report) setStatus('reporter', 'done');
    if (interrupt) resolveInterrupt();
    feedSys('Run finished. The report is on the Overview tab.', 'ok');
    finishRun();
    bump('all');
  } else if (type === 'resume') {
    const d = obj(ev.data);
    const n = arr(d.ids).length;
    if (!decisionLogged) feedSys(`Human decision: ${str(d.decision, 'approve')} ${n ? n + ' actions' : 'all actions'}.`, d.decision === 'reject' ? 'bad' : 'ok');
    decisionLogged = false;
    if (interrupt && interrupt.ui) interrupt.ui.note.textContent = `Decision sent: ${str(d.decision, 'approve')}. The control agent is continuing.`;
  } else if (type === 'error') {
    feedSys(`Error${ev.agent ? ` in ${agentMeta(ev.agent).label}` : ''}: ${str(ev.text, 'unknown error')}`, 'bad');
    if (ev.agent) setStatus(str(ev.agent), 'error');
    bump(ev.agent || 'all');
  }
  schedulePanel();
}

function mergeUpdate(up) {
  for (const [k, v] of Object.entries(up)) {
    if (k === 'messages') continue;
    R.state[k] = v;
    if (k === 'env_review' && v && typeof v === 'object') pushSnap(R.envHistory, v, R.envHistory.length + 1);
    if (k === 'solar_plan' && v && typeof v === 'object') pushSnap(R.planHistory, v, R.pass || R.planHistory.length + 1);
  }
  if (up.plan_iterations != null && num(up.plan_iterations) > R.pass) { R.pass = num(up.plan_iterations); graphView.setLoop(R.pass); }
  renderRoute();
}
function pushSnap(list, v, fallbackIt) {
  const it = num(v.iteration, fallbackIt);
  const snap = { ...v, iteration: it };
  const i = list.findIndex((x) => x.iteration === it);
  if (i >= 0) list[i] = snap; else list.push(snap);
}
function bump(id, msgOnly) {
  if (id) R.ver[id] = (R.ver[id] || 0) + 1;
  if (!msgOnly) R.ver.all += 1;
}

// ---------------------------------------------------------------- human in the loop
function showInterrupt(ev) {
  const actions = arr(obj(ev.data).actions).filter((a) => a && typeof a === 'object');
  interrupt = { actions, resolved: false, timer: null, sent: false };
  if (isMax()) setMax(false); // the approval card lives in the side column
  const boxes = actions.map((a, i) => h('input', { type: 'checkbox', checked: true, value: str(a.id, String(i)), 'aria-label': `Approve ${str(a.action)} on ${str(a.asset)}` }));
  const approveBtn = h('button', { class: 'ag-btn primary', type: 'button', onclick: () => decide('approve') }, 'Approve selected');
  const rejectBtn = h('button', { class: 'ag-btn danger', type: 'button', onclick: () => decide('reject') }, 'Reject');
  const note = h('div', { class: 'ag-appr-note' }, R.mode === 'replay' ? 'Replay: the recorded decision is applied in a moment. Approve to continue now.' : 'The control agent is waiting for you. Nothing changes until you decide.');
  const syncBtn = () => { if (!interrupt || !interrupt.sent) approveBtn.disabled = actions.length > 0 && !boxes.some((b) => b.checked); };
  boxes.forEach((b) => b.addEventListener('change', syncBtn));
  const question = str(obj(ev.data).question);
  interrupt.ui = { boxes, approveBtn, rejectBtn, note };
  ui.approval.textContent = '';
  ui.approval.append(h('section', { class: 'ag-appr', role: 'alertdialog', 'aria-label': 'Approval needed' },
    h('div', { class: 'ag-appr-head' }, h('b', {}, 'Approval needed'), chip(`${actions.length} actions`, 'warn')),
    h('div', { class: 'muted' }, question || 'The Control Agent wants to make these changes. Untick any you do not want.'),
    question ? h('div', { class: 'muted sm' }, 'Untick any action you do not want.') : null,
    h('div', { class: 'ag-appr-list' }, ...actions.map((a, i) => h('label', { class: 'ag-appr-item' }, boxes[i],
      h('div', {}, h('div', {}, h('span', { class: 'mono muted' }, str(a.t)), ' ', h('b', {}, str(a.asset)), ' ', str(a.action), a.kw != null ? h('span', { class: 'mono' }, ` ${fmtUnit(a.kw, 'kW')}`) : null),
        a.reason ? h('div', { class: 'muted' }, str(a.reason)) : null)))),
    actions.length ? null : h('div', { class: 'ag-empty sm' }, 'No actions listed.'),
    h('div', { class: 'ag-btnrow' }, approveBtn, rejectBtn), note));
  feedSys('Waiting for a human decision on the control actions.', 'warn');
  setRunStatus('Waiting for your approval.');
  if (R.mode === 'replay') {
    interrupt.timer = setTimeout(() => applyRecordedDecision(), 2500 / speed);
  }
}
// Replay: tick the boxes the recorded "resume" event approved, then continue.
function applyRecordedDecision() {
  if (!interrupt || interrupt.sent) return;
  const next = player && player.peek ? player.peek() : null;
  const rec = next && next.type === 'resume' ? obj(next.data) : { decision: 'approve', ids: [] };
  const ids = arr(rec.ids).map(String);
  const { boxes, approveBtn, rejectBtn, note } = interrupt.ui;
  boxes.forEach((b) => { b.checked = rec.decision !== 'reject' && (!ids.length || ids.includes(b.value)); });
  approveBtn.disabled = rejectBtn.disabled = true;
  (rec.decision === 'reject' ? rejectBtn : approveBtn).classList.add('pressed');
  note.textContent = `Recorded decision: ${str(rec.decision, 'approve')} ${ids.length ? ids.length + ' actions' : 'all actions'}.`;
  interrupt.sent = true;
  player && player.resume(true);
}

async function decide(decision) {
  if (!interrupt || interrupt.sent) return;
  const ids = interrupt.ui.boxes.filter((b) => b.checked).map((b) => b.value);
  const { approveBtn, rejectBtn, note } = interrupt.ui;
  approveBtn.disabled = rejectBtn.disabled = true;
  interrupt.sent = true;
  clearTimeout(interrupt.timer);
  if (R.mode === 'replay') {
    const next = player && player.peek ? player.peek() : null;
    const recDecision = next && next.type === 'resume' ? str(obj(next.data).decision, 'approve') : 'approve';
    note.textContent = decision === recDecision ? 'Replay: continuing with your decision.' : `Replay follows the recorded decision (${recDecision}). Run live to choose differently.`;
    player && player.resume(true);
    return;
  }
  note.textContent = `Sending "${decision}" for ${ids.length} actions...`;
  try {
    await resumeRun(R.threadId, decision, ids);
    note.textContent = 'Sent. The control agent is continuing.';
    decisionLogged = true;
    feedSys(`You chose to ${decision} ${decision === 'approve' ? ids.length + ' actions' : 'the actions'}.`, decision === 'approve' ? 'ok' : 'bad');
  } catch (err) {
    note.textContent = `Could not send the decision: ${err.message}. Try again.`;
    interrupt.sent = false; approveBtn.disabled = rejectBtn.disabled = false;
  }
}
function resolveInterrupt() {
  if (!interrupt || interrupt.resolved) return;
  interrupt.resolved = true;
  clearTimeout(interrupt.timer);
  const acts = arr(obj(R.state.control).actions);
  const approved = acts.filter((a) => actionState(a) === 'approved').length;
  const rejected = acts.filter((a) => actionState(a) === 'rejected').length;
  ui.approval.textContent = '';
  ui.approval.append(h('section', { class: 'ag-appr done' }, h('div', { class: 'ag-appr-head' }, h('b', {}, 'Decision recorded'), chip(`${approved} approved`, 'ok'), rejected ? chip(`${rejected} rejected`, 'bad') : null),
    h('button', { class: 'ag-link', type: 'button', onclick: () => selectTab('control') }, 'See the control actions')));
  interrupt = null;
}

// ---------------------------------------------------------------- run control
function resetRun(mode) {
  clearInterval(statsTimer); statsTimer = null;
  R = freshRun();
  R.mode = mode || 'idle';
  if (interrupt) clearTimeout(interrupt.timer);
  interrupt = null;
  ui.approval.textContent = '';
  ui.feed.textContent = ''; feedLines = 0; ui.feedCount.textContent = '';
  graphView.reset();
  for (const b of Object.values(ui.tabBtns)) delete b.dataset.status;
  ui.banner.hidden = true;
  renderRoute();
  panelCache.ver = -1;
}
function stopAll() {
  if (player) { player.stop(); player = null; }
  if (stream) { stream.close(); stream = null; }
}
function setRunStatus(t) { ui.runStatus.textContent = t; }
function setBusy(b) { ui.run.disabled = b && R.mode === 'live'; ui.run.textContent = b && R.mode === 'live' ? 'Running...' : 'Run agents'; }
function finishRun() {
  setBusy(false);
  R.finished = true;
  stopClock();
  setRunStatus(R.mode === 'replay' ? 'Replay finished. Press Replay to watch again.' : 'Run finished.');
  ui.progress.firstChild.style.width = '100%';
  if (R.mode === 'replay') ui.skip.disabled = true;
}
function setLlm() {
  if (R.mode === 'replay') ui.llm.textContent = `recorded run${R.llm ? ': ' + R.llm : ''}`;
  else ui.llm.textContent = health.ok ? str(health.llm, 'unknown') : 'offline (backend not reachable)';
  ui.llm.dataset.state = health.ok && R.mode !== 'replay' ? 'live' : 'replay';
}
function setSpeed(x) {
  speed = x;
  ui.speedBtns.forEach((b) => b.setAttribute('aria-pressed', b.textContent === `${x}x` ? 'true' : 'false'));
  if (player) player.setSpeed(x);
}

async function onRun() {
  if (!health.ok) {
    showBanner('The agent backend is not reachable, so this plays the recorded run. Start it with: python -m agents.server', 'info');
    return startReplay();
  }
  stopAll();
  resetRun('live');
  setLlm();
  ui.replayBar.hidden = true;
  const mode = ui.mode.value;
  const body = {
    goal: ui.goal.value.trim() || DEFAULT_GOAL,
    mode,
    scenario: { weather: ui.weather.value, day: ui.day.value || undefined, pilot_mode: ui.pilot.value },
  };
  if (mode === 'custom') body.agents = [...ui.custom.querySelectorAll('input:checked')].map((i) => i.value);
  setBusy(true);
  setRunStatus('Starting the run...');
  try {
    const { thread_id: tid } = await startRun(body);
    if (!tid) throw new Error('no thread id returned');
    R.threadId = tid; R.started = true;
    setRunStatus(`Live run ${tid}`);
    stream = openStream(tid, handle, (s) => {
      if (s === 'retry') setRunStatus('Connection dropped, reconnecting...');
      else if (s === 'open' && !R.finished) setRunStatus(`Live run ${tid}`);
      else if (s === 'lost') { setRunStatus('Lost the connection to the run.'); setBusy(false); }
    });
    selectTab(activeTab);
  } catch (err) {
    setBusy(false);
    setRunStatus(`Could not start the run: ${err.message}`);
    feedSys(`Could not start the run: ${err.message}`, 'bad');
  }
}

async function startReplay() {
  stopAll();
  resetRun('replay');
  setLlm();
  setRunStatus('Loading the recorded run...');
  try {
    replayData = await loadReplay(REPLAY_URL);
  } catch (err) {
    replayData = null;
    R.mode = 'idle';
    setLlm();
    setRunStatus('No recorded run available.');
    showBanner(`No recorded run found at ${REPLAY_URL}. Start the agent backend (python -m agents.server) and press Run, or record a demo run first.`, 'warn');
    renderPanel(true);
    return;
  }
  const meta = obj(replayData.meta);
  R.llm = str(meta.llm || '');
  setLlm();
  if (replayData.graph) graphView.setGraph(replayData.graph);
  ui.replayBar.hidden = false; ui.skip.disabled = false;
  ui.progress.firstChild.style.width = '0%';
  const evs = arr(replayData.events);
  if (!evs.length) { setRunStatus('The recorded run is empty.'); return; }
  player = new Player(evs, handle, {
    onProgress: (i, n) => { ui.progress.firstChild.style.width = `${((i / n) * 100).toFixed(1)}%`; if (!R.finished && !interrupt) setRunStatus(`Replaying the recorded run: event ${i} of ${n}.`); },
    onInterrupt: () => {},
    onEnd: () => { if (!R.finished) finishRun(); },
  });
  player.setSpeed(speed);
  selectTab(activeTab);
  player.start();
}

function showBanner(text, tone) {
  ui.banner.hidden = false;
  ui.banner.className = `ag-banner ${tone || ''}`;
  ui.banner.textContent = text;
}

// ---------------------------------------------------------------- boot
renderRoute();
updateStats();
renderPanel(true);
(async () => {
  health = await getHealth();
  setLlm();
  if (health.ok) {
    try { graphView.setGraph(await getGraph()); } catch { /* keep the default layout */ }
    setRunStatus('Backend online. Set the goal and press Run.');
    if (params.has('replay')) startReplay();
  } else {
    setRunStatus('Backend not reachable: replay mode.');
    if (params.get('autoplay') !== '0') startReplay();
  }
})();

