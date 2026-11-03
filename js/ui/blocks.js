// Blocks tab: one energy meter per NHCE block (as on the real campus), a
// clickable campus mini-map coloured by load, and rooftop solar per block.
import { COLS, ROWS, PLAYER_START } from '../building.js';
import { h, setText, setClass, setStyle, fmtKW, fmtNum, fmtPct, safe, isNum, fitCanvas, tokens, alpha } from './util.js';
import { BLOCKS, SITE, blockMeter, blockName } from './derive.js';

const EXTRA = [
  { id: 'CAMPUS', name: 'Campus zones', about: 'Gate, parking with EV and bus chargers, sports ground and floodlights' },
  { id: 'HOSTELS', name: 'Other blocks & hostels', about: 'Boys and girls hostels, faculty accommodation (metered, not modelled room by room)' },
  { id: 'PLANT', name: 'Central plant', about: 'Chillers, pumps and shared services' },
];

export function createBlocks({ state, actions }) {
  const el = h('section.tab-panel.bk');

  // ----- campus totals -----
  const tKW = h('div.stat-v.num', '—'), tBase = h('div.stat-s.num', ''), tKWh = h('div.stat-v.num', '—'), tSave = h('div.stat-s.num', '');
  const tSolar = h('div.stat-v.num', '—'), tSolarS = h('div.stat-s.num', '');
  const totals = h('div.stats.stats-3',
    h('div.stat', h('div.stat-l', 'Campus now'), tKW, tBase),
    h('div.stat', h('div.stat-l', 'Energy today'), tKWh, tSave),
    h('div.stat', h('div.stat-l', 'Rooftop solar'), tSolar, tSolarS));

  // ----- mini-map -----
  const map = h('canvas.bk-map');
  const mapTip = h('div.bk-map-tip', 'Click a block to jump to its meter');
  const mapCard = h('div.card', h('div.card-h', h('h3', 'NHCE campus'), h('span.card-meta', SITE.road || '')), h('div.bk-map-wrap', map), mapTip);
  let hoverId = null, selected = null, mapRects = [];
  const hit = (e) => {
    const r = map.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = mapRects.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
    return f ? f.id : null;
  };
  map.addEventListener('mousemove', (e) => { hoverId = hit(e); map.style.cursor = hoverId ? 'pointer' : 'default'; drawMap(); });
  map.addEventListener('mouseleave', () => { hoverId = null; drawMap(); });
  map.addEventListener('click', (e) => { const id = hit(e); if (id) select(id); });

  // ----- cards -----
  const list = h('div.bk-list');
  const cards = [];
  const all = [...BLOCKS.map((b) => ({ id: b.id, name: b.name, about: b.about, block: b })), ...EXTRA];
  for (const b of all) {
    const kw = h('span.bk-kw.num', '—');
    const base = h('span.bk-base.num', '');
    const bar = h('div.bk-bar-fill'), barBase = h('div.bk-bar-base');
    const kwh = h('b.num', '—'), save = h('b.num', '—'), ppl = h('b.num', '—'), off = h('b.num', '—');
    const solar = h('div.bk-solar');
    const go = b.block
      ? h('button.btn.btn-sm', { type: 'button', onclick: () => actions.teleport(b.block.ground, 1.5, 14.5) }, 'Go to block')
      : b.id === 'CAMPUS' ? h('button.btn.btn-sm', { type: 'button', onclick: () => actions.teleport(PLAYER_START.floor, PLAYER_START.x, PLAYER_START.y) }, 'Go to campus') : null;
    const card = h('div.bk-card', { dataset: { id: b.id } },
      h('div.bk-top',
        h('div.bk-title', h('span.bk-id', b.block ? b.block.short : b.id === 'CAMPUS' ? 'SITE' : b.id === 'HOSTELS' ? 'HST' : 'PLT'), h('div', h('div.bk-name', b.name), h('div.bk-about', b.about || ''))),
        h('div.bk-now', kw, base)),
      h('div.bk-bar', barBase, bar),
      h('div.bk-grid',
        h('div', h('span', 'kWh today'), kwh), h('div', h('span', 'Saving'), save),
        h('div', h('span', 'People'), ppl), h('div', h('span', 'Auto-off now'), off)),
      h('div.bk-foot', solar, go));
    list.append(card);
    cards.push({ b, card, kw, base, bar, barBase, kwh, save, ppl, off, solar, solarSig: '' });
  }

  el.append(totals, mapCard, h('div.section-h', 'Block energy meters'), list);

  function select(id) {
    selected = id;
    const c = cards.find((x) => x.b.id === id);
    if (c) {
      for (const x of cards) setClass(x.card, 'sel', x === c);
      c.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    drawMap();
  }

  let meters = {};
  function drawMap() {
    const fit = fitCanvas(map);
    if (!fit) return;
    const { ctx, w, h: H } = fit;
    const C = tokens();
    const s = Math.min(w / COLS, H / ROWS);
    const ox = (w - COLS * s) / 2, oy = (H - ROWS * s) / 2;
    const R = (x, y, ww, hh) => [ox + x * s, oy + y * s, ww * s, hh * s];
    ctx.clearRect(0, 0, w, H);
    // ground
    ctx.fillStyle = '#121a14';
    ctx.fillRect(...R(0, 0, COLS, ROWS));
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.strokeRect(...R(0.5, 0.5, COLS - 1, ROWS - 1));
    // road
    ctx.fillStyle = '#1d232b';
    ctx.fillRect(...R(0, ROWS - 1, COLS, 1));
    ctx.fillStyle = C.muted; ctx.font = `9px ${C.mono}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('OUTER RING ROAD', ox + (COLS - 1) * s, oy + (ROWS - 0.5) * s);
    // zones
    for (const z of SITE.zones || []) {
      ctx.fillStyle = z.type === 'sports' ? 'rgba(82,196,26,.08)' : 'rgba(138,155,176,.07)';
      ctx.fillRect(...R(z.x, z.y, z.w, z.h));
      ctx.fillStyle = alpha(C.muted, 0.8); ctx.textAlign = 'center'; ctx.font = `8.5px ${C.font}`;
      ctx.fillText(z.name.split(/[,&]/)[0].trim(), ox + (z.x + z.w / 2) * s, oy + (z.y + z.h / 2) * s);
    }
    for (const st of SITE.structures || []) {
      ctx.fillStyle = '#222b36';
      ctx.fillRect(...R(st.x, st.y, st.w, st.h));
    }
    // blocks coloured by kW intensity
    const max = Math.max(1, ...BLOCKS.map((b) => safe(meters[b.id] && meters[b.id].kW)));
    mapRects = [];
    for (const f of SITE.footprints || []) {
      const m = meters[f.blockId] || {};
      const t = Math.max(0, Math.min(1, safe(m.kW) / max));
      const [x, y, ww, hh] = R(f.x, f.y, f.w, f.h);
      mapRects.push({ id: f.blockId, x, y, w: ww, h: hh });
      ctx.fillStyle = `rgba(255, ${Math.round(190 - 110 * t)}, ${Math.round(60 - 30 * t)}, ${0.18 + 0.62 * t})`;
      ctx.fillRect(x, y, ww, hh);
      const on = f.blockId === selected || f.blockId === hoverId;
      ctx.strokeStyle = on ? C.accent : alpha(C.text, 0.35);
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, ww - 1, hh - 1);
      if (m.solarKW > 0.5 || (m.solar && m.solar.kWp > 0)) {
        ctx.fillStyle = C.solar;
        ctx.fillRect(x + ww - 7, y + 3, 4, 4);
      }
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.font = `700 10px ${C.font}`;
      ctx.fillText(BLOCK_SHORT[f.blockId] || f.blockId, x + ww / 2, y + hh / 2 - 6);
      ctx.font = `600 9.5px ${C.mono}`;
      ctx.fillText(fmtKW(m.kW), x + ww / 2, y + hh / 2 + 7);
    }
    // gate marker
    const gate = (SITE.zones || []).find((z) => z.type === 'gate');
    if (gate) {
      ctx.fillStyle = C.accent;
      ctx.beginPath(); ctx.arc(ox + (gate.x + gate.w / 2) * s, oy + (ROWS - 1) * s, 3, 0, Math.PI * 2); ctx.fill();
    }
    setText(mapTip, hoverId ? `${blockName(hoverId)}: ${fmtKW(meters[hoverId] && meters[hoverId].kW)} now. Click to see its meter.` : 'Colour shows load right now. Click a block to see its meter.');
  }

  return {
    el,
    update() {
      meters = {};
      let sumKW = 0, sumBase = 0, sumKWh = 0, sumBaseKWh = 0, haveKWh = false, solarKW = 0, solarKWp = 0, exKWp = 0;
      for (const c of cards) {
        const m = blockMeter(state, c.b.id);
        meters[c.b.id] = m;
        const hasMeter = !m.derived || m.rooms > 0;
        setClass(c.card, 'hide', !hasMeter);
        if (!hasMeter) continue;
        sumKW += safe(m.kW); sumBase += safe(m.baselineKW);
        if (isNum(m.kWhToday)) { haveKWh = true; sumKWh += m.kWhToday; sumBaseKWh += safe(m.baselineKWhToday); }
        solarKW += safe(m.solarKW); solarKWp += m.solar.kWp; exKWp += m.solar.existingKWp;
        setText(c.kw, fmtKW(m.kW));
        setText(c.base, `baseline ${fmtKW(m.baselineKW)}`);
        const scale = Math.max(1, m.kW, m.baselineKW);
        setStyle(c.bar, 'width', `${(safe(m.kW) / scale) * 100}%`);
        setStyle(c.barBase, 'width', `${(safe(m.baselineKW) / scale) * 100}%`);
        setText(c.kwh, isNum(m.kWhToday) ? fmtNum(m.kWhToday) : 'n/a');
        c.kwh.title = isNum(m.baselineKWhToday) ? `baseline ${fmtNum(m.baselineKWhToday)} kWh` : '';
        const pct = isNum(m.kWhToday) && safe(m.baselineKWhToday) > 0.5 ? 1 - m.kWhToday / m.baselineKWhToday
          : m.baselineKW > 0.5 ? 1 - m.kW / m.baselineKW : null;
        setText(c.save, isNum(pct) ? `${pct >= 0 ? '-' : '+'}${Math.abs(pct * 100).toFixed(0)}%` : '—');
        setClass(c.save, 'c-good', isNum(pct) && pct > 0.005);
        setText(c.ppl, m.rooms ? String(Math.round(m.people)) : '—');
        setText(c.off, m.rooms ? `${m.autoOff} rooms` : '—');
        // solar line: existing vs HUKUM expansion
        const so = m.solar;
        const sig = `${so.kWp}|${so.existingKWp}|${Math.round(so.kW * 10)}|${Math.round(safe(m.solarKW) * 10)}`;
        if (sig !== c.solarSig) {
          c.solarSig = sig;
          c.solar.textContent = '';
          if (so.kWp > 0) {
            if (so.existingKWp > 0) c.solar.append(h('span.bk-pv.pv-ex', h('i'), `Existing ${fmtNum(so.existingKWp)} kWp: ${fmtKW(so.existingKW)}`));
            if (so.newKWp > 0) c.solar.append(h('span.bk-pv.pv-new', h('i'), `HUKUM expansion ${fmtNum(so.newKWp)} kWp: ${fmtKW(so.newKW)}`));
          } else if (safe(m.solarKW) > 0.05) {
            c.solar.append(h('span.bk-pv.pv-new', h('i'), `Rooftop solar ${fmtKW(m.solarKW)}`));
          } else c.solar.append(h('span.bk-pv.pv-none', 'No rooftop solar'));
        }
      }
      setText(tKW, fmtKW(sumKW));
      setText(tBase, `baseline ${fmtKW(sumBase)}`);
      setText(tKWh, haveKWh ? `${fmtNum(sumKWh)} kWh` : '—');
      setText(tSave, haveKWh && sumBaseKWh > 0 ? `${fmtPct(1 - sumKWh / sumBaseKWh)} below baseline` : 'meters report kWh once running');
      setText(tSolar, fmtKW(solarKW));
      setText(tSolarS, solarKWp > 0 ? `${fmtNum(solarKWp)} kWp, ${fmtNum(exKWp)} existing` : 'per-block split not reported');
      drawMap();
    },
  };
}

const BLOCK_SHORT = Object.fromEntries(BLOCKS.map((b) => [b.id, b.short]));
