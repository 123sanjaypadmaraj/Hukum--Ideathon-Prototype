// Tiny event bus shared by every module.
const handlers = new Map();

export const bus = {
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event).delete(fn);
  },
  emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[bus] ${event}`, err); }
    }
  },
};
