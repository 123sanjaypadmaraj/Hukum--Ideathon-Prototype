// People animation tracking (heading + walk phase derived from position
// deltas) and the top-down figure painter shared by people and the player.

export const ROLE_COLORS = {
  student: '#4fc3f7',
  staff: '#b388ff',
  guard: '#ff8a65',
  cleaner: '#81c784',
};
export const PLAYER_COLOR = '#f5b301';

const TAU = Math.PI * 2;
export function lerpAngle(a, b, t) {
  let d = ((b - a) % TAU + TAU * 1.5) % TAU - Math.PI;
  return a + d * t;
}

export function personColor(p) {
  return ROLE_COLORS[p.role] || p.color || '#9fb3c8';
}

export function createPeopleTracker() {
  const map = new Map();
  let frame = 0;
  return {
    update(people, dt) {
      frame++;
      if (!Array.isArray(people)) return;
      for (const p of people) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        let e = map.get(p.id);
        if (!e) {
          e = { x: p.x, y: p.y, floor: p.floor, ang: Math.PI / 2, phase: Math.random() * TAU, moving: 0, seen: frame };
          map.set(p.id, e);
        }
        const dx = p.x - e.x, dy = p.y - e.y;
        const d = Math.hypot(dx, dy);
        if (d > 3 || p.floor !== e.floor) {
          e.moving = 0;
        } else if (d > 0.002) {
          e.ang = lerpAngle(e.ang, Math.atan2(dy, dx), Math.min(1, dt * 12));
          e.phase += Math.min(d, 0.25) * 10;
          e.moving = 1;
        } else {
          e.moving = Math.max(0, e.moving - dt * 4);
        }
        e.x = p.x; e.y = p.y; e.floor = p.floor; e.seen = frame;
      }
      if (frame % 300 === 0) for (const [id, e] of map) if (frame - e.seen > 300) map.delete(id);
    },
    get(id) { return map.get(id); },
  };
}

// Draw a small top-down figure at screen (x, y); s = css px per tile.
export function drawFigure(ctx, x, y, s, ang, phase, moving, color, { seated = false, scale = 1, outline = null } = {}) {
  const k = s * scale;
  if (k < 9) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, Math.max(1.6, k * 0.2), 0, TAU); ctx.fill();
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(k * 0.05, k * 0.07, k * 0.24, k * 0.2, 0, 0, TAU); ctx.fill();
  ctx.rotate(ang);
  const swing = seated ? 0 : Math.sin(phase) * 0.14 * k * Math.min(1, moving);
  if (!seated && moving > 0.05) {
    ctx.fillStyle = '#1a212c';
    ctx.beginPath(); ctx.ellipse(swing, -k * 0.075, k * 0.085, k * 0.055, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-swing, k * 0.075, k * 0.085, k * 0.055, 0, 0, TAU); ctx.fill();
  }
  // arms
  ctx.fillStyle = shade(color, -0.25);
  ctx.beginPath(); ctx.ellipse(-swing * 0.6, -k * 0.22, k * 0.065, k * 0.05, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(swing * 0.6, k * 0.22, k * 0.065, k * 0.05, 0, 0, TAU); ctx.fill();
  // shoulders / torso
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 0, k * 0.135, k * 0.215, 0, 0, TAU); ctx.fill();
  if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = Math.max(1, k * 0.03); ctx.stroke(); }
  else { ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke(); }
  // head (hair seen from above), nudged toward the heading
  ctx.fillStyle = '#2b211b';
  ctx.beginPath(); ctx.arc(k * 0.02, 0, k * 0.085, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.arc(k * 0.0, -k * 0.03, k * 0.035, 0, TAU); ctx.fill();
  ctx.restore();
}

const shadeCache = new Map();
export function shade(hex, amt) {
  const key = hex + amt;
  let v = shadeCache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  v = `rgb(${f(r)},${f(g)},${f(b)})`;
  shadeCache.set(key, v);
  return v;
}

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0x9fb3c8;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
