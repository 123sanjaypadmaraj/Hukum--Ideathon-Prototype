// First-person raycaster (Wolfenstein-style DDA) over the same floor grid.
// Renders into a low-res ImageData buffer: textured floors and ceilings with
// per-room lighting (lit ceiling panels vs dark auto-off rooms), painted walls
// with exterior windows showing the sky, people as billboard sprites.
import { FLOORS, COLS, ROWS, TILE, BLOCKS, SITE } from '../building.js';
import { groundAt, blockGeom } from './campus.js';
import { hexToRgb } from './people.js';

const FLOOR_RGB = {
  classroom: [112, 118, 132], lab: [104, 124, 128], seminar: [92, 76, 112], library: [124, 96, 70],
  office: [108, 114, 128], lobby: [138, 138, 144], canteen: [128, 124, 108], server: [86, 96, 112],
  electrical: [98, 98, 104], parking: [76, 78, 84], core: [108, 110, 118], plant: [92, 96, 100],
  roof: [88, 90, 96], corridor: [100, 108, 124], door: [110, 116, 128],
};
const WALL_RGB = {
  classroom: [186, 194, 206], lab: [176, 198, 200], seminar: [150, 118, 96], library: [184, 160, 128],
  office: [190, 190, 196], lobby: [200, 200, 204], canteen: [196, 186, 160], server: [120, 140, 170],
  electrical: [160, 160, 150], parking: [140, 140, 140], core: [170, 172, 180], plant: [140, 146, 152],
  roof: [150, 150, 154], corridor: [170, 178, 192],
};
// Floor patterns: 0 tiles, 1 carpet, 2 planks, 3 checker, 4 concrete, 5 raised floor, 6 solar panels
const PATTERN = {
  classroom: 0, lab: 0, office: 0, lobby: 0, core: 0, corridor: 0, door: 0,
  seminar: 1, library: 2, canteen: 3, electrical: 4, parking: 4, plant: 4, roof: 4, server: 5,
};
// Campus ground colours by ground code (see campus.js G).
const GROUND_RGB = [[62, 104, 58], [124, 126, 132], [62, 64, 70], [150, 68, 50], [78, 128, 70], [60, 92, 140], [134, 134, 138], [90, 90, 90], [44, 84, 48]];
const BLOCK_RGB = { MB: [196, 186, 166], SVP: [188, 176, 160], NSB: [176, 182, 188], NSC: [190, 184, 172], AUD: [168, 150, 160], AMN: [196, 178, 150] };
const SKIN = [[224, 172, 105], [198, 134, 66], [141, 85, 36], [241, 194, 125], [170, 110, 60]];

const tileCache = new Map();
function tileInfo(level) {
  let t = tileCache.get(level);
  if (t) return t;
  const f = FLOORS[level];
  const n = COLS * ROWS;
  const room = new Int16Array(n).fill(-2);   // room index, -1 corridor, -2 wall, -3 door
  const pat = new Uint8Array(n);
  const fr = new Uint8Array(n * 3);
  const wr = new Uint8Array(n * 3);
  const oy = new Float32Array(n);            // room origin y (for PV rows)
  const ox = new Float32Array(n);
  const wallH = new Float32Array(n).fill(1);   // wall height in units (campus buildings are taller)
  const wallKind = new Uint8Array(n);          // 0 interior wall, 1 building, 2 structure, 3 boundary
  const wallBlock = new Int8Array(n).fill(-1);
  const wallStoreys = new Uint8Array(n);
  const campus = !!f.isCampus;
  if (campus) {
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (f.grid[y][x] !== TILE.WALL) continue;
      const i = y * COLS + x;
      let rgb = [150, 92, 72], h = 0.45, kind = 3;
      BLOCKS.forEach((b, bi) => {
        const fp = b.footprint;
        if (fp && x >= fp.x && x < fp.x + fp.w && y >= fp.y && y < fp.y + fp.h) {
          const gm = blockGeom(b.id);
          kind = 1; wallBlock[i] = bi; wallStoreys[i] = gm ? gm.storeys : 1;
          h = b.id === 'AUD' ? 2.2 : 0.5 + (gm ? gm.storeys : 1) * 0.8;
          rgb = BLOCK_RGB[b.id] || [186, 180, 170];
        }
      });
      for (const st of SITE.structures) if (x >= st.x && x < st.x + st.w && y >= st.y && y < st.y + st.h) { kind = 2; h = 0.7; rgb = [120, 126, 134]; }
      wallH[i] = h; wallKind[i] = kind;
      wr[i * 3] = rgb[0]; wr[i * 3 + 1] = rgb[1]; wr[i * 3 + 2] = rgb[2];
    }
  }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const i = y * COLS + x;
    const g = f.grid[y][x];
    let type = 'corridor';
    if (g === TILE.WALL) { room[i] = -2; continue; }
    if (g === TILE.DOOR) { room[i] = -3; type = 'door'; }
    else if (g === TILE.CORRIDOR) { room[i] = -1; type = f.isRoof ? 'roof' : 'corridor'; }
    else {
      const ri = f.rooms.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      room[i] = ri;
      if (ri >= 0) { type = f.rooms[ri].type; oy[i] = f.rooms[ri].y; ox[i] = f.rooms[ri].x; }
    }
    let p = PATTERN[type] ?? 0;
    if (type === 'roof' && g === TILE.ROOM) p = 6;
    if (campus) p = 7;
    pat[i] = p;
    const fc = FLOOR_RGB[type] || FLOOR_RGB.office;
    const wc = WALL_RGB[type === 'door' ? 'corridor' : type] || WALL_RGB.office;
    fr[i * 3] = fc[0]; fr[i * 3 + 1] = fc[1]; fr[i * 3 + 2] = fc[2];
    if (!campus) { wr[i * 3] = wc[0]; wr[i * 3 + 1] = wc[1]; wr[i * 3 + 2] = wc[2]; }
  }
  t = { room, pat, fr, wr, oy, ox, grid: f.grid, campus, wallH, wallKind, wallBlock, wallStoreys };
  tileCache.set(level, t);
  return t;
}

const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function createFP() {
  const off = document.createElement('canvas');
  const octx = off.getContext('2d');
  let W = 0, H = 0, img = null, buf = null, zbuf = null;
  const light = new Float32Array(COLS * ROWS);
  const lit = new Uint8Array(COLS * ROWS);

  function ensure(w, h) {
    if (w === W && h === H) return;
    W = w; H = h;
    off.width = W; off.height = H;
    img = octx.createImageData(W, H);
    buf = new Uint32Array(img.data.buffer);
    zbuf = new Float32Array(W);
  }

  // info: { level, px, py, dir, roomLights:[{light,lit}], corridorLight, daylight, sprites:[{x,y,kind,color,seated,phase,moving,online,seed}] }
  function render(ctx, cssW, cssH, info) {
    const res = Math.max(200, Math.min(560, Math.round(cssW / 2)));
    const w = res, h = Math.max(120, Math.round(res * cssH / Math.max(1, cssW)));
    ensure(w, h);
    const T = tileInfo(info.level);
    const isRoofFloor = !!(FLOORS[info.level] && FLOORS[info.level].isRoof);
    const roof = isRoofFloor || T.campus;          // open sky overhead

    // Per-tile light for this frame.
    const RL = info.roomLights;
    for (let i = 0; i < light.length; i++) {
      const r = T.room[i];
      if (r >= 0) { const L = RL[r]; light[i] = L ? L.light : 0.5; lit[i] = L && L.lit ? 1 : 0; }
      else if (r === -1 || r === -3) { light[i] = info.corridorLight; lit[i] = info.corridorLit ? 1 : 0; }
      else { light[i] = 0.5; lit[i] = 0; }
    }

    const px = info.px, py = info.py;
    const dirX = Math.cos(info.dir), dirY = Math.sin(info.dir);
    const K = 0.68;
    const plX = -dirY * K, plY = dirX * K;
    const horizon = H >> 1;
    const dl = info.daylight;

    // Sky colours (roof ceiling + exterior windows)
    const skyTop = mix3([10, 14, 28], [70, 128, 196], dl);
    const skyBot = mix3([22, 30, 50], [170, 196, 226], dl);
    const fogC = roof ? mix3([10, 14, 24], [150, 176, 206], dl) : [8, 11, 16];
    const fogK = roof ? 0.035 : 0.075;

    const rdx0 = dirX - plX, rdy0 = dirY - plY, rdx1 = dirX + plX, rdy1 = dirY + plY;

    // -------- floor + ceiling
    for (let y = horizon + 1; y < H; y++) {
      const p = y - horizon;
      const rowDist = (0.5 * H) / p;
      const sx = rowDist * (rdx1 - rdx0) / W, sy = rowDist * (rdy1 - rdy0) / W;
      let fx = px + rowDist * rdx0, fy = py + rowDist * rdy0;
      const fog = Math.exp(-rowDist * fogK);
      const yc = 2 * horizon - y;
      const rowF = y * W, rowC = yc * W;
      let skyPix = 0;
      if (roof) {
        const tt = yc / horizon;
        skyPix = pack(lerp(skyTop[0], skyBot[0], tt), lerp(skyTop[1], skyBot[1], tt), lerp(skyTop[2], skyBot[2], tt));
      }
      for (let x = 0; x < W; x++, fx += sx, fy += sy) {
        const tx = Math.floor(fx), ty = Math.floor(fy);
        if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) {
          buf[rowF + x] = pack(fogC[0] * (1 - fog), fogC[1] * (1 - fog), fogC[2] * (1 - fog));
          buf[rowC + x] = roof ? skyPix : buf[rowF + x];
          continue;
        }
        const i = ty * COLS + tx;
        const ux = fx - tx, uy = fy - ty;
        let r = T.fr[i * 3], g = T.fr[i * 3 + 1], b = T.fr[i * 3 + 2];
        let m = 1;
        switch (T.pat[i]) {
          case 0: if (ux < 0.035 || uy < 0.035) m = 0.78; else if ((tx + ty) & 1) m = 0.94; break;
          case 1: m = 0.9 + hash((fx * 12) | 0, (fy * 12) | 0) * 0.12; break;
          case 2: { const pl = (fy * 4) | 0; m = 0.86 + hash(pl, ((fx + pl * 0.37) * 0.7) | 0) * 0.18; if (fy * 4 - pl < 0.06) m = 0.72; break; }
          case 3: m = ((tx + ty) & 1) ? 1.08 : 0.72; break;
          case 4: m = 0.88 + hash((fx * 9) | 0, (fy * 9) | 0) * 0.14; break;
          case 5: if (((fx * 1.667) % 1) < 0.05 || ((fy * 1.667) % 1) < 0.05) m = 0.7; break;
          case 7: {
            const gc = groundAt(fx, fy);
            const c = GROUND_RGB[gc] || GROUND_RGB[0];
            r = c[0]; g = c[1]; b = c[2];
            if (gc === 0 || gc === 4 || gc === 8) m = 0.86 + hash((fx * 8) | 0, (fy * 8) | 0) * 0.2;
            else if (gc === 1 || gc === 6) { if (((fx * 2) % 1) < 0.05 || ((fy * 2) % 1) < 0.05) m = 0.8; }
            else if (gc === 3) { const tt = ((fx * 3) % 1); if (tt < 0.04) { r = 220; g = 220; b = 220; } }
            break;
          }
          case 6: {
            const ly = (fy - T.oy[i] - 0.5) % 2.1, lx = (fx - T.ox[i] - 0.6) % 5.4;
            if (ly >= 0 && ly < 1.4 && lx >= 0 && lx < 4.8) {
              r = 34; g = 64; b = 118;
              if (((fx * 2.5) % 1) < 0.08 || ((ly * 2.86) % 1) < 0.08) { r = 70; g = 100; b = 150; }
            }
            break;
          }
          default: break;
        }
        const L = light[i] * m * fog;
        const warm = lit[i] && !roof ? 1 : 0;
        const fr = r * L + fogC[0] * (1 - fog), fg = g * L + fogC[1] * (1 - fog), fb = b * L * (warm ? 0.9 : 1) + fogC[2] * (1 - fog);
        buf[rowF + x] = pack(fr, fg, fb);
        if (roof) { buf[rowC + x] = skyPix; continue; }
        // Ceiling: light panels every 3 tiles in rooms.
        const isRoom = T.room[i] >= 0;
        let cr = 150, cg = 152, cb = 158, cl = light[i];
        if (isRoom && tx % 3 === 1 && ty % 3 === 1 && ux > 0.15 && ux < 0.85 && uy > 0.35 && uy < 0.65) {
          if (lit[i]) { cr = 255; cg = 244; cb = 220; cl = 1.15; } else { cr = 90; cg = 94; cb = 100; }
        } else if (!isRoom && T.room[i] === -1 && ty === 14 && tx % 2 === 0 && ux < 0.6 && uy > 0.4 && uy < 0.6) {
          if (lit[i]) { cr = 240; cg = 244; cb = 255; cl = 1.1; }
        } else if (ux < 0.02 || uy < 0.02) { cl *= 0.85; }
        const cf = cl * fog;
        buf[rowC + x] = pack(cr * cf + fogC[0] * (1 - fog), cg * cf + fogC[1] * (1 - fog), cb * cf + fogC[2] * (1 - fog));
      }
    }
    {
      // Horizon row, and row 0 which the mirrored ceiling pass can miss.
      const hrow = horizon * W;
      for (let x = 0; x < W; x++) buf[hrow + x] = roof ? pack(skyBot[0], skyBot[1], skyBot[2]) : pack(fogC[0], fogC[1], fogC[2]);
      if (2 * horizon - (H - 1) > 0) buf.copyWithin(0, W, 2 * W);
    }

    // -------- walls
    const grid = T.grid;
    for (let x = 0; x < W; x++) {
      const camX = 2 * x / W - 1;
      const rdx = dirX + plX * camX, rdy = dirY + plY * camX;
      let mx = Math.floor(px), my = Math.floor(py);
      const ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9));
      let stepX, stepY, sdx, sdy;
      if (rdx < 0) { stepX = -1; sdx = (px - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - px) * ddx; }
      if (rdy < 0) { stepY = -1; sdy = (py - my) * ddy; } else { stepY = 1; sdy = (my + 1 - py) * ddy; }
      let side = 0, hit = false, pmx = mx, pmy = my;
      for (let k = 0; k < 96; k++) {
        pmx = mx; pmy = my;
        if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
        if (mx < 0 || my < 0 || mx >= COLS || my >= ROWS) break;
        if (grid[my][mx] === TILE.WALL) { hit = true; break; }
      }
      if (!hit) { zbuf[x] = 1e9; continue; }
      const perp = Math.max(0.02, side === 0 ? sdx - ddx : sdy - ddy);
      zbuf[x] = perp;
      const lineH = H / perp;
      // Roof: low parapets, except the stair head structure.
      const mi = my * COLS + mx;
      const wallTop = T.campus ? T.wallH[mi] : isRoofFloor && mx < 44 ? 0.32 : 1;
      const y0 = horizon - lineH * (wallTop - 0.5);
      const y1 = horizon + lineH * 0.5;
      const ys = Math.max(0, Math.ceil(y0)), ye = Math.min(H - 1, Math.floor(y1));
      let wx = side === 0 ? py + perp * rdy : px + perp * rdx;
      wx -= Math.floor(wx);
      const pi = pmy * COLS + pmx;
      const inBounds = pmx >= 0 && pmy >= 0 && pmx < COLS && pmy < ROWS;
      const src = T.campus ? mi : pi;
      const wr = inBounds ? T.wr[src * 3] : 160, wg = inBounds ? T.wr[src * 3 + 1] : 160, wb = inBounds ? T.wr[src * 3 + 2] : 160;
      const Lw = (T.campus ? info.corridorLight : inBounds ? light[pi] : 0.5) * (side ? 0.8 : 1);
      const kind = T.campus ? T.wallKind[mi] : 0;
      const storeys = T.campus ? T.wallStoreys[mi] : 0;
      const bLit = kind === 1 && info.blockLit ? (info.blockLit[T.wallBlock[mi]] || 0) : 0;
      const warm = inBounds && lit[pi] && !roof;
      const fog = Math.exp(-perp * fogK);
      const outer = !roof && (mx === 0 || my === 0 || mx === COLS - 1 || my === ROWS - 1);
      for (let y = ys; y <= ye; y++) {
        const v = (y - y0) / (y1 - y0);
        let r = wr, g = wg, b = wb, m = 1, emissive = false;
        if (kind === 1) {                                  // campus building facade
          const zf = (1 - v) * wallTop;                    // height above ground
          const sH = (wallTop - 0.2) / Math.max(1, storeys);
          if (zf > wallTop - 0.14) m = 1.12;               // parapet
          else if (zf < 0.05) m = 0.5;
          else {
            const si = Math.floor(zf / sH), fz = (zf - si * sH) / sH, fu = (wx * 2.2) % 1;
            if (si < storeys && fz > 0.3 && fz < 0.8 && fu > 0.15 && fu < 0.85) {
              const on = hash(mx * 7 + ((wx * 2.2) | 0), my * 13 + si) < bLit;
              if (on && dl < 0.7) { r = 255; g = 214; b = 140; emissive = true; }
              else { const tt = 1 - fz; r = lerp(skyTop[0], skyBot[0], tt) * 0.55; g = lerp(skyTop[1], skyBot[1], tt) * 0.6; b = lerp(skyTop[2], skyBot[2], tt) * 0.7; m = 1; if (on) { r += 40; g += 30; } }
            } else if (fz < 0.06) m = 0.82;
          }
        } else if (kind === 2) {
          m = v < 0.1 ? 1.1 : 0.85;
        } else if (kind === 3) {
          if (v < 0.15) { r = 170; g = 160; b = 150; } else if ((((wx * 4) | 0) + ((v * 6) | 0)) & 1) m = 0.9;
        } else if (roof && wallTop < 1) {
          if (v < 0.12) m = 1.15; else m = 0.85;
        } else {
          if (v > 0.93) m = 0.42;                              // skirting
          else if (v > 0.6 && v < 0.62) m = 0.75;              // dado rail
          else if (v > 0.62) m = 0.9;
          if (outer && v > 0.18 && v < 0.55) {
            const fu = (wx * 2) % 1;
            if (fu < 0.06 || v < 0.2 || v > 0.53) { r = 60; g = 66; b = 76; m = 1; }
            else {
              const tt = (v - 0.18) / 0.37;
              r = lerp(skyTop[0], skyBot[0], tt); g = lerp(skyTop[1], skyBot[1], tt); b = lerp(skyTop[2], skyBot[2], tt);
              emissive = true;
            }
          }
        }
        const L = emissive ? 0.9 : Lw * m;
        buf[y * W + x] = pack(r * L * fog + fogC[0] * (1 - fog), g * L * fog + fogC[1] * (1 - fog), b * L * fog * (warm && !emissive ? 0.92 : 1) + fogC[2] * (1 - fog));
      }
    }

    // -------- sprites
    const invDet = 1 / (plX * dirY - dirX * plY);
    const sprites = [];
    for (const s of info.sprites) {
      const dx = s.x - px, dy = s.y - py;
      const tX = invDet * (dirY * dx - dirX * dy);
      const tY = invDet * (-plY * dx + plX * dy);
      if (tY < 0.15 || tY > 40) continue;
      sprites.push({ s, tX, tY });
    }
    sprites.sort((a, b) => b.tY - a.tY);
    for (const sp of sprites) drawSprite(sp, T);

    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;

    // Vignette + crosshair
    const vg = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(245,179,1,0.7)'; ctx.lineWidth = 1.5;
    const cx = cssW / 2, cy = cssH / 2;
    ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx - 3, cy); ctx.moveTo(cx + 3, cy); ctx.lineTo(cx + 9, cy);
    ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy - 3); ctx.moveTo(cx, cy + 3); ctx.lineTo(cx, cy + 9); ctx.stroke();
    compass(ctx, cssW, info.dir);

    function drawSprite({ s, tX, tY }) {
      const scrX = (W / 2) * (1 + tX / tY);
      const sH = H / tY;
      const tx = Math.floor(s.x), ty = Math.floor(s.y);
      const ti = ty * COLS + tx;
      const Ls = (ti >= 0 && ti < light.length ? light[ti] : 0.6);
      const fog = Math.exp(-tY * fogK);
      if (s.kind === 'camera') {
        const wS = 0.16 * sH, hS = 0.08 * sH;
        const cyS = horizon + (0.5 - 0.9) * sH;
        const x0 = Math.round(scrX - wS / 2), x1 = Math.round(scrX + wS / 2);
        const yA = Math.max(0, Math.round(cyS - hS / 2)), yB = Math.min(H - 1, Math.round(cyS + hS / 2));
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          if (tY >= zbuf[x]) continue;
          const u = (x - x0) / Math.max(1, x1 - x0);
          for (let y = yA; y <= yB; y++) {
            const v = (y - yA) / Math.max(1, yB - yA);
            let r = 200, g = 206, b = 214;
            if (u > 0.68 && v > 0.25 && v < 0.75) { r = 20; g = 24; b = 30; }
            if (u < 0.2 && v < 0.4) { if (s.online) { r = 82; g = 196; b = 26; } else { r = 255; g = 60; b = 60; } }
            const L = (u < 0.2 && v < 0.4) ? 1 : Ls * fog;
            buf[y * W + x] = pack(r * L, g * L, b * L);
          }
        }
        return;
      }
      const ph = s.seated ? 0.44 : 0.62;
      const wS = 0.34 * sH;
      const top = horizon + (0.5 - ph) * sH;
      const bot = horizon + 0.5 * sH;
      const x0 = scrX - wS / 2;
      const xa = Math.max(0, Math.floor(x0)), xb = Math.min(W - 1, Math.ceil(scrX + wS / 2));
      const ya = Math.max(0, Math.floor(top)), yb = Math.min(H - 1, Math.ceil(bot));
      const [cr, cg, cb] = s.rgb;
      const skin = SKIN[s.seed % SKIN.length];
      const bob = s.moving ? Math.abs(Math.sin(s.phase)) * 0.012 : 0;
      const legSplit = s.moving ? Math.sin(s.phase) * 0.02 : 0;
      for (let x = xa; x <= xb; x++) {
        if (tY >= zbuf[x]) continue;
        const dxw = ((x - x0) / wS - 0.5) * 0.34;     // world metres from centre line
        const adx = Math.abs(dxw);
        if (adx > 0.15) continue;
        for (let y = ya; y <= yb; y++) {
          const z = (y - top) / (bot - top) * ph - bob;  // world metres from top of head
          let r, g, b, sh = 1;
          if (z < 0) continue;
          if (z < 0.13) {                                   // head
            const hx = dxw / 0.058, hz = (z - 0.068) / 0.068;
            if (hx * hx + hz * hz > 1) continue;
            if (z < 0.04) { r = 44; g = 32; b = 26; } else { r = skin[0]; g = skin[1]; b = skin[2]; }
            sh = 1 - Math.max(0, dxw) * 3;
          } else if (z < 0.15) {
            if (adx > 0.025) continue;
            r = skin[0] * 0.8; g = skin[1] * 0.8; b = skin[2] * 0.8;
          } else if (z < (s.seated ? 0.36 : 0.38)) {      // torso and arms
            const shoulder = z < 0.18 ? 0.085 + (z - 0.15) * 0.6 : 0.105;
            if (adx <= shoulder) { r = cr; g = cg; b = cb; sh = 1 - Math.max(0, dxw) * 2.2; }
            else if (adx <= 0.14 && z > 0.17 && z < 0.34) { r = cr * 0.78; g = cg * 0.78; b = cb * 0.78; }
            else continue;
          } else if (s.seated) {                            // lap / chair
            if (adx > 0.12) continue;
            r = 46; g = 52; b = 62;
          } else {                                          // legs
            const legC = 0.048 + (dxw < 0 ? -legSplit : legSplit) * (z - 0.38) * 4;
            if (Math.abs(adx - legC) > 0.036) continue;
            if (z > 0.59) { r = 24; g = 24; b = 28; } else { r = 44; g = 50; b = 66; }
          }
          const L = Ls * fog * sh;
          buf[y * W + x] = pack(r * L + fogC[0] * (1 - fog), g * L + fogC[1] * (1 - fog), b * L + fogC[2] * (1 - fog));
        }
      }
    }
  }

  return { render };
}

function compass(ctx, w, dir) {
  const cw = 220, x0 = w / 2 - cw / 2, y = 14;
  ctx.save();
  ctx.fillStyle = 'rgba(11,15,20,0.65)';
  ctx.fillRect(x0, y, cw, 20);
  ctx.beginPath(); ctx.rect(x0, y, cw, 20); ctx.clip();
  ctx.font = "600 11px 'JetBrains Mono', monospace";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // dir 0 = east (+x), PI/2 = south (+y)
  const marks = [['N', -Math.PI / 2], ['E', 0], ['S', Math.PI / 2], ['W', Math.PI]];
  const pxPerRad = cw / (Math.PI * 0.9);
  for (const [lab, a] of marks) {
    for (const off of [-2 * Math.PI, 0, 2 * Math.PI]) {
      const d = a + off - dir;
      const x = w / 2 + d * pxPerRad;
      if (x < x0 - 10 || x > x0 + cw + 10) continue;
      ctx.fillStyle = lab === 'N' ? '#f5b301' : '#e6edf5';
      ctx.fillText(lab, x, y + 10);
    }
  }
  ctx.restore();
  ctx.fillStyle = '#f5b301';
  ctx.beginPath(); ctx.moveTo(w / 2 - 4, y + 20); ctx.lineTo(w / 2 + 4, y + 20); ctx.lineTo(w / 2, y + 25); ctx.fill();
}

function lerp(a, b, t) { return a + (b - a) * t; }
function mix3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function pack(r, g, b) {
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function spriteColor(hex) { return hexToRgb(hex); }
