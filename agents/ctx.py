"""AgentCtx: what every agent node gets. THIS FILE IS PART OF THE CONTRACT.

Rule that keeps the demo bullet-proof: numbers come from deterministic Python
tools; the LLM only writes reasoning text or picks between options, and every
LLM call carries a fallback that is used when there is no key, no network, a
timeout, or unparseable output. A node must produce correct output with
OfflineLLM.

Node signature (in agents/nodes/<id>.py):

    def run(state: HukumState, ctx: AgentCtx) -> dict   # partial state update, own key(s) only

Inside a node:
    ctx.emit("thought", "Reading the roof segments from the Solar API")
    roof = ctx.tool("solar_api_roof", tools.roof_segments, lat=..., lon=...)   # emits tool call + result
    text = ctx.llm.think(agent, system="You are ...", payload={...}, fallback="Deterministic sentence.")
    k = ctx.llm.choose(agent, "Which option?", ["a", "b"], payload={...}, fallback=0)
    obj = ctx.llm.json(agent, system="...", payload={...}, fallback={...})     # dict, keys merged over fallback
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable


class OfflineLLM:
    """Deterministic stand-in. The real Groq client (agents/llm.py) has the same methods."""
    name = "offline (scripted)"

    def think(self, agent: str, system: str, payload: dict, fallback: str) -> str:
        return fallback

    def choose(self, agent: str, question: str, options: list[str], payload: dict, fallback: int = 0) -> int:
        return fallback

    def json(self, agent: str, system: str, payload: dict, fallback: dict) -> dict:
        return dict(fallback)


def _summ(x: Any, limit: int = 600) -> Any:
    """Keep tool results small enough to stream to the UI."""
    try:
        s = json.dumps(x, default=str)
    except Exception:
        return str(x)[:limit]
    if len(s) <= limit:
        return x
    if isinstance(x, list):
        return {"items": len(x), "first": x[:3]}
    if isinstance(x, dict):
        return {k: (v if len(json.dumps(v, default=str)) < 160 else "...") for k, v in list(x.items())[:14]}
    return s[:limit]


class AgentCtx:
    def __init__(self, agent: str, llm: Any = None, sink: Callable[[dict], None] | None = None, scenario: dict | None = None):
        self.agent = agent
        self.llm = llm or OfflineLLM()
        self.sink = sink or (lambda e: None)
        self.scenario = scenario or {}
        self.messages: list[dict] = []

    def emit(self, kind: str, text: str, data: Any = None) -> None:
        m = {"agent": self.agent, "kind": kind, "text": text, "t": time.time()}
        if data is not None:
            m["data"] = _summ(data)
        self.messages.append(m)
        self.sink({"type": "message", "agent": self.agent, "data": m})

    def tool(self, name: str, fn: Callable, **kwargs) -> Any:
        self.emit("tool", f"{name}({', '.join(f'{k}={v!r}' for k, v in kwargs.items() if not isinstance(v, (dict, list)))})", {"tool": name})
        t0 = time.time()
        out = fn(**kwargs)
        self.emit("result", f"{name} done in {int((time.time() - t0) * 1000)} ms", {"tool": name, "result": _summ(out)})
        return out

    def handoff(self, to: str, why: str) -> None:
        self.emit("handoff", f"Handing over to {to}: {why}", {"to": to})
