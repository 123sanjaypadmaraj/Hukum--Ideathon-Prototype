// Small DOM, formatting and canvas helpers shared by the UI module.

// h('div.card#id', {onclick, title, ...}, child, 'text', [more])
export function h(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function setText(el, text) {
  const s = text == null ? '' : String(text);
  if (el && el.textContent !== s) el.textContent = s;
}

export function setClass(el, cls, on) {
  if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

export function setAttr(el, name, value) {
  const v = value == null ? null : String(value);
  if (!el || el.getAttribute(name) === v) return;
  if (v == null) el.removeAttribute(name); else el.setAttribute(name, v);
}

export function setStyle(el, prop, value) {
  if (el && el.style[prop] !== value) el.style[prop] = value;
}

// Keyed list sync: reuses nodes for existing keys, creates new ones, removes
// stale ones, keeps order. create(item) -> node ; update(node, item).
export function syncList(container, items, keyOf, create, update) {
  const map = container.__keyed || (container.__keyed = new Map());
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let node = map.get(key);
    if (!node) { node = create(item); map.set(key, node); }
    update && update(node, item);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (node !== want) container.insertBefore(node, want);
    prev = node;
  }
  for (const [key, node] of map) {
    if (!seen.has(key)) { node.remove(); map.delete(key); }
  }
}

// ---------- numbers ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const isNum = (v) => num(v) !== null;
export const safe = (v, d = 0) => (num(v) === null ? d : v);

export function fmtKW(v, unit = true) {
  if (num(v) === null) return '—';
  const a = Math.abs(v);
  const s = a >= 100 ? Math.round(v).toLocaleString('en-IN') : a >= 10 ? v.toFixed(1) : v.toFixed(a < 1 && a > 0 ? 2 : 1);
  return unit ? `${s} kW` : s;
}
export function fmtNum(v, digits = 0) {
  if (num(v) === null) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtRs(v, digits = 0) {
  if (num(v) === null) return '—';
  return `Rs ${v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function fmtPct(v, digits = 0, signed = false) {
  if (num(v) === null) return '—';
  const s = (v * 100).toFixed(digits);
  return `${signed && v > 0 ? '+' : ''}${s}%`;
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- colours ----------
let tokenCache = null;
export function tokens() {
  if (tokenCache) return tokenCache;
  const cs = getComputedStyle(document.documentElement);
  const g = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
  tokenCache = {
    bg: g('--bg', '#0b0f14'), bg2: g('--bg-2', '#111821'), panel: g('--panel', '#151d28'), panel2: g('--panel-2', '#1b2532'),
    line: g('--line', '#263243'), text: g('--text', '#e6edf5'), muted: g('--muted', '#8a9bb0'),
    accent: g('--accent', '#f5b301'), accent2: g('--accent-2', '#ffd666'),
    solar: g('--solar', '#ffc53d'), grid: g('--grid', '#69b1ff'), battery: g('--battery', '#95de64'),
    demand: g('--demand', '#ff7a45'), baseline: g('--baseline', '#8c8c8c'),
    danger: g('--danger', '#ff4d4f'), ok: g('--ok', '#52c41a'), warn: g('--warn', '#faad14'), info: g('--info', '#40a9ff'),
    font: g('--font', 'Inter, system-ui, sans-serif'), mono: g('--mono', 'monospace'),
  };
  return tokenCache;
}

export function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Size a canvas to its CSS box at device pixel ratio. Returns null if hidden.
export function fitCanvas(canvas) {
  const w = canvas.clientWidth, hh = canvas.clientHeight;
  if (!w || !hh) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const W = Math.round(w * dpr), H = Math.round(hh * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh, dpr };
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Segmented control. options [{value,label,title}], onPick(value). Returns {el, set(value)}.
export function segmented(options, onPick, cls = '') {
  const el = h(`div.seg${cls ? '.' + cls : ''}`, { role: 'group' });
  const btns = options.map((o) => {
    const b = h('button.seg-btn', { type: 'button', title: o.title || null, onclick: () => onPick(o.value) }, o.label);
    b.dataset.value = String(o.value);
    el.append(b);
    return b;
  });
  return {
    el,
    set(value) {
      for (const b of btns) setClass(b, 'on', b.dataset.value === String(value));
    },
  };
}
