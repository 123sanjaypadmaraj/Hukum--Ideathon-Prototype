# HUKUM agent team

A LangGraph multi-agent backend for the HUKUM campus-energy twin (NHCE Bengaluru).
Nine specialist agents, a supervisor and a reporter share one state; a FastAPI server
streams every thought, tool call and hand-off to `agents.html` over Server-Sent Events.

## Run it

```
cd hukum-prototype
pip install -r agents/requirements.txt
python -m agents.server            # http://127.0.0.1:8000/agents.html  (PORT=9000 to change)
```

The same server also serves the digital twin (`/index.html`) and HUKUM Scan (`/scan.html`).

Other commands (all from `hukum-prototype/`):

| Command | What it does |
|---|---|
| `python -m agents.tests.test_graph` | Offline end-to-end tests: every mode, the solar loop, approve/reject interrupts, HTTP API |
| `python -m agents.record_demo` | Re-records `agents/data/demo_run.json` (offline, mode full, pilot mode approve) |

## Architecture

```
POST /api/run (goal, mode, scenario)
        |
        v
      START --> supervisor --(state.next)--> one agent --> back to supervisor ...
                  |   ^
                  |   +-- mapping, solar_health, fault_maintenance, bill_auditor,
                  |       negotiator, optimiser, control
                  |   |
                  |   +-- solar_planner --> environment --(approved, or 4 passes)--+
                  |            ^                 |                                   |
                  |            +---- loop -------+ (not approved, passes < 4)        |
                  |                                                                  |
                  |   <--------------------------------------------------------------+
                  |
                  +--(route empty)--> reporter --> END

control: interrupt({"actions": [...]}) --> server waits for POST /api/resume/{id}

Every ctx.emit / node start / node end --> per-run event log
  --> GET /api/stream/{id} (SSE: backlog first, then live) --> agents.html
```

* **Supervisor** (`nodes/supervisor.py`) builds the route on its first visit from the mode
  (`full`, `plan_solar`, `operate`, `audit`, `custom`), or, with a real LLM, from the goal
  (validated against the agent ids, falling back to the mode route). It then pops one agent at a time.
  Custom selections run in canonical order (optimiser before control); picking only `environment`
  also adds `solar_planner`, because the engineer needs a plan to review.
* **Solar loop**: `solar_planner -> environment`; the engineer sends the plan back while
  `env_review.approved` is false and `plan_iterations < 4`.
* **Human in the loop**: with `scenario.pilot_mode == "approve"` the control node calls
  `interrupt({"actions": [...]})`. The server emits an `interrupt` event and waits for
  `POST /api/resume/{id}` with `{"decision": "approve"|"reject", "ids": [...]}`, then resumes with
  `Command(resume=...)` and records the decision in `state.approvals`. Unanswered approvals are rejected after 30 minutes.
* **Reporter** (`nodes/reporter.py`) turns whatever agent outputs exist into a headline, one section per
  agent and a KPI dictionary.
* A node that raises is logged as a `warning` message and the run continues without its update.

API summary: `GET /api/health`, `GET /api/graph`, `POST /api/run`, `GET /api/stream/{id}`,
`POST /api/resume/{id}`, `GET /api/state/{id}`, `POST /api/ask`. Full shapes are in `CONTRACT.md`.
The static server never serves hidden files (`.env`) or Python sources.

## LLM: offline by default, Groq when you want it

Numbers always come from deterministic, seeded Python tools. The LLM only writes reasoning text,
picks between options or chooses the route, and every call carries a fallback.

* **Offline (default)**: no key, no network. `OfflineLLM` returns the scripted fallbacks, so the demo
  produces the same run every time.
* **Groq**: copy `agents/.env.example` to `agents/.env` and set `GROQ_API_KEY`. Choose the model with
  `HUKUM_MODEL`:
  * `openai/gpt-oss-120b` (default, best reasoning)
  * `openai/gpt-oss-20b` (faster, cheaper)
  Restart the server; `/api/health` reports e.g. `"llm": "groq:openai/gpt-oss-120b"`.
* Set `HUKUM_OFFLINE=1` to force offline mode even when a key is present (e.g. on stage with bad Wi-Fi).

**Offline guarantee**: if the key is missing, the network is down, Groq times out (25 s, 1 retry) or the
answer cannot be parsed, every call returns its fallback and the run still finishes. The frontend also
replays `agents/data/demo_run.json` when `/api/health` is unreachable (for example when the site is
served by `python -m http.server`), so the agents page always has something to show.
