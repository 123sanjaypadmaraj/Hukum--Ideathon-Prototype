// Rooms tab: block picker, floor sub-filter, search and sort over every room
// on campus; occupancy (true vs detected), power, temperature, saving, overrides.
import { h, setText, setClass, segmented, fmtKW, safe, isNum } from './util.js';
import { LIST_ROOMS, FLOORS, BLOCKS, roomState, roomPower, cameraForRoom, roomCentre, floorShort } from './derive.js';

const ROOM_LIST = LIST_ROOMS.filter((r) => r.type !== 'roof' && r.type !== 'plant');
const SORTS = [
  { value: 'waste', label: 'Most wasteful' },
  { value: 'occ', label: 'Most people' },
  { value: 'name', label: 'Name' },
];

const norm = (t) => String(t || '').toLowerCase().replace(/&/g, 'and');

export function createRooms({ state, actions, onInspect }) {
  const el = h('section.tab-panel.rm');
  let block = 'all', floor = 'all', query = '', sort = 'waste';

  // ----- block picker -----
  const blockSeg = segmented([
    { value: 'all', label: 'All' },
    ...BLOCKS.map((b) => ({ value: b.id, label: b.short, title: b.name })),
    { value: 'CAMPUS', label: 'Zones', title: 'Campus zones: gate, parking, sports' },
  ], (v) => { block = v; floor = 'all'; blockSeg.set(v); buildFloorSeg(); sig = ''; }, 'seg-sm');
  blockSeg.set('all');
  blockSeg.el.classList.add('rm-blocks');

  // ----- floor sub-filter -----
  const floorWrap = h('div.rm-floors');
  let floorSeg = null;
  function buildFloorSeg() {
    floorWrap.textContent = '';
    const b = BLOCKS.find((x) => x.id === block);
    if (!b) { setClass(floorWrap, 'hide', true); return; }
    setClass(floorWrap, 'hide', false);
    floorSeg = segmented([{ value: 'all', label: 'All floors' }, ...b.floors.map((i) => {
      const f = FLOORS[i] || {};
      return { value: String(i), label: f.isRoof ? 'Roof' : f.storey === 0 ? 'Ground' : `Floor ${f.storey}`, title: f.name };
    })], (v) => { floor = v; floorSeg.set(v); sig = ''; }, 'seg-xs');
    floorSeg.set('all');
    floorWrap.append(floorSeg.el);
  }
  buildFloorSeg();

  // ----- search + sort -----
  const search = h('input.rm-search', {
    type: 'search', placeholder: 'Search rooms, e.g. AI & ML lab', autocomplete: 'off', 'aria-label': 'Search rooms',
    oninput: (e) => { query = norm(e.target.value).trim(); sig = ''; },
  });
  const sortSel = h('select.tb-select.rm-sort', { 'aria-label': 'Sort rooms', onchange: (e) => { sort = e.target.value; sig = ''; } },
    SORTS.map((s) => h('option', { value: s.value }, s.label)));
  // Simulation: pretend every classroom is empty by forcing it off; click again to hand control back to HUKUM.
  const CLASSROOMS = ROOM_LIST.filter((r) => r.type === 'classroom');
  let simOn = false;
  const simBtn = h('button.btn.btn-sm.btn-sim-empty', {
    type: 'button', title: 'Simulate every classroom being empty (forces them off). Click again to restore Auto.',
    onclick: () => {
      simOn = !simOn;
      CLASSROOMS.forEach((r) => actions.setRoomOverride(r.id, simOn ? 'off' : null));
      simBtn.textContent = simOn ? 'Stop simulation' : 'Simulate empty classrooms';
      simBtn.classList.toggle('active', simOn);
      sig = '';
    },
  }, 'Simulate empty classrooms');
  const tools = h('div.rm-tools', search, sortSel, simBtn);

  const sPowered = h('b.num', '—'), sOff = h('b.num', '—'), sSave = h('b.num', '—'), sPeople = h('b.num', '—'), sCount = h('b.num', '—');
  const summary = h('div.rm-summary',
    h('span', sCount, ' rooms'), h('span', sPeople, ' people'), h('span', sPowered, ' on'), h('span', sOff, ' auto-off'), h('span', sSave, ' saved now'));

  const head = h('div.rm-row.rm-head', h('span', 'Room'), h('span', 'Power'), h('span', 'Control'), h('span', ''));
  const body = h('div.rm-body');
  const empty = h('div.empty.hide', 'No rooms match.');
  const rows = ROOM_LIST.map((room) => {
    const power = h('span.pill', '—');
    const sub = h('div.cell-sub.num.rm-sub', '');
    const seg = segmented([
      { value: 'auto', label: 'Auto', title: 'HUKUM decides (auto-off when empty)' },
      { value: 'on', label: 'On', title: 'Manual override: keep on' },
      { value: 'off', label: 'Off', title: 'Manual override: switch off' },
    ], (v) => actions.setRoomOverride(room.id, v === 'auto' ? null : v), 'seg-xs');
    const go = h('button.icon-btn', {
      type: 'button', title: `Walk to ${room.name}`,
      onclick: () => { const c = roomCentre(room); actions.teleport(c.floor, c.x, c.y); },
    }, h('span.ic-go'));
    const row = h('div.rm-row',
      h('div.rm-name', h('button.link', { type: 'button', title: `${room.name} (${room.id})`, onclick: () => onInspect('room', room.id) }, room.name)),
      h('span.rm-pow', power), seg.el, go, sub);
    return { room, row, power, sub, seg, text: norm(`${room.name} ${room.id} ${room.type}`), waste: 0, occ: 0 };
  });

  el.append(h('div.rm-toolbar', blockSeg.el, floorWrap, tools, summary), h('div.card.card-flush', head, body, empty));

  let sig = '', lastOrder = 0;
  function visible(r) {
    if (block !== 'all' && (r.room.blockId || 'CAMPUS') !== block) return false;
    if (floor !== 'all' && String(r.room.floor) !== floor) return false;
    if (query && !query.split(/\s+/).every((w) => r.text.includes(w))) return false;
    return true;
  }

  return {
    el,
    update() {
      let ppl = 0, on = 0, off = 0, save = 0;
      const shown = [];
      for (const r of rows) {
        if (!visible(r)) continue;
        shown.push(r);
        const rs = roomState(state, r.room.id);
        const cam = cameraForRoom(state, r.room.id);
        const occ = safe(rs.occupancy);
        ppl += occ;
        r.occ = occ;
        r.waste = occ === 0 ? safe(rs.loadKW) : 0;
        const det = cam && !cam.online ? 'cam off' : isNum(rs.detected) ? String(rs.detected) : '—';
        const pplText = r.room.seats || occ ? `${det} / ${occ} ppl` : null;
        const p = roomPower(state, r.room.id);
        setText(r.power, p.label);
        const cls = `pill p-${p.tone}`;
        if (r.power.className !== cls) r.power.className = cls;
        if (p.key === 'auto-off') off++; else if (p.key === 'on' || p.key === 'override-on') on++;
        const s = Math.max(0, safe(rs.baselineLoadKW) - safe(rs.loadKW));
        save += s;
        const bits = [floorShort(r.room.floor)];
        if (pplText) bits.push(pplText);
        if (rs.classLabel) bits.push(String(rs.classLabel));
        if (rs.failSafe) bits.push('fail-safe ON');
        if (isNum(rs.tempC) && !r.room.outdoor) bits.push(`${rs.tempC.toFixed(1)} C`);
        if (r.room.loads && r.room.loads.acKW > 0) bits.push(rs.acOn ? (rs.precool ? 'AC pre-cool' : 'AC on') : 'AC off');
        bits.push(fmtKW(rs.loadKW));
        if (r.waste > 0.05) bits.push(`empty, drawing ${fmtKW(r.waste)}`);
        else if (s > 0.05) bits.push(`saving ${fmtKW(s)}`);
        setText(r.sub, bits.join(' · '));
        r.seg.set(rs.override || 'auto');
        setClass(r.row, 'is-off', p.key === 'auto-off');
        setClass(r.row, 'is-waste', r.waste > 0.05);
        setClass(r.row, 'is-here', state.ui && state.ui.focusRoom === r.room.id);
      }
      setText(sCount, String(shown.length));
      setText(sPeople, String(ppl));
      setText(sPowered, String(on));
      setText(sOff, String(off));
      setText(sSave, fmtKW(save));
      setClass(empty, 'hide', shown.length > 0);

      // Re-sort at most every 2 s, and never while the pointer is over the list.
      const now = performance.now();
      const filterChanged = sig === '';
      if (!filterChanged && (now - lastOrder < 2000 || body.matches(':hover'))) return;
      const sorted = shown.slice().sort(sort === 'name' ? (a, b) => a.room.name.localeCompare(b.room.name)
        : sort === 'occ' ? (a, b) => b.occ - a.occ || a.room.name.localeCompare(b.room.name)
          : (a, b) => b.waste - a.waste || safe(roomState(state, b.room.id).loadKW) - safe(roomState(state, a.room.id).loadKW));
      const order = sorted.map((r) => r.room.id).join(',');
      lastOrder = now;
      if (order === sig) return;
      sig = order;
      for (let i = 0; i < sorted.length; i++) {
        const want = body.children[i];
        if (want !== sorted[i].row) body.insertBefore(sorted[i].row, want || null);
      }
      while (body.children.length > sorted.length) body.lastChild.remove();
    },
  };
}
