// X-ray view: a see-through 3D model of the block you are in (or the whole
// campus), drawn with a small perspective projection on Canvas 2D. Every
// floor is stacked with glass walls so you can look through classrooms,
// stairs climb between floors, people show where they really are, and the
// wiring overlay shows current flowing from each floor's DB to its rooms.
// Rooms lit with nobody inside glow red.
//
// createXray() -> { render(ctx, W, H, info), pick(x, y), orbit(dx, dy), zoom(f), rotate(d), get yaw }
import { FLOORS, BLOCKS, BLOCK_BY_ID, SITE, COLS, ROWS, CORRIDOR } from '../building.js';
import { ROLE_COLORS, PLAYER_COLOR } from './people.js';
import { floorCircuits, campusFeeders, strokeFlow, wireWidth, WIRE, TRUNK_Y, DB_POS } from './wiring.js';

const GAP = 7;                 // floor-to-floor height in the block view (tiles)
const WALL = 3;                // room wall height
const C_STOREY = 1.5;          // storey height inside campus footprints
const STEPS = 14;
const MONO = "'JetBrains Mono', monospace";
const UNLIT_LABEL = new Set(['core', 'electrical', 'roof']);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const placeCache = new Map();
function placements(scene) {
  let p = placeCache.get(scene);
  if (p) return p;
  if (scene === 'CAMPUS') {
    p = [{ level: 0, ox: 0, oy: 0, sx: 1, sy: 1, z: 0, wall: 0, idx: 0, campus: true }];
    for (const b of BLOCKS) {
      const fp = b.footprint;
      b.floors.forEach((lv, i) => p.push({ level: lv, ox: fp.x, oy: fp.y, sx: fp.w / COLS, sy: fp.h / ROWS, z: i * C_STOREY, wall: 0, idx: i, mini: true, blockId: b.id }));
    }
  } else {
    p = BLOCK_BY_ID[scene].floors.map((lv, i) => ({ level: lv, ox: 0, oy: 0, sx: 1, sy: 1, z: i * GAP, wall: FLOORS[lv].isRoof ? 0.8 : WALL, idx: i }));
  }
  placeCache.set(scene, p);
  return p;
}

export function createXray() {
  const cam = { yaw: -0.5, pitch: 0.8, dist: 78, tx: 26, ty: 14.5, th: 0, scene: null };
  let picks = [];
  let B = null;                // camera basis for the current frame

  function setBasis(W, H) {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    B = {
      px: cam.tx + cam.dist * cp * sy, py: cam.ty + cam.dist * cp * cy, ph: cam.th + cam.dist * sp,
      f: [-cp * sy, -cp * cy, -sp], r: [cy, -sy, 0], u: [-sp * sy, -sp * cy, cp],
      foc: Math.min(W, H * 1.6) * 0.95, cx: W / 2, cy: H / 2,
    };
  }
  // World (x, y on the ground, h up) -> [screenX, screenY, depth] or null behind the camera.
  function P(x, y, h) {
    const dx = x - B.px, dy = y - B.py, dh = h - B.ph;
    const zc = dx * B.f[0] + dy * B.f[1] + dh * B.f[2];
    if (zc < 0.6) return null;
    const xc = dx * B.r[0] + dy * B.r[1];
    const yc = dx * B.u[0] + dy * B.u[1] + dh * B.u[2];
    return [B.cx + xc * B.foc / zc, B.cy - yc * B.foc / zc, zc];
  }

  function render(ctx, W, H, info) {
    const { state, level, player, time, wiring, waste, dl, hover } = info;
    const floor = FLOORS[level];
    const scene = floor.isCampus ? 'CAMPUS' : floor.blockId;
    const places = placements(scene);
    const here = places.find((p) => p.level === level) || places[0];
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    const rs = state.rooms || {};

    // Camera follows the player; snap when the scene changes.
    const ptx = here.ox + player.x * here.sx, pty = here.oy + player.y * here.sy, pth = here.z + 1;
    if (cam.scene !== scene) {
      cam.scene = scene;
      cam.dist = scene === 'CAMPUS' ? 72 : 78;
      cam.tx = ptx; cam.ty = pty; cam.th = pth;
    }
    const k = Math.min(1, info.dt * 6);
    cam.tx += (ptx - cam.tx) * k; cam.ty += (pty - cam.ty) * k; cam.th += (pth - cam.th) * k;
    setBasis(W, H);

    // Background: night-blue to day-slate.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const d = Math.max(0, Math.min(1, dl));
    g.addColorStop(0, mix([6, 9, 16], [26, 36, 52], d));
    g.addColorStop(1, mix([3, 5, 9], [12, 17, 25], d));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const items = [];
    const labels = [];
    picks = [];
    const poly = (pts, st, bias = 0, pick = null) => {
      const s = [];
      let dsum = 0;
      for (const p of pts) { const q = P(p[0], p[1], p[2]); if (!q) return; s.push(q); dsum += q[2]; }
      const depth = dsum / s.length + bias;
      items.push({ t: 'poly', s, st, depth });
      if (pick) picks.push({ ...pick, s, depth });
    };
    const rect = (x, y, w, h, z) => [[x, y, z], [x + w, y, z], [x + w, y + h, z], [x, y + h, z]];
    const box = (x, y, w, h, z0, z1, st, bias = 0) => {
      const faces = [
        [[x, y, z0], [x + w, y, z0], [x + w, y, z1], [x, y, z1]],
        [[x + w, y, z0], [x + w, y + h, z0], [x + w, y + h, z1], [x + w, y, z1]],
        [[x + w, y + h, z0], [x, y + h, z0], [x, y + h, z1], [x + w, y + h, z1]],
        [[x, y + h, z0], [x, y, z0], [x, y, z1], [x, y + h, z1]],
      ];
      for (const f of faces) poly(f, st, bias);
    };

    // People grouped by floor.
    const byFloor = new Map();
    for (const p of Array.isArray(state.people) ? state.people : []) {
      if (!p || !Number.isFinite(p.x)) continue;
      if (!byFloor.has(p.floor)) byFloor.set(p.floor, []);
      byFloor.get(p.floor).push(p);
    }

    const roomStyle = (r, a) => {
      const s = rs[r.id] || {};
      const w = waste.minutes(r.id);
      const lit = !!s.lightsOn || (s.powered !== false && (r.type === 'server' || r.type === 'security' || r.type === 'core'));
      if (w != null) {
        return { w, s, fill: `rgba(255,64,64,${(0.3 + 0.25 * pulse) * a})`, wall: `rgba(255,70,70,${(0.1 + 0.12 * pulse) * a})`, edge: `rgba(255,95,95,${0.9 * a})`, lw: 1.6 };
      }
      if (lit) return { w, s, fill: `rgba(255,206,92,${0.26 * a})`, wall: `rgba(255,214,102,${0.05 * a})`, edge: `rgba(255,214,102,${0.55 * a})`, lw: 1 };
      return { w, s, fill: `rgba(70,95,130,${0.14 * a})`, wall: `rgba(120,150,190,${0.025 * a})`, edge: `rgba(140,165,200,${0.3 * a})`, lw: 1 };
    };

    // ---------------------------------------------------------- scene build
    for (const pl of places) {
      const f = FLOORS[pl.level];
      const { ox, oy, sx, sy, z } = pl;
      const X = (x) => ox + x * sx, Y = (y) => oy + y * sy;
      let a = 1;
      if (!floor.isCampus) a = pl.idx === here.idx ? 1 : pl.idx < here.idx ? 0.7 : 0.3;

      if (pl.campus) {
        poly(rect(0, 0, COLS, ROWS, -0.02), { fill: 'rgba(28,48,36,0.55)', edge: 'rgba(90,130,100,0.35)', lw: 1 }, 50);
        poly(rect(-2, ROWS + 0.2, COLS + 4, 4, -0.02), { fill: 'rgba(40,44,52,0.7)', edge: null }, 50);
        for (const r of f.rooms) {
          const col = r.type === 'sports' ? 'rgba(60,140,80,0.35)' : r.type === 'parking' ? 'rgba(90,100,115,0.4)' : 'rgba(120,120,100,0.35)';
          poly(rect(r.x, r.y, r.w, r.h, 0), { fill: col, edge: 'rgba(160,180,170,0.3)', lw: 1 }, 20, { kind: 'room', id: r.id, level: 0 });
          labels.push({ at: [r.x + r.w / 2, r.y + r.h / 2, 0.2], text: r.name, sub: '', col: '#9fb3a8', prio: 1 });
        }
        for (const s of SITE.structures) box(s.x, s.y, s.w, s.h, 0, 1.2, { fill: 'rgba(120,110,90,0.25)', edge: 'rgba(200,180,140,0.5)', lw: 1 });
        for (const b of BLOCKS) {
          const fp = b.footprint;
          const top = b.floors.length * C_STOREY;
          box(fp.x, fp.y, fp.w, fp.h, 0, top, { fill: 'rgba(120,160,220,0.04)', edge: 'rgba(140,175,225,0.45)', lw: 1 }, -0.5);
          poly(rect(fp.x, fp.y, fp.w, fp.h, top), { fill: 'rgba(120,160,220,0.03)', edge: 'rgba(140,175,225,0.45)', lw: 1 }, -0.5, { kind: 'block', id: b.id });
          const nW = b.floors.reduce((n, lv) => n + FLOORS[lv].rooms.filter((r) => waste.minutes(r.id) != null).length, 0);
          labels.push({ at: [fp.x + fp.w / 2, fp.y + fp.h / 2, top + 0.6], text: b.name, sub: nW ? `${nW} lit, empty` : '', col: '#e6edf5', warn: nW > 0, prio: 3 });
        }
        drawPeople(byFloor.get(0), (x) => x, (y) => y, 0, 1, 0.9);
        continue;
      }

      if (pl.mini) {
        poly(rect(ox + 0.2, oy + 0.2, COLS * sx - 0.4, ROWS * sy - 0.4, z + 0.01), { fill: 'rgba(40,55,75,0.25)', edge: 'rgba(120,150,190,0.25)', lw: 0.7 }, 1);
        for (const r of f.rooms) {
          if (r.type === 'core' || r.type === 'electrical') continue;
          const st = roomStyle(r, 1);
          poly(rect(X(r.x), Y(r.y), r.w * sx, r.h * sy, z + 0.03), { fill: st.fill, edge: st.w != null ? st.edge : null, lw: 1 }, 0, { kind: 'room', id: r.id, level: pl.level });
        }
        drawPeople(byFloor.get(pl.level), X, Y, z + 0.05, 0.25, 0.9);
        continue;
      }

      // Block floor: slab, corridor, glass rooms, stairs.
      poly(rect(0.5, 0.5, COLS - 1, ROWS - 1, z - 0.06), { fill: `rgba(24,33,46,${0.4 * a})`, edge: `rgba(120,145,180,${0.4 * a})`, lw: 1 }, 3);
      poly(rect(CORRIDOR.x, CORRIDOR.y, CORRIDOR.w, CORRIDOR.h, z), { fill: `rgba(110,130,160,${0.12 * a})`, edge: null }, 2);
      for (const r of f.rooms) {
        const st = roomStyle(r, a);
        const wall = r.type === 'roof' ? 0.6 : pl.wall;
        poly(rect(r.x + 0.1, r.y + 0.1, r.w - 0.2, r.h - 0.2, z + 0.02), { fill: st.fill, edge: st.edge, lw: st.lw }, 1, { kind: 'room', id: r.id, level: pl.level });
        if (wall > 0) box(r.x, r.y, r.w, r.h, z, z + wall, { fill: st.wall, edge: st.edge, lw: st.lw * 0.8 });
        if (hover && hover.id === r.id) poly(rect(r.x, r.y, r.w, r.h, z + wall), { fill: null, edge: 'rgba(255,255,255,0.9)', lw: 2 }, -1);
        if (st.w != null) items.push({ t: 'glow', at: [r.x + r.w / 2, r.y + r.h / 2, z + 1.4], rad: Math.max(r.w, r.h) * 0.75, a: (0.35 + 0.35 * pulse) * Math.max(a, 0.5), depth: 0 });
        roomLabel(r, st, z + wall + 0.4, pl.idx === here.idx, a);
      }
      // Stairs up to the next floor, and the landing.
      if (f.up != null) {
        for (let i = 0; i < STEPS; i++) {
          const y0 = 10 - (i + 1) * (8 / STEPS);
          const h0 = z + (i + 1) * (GAP / STEPS);
          poly(rect(46, y0, 2, 8 / STEPS, h0), { fill: `rgba(175,190,210,${0.32 * Math.max(a, 0.5)})`, edge: `rgba(200,215,235,${0.45 * Math.max(a, 0.5)})`, lw: 0.6 }, 0);
        }
      }
      // Distribution board in the riser.
      box(DB_POS.x - 0.4, DB_POS.y - 0.2, 0.8, 0.4, z, z + 1.8, { fill: `rgba(255,156,58,${0.25 * a})`, edge: `rgba(255,170,90,${0.8 * a})`, lw: 1 });
      drawPeople(byFloor.get(pl.level), X, Y, z, 1, a);
    }

    // Lift shaft through the whole block, cab at the player's floor.
    if (!floor.isCampus) {
      const topZ = places[places.length - 1].z + WALL;
      box(49, 3, 2, 3, 0, topZ, { fill: 'rgba(120,170,230,0.035)', edge: 'rgba(140,185,240,0.35)', lw: 0.8 }, -0.2);
      box(49.15, 3.15, 1.7, 2.7, here.z, here.z + 2.4, { fill: 'rgba(150,200,255,0.16)', edge: 'rgba(170,210,255,0.8)', lw: 1 }, -0.3);
    }

    // The player: a beacon you can spot through every wall.
    {
      const base = [ptx, pty, here.z];
      const q0 = P(base[0], base[1], base[2]), q1 = P(base[0], base[1], base[2] + (floor.isCampus ? 2.5 : 2.2));
      if (q0 && q1) items.push({ t: 'player', q0, q1, depth: q0[2] - 0.5 });
    }

    // ---------------------------------------------------------- draw
    items.sort((m, n) => n.depth - m.depth);
    for (const it of items) {
      if (it.t === 'poly') drawPoly(ctx, it.s, it.st);
      else if (it.t === 'dot') {
        ctx.globalAlpha = it.a;
        if (it.q1) { ctx.strokeStyle = it.col; ctx.lineWidth = Math.max(1, it.r * 0.7); ctx.beginPath(); ctx.moveTo(it.q0[0], it.q0[1]); ctx.lineTo(it.q1[0], it.q1[1]); ctx.stroke(); }
        ctx.fillStyle = it.col;
        ctx.beginPath(); ctx.arc((it.q1 || it.q0)[0], (it.q1 || it.q0)[1], it.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (it.t === 'glow') {
        const q = P(...it.at);
        if (!q) continue;
        const rad = it.rad * B.foc / q[2];
        const gr = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], rad);
        gr.addColorStop(0, `rgba(255,60,60,${it.a})`);
        gr.addColorStop(1, 'rgba(255,60,60,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = gr;
        ctx.fillRect(q[0] - rad, q[1] - rad, rad * 2, rad * 2);
        ctx.globalCompositeOperation = 'source-over';
      } else if (it.t === 'player') {
        const { q0, q1 } = it;
        const gr = ctx.createLinearGradient(q0[0], q0[1], q1[0], q1[1] - 30);
        gr.addColorStop(0, 'rgba(245,179,1,0.9)'); gr.addColorStop(1, 'rgba(245,179,1,0)');
        ctx.strokeStyle = gr; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1] - 30); ctx.stroke();
        ctx.fillStyle = PLAYER_COLOR;
        ctx.beginPath(); ctx.arc(q1[0], q1[1], 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0b0f14'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(q0[0], q0[1], 9 + pulse * 4, (9 + pulse * 4) * 0.45, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245,179,1,${0.8 - pulse * 0.5})`; ctx.lineWidth = 1.5; ctx.stroke();
        labels.push({ q: [q1[0], q1[1] - 12], text: 'YOU', sub: '', col: PLAYER_COLOR, prio: 9 });
      }
    }

    if (wiring) drawWiringOverlay(ctx, places, here, floor, state, waste, time, pulse);
    drawLabels(ctx, labels, W, H);

    // ---------------------------------------------------------- helpers (closures)
    function drawPeople(list, X, Y, z, scale, a) {
      if (!list) return;
      for (const p of list) {
        const h = p.seated ? 1.0 : 1.6;
        const q0 = P(X(p.x), Y(p.y), z), q1 = P(X(p.x), Y(p.y), z + h * scale);
        if (!q0 || !q1) continue;
        const r = Math.max(1.4, Math.min(5, 0.28 * scale * B.foc / q1[2]));
        items.push({ t: 'dot', q0: scale < 0.5 ? q1 : q0, q1: scale < 0.5 ? null : q1, r, col: ROLE_COLORS[p.role] || '#9fb3c8', a, depth: q1[2] - 0.05 });
      }
    }

    function roomLabel(r, st, h, focused, a) {
      if (UNLIT_LABEL.has(r.type) && st.w == null) return;
      const s = st.s;
      if (st.w != null) {
        labels.push({ at: [r.x + r.w / 2, r.y + r.h / 2, h], text: r.id, sub: `LIGHTS ON, EMPTY ${Math.floor(st.w)} min  ${num(s.loadKW).toFixed(1)} kW`, col: '#ff7875', warn: true, prio: focused ? 8 : 6, a: Math.max(a, 0.75) });
        return;
      }
      if (!focused) return;
      const occ = num(s.occupancy);
      const parts = [];
      if (r.seats > 0 || occ > 0) parts.push(`${occ} ppl`);
      parts.push(s.lightsOn ? `${num(s.loadKW).toFixed(1)} kW` : s.offSince != null ? 'AUTO-OFF' : 'off');
      labels.push({ at: [r.x + r.w / 2, r.y + r.h / 2, h], text: r.id, sub: parts.join('  '), col: s.lightsOn ? '#ffd666' : '#8a9bb0', prio: 4 });
    }

    function drawWiringOverlay(ctx, places, here, floor, state, waste, time, pulse) {
      const proj = (pts) => { const o = []; for (const p of pts) { const q = P(p[0], p[1], p[2]); if (!q) return null; o.push(q); } return o; };
      if (floor.isCampus) {
        const cf = campusFeeders(state, waste);
        const z = 0.12;
        strokeFlow(ctx, proj(cf.incomer.pts.map((p) => [p.x, p.y, z])), { color: WIRE.feed, on: true, kW: cf.incomer.kW / 10, time, width: wireWidth(cf.incomer.kW / 8, 2) });
        for (const fd of cf.feeders) {
          strokeFlow(ctx, proj(fd.pts.map((p) => [p.x, p.y, z])), { color: fd.wasteRooms ? WIRE.waste : WIRE.feed, on: fd.kW > 0.05, kW: fd.kW / 4, time, width: wireWidth(fd.kW / 4, 1.5) });
        }
        const q = P(cf.hub.x, cf.hub.y, z);
        if (q) { ctx.fillStyle = WIRE.feed; ctx.fillRect(q[0] - 4, q[1] - 4, 8, 8); labels.push({ q: [q[0], q[1] - 8], text: 'MAIN LT PANEL', sub: `${cf.incomer.kW.toFixed(0)} kW`, col: WIRE.feed, prio: 5 }); }
        return;
      }
      // Riser bus through every floor.
      const top = places[places.length - 1];
      let blockKW = 0;
      const circ = places.map((pl) => { const c = floorCircuits(FLOORS[pl.level], state, waste); blockKW += c.kW; return c; });
      strokeFlow(ctx, proj([[DB_POS.x, DB_POS.y, 0], [DB_POS.x, DB_POS.y, top.z + WALL - 0.3]]), { color: WIRE.feed, on: blockKW > 0.05, kW: blockKW / 3, time, width: wireWidth(blockKW / 3, 2.2) });
      places.forEach((pl, i) => {
        const c = circ[i];
        const a = pl.idx === here.idx ? 1 : pl.idx < here.idx ? 0.55 : 0.3;
        const hz = pl.z + pl.wall - 0.3;
        strokeFlow(ctx, proj([[DB_POS.x, DB_POS.y, hz], [DB_POS.x, TRUNK_Y, hz], [c.minX, TRUNK_Y, hz]]), { color: WIRE.feed, on: c.kW > 0.05, kW: c.kW, time, width: wireWidth(c.kW, 1.6), alpha: a });
        for (const b of c.branches) {
          const lz = hz;
          const lamp = [b.cx - 0.4, b.cy, lz];
          strokeFlow(ctx, proj([[b.cx - 0.4, TRUNK_Y, lz], lamp]), { color: b.waste ? WIRE.waste : WIRE.light, on: b.lightKW > 0, kW: b.lightKW * 4, time, width: wireWidth(b.lightKW, 1), alpha: a });
          strokeFlow(ctx, proj([[b.cx + 0.4, TRUNK_Y, lz], [b.cx + 0.4, b.cy, lz]]), { color: b.waste ? WIRE.waste : WIRE.power, on: b.powKW > 0.05, kW: b.powKW, time, width: wireWidth(b.powKW, 1), alpha: a });
          const q = P(...lamp);
          if (q) {
            ctx.globalAlpha = a;
            ctx.fillStyle = b.waste ? `rgba(255,77,79,${0.6 + 0.4 * pulse})` : b.lightKW > 0 ? WIRE.light : WIRE.off;
            ctx.beginPath(); ctx.arc(q[0], q[1], b.waste ? 4 : 3, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
          }
        }
        const qd = P(DB_POS.x, DB_POS.y, pl.z + 1.9);
        if (qd && pl.idx === here.idx) labels.push({ q: [qd[0], qd[1] - 6], text: `DB-${FLOORS[pl.level].short}`, sub: `${c.kW.toFixed(1)} kW`, col: WIRE.feed, prio: 5 });
      });
    }

    function drawLabels(ctx, labels, W, H) {
      for (const l of labels) if (!l.q) l.q = P(...l.at);
      const vis = labels.filter((l) => l.q && l.q[0] > -50 && l.q[0] < W + 50 && l.q[1] > -20 && l.q[1] < H + 20);
      vis.sort((m, n) => n.prio - m.prio);
      const taken = [];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const l of vis) {
        ctx.font = `700 10.5px ${MONO}`;
        const w1 = ctx.measureText(l.text).width;
        ctx.font = `500 9.5px ${MONO}`;
        const w2 = l.sub ? ctx.measureText(l.sub).width : 0;
        const w = Math.max(w1, w2) + 12, h = l.sub ? 28 : 16;
        const x = l.q[0] - w / 2, y = l.q[1] - h;
        if (taken.some((t) => x < t.x + t.w && x + w > t.x && y < t.y + t.h && y + h > t.y)) continue;
        taken.push({ x, y, w, h });
        ctx.globalAlpha = l.a ?? 1;
        ctx.fillStyle = l.warn ? 'rgba(60,8,10,0.88)' : 'rgba(11,15,20,0.78)';
        ctx.strokeStyle = l.warn ? 'rgba(255,90,90,0.9)' : 'rgba(80,100,130,0.6)';
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, w, h, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = l.col;
        ctx.font = `700 10.5px ${MONO}`;
        ctx.fillText(l.text, l.q[0], y + 8.5);
        if (l.sub) { ctx.font = `500 9.5px ${MONO}`; ctx.fillStyle = l.warn ? '#ffa39e' : '#a8b6c8'; ctx.fillText(l.sub, l.q[0], y + 20.5); }
        ctx.globalAlpha = 1;
      }
    }
  }

  // Nearest pickable thing under a screen point.
  function pick(x, y) {
    let best = null;
    for (const p of picks) if ((!best || p.depth < best.depth) && inPoly(x, y, p.s)) best = p;
    return best ? { kind: best.kind, id: best.id, level: best.level } : null;
  }

  return {
    render,
    pick,
    orbit(dx, dy) {
      cam.yaw -= dx * 0.008;
      cam.pitch = Math.max(0.12, Math.min(1.5, cam.pitch + dy * 0.006));
    },
    zoom(f) { cam.dist = Math.max(10, Math.min(170, cam.dist * f)); },
    rotate(d) { cam.yaw += d; },
    get yaw() { return cam.yaw; },
  };
}

function drawPoly(ctx, s, st) {
  ctx.beginPath();
  ctx.moveTo(s[0][0], s[0][1]);
  for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
  ctx.closePath();
  if (st.fill) { ctx.fillStyle = st.fill; ctx.fill(); }
  if (st.edge) { ctx.strokeStyle = st.edge; ctx.lineWidth = st.lw || 1; ctx.stroke(); }
}

function inPoly(x, y, s) {
  let inside = false;
  for (let i = 0, j = s.length - 1; i < s.length; j = i++) {
    const xi = s[i][0], yi = s[i][1], xj = s[j][0], yj = s[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function mix(a, b, t) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
