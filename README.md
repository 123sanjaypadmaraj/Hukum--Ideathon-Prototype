# HUKUM: Building Twin Prototype

A working, browser-based prototype of **HUKUM** (Harnessing Unused Kilowatts Using Machine
intelligence), the Ideathon 2026 concept in `../HUKUM_Ideathon_2026.pptx`.

It simulates the **New Horizon College of Engineering (NHCE)** campus on the Outer Ring Road,
Marathahalli, Bengaluru. You start at the main gate and walk with the arrow keys. You can go
into any block and up its stairs, watch about 90 simulated CCTV cameras, and see HUKUM's
six-engine loop run every 15 minutes:
**SEE → PREDICT → DISCOVER → DECIDE → ACT → PROVE**.

## Run

```bash
cd hukum-prototype
python -m http.server 8000
# open http://localhost:8000
```

You need to serve the folder over HTTP because ES modules don't load from `file://`. There are no dependencies and no build step.

Every page has the same tab strip at the top: **Digital Twin** (`twin.html`; `index.html` is the start page, Enter opens Zero Scan), **Zero Scan** (`scan.html`), **Agents** (`agents.html`).

### Agents (LangGraph)

```powershell
pip install -r agents/requirements.txt
.\run.ps1 -Agents            # or: python -m agents.server   (PORT env var, default 8000)
```

Nine agents (Mapping, Solar Planner, Environmental Engineer, Solar Health, Fault & Maintenance, Bill Auditor,
Multi-Campus Negotiator, State Optimiser, Control) run as a LangGraph `StateGraph` under a supervisor. The Solar Planner
and Environmental Engineer loop until the plan passes review, and Control pauses for human approval in "approve" pilot mode.
See `agents/README_AGENTS.md` and `agents/CONTRACT.md`.

- **LLM:** put `GROQ_API_KEY=...` in `agents/.env` (git-ignored). `HUKUM_MODEL` defaults to `openai/gpt-oss-120b`. On a
  rate limit the run switches to `HUKUM_MODEL_BACKUP` (`openai/gpt-oss-20b`).
- **Always demo-safe:** every number comes from deterministic Python tools; the model only writes the wording.
  - A model call slower than `HUKUM_LLM_TIMEOUT` (6 s) is simulated with the scripted text.
  - Once a run has spent `HUKUM_LLM_BUDGET` (45 s) on the model, or after 3 failures in a row, the rest of that run is simulated.
  - A model sentence containing a number that isn't in the data is replaced by the scripted sentence.
  - Without a key everything runs offline.
- **Without the Python server** (plain `http.server`), `agents.html` replays the recorded run `agents/data/demo_run.json`. Re-record it with `python -m agents.record_demo`.
- **Tests:** `python -m agents.tests.test_graph`. These run offline and never call Groq.

## Controls

| Key | Action |
| --- | --- |
| Arrow keys / WASD | Walk (Shift to run) |
| Walk into a block door | Enter that block; walk out of the ground-floor west door to return to the campus |
| PageUp / PageDown, `[` `]` | Change floor while standing in the stairs/lift core |
| E / Enter | Interact: view a camera, open the AR Panel Lens on a distribution board, inspect equipment or a room |
| V | Switch between the top-down view and the first-person view |
| M | Show or hide the minimap (click it to teleport) |
| F | Show or hide the front-view window (first-person look ahead, shown over the top-down map) |
| H / ? | Help overlay |
| Esc | Close a modal |

## What is simulated

- **Campus**: an outdoor site plan with the main gate on the Outer Ring Road, parking and the bus bay with EV chargers, the sports ground and synthetic track, the basketball court, the substation and the STP.
- **Blocks**:
  - Main Block: admin, Library & Information Centre, CCTV control room, data centre, CSE / ISE / AI & ML, Video Conference Hall, and a roof plant.
  - SVP Block: ECE / EEE, AICTE Idea Lab, Industry Skill Lab (CoE), and existing 25 kWp rooftop solar.
  - NSB Block: Mechanical / Civil workshops and labs, and rooftop solar.
  - NSC Block: MBA / MCA / Basic Sciences and the Examination Hall.
  - 700-seat Auditorium.
  - Student Amenities: cafeteria, Sanjeevini Medical Facility, Indian Bank & ATM, gym, and Nirvana Recreation Centre.
  
  Every floor has a distribution board, and every block has its own energy meter, as NHCE does.
- **What is real and what is assumed**: the facilities listed above come from NHCE's own infrastructure pages and green audit. Which department sits in which block, the block positions, and the room lists are assumptions; edit `BLOCK_SPECS` and `SITE` in `js/building.js` to match the real campus.
- **People**: a seeded timetable (75% slot occupancy, 08:45 to 17:45), lunch in the canteen, staff, a guard on patrol and a cleaner.
- **SEE**: each room camera produces YOLO-style detections with confidence noise. If a room has had no detections for 10 minutes, its power goes off. Power comes back as soon as someone walks in. If a camera goes offline, the room's power is held on (fail-safe).
- **PREDICT / DISCOVER / DECIDE / ACT**: solar and demand forecasts with P10/P50/P90 bands, a learned flexibility estimate per machine, and an internal market cleared by merit order every 15 minutes. Dispatch covers battery, HVAC pre-cooling, pumps, EVs and e-buses.
- **PROVE**: savings verified against a do-nothing baseline and against a battery-only system, with rebound counted, plus a Flex Score and a downloadable report.
- **Scenarios**: sunny, cloudy or monsoon weather; grid outage (Resilience Mode); internet down (local backup schedule); battery size of 400 or 50 kWh; HUKUM on or off; pilot mode of Shadow, Approve or Automate.

The tariff and plant assumptions come from the deck's speaker notes: see `js/config.js`.
For how the modules fit together, see `CONTRACT.md`.

All figures come from the simulation and are not measured.

## HUKUM Zero Scan (`scan.html`)

> HUKUM Zero Scan fuses Google Solar data, blueprints and a five-minute phone walkthrough into one model of the building, and asks a human only about what it isn't sure of.

Open it with `.\run.ps1 -Scan`, or click **Zero Scan** in the top bar. It runs in the browser like the twin, with no build step. Every source has a **Sample** button, and most also have **File** (upload your own) and **Live** (fetch from the network).

**Test run.** Press **Test run** (or open `scan.html?autotest`). The page uploads every file in `test-files/` as if you had dropped them in, then runs the scan. These are real files for all 14 sources (a DXF, an IFC, and CSV, JSON and text files), listed in `test-files/manifest.json`. To regenerate them from the samples, run `node tools/make-test-files.mjs`. You can also replace any file with your own: keep the file name, or edit the manifest.

**Live build.** While the scan runs, the **Live build** tab shows the Main Block assembling itself, with one animation per stage:
1. The footprint is traced and the massing is extruded.
2. The floors open and the walls rise.
3. The walkthrough places furniture and plant, with nameplate ratings.
4. Cameras and detected people appear.
5. Circuits light up from the riser while the meter trace draws.
6. The drawing snaps onto the footprint, then each room takes its verdict colour.

Drag to rotate, scroll to zoom, and double-click to stop the sway. **Skip animation** jumps to the end. **Replay build** plays the animation again without re-running the scan.

| Stage | Sources | What the MVP does |
| --- | --- | --- |
| 1 Outside | Google Solar API `buildingInsights`, Open Buildings CSV row (+ 2.5D height), OSM Overpass, Open-Meteo irradiance | Parses roof segments, panel layout and yield. Takes the footprint polygon and height (storeys = height / 3.5 m). Runs a PVWatts-style yield check against the Solar API figure. With no Solar API coverage it falls back to footprint × 60% usable, flagged at low confidence. |
| 2 Inside | DXF, IFC, plan-recognition JSON (CubiCasa / DeepFloorplan output + OCR), single-line diagram OCR text | Reads room boundaries, labels, light fittings and `DB-x/Cn` circuit tags from the DXF. Reads IfcSpace names and areas. Corrects OCR label errors (O/0, I/1) against the room register. Parses SLD lines into circuit → room links. |
| 3 Walkthrough | Apple RoomPlan `CapturedRoom` JSON, nameplate OCR text | Turns walls into room polygons and counts chairs and tables. A rule-based extractor pulls kW (or HP, kVA), kWh, V, A, make, model and type from the nameplate text. |
| 4 CCTV | Camera frame per room camera (the twin's CCTV renderer) | Proposes floor points, fits an image → plan homography and maps YOLO foot points to room ids. You can drag points in the **Cameras** tab, and the homography refits. |
| 5 Electricity | 1-min block meter CSV, Wi-Fi AP CSV, timetable CSV | Event-based NILM: step detection, on/off pairing and clustering. Steps that line up with class bells are classed as room circuits; the rest are matched to nameplates. Wi-Fi occupancy is cross-checked against camera counts. |
| 6 Align + fuse | All of the above | ICP (similarity) aligns the drawing outline to the footprint and the scan to the drawing. Each fact records its source and a confidence. Agreeing sources are combined with noisy-OR; disagreements and anything below 70% confidence go to the to-do list. Exports a Brick Schema Turtle graph, a JSON model, and the facts plus decisions. |

The samples are generated from `js/building.js` (Main Block). Six real-world problems are planted in them: a store-room wall that no longer exists, a circuit tag drawn in the wrong room, a 15 kW pump that the meter sees drawing 8.25 kW, a camera that is blocked while Wi-Fi shows a full lab, a timetable booking for a room that doesn't exist, and an OCR misread. Expect about 97% of statements to be accepted automatically and six to-dos.

Not in this MVP: reading the Solar API DSM/flux GeoTIFF layers, IFC geometry, running the plan-recognition and OCR models themselves (bring their JSON or text output), lens-distortion calibration, and LLM nameplate extraction. The Solar API key is stored only in this browser's localStorage and is sent only to Google. Check the Solar API coverage page for India before you rely on it.
