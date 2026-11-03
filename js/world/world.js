// The navigable NHCE campus: 2.5D top-down view of the current floor (the
// outdoor site plan or a block floor) with walking, collision, block
// entrances (portals), floor changes through each block's stairs/lift core,
// interaction (E), a first-person raycaster (V), minimap and HUD.
//
// export createWorld({ canvas, state, actions }) -> { update(dtSec), render(), resize() }
import { bus } from '../bus.js';
import { FLOORS, CAMERAS, PANELS, EQUIPMENT, ROOMS, ROOM_BY_ID, BLOCKS, BLOCK_BY_ID, PORTALS, SITE, TILE, COLS, ROWS, tileAt, isWalkable, roomAt, portalAt } from '../building.js';
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { getFloorArt, MINI_PPT, WALL_H } from './art.js';
import { blockGeom } from './campus.js';
import { daylight, dusk, roomLight, lightFromDark } from './lighting.js';
import { createPeopleTracker, lerpAngle, personColor, hexToRgb, ROLE_COLORS, PLAYER_COLOR } from './people.js';
import { drawTopDown } from './topdown.js';
import { createFP } from './fp.js';
import { createHud } from './hud.js';
import { createXray } from './xray.js';
import { createWasteWatch } from './waste.js';
import { floorCircuits, campusFeeders, strokeFlow, wireWidth, WIRE, TRUNK_Y, DB_POS } from './wiring.js';

const WALK = 6.0, RUN = 11.0, FP_WALK = 5.2, FP_RUN = 9.0, TURN = 3.2;
const RADIUS = 0.26;
const ZOOM_MIN = 12, ZOOM_MAX = 72;
const INTERACT_RANGE = 2.0;
const CORE_SPOT = { x: 47.5, y: 6.5 };
const CAMPUS_SPOT = { x: 25.5, y: 25.5 };
const storeyLabel = (f) => (f.isRoof ? 'R' : f.storey === 0 ? 'G' : String(f.storey));

// Rooms per floor, for the campus kW badges and lit windows.
const ROOMS_BY_FLOOR = new Map();
for (const r of ROOMS) {
  if (!ROOMS_BY_FLOOR.has(r.floor)) ROOMS_BY_FLOOR.set(r.floor, []);
  ROOMS_BY_FLOOR.get(r.floor).push(r);
}
const MOVE = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

const strHash = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

export function createWorld({ canvas, state, actions = {} }) {
  const ctx = canvas.getContext('2d');
  const hudRoot = document.getElementById('world-hud') || canvas.parentElement || document.body;
  const lightCv = document.createElement('canvas');
  const lightCtx = lightCv.getContext('2d');
  const tracker = createPeopleTracker();
  const fp = createFP();
  const fpInset = createFP();      // front-view window shown over the top-down map
  const xray = createXray();
  const waste = createWasteWatch({ state, actions });

  if (!state.player) state.player = { floor: 0, x: 6, y: 14, dir: 0, moving: false };
  if (!state.ui) state.ui = {};
  const P = state.player;
  if (!Number.isFinite(P.dir)) P.dir = 0;

  let W = 1, H = 1, dpr = 1;
  const view = { mode: 'top', z: 30, cx: P.x, cy: P.y, minimap: true, help: false, wiring: false, front: true, frontMin: false };
  let frontBtn = null;             // screen rect of the front-view minimise/expand button
  let drag = null, xrayHover = null, frameDt = 0;
  const keys = new Set();
  const taps = new Set();           // keys pressed and released between two frames still move once
  const pressedAt = new Map();      // a tap keeps its key held for at least MIN_HOLD ms
  let time = 0, fadeIn = 0, trans = null, playerPhase = 0, playerMoving = 0;
  let target = null, hoverRoomId = null, hoverPick = null, lastFloor = P.floor, teleportSeen = false;
  let dl = 1;
  const lights = new Map();
  let corridorLight = { dark: 0, lit: false };

  const hud = createHud({
    root: hudRoot,
    onFloor: (level) => {
      if (level === P.floor || trans || !FLOORS[level]) return;
      const target = FLOORS[level];
      if (target.isCampus) { goBlock('CAMPUS'); focusCanvas(); return; }
      const ok = !FLOORS[P.floor].isCampus && canStand(level, P.x, P.y);
      goFloor(level, ok ? P.x : CORE_SPOT.x, ok ? P.y : CORE_SPOT.y, target.name);
      focusCanvas();
    },
    onBlock: (id) => { goBlock(id); focusCanvas(); },
    onMiniClick: (tx, ty) => {
      const p = findWalkable(P.floor, tx, ty);
      doTeleport(P.floor, p.x, p.y);
      focusCanvas();
    },
    onToggleHelp: (on) => { view.help = on; },
    onWaste: (id) => { goRoom(id); focusCanvas(); },
  });
  const miniCtx = hud.miniCanvas.getContext('2d');

  // ------------------------------------------------------------ helpers
  function focusCanvas() { try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ } }

  function typing() {
    const a = document.activeElement;
    if (!a) return false;
    const t = a.tagName;
    return t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || a.isContentEditable;
  }
  function worldFocused() {
    const a = document.activeElement;
    return !a || a === document.body || a === canvas || hudRoot.contains(a);
  }

  function canStand(level, x, y) {
    return isWalkable(level, x - RADIUS, y - RADIUS) && isWalkable(level, x + RADIUS, y - RADIUS) &&
      isWalkable(level, x - RADIUS, y + RADIUS) && isWalkable(level, x + RADIUS, y + RADIUS);
  }

  function findWalkable(level, x, y) {
    if (canStand(level, x, y)) return { x, y };
    for (let r = 0.5; r <= 8; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2;
        const nx = x + Math.cos(a) * r, ny = y + Math.sin(a) * r;
        if (canStand(level, nx, ny)) return { x: nx, y: ny };
      }
    }
    return FLOORS[level] && FLOORS[level].isCampus ? { ...CAMPUS_SPOT } : { ...CORE_SPOT };
  }

  function onCore() { return tileAt(P.floor, P.x, P.y) === TILE.CORE; }

  function doTeleport(level, x, y) {
    teleportSeen = false;
    if (typeof actions.teleport === 'function') actions.teleport(level, x, y);
    else Object.assign(P, { floor: level, x, y });
    if (!teleportSeen) onTeleport();
  }

  function onTeleport() {
    teleportSeen = true;
    if (!FLOORS[P.floor]) P.floor = 0;
    if (!Number.isFinite(P.x) || !Number.isFinite(P.y) || !canStand(P.floor, P.x, P.y)) {
      const p = findWalkable(P.floor, Number(P.x) || CORE_SPOT.x, Number(P.y) || CORE_SPOT.y);
      P.x = p.x; P.y = p.y;
    }
    const far = Math.hypot(P.x - view.cx, P.y - view.cy) > 4;
    if (P.floor !== lastFloor || far) fadeIn = 1;
    lastFloor = P.floor;
    view.cx = P.x; view.cy = P.y;
    clampCamera(true);
  }
  bus.on('player:teleport', onTeleport);

  let banner = null, bannerSub = null;
  // After going through an entrance, portals stay disarmed until the player
  // lets go of the movement keys or walks a little way from the arrival
  // point, so holding a key does not bounce straight back out.
  let portalArmed = true, arrivedAt = null;
  function goFloor(level, x, y, title, dir) {
    if (trans || !FLOORS[level]) return;
    trans = { t: 0, dur: 0.22, level, x, y, dir };
    banner = title || FLOORS[level].name;
    bannerSub = FLOORS[level].isCampus ? 'NEW HORIZON COLLEGE OF ENGINEERING' : `NHCE  ·  ${FLOORS[level].name.toUpperCase()}`;
  }

  // Walk through a block entrance (either direction).
  function enterPortal(pa) {
    if (!pa || trans) return;
    const b = BLOCK_BY_ID[pa.portal.blockId];
    const a = pa.arrive;
    const src = pa.to === 'inside' ? pa.portal.outside : pa.portal.inside;
    const dir = pa.to === 'inside' ? 0 : Math.atan2(a.y - (src.y + 0.5), a.x - (src.x + 0.5));
    goFloor(a.floor, a.x, a.y, pa.to === 'inside' ? `Entering ${b ? b.name : 'block'}` : 'NHCE Campus', dir);
    portalArmed = false;
    arrivedAt = { floor: a.floor, x: a.x, y: a.y };
  }

  // Block picker / Campus button.
  function goBlock(id) {
    if (trans) return;
    const cur = FLOORS[P.floor];
    if (id === 'CAMPUS') {
      if (cur.isCampus) return;
      const portal = PORTALS.find((p) => p.blockId === cur.blockId);
      const a = portal ? portal.outsideArrive : { floor: 0, ...CAMPUS_SPOT };
      goFloor(a.floor, a.x, a.y, 'NHCE Campus', Math.PI / 2);
      return;
    }
    const portal = PORTALS.find((p) => p.blockId === id);
    if (!portal) return;
    if (cur.blockId === id && cur.storey === 0) return;
    const a = portal.insideArrive;
    goFloor(a.floor, a.x, a.y, `Entering ${BLOCK_BY_ID[id].name}`, 0);
  }

  function floorStep(d) {
    if (trans) return;
    const f = FLOORS[P.floor];
    if (f.isCampus) { hud.flash('Walk into a block entrance to go inside, then use its stairs or lift'); return; }
    const tgt = d > 0 ? f.up : f.down;
    if (tgt == null) {
      hud.flash(d > 0 ? `No floor above ${f.floorName} in this block`
        : 'This is the ground floor. Leave by the EXIT TO CAMPUS door at the west end of the corridor');
      return;
    }
    if (!onCore()) { hud.flash('Walk to the Stairs & Lift core at the east end of the corridor to change floor'); return; }
    goFloor(tgt, P.x, P.y, FLOORS[tgt].name);
  }

  function setZoom(z) { view.z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }

  function sameSpace(x, y) {
    const a = roomAt(P.floor, P.x, P.y), b = roomAt(P.floor, x, y);
    return !a || !b || a.id === b.id;
  }

  function findTarget() {
    const f = P.floor;
    let best = null, bestScore = INTERACT_RANGE;
    const fx = Math.cos(P.dir), fy = Math.sin(P.dir);
    const consider = (kind, id, x, y, label) => {
      const dx = x - P.x, dy = y - P.y;
      const d = Math.hypot(dx, dy);
      if (d > INTERACT_RANGE || !sameSpace(x, y)) return;
      const facing = d > 0.01 ? (dx * fx + dy * fy) / d : 1;
      const score = d - (view.mode === 'fp' ? facing * 0.6 : facing * 0.15);
      if (score < bestScore) { bestScore = score; best = { kind, id, x, y, label }; }
    };
    for (const c of CAMERAS) if (c.floor === f) consider('camera', c.id, c.x, c.y, `View camera ${c.id}`);
    for (const p of PANELS) if (p.floor === f) consider('panel', p.id, p.x, p.y, `Open AR Panel Lens ${p.id}`);
    for (const e of EQUIPMENT) if (e.floor === f && e.x != null) consider('equipment', e.id, e.x, e.y, `Inspect ${e.name}`);
    for (const pt of PORTALS) {
      const b = BLOCK_BY_ID[pt.blockId];
      if (pt.outside.floor === f) consider('portal', pt.blockId, pt.outside.x + 0.5, pt.outside.y + 0.5, `Enter ${b ? b.name : pt.blockId}`);
      if (pt.inside.floor === f) consider('portal', pt.blockId, pt.inside.x + 0.5, pt.inside.y + 0.5, 'Exit to NHCE Campus');
    }
    if (!best) {
      const r = roomAt(f, P.x, P.y);
      if (r && ROOM_BY_ID[r.id]) best = { kind: 'room', id: r.id, x: null, y: null, label: `Inspect ${r.name}` };
    }
    return best;
  }

  function activate(t) {
    if (!t) return;
    if (t.kind === 'camera' && actions.openCamera) actions.openCamera(t.id);
    else if (t.kind === 'panel' && actions.openLens) actions.openLens(t.id);
    else if (t.kind === 'equipment' && actions.inspect) actions.inspect('equipment', t.id);
    else if (t.kind === 'room' && actions.inspect) actions.inspect('room', t.id);
    else if (t.kind === 'portal') {
      const pt = PORTALS.find((p) => p.blockId === t.id);
      if (!pt) return;
      const goIn = FLOORS[P.floor].isCampus;
      enterPortal({ portal: pt, to: goIn ? 'inside' : 'outside', arrive: goIn ? pt.insideArrive : pt.outsideArrive });
    } else if (t.kind === 'block') goBlock(t.id);
  }

  function toggleView() {
    view.mode = view.mode === 'fp' ? 'top' : 'fp';
    hud.flash(view.mode === 'fp' ? 'First-person view: Up/Down walk, Left/Right turn, V to exit' : 'Top-down view', 1.6);
  }
  function toggleXray() {
    view.mode = view.mode === 'xray' ? 'top' : 'xray';
    hud.flash(view.mode === 'xray' ? 'X-ray view: drag to orbit, wheel to zoom, L for wiring, X to exit' : 'Top-down view', 2);
  }
  function toggleWiring() {
    view.wiring = !view.wiring;
    hud.flash(view.wiring ? 'Wiring on: amber lighting, teal fans/AC/sockets, red feeds a lit empty room' : 'Wiring hidden', 2.2);
  }

  // Jump into a room (used by the waste list).
  function goRoom(id) {
    const r = ROOM_BY_ID[id];
    if (!r || trans) return;
    const p = findWalkable(r.floor, r.x + r.w / 2, r.y + r.h / 2);
    if (r.floor === P.floor) doTeleport(r.floor, p.x, p.y);
    else goFloor(r.floor, p.x, p.y, r.name);
  }

  // ------------------------------------------------------------ input
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    const modal = state.ui && state.ui.modal;
    if (modal) return;                         // the modal owner handles Escape
    const code = e.code, key = e.key;
    const focused = worldFocused();
    if (MOVE[code]) { if (!e.repeat) pressedAt.set(code, performance.now()); keys.add(code); taps.add(code); if (focused) e.preventDefault(); return; }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { keys.add('Shift'); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (code === 'Space') { if (focused) e.preventDefault(); return; }
    if (key === '?' || code === 'KeyH') { if (!e.repeat) view.help = !view.help; e.preventDefault(); return; }
    if (code === 'Escape') { if (view.help) { view.help = false; e.preventDefault(); } return; }
    if (code === 'PageUp' || key === ']') { e.preventDefault(); if (!e.repeat) floorStep(1); return; }
    if (code === 'PageDown' || key === '[') { e.preventDefault(); if (!e.repeat) floorStep(-1); return; }
    if (code === 'KeyE' || (code === 'Enter' && focused) || code === 'NumpadEnter') {
      if (!e.repeat) activate(target);
      e.preventDefault(); return;
    }
    if (code === 'KeyV') { if (!e.repeat) toggleView(); return; }
    if (code === 'KeyX') { if (!e.repeat) toggleXray(); return; }
    if (code === 'KeyL') { if (!e.repeat) toggleWiring(); return; }
    if (view.mode === 'xray' && (code === 'Comma' || code === 'Period')) { xray.rotate(code === 'Comma' ? 0.12 : -0.12); e.preventDefault(); return; }
    if (code === 'KeyM') { if (!e.repeat) view.minimap = !view.minimap; return; }
    if (code === 'KeyF') { if (!e.repeat) { view.front = !view.front; hud.flash(view.front ? 'Front view on' : 'Front view hidden', 1.2); } return; }
    if (key === '+' || key === '=' || code === 'NumpadAdd') { setZoom(view.z * 1.15); return; }
    if (key === '-' || key === '_' || code === 'NumpadSubtract') { setZoom(view.z / 1.15); return; }
  });
  window.addEventListener('keyup', (e) => {
    if (MOVE[e.code]) {
      const code = e.code;
      const left = 120 - (performance.now() - (pressedAt.get(code) || 0));
      if (left > 0) setTimeout(() => { if (pressedAt.get(code) <= performance.now() - 119) keys.delete(code); }, left);
      else keys.delete(code);
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.delete('Shift');
  });
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('mousedown', (ev) => {
    focusCanvas();
    if (view.mode === 'xray' && ev.button === 0) drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = ev.clientX; drag.y = ev.clientY;
    if (view.mode === 'xray') xray.orbit(dx, dy);
  });
  window.addEventListener('mouseup', () => { setTimeout(() => { drag = null; }, 0); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (view.mode === 'xray') { xray.zoom(Math.exp(e.deltaY * 0.0012)); return; }
    if (view.mode !== 'top') return;
    setZoom(view.z * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  function xrayPick(ev) {
    const r = canvas.getBoundingClientRect();
    return xray.pick(ev.clientX - r.left, ev.clientY - r.top);
  }

  function frontHit(ev) {
    if (!view.front || !frontBtn) return false;
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    return mx >= frontBtn.x && mx <= frontBtn.x + frontBtn.w && my >= frontBtn.y && my <= frontBtn.y + frontBtn.h;
  }

  function screenToTile(ev) {
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    return { x: (mx - W / 2) / view.z + view.cx, y: (my - H / 2) / view.z + view.cy };
  }
  function pick(ev) {
    const { x, y } = screenToTile(ev);
    const f = P.floor;
    const near = (px, py, rad) => Math.hypot(px - x, py - y) <= rad;
    const camR = Math.max(0.55, 11 / view.z);
    for (const c of CAMERAS) if (c.floor === f && near(c.x, c.y, camR)) return { kind: 'camera', id: c.id };
    for (const e of EQUIPMENT) if (e.floor === f && e.x != null && near(e.x, e.y, Math.max(0.6, 10 / view.z))) return { kind: 'equipment', id: e.id };
    for (const p of PANELS) if (p.floor === f && (near(p.x, p.y, 0.9) || near(p.x, p.y - 0.65, 0.9))) return { kind: 'panel', id: p.id };
    const room = roomAt(f, x, y);
    if (room && ROOM_BY_ID[room.id]) return { kind: 'room', id: room.id };
    if (FLOORS[f].isCampus) {
      for (const b of BLOCKS) {
        const gm = blockGeom(b.id);
        if (!gm) continue;
        const fp = gm.fp;
        if (x >= fp.x && x < fp.x + fp.w && y >= fp.y - gm.H && y < fp.y + fp.h) return { kind: 'block', id: b.id };
      }
    }
    return null;
  }
  canvas.addEventListener('click', (ev) => {
    if (view.mode === 'xray') {
      if (drag && drag.moved > 5) return;
      const hit = xrayPick(ev);
      if (hit && hit.kind === 'room' && actions.inspect) actions.inspect('room', hit.id);
      else if (hit && hit.kind === 'block') goBlock(hit.id);
      return;
    }
    if (view.mode !== 'top') return;
    if (frontHit(ev)) { view.frontMin = !view.frontMin; return; }
    activate(pick(ev));
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (view.mode === 'xray') {
      const dragging = drag && drag.moved > 5;
      xrayHover = dragging ? null : xrayPick(ev);
      canvas.style.cursor = dragging ? 'grabbing' : xrayHover ? 'pointer' : 'grab';
      return;
    }
    if (view.mode !== 'top') { canvas.style.cursor = ''; hoverRoomId = null; return; }
    if (frontHit(ev)) { hoverPick = null; hoverRoomId = null; canvas.style.cursor = 'pointer'; return; }
    hoverPick = pick(ev);
    hoverRoomId = hoverPick && hoverPick.kind === 'room' ? hoverPick.id : null;
    canvas.style.cursor = hoverPick ? 'pointer' : '';
  });
  canvas.addEventListener('mouseleave', () => { hoverRoomId = null; hoverPick = null; });

  // ------------------------------------------------------------ sizing
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    // The darkness map is low-frequency: render it at half resolution.
    const lw = Math.max(1, Math.round(W * dpr * 0.5)), lh = Math.max(1, Math.round(H * dpr * 0.5));
    if (lightCv.width !== lw || lightCv.height !== lh) { lightCv.width = lw; lightCv.height = lh; }
    const ms = MINI_PPT * dpr;
    const mw = Math.round(COLS * ms), mh = Math.round(ROWS * ms);
    if (hud.miniCanvas.width !== mw || hud.miniCanvas.height !== mh) { hud.miniCanvas.width = mw; hud.miniCanvas.height = mh; }
    clampCamera(true);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(canvas);

  function clampCamera(snap) {
    const vw = W / view.z, vh = H / view.z;
    const art = FLOORS[P.floor] ? getFloorArt(P.floor, dpr) : null;
    const x0 = art ? art.x0 : -1, x1 = art ? art.x1 : COLS + 1;
    const y0 = (art ? art.y0 : -1) - WALL_H, y1 = art ? art.y1 : ROWS + 1;
    let tx = P.x, ty = P.y;
    if (vw >= x1 - x0) tx = (x0 + x1) / 2; else tx = Math.max(x0 + vw / 2, Math.min(x1 - vw / 2, tx));
    if (vh >= y1 - y0) ty = (y0 + y1) / 2; else ty = Math.max(y0 + vh / 2, Math.min(y1 - vh / 2, ty));
    if (snap) { view.cx = tx; view.cy = ty; }
    return { tx, ty };
  }

  // ------------------------------------------------------------ update
  function move(dx, dy) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.15));
    const sx = dx / n, sy = dy / n;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (sx) {
        if (canStep(P.x + sx, P.y)) { P.x += sx; moved += Math.abs(sx); }
        else moved += slide('x', sx);
      }
      if (sy) {
        if (canStep(P.x, P.y + sy)) { P.y += sy; moved += Math.abs(sy); }
        else moved += slide('y', sy);
      }
    }
    return moved;
  }

  // Player step test: a disarmed entrance tile blocks like a wall, so the
  // player stops at the threshold instead of bouncing back through it.
  function canStep(x, y) {
    if (!canStand(P.floor, x, y)) return false;
    return portalArmed || !portalAt(P.floor, x, y) || !!portalAt(P.floor, P.x, P.y);
  }

  // Door assist: when blocked, slide sideways toward an opening that lies
  // just ahead, so 1-tile doorways are easy to hit with the keyboard.
  function slide(axis, step) {
    const ahead = (axis === 'x' ? P.x : P.y) + Math.sign(step) * (RADIUS + 0.3);
    const lat = axis === 'x' ? P.y : P.x;
    const base = Math.floor(lat);
    const cands = [0, -1, 1].map((o) => base + o + 0.5).sort((m, n) => Math.abs(m - lat) - Math.abs(n - lat));
    for (const c of cands) {
      if (Math.abs(c - lat) > 1.3) continue;
      const free = axis === 'x' ? isWalkable(P.floor, ahead, c) : isWalkable(P.floor, c, ahead);
      if (!free) continue;
      const d = Math.sign(c - lat) * Math.min(Math.abs(c - lat), Math.abs(step));
      if (!d) return 0;
      if (axis === 'x' && canStep(P.x, P.y + d)) { P.y += d; return Math.abs(d); }
      if (axis === 'y' && canStep(P.x + d, P.y)) { P.x += d; return Math.abs(d); }
      return 0;
    }
    return 0;
  }

  function update(dtSec) {
    const dt = Math.max(0, Math.min(Number(dtSec) || 0, 0.1));
    time += dt;
    frameDt = dt;
    waste.update();
    if (P.floor !== lastFloor) onTeleport();       // someone else moved the player
    if ((state.ui && state.ui.modal) || typing()) { keys.clear(); taps.clear(); }

    tracker.update(state.people, dt);

    if (trans) {
      trans.t += dt;
      if (trans.t >= trans.dur) {
        const { level, x, y, dir } = trans;
        trans = null;
        const p = findWalkable(level, x, y);
        if (Number.isFinite(dir)) P.dir = dir;
        doTeleport(level, p.x, p.y);
      }
    }
    fadeIn = Math.max(0, fadeIn - dt / 0.35);

    // Movement
    const held = { up: false, down: false, left: false, right: false };
    for (const k of keys) if (MOVE[k]) held[MOVE[k]] = true;
    for (const k of taps) if (MOVE[k]) held[MOVE[k]] = true;
    taps.clear();
    const mdt = dt;
    const run = keys.has('Shift');
    let moved = 0;
    if (!trans) {
      if (view.mode === 'top' || view.mode === 'xray') {
        let ix = (held.right ? 1 : 0) - (held.left ? 1 : 0);
        let iy = (held.down ? 1 : 0) - (held.up ? 1 : 0);
        if (view.mode === 'xray' && (ix || iy)) {
          // Walk relative to the orbit camera: Up always moves away from you on screen.
          const c = Math.cos(xray.yaw), s = Math.sin(xray.yaw);
          [ix, iy] = [ix * c + iy * s, -ix * s + iy * c];
        }
        if (ix || iy) {
          const len = Math.hypot(ix, iy);
          const sp = (run ? RUN : WALK) * mdt;
          P.dir = lerpAngle(P.dir, Math.atan2(iy, ix), Math.min(1, dt * 16));
          moved = move(ix / len * sp, iy / len * sp);
        }
      } else {
        const turn = (held.right ? 1 : 0) - (held.left ? 1 : 0);
        P.dir += turn * TURN * mdt * (run ? 1.3 : 1);
        const fwd = (held.up ? 1 : 0) - (held.down ? 1 : 0);
        if (fwd) {
          const sp = (run ? FP_RUN : FP_WALK) * mdt * fwd * (fwd < 0 ? 0.7 : 1);
          moved = move(Math.cos(P.dir) * sp, Math.sin(P.dir) * sp);
        }
      }
    }
    if (P.dir > Math.PI) P.dir -= Math.PI * 2;
    if (P.dir < -Math.PI) P.dir += Math.PI * 2;
    P.moving = moved > 0.0005;
    if (!portalArmed && !trans) {
      const anyHeld = held.up || held.down || held.left || held.right;
      const away = !arrivedAt || arrivedAt.floor !== P.floor || Math.hypot(P.x - arrivedAt.x, P.y - arrivedAt.y) > 1.2;
      if (!anyHeld || away) portalArmed = true;
    }
    if (P.moving && !trans && portalArmed) {
      const pa = portalAt(P.floor, P.x, P.y);
      if (pa) enterPortal(pa);
    }
    playerPhase += Math.min(moved, 0.3) * 9;
    playerMoving = P.moving ? 1 : Math.max(0, playerMoving - dt * 6);

    // Camera follow
    const { tx, ty } = clampCamera(false);
    const k = 1 - Math.exp(-dt * 9);
    view.cx += (tx - view.cx) * k;
    view.cy += (ty - view.cy) * k;

    // Lighting for the current floor
    const floor = FLOORS[P.floor];
    dl = daylight(state.t);
    for (const r of floor.rooms) lights.set(r.id, roomLight(state, r, dl, floor));
    corridorLight = roomLight(state, floor.corridor, dl, floor);
    if (floor.isCampus) {
      blockTimer -= dt;
      if (blockTimer <= 0) { blockTimer = 0.25; computeBlockInfo(); }
    }

    target = trans ? null : findTarget();
    updateHud(floor);
  }

  let blockTimer = 0;
  const blockInfo = {};
  function computeBlockInfo() {
    const rs = state.rooms || {};
    for (const b of BLOCKS) {
      const gm = blockGeom(b.id);
      let kw = 0, lit = 0, n = 0;
      const storeyLit = [];
      for (const fi of b.floors) {
        let fl = 0, fn = 0;
        for (const r of ROOMS_BY_FLOOR.get(fi) || []) {
          const s = rs[r.id];
          if (s && Number.isFinite(Number(s.loadKW))) kw += Number(s.loadKW);
          if (r.type === 'core' || r.type === 'electrical' || r.type === 'roof' || r.type === 'plant') continue;
          fn++; if (s && s.lightsOn) fl++;
        }
        n += fn; lit += fl;
        if (gm && gm.storeyFloors.includes(fi)) storeyLit.push(fn ? fl / fn : 0);
      }
      blockInfo[b.id] = { kw, lit: n ? lit / n : 0, storeyLit };
    }
  }

  function updateHud(floor) {
    const here = roomAt(P.floor, P.x, P.y);
    let roomName = 'Doorway', roomStat = '', roomDot = 'dim';
    if (here) {
      roomName = here.name;
      if (here.id && here.id.startsWith('COR-')) {
        roomStat = floor.isCampus ? `Outdoors  ·  ${SITE.road}` : floor.isRoof ? 'Open roof walkway' : corridorLight.lit ? 'Corridor lights on' : 'Daylight';
        roomDot = 'lit';
      } else {
        const li = lights.get(here.id);
        const s = (li && li.s) || {};
        const parts = [];
        parts.push(li && li.lit ? 'Lights on' : li && li.autoOff ? 'AUTO-OFF' : li && li.manualOff ? 'Manual OFF' : 'Lights off');
        const occ = Number(s.occupancy);
        if (here.seats > 0 || occ > 0) parts.push(`${Number.isFinite(occ) ? occ : 0} ppl`);
        if (s.detected != null && here.camera) parts.push(`cam ${s.detected}`);
        if (here.loads && here.loads.acKW > 0 && Number.isFinite(Number(s.tempC))) parts.push(`${Number(s.tempC).toFixed(1)} C${s.acOn ? ' AC' : ''}`);
        if (Number.isFinite(Number(s.loadKW))) parts.push(`${Number(s.loadKW).toFixed(1)} kW`);
        if (li && li.camOffline) parts.push('camera offline');
        roomStat = parts.join('  ·  ');
        roomDot = li && li.lit ? 'lit' : li && (li.autoOff || li.manualOff) ? 'off' : 'dim';
      }
    }
    const phase = dl >= 0.98 ? 'Day' : dl <= 0.02 ? 'Night' : (minuteOfDay(state.t) < 720 ? 'Dawn' : 'Dusk');
    const block = BLOCK_BY_ID[floor.blockId];
    const floorButtons = [];
    if (block) for (let i = block.floors.length - 1; i >= 0; i--) {
      const f = FLOORS[block.floors[i]];
      floorButtons.push({ level: f.level, label: storeyLabel(f), title: f.name });
    }
    floorButtons.push({ level: 0, label: 'Campus', title: 'NHCE campus site plan', campus: true });
    hud.update({
      fp: view.mode === 'fp',
      mode: view.mode,
      wiring: view.wiring,
      waste: waste.list,
      wasteTotals: waste.totals,
      level: P.floor,
      blockId: floor.isCampus ? 'CAMPUS' : floor.blockId,
      blockLabel: floor.isCampus ? 'NHCE CAMPUS' : `NHCE  ·  ${block ? block.name.toUpperCase() : ''}`,
      floorButtons,
      floorName: floor.isCampus ? 'Campus site plan' : `${block ? block.name : ''} · ${floor.floorName}`,
      roomName, roomStat, roomDot,
      clock: `${fmtTime(minuteOfDay(Number(state.t) || 0))}  Day ${state.day || 1}  ${phase}`,
      miniOn: view.minimap,
      helpOn: view.help,
    });
  }

  // ------------------------------------------------------------ render
  function render() {
    const r = canvas.getBoundingClientRect();
    if (Math.abs(r.width - W) > 0.5 || Math.abs(r.height - H) > 0.5 || (window.devicePixelRatio || 1) !== dpr) resize();
    const level = P.floor;
    const floor = FLOORS[level];
    if (!floor) return;
    const art = getFloorArt(level, dpr);
    if (lights.size === 0 || !lights.has(floor.rooms[0].id)) {
      dl = daylight(state.t);
      for (const rm of floor.rooms) lights.set(rm.id, roomLight(state, rm, dl, floor));
      corridorLight = roomLight(state, floor.corridor, dl, floor);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    let promptPos;
    if (view.mode === 'xray') {
      xray.render(ctx, W, H, { state, level, player: P, time, dt: frameDt, wiring: view.wiring, waste, dl, hover: xrayHover });
      promptPos = { x: W / 2, y: H - 64 };
    } else if (view.mode === 'fp') {
      fp.render(ctx, W, H, fpInfo(level, floor));
      drawFpWaste();
      promptPos = { x: W / 2, y: H - 64 };
    } else {
      const { X, Y } = drawTopDown({
        ctx, lightCtx, lightCv, lightScale: dpr * 0.5, W, H, dpr, z: view.z, cx: view.cx, cy: view.cy, level, time, state, art, tracker,
        lights, corridorLight, dl, duskAmt: dusk(dl), hoverRoomId, target, player: P, playerPhase, playerMoving, blockInfo,
      });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      drawTopOverlays(X, Y, floor);
      if (view.front) drawFrontView(level, floor);
      promptPos = { x: X(P.x), y: Y(P.y) - Math.max(view.z, 12) * 0.75 - 18 };
    }

    // Fade for floor changes / teleports, with the floor name.
    const fadeOut = trans ? Math.min(1, trans.t / trans.dur) : 0;
    const a = Math.max(fadeIn, fadeOut);
    if (a > 0.001) {
      ctx.fillStyle = `rgba(4,6,10,${Math.min(1, a)})`;
      ctx.fillRect(0, 0, W, H);
      if (fadeIn > 0.05) {
        ctx.globalAlpha = Math.min(1, fadeIn * 1.6);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = "600 12px 'JetBrains Mono', monospace";
        ctx.fillStyle = '#8a9bb0';
        ctx.fillText(bannerSub || 'NHCE', W / 2, H / 2 - 22);
        ctx.font = '700 28px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#e6edf5';
        ctx.fillText(banner || floor.name, W / 2, H / 2 + 8);
        ctx.globalAlpha = 1;
      }
    }

    // Prompt
    const lines = [];
    if (target && !(view.help)) {
      const cls = target.kind === 'room' ? ' class="sub"' : '';
      const keyHint = target.kind === 'portal' ? '<kbd>walk in</kbd> or <kbd>E</kbd>' : '<kbd>E</kbd>';
      lines.push(`<div${cls}>${keyHint} ${escapeHtml(target.label)}</div>`);
    }
    if (!trans && onCore()) {
      const up = floor.up != null ? `<kbd>PgUp</kbd> up to ${escapeHtml(FLOORS[floor.up].floorName)}` : '';
      const dn = floor.down != null ? `<kbd>PgDn</kbd> down to ${escapeHtml(FLOORS[floor.down].floorName)}` : '';
      lines.push(`<div>${[up, dn].filter(Boolean).join('&nbsp;&nbsp;')}</div>`);
    }
    hud.setPrompt(lines.join(''), Math.max(120, Math.min(W - 120, promptPos.x)), Math.max(60, promptPos.y));

    if (view.minimap) drawMinimap(art, level, floor);
  }

  // Red glow on lit empty rooms and the wiring layer, over the top-down art.
  function drawTopOverlays(X, Y, floor) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    const z = view.z;
    if (view.wiring) {
      if (floor.isCampus) {
        const cf = campusFeeders(state, waste);
        const sp = (pts) => pts.map((p) => [X(p.x), Y(p.y)]);
        strokeFlow(ctx, sp(cf.incomer.pts), { color: WIRE.feed, on: true, kW: cf.incomer.kW / 10, time, width: wireWidth(cf.incomer.kW / 8, 2) });
        for (const fd of cf.feeders) strokeFlow(ctx, sp(fd.pts), { color: fd.wasteRooms ? WIRE.waste : WIRE.feed, on: fd.kW > 0.05, kW: fd.kW / 4, time, width: wireWidth(fd.kW / 4, 1.5) });
      } else {
        const c = floorCircuits(floor, state, waste);
        strokeFlow(ctx, [[X(DB_POS.x), Y(DB_POS.y)], [X(DB_POS.x), Y(TRUNK_Y)], [X(c.minX), Y(TRUNK_Y)]], { color: WIRE.feed, on: c.kW > 0.05, kW: c.kW, time, width: wireWidth(c.kW, 2) });
        for (const b of c.branches) {
          strokeFlow(ctx, [[X(b.cx - 0.4), Y(TRUNK_Y)], [X(b.cx - 0.4), Y(b.cy)]], { color: b.waste ? WIRE.waste : WIRE.light, on: b.lightKW > 0, kW: b.lightKW * 4, time, width: wireWidth(b.lightKW, 1.2) });
          strokeFlow(ctx, [[X(b.cx + 0.4), Y(TRUNK_Y)], [X(b.cx + 0.4), Y(b.cy)]], { color: b.waste ? WIRE.waste : WIRE.power, on: b.powKW > 0.05, kW: b.powKW, time, width: wireWidth(b.powKW, 1.2) });
          ctx.fillStyle = b.waste ? `rgba(255,77,79,${0.6 + 0.4 * pulse})` : b.lightKW > 0 ? WIRE.light : WIRE.off;
          ctx.beginPath(); ctx.arc(X(b.cx - 0.4), Y(b.cy), Math.max(2.5, z * 0.12), 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    for (const r of floor.rooms) {
      const m = waste.minutes(r.id);
      if (m == null) continue;
      const x = X(r.x), y = Y(r.y), w = r.w * z, h = r.h * z;
      ctx.fillStyle = `rgba(255,50,50,${0.14 + 0.16 * pulse})`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = `rgba(255,90,90,${0.7 + 0.3 * pulse})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      const s = (state.rooms && state.rooms[r.id]) || {};
      const txt = `LIGHTS ON, EMPTY ${Math.floor(m)} min  ${(Number(s.loadKW) || 0).toFixed(1)} kW`;
      ctx.font = "700 10px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(txt).width + 10;
      if (tw < w + 20) {
        ctx.fillStyle = 'rgba(60,8,10,0.9)';
        ctx.fillRect(x + w / 2 - tw / 2, y + h - 22, tw, 16);
        ctx.fillStyle = '#ffa39e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, x + w / 2, y + h - 14);
      }
    }
  }

  // Front view: a first-person window in the corner of the top-down map,
  // looking the way the player walks, so doorways and rooms are seen as you
  // approach them.
  function drawFrontView(level, floor) {
    frontBtn = null;
    if (W < 640 || H < 360) return;
    const chevron = (bx, by, up) => {
      ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (up) { ctx.moveTo(bx + 6, by + 15); ctx.lineTo(bx + 11, by + 9); ctx.lineTo(bx + 16, by + 15); }
      else { ctx.moveTo(bx + 6, by + 9); ctx.lineTo(bx + 11, by + 15); ctx.lineTo(bx + 16, by + 9); }
      ctx.stroke();
    };
    if (view.frontMin) {
      const tw = 128, th = 24, tx = W - tw - 12, ty = H - th - 12;
      ctx.save();
      ctx.fillStyle = 'rgba(11,15,20,0.85)'; ctx.fillRect(tx, ty, tw, th);
      ctx.strokeStyle = 'rgba(245,179,1,0.55)'; ctx.lineWidth = 1; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
      ctx.font = "700 10px 'JetBrains Mono', monospace"; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillStyle = '#f5b301'; ctx.fillText('FRONT VIEW', tx + 8, ty + th / 2);
      chevron(tx + tw - 22, ty + 1, true);
      ctx.restore();
      frontBtn = { x: tx, y: ty, w: tw, h: th };
      return;
    }
    const iw = Math.round(Math.min(380, W * 0.34)), ih = Math.round(iw * 0.6);
    const x = W - iw - 12, y = H - ih - 12;
    ctx.save();
    ctx.fillStyle = 'rgba(11,15,20,0.85)';
    ctx.fillRect(x - 3, y - 3, iw + 6, ih + 6);
    ctx.beginPath(); ctx.rect(x, y, iw, ih); ctx.clip();
    ctx.translate(x, y);
    fpInset.render(ctx, iw, ih, fpInfo(level, floor));
    // Caption: where you are and what is ahead.
    const here = roomAt(level, P.x, P.y);
    const ahead = target ? target.label : here ? here.name : floor.name;
    ctx.fillStyle = 'rgba(11,15,20,0.78)';
    ctx.fillRect(0, ih - 22, iw, 22);
    ctx.font = "700 10px 'JetBrains Mono', monospace";
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#f5b301';
    ctx.fillText('FRONT VIEW', 8, ih - 11);
    ctx.font = "600 10px 'JetBrains Mono', monospace";
    ctx.fillStyle = '#e6edf5'; ctx.textAlign = 'right';
    let txt = ahead;
    while (txt.length > 4 && ctx.measureText(txt).width > iw - 96) txt = txt.slice(0, -2);
    ctx.fillText(txt === ahead ? txt : txt + '...', iw - 8, ih - 11);
    ctx.restore();
    ctx.strokeStyle = 'rgba(245,179,1,0.55)'; ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, iw + 1, ih + 1);
    // Minimise button (top-right corner of the window).
    ctx.fillStyle = 'rgba(11,15,20,0.78)'; ctx.fillRect(x + iw - 24, y, 24, 22);
    chevron(x + iw - 24, y, false);
    frontBtn = { x: x + iw - 24, y, w: 24, h: 22 };
  }

  // First-person: red vignette when you stand in a lit empty room.
  function drawFpWaste() {
    const here = roomAt(P.floor, P.x, P.y);
    const m = here ? waste.minutes(here.id) : null;
    if (m == null) return;
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(255,40,40,0)');
    g.addColorStop(1, `rgba(255,40,40,${0.25 + 0.2 * pulse})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.font = "700 13px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffa39e';
    ctx.fillText(`${here.name}: lights on, nobody here for ${Math.floor(m)} min`, W / 2, 92);
  }

  function fpInfo(level, floor) {
    const roomLights = floor.rooms.map((r) => {
      const li = lights.get(r.id);
      return { light: lightFromDark(li ? li.dark : 0.5), lit: !!(li && li.lit) };
    });
    const sprites = [];
    const people = Array.isArray(state.people) ? state.people : [];
    for (const p of people) {
      if (!p || p.floor !== level || !Number.isFinite(p.x)) continue;
      const d = Math.hypot(p.x - P.x, p.y - P.y);
      if (d > 30 || d < 0.2) continue;
      const tr = tracker.get(p.id);
      sprites.push({ kind: 'person', x: p.x, y: p.y, rgb: hexToRgb(personColor(p)), seated: !!p.seated, phase: tr ? tr.phase : 0, moving: p.seated ? false : tr ? tr.moving > 0.3 : !!p.moving, seed: strHash(p.id) });
    }
    const camS = state.cameras || {};
    for (const c of CAMERAS) if (c.floor === level) sprites.push({ kind: 'camera', x: c.x, y: c.y, online: !camS[c.id] || camS[c.id].online !== false });
    return {
      level, px: P.x, py: P.y, dir: P.dir, daylight: dl, roomLights,
      blockLit: BLOCKS.map((b) => (blockInfo[b.id] ? blockInfo[b.id].lit : 0)),
      corridorLight: lightFromDark(corridorLight.dark), corridorLit: !!corridorLight.lit, sprites,
    };
  }

  function drawMinimap(art, level, floor) {
    const mc = hud.miniCanvas;
    const s = mc.width / COLS;
    const g = miniCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.drawImage(art.mini, 0, 0, mc.width, mc.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    for (const r of floor.rooms) {
      const li = lights.get(r.id);
      if (!li || li.outdoor) continue;
      if (li.lit) { g.fillStyle = 'rgba(255,214,102,0.22)'; g.fillRect(r.x, r.y, r.w, r.h); }
      else if (li.autoOff || li.manualOff) { g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(r.x, r.y, r.w, r.h); }
    }
    const people = Array.isArray(state.people) ? state.people : [];
    for (const p of people) {
      if (!p || p.floor !== level || !Number.isFinite(p.x)) continue;
      g.fillStyle = ROLE_COLORS[p.role] || '#9fb3c8';
      g.fillRect(p.x - 0.4, p.y - 0.4, 0.8, 0.8);
    }
    const camS = state.cameras || {};
    for (const c of CAMERAS) {
      if (c.floor !== level) continue;
      g.fillStyle = camS[c.id] && camS[c.id].online === false ? '#ff4d4f' : '#40a9ff';
      g.fillRect(c.x - 0.5, c.y - 0.5, 1, 1);
    }
    if (view.mode === 'top') {
      const vw = W / view.z, vh = H / view.z;
      g.strokeStyle = 'rgba(230,237,245,0.45)'; g.lineWidth = 1 / s;
      g.strokeRect(view.cx - vw / 2, view.cy - vh / 2, vw, vh);
    } else {
      g.fillStyle = 'rgba(245,179,1,0.25)';
      g.beginPath(); g.moveTo(P.x, P.y); g.arc(P.x, P.y, 7, P.dir - 0.6, P.dir + 0.6); g.closePath(); g.fill();
    }
    if (floor.isCampus) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.font = `700 ${Math.round(8 * dpr)}px 'JetBrains Mono', monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(230,237,245,0.85)';
      for (const b of BLOCKS) {
        const fp = b.footprint;
        if (fp) g.fillText(b.short, (fp.x + fp.w / 2) * s, (fp.y + fp.h / 2) * s);
      }
      g.setTransform(s, 0, 0, s, 0, 0);
    }
    g.fillStyle = PLAYER_COLOR;
    g.beginPath(); g.arc(P.x, P.y, 0.95, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#0b0f14'; g.lineWidth = 0.35; g.stroke();
    g.strokeStyle = PLAYER_COLOR; g.lineWidth = 0.45;
    g.beginPath(); g.moveTo(P.x, P.y); g.lineTo(P.x + Math.cos(P.dir) * 2.2, P.y + Math.sin(P.dir) * 2.2); g.stroke();
  }

  setTimeout(focusCanvas, 0);
  resize();
  onTeleport();
  fadeIn = 0;

  return { update, render, resize };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
