// Live agent graph in SVG: supervisor hub, the agents on an ellipse around it,
// reporter and terminals at the sides. Driven by status updates from app.js.
// Nodes carry the agent's icon; the active agent gets a spinning ring, packets
// flow along its edges and a speech bubble shows its latest line.
import { s, AGENTS, AGENT_IDS, agentMeta, colorOf, ICONS } from './util.js';

const W = 920, H = 400, CX = 460, CY = 200, RX = 290, RY = 148;
const NW = 150, NH = 44;

export function defaultGraph() {
  const nodes = [
    { id: '__start__', label: 'Start', kind: 'terminal' },
    { id: 'supervisor', label: 'Supervisor', kind: 'router' },
    ...AGENTS.map((a) => ({ id: a.id, label: a.label, role: a.role, kind: 'agent' })),
    { id: 'reporter', label: 'Reporter', kind: 'agent' },
    { id: '__end__', label: 'End', kind: 'terminal' },
  ];
  const edges = [{ from: '__start__', to: 'supervisor', kind: 'normal' }];
  for (const a of AGENTS) {
    if (a.id === 'environment') continue;
    edges.push({ from: 'supervisor', to: a.id, kind: 'conditional' }, { from: a.id, to: 'supervisor', kind: 'normal' });
  }
  edges.push({ from: 'solar_planner', to: 'environment', kind: 'normal' }, { from: 'environment', to: 'solar_planner', kind: 'loop' },
    { from: 'environment', to: 'supervisor', kind: 'conditional' }, { from: 'supervisor', to: 'reporter', kind: 'conditional' }, { from: 'reporter', to: '__end__', kind: 'normal' });
  return { nodes, edges };
}

const isStart = (id) => /^(__)?start(__)?$/i.test(id);
const isEnd = (id) => /^(__)?end(__)?$/i.test(id);

function layout(graph) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes.filter((n) => n && n.id) : [];
  const pos = {};
  const hub = nodes.find((n) => n.id === 'supervisor') || nodes.find((n) => n.kind === 'router');
  if (hub) pos[hub.id] = { x: CX, y: CY, w: 168, h: 52, type: 'hub' };
  const ring = [];
  for (const id of AGENT_IDS) if (nodes.some((n) => n.id === id)) ring.push(id);
  for (const n of nodes) {
    if (pos[n.id] || ring.includes(n.id) || n.id === 'reporter' || n.kind === 'terminal' || isStart(n.id) || isEnd(n.id)) continue;
    if (n.kind === 'router' && hub) continue;
    ring.push(n.id); // unknown extra agents join the ring
  }
  ring.forEach((id, i) => {
    const a = (-90 + (360 / Math.max(ring.length, 1)) * i) * Math.PI / 180;
    pos[id] = { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a), w: NW, h: NH, type: 'agent', angle: a };
  });
  if (nodes.some((n) => n.id === 'reporter')) pos.reporter = { x: 846, y: 128, w: 128, h: NH, type: 'agent' };
  let endY = 272;
  for (const n of nodes) {
    if (pos[n.id]) continue;
    if (isStart(n.id)) pos[n.id] = { x: 44, y: CY, w: 66, h: 26, type: 'terminal' };
    else { pos[n.id] = { x: 860, y: endY, w: 66, h: 26, type: 'terminal' }; endY += 40; }
  }
  return { nodes, pos };
}

function wrap(text, max, lines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; if (out.length === lines) break; }
    else cur = (cur + ' ' + w).trim();
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = out[lines - 1].replace(/.{0,3}$/, '...');
  return out.slice(0, lines);
}

export function createGraphView(root, { onSelect } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ag-graph', role: 'img', 'aria-label': 'Agent graph' });
  const defs = s('defs', {},
    s('marker', { id: 'ag-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#3a4a60' })),
    s('radialGradient', { id: 'ag-glow', cx: '50%', cy: '50%', r: '50%' },
      s('stop', { offset: '0%', 'stop-color': '#f5b301', 'stop-opacity': '.10' }),
      s('stop', { offset: '100%', 'stop-color': '#f5b301', 'stop-opacity': '0' })),
    s('pattern', { id: 'ag-dots', width: '22', height: '22', patternUnits: 'userSpaceOnUse' }, s('circle', { cx: '1', cy: '1', r: '1', fill: '#16202c' })));
  const gBack = s('g', { class: 'back' },
    s('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#ag-dots)' }),
    s('ellipse', { cx: CX, cy: CY, rx: RX + 40, ry: RY + 34, fill: 'url(#ag-glow)' }),
    s('ellipse', { class: 'orbit', cx: CX, cy: CY, rx: RX, ry: RY }));
  const gEdges = s('g', { class: 'edges' });
  const gFlow = s('g', { class: 'flows' });
  const gNodes = s('g', { class: 'nodes' });
  const gBubble = s('g', { class: 'bubble', opacity: '0' });
  const loopLabel = s('text', { class: 'loop-label', 'text-anchor': 'middle' }, '');
  svg.append(defs, gBack, gEdges, gFlow, gNodes, loopLabel, gBubble);
  root.textContent = '';
  root.append(svg);

  let nodeEls = {};
  let edgeEls = []; // {a, b, el, kind, d}
  let loopEl = null;
  let statuses = {};
  let loopPass = 0;
  let graph = null;
  let pos = {};
  let speech = {};
  let flowKey = '';

  function setGraph(g) {
    graph = g && Array.isArray(g.nodes) && g.nodes.length ? g : defaultGraph();
    const L = layout(graph);
    pos = L.pos;
    const nodes = L.nodes;
    gEdges.textContent = ''; gNodes.textContent = ''; gFlow.textContent = ''; flowKey = '';
    nodeEls = {}; edgeEls = []; loopEl = null;

    // Edges: one line per unordered pair; the strongest kind wins.
    const pairs = new Map();
    const rank = { normal: 0, conditional: 1, loop: 2 };
    for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
      if (!e || !pos[e.from] || !pos[e.to] || e.from === e.to) continue;
      const key = [e.from, e.to].sort().join('|');
      const kind = rank[e.kind] != null ? e.kind : 'normal';
      const prev = pairs.get(key);
      if (!prev || rank[kind] > rank[prev.kind]) pairs.set(key, { a: e.from, b: e.to, kind, both: prev ? true : false });
      else prev.both = true;
    }
    for (const [, p] of pairs) {
      const A = pos[p.a], B = pos[p.b];
      let d;
      if (p.kind === 'loop' || (A.type === 'agent' && B.type === 'agent' && A.angle != null && B.angle != null)) {
        // Curved arc on the outside of the ring.
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const dx = mx - CX, dy = my - CY; const dd = Math.hypot(dx, dy) || 1;
        const qx = mx + (dx / dd) * 70, qy = my + (dy / dd) * 70;
        d = `M${A.x},${A.y} Q${qx},${qy} ${B.x},${B.y}`;
        if (p.kind === 'loop') {
          loopLabel.setAttribute('x', String(Math.max(80, Math.min(W - 80, mx + (dx / dd) * 100))));
          loopLabel.setAttribute('y', String(Math.max(14, my + (dy / dd) * 100)));
        }
      } else {
        d = `M${A.x},${A.y} L${B.x},${B.y}`;
      }
      const el = s('path', { d, class: `edge ${p.kind}` });
      if (p.kind === 'loop') loopEl = el;
      gEdges.append(el);
      edgeEls.push({ a: p.a, b: p.b, el, kind: p.kind, d });
    }

    for (const n of nodes) {
      const P = pos[n.id]; if (!P) continue;
      const meta = agentMeta(n.id);
      const term = P.type === 'terminal';
      const label = term ? (n.label || (isStart(n.id) ? 'Start' : 'End')) : (meta.short || n.label || n.id);
      const col = colorOf(n.id);
      const ir = P.type === 'hub' ? 15 : 13, icx = ir + 9, icy = P.h / 2;
      const kids = [
        s('title', {}, `${meta.label || label}${meta.role ? ': ' + meta.role : ''}`),
        s('rect', { class: 'halo', x: -5, y: -5, width: P.w + 10, height: P.h + 10, rx: 14 }),
        s('rect', { class: 'box', width: P.w, height: P.h, rx: term ? P.h / 2 : 10 }),
      ];
      if (term) {
        kids.push(s('text', { class: 'lbl', x: P.w / 2, y: P.h / 2 + 4, 'text-anchor': 'middle' }, label));
      } else {
        kids.push(
          s('circle', { class: 'ico-bg', cx: icx, cy: icy, r: ir, fill: col, 'fill-opacity': '.14', stroke: col, 'stroke-opacity': '.45' }),
          s('circle', { class: 'ring', cx: icx, cy: icy, r: ir + 3.5, stroke: col }),
          s('g', { transform: `translate(${icx - ir * 0.62},${icy - ir * 0.62}) scale(${(ir * 1.24) / 24})`, fill: 'none', stroke: col, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
            s('path', { d: ICONS[n.id] || 'M12 4a8 8 0 100 16 8 8 0 000-16z' })),
          s('text', { class: 'lbl', x: icx + ir + 9, y: P.h / 2 - 2 }, label),
          s('text', { class: 'sub', x: icx + ir + 9, y: P.h / 2 + 12 }, P.type === 'hub' ? 'routing' : 'waiting'),
          s('g', { class: 'tick', transform: `translate(${P.w - 15},${P.h / 2})` },
            s('circle', { r: 7 }), s('path', { d: 'M-3,0 L-1,2.5 L3.2,-2.4' })));
      }
      const g = s('g', { class: `node ${P.type}`, 'data-id': n.id, 'data-status': 'idle', transform: `translate(${P.x - P.w / 2},${P.y - P.h / 2})`, tabindex: term ? null : '0', role: term ? null : 'button', 'aria-label': `${meta.label || label}` }, ...kids);
      if (!term && onSelect) {
        g.addEventListener('click', () => onSelect(n.id));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } });
      }
      gNodes.append(g);
      nodeEls[n.id] = g;
    }
    render();
  }

  const SUB = { idle: 'waiting', active: 'working', done: 'done', interrupt: 'needs approval', error: 'error', skipped: 'not in route' };

  // Packets along the active agent's edges (supervisor -> agent on handoff).
  function setFlows(active) {
    const key = `${active || ''}|${loopPass}`;
    if (key === flowKey) return;
    flowKey = key;
    gFlow.textContent = '';
    if (!active) return;
    const col = colorOf(active);
    for (const e of edgeEls) {
      const hot = (e.a === active || e.b === active) && (e.a === 'supervisor' || e.b === 'supervisor' || (e.kind === 'loop' && loopPass > 1));
      if (!hot) continue;
      // Packets travel from the supervisor towards the active agent.
      const towardB = e.b === active;
      for (let i = 0; i < 3; i++) {
        const c = s('circle', { r: 3.2, class: 'packet', fill: col });
        const m = s('animateMotion', { dur: '1.4s', repeatCount: 'indefinite', begin: `${(i * 1.4) / 3}s`, path: e.d, keyPoints: towardB ? '0;1' : '1;0', keyTimes: '0;1', calcMode: 'linear' });
        c.append(m);
        gFlow.append(c);
      }
    }
  }

  function renderBubble(active) {
    const text = active && speech[active];
    const P = active && pos[active];
    if (!text || !P || active === 'supervisor' && !text) { gBubble.setAttribute('opacity', '0'); return; }
    const lines = wrap(text, 42, 2);
    const bw = 262, bh = 16 + lines.length * 14;
    const below = P.y < CY - 20 || P.y === CY;
    let x = Math.max(8, Math.min(W - bw - 8, P.x - bw / 2));
    const y = below ? P.y + P.h / 2 + 12 : P.y - P.h / 2 - 12 - bh;
    const tipX = Math.max(x + 14, Math.min(x + bw - 14, P.x));
    const tip = below ? `M${tipX - 7},${y} L${tipX},${y - 7} L${tipX + 7},${y} Z` : `M${tipX - 7},${y + bh} L${tipX},${y + bh + 7} L${tipX + 7},${y + bh} Z`;
    const col = colorOf(active);
    gBubble.textContent = '';
    gBubble.append(
      s('rect', { x, y, width: bw, height: bh, rx: 9, class: 'bub', stroke: col }),
      s('path', { d: tip, class: 'bub-tip', fill: '#0d131b', stroke: col }),
      ...lines.map((l, i) => s('text', { x: x + 11, y: y + 18 + i * 14, class: 'bub-t' }, l)));
    gBubble.setAttribute('opacity', '1');
  }

  function render() {
    let active = null;
    for (const [id, g] of Object.entries(nodeEls)) {
      const st = statuses[id] || 'idle';
      g.setAttribute('data-status', st);
      const sub = g.querySelector('text.sub');
      if (sub) sub.textContent = id === 'supervisor' && st === 'idle' ? 'routing' : (id === 'solar_planner' && loopPass > 1 && st !== 'idle' ? `${SUB[st]}, pass ${loopPass}` : SUB[st] || st);
      if (st === 'active' || st === 'interrupt') active = active && active !== 'supervisor' ? active : id;
    }
    for (const e of edgeEls) {
      const on = active && (e.a === active || e.b === active) && (e.a === 'supervisor' || e.b === 'supervisor' || e.kind === 'loop');
      e.el.classList.toggle('flow', !!on);
      if (on) e.el.style.setProperty('--flow', colorOf(active)); else e.el.style.removeProperty('--flow');
      const done = (statuses[e.a] === 'done' || e.a === 'supervisor' || /start/i.test(e.a)) && (statuses[e.b] === 'done' || e.b === 'supervisor');
      e.el.classList.toggle('done', !!done && !on);
    }
    if (loopEl) {
      const loopActive = loopPass > 1 && (active === 'environment' || active === 'solar_planner');
      loopEl.classList.toggle('flow', loopActive);
      loopEl.classList.toggle('hot', loopPass > 1);
    }
    loopLabel.textContent = loopPass > 0 ? `Review loop: pass ${loopPass}` : '';
    loopLabel.classList.toggle('hot', loopPass > 1);
    setFlows(active);
    renderBubble(active);
  }

  return {
    setGraph,
    get graph() { return graph; },
    setStatus(id, st) { statuses[id] = st; render(); },
    setAll(map) { statuses = { ...map }; render(); },
    setLoop(pass) { loopPass = pass || 0; render(); },
    // Latest line from an agent, shown in a bubble while it is active.
    say(id, text) { if (!id) return; speech[id] = text; if (statuses[id] === 'active' || statuses[id] === 'interrupt') render(); },
    reset() { statuses = {}; loopPass = 0; speech = {}; render(); },
  };
}
