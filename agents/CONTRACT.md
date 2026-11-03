# HUKUM agent team: build contract

Python package `agents/` (run from `hukum-prototype/`: `python -m agents.server`, port 8000),
LangGraph 1.2, langchain-core 1.x, langchain-groq 1.1, FastAPI 0.124, Python 3.14 (Windows).
Read `state.py` (state schema, AGENTS list) and `ctx.py` (AgentCtx, OfflineLLM) first: they are fixed.

## Golden rules
1. The demo must work with **no API key and no network**. Numbers come from deterministic, seeded
   Python tools. The LLM only writes reasoning text / picks options, always with a fallback.
2. Plain English, no emojis. Rs, kWh, kW. Campus = NHCE Bengaluru, Main Block + other blocks
   (see `../js/building.js`, `../js/config.js`; HUKUM Scan in `../js/scan/`).
3. Only edit files you own (below). Do not edit `state.py`, `ctx.py`, `nodes/__init__.py`.
4. Each node `run(state, ctx) -> dict` returns ONLY its own state key(s) (see state.py), never `messages`.
   Use `ctx.emit` / `ctx.tool` / `ctx.handoff` generously: 4-10 trace lines per node make the UI come alive.
5. Nodes must be defensive: other agents' keys may be missing (run in any order / alone).
6. Each node must finish in < 1 s offline. Standard library only for tools (no numpy needed; it is fine
   if installed but don't require it).

## Graph (owner: core)
START -> supervisor -> {agent} -> supervisor -> ... -> reporter -> END
Solar loop: solar_planner -> environment -> (env_review.approved == False and plan_iterations < 4)
? solar_planner : supervisor.
Supervisor builds `route` from `mode`:
- full: mapping, solar_planner(+environment loop), solar_health, fault_maintenance, bill_auditor, negotiator, optimiser, control
- plan_solar: mapping, solar_planner(+loop)
- operate: solar_health, fault_maintenance, optimiser, control
- audit: bill_auditor, negotiator, solar_health
- custom: `state.agents` in display order (environment is auto-added after solar_planner)
With a real LLM the supervisor may ask the model to pick the route from `goal` (validated against AGENT_IDS,
fallback = mode route). The supervisor emits a "thought" explaining the route.
Control: when `scenario.pilot_mode == "approve"` and there are actions, the control node calls
`langgraph.types.interrupt({"actions": [...]})` (MemorySaver checkpointer); the server resumes with
`Command(resume={"decision": "approve"|"reject", "ids": [...]})`. Control marks actions accordingly.
(In shadow mode: status "shadow"; automate: "executed".)

## HTTP API (owner: core, server.py) - same origin as the static site
FastAPI also serves the whole `hukum-prototype/` folder statically at `/` (index.html, scan.html, agents.html ...).
- `GET /api/health` -> `{"ok": true, "llm": "groq:openai/gpt-oss-120b" | "offline (scripted)", "agents": AGENTS as [{id,label,role}]}`
- `GET /api/graph` -> `{"nodes":[{"id","label","role","kind":"agent"|"router"|"terminal"}], "edges":[{"from","to","kind":"normal"|"conditional"|"loop"}]}`
- `POST /api/run` body `{"goal": str, "mode": str, "agents": [str]?, "scenario": {...}}` -> `{"thread_id": str}`
  Starts the graph in a background thread.
- `GET /api/stream/{thread_id}` -> Server-Sent Events, each `data: <json>\n\n`, event objects:
  - `{"type":"run_start","thread_id","goal","mode","llm"}`
  - `{"type":"node_start","agent": id}`
  - `{"type":"message","agent": id,"data": Message}`            (from ctx.emit)
  - `{"type":"node_end","agent": id,"update": {<state key>: value}}`  (the node's returned dict)
  - `{"type":"interrupt","agent":"control","data":{"actions":[...]}}`  (waits for /api/resume)
  - `{"type":"done","state": {...final state without messages...}}`
  - `{"type":"error","agent": id|null,"text": str}`
  Late subscribers get the full backlog first (events are kept per thread).
- `POST /api/resume/{thread_id}` body `{"decision":"approve"|"reject","ids":[...]}` -> `{"ok":true}`
- `GET /api/state/{thread_id}` -> latest state snapshot.
- `POST /api/ask` body `{"agent": id, "question": str, "thread_id": str?}` -> `{"answer": str}`
  (LLM answers in that agent's voice using its slice of state; offline: deterministic summary from state.)

## Replay file (owner: core)
`agents/data/demo_run.json` = `{"meta":{...}, "graph": <GET /api/graph>, "events": [<SSE events in order, with "dt" ms delay>]}`
recorded from an offline `mode:"full"`, `pilot_mode:"approve"` run (the interrupt + an "approve" resume included).
The frontend replays it when `/api/health` fails (e.g. site served by plain `python -m http.server`).

## LLM (owner: core, llm.py)
`get_llm()` -> GroqLLM if `GROQ_API_KEY` set and `HUKUM_OFFLINE` != "1", else OfflineLLM.
GroqLLM uses `langchain_groq.ChatGroq(model=os.getenv("HUKUM_MODEL","openai/gpt-oss-120b"), temperature=0.2, timeout=25, max_retries=1)`,
implements think/choose/json exactly like OfflineLLM, catches every exception and returns the fallback
(emitting nothing itself). Strip any reasoning tags; json() extracts the first {...} block.
Optional `.env` support in hukum-prototype/agents/.env (simple KEY=VALUE parser, no dependency).

## Ownership
- core: `agents/llm.py, graph.py, server.py, nodes/supervisor.py (+reporter in graph or nodes/reporter.py), requirements.txt, data/demo_run.json, tests/test_graph.py, README_AGENTS.md`
- planning: `nodes/mapping.py, nodes/solar_planner.py, nodes/environment.py, nodes/solar_health.py, tools/mapping_tools.py, tools/solar_tools.py, tools/export_scan.mjs, data/scan_model.json`
- operations: `nodes/fault_maintenance.py, nodes/bill_auditor.py, nodes/negotiator.py, nodes/control.py, nodes/optimiser.py, tools/ops_tools.py, tools/market_tools.py, tools/optim_tools.py`
- frontend: `agents.html, css/agents.css, js/agents/*.js, css/nav.css, js/nav.js` + inserting the shared nav into `index.html` and `scan.html` (only a `<link>`, a `<nav>` mount/`<script>`, nothing else)
