// The fact store behind HUKUM Scan. Every claim any source makes is a fact
// { subject, predicate, value, source, confidence, evidence }. Fusion groups
// facts by (subject, predicate): agreeing sources raise confidence
// (noisy-OR), disagreeing sources become a review item for a human. Cross-
// checks between different predicates (nameplate vs meter, Wi-Fi vs camera)
// add review items too. Everything else is accepted automatically.

export const ACCEPT_AT = 0.7;

export const SOURCES = {
  'solar-api':     { label: 'Google Solar API', stage: 1 },
  'open-buildings':{ label: 'Open Buildings 2.5D', stage: 1 },
  'osm':           { label: 'OpenStreetMap', stage: 1 },
  'irradiance':    { label: 'Irradiance model (pvlib-style)', stage: 1 },
  'dxf':           { label: 'CAD blueprint (DXF)', stage: 2 },
  'ifc':           { label: 'BIM model (IFC)', stage: 2 },
  'plan-ocr':      { label: 'Scanned plan + OCR', stage: 2 },
  'sld-ocr':       { label: 'Single-line diagram OCR', stage: 2 },
  'roomplan':      { label: 'Interior scan (RoomPlan)', stage: 3 },
  'nameplate':     { label: 'Nameplate OCR', stage: 3 },
  'cctv':          { label: 'CCTV homography + YOLO', stage: 4 },
  'nilm':          { label: 'NILM on block meter', stage: 5 },
  'wifi':          { label: 'Wi-Fi AP logs', stage: 5 },
  'timetable':     { label: 'Timetable export', stage: 5 },
  'align':         { label: 'Auto-alignment (ICP)', stage: 6 },
  'human':         { label: 'Human review', stage: 6 },
};

// How close two values must be to count as agreeing, per predicate.
const TOL = { area_m2: 0.12, floors: 0, roof_kwp: 0.15, yearly_kwh: 0.2, rated_kw: 0.1, seats: 0.25, height_m: 0.15, peak_occupancy: 0.3, running_kw: 0.1 };

export function createFactStore() {
  const facts = [];
  const decisions = new Map();     // reviewKey -> { choice, value, by, at }
  let seq = 0;
  return {
    facts, decisions,
    add(subject, predicate, value, source, confidence, evidence = '', extra = {}) {
      const f = { id: `F${++seq}`, subject, predicate, value, source, confidence: +(+confidence).toFixed(2), evidence, ...extra };
      facts.push(f);
      return f;
    },
    clearSource(source) {
      for (let i = facts.length - 1; i >= 0; i--) if (facts[i].source === source) facts.splice(i, 1);
    },
    decide(key, choice) { decisions.set(key, { ...choice, at: new Date().toISOString() }); },
    undecide(key) { decisions.delete(key); },
  };
}

function same(pred, a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = TOL[pred] ?? 0.1;
    if (tol === 0) return a === b;
    return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}
const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-IN') : +v.toFixed(2)) : v === true ? 'yes' : v === false ? 'no' : String(v));
const noisyOr = (cs) => Math.min(0.99, 1 - cs.reduce((p, c) => p * (1 - c), 1));

// Predicates that describe a relation where several values are all true
// (a room has many circuits), so different values are not a conflict.
const MULTI = new Set(['has_circuit', 'contains', 'observed_by']);

export function fuse(store, crossChecks = []) {
  const groups = new Map();
  for (const f of store.facts) {
    const k = MULTI.has(f.predicate) ? `${f.subject}|${f.predicate}|${f.value}` : `${f.subject}|${f.predicate}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const resolved = [];   // { subject, predicate, value, confidence, sources[], status, reviewKey? }
  const review = [];
  for (const [k, fs] of groups) {
    const { subject, predicate } = fs[0];
    // Cluster values that agree.
    const clusters = [];
    for (const f of fs) {
      const c = clusters.find((c) => same(predicate, c.value, f.value));
      if (c) c.facts.push(f); else clusters.push({ value: f.value, facts: [f] });
    }
    for (const c of clusters) c.conf = noisyOr(c.facts.map((f) => f.confidence));
    clusters.sort((a, b) => b.conf - a.conf);
    const key = `fact:${k}`;
    const decision = store.decisions.get(key);
    if (decision) {
      resolved.push({ subject, predicate, value: decision.value, confidence: 1, sources: ['human'], status: 'human', reviewKey: key, note: decision.label });
      review.push(conflictItem(key, subject, predicate, clusters, decision));
      continue;
    }
    if (clusters.length > 1) {
      review.push(conflictItem(key, subject, predicate, clusters, null));
      resolved.push({ subject, predicate, value: clusters[0].value, confidence: clusters[0].conf, sources: clusters[0].facts.map((f) => f.source), status: 'conflict', reviewKey: key });
      continue;
    }
    const c = clusters[0];
    const status = c.conf >= ACCEPT_AT ? 'accepted' : 'review';
    resolved.push({ subject, predicate, value: c.value, confidence: c.conf, sources: c.facts.map((f) => f.source), status, reviewKey: status === 'review' ? key : undefined });
    if (status === 'review') {
      review.push({
        key, kind: 'low-confidence', subject, predicate,
        title: question(subject, predicate, c.value),
        detail: `Only ${c.facts.map((f) => SOURCES[f.source]?.label || f.source).join(', ')} says so, at ${Math.round(c.conf * 100)}% confidence. ${c.facts.map((f) => f.evidence).filter(Boolean).join(' ')}`,
        options: [{ id: 'confirm', label: `Yes, ${fmt(c.value)}`, value: c.value }, { id: 'reject', label: 'No, drop it', value: null }],
        decided: null,
      });
    }
  }
  for (const x of crossChecks) {
    const decision = store.decisions.get(x.key);
    review.push({ ...x, kind: 'cross-check', decided: decision || null });
    if (decision && x.apply) for (const r of x.apply(decision)) resolved.push({ ...r, confidence: 1, sources: ['human'], status: 'human', reviewKey: x.key });
  }
  // Drop facts a human rejected.
  const out = resolved.filter((r) => !(r.status === 'human' && r.value == null));
  return { resolved: out, review };
}

function conflictItem(key, subject, predicate, clusters, decision) {
  return {
    key, kind: 'conflict', subject, predicate,
    title: question(subject, predicate, null),
    detail: clusters.map((c) => `${c.facts.map((f) => SOURCES[f.source]?.label || f.source).join(' + ')} says ${fmt(c.value)} (${Math.round(c.conf * 100)}%)${c.facts[0].evidence ? ': ' + c.facts[0].evidence.replace(/\.$/, '') : ''}`).join('. ') + '.',
    options: clusters.map((c, i) => ({ id: `v${i}`, label: `${fmt(c.value)} (${c.facts.map((f) => SOURCES[f.source]?.label || f.source).join(' + ')})`, value: c.value })),
    decided: decision || null,
  };
}

function question(subject, p, value) {
  const q = {
    feeds: `Which room does circuit ${subject} feed?`,
    exists: value == null ? `Does ${subject} still exist?` : `Is ${subject} a real room?`,
    peak_occupancy: `How many people use ${subject} at peak?`,
    label: `OCR label: is this room ${value ?? subject}?`,
    rated_kw: `What is the real rating of ${subject}?`,
  }[p];
  if (q) return q;
  return value == null ? `Sources disagree on ${label(p)} of ${subject}` : `Confirm ${label(p)} of ${subject}: ${fmt(value)}?`;
}

function label(p) {
  return ({
    exists: 'existence', area_m2: 'floor area', floors: 'storey count', roof_kwp: 'rooftop solar potential', yearly_kwh: 'yearly solar yield',
    feeds: 'the room fed by', rated_kw: 'rated power', name: 'name', seats: 'seat count', height_m: 'height', label: 'room label',
  })[p] || p.replace(/_/g, ' ');
}

export function summarize(fused) {
  const total = fused.resolved.length;
  const auto = fused.resolved.filter((r) => r.status === 'accepted').length;
  const human = fused.resolved.filter((r) => r.status === 'human').length;
  const open = fused.review.filter((r) => !r.decided).length;
  return { total, auto, human, open, autoPct: total ? Math.round((auto / total) * 100) : 0 };
}

export { fmt as fmtValue };
