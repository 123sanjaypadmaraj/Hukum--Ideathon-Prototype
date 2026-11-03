// HTTP API client (agents/CONTRACT.md) and the replay player for demo_run.json.

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: 'no-store', ...opts, signal: ctl ? ctl.signal : undefined });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const post = (url, body, timeoutMs) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }, timeoutMs);

export async function getHealth() {
  // Reuse the nav's request when it is already in flight.
  try {
    if (window.__hukumHealth) {
      const h = await window.__hukumHealth;
      if (h && h.ok) return h;
    }
  } catch { /* fall through */ }
  try {
    const h = await fetchJson('/api/health', {}, 3000);
    if (h && h.ok !== false) return { ok: true, ...h };
  } catch { /* offline */ }
  return { ok: false };
}

export const getGraph = () => fetchJson('/api/graph', {}, 4000);
export const startRun = (body) => post('/api/run', body, 10000);
export const resumeRun = (threadId, decision, ids) => post(`/api/resume/${encodeURIComponent(threadId)}`, { decision, ids }, 10000);
export const askAgent = (agent, question, threadId) => post('/api/ask', { agent, question, thread_id: threadId || undefined }, 30000);

// Subscribe to the SSE stream. The server replays the full backlog to late or
// reconnecting subscribers, so events already seen are skipped by index.
export function openStream(threadId, onEvent, onStatus) {
  let seen = 0;
  let lastSeq = -Infinity;
  let es = null;
  let closed = false;
  let retries = 0;
  const connect = () => {
    if (closed) return;
    let idx = 0;
    es = new EventSource(`/api/stream/${encodeURIComponent(threadId)}`);
    es.onopen = () => { retries = 0; onStatus && onStatus('open'); };
    es.onmessage = (m) => {
      const i = idx++;
      if (i < seen) return;
      seen = i + 1;
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev && typeof ev.seq === 'number') { if (ev.seq <= lastSeq) return; lastSeq = ev.seq; }
      try { onEvent(ev); } catch (err) { console.error('agents: event handler failed', err); }
      if (ev && (ev.type === 'done')) close();
    };
    es.onerror = () => {
      if (closed) return;
      es.close();
      if (++retries > 5) { onStatus && onStatus('lost'); close(); return; }
      onStatus && onStatus('retry');
      setTimeout(connect, 800 * retries);
    };
  };
  const close = () => { closed = true; if (es) es.close(); };
  connect();
  return { close };
}

export async function loadReplay(url) {
  const j = await fetchJson(url, {}, 15000);
  if (!j || !Array.isArray(j.events)) throw new Error('replay file has no "events" list');
  return j;
}

// Plays recorded events honouring each event's "dt" (ms before this event).
// Pauses after an "interrupt" until resume() is called (or the auto timer fires).
export class Player {
  constructor(events, onEvent, { onProgress, onInterrupt, onEnd } = {}) {
    this.events = events || [];
    this.onEvent = onEvent;
    this.onProgress = onProgress || (() => {});
    this.onInterrupt = onInterrupt || (() => {});
    this.onEnd = onEnd || (() => {});
    this.i = 0;
    this.speed = 1;
    this.timer = null;
    this.waiting = false;
    this.stopped = false;
  }
  start() { this.schedule(); }
  setSpeed(x) { this.speed = x || 1; if (this.timer && !this.waiting) { clearTimeout(this.timer); this.schedule(); } }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }
  schedule() {
    if (this.stopped) return;
    if (this.i >= this.events.length) { this.finish(); return; }
    const dt = Math.max(0, Math.min(6000, Number(this.events[this.i].dt) || 0));
    this.timer = setTimeout(() => this.step(), dt / this.speed);
  }
  step() {
    if (this.stopped) return;
    const ev = this.events[this.i++];
    this.emit(ev);
    this.onProgress(this.i, this.events.length);
    if (ev && ev.type === 'interrupt') {
      this.waiting = true;
      this.onInterrupt(ev);
      return;
    }
    this.schedule();
  }
  // immediate: play the next event now instead of honouring its dt
  // (used when the recorded human decision is applied after the card was shown).
  resume(immediate = false) {
    if (!this.waiting || this.stopped) return;
    this.waiting = false;
    clearTimeout(this.timer);
    if (immediate) this.timer = setTimeout(() => this.step(), 0);
    else this.schedule();
  }
  peek() { return this.events[this.i]; }
  skipToEnd() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.waiting = false;
    while (this.i < this.events.length) this.emit(this.events[this.i++]);
    this.onProgress(this.i, this.events.length);
    this.finish();
  }
  emit(ev) {
    try { this.onEvent(ev); } catch (err) { console.error('agents: replay event failed', err); }
  }
  finish() {
    if (this.stopped) return;
    this.stopped = true;
    this.onEnd();
  }
}
