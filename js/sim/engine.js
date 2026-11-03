// Orchestrates the simulation clock. Calls the occupancy layer (SEE + room
// control) and the energy layer (PREDICT, DISCOVER, DECIDE, ACT, PROVE).
import { bus } from '../bus.js';
import { slotOf, minuteOfDay } from '../state.js';
import * as occ from './occupancy.js';
import * as energy from './energy.js';

const MAX_STEP_MIN = 0.25;     // integrate in <= 15 sim-second steps

export function createEngine(state) {
  occ.initOccupancy(state);
  energy.initEnergy(state);
  let lastSlot = slotOf(state.t);
  energy.onSlot(state, lastSlot);

  function advance(dtMin) {
    while (dtMin > 1e-9) {
      const h = Math.min(dtMin, MAX_STEP_MIN);
      const before = state.t;
      state.t += h;
      dtMin -= h;
      occ.stepOccupancy(state, h);
      energy.stepEnergy(state, h);
      bus.emit('tick', { t: state.t, dtMin: h });

      if (minuteOfDay(state.t) < minuteOfDay(before)) {
        energy.onDayEnd(state);
        state.day += 1;
        bus.emit('day', { day: state.day });
      }
      const s = slotOf(state.t);
      if (s !== lastSlot) {
        lastSlot = s;
        energy.onSlot(state, s);
        bus.emit('slot', { slot: s, t: state.t });
      }
    }
  }

  return {
    step(dtRealSec) {
      if (state.paused) return;
      // speed = sim seconds per real second
      advance(Math.min(dtRealSec, 0.25) * state.speed / 60);
    },
    advance,
    applyAction(action) {
      if (action.target.type === 'room') occ.applyRoomAction(state, action);
      else energy.applyEquipmentAction(state, action);
    },
    setRoomOverride: (roomId, mode) => occ.setRoomOverride(state, roomId, mode),
    setCameraOnline: (camId, online) => occ.setCameraOnline(state, camId, online),
    setEquipmentOverride: (equipId, mode) => energy.setEquipmentOverride(state, equipId, mode),
  };
}
