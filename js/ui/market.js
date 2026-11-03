// Market tab: slot need, merit-order chart, bids table, clearing price history.
import { CONFIG, fmtTime } from '../config.js';
import { h, setText, setClass, fmtKW, fmtPct, safe, isNum, tokens } from './util.js';
import { drawMeritOrder, drawSparkline, relevantBids } from './charts.js';

export function createMarket({ state, onInspect }) {
  const el = h('section.tab-panel.mk');

  const stat = (label) => {
    const v = h('div.stat-v.num', '—');
    const s = h('div.stat-s', '');
    return { el: h('div.stat', h('div.stat-l', label), v, s), v, s };
  };
  const sSlot = stat('Slot'), sNeed = stat('Need'), sPrice = stat('Price'), sAcc = stat('Accepted');
  const stats = h('div.stats', sSlot.el, sNeed.el, sPrice.el, sAcc.el);

  const merit = h('canvas.mk-chart');
  const meritCard = h('div.card',
    h('div.card-h', h('h3', 'Merit order'), h('span.card-meta', 'Rs/kWh vs cumulative kW')),
    merit,
    h('div.legend', h('span.lg', h('i.lg-acc'), 'Accepted'), h('span.lg', h('i.lg-rej'), 'Not needed'), h('span.lg', h('i.lg-need'), 'Slot need')));

  const spark = h('canvas.spark');
  const sparkLast = h('span.card-meta.num', '');
  const sparkCard = h('div.card', h('div.card-h', h('h3', 'Clearing price history'), sparkLast), spark);

  const tbody = h('tbody');
  const table = h('table.tbl.bids',
    h('thead', h('tr', h('th', 'Machine'), h('th', 'Dir'), h('th.r', 'kW'), h('th.r', 'Rs/kWh'), h('th.r', 'Rel.'), h('th', ''))),
    tbody);
  const reason = h('div.mk-reason', '');
  const empty = h('div.empty', 'No bids in this slot yet.');
  const bidsCard = h('div.card', h('div.card-h', h('h3', 'Bids this slot'), h('span.card-meta', 'battery wear Rs 1.5/kWh included')), table, empty, reason);

  el.append(stats, meritCard, bidsCard, sparkCard);

  let sig = '';
  let selected = null;
  function renderBids() {
    const m = state.market || {};
    const bids = (Array.isArray(m.bids) ? m.bids : []).filter(Boolean);
    const s = `${m.slot}|${bids.length}|${bids.map((b) => `${b.id}:${b.accepted}:${Math.round(safe(b.kW))}:${safe(b.priceRs).toFixed(2)}`).join(',')}|${selected}`;
    if (s === sig) return;
    sig = s;
    tbody.textContent = '';
    const sorted = bids.slice().sort((a, b) => safe(a.priceRs) - safe(b.priceRs));
    for (const b of sorted) {
      const key = b.id || b.equipId || b.name;
      const tr = h('tr', { class: `${b.accepted ? 'acc' : ''}${selected === key ? ' sel' : ''}`, onclick: () => { selected = selected === key ? null : key; renderBids(); } },
        h('td', h('div.cell-main', b.name || b.equipId || 'Bid'), h('div.cell-sub', b.equipId || b.kind || '')),
        h('td', h(`span.pill.${b.direction === 'absorb' ? 'p-absorb' : 'p-reduce'}`, b.direction === 'absorb' ? 'absorb' : 'reduce')),
        h('td.r.num', isNum(b.acceptedKW) && b.acceptedKW > 0 && b.acceptedKW < Math.abs(safe(b.kW)) - 0.05 ? `${fmtKW(b.acceptedKW, false)}/${fmtKW(Math.abs(safe(b.kW)), false)}` : fmtKW(Math.abs(safe(b.kW)), false)),
        h('td.r.num', isNum(b.priceRs) ? b.priceRs.toFixed(2) : '—'),
        h('td.r.num', fmtPct(b.reliability)),
        h('td', b.accepted ? h('span.pill.p-on', 'won') : h('span.pill.p-idle', 'out')));
      tbody.append(tr);
      if (selected === key && b.reason) tbody.append(h('tr.reason-row', h('td', { colSpan: 6 }, b.reason)));
    }
    setClass(empty, 'hide', bids.length > 0);
    setClass(table, 'hide', bids.length === 0);
    setText(reason, bids.length ? 'Click a bid to see why it won or lost.' : '');
  }

  return {
    el,
    update() {
      const m = state.market || {};
      const slotStart = isNum(m.slot) ? m.slot * CONFIG.slotMinutes : null;
      setText(sSlot.v, slotStart == null ? '—' : fmtTime(slotStart));
      setText(sSlot.s, slotStart == null ? '' : `to ${fmtTime(slotStart + CONFIG.slotMinutes)}`);
      const need = safe(m.needKW);
      setText(sNeed.v, fmtKW(Math.abs(need)));
      setText(sNeed.s, need > 0 ? 'to cut / shift' : need < 0 ? 'surplus' : 'balanced');
      setClass(sNeed.el, 'surplus', need < 0);
      setText(sPrice.v, isNum(m.clearingPrice) && m.clearingPrice > 0 ? `Rs ${m.clearingPrice.toFixed(2)}` : '—');
      setText(sPrice.s, 'clearing, /kWh');
      const bids = relevantBids(m);
      const acc = bids.filter((b) => b.accepted);
      setText(sAcc.v, `${acc.length} / ${bids.length}`);
      setText(sAcc.s, fmtKW(acc.reduce((s, b) => s + Math.abs(safe(b.kW)), 0)));

      drawMeritOrder(merit, m);
      const hist = Array.isArray(m.history) ? m.history.slice(-96) : [];
      drawSparkline(spark, hist.map((r) => r && r.clearingPrice), tokens().accent, { empty: 'price history appears after a few slots', min: 0 });
      const lastH = hist[hist.length - 1];
      setText(sparkLast, lastH && isNum(lastH.clearingPrice) ? `last Rs ${lastH.clearingPrice.toFixed(2)} · ${hist.length} slots` : '');
      renderBids();
    },
  };
}
