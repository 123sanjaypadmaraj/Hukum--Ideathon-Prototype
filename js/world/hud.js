// DOM heads-up display inside #world-hud: floor card + switcher, current
// room status, clock, minimap (click to teleport), interaction prompt,
// transient hints and the help overlay.
import { COLS, ROWS, BLOCKS } from '../building.js';
import { MINI_PPT } from './art.js';

const HELP = [
  ['Arrows / WASD', 'Walk (top-down). In first-person: Up/Down walk, Left/Right turn'],
  ['Shift', 'Run'],
  ['E / Enter', 'Interact: camera feed, AR panel lens, equipment, room'],
  ['PgUp / ]', 'Go up a floor (stand on the stairs or lift)'],
  ['PgDn / [', 'Go down a floor'],
  ['Walk into a door', 'Enter a block from the campus; leave by the EXIT TO CAMPUS door at the west end of a ground-floor corridor'],
  ['V', 'Toggle first-person view'],
  ['X', 'Toggle x-ray view: see-through 3D of every floor in the block (or the whole campus)'],
  ['Drag / wheel / , .', 'X-ray: orbit, zoom, rotate. Arrows walk relative to the camera'],
  ['L', 'Show or hide the wiring: DB, riser and every room circuit with live current flow'],
  ['M', 'Toggle minimap'],
  ['F', 'Show or hide the front view window (top-down): what you would see walking ahead'],
  ['Mouse wheel / + -', 'Zoom (top-down)'],
  ['Click', 'Room: inspect. Camera icon: open feed. Minimap: teleport. Block buttons: jump to that block'],
  ['H / ?', 'Toggle this help'],
];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function createHud({ root, onFloor, onBlock, onMiniClick, onToggleHelp, onWaste = () => {} }) {
  const wrap = el('div', 'wh');
  root.appendChild(wrap);

  // Floor card
  const card = el('div', 'wh-card wh-floor');
  card.innerHTML = `
    <div class="wh-bldg"><span class="wh-bname">NHCE</span> <span class="wh-view"></span></div>
    <div class="wh-row">
      <div class="wh-floors" role="group" aria-label="Floor switcher"></div>
      <div class="wh-info">
        <div class="wh-floorname"></div>
        <div class="wh-room"><span class="wh-dot"></span><span class="wh-roomname"></span></div>
        <div class="wh-roomstat"></div>
        <div class="wh-clock"></div>
      </div>
    </div>
    <div class="wh-blocks" role="group" aria-label="Go to block"></div>`;
  wrap.appendChild(card);
  const floorsEl = card.querySelector('.wh-floors');
  let floorBtns = [];
  let floorsKey = '';
  function setFloors(list) {
    const key = list.map((f) => `${f.level}:${f.label}`).join('|');
    if (key === floorsKey) return;
    floorsKey = key;
    floorsEl.textContent = '';
    floorBtns = list.map((f) => {
      const b = el('button', `wh-fbtn${f.campus ? ' wide' : ''}`, f.label);
      b.type = 'button';
      b.title = f.title;
      b._level = f.level;
      b.addEventListener('click', (ev) => { ev.preventDefault(); onFloor(f.level); });
      floorsEl.appendChild(b);
      return b;
    });
  }
  const blocksEl = card.querySelector('.wh-blocks');
  const blockBtns = {};
  const campusBtn = el('button', 'wh-bbtn', 'Campus');
  campusBtn.type = 'button'; campusBtn.title = 'NHCE campus site plan';
  campusBtn.addEventListener('click', (ev) => { ev.preventDefault(); onBlock('CAMPUS'); });
  blocksEl.appendChild(campusBtn);
  blockBtns.CAMPUS = campusBtn;
  for (const b of BLOCKS) {
    const btn = el('button', 'wh-bbtn', b.short);
    btn.type = 'button';
    btn.title = `${b.name}: ${b.about || ''}`;
    btn.addEventListener('click', (ev) => { ev.preventDefault(); onBlock(b.id); });
    blocksEl.appendChild(btn);
    blockBtns[b.id] = btn;
  }
  const $ = (s) => card.querySelector(s);
  const bnameEl = $('.wh-bname');
  const viewEl = $('.wh-view'), floorNameEl = $('.wh-floorname'), roomNameEl = $('.wh-roomname');
  const dotEl = $('.wh-dot'), roomStatEl = $('.wh-roomstat'), clockEl = $('.wh-clock');

  // Right column: minimap above the waste watch.
  const right = el('div', 'wh-right');
  wrap.appendChild(right);

  // Minimap
  const mini = el('div', 'wh-card wh-mini');
  const miniCv = el('canvas', 'wh-minicv');
  miniCv.style.width = `${COLS * MINI_PPT}px`;
  miniCv.style.height = `${ROWS * MINI_PPT}px`;
  const miniCap = el('div', 'wh-minicap', '<span>MAP</span><span>click to teleport</span>');
  mini.append(miniCv, miniCap);
  right.appendChild(mini);

  // Waste watch: rooms with lights on and nobody inside.
  const wasteCard = el('div', 'wh-card wh-waste');
  wasteCard.innerHTML = '<div class="wh-waste-h"><span>WASTE WATCH</span><span class="wh-waste-sum"></span></div><div class="wh-waste-list"></div>';
  right.appendChild(wasteCard);
  const wasteSum = wasteCard.querySelector('.wh-waste-sum');
  const wasteList = wasteCard.querySelector('.wh-waste-list');
  wasteList.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-room]');
    if (row) { ev.preventDefault(); onWaste(row.dataset.room); }
  });
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function setWaste(list, tot) {
    const rows = (list || []).slice(0, 4);
    const key = rows.map((r) => `${r.id}:${Math.floor(r.min)}:${r.kW.toFixed(1)}`).join('|') + (list ? list.length : 0);
    if (key === last.waste) return;
    last.waste = key;
    wasteCard.classList.toggle('alarm', rows.length > 0);
    wasteSum.textContent = rows.length ? `${tot.rooms} rooms  ${tot.kW.toFixed(1)} kW  Rs ${tot.rsPerHour.toFixed(0)}/h` : 'all clear';
    wasteList.innerHTML = rows.length
      ? rows.map((r) => `<button type="button" class="wh-wrow${r.min >= 5 ? ' hot' : ''}" data-room="${esc(r.id)}" title="${esc(r.name)}: ${esc(r.why)}. Click to go there.">
          <i></i><span class="wh-wname">${esc(r.id)} <em>${esc(r.where)}</em></span><span class="wh-wval">${Math.floor(r.min)} min  ${r.kW.toFixed(1)} kW</span></button>`).join('')
        + (list.length > rows.length ? `<div class="wh-wmore">+${list.length - rows.length} more</div>` : '')
      : '<div class="wh-wok">No room has lights on with nobody inside.</div>';
  }
  miniCv.addEventListener('click', (ev) => {
    const r = miniCv.getBoundingClientRect();
    const tx = (ev.clientX - r.left) / r.width * COLS;
    const ty = (ev.clientY - r.top) / r.height * ROWS;
    onMiniClick(tx, ty);
  });

  // Bottom hint strip
  const hint = el('div', 'wh-hint', '<kbd>Arrows</kbd> walk <kbd>E</kbd> interact <kbd>PgUp</kbd><kbd>PgDn</kbd> floor <kbd>X</kbd> x-ray <kbd>L</kbd> wiring <kbd>V</kbd> first-person <kbd>F</kbd> front view <kbd>H</kbd> help');
  wrap.appendChild(hint);

  // Floating prompt
  const prompt = el('div', 'wh-prompt');
  wrap.appendChild(prompt);

  // Transient message
  const toast = el('div', 'wh-msg');
  wrap.appendChild(toast);

  // Help overlay
  const help = el('div', 'wh-card wh-help');
  help.innerHTML = `<div class="wh-help-h"><b>Building controls</b><button type="button" class="wh-x" aria-label="Close help">Close</button></div>
    <table>${HELP.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table>
    <p class="wh-help-f">Rooms glowing red have their lights on with nobody inside. After 5 minutes you get a warning; the Waste Watch panel lists them, click one to go there.</p>
    <p class="wh-help-f">Rooms glow warm when lit. Dark rooms marked AUTO-OFF were switched off by HUKUM after their camera saw nobody for 10 minutes; they power back on the moment someone walks in.</p>
    <div class="wh-legend">
      <span><i style="background:#f5b301"></i>You</span><span><i style="background:#4fc3f7"></i>Student</span>
      <span><i style="background:#b388ff"></i>Staff</span><span><i style="background:#ff8a65"></i>Guard</span>
      <span><i style="background:#81c784"></i>Cleaner</span><span><i class="cone"></i>Camera view</span>
    </div>`;
  help.querySelector('.wh-x').addEventListener('click', () => onToggleHelp(false));
  wrap.appendChild(help);

  const last = {};
  const setText = (node, key, v) => { if (last[key] !== v) { last[key] = v; node.textContent = v; } };
  const setCls = (node, key, v) => { if (last[key] !== v) { last[key] = v; node.className = v; } };
  let msgTimer = 0;

  return {
    miniCanvas: miniCv,
    update(info) {
      setText(viewEl, 'view', (info.mode === 'xray' ? 'X-RAY' : info.fp ? 'FIRST-PERSON' : 'TOP-DOWN') + (info.wiring ? ' + WIRING' : ''));
      setWaste(info.waste, info.wasteTotals);
      setText(floorNameEl, 'floor', info.floorName);
      setText(roomNameEl, 'room', info.roomName);
      setText(roomStatEl, 'stat', info.roomStat);
      setText(clockEl, 'clock', info.clock);
      setCls(dotEl, 'dot', `wh-dot ${info.roomDot}`);
      setText(bnameEl, 'bname', info.blockLabel);
      setFloors(info.floorButtons);
      for (const b of floorBtns) {
        const on = b._level === info.level;
        if (b._on !== on) { b._on = on; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
      }
      for (const id in blockBtns) {
        const on = id === info.blockId;
        const btn = blockBtns[id];
        if (btn._on !== on) { btn._on = on; btn.classList.toggle('on', on); }
      }
      if (last.miniOn !== info.miniOn) { last.miniOn = info.miniOn; mini.style.display = info.miniOn ? '' : 'none'; }
      if (last.helpOn !== info.helpOn) { last.helpOn = info.helpOn; help.classList.toggle('open', info.helpOn); }
    },
    setPrompt(html, x, y) {
      if (!html) {
        if (last.prompt !== '') { last.prompt = ''; prompt.classList.remove('show'); }
        return;
      }
      if (last.prompt !== html) { last.prompt = html; prompt.innerHTML = html; prompt.classList.add('show'); }
      prompt.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    },
    flash(text, sec = 2.2) {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => toast.classList.remove('show'), sec * 1000);
    },
  };
}
