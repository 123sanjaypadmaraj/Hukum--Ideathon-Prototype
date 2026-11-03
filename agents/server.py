"""HUKUM agent server. Owner: core.

    python -m agents.server          (from hukum-prototype/; PORT env overrides 8000)

Serves the JSON/SSE API under /api/* and the whole hukum-prototype/ folder as
static files at / (index.html, scan.html, agents.html ...).
"""
from __future__ import annotations

import warnings

warnings.filterwarnings("ignore", message=".*Pydantic V1.*")
warnings.filterwarnings("ignore", category=UserWarning, module="langchain_core.*")

import json  # noqa: E402
import os  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import uuid  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

from fastapi import Body, FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from langgraph.types import Command  # noqa: E402

from .ctx import OfflineLLM  # noqa: E402
from .graph import build_graph, describe_graph  # noqa: E402
from .llm import get_llm  # noqa: E402
from .nodes.reporter import build_report  # noqa: E402
from .state import AGENT_IDS, AGENTS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent          # hukum-prototype/
DEMO_FILE = Path(__file__).resolve().parent / "data" / "demo_run.json"
MODES = ("full", "plan_solar", "operate", "audit", "custom")
RESUME_TIMEOUT_S = 30 * 60
MAX_RUNS = 30

# agent id -> its state key
STATE_KEY = {"mapping": "building", "solar_planner": "solar_plan", "environment": "env_review",
             "solar_health": "solar_health", "fault_maintenance": "faults", "bill_auditor": "bill_audit",
             "negotiator": "market", "control": "control", "optimiser": "optimiser", "reporter": "report"}

LLM = get_llm()


def jsonable(x: Any) -> Any:
    """Round-trip through json with default=str so every payload is safe to send."""
    return json.loads(json.dumps(x, default=str))


def strip_state(values: dict) -> dict:
    out = {k: v for k, v in (values or {}).items() if k != "messages"}
    return jsonable(out)


# --------------------------------------------------------------------------- runs
class Run:
    def __init__(self, thread_id: str, req: dict, llm: Any = None):
        self.id = thread_id
        # fresh client per run so each run gets its own time budget (see llm.GroqLLM)
        self.llm = llm or (LLM if isinstance(LLM, OfflineLLM) else get_llm())
        self.req = req
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.finished = False
        self.resume_event = threading.Event()
        self.resume_value: dict | None = None
        self.waiting = False
        self.created = time.time()
        self.config = {"configurable": {"thread_id": thread_id}}
        # duplicate suppression when LangGraph re-runs the interrupted node on resume
        self._cur_agent: str | None = None
        self._cur_msgs: list[str] = []
        self._skip: dict | None = None
        self.graph = build_graph(self.llm, self.sink)

    def push(self, ev: dict) -> None:
        ev = jsonable(ev)
        with self.cond:
            ev["seq"] = len(self.events)
            self.events.append(ev)
            if ev.get("type") in ("done", "error"):
                self.finished = True
            self.cond.notify_all()

    def sink(self, ev: dict) -> None:
        typ, agent = ev.get("type"), ev.get("agent")
        sk = self._skip
        if sk is not None:
            if typ == "node_start" and agent == sk["agent"] and sk["start"]:
                sk["start"] = False
                return
            if typ == "message" and agent == sk["agent"] and sk["texts"] and \
                    (ev.get("data") or {}).get("text") == sk["texts"][0]:
                sk["texts"].pop(0)
                return
            self._skip = None
        if typ == "node_start":
            self._cur_agent, self._cur_msgs = agent, []
        elif typ == "message" and agent == self._cur_agent:
            self._cur_msgs.append((ev.get("data") or {}).get("text"))
        self.push(ev)

    def initial_state(self) -> dict:
        r = self.req
        return {"goal": r.get("goal") or "", "mode": r.get("mode") or "full",
                "agents": list(r.get("agents") or []), "scenario": dict(r.get("scenario") or {}),
                "done": [], "plan_iterations": 0, "approvals": [], "messages": []}

    def execute(self) -> None:
        self.push({"type": "run_start", "thread_id": self.id, "goal": self.req.get("goal") or "",
                   "mode": self.req.get("mode") or "full", "llm": self.llm.name,
                   "scenario": self.req.get("scenario") or {}})
        inp: Any = self.initial_state()
        try:
            while True:
                result = self.graph.invoke(inp, self.config)
                intr = result.get("__interrupt__") if isinstance(result, dict) else None
                snap = self.graph.get_state(self.config)
                if not intr and not snap.next:
                    break
                value = intr[0].value if intr else {}
                agent = snap.next[0] if snap.next else "control"
                self._skip = {"agent": agent, "start": True, "texts": list(self._cur_msgs)} \
                    if agent == self._cur_agent else None
                self.waiting = True
                self.resume_event.clear()
                self.push({"type": "interrupt", "agent": agent, "data": value})
                if not self.resume_event.wait(RESUME_TIMEOUT_S):
                    self.resume_value = {"decision": "reject", "ids": [], "reason": "timeout"}
                self.waiting = False
                decision = dict(self.resume_value or {"decision": "reject", "ids": []})
                approvals = list(snap.values.get("approvals") or []) + [{**decision, "agent": agent, "t": time.time()}]
                inp = Command(resume=decision, update={"approvals": approvals})
            final = self.graph.get_state(self.config).values
            self.push({"type": "done", "state": strip_state(final)})
        except Exception as e:  # noqa: BLE001
            self.push({"type": "error", "agent": self._cur_agent, "text": f"{type(e).__name__}: {e}",
                       "trace": traceback.format_exc(limit=6)[-1500:]})

    def resume(self, value: dict) -> None:
        self.resume_value = value
        self.resume_event.set()


RUNS: dict[str, Run] = {}
RUNS_LOCK = threading.Lock()


def _get_run(thread_id: str) -> Run:
    run = RUNS.get(thread_id)
    if not run:
        raise HTTPException(404, f"unknown thread_id {thread_id}")
    return run


def _gc_runs() -> None:
    with RUNS_LOCK:
        if len(RUNS) <= MAX_RUNS:
            return
        for tid, r in sorted(RUNS.items(), key=lambda kv: kv[1].created)[: len(RUNS) - MAX_RUNS]:
            if r.finished:
                RUNS.pop(tid, None)


# --------------------------------------------------------------------------- app
app = FastAPI(title="HUKUM agents", version="1.0")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
                   allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"ok": True, "llm": LLM.name, "agents": [{"id": a, "label": l, "role": r} for a, l, r in AGENTS]}


@app.get("/api/graph")
def graph_desc():
    return describe_graph()


@app.post("/api/run")
def start_run(body: dict = Body(default={})):
    mode = body.get("mode") or "full"
    if mode not in MODES:
        raise HTTPException(400, f"mode must be one of {MODES}")
    agents = [a for a in (body.get("agents") or []) if a in AGENT_IDS]
    req = {"goal": str(body.get("goal") or ""), "mode": mode, "agents": agents,
           "scenario": body.get("scenario") if isinstance(body.get("scenario"), dict) else {}}
    tid = uuid.uuid4().hex[:12]
    run = Run(tid, req)
    with RUNS_LOCK:
        RUNS[tid] = run
    threading.Thread(target=run.execute, name=f"hukum-run-{tid}", daemon=True).start()
    _gc_runs()
    return {"thread_id": tid}


@app.get("/api/stream/{thread_id}")
def stream(thread_id: str):
    run = _get_run(thread_id)

    def gen():
        i = 0
        yield ": connected\n\n"
        while True:
            with run.cond:
                if i >= len(run.events) and not run.finished:
                    run.cond.wait(timeout=15)
                batch = run.events[i:]
                finished = run.finished
            if not batch:
                if finished:
                    return
                yield ": keep-alive\n\n"
                continue
            for ev in batch:
                i += 1
                yield f"id: {ev.get('seq', i)}\ndata: {json.dumps(ev, default=str)}\n\n"
                if ev.get("type") in ("done", "error"):
                    return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/resume/{thread_id}")
def resume(thread_id: str, body: dict = Body(default={})):
    run = _get_run(thread_id)
    if not run.waiting:
        raise HTTPException(409, "run is not waiting for approval")
    decision = body.get("decision") if body.get("decision") in ("approve", "reject") else "reject"
    ids = body.get("ids") if isinstance(body.get("ids"), list) else []
    run.resume({"decision": decision, "ids": [str(x) for x in ids]})
    return {"ok": True}


@app.get("/api/state/{thread_id}")
def state(thread_id: str):
    run = _get_run(thread_id)
    try:
        values = run.graph.get_state(run.config).values or {}
    except Exception:  # noqa: BLE001
        values = {}
    out = strip_state(values)
    out["_meta"] = {"thread_id": thread_id, "finished": run.finished, "waiting": run.waiting,
                    "events": len(run.events), "messages": len(values.get("messages") or [])}
    return out


def _state_for_ask(thread_id: str | None) -> dict:
    if thread_id and thread_id in RUNS:
        try:
            return RUNS[thread_id].graph.get_state(RUNS[thread_id].config).values or {}
        except Exception:  # noqa: BLE001
            return {}
    for r in sorted(RUNS.values(), key=lambda r: r.created, reverse=True):
        try:
            v = r.graph.get_state(r.config).values or {}
        except Exception:  # noqa: BLE001
            continue
        if v:
            return v
    try:
        events = json.loads(DEMO_FILE.read_text(encoding="utf-8")).get("events", [])
        for ev in reversed(events):
            if ev.get("type") == "done":
                return ev.get("state") or {}
    except Exception:  # noqa: BLE001
        pass
    return {}


def offline_answer(agent: str, state: dict, question: str = "") -> str:
    label = dict((a, l) for a, l, _ in AGENTS).get(agent, agent.title())
    if agent == "supervisor":
        done = state.get("done") or []
        if not done:
            return "No run yet. Start a run and I will route the goal through the right agents."
        return f"I routed the goal through {', '.join(dict.fromkeys(done))}. " + \
            ((state.get("report") or {}).get("headline") or "")
    key = STATE_KEY.get(agent)
    if not key or not state.get(key):
        return f"{label}: I have not run yet in this session, so I have no results to report."
    if agent == "reporter":
        rep = state.get("report") or {}
        return rep.get("headline") or "The briefing is ready."
    sections = [s for s in build_report(state)["sections"] if s["agent"] == agent]
    slice_ = state.get(key) or {}
    parts = []
    summ = slice_.get("summary") if isinstance(slice_, dict) else None
    if summ:
        parts.append(str(summ))
    for s in sections:
        parts += [b for b in s["bullets"] if b != summ]
    if not parts:
        parts.append(f"My output has {len(slice_)} field(s): {', '.join(list(slice_)[:8])}.")
    return f"{label}: " + " ".join(parts[:6])


@app.post("/api/ask")
def ask(body: dict = Body(default={})):
    agent = str(body.get("agent") or "supervisor")
    question = str(body.get("question") or "").strip()
    if agent not in AGENT_IDS and agent not in ("supervisor", "reporter"):
        raise HTTPException(400, "unknown agent")
    st = _state_for_ask(body.get("thread_id"))
    fb = offline_answer(agent, st, question)
    if isinstance(LLM, OfflineLLM) or not question:
        return {"answer": fb, "llm": LLM.name}
    key = STATE_KEY.get(agent)
    slice_ = st.get(key) if key else {"route": st.get("route"), "done": st.get("done"), "report": st.get("report")}
    role = dict((a, r) for a, _, r in AGENTS).get(agent, "Coordinates the HUKUM agent team.")
    answer = LLM.think(agent,
                       system=(f"You are the {agent} agent of HUKUM. Your role: {role} Answer the user's question in "
                               "your own voice, using only the numbers in your state. If the data does not cover it, say so."),
                       payload={"question": question, "my_state": jsonable(slice_)}, fallback=fb)
    return {"answer": answer, "llm": LLM.name}


@app.exception_handler(HTTPException)
def http_err(_req, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


class SafeStatic(StaticFiles):
    """Static files, but never hidden files (.env, .git) or Python sources."""

    async def get_response(self, path: str, scope):
        parts = Path(path).parts
        if any(p.startswith(".") for p in parts) or path.endswith((".py", ".pyc")) or "__pycache__" in parts:
            raise HTTPException(404, "not found")
        return await super().get_response(path, scope)


app.mount("/", SafeStatic(directory=str(ROOT), html=True), name="static")


def main() -> None:
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "127.0.0.1")
    mode = "offline (scripted, no API key needed)" if isinstance(LLM, OfflineLLM) else f"live LLM: {LLM.name}"
    print(f"HUKUM agents  |  LLM: {mode}", flush=True)
    print(f"  Agents UI : http://{host}:{port}/agents.html", flush=True)
    print(f"  Twin      : http://{host}:{port}/twin.html", flush=True)
    print(f"  API       : http://{host}:{port}/api/health  /api/graph  /api/run", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
