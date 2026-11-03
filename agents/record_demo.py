"""Record an offline demo run for the frontend replay. Owner: core.

    python -m agents.record_demo

Writes agents/data/demo_run.json = {"meta", "graph", "events"} where every event
carries "dt" (ms to wait before showing it). Forces OfflineLLM, mode "full",
pilot_mode "approve"; the interrupt is answered automatically with "approve".
An extra {"type":"resume"} event marks the human decision in the replay.
"""
from __future__ import annotations

import warnings

warnings.filterwarnings("ignore")

import json  # noqa: E402
import random  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

from .ctx import OfflineLLM  # noqa: E402
from .graph import describe_graph  # noqa: E402
from .server import DEMO_FILE, Run  # noqa: E402

GOAL = ("Map the Main Block, plan rooftop solar with an environmental review, check solar health, faults and bills, "
        "verify export credit with partner campuses, then optimise and control tomorrow.")
SCENARIO = {"weather": "sunny", "pilot_mode": "approve", "day": "2026-11-03"}
MODE = "full"


def _delay(ev: dict, rng: random.Random) -> int:
    t = ev.get("type")
    if t == "run_start":
        return 300
    if t == "node_start":
        return 700 if ev.get("agent") == "supervisor" else rng.randint(1000, 1400)
    if t == "message":
        kind = (ev.get("data") or {}).get("kind")
        if kind == "result":
            return rng.randint(500, 900)
        if kind == "handoff":
            return rng.randint(450, 700)
        return rng.randint(350, 900)
    if t == "node_end":
        return 300
    if t == "interrupt":
        return 800
    if t == "resume":
        return 3500
    if t == "done":
        return 1000
    return 400


def record() -> dict:
    rng = random.Random(20261103)
    run = Run("demo", {"goal": GOAL, "mode": MODE, "agents": [], "scenario": dict(SCENARIO)}, llm=OfflineLLM())
    th = threading.Thread(target=run.execute, daemon=True)
    th.start()
    resumed = []
    deadline = time.time() + 120
    while th.is_alive() and time.time() < deadline:
        last = run.events[-1] if run.events else {}
        if run.waiting and last.get("type") == "interrupt" and not run.resume_event.is_set():
            intr = last
            ids = [str(a.get("id")) for a in ((intr.get("data") or {}).get("actions") or []) if isinstance(a, dict)]
            value = {"decision": "approve", "ids": ids}
            resumed.append((len(run.events), value, intr.get("agent", "control")))
            run.resume(value)
        time.sleep(0.02)
    th.join(timeout=5)

    events = [dict(e) for e in run.events]
    # insert the human decision right after each interrupt (position recorded at resume time)
    for pos, value, agent in reversed(resumed):
        events.insert(pos, {"type": "resume", "agent": agent, "data": value})
    out = []
    for e in events:
        e.pop("seq", None)
        e.pop("t", None)
        e["dt"] = _delay(e, rng)
        out.append(e)
    if out and out[0].get("type") == "run_start":
        out[0]["thread_id"] = "demo"
    return {
        "meta": {"recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "llm": OfflineLLM.name, "goal": GOAL, "mode": MODE, "scenario": SCENARIO,
                 "events": len(out), "duration_ms": sum(e["dt"] for e in out)},
        "graph": describe_graph(),
        "events": out,
    }


def main() -> None:
    demo = record()
    DEMO_FILE.parent.mkdir(parents=True, exist_ok=True)
    DEMO_FILE.write_text(json.dumps(demo, indent=1, default=str), encoding="utf-8")
    types = {}
    for e in demo["events"]:
        types[e["type"]] = types.get(e["type"], 0) + 1
    last = demo["events"][-1]["type"] if demo["events"] else None
    print(f"Wrote {DEMO_FILE} ({len(demo['events'])} events, {demo['meta']['duration_ms'] / 1000:.0f} s replay, "
          f"last event: {last})")
    print("Event types:", types)


if __name__ == "__main__":
    main()
