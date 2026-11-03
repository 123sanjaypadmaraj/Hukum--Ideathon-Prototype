// Simulated CCTV: synthetic perspective feeds for every camera on the NHCE campus,
// the CCTV wall (mountWall) and the large modal viewer.
import { bus } from '../bus.js';
import { CAMERAS, CAMERA_BY_ID, ROOM_BY_ID, FLOORS, BLOCKS, BLOCK_BY_ID, SITE } from '../building.js';
import { fmtTime } from '../config.js';
import { minuteOfDay } from '../state.js';
import { buildScene, sceneKey, dynamicItems } from './scenes.js';
import {
  makeView, makeLight, drawShell, drawBox, drawBlob, drawFans, drawHeat,
  postFx, drawNoSignal, drawOverlays, drawDetections, toneFn, drawSky, drawGlows, project,
} from './render.js';
import { drawPerson, personBox } from './figures.js';

const WALL_FPS = 7;
const MODAL_FPS = 20;
const TILE_W = 320, TILE_H = 180;
const MODAL_W = 960, MODAL_H = 540;

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
}

export function createCctv({ state, actions = {} }) {
  let now = 0;
  const scenes = new Map();      // camId -> { key, scene, ver }
  const views = new Map();       // `${camId}|${W}x${H}` -> view
  const bgs = new Map();         // `${camId}|${W}x${H}|${layer}` -> { key, canvas }
  const anims = new Map();       // personId -> { x, y, phase, moving, still }
  const heat = new Map();        // camId -> Float32Array (one cell per tile)
  const hist = new Map();        // camId -> [{ t, det, occ }]
  const meters = new WeakMap();  // canvas -> { last, fps }
  const peopleCount = new Map(); // camId -> people inside (ground truth)
  let peopleById = new Map();
  let lastMin = null;
  let badgeAccum = 0, listAccum = 0;
  const walls = [];
  let modal = null;
  const modalOpts = { boxes: true, privacy: false, heatmap: false };

  const rectOf = (cam) => (cam.kind === 'corridor' ? FLOORS[cam.floor]?.corridor : ROOM_BY_ID[cam.roomId]);
  const camGeo = CAMERAS.map((cam) => ({ cam, rect: rectOf(cam) })).filter((g) => g.rect);
  for (const g of camGeo) heat.set(g.cam.id, new Float32Array(g.rect.w * g.rect.h));
  const geoByFloor = new Map();
  for (const g of camGeo) { if (!geoByFloor.has(g.cam.floor)) geoByFloor.set(g.cam.floor, []); geoByFloor.get(g.cam.floor).push(g); }
  // Where the virtual lens sits (outdoor pole cameras are pulled back a little; see makeView).
  const camPos = (cam) => (cam.kind === 'outdoor' ? [cam.x - Math.cos(cam.facing) * 2.5, cam.y - Math.sin(cam.facing) * 2.5] : [cam.x, cam.y]);
  const boxDepth = (b, pos) => Math.hypot(Math.max(b[0] - pos[0], 0, pos[0] - b[3]), Math.max(b[1] - pos[1], 0, pos[1] - b[4])) - b[2] * 0.01;

  const zoneOf = (cam) => rectOf(cam)?.name || cam.roomId;
  const roomState = (cam) => (cam.kind === 'corridor' ? null : state.rooms?.[cam.roomId] || null);
  const kindLabel = (cam) => (cam.kind === 'corridor' ? 'corridor camera' : cam.kind === 'outdoor' ? 'outdoor pole camera' : 'room camera');
  const camState = (id) => state.cameras?.[id] || {};
  const people = () => (Array.isArray(state.people) ? state.people : []);

  function inRect(p, cam, r) {
    return p && p.floor === cam.floor && Number.isFinite(p.x) && Number.isFinite(p.y)
      && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
  }
  function peopleIn(cam, r) {
    const out = [];
    for (const p of people()) if (inRect(p, cam, r)) out.push(p);
    return out;
  }
  function detCount(id) {
    const cs = camState(id);
    if (Number.isFinite(cs.count)) return cs.count;
    return Array.isArray(cs.detections) ? cs.detections.length : 0;
  }
  function timeStr() {
    const t = Number.isFinite(state.t) ? state.t : 0;
    const secs = Math.floor((t - Math.floor(t)) * 60);
    return `${fmtTime(minuteOfDay(t))}:${String(secs).padStart(2, '0')}`;
  }
  function powerInfo(cam) {
    if (cam.kind === 'outdoor') return { text: 'OUTDOOR', cls: 'outdoor', label: 'outdoor zone', color: '#69b1ff' };
    if (cam.kind === 'corridor') return { text: 'ALWAYS ON', cls: 'on', label: 'POWER: corridor schedule', color: '#95de64' };
    const rs = roomState(cam) || {};
    if (rs.override === 'on') return { text: 'ON (manual)', cls: 'manual', label: 'POWER: manual ON', color: '#69b1ff' };
    if (rs.override === 'off') return { text: 'OFF (manual)', cls: 'manual', label: 'POWER: manual OFF', color: '#69b1ff' };
    if (rs.powered === false) return { text: 'AUTO-OFF', cls: 'off', label: 'POWER: AUTO-OFF (room empty)', color: '#faad14' };
    return { text: 'ON', cls: 'on', label: 'POWER: ON', color: '#95de64' };
  }

  // ----------------------------------------------------------- caches
  function getScene(cam) {
    const key = sceneKey(cam, state);
    let e = scenes.get(cam.id);
    if (!e || e.key !== key) {
      const scene = buildScene(cam, state);
      // Depth = distance to the nearest point of the footprint, so long
      // benches and shelves sort correctly against people beside them.
      const pos = scene.camXY || camPos(cam);
      const fwd = scene.depthMode === 'forward' ? [Math.cos(scene.yaw), Math.sin(scene.yaw)] : null;
      for (const it of scene.furn) {
        if (fwd) it.sd = (it.cen[0] - pos[0]) * fwd[0] + (it.cen[1] - pos[1]) * fwd[1] - (it.k === 'box' ? it.b[2] * 0.01 : 0);
        else if (it.k === 'box') it.sd = boxDepth(it.b, pos);
        else it.sd = Math.hypot(it.p[0] - pos[0], it.p[1] - pos[1]) - it.r - 0.3;
      }
      // Things resting on a bigger box (apparatus, monitors) draw right after it.
      const boxes = scene.furn.filter((it) => it.k === 'box');
      const roots = [];
      for (const it of scene.furn) {
        const fb = it.k === 'box' ? it.b : [it.p[0], it.p[1], it.p[2] - it.r, it.p[0], it.p[1], it.p[2]];
        let parent = null;
        for (const p of boxes) {
          if (p === it) continue;
          const b = p.b;
          if (b[0] - 0.02 <= fb[0] && b[1] - 0.02 <= fb[1] && b[3] + 0.02 >= fb[3] && b[4] + 0.02 >= fb[4]
            && b[5] <= fb[2] + 0.02 && (b[3] - b[0]) * (b[4] - b[1]) > (fb[3] - fb[0]) * (fb[4] - fb[1]) + 1e-6
            && (!parent || b[5] > parent.b[5])) parent = p;
        }
        if (parent) (parent.kids || (parent.kids = [])).push(it); else roots.push(it);
      }
      for (const p of boxes) if (p.kids) p.kids.sort((a, b) => b.sd - a.sd);
      scene.furnSorted = roots.sort((a, b) => b.sd - a.sd);
      e = { key, scene, ver: (e?.ver || 0) + 1 };
      scenes.set(cam.id, e);
    }
    return e;
  }
  function getView(cam, W, H, scene) {
    const k = `${cam.id}|${W}x${H}`;
    let v = views.get(k);
    if (!v) { v = makeView(cam, W, H, scene); views.set(k, v); }
    return v;
  }
  function getBg(cam, v, se, L, layer) {
    const k = `${cam.id}|${v.W}x${v.H}|${layer}`;
    const key = `${L.key}|${se.ver}`;
    let e = bgs.get(k);
    if (e && e.key === key) return e.canvas;
    if (!e) {
      const c = document.createElement('canvas');
      c.width = v.W; c.height = v.H;
      e = { canvas: c, key: '' };
      bgs.set(k, e);
    }
    const g = e.canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, v.W, v.H);
    g.lineJoin = 'round';
    if (se.scene.outdoor) drawSky(g, v, L);
    drawShell(g, v, se.scene, L);
    if (layer === 'full') {
      for (const it of se.scene.furnSorted) {
        drawItem(g, v, se.scene, L, it, 0);
      }
    }
    e.key = key;
    return e.canvas;
  }

  function drawItem(ctx, v, scene, L, it, t) {
    if (it.k === 'box') drawBox(ctx, v, scene, L, it, t); else drawBlob(ctx, v, L, it);
    if (it.kids) for (const k of it.kids) drawItem(ctx, v, scene, L, k, t);
  }

  function lightFor(cam, scene, here) {
    const mod = minuteOfDay(Number.isFinite(state.t) ? state.t : 0);
    const weather = state.scenario?.weather;
    if (cam.kind === 'corridor') {
      const on = (mod >= 6 * 60 + 30 && mod < 22 * 60) || here.length > 0;
      return makeLight({ mod, weather, lightsOn: on, powered: true, fansOn: false, winGain: scene.winGain, alwaysScreens: true });
    }
    const rs = roomState(cam) || {};
    const type = scene.type;
    if (cam.kind === 'outdoor') {
      const night = mod < 6 * 60 + 15 || mod > 18 * 60 + 30;
      const flood = !!rs.lightsOn || (night && here.length > 0);
      return makeLight({ mod, weather, outdoor: true, flood, streetLit: scene.streetLit, powered: true, winGain: 0, alwaysScreens: true });
    }
    return makeLight({
      mod, weather,
      lightsOn: !!rs.lightsOn,
      powered: rs.powered !== false,
      fansOn: !!rs.fansOn,
      winGain: scene.winGain,
      alwaysScreens: type === 'server' || type === 'electrical',
    });
  }

  function pixelate(ctx, canvas, x, y, w, h) {
    x = Math.floor(x); y = Math.floor(y); w = Math.ceil(w); h = Math.ceil(h);
    if (w < 2 || h < 2) return;
    const block = Math.max(2, Math.round(w / 5));
    const sw = Math.max(1, Math.round(w / block)), sh = Math.max(1, Math.round(h / block));
    const tmp = pixelate.c || (pixelate.c = document.createElement('canvas'));
    tmp.width = sw; tmp.height = sh;
    const g = tmp.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(canvas, x, y, w, h, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
    ctx.restore();
  }

  function measure(canvas) {
    let m = meters.get(canvas);
    if (!m) { m = { last: now, fps: 0 }; meters.set(canvas, m); return 0; }
    const dt = now - m.last;
    m.last = now;
    if (dt > 0 && dt < 2) m.fps = m.fps ? m.fps * 0.85 + (1 / dt) * 0.15 : 1 / dt;
    return Math.round(m.fps);
  }

  // ----------------------------------------------------------- renderFeed
  function renderFeed(canvas, cameraId, opts = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cam = CAMERA_BY_ID[cameraId];
    if (!cam || !rectOf(cam)) {
      ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);
      return;
    }
    const small = opts.small ?? W < 480;
    const thumb = !!opts.thumb;
    const boxesOn = opts.boxes !== false;
    const cs = camState(cameraId);
    const online = cs.online !== false;
    const fps = thumb ? 0 : measure(canvas) || cs.fps || 12;
    const pw = powerInfo(cam);
    const info = {
      camId: cam.id, zone: zoneOf(cam), day: state.day || 1, time: timeStr(), now, small,
      count: detCount(cameraId), fps, offline: !online, ir: false,
      power: pw.label, powerColor: pw.color, heat: !!opts.heatmap, privacy: !!opts.privacy,
    };
    if (!online) {
      drawNoSignal(ctx, W, H, now, small);
      if (!thumb) drawOverlays(ctx, W, H, info);
      return;
    }
    try {
      const se = getScene(cam);
      const scene = se.scene;
      const v = getView(cam, W, H, scene);
      const here = peopleIn(cam, scene.rect);
      const L = lightFor(cam, scene, here);
      const pos = scene.camXY || camPos(cam);
      info.ir = L.ir;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.drawImage(getBg(cam, v, se, L, small ? 'full' : 'shell'), 0, 0);
      if (scene.thumbScreens && !thumb) drawThumbScreens(ctx, v, scene, cam.id, L);
      if (opts.heatmap) drawHeat(ctx, v, scene.rect, heat.get(cam.id));
      drawGlows(ctx, v, scene, L, 'pool');
      drawFans(ctx, v, scene, L, now);

      // Depth-sorted people, moving vehicles (and furniture in the large view).
      const tone = toneFn(L, v);
      const fz = scene.floorZ;
      const fwd = scene.depthMode === 'forward';
      const ppl = here.map((p) => ({
        p,
        d: (fwd ? (p.x - pos[0]) * v.fh[0] + (p.y - pos[1]) * v.fh[1] : Math.hypot(p.x - pos[0], p.y - pos[1])) - (p.seated ? (fwd ? 0.2 : 0.75) : 0.15),
      })).sort((a, b) => b.d - a.d);
      const heads = [];
      const drawP = (it) => {
        const hd = drawPerson(ctx, v, it.p, anims.get(it.p.id), tone, fz ? fz(it.p.x, it.p.y) : 0);
        if (hd) heads.push(hd);
      };
      const dyn = scene.outdoor ? dynamicItems(scene, now) : [];
      for (const it of dyn) it.sd = boxDepth(it.b, pos);
      let furn = small ? [] : scene.furnSorted;
      if (dyn.length) furn = [...furn, ...dyn].sort((a, b) => b.sd - a.sd);
      let i = 0, j = 0;
      while (i < furn.length || j < ppl.length) {
        const fd = i < furn.length ? furn[i].sd : -1e9;
        const pd = j < ppl.length ? ppl[j].d : -1e9;
        if (fd >= pd) drawItem(ctx, v, scene, L, furn[i++], now);
        else drawP(ppl[j++]);
      }
      drawGlows(ctx, v, scene, L, 'halo');

      if (opts.privacy) {
        for (const h of heads) {
          const r = h.hr * 1.5;
          if (r < 2.5) { ctx.fillStyle = 'rgba(120,120,120,0.9)'; ctx.fillRect(h.hx - r, h.hy - r, r * 2, r * 2); }
          else pixelate(ctx, canvas, h.hx - r, h.hy - r, r * 2, r * 2);
        }
      }
      ctx.restore();
      if (thumb) return;
      postFx(ctx, W, H, L, small);

      if (boxesOn) {
        const dets = Array.isArray(cs.detections) ? cs.detections : [];
        const boxes = [];
        dets.forEach((d, idx) => {
          if (!d) return;
          const p = peopleById.get(d.personId);
          const x = Number.isFinite(d.x) ? d.x : p?.x, y = Number.isFinite(d.y) ? d.y : p?.y;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          const b = personBox(v, x, y, !!p?.seated, fz ? fz(x, y) : 0);
          if (!b) return;
          const jit = (W / 960) * 1.6;
          const n1 = Math.sin(idx * 12.9 + Math.floor(now * 9) * 7.7), n2 = Math.sin(idx * 4.1 + Math.floor(now * 9) * 3.3);
          b[0] += n1 * jit; b[2] += n2 * jit; b[1] += n2 * jit; b[3] -= n1 * jit;
          if (b[2] < 0 || b[0] > W || b[3] < 0 || b[1] > H) return;
          b[0] = Math.max(1, b[0]); b[1] = Math.max(1, b[1]); b[2] = Math.min(W - 1, b[2]); b[3] = Math.min(H - 1, b[3]);
          const conf = Number.isFinite(d.conf) ? d.conf : 0.9;
          boxes.push({ box: b, conf });
        });
        drawDetections(ctx, W, H, boxes, small);
      }
      drawOverlays(ctx, W, H, info);
    } catch (err) {
      // Never let a feed take the app down.
      ctx.restore?.();
      ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);
      if (!renderFeed.warned) { console.error('[cctv] render failed', err); renderFeed.warned = true; }
    }
  }

  // CCTV control room: the monitor wall shows tiny live thumbnails of other
  // feeds, cycling through the campus every few seconds.
  const thumbs = new Map();        // camId -> { canvas, last }
  let thumbBusy = false;
  function drawThumbScreens(ctx, v, scene, selfId, L) {
    if (!L.screens || thumbBusy) return;
    const ids = CAMERAS.filter((c) => c.id !== selfId && rectOf(c)).map((c) => c.id);
    const n = scene.thumbScreens.length;
    const page = Math.floor(now / 8);
    let refreshed = 0;
    scene.thumbScreens.forEach((sc, k) => {
      const id = ids[(page * n + k) % ids.length];
      let t = thumbs.get(id);
      if (!t) {
        const c = document.createElement('canvas');
        c.width = 128; c.height = 72;
        t = { canvas: c, last: -99 };
        thumbs.set(id, t);
      }
      if (now - t.last > 0.5 && refreshed < 2) {
        refreshed++;
        t.last = now;
        thumbBusy = true;
        try { renderFeed(t.canvas, id, { small: true, thumb: true, boxes: false }); } finally { thumbBusy = false; }
      }
      const a = project(v, ...sc.tl), b = project(v, ...sc.tr), c = project(v, ...sc.bl);
      if (!a || !b || !c) return;
      ctx.save();
      ctx.setTransform((b[0] - a[0]) / 128, (b[1] - a[1]) / 128, (c[0] - a[0]) / 72, (c[1] - a[1]) / 72, a[0], a[1]);
      ctx.globalAlpha = L.ir ? 0.6 : 0.92;
      ctx.drawImage(t.canvas, 0, 0);
      ctx.restore();
    });
  }

  // ----------------------------------------------------------- update loop
  function stepSim(dt) {
    const ps = people();
    const byId = new Map();
    for (const p of ps) {
      if (!p) continue;
      byId.set(p.id, p);
      let a = anims.get(p.id);
      if (!a) { anims.set(p.id, { x: p.x, y: p.y, phase: Math.random() * 6.28, moving: false, still: 0 }); continue; }
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d > 4) { a.moving = false; }
      else if (d > 1e-4) { a.moving = true; a.still = 0; a.phase += dt * 10; }
      else { a.still += dt; if (a.still > 0.3) a.moving = false; }
      a.x = p.x; a.y = p.y;
    }
    peopleById = byId;
    if (anims.size > byId.size + 50) for (const k of anims.keys()) if (!byId.has(k)) anims.delete(k);

    // Occupancy heat (decays over ~30 sim minutes).
    const dtMin = state.paused ? 0 : dt * (state.speed || 1) / 60;
    for (const g of camGeo) peopleCount.set(g.cam.id, 0);
    if (dtMin > 0) {
      const decay = Math.exp(-dtMin / 30);
      for (const grid of heat.values()) for (let i = 0; i < grid.length; i++) grid[i] *= decay;
    }
    for (const p of ps) {
      for (const g of geoByFloor.get(p?.floor) || []) {
        if (!inRect(p, g.cam, g.rect)) continue;
        peopleCount.set(g.cam.id, peopleCount.get(g.cam.id) + 1);
        if (dtMin > 0) {
          const i = Math.floor(p.x - g.rect.x), j = Math.floor(p.y - g.rect.y);
          const grid = heat.get(g.cam.id);
          grid[j * g.rect.w + i] += dtMin;
        }
      }
    }

    // One occupancy sample per sim minute for the sparkline.
    const m = Math.floor(Number.isFinite(state.t) ? state.t : 0);
    if (m !== lastMin) {
      if (lastMin != null && m < lastMin) hist.clear();
      lastMin = m;
      for (const g of camGeo) {
        let arr = hist.get(g.cam.id);
        if (!arr) { arr = []; hist.set(g.cam.id, arr); }
        const cs = camState(g.cam.id);
        const rs = roomState(g.cam);
        arr.push({
          t: m,
          det: cs.online === false ? null : detCount(g.cam.id),
          occ: Number.isFinite(rs?.occupancy) ? rs.occupancy : peopleCount.get(g.cam.id) || 0,
        });
        while (arr.length && arr[0].t < m - 60) arr.shift();
      }
    }
  }

  function update(dtSec) {
    const dt = Math.max(0, Math.min(0.25, Number(dtSec) || 0));
    now += dt;
    try { stepSim(dt); } catch (err) { console.error('[cctv] update failed', err); }

    // Wall tiles: only visible ones, round-robin, ~WALL_FPS each.
    for (let w = walls.length - 1; w >= 0; w--) {
      const wall = walls[w];
      if (!wall.root.isConnected) { wall.io?.disconnect(); walls.splice(w, 1); continue; }
      const due = wall.tiles.filter((t) => t.visible && now - t.last >= 1 / WALL_FPS);
      due.sort((a, b) => a.last - b.last);
      for (const t of due.slice(0, 5)) {
        t.last = now;
        renderFeed(t.canvas, t.camId, { small: true, boxes: true });
      }
    }

    badgeAccum += dt;
    if (badgeAccum >= 0.3) {
      badgeAccum = 0;
      listAccum += 0.3;
      for (const wall of walls) {
        if (listAccum >= 3 && (wall.block === 'busiest' || wall.block === 'autooff')) rebuildPage(wall, false);
        else updateBadges(wall);
      }
      if (listAccum >= 3) listAccum = 0;
      if (modal) updateModalStats();
    }

    if (modal) {
      if (!modal.root.isConnected) { closeModal(true); return; }
      if (now - modal.last >= 1 / MODAL_FPS) {
        modal.last = now;
        renderFeed(modal.canvas, modal.camId, { ...modalOpts, small: false });
      }
    }
  }

  // ----------------------------------------------------------- wall
  // Block picker (built from BLOCKS) + floor sub-filter + quick filters, and
  // a paged grid so only one page of tiles exists and renders at a time.
  const WALL_CAMS = CAMERAS.filter((c) => rectOf(c));
  const isAutoOff = (cam) => cam.kind === 'room' && roomState(cam)?.powered === false;
  const storeyLabel = (f) => (f.isCampus ? 'Site' : f.storey === 'R' ? 'R' : f.storey === 0 ? 'G' : String(f.storey));

  function camsFor(wall) {
    let list = WALL_CAMS;
    if (wall.block === 'busiest') {
      return [...list].filter((c) => camState(c.id).online !== false && detCount(c.id) > 0)
        .sort((a, b) => detCount(b.id) - detCount(a.id)).slice(0, 24);
    }
    if (wall.block === 'autooff') return list.filter(isAutoOff);
    if (wall.block !== 'all') list = list.filter((c) => (c.blockId || FLOORS[c.floor]?.blockId) === wall.block);
    if (wall.floor !== 'all') list = list.filter((c) => String(c.floor) === wall.floor);
    return list;
  }

  function mountWall(host) {
    if (!host) return;
    host.replaceChildren();
    const blockIds = [...BLOCKS.map((b) => b.id), 'CAMPUS'].filter((id) => WALL_CAMS.some((c) => (c.blockId || FLOORS[c.floor]?.blockId) === id));
    const blockLabel = (id) => (id === 'CAMPUS' ? 'Campus' : BLOCK_BY_ID[id]?.short || id);
    const blockName = (id) => (id === 'CAMPUS' ? `${SITE.name} grounds` : BLOCK_BY_ID[id]?.name || id);
    const mk = (key, label, title) => el('button', { class: 'cctv-seg-btn', 'data-key': key, type: 'button', title }, [label, el('span', { class: 'cctv-seg-n' })]);
    const blockBtns = [mk('all', 'All', 'All cameras'), ...blockIds.map((id) => mk(id, blockLabel(id), blockName(id)))];
    const quickBtns = [mk('busiest', 'Busiest', 'Cameras seeing the most people right now'), mk('autooff', 'Auto-off now', 'Rooms HUKUM has switched off')];
    const blockSeg = el('div', { class: 'cctv-seg cctv-seg-wrap', role: 'group', 'aria-label': 'Filter cameras by block' }, blockBtns);
    const quickSeg = el('div', { class: 'cctv-seg', role: 'group', 'aria-label': 'Quick filters' }, quickBtns);
    const floorSeg = el('div', { class: 'cctv-seg cctv-seg-wrap', role: 'group', 'aria-label': 'Filter by floor' });
    const summary = el('div', { class: 'cctv-summary' });
    const grid = el('div', { class: 'cctv-grid' });
    const pageInfo = el('span', { class: 'cctv-page-info' });
    const prevBtn = el('button', { class: 'cctv-btn', type: 'button', text: 'Prev' });
    const nextBtn = el('button', { class: 'cctv-btn', type: 'button', text: 'Next' });
    const pager = el('div', { class: 'cctv-pager' }, [prevBtn, pageInfo, nextBtn]);
    const root = el('div', { class: 'cctv-wall' }, [
      el('div', { class: 'cctv-wall-head' }, [
        el('div', {}, [
          el('div', { class: 'cctv-wall-title', text: `CCTV wall · ${SITE.name}` }),
          el('div', { class: 'cctv-wall-sub', text: `${WALL_CAMS.length} existing cameras across ${BLOCKS.length} blocks and the grounds · YOLO on edge boxes · only counts leave the box` }),
        ]),
      ]),
      el('div', { class: 'cctv-filters' }, [blockSeg, quickSeg, floorSeg]),
      summary,
      grid,
      pager,
      el('p', { class: 'cctv-note', text: 'Frames are analysed in memory on the edge box and never stored or uploaded. Click a feed to open the viewer.' }),
    ]);
    const wall = { root, grid, tiles: [], summary, block: 'all', floor: 'all', page: 0, perPage: 12, io: null, blockBtns, quickBtns, floorSeg, pageInfo, prevBtn, nextBtn, list: [], listKey: '' };

    const select = (key) => {
      wall.block = key; wall.floor = 'all'; wall.page = 0;
      buildFloorSeg(wall);
      rebuildPage(wall, true);
    };
    blockSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-key]'); if (b) select(b.dataset.key); });
    quickSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-key]'); if (b) select(b.dataset.key); });
    floorSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-floor]');
      if (!b) return;
      wall.floor = b.dataset.floor; wall.page = 0;
      for (const x of floorSeg.querySelectorAll('button')) x.classList.toggle('active', x === b);
      rebuildPage(wall, true);
    });
    prevBtn.addEventListener('click', () => { wall.page = Math.max(0, wall.page - 1); rebuildPage(wall, true); });
    nextBtn.addEventListener('click', () => { wall.page += 1; rebuildPage(wall, true); });

    if (typeof IntersectionObserver !== 'undefined') {
      wall.io = new IntersectionObserver((entries) => {
        for (const en of entries) { const t = wall.tiles.find((x) => x.el === en.target); if (t) t.visible = en.isIntersecting; }
      }, { threshold: 0.01 });
    }
    host.append(root);
    walls.push(wall);
    buildFloorSeg(wall);
    rebuildPage(wall, true);
  }

  function buildFloorSeg(wall) {
    const seg = wall.floorSeg;
    seg.replaceChildren();
    const blk = wall.block;
    const floors = blk === 'all' || blk === 'busiest' || blk === 'autooff' ? [] :
      [...new Set(WALL_CAMS.filter((c) => (c.blockId || FLOORS[c.floor]?.blockId) === blk).map((c) => c.floor))].sort((a, b) => a - b);
    seg.hidden = floors.length < 2;
    if (floors.length < 2) return;
    const btn = (key, label, title) => el('button', { class: `cctv-seg-btn${wall.floor === key ? ' active' : ''}`, 'data-floor': key, type: 'button', title }, [label, el('span', { class: 'cctv-seg-n', text: ` ${key === 'all' ? WALL_CAMS.filter((c) => (c.blockId || FLOORS[c.floor]?.blockId) === blk).length : WALL_CAMS.filter((c) => String(c.floor) === key).length}` })]);
    seg.append(btn('all', 'All floors', 'Every floor of this block'), ...floors.map((f) => btn(String(f), storeyLabel(FLOORS[f]), FLOORS[f].name)));
  }

  function makeTile(cam) {
    const canvas = el('canvas', { width: TILE_W, height: TILE_H, 'aria-hidden': 'true' });
    const dot = el('span', { class: 'cctv-dot' });
    const count = el('span', { class: 'cctv-badge cctv-count', title: 'People detected' });
    const power = el('span', { class: 'cctv-badge cctv-power' });
    const f = FLOORS[cam.floor];
    const tile = el('button', {
      class: 'cctv-tile', type: 'button', 'data-cam': cam.id,
      'aria-label': `Open camera ${cam.id}, ${zoneOf(cam)}, ${f?.name || ''}`,
      onclick: () => openFromUi(cam.id),
    }, [
      el('div', { class: 'cctv-tile-screen' }, canvas),
      el('div', { class: 'cctv-tile-bar' }, [
        dot,
        el('span', { class: 'cctv-tile-name', text: zoneOf(cam), title: zoneOf(cam) }),
        el('span', { class: 'cctv-tile-floor', text: f?.isCampus ? '' : f?.short || '' }),
        count, power,
      ]),
    ]);
    return { camId: cam.id, el: tile, canvas, dot, count, power, visible: typeof IntersectionObserver === 'undefined', last: -1 };
  }

  // Rebuild the current page's tiles when the camera list or page changes.
  function rebuildPage(wall, force) {
    const list = camsFor(wall);
    const pages = Math.max(1, Math.ceil(list.length / wall.perPage));
    wall.page = Math.min(wall.page, pages - 1);
    const slice = list.slice(wall.page * wall.perPage, (wall.page + 1) * wall.perPage);
    const key = `${wall.block}|${wall.floor}|${wall.page}|${slice.map((c) => c.id).join(',')}`;
    wall.list = list;
    if (force || key !== wall.listKey) {
      wall.listKey = key;
      wall.io?.disconnect();
      const old = new Map(wall.tiles.map((t) => [t.camId, t]));
      wall.tiles = slice.map((cam) => old.get(cam.id) || makeTile(cam));
      wall.grid.replaceChildren(...wall.tiles.map((t) => t.el));
      if (!slice.length) {
        wall.grid.append(el('p', { class: 'cctv-empty', text: wall.block === 'autooff' ? 'No rooms are switched off right now.' : wall.block === 'busiest' ? 'Nobody is in view of any camera right now.' : 'No cameras here.' }));
      }
      for (const t of wall.tiles) {
        wall.io?.observe(t.el);
        if (t.last < 0) { t.last = now; renderFeed(t.canvas, t.camId, { small: true }); }
      }
    }
    for (const b of [...wall.blockBtns, ...wall.quickBtns]) b.classList.toggle('active', b.dataset.key === wall.block);
    wall.pageInfo.textContent = list.length ? `${wall.page * wall.perPage + 1}-${wall.page * wall.perPage + slice.length} of ${list.length}` : '0 cameras';
    wall.prevBtn.disabled = wall.page === 0;
    wall.nextBtn.disabled = wall.page >= pages - 1;
    wall.root.querySelector('.cctv-pager').hidden = pages < 2;
    updateBadges(wall);
  }

  function updateBadges(wall) {
    // Counts per filter button.
    const byBlock = new Map();
    let autoOff = 0, busy = 0;
    for (const c of WALL_CAMS) {
      const b = c.blockId || FLOORS[c.floor]?.blockId;
      byBlock.set(b, (byBlock.get(b) || 0) + 1);
      if (isAutoOff(c)) autoOff++;
      if (camState(c.id).online !== false && detCount(c.id) > 0) busy++;
    }
    for (const b of wall.blockBtns) {
      const k = b.dataset.key;
      b.lastChild.textContent = ` ${k === 'all' ? WALL_CAMS.length : byBlock.get(k) || 0}`;
    }
    wall.quickBtns[0].lastChild.textContent = ` ${Math.min(24, busy)}`;
    wall.quickBtns[1].lastChild.textContent = ` ${autoOff}`;

    let online = 0, total = 0, ppl = 0, off = 0;
    for (const c of wall.list) {
      const isOn = camState(c.id).online !== false;
      total++; if (isOn) { online++; ppl += detCount(c.id); }
      if (isAutoOff(c)) off++;
    }
    for (const t of wall.tiles) {
      const cam = CAMERA_BY_ID[t.camId];
      const isOn = camState(t.camId).online !== false;
      const n = detCount(t.camId);
      t.dot.className = `cctv-dot ${isOn ? 'online' : 'offline'}`;
      t.dot.title = isOn ? 'Camera online' : 'Camera offline';
      t.count.textContent = isOn ? `${n}` : '--';
      t.count.classList.toggle('zero', !isOn || n === 0);
      const pw = powerInfo(cam);
      t.power.textContent = pw.text;
      t.power.className = `cctv-badge cctv-power ${pw.cls}`;
      t.el.classList.toggle('is-offline', !isOn);
      t.el.classList.toggle('is-selected', !!modal && modal.camId === t.camId);
    }
    wall.summary.replaceChildren(
      el('span', {}, [el('b', { text: `${online}/${total}` }), ' cameras online']),
      el('span', {}, [el('b', { text: `${ppl}` }), ' people detected']),
      el('span', {}, [el('b', { text: `${off}` }), ' rooms auto-off']),
    );
  }

  // ----------------------------------------------------------- modal viewer
  function openFromUi(id) {
    try { actions.openCamera?.(id); } catch (err) { console.error(err); }
    if (!modal || modal.camId !== id) openModal(id);
  }

  function step(dir) {
    if (!modal) return;
    const ids = CAMERAS.filter((c) => rectOf(c)).map((c) => c.id);
    const i = ids.indexOf(modal.camId);
    openModal(ids[(i + dir + ids.length) % ids.length]);
  }

  function toggleBtn(key, labelText) {
    const b = el('button', { class: 'cctv-toggle', type: 'button', 'aria-pressed': String(modalOpts[key]) }, [el('span', { class: 'cctv-switch' }), labelText]);
    b.addEventListener('click', () => { modalOpts[key] = !modalOpts[key]; syncToggles(); });
    return b;
  }
  function syncToggles() {
    if (!modal) return;
    for (const [k, b] of Object.entries(modal.toggles)) b.setAttribute('aria-pressed', String(modalOpts[k]));
  }

  function openModal(id) {
    const cam = CAMERA_BY_ID[id];
    if (!cam || !rectOf(cam)) return;
    const mroot = document.getElementById('modal-root');
    if (!mroot) return;
    if (!modal) buildModal(mroot);
    modal.camId = id;
    modal.last = -1;
    state.ui && (state.ui.modal = 'camera', state.ui.selectedCamera = id);
    modal.camIdEl.textContent = cam.id;
    modal.titleEl.textContent = zoneOf(cam);
    const mount = cam.kind === 'outdoor' ? 'pole mount 5.5 m' : 'ceiling mount 2.8 m';
    modal.metaEl.textContent = `${FLOORS[cam.floor]?.name || ''} \u00b7 ${kindLabel(cam)} \u00b7 ${mount}, ${Math.round((cam.fov || Math.PI / 2) * 180 / Math.PI)} deg lens`;
    modal.overrideSec.hidden = cam.kind !== 'room';
    modal.corridorNote.hidden = cam.kind === 'room';
    modal.corridorNote.textContent = cam.kind === 'outdoor'
      ? 'Outdoor zone: street lights and floodlights follow the campus schedule, not room auto-off.'
      : 'Corridor lights follow the building schedule and are never switched off by HUKUM.';
    updateModalStats();
    renderFeed(modal.canvas, id, { ...modalOpts, small: false });
    for (const w of walls) updateBadges(w);
  }

  function buildModal(mroot) {
    const canvas = el('canvas', { width: MODAL_W, height: MODAL_H, class: 'cctv-modal-canvas', 'aria-label': 'Live camera feed' });
    const camIdEl = el('span', { class: 'cctv-modal-id' });
    const titleEl = el('h2', { class: 'cctv-modal-title' });
    const metaEl = el('div', { class: 'cctv-modal-meta' });
    const closeBtn = el('button', { class: 'cctv-btn', type: 'button', text: 'Close', title: 'Close (Esc)', onclick: () => closeModal() });
    const toggles = {
      boxes: toggleBtn('boxes', 'Detection boxes'),
      privacy: toggleBtn('privacy', 'Privacy blur'),
      heatmap: toggleBtn('heatmap', 'Occupancy heatmap'),
    };
    const stats = el('dl', { class: 'cctv-stats' });
    const spark = el('canvas', { width: 600, height: 150, class: 'cctv-spark', 'aria-label': 'Occupancy over the last hour' });
    const failBtn = el('button', { class: 'cctv-btn cctv-fail', type: 'button' });
    failBtn.addEventListener('click', () => {
      if (!modal) return;
      const id = modal.camId;
      const was = camState(id).online !== false;
      try { actions.setCameraOnline?.(id, !was); } catch (err) { console.error(err); }
      // Fallback if the sim layer is not wired yet.
      if (state.cameras?.[id] && (state.cameras[id].online !== false) === was) state.cameras[id].online = !was;
      updateModalStats();
    });
    const ovButtons = [['Auto', null], ['Force ON', 'on'], ['Force OFF', 'off']].map(([t, m]) => {
      const b = el('button', { class: 'cctv-seg-btn', type: 'button', text: t, 'data-mode': m || 'auto' });
      b.addEventListener('click', () => {
        if (!modal) return;
        const cam = CAMERA_BY_ID[modal.camId];
        try { actions.setRoomOverride?.(cam.roomId, m); } catch (err) { console.error(err); }
        updateModalStats();
      });
      return b;
    });
    const overrideSec = el('section', { class: 'cctv-side-sec' }, [
      el('h3', { text: 'Room power override' }),
      el('div', { class: 'cctv-seg cctv-seg-wide' }, ovButtons),
      el('p', { class: 'cctv-hint', text: 'Manual override always wins over HUKUM.' }),
    ]);
    const corridorNote = el('p', { class: 'cctv-hint', text: 'Corridor lights follow the building schedule and are never switched off by HUKUM.' });

    const root = el('div', { class: 'cctv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Camera viewer' }, [
      el('header', { class: 'cctv-modal-head' }, [
        el('div', { class: 'cctv-modal-titles' }, [el('div', { class: 'cctv-modal-row' }, [camIdEl, titleEl]), metaEl]),
        el('div', { class: 'cctv-modal-nav' }, [
          el('button', { class: 'cctv-btn', type: 'button', text: 'Prev', title: 'Previous camera (Left arrow)', onclick: () => step(-1) }),
          el('button', { class: 'cctv-btn', type: 'button', text: 'Next', title: 'Next camera (Right arrow)', onclick: () => step(1) }),
          closeBtn,
        ]),
      ]),
      el('div', { class: 'cctv-modal-body' }, [
        el('div', { class: 'cctv-modal-view' }, canvas),
        el('aside', { class: 'cctv-modal-side' }, [
          el('section', { class: 'cctv-side-sec' }, [el('h3', { text: 'Live status' }), stats]),
          el('section', { class: 'cctv-side-sec' }, [el('h3', { text: 'View' }), el('div', { class: 'cctv-toggles' }, Object.values(toggles))]),
          el('section', { class: 'cctv-side-sec' }, [
            el('h3', {}, ['Occupancy, last hour ', el('span', { class: 'cctv-legend' }, [el('i', { class: 'det' }), 'camera count ', el('i', { class: 'occ' }), 'actual'])]),
            spark,
          ]),
          el('section', { class: 'cctv-side-sec' }, [
            el('h3', { text: 'Camera health' }),
            failBtn,
            el('p', { class: 'cctv-hint', text: 'If a camera or the AI box fails, HUKUM holds the room power ON (fail-safe).' }),
          ]),
          overrideSec, corridorNote,
        ]),
      ]),
      el('footer', { class: 'cctv-modal-foot', text: 'Left / Right: switch camera · B boxes · P privacy · H heatmap · Esc close' }),
    ]);

    const onKey = (e) => {
      if (!modal) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'b' || e.key === 'B') { modalOpts.boxes = !modalOpts.boxes; syncToggles(); }
      else if (e.key === 'p' || e.key === 'P') { modalOpts.privacy = !modalOpts.privacy; syncToggles(); }
      else if (e.key === 'h' || e.key === 'H') { modalOpts.heatmap = !modalOpts.heatmap; syncToggles(); }
    };
    const onBackdrop = (e) => { if (e.target === mroot) closeModal(); };
    window.addEventListener('keydown', onKey);
    mroot.addEventListener('click', onBackdrop);
    mroot.replaceChildren(root);

    modal = { root, mroot, canvas, camIdEl, titleEl, metaEl, stats, spark, failBtn, ovButtons, overrideSec, corridorNote, toggles, onKey, onBackdrop, camId: null, last: -1 };
    syncToggles();
    closeBtn.focus({ preventScroll: true });
  }

  function closeModal(external = false) {
    if (!modal) return;
    const m = modal;
    modal = null;
    window.removeEventListener('keydown', m.onKey);
    m.mroot.removeEventListener('click', m.onBackdrop);
    if (!external && m.root.parentNode === m.mroot) m.mroot.replaceChildren();
    if (state.ui && state.ui.modal === 'camera') { state.ui.modal = null; state.ui.selectedCamera = null; }
    for (const w of walls) updateBadges(w);
    if (!external) document.getElementById('world')?.focus?.({ preventScroll: true });
  }

  function updateModalStats() {
    if (!modal) return;
    const cam = CAMERA_BY_ID[modal.camId];
    const cs = camState(cam.id);
    const rs = roomState(cam);
    const isOn = cs.online !== false;
    const pw = powerInfo(cam);
    const truth = Number.isFinite(rs?.occupancy) ? rs.occupancy : peopleCount.get(cam.id) || 0;
    const rows = [
      [cam.kind === 'room' ? 'People in room' : 'People in zone', `${truth}`],
      ['Camera count', isOn ? `${detCount(cam.id)}` : 'offline'],
      ['Power', pw.text],
    ];
    if (rs) {
      if (cam.kind === 'outdoor') rows.push(['Zone lighting', rs.lightsOn ? 'on' : 'off']);
      else rows.push(['Lights / fans / AC', `${rs.lightsOn ? 'on' : 'off'} / ${rs.fansOn ? 'on' : 'off'} / ${rs.acOn ? 'on' : 'off'}`]);
      if (Number.isFinite(rs.tempC) && cam.kind !== 'outdoor') rows.push(['Room temp', `${rs.tempC.toFixed(1)} C`]);
      if (Number.isFinite(rs.loadKW)) rows.push(['Load now', `${rs.loadKW.toFixed(1)} kW`]);
      const ls = rs.lastSeenT;
      rows.push(['Last detection', Number.isFinite(ls) ? (state.t - ls < 1 ? 'now' : `${Math.round(state.t - ls)} min ago`) : 'none today']);
    }
    rows.push(['Edge inference', isOn ? `YOLO, ${cs.fps || 12} fps, frames discarded` : 'no frames']);
    modal.stats.replaceChildren(...rows.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })]));
    modal.failBtn.textContent = isOn ? 'Simulate camera failure' : 'Restore camera';
    modal.failBtn.classList.toggle('danger', isOn);
    const mode = rs?.override || 'auto';
    for (const b of modal.ovButtons) b.classList.toggle('active', b.dataset.mode === mode);
    drawSpark();
  }

  function drawSpark() {
    const c = modal.spark, g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0d131b'; g.fillRect(0, 0, W, H);
    const arr = hist.get(modal.camId) || [];
    const tNow = Math.floor(Number.isFinite(state.t) ? state.t : 0);
    let max = 4;
    for (const s of arr) max = Math.max(max, s.occ || 0, s.det || 0);
    max = Math.ceil(max / 5) * 5;
    const padL = 34, padR = 10, padT = 12, padB = 24;
    const X = (t) => padL + ((t - (tNow - 60)) / 60) * (W - padL - padR);
    const Y = (n) => H - padB - (n / max) * (H - padT - padB);
    g.strokeStyle = '#263243'; g.lineWidth = 1;
    g.font = '18px "JetBrains Mono", monospace';
    g.fillStyle = '#8a9bb0';
    g.textBaseline = 'middle';
    for (const n of [0, max / 2, max]) {
      g.beginPath(); g.moveTo(padL, Y(n)); g.lineTo(W - padR, Y(n)); g.stroke();
      g.fillText(String(n), 4, Y(n));
    }
    g.textBaseline = 'alphabetic';
    g.fillText('-60 min', padL, H - 4);
    g.textAlign = 'right'; g.fillText('now', W - padR, H - 4); g.textAlign = 'left';
    const line = (key, color, width, dash) => {
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash);
      g.beginPath();
      let pen = false;
      for (const s of arr) {
        const val = s[key];
        if (val == null) { pen = false; continue; }
        const x = X(s.t), y = Y(val);
        if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
      }
      g.stroke(); g.setLineDash([]);
    };
    line('occ', '#8a9bb0', 2, [6, 5]);
    line('det', '#3cf0a0', 3, []);
    if (!arr.length) { g.fillStyle = '#8a9bb0'; g.fillText('collecting samples...', padL + 10, H / 2); }
  }

  bus.on('ui:openCamera', (p) => { if (p && p.id) openModal(p.id); });

  return { mountWall, renderFeed, update, openCamera: openModal, closeCamera: () => closeModal() };
}
