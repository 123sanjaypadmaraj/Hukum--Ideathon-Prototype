// AR Panel Lens: a phone-style AR view of a distribution board. The board is
// rendered on canvas like a camera frame; detection / OCR / live-kW callouts
// are DOM overlays in the same coordinate space.
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, setStyle, segmented, fmtKW, fmtPct, safe, isNum, tokens } from './util.js';
import {
  PANELS, PANEL_BY_ID, ROOM_BY_ID, EQUIPMENT_BY_ID, roomState, equipState, circuitKW, circuitState, capacityKW,
  roomPower, cameraForRoom, roomCentre, floorShort, FLOORS, BLOCKS, BLOCK_BY_ID, blockName, blockMeter,
} from './derive.js';

const KIND_TAG = { lighting: 'L+F', ac: 'AC', equipment: 'SKT', incomer: 'INC', solar: 'PV', battery: 'BAT', feeder: 'FDR', ev: 'EV' };
const KIND_NAME = { lighting: 'Lights and fans', ac: 'Air conditioning', equipment: 'Sockets and equipment', incomer: 'Grid incomer', solar: 'Solar PV', battery: 'Battery inverter', feeder: 'Feeder', ev: 'EV charging' };

function shortRoom(id) { return String(id || '').replace(/^MB-/, ''); }
function stripText(c) {
  if (c.roomId) return [`${c.breaker} ${KIND_TAG[c.kind] || ''}`, shortRoom(c.roomId)];
  const second = c.kind === 'incomer' ? 'GRID IN' : c.kind === 'solar' ? 'SOLAR PV' : c.kind === 'battery' ? 'BAT-1' : c.kind === 'ev' ? 'EV BAY'
    : c.blockId ? `${c.blockId} BLOCK` : /hostel/i.test(c.label) ? 'HOSTELS' : /flood|campus/i.test(c.label) ? 'FLOODLT' : 'FEEDER';
  return [`${c.breaker} ${c.ratingA}A`, second];
}
function hash01(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return ((x >>> 0) % 1000) / 1000;
}

// Where a circuit lives on the map, if anywhere.
function circuitTarget(c) {
  if (c.roomId && ROOM_BY_ID[c.roomId]) return roomCentre(ROOM_BY_ID[c.roomId]);
  if (c.equipId && EQUIPMENT_BY_ID[c.equipId] && isNum(EQUIPMENT_BY_ID[c.equipId].x)) {
    const e = EQUIPMENT_BY_ID[c.equipId];
    return { floor: e.floor, x: e.x, y: e.y };
  }
  if (c.kind === 'ev' && ROOM_BY_ID.PARKING) return roomCentre(ROOM_BY_ID.PARKING);
  if (c.blockId && BLOCK_BY_ID[c.blockId]) return { floor: BLOCK_BY_ID[c.blockId].ground, x: 1.5, y: 14.5 };
  if (/flood|campus/i.test(c.label || '') && ROOM_BY_ID.SPORTS) return roomCentre(ROOM_BY_ID.SPORTS);
  return null;
}

let noiseCanvas = null;
function noise() {
  if (noiseCanvas) return noiseCanvas;
  noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = noiseCanvas.height = 160;
  const g = noiseCanvas.getContext('2d');
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return noiseCanvas;
}

function rr(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function computeLayout(panel, vw, vh, sheetH) {
  const n = Math.max(1, panel.circuits.length);
  const big = panel.id === 'MLT';
  const px = 16, pw = vw - 32, py = 100;
  const inner = 14;
  const maxCols = Math.max(3, Math.floor((pw - inner * 2) / (big ? 48 : 38)));
  const rowsN = Math.ceil(n / maxCols);
  const cols = Math.ceil(n / rowsN);
  const slotW = (pw - inner * 2) / cols;
  const headerH = 40;
  const chipH = 16, stripH = 22;
  const avail = vh - sheetH - py - 18;
  let bh = big ? 78 : 64;
  const fixed = chipH + 8 + 4 + stripH + 14;
  const need = headerH + rowsN * (fixed + bh) + 8;
  if (need > avail) bh = Math.max(46, (avail - headerH - 8) / rowsN - fixed);
  const rowH = fixed + bh;
  const ph = headerH + rowsN * rowH + 8;
  const bw = Math.min(big ? 50 : 38, slotW - 6);
  const items = panel.circuits.map((c, i) => {
    const r = Math.floor(i / cols), col = i % cols;
    const sx = px + inner + col * slotW;
    const y0 = py + headerH + r * rowH;
    const bx = sx + (slotW - bw) / 2;
    const by = y0 + chipH + 8;
    return {
      c, i, row: r,
      slot: { x: sx, w: slotW },
      chip: { x: sx + 2, y: y0, w: slotW - 4, h: chipH },
      br: { x: bx, y: by, w: bw, h: bh },
      strip: { x: sx + 2, y: by + bh + 4, w: slotW - 4, h: stripH },
      duct: y0 + chipH / 2,
    };
  });
  // Still too tall (small screens): shrink the whole board around its top centre.
  const scale = Math.min(1, avail / ph);
  return { vw, vh, px, py, pw, ph, inner, headerH, rowsN, rowH, cols, slotW, items, big, scale, ox: px + pw / 2, oy: py };
}

function drawLook(ctx, vw, vh) {
  // camera look: warm glare + vignette
  const glare = ctx.createRadialGradient(vw * 0.25, vh * 0.12, 10, vw * 0.25, vh * 0.12, vw * 0.9);
  glare.addColorStop(0, 'rgba(255,240,210,.10)'); glare.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = glare; ctx.fillRect(0, 0, vw, vh);
  const vig = ctx.createRadialGradient(vw / 2, vh * 0.42, vh * 0.25, vw / 2, vh * 0.42, vh * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, vw, vh);
}

function drawBoard(ctx, L, panel, levers, t) {
  const { vw, vh, px, py, pw, ph } = L;
  // wall
  const wall = ctx.createLinearGradient(0, 0, vw * 0.3, vh);
  wall.addColorStop(0, '#3a3a36'); wall.addColorStop(1, '#1d1d1b');
  ctx.fillStyle = wall; ctx.fillRect(-vw, -vh, vw * 3, vh * 3);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = ctx.createPattern(noise(), 'repeat');
  ctx.fillRect(-vw, -vh, vw * 3, vh * 3);
  ctx.globalAlpha = 1;
  // floor line + skirting far below
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, vh * 0.93, vw, vh * 0.07);

  // conduits up into the ceiling
  for (let k = 0; k < 4; k++) {
    const cx = px + 30 + k * 26;
    const g = ctx.createLinearGradient(cx - 6, 0, cx + 6, 0);
    g.addColorStop(0, '#5d6064'); g.addColorStop(0.5, '#9ea2a6'); g.addColorStop(1, '#4b4e52');
    ctx.fillStyle = g; ctx.fillRect(cx - 6, -vh, 12, py + 4 + vh);
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(cx - 6, py - 14, 12, 3);
  }
  ctx.fillStyle = '#2e5aa8';
  ctx.fillRect(px + pw - 54, -vh, 9, py + 4 + vh);       // blue data conduit

  // enclosure
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 12;
  rr(ctx, px, py, pw, ph, 7);
  const encl = ctx.createLinearGradient(px, py, px + pw, py + ph);
  encl.addColorStop(0, '#c9cdd0'); encl.addColorStop(0.55, '#a7acb0'); encl.addColorStop(1, '#8b9095');
  ctx.fillStyle = encl; ctx.fill();
  ctx.restore();
  // open door edge on the left
  ctx.fillStyle = '#7d8286';
  ctx.beginPath(); ctx.moveTo(px - 12, py + 6); ctx.lineTo(px, py + 2); ctx.lineTo(px, py + ph - 2); ctx.lineTo(px - 12, py + ph - 6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#555a5e';
  for (const hy of [py + 30, py + ph - 40]) ctx.fillRect(px - 3, hy, 4, 18);

  // backplate
  const bp = { x: px + 8, y: py + 8, w: pw - 16, h: ph - 16 };
  rr(ctx, bp.x, bp.y, bp.w, bp.h, 4);
  const back = ctx.createLinearGradient(0, bp.y, 0, bp.y + bp.h);
  back.addColorStop(0, '#2a2e32'); back.addColorStop(1, '#1d2023');
  ctx.fillStyle = back; ctx.fill();

  // header plate + danger sticker
  ctx.fillStyle = '#111315';
  rr(ctx, bp.x + 6, bp.y + 5, bp.w - 64, 20, 2); ctx.fill();
  ctx.fillStyle = '#e8e8e2';
  ctx.font = `600 9px ${tokens().mono}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const fl = FLOORS[panel.floor];
  const where = panel.id === 'MLT' ? 'MAIN LT' : (fl && fl.floorName ? String(fl.floorName).toUpperCase() : '');
  ctx.fillText(`${panel.id}  ${where}  415V`, bp.x + 12, bp.y + 15.5, bp.w - 76);
  const sx = bp.x + bp.w - 50, sy = bp.y + 4;
  ctx.fillStyle = '#f2c40f'; rr(ctx, sx, sy, 44, 22, 2); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.moveTo(sx + 11, sy + 4); ctx.lineTo(sx + 18, sy + 17); ctx.lineTo(sx + 4, sy + 17); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f2c40f'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('!', sx + 11, sy + 12.5);
  ctx.fillStyle = '#111'; ctx.font = 'bold 6.5px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('DANGER', sx + 20, sy + 8); ctx.fillText('415 V', sx + 20, sy + 16);

  const wireCols = ['#c62828', '#f9a825', '#1565c0', '#212121'];
  for (let r = 0; r < L.rowsN; r++) {
    const rowItems = L.items.filter((it) => it.row === r);
    if (!rowItems.length) continue;
    const first = rowItems[0];
    const y0 = first.chip.y;
    // cable duct
    const dy = y0 - 2, dh = first.br.y - y0 - 2;
    ctx.fillStyle = '#6f757a'; ctx.fillRect(bp.x + 4, dy, bp.w - 8, dh);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (let x = bp.x + 10; x < bp.x + bp.w - 8; x += 7) ctx.fillRect(x, dy + 3, 3, dh - 6);
    // DIN rail + busbar
    const midY = first.br.y + first.br.h / 2;
    const rail = ctx.createLinearGradient(0, midY - 9, 0, midY + 9);
    rail.addColorStop(0, '#d9dde0'); rail.addColorStop(0.5, '#8d9296'); rail.addColorStop(1, '#c3c7ca');
    ctx.fillStyle = rail; ctx.fillRect(bp.x + 4, midY - 9, bp.w - 8, 18);
    ctx.fillStyle = '#b8742c'; ctx.fillRect(first.br.x - 2, first.br.y + 2, rowItems[rowItems.length - 1].br.x + first.br.w - first.br.x + 4, 3);
    // blank cover strip for labels
    ctx.fillStyle = '#3a3f44';
    ctx.fillRect(bp.x + 4, first.strip.y - 2, bp.w - 8, first.strip.h + 4);
  }

  for (const it of L.items) {
    const { br, strip } = it;
    const on = levers[it.i];
    // wire from top terminal into duct
    ctx.strokeStyle = wireCols[it.i % 4]; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(br.x + br.w / 2, br.y + 4); ctx.lineTo(br.x + br.w / 2, it.chip.y + it.chip.h - 2); ctx.stroke();
    // body
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    rr(ctx, br.x, br.y, br.w, br.h, 2.5);
    const body = ctx.createLinearGradient(br.x, 0, br.x + br.w, 0);
    body.addColorStop(0, '#d7d4cc'); body.addColorStop(0.35, '#f2f0ea'); body.addColorStop(1, '#c4c1b9');
    ctx.fillStyle = body; ctx.fill();
    ctx.restore();
    // terminals
    ctx.fillStyle = '#9c9a94';
    const th = Math.max(6, br.h * 0.14);
    ctx.fillRect(br.x + 3, br.y + 3, br.w - 6, th);
    ctx.fillRect(br.x + 3, br.y + br.h - 3 - th, br.w - 6, th);
    ctx.fillStyle = '#5b5a56';
    for (const ty of [br.y + 3 + th / 2, br.y + br.h - 3 - th / 2]) {
      ctx.beginPath(); ctx.arc(br.x + br.w / 2, ty, Math.min(2.6, th / 2.4), 0, Math.PI * 2); ctx.fill();
    }
    // toggle window
    const tw = Math.min(br.w * 0.5, 16), thh = br.h * 0.34;
    const tx = br.x + (br.w - tw) / 2, ty = br.y + br.h / 2 - thh / 2;
    ctx.fillStyle = '#1a1a1a'; rr(ctx, tx, ty, tw, thh, 2); ctx.fill();
    const lh = thh * 0.5;
    const ly = on ? ty + 1.5 : ty + thh - lh - 1.5;
    const lever = ctx.createLinearGradient(0, ly, 0, ly + lh);
    lever.addColorStop(0, on ? '#3c3c3c' : '#2a2a2a'); lever.addColorStop(1, on ? '#101010' : '#3a3a3a');
    ctx.fillStyle = lever; rr(ctx, tx + 1.5, ly, tw - 3, lh, 1.5); ctx.fill();
    // status flag
    ctx.fillStyle = on ? '#2e9d4b' : '#d63a2f';
    ctx.fillRect(br.x + br.w / 2 - 4, ty - 6, 8, 3.5);
    // rating print
    if (br.h > 44) {
      ctx.fillStyle = '#444';
      ctx.font = `600 ${br.w > 44 ? 8 : 7}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const rating = it.c.ratingA >= 100 ? `${it.c.ratingA}A` : `C${it.c.ratingA}`;
      ctx.fillText(rating, br.x + br.w / 2, ty + thh + 7);
    }
    // handwritten label strip
    ctx.fillStyle = '#efe9d8';
    ctx.fillRect(strip.x, strip.y, strip.w, strip.h);
    ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(strip.x, strip.y + strip.h - 2, strip.w, 2);
    const [l1, l2] = stripText(it.c);
    ctx.fillStyle = '#1b2f73';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.min(8, strip.w / 6.2);
    ctx.font = `bold ${fs}px "Segoe Print", "Comic Sans MS", "Bradley Hand", cursive`;
    ctx.fillText(l1, strip.x + strip.w / 2, strip.y + 6.5, strip.w - 2);
    ctx.fillText(l2, strip.x + strip.w / 2, strip.y + 15.5, strip.w - 2);
  }

}

export function createLens({ state, actions, modal, onInspect }) {
  let lockTimer = 0;
  let panel = null, open = false, L = null, sel = null, phase = 'scan', raf = 0, t0 = 0, levSig = '';
  let els = null;

  function build() {
    const canvas = h('canvas.ar-cam');
    const layer = h('div.ar-layer');
    const grain = h('div.ar-grain');
    try { grain.style.backgroundImage = `url(${noise().toDataURL()})`; } catch { /* ignore */ }
    const stage = h('div.ar-stage', canvas, layer);
    const scan = h('div.ar-scan');
    const hudTag = h('div.ar-hud-tag', 'Looking for a distribution board...');
    const reticle = h('div.ar-reticle');
    const view = h('div.ar-view', stage, grain, scan, reticle, h('div.ar-hud', h('span.ar-rec'), hudTag));
    const clock = h('span.num', '--:--');
    const status = h('div.ar-status', clock, h('span.ar-app', 'HUKUM Lens'), h('span.ar-batt', h('i')));
    const sheet = h('div.ar-sheet');
    const closeBtn = h('button.ar-close', { type: 'button', title: 'Close (Esc)', onclick: close }, 'Close');
    const screen = h('div.phone-screen', view, status, sheet);
    const phone = h('div.phone', h('div.phone-notch'), screen, h('div.phone-btn.b1'), h('div.phone-btn.b2'));

    const groups = [...BLOCKS.map((b) => b.id)].map((bid) => ({ bid, list: PANELS.filter((p) => p.blockId === bid) })).filter((g) => g.list.length);
    const panelBtns = h('div.lens-groups', groups.map((g) => h('div.lens-group',
      h('span.lens-group-l', BLOCK_BY_ID[g.bid] ? BLOCK_BY_ID[g.bid].short : g.bid),
      h('div.lens-panels', g.list.map((p) => h('button.chip', {
        type: 'button', dataset: { id: p.id }, title: p.name, onclick: () => switchPanel(p.id),
      }, p.id === 'MLT' ? 'Main LT' : p.id.replace(/^DB-[A-Z]+-/, 'DB ')))))));
    const side = h('div.lens-side',
      h('div.lens-side-h', h('div.tile-l', 'AR Panel Lens'), closeBtn),
      h('h3.lens-title', ''),
      h('p.lens-p', 'Point a phone at any distribution board. HUKUM recognises the board, reads every breaker label with OCR and links each circuit to the digital twin, so an electrician sees what each breaker feeds and what it draws right now.'),
      h('ol.lens-steps',
        h('li', h('b', 'Detect'), ' the panel and match it to the asset register'),
        h('li', h('b', 'Read'), ' breaker labels (OCR boxes)'),
        h('li', h('b', 'Overlay'), ' live kW and the room each circuit feeds')),
      h('div.tile-l', 'Other panels'), panelBtns,
      h('div.lens-legend',
        h('span.lg', h('i.st-live'), 'Drawing power'), h('span.lg', h('i.st-idle'), 'On, idle'),
        h('span.lg', h('i.st-off'), 'Auto-off / open'), h('span.lg', h('i.st-override'), 'Manual override')),
      h('div.lens-hint', 'Tap a breaker on the phone. Esc closes.'));

    const root = h('div.lens-modal', { role: 'dialog', 'aria-label': 'AR Panel Lens' }, phone, side);
    els = { root, canvas, layer, stage, grain, scan, hudTag, view, clock, sheet, side, panelBtns, reticle, overlay: [] };
  }

  function buildOverlays() {
    const { layer } = els;
    layer.textContent = '';
    els.overlay = [];
    const det = h('div.ar-detect', h('i.c1'), h('i.c2'), h('i.c3'), h('i.c4'),
      h('div.ar-detect-tag', h('b', 'Panel recognised'), ` ${panel.id} · ${(97 + hash01(panel.id) * 2.5).toFixed(0)}%`));
    Object.assign(det.style, { left: `${L.px - 8}px`, top: `${L.py - 8}px`, width: `${L.pw + 16}px`, height: `${L.ph + 16}px` });
    layer.append(det);
    for (const it of L.items) {
      const ocr = h('div.ar-ocr');
      Object.assign(ocr.style, { left: `${it.strip.x - 1.5}px`, top: `${it.strip.y - 1.5}px`, width: `${it.strip.w + 3}px`, height: `${it.strip.h + 3}px`, transitionDelay: `${350 + it.i * 35}ms` });
      const chip = h('div.ar-chip.num');
      Object.assign(chip.style, { left: `${it.chip.x}px`, top: `${it.chip.y}px`, width: `${it.chip.w}px`, height: `${it.chip.h}px`, transitionDelay: `${700 + it.i * 30}ms` });
      const hit = h('button.ar-hit', { type: 'button', title: it.c.label, onclick: () => select(it.i) });
      Object.assign(hit.style, { left: `${it.slot.x + 1}px`, top: `${it.chip.y - 2}px`, width: `${it.slot.w - 2}px`, height: `${it.strip.y + it.strip.h - it.chip.y + 4}px` });
      layer.append(ocr, chip, hit);
      els.overlay.push({ it, ocr, chip, hit });
    }
    els.callout = h('div.ar-callout');
    layer.append(els.callout);
  }

  function measure() {
    const r = els.view.getBoundingClientRect();
    const vw = Math.round(r.width), vh = Math.round(r.height);
    if (!vw || !vh) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    els.canvas.width = vw * dpr; els.canvas.height = vh * dpr;
    els.canvas.style.width = `${vw}px`; els.canvas.style.height = `${vh}px`;
    els.dpr = dpr;
    L = computeLayout(panel, vw, vh, Math.min(250, vh * 0.36));
    buildOverlays();
    els.layer.style.transformOrigin = `${L.ox}px ${L.oy}px`;
    els.layer.style.transform = L.scale < 1 ? `scale(${L.scale.toFixed(4)})` : '';
    levSig = '';
    return true;
  }

  function levers() {
    return panel.circuits.map((c) => {
      if (c.roomId) {
        const rs = roomState(state, c.roomId);
        if (rs.override === 'off') return false;
        if (rs.override === 'on') return true;
        return rs.powered !== false;
      }
      if (c.equipId && equipState(state, c.equipId).override === 'off') return false;
      if (c.kind === 'incomer' && state.scenario && state.scenario.outage) return false;
      return true;
    });
  }

  function redraw(force) {
    if (!L) return;
    const lv = levers();
    const sig = lv.join('');
    if (!force && sig === levSig) return;
    levSig = sig;
    const ctx = els.canvas.getContext('2d');
    ctx.setTransform(els.dpr, 0, 0, els.dpr, 0, 0);
    const { scale: k, ox, oy } = L;
    ctx.translate(ox, oy); ctx.scale(k, k); ctx.translate(-ox, -oy);
    drawBoard(ctx, L, panel, lv, state.t);
    ctx.setTransform(els.dpr, 0, 0, els.dpr, 0, 0);
    drawLook(ctx, L.vw, L.vh);
  }

  function select(i) {
    sel = sel === i ? null : i;
    renderSheet(true);
    refreshOverlays();
  }

  function stateOf(c) { return circuitState(state, c); }

  function refreshOverlays() {
    if (!L) return;
    for (const o of els.overlay) {
      const c = o.it.c;
      const kw = circuitKW(state, c);
      const st = stateOf(c);
      setText(o.chip, st === 'off' ? 'OFF' : Math.abs(kw) >= 100 ? Math.round(kw).toString() : kw.toFixed(1));
      const cls = `ar-chip num st-${st}${sel === o.it.i ? ' sel' : ''}`;
      if (o.chip.className !== cls) o.chip.className = cls;
      setClass(o.ocr, 'sel', sel === o.it.i);
      setClass(o.hit, 'sel', sel === o.it.i);
    }
    const co = els.callout;
    if (sel == null || !L.items[sel]) { setClass(co, 'show', false); return; }
    const it = L.items[sel];
    const c = it.c;
    const kw = circuitKW(state, c);
    const room = c.roomId ? ROOM_BY_ID[c.roomId] : null;
    const rs = room ? roomState(state, room.id) : null;
    co.textContent = '';
    co.append(
      h('div.co-h', h('b', c.breaker), ` ${c.label}`),
      h('div.co-v.num', fmtKW(kw)),
      h('div.co-s', room ? `${room.name} · ${safe(rs.occupancy)} ppl` : KIND_NAME[c.kind] || ''),
    );
    const W = 150;
    let left = it.slot.x + it.slot.w / 2 - W / 2;
    left = Math.max(6, Math.min(L.vw - W - 6, left));
    const above = it.chip.y - 64 > 34;
    const top = above ? it.chip.y - 62 : it.strip.y + it.strip.h + 8;
    Object.assign(co.style, { left: `${left}px`, top: `${top}px`, width: `${W}px` });
    co.style.setProperty('--px', `${it.slot.x + it.slot.w / 2 - left}px`);
    setClass(co, 'below', !above);
    setClass(co, 'show', true);
  }

  // ----- bottom sheet -----
  let sheetSig = '';
  let sheetRefs = null;
  function renderSheet(force) {
    const sig = `${panel.id}|${sel}`;
    if (force || sig !== sheetSig) {
      sheetSig = sig;
      els.sheet.textContent = '';
      sheetRefs = sel == null ? buildSummary() : buildDetail(panel.circuits[sel]);
    }
    sheetRefs && sheetRefs.update();
  }

  function buildSummary() {
    const total = h('b.num', '—');
    const live = h('b.num', '—');
    const list = h('div.sh-list');
    els.sheet.append(
      h('div.sh-grab'),
      h('div.sh-h', h('div', h('div.sh-title', panel.name), h('div.sh-sub', `${panel.circuits.length} circuits · ${blockName(panel.blockId)}${FLOORS[panel.floor] && panel.id !== 'MLT' ? ` · ${FLOORS[panel.floor].floorName}` : ''}`)),
        h('div.sh-total', total, h('span', 'kW live'))),
      h('div.sh-row-l', 'Biggest loads now · tap a breaker for details', live),
      list);
    return {
      update() {
        const rows = panel.circuits.map((c, i) => ({ c, i, kw: circuitKW(state, c) })).sort((a, b) => Math.abs(b.kw) - Math.abs(a.kw));
        const sum = panel.id === 'MLT' ? safe(state.energy && state.energy.demandKW, rows.reduce((s, r) => s + Math.max(0, r.kw), 0))
          : rows.reduce((s, r) => s + r.kw, 0);
        setText(total, fmtKW(sum, false));
        setText(live, `${rows.filter((r) => Math.abs(r.kw) > 0.05).length} drawing`);
        const top = rows.slice(0, 4);
        const sig = top.map((r) => r.i).join(',');
        if (list.dataset.sig !== sig) {
          list.dataset.sig = sig;
          list.textContent = '';
          for (const r of top) {
            const v = h('b.num', '');
            const b = h('button.sh-item', { type: 'button', onclick: () => select(r.i) },
              h('span.sh-code', r.c.breaker), h('span.sh-name', r.c.label), v);
            b._v = v; b._i = r.i;
            list.append(b);
          }
        }
        for (const b of list.children) setText(b._v, fmtKW(circuitKW(state, panel.circuits[b._i])));
      },
    };
  }

  function buildDetail(c) {
    const room = c.roomId ? ROOM_BY_ID[c.roomId] : null;
    const equip = c.equipId ? EQUIPMENT_BY_ID[c.equipId] : null;
    const kw = h('div.sh-kw.num', '—');
    const pct = h('span.num', '');
    const fill = h('div.bar-fill');
    const feeds = h('div.sh-feeds');
    const target = circuitTarget(c);
    let seg = null;
    if (room) seg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], (v) => actions.setRoomOverride(room.id, v === 'auto' ? null : v), 'seg-sm');
    else if (equip && equip.kind !== 'solar') seg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], (v) => actions.setEquipmentOverride(equip.id, v === 'auto' ? null : v), 'seg-sm');

    const showBtn = h('button.btn.btn-accent.btn-sm', {
      type: 'button', disabled: !target, title: target ? 'Walk to this on the map' : 'Not on the campus map',
      onclick: () => { if (target) { actions.teleport(target.floor, target.x, target.y); close(); } },
    }, 'Show on map');
    const inspectBtn = (room || equip) ? h('button.btn.btn-sm', { type: 'button', onclick: () => { close(); onInspect(room ? 'room' : 'equipment', (room || equip).id); } }, 'Inspect') : null;

    els.sheet.append(
      h('div.sh-grab'),
      h('div.sh-h',
        h('div.sh-hl', h('span.sh-badge', c.breaker), h('div', h('div.sh-title', c.label), h('div.sh-sub', `${KIND_NAME[c.kind] || c.kind} · ${c.ratingA} A · OCR ${(0.9 + hash01(c.label) * 0.09).toFixed(2)}`))),
        h('button.sh-x', { type: 'button', title: 'Back to panel', onclick: () => select(sel) }, 'Back')),
      h('div.sh-load', kw, h('div.sh-load-r', h('div.sh-row-l', 'of breaker capacity', pct), h('div.bar', fill))),
      feeds,
      h('div.sh-actions', seg ? h('div.sh-ov', h('span.sh-row-l', 'Override'), seg.el) : h('span'), h('div.sh-btns', inspectBtn, showBtn)));

    let fBlock = null;
    const fRoom = room ? {
      occ: h('b.num', ''), det: h('b.num', ''), pow: h('span.pill', ''), temp: h('b.num', ''),
    } : null;
    if (room) {
      feeds.append(
        h('div.sh-feed-h', h('span.sh-row-l', 'Feeds'), h('b', `${room.name}`), h('span.sh-sub', ` ${room.id} · ${floorShort(room.floor)}`)),
        h('div.sh-grid',
          h('div', h('span', 'People'), fRoom.occ), h('div', h('span', 'Camera'), fRoom.det),
          h('div', h('span', 'Temp'), fRoom.temp), h('div', h('span', 'Power'), fRoom.pow)));
    } else if (c.blockId) {
      fBlock = { ppl: h('b.num', ''), off: h('b.num', ''), base: h('b.num', ''), solar: h('b.num', '') };
      feeds.append(
        h('div.sh-feed-h', h('span.sh-row-l', 'Feeds'), h('b', blockName(c.blockId)), h('span.sh-sub', ' block energy meter')),
        h('div.sh-grid',
          h('div', h('span', 'People'), fBlock.ppl), h('div', h('span', 'Auto-off'), fBlock.off),
          h('div', h('span', 'Baseline'), fBlock.base), h('div', h('span', 'Solar'), fBlock.solar)));
    } else {
      feeds.append(h('div.sh-feed-h', h('span.sh-row-l', 'Feeds'), h('b', equip ? equip.name : c.label)));
    }

    return {
      update() {
        const v = circuitKW(state, c);
        setText(kw, fmtKW(v));
        const cap = capacityKW(c);
        const f = cap > 0 ? Math.abs(v) / cap : 0;
        setText(pct, fmtPct(f));
        setStyle(fill, 'width', `${Math.min(100, f * 100)}%`);
        setClass(fill, 'warn', f > 0.8);
        if (room) {
          const rs = roomState(state, room.id);
          const cam = cameraForRoom(state, room.id);
          setText(fRoom.occ, String(safe(rs.occupancy)));
          setText(fRoom.det, cam ? (cam.online ? `${isNum(rs.detected) ? rs.detected : cam.count} seen` : 'offline') : 'none');
          setText(fRoom.temp, isNum(rs.tempC) ? `${rs.tempC.toFixed(1)} C` : '—');
          const p = roomPower(state, room.id);
          setText(fRoom.pow, p.label);
          const cls = `pill p-${p.tone}`;
          if (fRoom.pow.className !== cls) fRoom.pow.className = cls;
          seg && seg.set(rs.override || 'auto');
        } else if (fBlock) {
          const bm = blockMeter(state, c.blockId);
          setText(fBlock.ppl, String(Math.round(bm.people)));
          setText(fBlock.off, `${bm.autoOff} rooms`);
          setText(fBlock.base, fmtKW(bm.baselineKW));
          setText(fBlock.solar, fmtKW(bm.solarKW));
        } else if (equip && seg) {
          seg.set(equipState(state, equip.id).override || 'auto');
        }
      },
    };
  }

  function animate(now) {
    if (!open) return;
    const t = (now - t0) / 1000;
    // handheld sway
    const dx = Math.sin(t * 0.9) * 1.6 + Math.sin(t * 2.3) * 0.5;
    const dy = Math.cos(t * 0.7) * 1.3 + Math.sin(t * 1.9) * 0.4;
    const rot = Math.sin(t * 0.5) * 0.25;
    els.stage.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rot.toFixed(3)}deg)`;
    els.grain.style.backgroundPosition = `${(Math.random() * 160) | 0}px ${(Math.random() * 160) | 0}px`;
    raf = requestAnimationFrame(animate);
  }

  function switchPanel(id) {
    if (!PANEL_BY_ID[id]) return;
    panel = PANEL_BY_ID[id];
    state.ui.lensPanel = id;
    sel = null;
    phase = 'scan';
    t0 = performance.now();
    setClass(els.view, 'locked', false);
    setText(els.hudTag, 'Looking for a distribution board...');
    setText(els.side.querySelector('.lens-title'), `${panel.name} (${panel.id})`);
    for (const b of els.panelBtns.querySelectorAll('button')) setClass(b, 'on', b.dataset.id === id);
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => {
      if (!open || phase !== 'scan') return;
      phase = 'locked';
      setClass(els.view, 'locked', true);
      setText(els.hudTag, `Panel recognised · ${panel.id} · ${panel.circuits.length} labels read`);
    }, 1150);
    measure();
    redraw(true);
    renderSheet(true);
    refreshOverlays();
  }

  function onResize() { if (open && measure()) { redraw(true); refreshOverlays(); } }

  function openLens(panelId) {
    const p = PANEL_BY_ID[panelId] || PANELS[0];
    if (!els) build();
    if (!open) {
      modal.open('lens', els.root, close);
      open = true;
      window.addEventListener('resize', onResize);
      raf = requestAnimationFrame(animate);
    }
    // wait one frame so the phone has its size
    requestAnimationFrame(() => { if (open) { switchPanel(p.id); } });
  }

  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    modal.close('lens');
    if (state.ui) state.ui.lensPanel = null;
  }

  return {
    open: openLens,
    close,
    isOpen: () => open,
    update() {
      if (!open || !panel || !L) return;
      setText(els.clock, fmtTime(minuteOfDay(safe(state.t))));
      redraw(false);
      refreshOverlays();
      renderSheet(false);
    },
  };
}

