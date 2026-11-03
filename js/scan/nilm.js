// Event-based NILM (Hart-style) on a single aggregate meter:
// 1) median filter, 2) detect steady-state step changes, 3) pair each ON step
// with the matching OFF step, 4) cluster ON magnitudes into appliances.
// NILMTK does this (and more) in Python; this is the same idea in the browser.

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

export function disaggregate(series, { minStepKW = 2.5, tol = 0.12, minDurMin = 4 } = {}) {
  const kW = series.map((s) => s.kW);
  const n = kW.length;
  const f = kW.map((_, i) => median(kW.slice(Math.max(0, i - 2), Math.min(n, i + 3))));
  // Steps: compare the mean of 3 samples after with 3 before (catches 1-2 minute ramps).
  const events = [];
  for (let i = 3; i < n - 3; i++) {
    const before = (f[i - 3] + f[i - 2] + f[i - 1]) / 3;
    const after = (f[i] + f[i + 1] + f[i + 2]) / 3;
    const d = after - before;
    if (Math.abs(d) >= minStepKW) {
      const last = events[events.length - 1];
      if (last && i - last.i <= 2 && Math.sign(last.d) === Math.sign(d)) { if (Math.abs(d) > Math.abs(last.d)) { last.i = i; last.d = d; } continue; }
      events.push({ i, d });
    }
  }
  // Pair ON with the first later OFF of similar size.
  const used = new Set();
  const runs = [];
  for (let a = 0; a < events.length; a++) {
    const on = events[a];
    if (on.d <= 0) continue;
    for (let b = a + 1; b < events.length; b++) {
      const off = events[b];
      if (off.d >= 0 || used.has(b)) continue;
      if (Math.abs(-off.d - on.d) / on.d <= tol) {
        if (off.i - on.i >= minDurMin) { runs.push({ kW: (on.d - off.d) / 2, start: on.i, end: off.i }); used.add(b); }
        break;
      }
    }
  }
  // Cluster by magnitude.
  runs.sort((x, y) => x.kW - y.kW);
  const clusters = [];
  for (const r of runs) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(r.kW - c.mean) / c.mean <= tol) { c.runs.push(r); c.mean = c.runs.reduce((s, q) => s + q.kW, 0) / c.runs.length; }
    else clusters.push({ mean: r.kW, runs: [r] });
  }
  return {
    events: events.length,
    paired: runs.length,
    appliances: clusters.map((c, k) => {
      const spread = Math.sqrt(c.runs.reduce((s, r) => s + (r.kW - c.mean) ** 2, 0) / c.runs.length);
      return {
        id: `NILM-${k + 1}`,
        kW: +c.mean.toFixed(2),
        runs: c.runs.length,
        meanMinutes: Math.round(c.runs.reduce((s, r) => s + (r.end - r.start), 0) / c.runs.length),
        starts: c.runs.map((r) => series[r.start]?.label || r.start),
        startMinutes: c.runs.map((r) => r.start),
        quality: +Math.max(0.4, Math.min(0.95, 0.95 - spread / c.mean - (c.runs.length < 2 ? 0.15 : 0))).toFixed(2),
      };
    }),
    filtered: f,
  };
}

// Match NILM appliances to nameplate equipment. Equipment with identical
// nameplates can't be told apart from one meter, so a group of identical
// plates is matched together and any mismatch is reported for the group.
export function matchToNameplates(appliances, plates) {
  const results = [];
  const free = [...appliances];
  const groups = new Map();
  for (const p of plates) {
    if (p.kW == null || p.kind === 'battery' || p.kind === 'chiller') continue;  // battery / chiller have their own meters
    const key = `${p.kind}|${p.kW}|${p.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [, members] of groups) {
    const rated = members[0].kW;
    // Pumps and motors are on/off loads; expect 60-110% of the plate.
    const picks = [];
    for (let k = 0; k < members.length; k++) {
      let best = null;
      for (const a of free) {
        if (a.kW < rated * 0.35 || a.kW > rated * 1.25) continue;
        const score = Math.abs(Math.log(a.kW / rated));
        if (!best || score < best.score) best = { a, score };
      }
      if (best) { picks.push(best.a); free.splice(free.indexOf(best.a), 1); }
    }
    picks.sort((x, y) => y.kW - x.kW);
    if (members.length === 1) {
      const a = picks[0] || null;
      results.push({ tags: [members[0].tag], rated, appliance: a, ratio: a ? a.kW / rated : null, ambiguous: false });
    } else {
      picks.forEach((a) => results.push({ tags: members.map((m) => m.tag), rated, appliance: a, ratio: a.kW / rated, ambiguous: true }));
      for (let k = picks.length; k < members.length; k++) results.push({ tags: members.map((m) => m.tag), rated, appliance: null, ratio: null, ambiguous: true });
    }
  }
  return { matches: results, unmatched: free };
}
