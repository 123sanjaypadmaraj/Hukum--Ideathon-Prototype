// Entry point: wires state, simulation, world view, CCTV and UI together.
import { bus } from './bus.js';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { createEngine } from './sim/engine.js';
import { createWorld } from './world/world.js';
import { createCctv } from './cctv/cctv.js';
import { createUI } from './ui/ui.js';

const state = createState();
const engine = createEngine(state);
window.HUKUM = { state, bus, engine };          // handy for debugging in the console

function toast(level, text) {
  state.alerts.push({ id: `al-${state.alerts.length}`, t: state.t, level, text });
  bus.emit('alert', state.alerts[state.alerts.length - 1]);
}

// One action surface for every module. Modules never mutate state directly
// for user-initiated changes; they call these.
const actions = {
  setSpeed(speed) { state.speed = speed; bus.emit('control', { speed }); },
  togglePause() { state.paused = !state.paused; bus.emit('control', { paused: state.paused }); },
  setMode(mode) { state.mode = mode; bus.emit('control', { mode }); toast('info', `Pilot mode: ${mode}`); },
  setWeather(weather) { state.scenario.weather = weather; bus.emit('scenario', { weather }); },
  setOutage(on) { state.scenario.outage = on; bus.emit('scenario', { outage: on }); toast(on ? 'warn' : 'info', on ? 'Grid outage: Resilience Mode engaged' : 'Grid restored'); },
  setInternetDown(on) { state.scenario.internetDown = on; bus.emit('scenario', { internetDown: on }); },
  setBatteryKWh(kwh) { state.scenario.batteryKWh = kwh; bus.emit('scenario', { batteryKWh: kwh }); },
  setHukumEnabled(on) { state.scenario.hukumEnabled = on; bus.emit('scenario', { hukumEnabled: on }); },
  skipMinutes(min) { engine.advance(min); },

  approve(id) {
    const a = state.pendingActions.find((p) => p.id === id);
    if (!a || a.status !== 'pending') return;
    a.status = 'approved';
    engine.applyAction(a);
    bus.emit('action:approved', a);
  },
  reject(id) {
    const a = state.pendingActions.find((p) => p.id === id);
    if (!a || a.status !== 'pending') return;
    a.status = 'rejected';
    bus.emit('action:rejected', a);
  },
  setRoomOverride: (roomId, mode) => engine.setRoomOverride(roomId, mode),
  setCameraOnline: (camId, online) => engine.setCameraOnline(camId, online),
  setEquipmentOverride: (equipId, mode) => engine.setEquipmentOverride(equipId, mode),

  teleport(floor, x, y) { Object.assign(state.player, { floor, x, y }); bus.emit('player:teleport', state.player); },
  openCamera(id) { state.ui.selectedCamera = id; bus.emit('ui:openCamera', { id }); },
  openLens(panelId) { state.ui.lensPanel = panelId; bus.emit('ui:openLens', { panelId }); },
  inspect(type, id) { bus.emit('ui:inspect', { type, id }); },
  toast,
};

const world = createWorld({ canvas: document.getElementById('world'), state, actions });
const cctv = createCctv({ state, actions });
const ui = createUI({ state, actions, cctv, world });

window.addEventListener('resize', () => world.resize());
world.resize();

let last = performance.now();
let uiAccum = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  engine.step(dt);
  world.update(dt);
  world.render();
  cctv.update(dt);
  uiAccum += dt;
  if (uiAccum > 0.2) { uiAccum = 0; ui.update(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

console.info(`HUKUM prototype ready. Speed ${CONFIG.defaultSpeed}x. Arrow keys to walk.`);
