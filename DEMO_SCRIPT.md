# HUKUM: 3-minute demo script

Run: `python -m agents.server` then open http://127.0.0.1:8000/twin.html (use `HUKUM_OFFLINE=1` for a repeatable run).
Record the screen (Win+Alt+R / OBS) while reading the narration. Timings are cumulative.

## 0:00 – 0:20 | Problem and idea (Twin tab, welcome card)
"Campuses waste power: lights and AC running in empty rooms, solar going unused at midday, and peak-hour grid bills.
HUKUM, Harnessing Unused Kilowatts Using Machine intelligence, is a digital twin of the NHCE campus in Bengaluru
that runs a six-step loop every 15 minutes: See, Predict, Discover, Decide, Act, Prove."

## 0:20 – 1:00 | The twin and its UI (index.html)
- Click Start exploring. Walk with arrow keys from the main gate; press V for first-person, M for the minimap, X for x-ray, L for wiring.
- Top bar: clock, speed (1x to 300x), pilot mode (Shadow / Approve / Automate), weather, Scenarios (grid outage, internet down, battery size, HUKUM on/off).
- "About 90 simulated CCTV cameras count people with YOLO-style detections. A room empty for 10 minutes is switched off; if a camera fails, the room stays on (fail-safe)."
- Point at Waste Watch: flags lights on with nobody inside.

## 1:00 – 1:35 | Dashboard tabs (right panel)
- Overview: cost today vs do-nothing baseline (about -23%), peak grid kW, solar self-use, CO2 avoided, Flex Score, 24 h forecast with P10/P50/P90 bands.
- CCTV: wall of cameras, filter by block, people detected, rooms auto-off.
- Market: every 15 minutes machines bid their flexibility and the cheapest dependable mix is cleared by merit order (battery, HVAC pre-cooling, pumps, EVs, e-buses).
- Verify: savings proven against a do-nothing baseline and a battery-only system, rebound counted, downloadable report.

## 1:35 – 1:55 | Zero Scan (scan.html)
"Zero Scan builds the building model without a survey: Google Solar, Open Buildings and OSM for the outside; DXF/BIM/scanned plans for the inside;
CCTV and meter data (NILM) for what runs where. Press Test run and the Main Block builds up stage by stage into a brick graph you can export."

## 1:55 – 2:50 | The agent team (agents.html)
- Nine LangGraph agents under a supervisor: Mapping, Solar Planner, Environmental Engineer, Solar Health, Fault & Maintenance, Bill Auditor, Multi-Campus Negotiator, State Optimiser, Control, then a Reporter.
- Press Run agents. Narrate as nodes light up: Mapping finds 23 rooms and 181 kWp of roof; Solar Planner proposes a plan; the Environmental Engineer sends it back until it passes review (3 passes here, then approved); Bill Auditor and Negotiator find recoverable money; the Optimiser solves 96 slots for tomorrow.
- Human in the loop: in Approve mode, Control pauses with 11 proposed actions (e.g. pre-cool AHU-A 11:00-12:30). Untick any, press Approve selected. Nothing changes until you decide.
- Result: 156 kWp plan, 4.8-year payback, 26.4% cost saving tomorrow, Rs 1.6 lakh recoverable on bills, 8 work orders.

## 2:50 – 3:00 | Why it is trustworthy
"Every number comes from deterministic, seeded Python tools; the LLM (GPT-OSS on Groq) only writes wording, and any sentence with a number not in the data is replaced.
No key or no network? It runs fully offline with the same result. HUKUM: use what the campus already has."
