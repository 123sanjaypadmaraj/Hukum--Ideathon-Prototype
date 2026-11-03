// Control-room UI: top bar, sidebar tabs, modals (AR Lens, Inspector),
// toasts and first-run onboarding. createUI(...).update() is called ~5x/s.
import { bus } from '../bus.js';
import { ROOM_BY_ID } from '../building.js';
import { h, setText, setClass } from './util.js';
import { createTopbar } from './topbar.js';
import { createOverview } from './overview.js';
import { createMarket } from './market.js';
import { createEquipment } from './equipment.js';
import { createRooms } from './rooms.js';
import { createBlocks } from './blocks.js';
import { createCopilot } from './copilot.js';
import { createVerify } from './verify.js';
import { createLens } from './lens.js';
import { createInspector } from './inspector.js';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function createUI({ state, actions, cctv, world }) {
  if (!state.ui) state.ui = { selectedCamera: null, lensPanel: null, focusRoom: null, modal: null };
  const $ = (id) => document.getElementById(id);
  const topbarEl = $('topbar'), tabsEl = $('tabs'), panelsEl = $('panels'), modalRoot = $('modal-root'), toastsEl = $('toasts');
  document.body.classList.add('hk-ui');

  // ---------- modal manager (shares #modal-root with the CCTV viewer) ----------
  let current = null;
  const modal = {
    open(kind, el, onClose) {
      if (current && current.kind !== kind) current.onClose();
      if (current && current.kind === kind) current.el.remove();
      current = { kind, el, onClose };
      modalRoot.append(el);
      state.ui.modal = kind;
    },
    close(kind) {
      if (!current || current.kind !== kind) return;
      current.el.remove();
      current = null;
      if (state.ui.modal === kind) state.ui.modal = null;
      const canvas = $('world');
      if (canvas && !state.ui.modal) canvas.focus({ preventScroll: true });
    },
  };
  modalRoot.addEventListener('click', (e) => { if (e.target === modalRoot && current) current.onClose(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) { e.preventDefault(); current.onClose(); }
  });

  // ---------- modules ----------
  let inspector = null, lens = null;
  const onInspect = (type, id) => inspector.show(type, id);
  lens = createLens({ state, actions, modal, onInspect });
  inspector = createInspector({ state, actions, modal, onLens: (id) => actions.openLens(id) });

  const topbar = createTopbar(topbarEl, { state, actions, onHelp: () => onboarding.show() });

  const ctx = { state, actions, onInspect };
  const cctvPanel = h('section.tab-panel.cc');
  let cctvMounted = false;
  const copilot = createCopilot(ctx);
  const tabs = [
    { id: 'overview', label: 'Overview', mod: createOverview(ctx) },
    { id: 'blocks', label: 'Blocks', mod: createBlocks(ctx) },
    { id: 'cctv', label: 'CCTV', mod: { el: cctvPanel, update() {} } },
    { id: 'market', label: 'Market', mod: createMarket(ctx) },
    { id: 'equipment', label: 'Assets', mod: createEquipment(ctx) },
    { id: 'rooms', label: 'Rooms', mod: createRooms(ctx) },
    { id: 'copilot', label: 'Copilot', mod: copilot },
    { id: 'verify', label: 'Verify', mod: createVerify(ctx) },
  ];

  tabsEl.textContent = '';
  panelsEl.textContent = '';
  for (const t of tabs) {
    t.badge = h('span.tab-badge');
    t.btn = h('button.tab', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `panel-${t.id}`, onclick: () => activate(t.id) }, t.label, t.badge);
    t.mod.el.id = `panel-${t.id}`;
    t.mod.el.setAttribute('role', 'tabpanel');
    tabsEl.append(t.btn);
    panelsEl.append(t.mod.el);
  }

  let active = null;
  function activate(id) {
    const t = tabs.find((x) => x.id === id) || tabs[0];
    active = t;
    for (const x of tabs) {
      setClass(x.btn, 'on', x === t);
      x.btn.setAttribute('aria-selected', String(x === t));
      setClass(x.mod.el, 'hide', x !== t);
    }
    if (t.id === 'cctv' && !cctvMounted && cctv && typeof cctv.mountWall === 'function') {
      cctvMounted = true;
      try { cctv.mountWall(cctvPanel); } catch (err) { console.error('[ui] cctv.mountWall failed', err); cctvPanel.textContent = 'CCTV wall failed to load.'; }
    }
    store.set('hukum.tab', t.id);
    panelsEl.scrollTop = 0;
    try { t.mod.update(); } catch (err) { console.error(`[ui] ${t.id}`, err); }
  }
  activate(store.get('hukum.tab') || 'overview');

  // ---------- toasts ----------
  const toasts = createToasts(toastsEl);
  bus.on('alert', (a) => a && toasts.push(a.level || 'info', a.text || ''));
  const roomBuf = { off: [], on: [] };
  let roomTimer = null;
  const flushRooms = () => {
    roomTimer = null;
    for (const kind of ['off', 'on']) {
      const ids = [...new Set(roomBuf[kind])];
      roomBuf[kind] = [];
      if (!ids.length) continue;
      const names = ids.slice(0, 3).map((id) => (ROOM_BY_ID[id] ? ROOM_BY_ID[id].name : id)).join(', ') + (ids.length > 3 ? ` +${ids.length - 3} more` : '');
      if (kind === 'off') toasts.push('saving', ids.length === 1 ? `${names} empty for 10 min: lights, fans and AC off` : `${ids.length} empty rooms switched off: ${names}`, 'Auto-off');
      else toasts.push('info', ids.length === 1 ? `${names}: someone walked in, power back on` : `Power back on in ${names}`, 'Power on');
    }
  };
  const queueRoom = (kind, p) => {
    if (!p || !p.roomId) return;
    roomBuf[kind].push(p.roomId);
    if (!roomTimer) roomTimer = setTimeout(flushRooms, 1500);
  };
  bus.on('room:auto-off', (p) => queueRoom('off', p));
  bus.on('room:power-on', (p) => queueRoom('on', p));
  bus.on('action:approved', (a) => a && toasts.push('action', a.text || 'Action approved', 'Approved'));

  // ---------- modal events ----------
  bus.on('ui:openLens', (p) => lens.open(p && p.panelId));
  bus.on('ui:inspect', (p) => p && inspector.show(p.type, p.id));

  // ---------- onboarding ----------
  const onboarding = createOnboarding(() => activate('overview'));
  if (!store.get('hukum.onboarded')) onboarding.show();

  return {
    update() {
      try { topbar.update(); } catch (err) { console.error('[ui] topbar', err); }
      const n = copilot.pendingCount();
      setText(tabs.find((t) => t.id === 'copilot').badge, n ? String(n) : '');
      if (active) {
        try { active.mod.update(); } catch (err) { console.error(`[ui] ${active.id}`, err); }
      }
      try { lens.update(); inspector.update(); } catch (err) { console.error('[ui] modal', err); }
    },
  };

  function createOnboarding(onLoop) {
    let el = null;
    const key = (k, label) => h('div.ob-k', h('span.kbd-group', k.map((x) => h('kbd', x))), h('span', label));
    function hide() { if (el) { el.remove(); el = null; } store.set('hukum.onboarded', '1'); }
    return {
      show() {
        if (el) return;
        el = h('div.onboard', { role: 'dialog', 'aria-label': 'Welcome to HUKUM' },
          h('div.ob-h', h('div', h('div.tile-l', 'Digital twin · NHCE campus'), h('h2', 'Walk the campus. Watch HUKUM work.')),
            h('button.icon-btn', { type: 'button', title: 'Dismiss', onclick: hide }, h('span.ic-x'))),
          h('div.ob-keys',
            key(['Arrows', 'WASD'], 'walk, Shift to run'),
            key(['E'], 'interact: camera, panel, machine, room'),
            key(['V'], 'first-person view'),
            key(['PgUp', 'PgDn'], 'stairs / lift: up and down within a block'),
            key(['M', 'H'], 'minimap, help')),
          h('div.ob-loop',
            h('div.tile-l', 'Every 15 minutes'),
            h('div.ob-steps', ['SEE', 'PREDICT', 'DISCOVER', 'DECIDE', 'ACT', 'PROVE'].map((s) => h('span', s)))),
          h('p.ob-p', 'You start at the NHCE main gate on the Outer Ring Road. Walk into any block door to enter it; walk out through the ground-floor entrance to return to the campus. '),
          h('p.ob-p', 'Cameras count people, the forecast predicts solar and demand, every machine bids its flexibility, the cheapest dependable mix is dispatched, and savings are verified against a do-nothing baseline. Try the Approve pilot mode, a grid outage, or point the AR Lens at a distribution board in any block\'s electrical riser (the Main LT panel is in the Main Block electrical room).'),
          h('div.ob-btns',
            h('button.btn', { type: 'button', onclick: () => { hide(); onLoop(); } }, 'Show the numbers'),
            h('button.btn.btn-accent', { type: 'button', onclick: () => { hide(); const c = $('world'); c && c.focus(); } }, 'Start exploring')));
        document.body.append(el);
      },
      hide,
    };
  }
}

function createToasts(root) {
  const MAX = 3;
  const recent = new Map();
  return {
    push(level, text, title) {
      if (!root || !text) return;
      const now = performance.now();
      if (recent.has(text) && now - recent.get(text) < 4000) return;   // de-duplicate bursts
      recent.set(text, now);
      if (recent.size > 50) recent.clear();
      const tone = level === 'warn' || level === 'danger' || level === 'error' ? level === 'warn' ? 'warn' : 'danger' : level === 'saving' || level === 'action' ? 'ok' : 'info';
      const el = h(`div.toast.t-${tone}`, h('div.toast-bar'), h('div.toast-body', title ? h('div.toast-t', title) : null, h('div.toast-x', text)));
      el.addEventListener('click', () => dismiss(el));
      root.append(el);
      while (root.children.length > MAX) root.firstChild.remove();
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => dismiss(el), level === 'warn' || level === 'danger' ? 7000 : 4500);
    },
  };
  function dismiss(el) {
    if (!el.isConnected) return;
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }
}
