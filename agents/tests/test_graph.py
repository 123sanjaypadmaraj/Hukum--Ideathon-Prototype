"""Offline end-to-end checks for the HUKUM graph and API. Owner: core.

    python -m agents.tests.test_graph
"""
from __future__ import annotations

import os
import warnings

warnings.filterwarnings("ignore")
os.environ["HUKUM_OFFLINE"] = "1"  # tests never call Groq, even when agents/.env has a key

import json  # noqa: E402
import time  # noqa: E402

from langgraph.types import Command  # noqa: E402

from ..ctx import OfflineLLM  # noqa: E402
from ..graph import build_graph, describe_graph  # noqa: E402
from ..state import AGENT_IDS  # noqa: E402

LLM = OfflineLLM()


def run_mode(mode: str, scenario: dict | None = None, agents: list | None = None, decision: str = "approve"):
    events: list[dict] = []
    g = build_graph(LLM, events.append)
    cfg = {"configurable": {"thread_id": f"test-{mode}-{time.time_ns()}"}, "recursion_limit": 80}
    inp = {"goal": f"test {mode}", "mode": mode, "agents": agents or [], "scenario": scenario or {"weather": "sunny"},
           "done": [], "plan_iterations": 0, "approvals": [], "messages": []}
    interrupts = []
    t0 = time.time()
    for _ in range(5):
        res = g.invoke(inp, cfg)
        intr = res.get("__interrupt__")
        if not intr:
            break
        interrupts.append(intr[0].value)
        ids = [a.get("id") for a in (intr[0].value or {}).get("actions", []) if isinstance(a, dict)]
        inp = Command(resume={"decision": decision, "ids": ids})
    snap = g.get_state(cfg)
    assert not snap.next, f"{mode}: graph did not terminate, next={snap.next}"
    st = snap.values
    json.dumps({k: v for k, v in st.items()}, default=str)  # JSON-safe
    return st, events, interrupts, time.time() - t0


def check_common(mode, st, events):
    rep = st.get("report")
    assert isinstance(rep, dict) and rep.get("headline"), f"{mode}: report missing"
    assert isinstance(rep.get("sections"), list) and isinstance(rep.get("kpis"), dict)
    assert st.get("route") == [], f"{mode}: route not empty"
    assert events[0]["type"] == "node_start" and events[0]["agent"] == "supervisor"
    assert events[-1]["type"] == "node_end" and events[-1]["agent"] == "reporter"
    for m in st.get("messages", []):
        assert m.get("agent") and m.get("kind") and isinstance(m.get("text"), str)
    done = st.get("done") or []
    if "solar_planner" in done:
        assert "environment" in done, f"{mode}: environment loop did not run after solar_planner"
        assert done.index("environment") > done.index("solar_planner")
        it = st.get("plan_iterations") or 0
        assert done.count("solar_planner") == done.count("environment")
        assert done.count("solar_planner") <= 4
        env = st.get("env_review") or {}
        if env and not env.get("approved"):
            assert it >= 4, f"{mode}: loop stopped early without approval"


def main():
    results = []

    st, ev, intr, dt = run_mode("full", {"weather": "sunny", "pilot_mode": "approve", "day": "2026-11-03"})
    check_common("full", st, ev)
    expected = ["mapping", "solar_planner", "solar_health", "fault_maintenance", "bill_auditor",
                "negotiator", "optimiser", "control"]
    done = st["done"]
    order = list(dict.fromkeys(a for a in done if a != "environment"))
    assert order == expected, f"full: order {order}"
    actions = (st.get("control") or {}).get("actions") or []
    if actions:
        assert intr, "full/approve: control had actions but no interrupt happened"
        assert any(a.get("status") in ("approved", "executed") for a in actions), "full: resume did not approve actions"
    results.append(("full", dt, len(ev), len(intr), done.count("solar_planner")))

    st, ev, intr, dt = run_mode("full", {"weather": "cloudy", "pilot_mode": "approve"}, decision="reject")
    check_common("full-reject", st, ev)
    actions = (st.get("control") or {}).get("actions") or []
    if intr and actions:
        assert not any(a.get("status") in ("approved", "executed") for a in actions), "reject: actions approved"
    results.append(("full-reject", dt, len(ev), len(intr), st["done"].count("solar_planner")))

    st, ev, intr, dt = run_mode("plan_solar")
    check_common("plan_solar", st, ev)
    assert "solar_planner" in st["done"] and "environment" in st["done"]
    assert "control" not in st["done"]
    results.append(("plan_solar", dt, len(ev), len(intr), st["done"].count("solar_planner")))

    st, ev, intr, dt = run_mode("operate", {"pilot_mode": "shadow"})
    check_common("operate", st, ev)
    assert list(dict.fromkeys(st["done"])) == ["solar_health", "fault_maintenance", "optimiser", "control"]
    assert not intr, "shadow mode must not interrupt"
    results.append(("operate", dt, len(ev), len(intr), 0))

    st, ev, intr, dt = run_mode("audit")
    check_common("audit", st, ev)
    assert list(dict.fromkeys(st["done"])) == ["bill_auditor", "negotiator", "solar_health"]
    results.append(("audit", dt, len(ev), len(intr), 0))

    st, ev, intr, dt = run_mode("custom", agents=["environment", "bill_auditor"])
    check_common("custom", st, ev)
    assert "solar_planner" in st["done"] and "environment" in st["done"] and "bill_auditor" in st["done"]
    results.append(("custom", dt, len(ev), len(intr), st["done"].count("solar_planner")))

    st, ev, intr, dt = run_mode("custom", agents=["optimiser", "control"], scenario={"pilot_mode": "automate"})
    check_common("custom-ops", st, ev)
    assert list(dict.fromkeys(st["done"])) == ["optimiser", "control"]
    assert not intr
    results.append(("custom-ops", dt, len(ev), len(intr), 0))

    # static graph description
    gd = describe_graph()
    ids = {n["id"] for n in gd["nodes"]}
    assert set(AGENT_IDS) <= ids and "supervisor" in ids and "reporter" in ids
    assert any(e["from"] == "environment" and e["to"] == "solar_planner" and e["kind"] == "loop" for e in gd["edges"])

    for name, dt, n_ev, n_int, loops in results:
        print(f"  ok  {name:<12} {dt * 1000:7.0f} ms  {n_ev:4d} events  interrupts={n_int}  solar passes={loops}")

    interrupt_wiring_test()
    http_tests()
    with fake_control():
        http_tests(label="http+fake-control", require_interrupt=True)
    print("ALL TESTS PASSED")


class fake_control:
    """Temporarily swap in a control node that always interrupts (tests the wiring, not the real node)."""

    def __enter__(self):
        from langgraph.types import interrupt
        from ..nodes import REGISTRY

        def ctl(state, ctx):
            ctx.emit("thought", "fake control: planning 2 actions")
            acts = [{"id": "A1", "status": "pending_approval"}, {"id": "A2", "status": "pending_approval"}]
            v = interrupt({"actions": acts})
            ok = set(v.get("ids") or [])
            for a in acts:
                a["status"] = "approved" if v.get("decision") == "approve" and a["id"] in ok else "rejected"
            ctx.emit("result", f"fake control: {v.get('decision')}")
            return {"control": {"pilot_mode": "approve", "actions": acts}}

        self.reg, self.old = REGISTRY, REGISTRY["control"]
        REGISTRY["control"] = ctl
        return self

    def __exit__(self, *a):
        self.reg["control"] = self.old


def interrupt_wiring_test():
    with fake_control():
        st, ev, intr, dt = run_mode("operate", {"pilot_mode": "approve"})
    check_common("fake-ctl", st, ev)
    assert len(intr) == 1 and intr[0]["actions"][0]["id"] == "A1"
    assert all(a["status"] == "approved" for a in st["control"]["actions"])
    print(f"  ok  {'fake-ctl':<12} {dt * 1000:7.0f} ms  {len(ev):4d} events  interrupts={len(intr)}  (resume approve)")


def http_tests(label: str = "http", require_interrupt: bool = False):
    try:
        from fastapi.testclient import TestClient
    except Exception as e:  # noqa: BLE001
        print(f"  skip HTTP tests ({e})")
        return
    from .. import server
    c = TestClient(server.app)
    h = c.get("/api/health").json()
    assert h["ok"] is True and len(h["agents"]) == len(AGENT_IDS) and h["llm"]
    g = c.get("/api/graph").json()
    assert g["nodes"] and g["edges"]
    assert c.get("/agents/.env").status_code == 404
    assert c.get("/agents/server.py").status_code == 404
    r = c.post("/api/run", json={"goal": "operate test", "mode": "operate",
                                 "scenario": {"pilot_mode": "approve"}}).json()
    tid = r["thread_id"]
    for _ in range(300):
        run = server.RUNS[tid]
        if run.waiting or run.finished:
            break
        time.sleep(0.02)
    assert run.waiting or not require_interrupt, "expected an interrupt"
    if run.waiting:
        assert c.post(f"/api/resume/{tid}", json={"decision": "approve", "ids": ["A1"]}).json() == {"ok": True}
    for _ in range(300):
        if run.finished:
            break
        time.sleep(0.02)
    assert run.finished
    with c.stream("GET", f"/api/stream/{tid}") as s:
        evs = [json.loads(line[6:]) for line in s.iter_lines() if line.startswith("data: ")]
    assert evs[0]["type"] == "run_start" and evs[-1]["type"] == "done", [e["type"] for e in evs[-3:]]
    assert "messages" not in evs[-1]["state"]
    if any(e["type"] == "interrupt" for e in evs):
        assert evs[-1]["state"].get("approvals"), "approvals not recorded on resume"
        starts = [e for e in evs if e["type"] == "node_start" and e["agent"] == "control"]
        assert len(starts) == 1, "duplicate control node_start after resume"
    a = c.post("/api/ask", json={"agent": "optimiser", "question": "what did you save?", "thread_id": tid}).json()
    assert isinstance(a["answer"], str) and a["answer"]
    stj = c.get(f"/api/state/{tid}").json()
    assert stj["_meta"]["finished"] is True
    if require_interrupt:
        acts = evs[-1]["state"]["control"]["actions"]
        assert [a["status"] for a in acts] == ["approved", "rejected"], acts
        msgs = [e["data"]["text"] for e in evs if e["type"] == "message" and e["agent"] == "control"]
        assert msgs.count("fake control: planning 2 actions") == 1, msgs
    print(f"  ok  {label:<12} health/graph/run/stream({len(evs)} events)/resume/ask/state")


if __name__ == "__main__":
    main()
