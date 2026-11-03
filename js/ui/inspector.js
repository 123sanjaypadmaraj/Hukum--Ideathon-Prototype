// Inspector modal for a room or a piece of equipment: live details + controls.
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { h, setText, setClass, segmented, fmtKW, fmtPct, safe, isNum } from './util.js';
import { FLOORS, blockName, ROOM_BY_ID, EQUIPMENT_BY_ID, PANELS, roomState, equipState, roomPower, cameraForRoom, roomCentre, floorShort } from './derive.js';
import { statusTone } from './equipment.js';

export function createInspector({ state, actions, modal, onLens }) {
  let open = false, refs = null;

  function field(label) {
    const v = h('b.num', '—');
    return { el: h('div.in-f', h('span', label), v), v };
  }

  function buildRoom(room) {
    const f = {
      occ: field('People inside'), det: field('Camera count'), power: field('Power'), temp: field('Temperature'),
      set: field('Setpoint'), load: field('Load now'), base: field('Baseline load'), save: field('Saving now'),
      sched: field('Class now'), last: field('Last seen'), flags: field('Running'), auto: field('Auto-off'),
    };
    const pill = h('span.pill', '');
    const seg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Force on' }, { value: 'off', label: 'Force off' }],
      (v) => actions.setRoomOverride(room.id, v === 'auto' ? null : v));
    const cam = room.camera;
    const panel = PANELS.find((p) => p.circuits.some((c) => c.roomId === room.id));
    const body = h('div.in-body',
      h('div.in-grid', Object.values(f).map((x) => x.el)),
      h('div.in-ctl', h('span.tile-l', 'Manual override'), seg.el),
      h('div.in-btns',
        h('button.btn.btn-accent', { type: 'button', onclick: () => { const c = roomCentre(room); actions.teleport(c.floor, c.x, c.y); close(); } }, 'Go to room'),
        cam ? h('button.btn', { type: 'button', onclick: () => { close(); actions.openCamera(cam.id); } }, 'View camera') : null,
        panel ? h('button.btn', { type: 'button', onclick: () => { close(); onLens(panel.id); } }, `Open ${panel.id} in AR Lens`) : null));
    return {
      title: room.name,
      sub: `${room.id} · ${room.type} · ${blockName(room.blockId)} · ${FLOORS[room.floor] ? FLOORS[room.floor].floorName || floorShort(room.floor) : ''}${room.seats ? ` · ${room.seats} seats` : ''}`,
      pill, body,
      update() {
        const rs = roomState(state, room.id);
        const c = cameraForRoom(state, room.id);
        const p = roomPower(state, room.id);
        setText(pill, p.label); pill.className = `pill p-${p.tone}`;
        setText(f.occ.v, String(safe(rs.occupancy)));
        setText(f.det.v, c ? (c.online ? String(isNum(rs.detected) ? rs.detected : c.count) : 'camera offline (fail-safe on)') : 'no camera');
        setClass(f.det.v, 'bad', c && !c.online);
        setText(f.power.v, rs.powered === false ? 'relay open' : 'relay closed');
        setText(f.temp.v, isNum(rs.tempC) ? `${rs.tempC.toFixed(1)} C` : '—');
        setText(f.set.v, isNum(rs.setpointC) ? `${rs.setpointC.toFixed(0)} C${rs.precool ? ' (pre-cool)' : ''}` : '—');
        setText(f.load.v, fmtKW(rs.loadKW));
        setText(f.base.v, fmtKW(rs.baselineLoadKW));
        setText(f.save.v, fmtKW(Math.max(0, safe(rs.baselineLoadKW) - safe(rs.loadKW))));
        const next = isNum(rs.nextClassAt) ? ` (next ${fmtTime(minuteOfDay(rs.nextClassAt))})` : '';
        setText(f.sched.v, rs.classLabel ? String(rs.classLabel) : room.timetabled ? (rs.scheduled ? 'class on now' : `no class now${next}`) : 'not timetabled');
        if (rs.failSafe) setText(f.power.v, 'held ON (fail-safe)');
        setText(f.last.v, isNum(rs.lastSeenT) && Number.isFinite(rs.lastSeenT) ? fmtTime(minuteOfDay(rs.lastSeenT)) : '—');
        const fl = [rs.lightsOn && 'lights', rs.fansOn && 'fans', rs.acOn && 'AC'].filter(Boolean);
        setText(f.flags.v, fl.length ? fl.join(', ') : 'nothing');
        setText(f.auto.v, room.autoOff ? (rs.powered === false && isNum(rs.offSince) ? `off since ${fmtTime(minuteOfDay(rs.offSince))}` : 'armed, 10 min') : 'never (critical)');
        seg.set(rs.override || 'auto');
      },
    };
  }

  function buildEquip(e) {
    const f = {
      kw: field('Power now'), status: field('Status'), flex: field('Flexible now'), rel: field('Reliability'),
      lvl: field(e.kind === 'pump' ? 'Tank level' : 'State of charge'), conn: field(e.kind === 'ev' || e.kind === 'ebus' ? 'Vehicle' : 'Rated'),
    };
    const pill = h('span.pill', '');
    const seg = e.kind === 'solar' ? null : segmented([{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Force on' }, { value: 'off', label: 'Force off' }],
      (v) => actions.setEquipmentOverride(e.id, v === 'auto' ? null : v));
    const hasPos = isNum(e.x) && isNum(e.y);
    const body = h('div.in-body',
      h('div.in-grid', Object.values(f).map((x) => x.el)),
      seg ? h('div.in-ctl', h('span.tile-l', 'Manual override'), seg.el) : null,
      h('div.in-btns', hasPos
        ? h('button.btn.btn-accent', { type: 'button', onclick: () => { actions.teleport(e.floor, e.x, e.y + 1.2); close(); } }, 'Go to it')
        : h('span.cp-note', 'Aggregated asset in other blocks & hostels, not on the campus map.')));
    return {
      title: e.name, sub: `${e.id} · ${e.kind} · rated ${fmtKW(e.ratedKW)}`, pill, body,
      update() {
        const s = equipState(state, e.id);
        setText(pill, s.status || 'idle'); pill.className = `pill ${statusTone(s.status)}`;
        setText(f.kw.v, e.kind === 'solar' ? `${fmtKW(Math.abs(safe(s.kW, 0)) || safe(state.energy && state.energy.solarKW))} generated` : fmtKW(s.kW));
        setText(f.status.v, s.status || 'idle');
        setText(f.flex.v, fmtKW(isNum(s.flexKW) ? s.flexKW : e.flexKW));
        setText(f.rel.v, fmtPct(s.reliability));
        setText(f.lvl.v, e.kind === 'pump' ? fmtPct(s.tankLevel) : fmtPct(s.soc));
        setText(f.conn.v, e.kind === 'ev' || e.kind === 'ebus' ? (s.connected ? 'plugged in' : 'none') : fmtKW(e.ratedKW));
        seg && seg.set(s.override || 'auto');
      },
    };
  }

  function show(type, id) {
    const item = type === 'room' ? ROOM_BY_ID[id] : EQUIPMENT_BY_ID[id];
    if (!item) return;
    refs = type === 'room' ? buildRoom(item) : buildEquip(item);
    const root = h('div.inspector', { role: 'dialog', 'aria-label': refs.title },
      h('div.in-h', h('div', h('div.tile-l', type === 'room' ? 'Room' : 'Equipment'), h('h2', refs.title), h('div.cell-sub', refs.sub)),
        h('div.in-hr', refs.pill, h('button.icon-btn.in-x', { type: 'button', title: 'Close (Esc)', onclick: close }, h('span.ic-x')))),
      refs.body);
    if (type === 'room' && state.ui) state.ui.focusRoom = id;
    modal.open('inspect', root, close);
    open = true;
    refs.update();
  }

  function close() {
    if (!open) return;
    open = false;
    refs = null;
    modal.close('inspect');
  }

  return {
    show, close, isOpen: () => open,
    update() { if (open && refs) refs.update(); },
  };
}
