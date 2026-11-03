// Copilot tab: pending approvals / shadow log, copilot feed with engine chips, Ask HUKUM.
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, syncList, fmtKW, fmtRs, safe, isNum } from './util.js';
import { ENGINES } from './derive.js';
import { answer, SUGGESTIONS } from './ask.js';

const tm = (t) => fmtTime(minuteOfDay(safe(t)));

export function createCopilot({ state, actions }) {
  const el = h('section.tab-panel.cp');

  // ----- queue -----
  const qTitle = h('h3', 'Pending approvals');
  const qMeta = h('span.card-meta.num', '');
  const qNote = h('div.cp-note', '');
  const qList = h('div.cp-queue');
  const approveAll = h('button.btn.btn-sm', { type: 'button', onclick: () => {
    for (const a of (state.pendingActions || [])) if (a && a.status === 'pending') actions.approve(a.id);
  } }, 'Approve all');
  const queueCard = h('div.card', h('div.card-h', qTitle, h('div.card-h-r', qMeta, approveAll)), qNote, qList);

  // ----- ask -----
  const input = h('input.ask-in', { type: 'text', placeholder: 'Ask HUKUM, e.g. why is Lab 3 off?', autocomplete: 'off', 'aria-label': 'Ask HUKUM' });
  const convo = h('div.ask-convo');
  const ask = (text) => {
    const q = String(text || '').trim();
    if (!q) return;
    const a = answer(state, q);
    convo.prepend(h('div.ask-turn', h('div.ask-q', q), h('div.ask-a', h('span.ask-badge', 'HUKUM'), a)));
    while (convo.children.length > 6) convo.lastChild.remove();
  };
  const form = h('form.ask-form', { onsubmit: (e) => { e.preventDefault(); ask(input.value); input.value = ''; } },
    input, h('button.btn.btn-accent', { type: 'submit' }, 'Ask'));
  const chips = h('div.ask-chips', SUGGESTIONS.map((s) => h('button.chip', { type: 'button', onclick: () => ask(s) }, s)));
  const askCard = h('div.card', h('div.card-h', h('h3', 'Ask HUKUM'), h('span.card-meta', 'answers from live building data')), form, chips, convo);

  // ----- log -----
  let filter = 'ALL';
  const chipEls = {};
  const engChips = h('div.eng-chips', ['ALL', ...ENGINES].map((eng) => {
    const b = h(`button.chip.eng-${eng.toLowerCase()}`, { type: 'button', onclick: () => { filter = eng; logSig = ''; } }, eng === 'ALL' ? 'All' : eng);
    chipEls[eng] = b;
    return b;
  }));
  const log = h('div.cp-log');
  const logEmpty = h('div.empty', 'HUKUM will narrate what it sees and does here.');
  const logCard = h('div.card', h('div.card-h', h('h3', 'Copilot log'), h('span.card-meta', 'newest first')), engChips, log, logEmpty);

  el.append(queueCard, askCard, logCard);

  let logSig = '';
  function renderLog() {
    for (const [k, b] of Object.entries(chipEls)) setClass(b, 'on', k === filter);
    const cp = Array.isArray(state.copilot) ? state.copilot : [];
    const last = cp[cp.length - 1];
    const sig = `${filter}|${cp.length}|${last ? last.t + last.text : ''}`;
    if (sig === logSig) return;
    logSig = sig;
    log.textContent = '';
    let n = 0;
    for (let i = cp.length - 1; i >= 0 && n < 120; i--) {
      const c = cp[i];
      if (!c || (filter !== 'ALL' && c.engine !== filter)) continue;
      n++;
      log.append(h(`div.cp-line.lv-${c.level || 'info'}`,
        h('span.cp-t.num', tm(c.t)),
        h(`span.eng-tag.eng-${String(c.engine || 'info').toLowerCase()}`, c.engine || 'INFO'),
        h('span.cp-text', c.text || '')));
    }
    setClass(logEmpty, 'hide', n > 0);
  }

  function makeItem(a) {
    const text = h('div.q-text');
    const meta = h('div.q-meta.num');
    const reason = h('div.q-reason');
    const btns = h('div.q-btns',
      h('button.btn.btn-sm.btn-accent', { type: 'button', onclick: () => actions.approve(a.id) }, 'Approve'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => actions.reject(a.id) }, 'Reject'));
    const status = h('span.pill');
    const node = h('div.q-item', h('div.q-main', text, meta, reason), h('div.q-side', status, btns));
    node._p = { text, meta, reason, btns, status };
    return node;
  }
  function updateItem(node, a) {
    const p = node._p;
    setText(p.text, a.text || `${a.action || 'act'} ${a.target ? a.target.id : ''}`);
    const bits = [tm(a.t)];
    if (isNum(a.kW)) bits.push(fmtKW(a.kW));
    if (isNum(a.savingRs)) bits.push(`saves ${fmtRs(a.savingRs, a.savingRs < 10 ? 1 : 0)}`);
    if (a.target) bits.push(`${a.target.type} ${a.target.id}`);
    setText(p.meta, bits.join(' · '));
    setText(p.reason, a.reason || '');
    const pending = a.status === 'pending';
    setClass(p.btns, 'hide', !pending);
    setText(p.status, a.status === 'shadow' ? 'would do' : a.status || '');
    if (a.status === 'expired') setText(p.reason, a.reason ? `${a.reason} (expired: the situation changed before approval)` : 'Expired: the situation changed before approval.');
    const cls = `pill ${a.status === 'approved' ? 'p-on' : a.status === 'rejected' ? 'p-off' : 'p-idle'}${pending ? ' hide' : ''}`;
    if (p.status.className !== cls) p.status.className = cls;
  }

  function renderQueue() {
    const all = (Array.isArray(state.pendingActions) ? state.pendingActions : []).filter(Boolean);
    const mode = state.mode;
    let items;
    if (mode === 'shadow') {
      setText(qTitle, 'Shadow mode: would have done');
      items = all.filter((a) => a.status === 'shadow').slice(-30).reverse();
      const os = state.occStats || {};
      const T = (state.energy && state.energy.totals) || {};
      const sum = isNum(T.shadowWouldSaveRs) && T.shadowWouldSaveRs > 0 ? T.shadowWouldSaveRs + safe(os.shadowSavedRs) : isNum(os.shadowSavedRs) ? os.shadowSavedRs : items.reduce((s, a) => s + safe(a.savingRs), 0);
      const kwh = isNum(os.shadowSavedKWh) ? ` · ${Math.round(os.shadowSavedKWh)} kWh` : '';
      setText(qMeta, items.length || sum > 0 ? `would have saved ${fmtRs(sum)}${kwh}` : '');
      setText(qNote, 'Nothing executes in shadow mode. HUKUM logs every action it would have taken and what it would have saved, so the pilot can be judged before it touches a single switch.');
    } else if (mode === 'approve') {
      setText(qTitle, 'Pending approvals');
      const pend = all.filter((a) => a.status === 'pending');
      const done = all.filter((a) => a.status === 'approved' || a.status === 'rejected' || a.status === 'expired').slice(-6).reverse();
      items = [...pend.slice().reverse(), ...done];
      setText(qMeta, `${pend.length} waiting`);
      setText(qNote, pend.length ? 'Each action waits for you. Comfort limits and manual overrides still apply after approval.' : 'Nothing waiting. New actions appear here as HUKUM proposes them.');
    } else {
      setText(qTitle, 'Recent decisions');
      items = all.filter((a) => a.status !== 'shadow').slice(-6).reverse();
      setText(qMeta, '');
      setText(qNote, 'Automate mode: HUKUM acts on its own inside safety and comfort limits. Switch to Approve to review each action first.');
    }
    setClass(approveAll, 'hide', !(mode === 'approve' && all.some((a) => a.status === 'pending')));
    // Don't reorder under the cursor: skip the sync while hovering a button in the list.
    if (qList.matches(':hover') && qList.__keyed && items.every((a) => qList.__keyed.has(a.id))) {
      for (const a of items) updateItem(qList.__keyed.get(a.id), a);
      return;
    }
    syncList(qList, items, (a) => a.id, makeItem, updateItem);
  }

  return {
    el,
    update() {
      renderQueue();
      renderLog();
    },
    pendingCount() {
      return (Array.isArray(state.pendingActions) ? state.pendingActions : []).filter((a) => a && a.status === 'pending').length;
    },
  };
}
