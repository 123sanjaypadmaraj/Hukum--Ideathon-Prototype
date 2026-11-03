# HUKUM prototype: module contract

A browser digital twin of "Academic Block A" on the HUKUM model campus
(deck: `../HUKUM_Ideathon_2026.pptx`). Plain ES modules, no build step, no npm.
Run with `python -m http.server 8000` from `hukum-prototype/` and open
http://localhost:8000. No external JS libraries: draw everything with Canvas 2D / DOM.

## Concept (from the deck)
HUKUM = Harnessing Unused Kilowatts Using Machine intelligence. One AI brain
turns a campus's existing equipment and existing CCTV into a virtual battery.
Six-engine loop, every 15 minutes:
1. **SEE** - occupancy per room from existing CCTV (YOLO on edge box; frames in memory, never stored).
2. **PREDICT** - solar & demand forecast with P10/P50/P90 range, re-forecast through the day.
3. **DISCOVER** - learns how much each AC, pump, EV charger can shift, and how reliably (reliability, rebound).
4. **DECIDE** - internal flexibility market: each machine bids its cost; cheapest dependable mix wins.
5. **ACT** - MPC dispatch: shift loads, run battery, auto-off rooms empty 10+ min, power back the moment someone walks in. Safety/comfort limits never broken.
6. **PROVE** - verified savings vs baseline, rebound counted, Flex Score.

Pilot modes: **shadow** (HUKUM suggests, nothing executes, we log what it would have saved),
**approve** (each action waits for operator approval), **automate** (runs on its own).
Failure handling: camera/AI box fails -> room power stays ON (fail-safe); internet down -> local
backup schedule; weather miss -> re-forecast + reserves; comfort hard limits 22-27 C + manual override;
battery wear cost (Rs 1.5/kWh) in every bid; grid outage -> **Resilience Mode** (battery + solar
serve critical loads, non-critical shed, diesel last).
Simulation assumptions are in `js/config.js` (tariff Rs 8 normal, 6.4 solar hours 9-17, 9.6 peak 18-22,
export 3, 900 kWp, 400 kWh battery, 60 classrooms, 75% slot occupancy, pre-cool 35 kW x 90 min @ 80% reliability, 10% rebound).
Headline sim results to roughly reproduce: HUKUM -26% daily cost (sunny) vs do-nothing, battery-only -11%,
evening peak 425 -> 228 kW, classroom energy -36% from camera auto-off.

## Shared files (owned by the integrator - read, do not edit)
- `js/config.js` - `CONFIG`, `tariffAt(minuteOfDay)`, `mulberry32(seed)`, `fmtTime(min)`.
- `js/bus.js` - `bus.on(event, fn) -> unsubscribe`, `bus.emit(event, payload)`.
- `js/building.js` - `FLOORS` (4 levels: 0 G, 1, 2, 3 Roof; each `{level,name,short,grid[ROWS][COLS],rooms[],corridor,stairs,lift}`),
  `ROOMS`, `ROOM_BY_ID`, `CAMERAS`, `CAMERA_BY_ID`, `PANELS`, `PANEL_BY_ID`, `EQUIPMENT`, `EQUIPMENT_BY_ID`,
  `TILE`, `COLS`(52), `ROWS`(29), `CORRIDOR`, `PLAYER_START`, `tileAt`, `isWalkable`, `roomAt`, `AUTO_OFF_TYPES`, `TIMETABLE_TYPES`.
  Units are tiles (~1 m). Room `{id,name,type,floor,x,y,w,h,top,doors[{x,y}],seats,loads{lightsKW,fansKW,acKW,equipKW},camera,autoOff,timetabled}`.
  Camera `{id,x,y,facing(rad, 0=+x, +PI/2=+y down),fov,roomId,floor,kind:'room'|'corridor'}`.
- `js/state.js` - `createState()` (READ IT: it documents every field), `minuteOfDay(t)`, `slotOf(t)`.
- `js/sim/engine.js` - clock; calls occupancy + energy functions below.
- `js/main.js` - wiring, game loop, the `actions` object.
- `index.html`, `css/base.css` - layout & colour tokens (`--accent`, `--solar`, `--grid`, `--battery`, `--demand`, `--baseline`, `--danger`, `--ok`, `--warn`, `--panel`, `--line`, `--muted`, `--mono` ...).

`state.t` is sim minutes since midnight of day 1 and keeps increasing; use `minuteOfDay(state.t)`.

## Modules and owners

### A. `js/sim/occupancy.js` (+ any `js/sim/occ-*.js` helpers) - SEE + room control
Exports:
- `initOccupancy(state)` - build timetable (seeded with `mulberry32(state.seed)`), spawn people.
- `stepOccupancy(state, dtMin)` - move people (walk via doors/corridor/stairs core between floors, sit in seats during class),
  update `state.people`, `state.rooms[id].occupancy`, vision detections into `state.cameras[id]` (`count`, `detections[{personId,conf,x,y}]`, small realistic miss rate / confidence noise, only people inside the camera's room), `rooms[id].detected/lastSeenT`,
  auto-off after `CONFIG.occupancy.autoOffMinutes` with no detection for `autoOff` rooms, instant power-on when detected,
  fail-safe (offline camera -> room stays powered), manual override wins, simple room thermal model (`tempC`), lights/fans/AC flags,
  `loadKW` (actual with HUKUM) and `baselineLoadKW` (baseline: timetabled rooms powered 08:45-17:45 regardless, others per normal hours).
  When `state.mode` is 'shadow' or 'approve', do not switch off: push a pending action into `state.pendingActions`
  (`{id,t,text,target:{type:'room',id},action:'off',kW,savingRs,reason,status:'pending'}`; in shadow mode status 'shadow' and never executed, just logged). Don't duplicate pending actions for the same room.
  When `scenario.hukumEnabled` is false, rooms behave like baseline.
  Also respond to `state.energy`'s pre-cool request: `state.rooms[id].precool` (boolean set by energy) lowers setpoint by 2 C within comfort limits.
  Push copilot lines `{t, level, engine:'SEE'|'ACT', text}` into `state.copilot` for auto-off / power-on events (plain English, e.g. "Lab 3 empty for 10 min - lights, fans and AC off (saves 7.8 kW)").
  Emit `bus` events: `room:auto-off {roomId}`, `room:power-on {roomId}`, `camera:status {id, online}`.
- `applyRoomAction(state, action)` - execute an approved room action.
- `setRoomOverride(state, roomId, mode)` - mode `'on'|'off'|null`.
- `setCameraOnline(state, camId, online)`.
People `{id, name, role:'student'|'staff'|'guard'|'cleaner', floor, x, y, roomId, targetRoomId, path[], seated, color}`.
People speed ~1.3 tiles/sim-second is far too fast at 60x; use realistic walking (~80 tiles per sim minute is ok) but
clamp so movement looks smooth at 60x speed (people move in sim time). Keep ~150-250 people max for performance.
Populate: students attend timetabled slots (75% probability per room per hour slot, 08:45-17:45, 10 min break at slot change where rooms empty briefly), staff in offices/staff room, library visitors, canteen at lunch (12:30-13:30), a guard patrolling, a cleaner. After 18:00 most leave, campus empty overnight; one guard remains.

### B. `js/sim/energy.js` (+ `js/sim/energy-*.js` helpers) - PREDICT, DISCOVER, DECIDE, ACT, PROVE
Exports:
- `initEnergy(state)`; `stepEnergy(state, dtMin)`; `onSlot(state, slot)`; `onDayEnd(state)`;
  `applyEquipmentAction(state, action)`; `setEquipmentOverride(state, equipId, mode)` (`'on'|'off'|null`).
- Solar actual: bell curve 06:30-18:30 scaled to 900 kWp x weather (sunny ~0.8 peak, cloudy with noisy dips, monsoon low), seeded noise.
- Forecast (`state.energy.forecast`): 96-slot P10/P50/P90 for solar and demand, re-issued each slot (narrowing as the day goes), plus copilot PREDICT lines at notable moments (09:00 forecast, 11:00 surplus spotted, 16:00 evening re-forecast).
- Demand = sum(rooms[].loadKW) + equipment kW + `CONFIG.campus.otherBlocksBaseKW` profile for Blocks B-D (scaled so peak baseline ~425 kW in the evening incl. hostels/lighting, use a realistic campus shape).
- Baseline ("do nothing"): rooms' `baselineLoadKW`, EVs/e-buses charge on arrival, pumps run on a fixed schedule (evening), HVAC no pre-cool, no battery. Also compute battery-only cost (same 400 kWh battery doing simple peak shaving) for the comparison.
- DISCOVER: each slot compute `equipment[id].flexKW`, reliability (learned, drifts with delivery), rebound.
- DECIDE: `onSlot` builds bids into `state.market` (`needKW`, `bids[]` with priceRs per kWh incl. battery wear Rs1.5, reliability derating, `accepted`, plain `reason`), clears by merit order, records `market.history`.
- ACT: dispatch for the slot: pre-cool AHU/HVAC in solar hours (sets `rooms[id].precool` for AC rooms), pumps fill tanks on solar, EVs/e-buses charge on solar, battery charges on surplus & discharges in 18-22 peak, export only when nothing else absorbs. Respect overrides and `state.mode`:
  shadow -> compute but don't execute, push pendingActions with status 'shadow'; approve -> push `status:'pending'` actions with `target:{type:'equipment',id}`, execute in `applyEquipmentAction` when approved; automate -> execute directly.
  Resilience Mode (`scenario.outage`): grid 0, battery + solar serve critical loads (server, corridors, labs), shed non-critical, `dieselKW` only if battery empty. Internet down: keep running from last plan, copilot note "running local backup schedule".
- Each minute push to `energy.history` and accumulate `energy.totals` (cost includes tariff by time-of-day, export credit, battery wear; peak tracked as max grid kW; solar self-use; classroom kWh hukum vs baseline; CO2 0.71 kg/kWh grid avoided).
- PROVE `onDayEnd`: verification summary into `energy.pastDays` (`{day, costHukum, costBaseline, costBatteryOnly, savingPct, peakHukum, peakBaseline, flexScore, ...}`), update `state.flexScore` (0-100: delivered/promised flexibility x reliability minus rebound and any safety violation), copilot PROVE line, then reset today's history/totals.
- Copilot: every slot one DECIDE line explaining the market result in plain words ("Solar surplus 180 kW at Rs 6.4: pre-cooling Block A (35 kW, 80% reliable), pumps 30 kW, e-bus 60 kW; battery absorbs the rest").
- Keep it fast: per-minute step must be O(rooms + equipment).

### C. `js/world/world.js` (+ `js/world/*.js`, `css/world.css`) - the navigable building
`export function createWorld({ canvas, state, actions }) -> { update(dtSec), render(), resize() }`.
- Draw the current floor of `FLOORS[state.player.floor]` on the canvas, camera following the player, with a polished 2.5D look
  (extruded walls with top faces, floor textures per room type: desks/chairs in classrooms, lab benches, bookshelves, server racks, canteen tables, solar panel rows on roof, pumps/AHU, EV chargers & parked cars, DB panels).
- Lighting: rooms with `rooms[id].lightsOn` warm-lit; powered-off rooms dark with a subtle "AUTO-OFF" label; daylight tint by time of day (night = dark outside, corridor lights).
- Draw `state.people` on this floor (small top-down figures, walk animation, colour by role), CCTV cameras as icons with view cones (cone tinted red when offline), equipment glyphs with live kW/status, room labels with occupancy (e.g. "CR-101  32 ppl  24.1 C").
- **Arrow keys (and WASD)** walk the player with collision against walls (`isWalkable`), Shift = run. Smooth, frame-rate independent.
- Floors: when inside the stairs/lift core (`floor.stairs` / `floor.lift`) PageUp/PageDown (also `[`/`]`) change floor; show a prompt. Brief fade transition.
- `E` / Enter interacts with the nearest thing within ~2 tiles: camera -> `actions.openCamera(id)`; panel (`PANELS`) -> `actions.openLens(panelId)`; equipment -> `actions.inspect('equipment', id)`; otherwise current room -> `actions.inspect('room', id)`. Show a floating "[E] View camera CAM-LAB-3" prompt.
- `V` toggles a **first-person view** (raycaster, Wolfenstein-style; Left/Right turn, Up/Down walk) of the same floor, with room lighting state reflected (dark vs lit), people as billboard sprites, and the minimap still visible. `M` toggles minimap. `H` / `?` toggles a help overlay of controls (build it in `#world-hud`).
- HUD in `#world-hud`: floor indicator + floor switcher buttons (G/1/2/R), current room name & status, clock, minimap (click to teleport via `actions.teleport`), interaction prompt.
- Mouse: click a room on the canvas -> `actions.inspect('room', id)`; click a camera icon -> `actions.openCamera(id)`; mouse wheel zoom.
- Ignore keys when `document.activeElement` is an input/select/textarea or `state.ui.modal` is set (except Escape). Prevent page scroll on arrows/space when the world has focus (focus canvas on click and on load).
- Listen to `player:teleport` bus event.

### D. `js/cctv/cctv.js` (+ `js/cctv/*.js`, `css/cctv.css`) - simulated CCTV feeds
`export function createCctv({ state, actions }) -> { mountWall(el), renderFeed(canvas, cameraId, opts), update(dtSec) }`.
- `renderFeed` draws a synthetic **camera view** from the camera pose (`CAMERA_BY_ID[id]`: position, facing, fov, mounted ~2.8 m high looking down ~30 deg) using a simple 3D perspective projection of the room box (floor, walls, door, windows, desks/benches per room type) and `state.people` inside that room as shaded human figures (seated/standing) sorted by depth.
  Lighting reflects `rooms[id].lightsOn` (dark/IR night-vision greyscale when off), daylight from windows by time of day.
  Overlays: YOLO-style boxes + "person 0.93" labels from `state.cameras[id].detections`, people count, "ZONE: <room>", timestamp `fmtTime`, camera id, "LIVE · edge-processed · frames not stored", slight noise/scanlines/vignette/fisheye-ish feel, fps. Offline camera -> static noise + "NO SIGNAL - fail-safe: room power held ON".
  `opts`: `{ boxes: true, privacy: false (blur/pixelate heads), heatmap: false (occupancy heat overlay), small: bool }`.
- `mountWall(el)` builds the CCTV wall UI inside `el`: floor filter (All/G/1/2), grid of live tiles (room name, count badge, power state badge ON/AUTO-OFF, online dot), click tile -> opens a large modal viewer in `#modal-root` with toggles (boxes, privacy blur, heatmap), occupancy sparkline for the last hour, "simulate camera failure" toggle (`actions.setCameraOnline`), override buttons (`actions.setRoomOverride`), next/prev camera, Escape closes (set/clear `state.ui.modal = 'camera'`).
- Also listen to `ui:openCamera` bus event to open the modal for that camera.
- Performance: render only visible tiles, at ~6-10 fps for wall tiles and ~20 fps in the modal; reuse offscreen canvases.
- Each feed should look distinct (room type furnishings) and convincing.

### E. `js/ui/ui.js` (+ `js/ui/*.js`, `css/ui.css`) - control room UI
`export function createUI({ state, actions, cctv, world }) -> { update() }` (called ~5x/s).
- `#topbar`: HUKUM wordmark ("HUKUM" + "One command. Every machine. Every 15 minutes."), sim clock + day, play/pause + speed buttons (`CONFIG.speeds`), skip +15 min / +1 h, pilot mode segmented control (Shadow / Approve / Automate), weather select, scenario toggles (grid outage, internet down, battery 400/50 kWh, HUKUM on/off), live KPIs (grid kW, solar kW, tariff now with colour by band).
- `#tabs` + `#panels` tabs:
  1. **Overview** - KPI tiles (cost today HUKUM vs baseline with % saving, battery-only %, peak kW vs baseline, solar self-use %, classroom energy saved %, CO2 avoided, Flex Score), main 24h energy chart (canvas): solar P10-P90 band + P50 forecast, actual solar, demand, grid import, baseline grid (dashed), battery charge/discharge bars, tariff band shading, "now" line; the six-engine loop strip with the active engine pulsing.
  2. **CCTV** - `cctv.mountWall(panelEl)`.
  3. **Market** - current slot need, merit-order chart of bids (price vs cumulative kW, accepted highlighted), bids table (machine, direction, kW, Rs/kWh, reliability, accepted, reason), clearing price history sparkline.
  4. **Equipment** - each `EQUIPMENT` item: status, kW, flexKW, reliability bar, SOC/tank, override buttons; battery SOC gauge.
  5. **Rooms** - table of rooms (filter by floor): occupancy (true) vs detected, power, temp, AC, saving, override on/off/auto, "go to" button -> `actions.teleport` to room centre.
  6. **Copilot** - pending actions queue with Approve / Reject (approve mode) or "would have done" list (shadow mode), log of `state.copilot` filtered by engine chips, and an "Ask HUKUM" box answering questions from live state with rule-based intents (why is X off, how much did we save, what's the forecast, battery status, which rooms are empty, peak) in plain English.
  7. **Verify** - PROVE report: today vs baseline vs battery-only table, savings ribbon, Flex Score breakdown, past days list, gain-sharing estimate (e.g. 30% share of verified savings), "Download report (JSON/CSV)" button.
- **AR Panel Lens** modal on `ui:openLens {panelId}`: phone-frame overlay showing a stylised distribution board (rows of breakers from `PANEL_BY_ID[id].circuits`), "panel recognised: DB-1 (98%)" detection, OCR boxes over breaker labels, live kW per circuit (from room loads/equipment), colour by state, tap a circuit -> shows room it feeds + occupancy + "Show on map" (teleport) + override toggle. Escape closes. Set `state.ui.modal = 'lens'` while open.
- **Inspector** modal/drawer on `ui:inspect {type:'room'|'equipment', id}` with live details and controls.
- Toasts on `alert`, `room:auto-off`, `room:power-on`, `action:approved` bus events (throttled; max 3 visible).
- Charts: hand-written Canvas 2D, crisp on HiDPI, colours from CSS tokens, legends, hover tooltip on the energy chart.
- Do the first-run onboarding: small dismissible card explaining controls (arrow keys, E, V, PgUp/PgDn) and the HUKUM loop.

## Bus events
`tick {t,dtMin}`, `slot {slot,t}`, `day {day}`, `control {...}`, `scenario {...}`, `alert {id,t,level,text}`,
`room:auto-off {roomId}`, `room:power-on {roomId}`, `camera:status {id,online}`,
`action:approved`, `action:rejected`, `player:teleport`, `ui:openCamera {id}`, `ui:openLens {panelId}`, `ui:inspect {type,id}`.

## Rules for every module
- Only edit files you own. If you need something from a shared file, work around it inside your module and note it in your final report.
- Defensive reads: other modules may not have populated fields yet (e.g. empty `forecast` arrays); never throw on missing data.
- No external libraries or network calls (fonts already loaded). Vanilla ES modules, relative imports with `.js` extensions.
- Plain-English, no emojis in UI text.
- Verify your module at least loads: `node --check` each file you wrote (and for sim modules, write a quick node smoke script in the scratchpad that imports your module with `createState()` and steps a full simulated day, printing key numbers).

## v2: NHCE campus (multi-block) - READ THIS, it supersedes single-building assumptions
`js/building.js` now models the New Horizon College of Engineering campus (Outer Ring Road, Marathahalli):
- `FLOORS` is a flat list of 15 floors. Index 0 is the outdoor **campus site plan** (`isCampus: true`, `blockId: 'CAMPUS'`,
  no stairs/lift: `stairs`/`lift` are null). Then each block's floors: Main Block `MB-G, MB-1, MB-2, MB-R`, `SVP-G, SVP-1, SVP-R`,
  `NSB-G, NSB-1, NSB-R`, `NSC-G, NSC-1`, `AUD-G` (700-seat auditorium), `AMN-G` (cafeteria, Sanjeevini medical, bank, gym, Nirvana).
  Every floor has `level` (= its index), `blockId`, `storey` (0, 1, 2 or 'R'), `isRoof`, `isCampus`, `short` (e.g. 'SVP-1'),
  `name` ('SVP Block · First Floor'), `floorName`, and `up` / `down` (floor index or null, within the same block).
  **Never assume `level === 3` means roof, `level + 1` is the floor above, or that floors 0-3 exist. Use `isRoof`, `up`, `down`, `isCampus`.**
- `BLOCKS [{id,name,short,about,floors[],ground,footprint}]`, `BLOCK_BY_ID`, `CAMPUS_FLOOR` (0), `floorIndex(blockId, storey)`, `blockOfFloor(floor)`.
- `SITE`: campus site plan data: `footprints[{blockId,x,y,w,h,door,arrive}]` (solid block outlines on the campus floor; `door` is the
  walkable entrance tile in front), `structures[]` (substation, STP: solid, non-enterable), `zones[]` (walkable outdoor rooms:
  GATE, PARKING, SPORTS, BBALL; they are also in `ROOMS` with `outdoor: true`, `autoOff: false`), `road`, `offsite`.
  The main gate opens through the south boundary (DOOR tiles on the bottom row) onto the Outer Ring Road.
- `PORTALS [{blockId, outside, outsideArrive, inside, insideArrive}]` and `portalAt(floor, x, y)` -> `{portal, to, arrive}`:
  stepping on a block's campus `door` tile enters that block's ground floor (arrive at `insideArrive`); stepping on the block's
  ground-floor entrance tile (x 0, y 14, west end of the corridor) exits to the campus at `outsideArrive`.
- Room ids are globally unique and descriptive (`CSE-101`, `AIML-LAB`, `IDEA-LAB`, `AUD-HALL`, `CAFE`, `SANJEEVINI`, `MB-CCTV` ...).
  New room types: `workshop`, `auditorium`, `medical`, `security`, `gym`, `recreation`, and campus zone types `gate`, `parking`, `sports`.
  Every room has `blockId`. `AUTO_OFF_TYPES`, `TIMETABLE_TYPES`, `ZONE_TYPES` exported.
- Cameras: room cameras `CAM-<roomId>`, corridor cameras `CAM-COR-<floorShort>`, outdoor zone cameras (`kind: 'outdoor'`, e.g. `CAM-GATE`,
  `CAM-PARKING`, `CAM-SPORTS`, `CAM-BBALL`). Every camera has `blockId`.
- Panels: `DB-<floorShort>` in each block floor's riser, plus `MLT` in `MB-ELEC` with one feeder per block (circuit `blockId`).
  Panels have `blockId`.
- Equipment keeps the same ids. PV/AHU/pumps are on the Main Block roof, BAT-1 in MB-ELEC, EV and e-bus chargers in the campus PARKING zone.
- `PLAYER_START` is on the campus just inside the main gate.
Real NHCE facts used: 700-seat auditorium, Library & Information Centre, Conference Hall, Video Conference Hall, CCTV control room,
Sanjeevini Medical Facility, Nirvana Recreation Centre, Indian Bank & ATM, gym, indoor sports, sports ground, synthetic track,
basketball court, substation, STP, AICTE Idea Lab, Industry Skill Lab (CoE), rooftop solar on SVP (25 kWp off-grid + battery)
and NSB blocks, one energy meter per block. Department placement and positions are assumptions (editable in building.js).
