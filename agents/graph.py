"""LangGraph wiring for the HUKUM agent team. Owner: core.

START -> supervisor -> {agent} -> supervisor -> ... -> reporter -> END
Solar loop: solar_planner -> environment -> (not approved and plan_iterations < 4)
            ? solar_planner : supervisor
"""
from __future__ import annotations

import time
import traceback
from typing import Any, Callable

from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphBubbleUp
from langgraph.graph import END, START, StateGraph

from .ctx import AgentCtx
from .nodes import REGISTRY
from .nodes import reporter as reporter_node
from .nodes import supervisor as supervisor_node
from .state import AGENT_IDS, AGENTS, HukumState

MAX_PLAN_ITERATIONS = 4


def _make_runner(agent: str, fn: Callable, llm: Any, sink: Callable[[dict], None], track_done: bool):
    def runner(state: HukumState) -> dict:
        ctx = AgentCtx(agent, llm, sink, state.get("scenario") or {})
        sink({"type": "node_start", "agent": agent, "t": time.time()})
        try:
            update = fn(state, ctx) or {}
        except GraphBubbleUp:
            # interrupt() (human approval) and other control-flow signals must reach LangGraph.
            raise
        except Exception as e:  # noqa: BLE001  keep the demo alive: one broken agent must not kill the run
            ctx.emit("warning", f"{agent} failed: {type(e).__name__}: {e}",
                     {"traceback": traceback.format_exc(limit=4)[-600:]})
            update = {}
        if not isinstance(update, dict):
            update = {}
        update = {k: v for k, v in update.items() if k not in ("messages", "done")}
        sink({"type": "node_end", "agent": agent, "update": update, "t": time.time()})
        out = {**update, "messages": ctx.messages}
        if track_done:
            out["done"] = list(state.get("done") or []) + [agent]
        return out

    runner.__name__ = f"run_{agent}"
    return runner


def _after_supervisor(state: HukumState) -> str:
    nxt = state.get("next") or "reporter"
    return nxt if nxt in AGENT_IDS else "reporter"


def _after_environment(state: HukumState) -> str:
    review = state.get("env_review")
    # A missing review (stub / crashed engineer) counts as approved so the loop cannot spin.
    approved = bool(review.get("approved")) if isinstance(review, dict) and "approved" in review else True
    if not approved and int(state.get("plan_iterations") or 0) < MAX_PLAN_ITERATIONS:
        return "solar_planner"
    return "supervisor"


def build_graph(llm: Any = None, sink: Callable[[dict], None] | None = None, checkpointer=None):
    sink = sink or (lambda e: None)
    g = StateGraph(HukumState)
    g.add_node("supervisor", _make_runner("supervisor", supervisor_node.run, llm, sink, track_done=False))
    for aid in AGENT_IDS:
        g.add_node(aid, _make_runner(aid, REGISTRY[aid], llm, sink, track_done=True))
    g.add_node("reporter", _make_runner("reporter", reporter_node.run, llm, sink, track_done=False))

    g.add_edge(START, "supervisor")
    targets = {aid: aid for aid in AGENT_IDS}
    targets["reporter"] = "reporter"
    g.add_conditional_edges("supervisor", _after_supervisor, targets)
    g.add_edge("solar_planner", "environment")
    g.add_conditional_edges("environment", _after_environment,
                            {"solar_planner": "solar_planner", "supervisor": "supervisor"})
    for aid in AGENT_IDS:
        if aid not in ("solar_planner", "environment"):
            g.add_edge(aid, "supervisor")
    g.add_edge("reporter", END)
    return g.compile(checkpointer=checkpointer or MemorySaver())


def describe_graph() -> dict:
    """Static description served at GET /api/graph."""
    nodes = [{"id": "__start__", "label": "Start", "role": "User goal and scenario", "kind": "terminal"},
             {"id": "supervisor", "label": "Supervisor",
              "role": "Plans the route from the goal and mode, then hands over to one agent at a time.",
              "kind": "router"}]
    nodes += [{"id": aid, "label": label, "role": role, "kind": "agent"} for aid, label, role in AGENTS]
    nodes += [{"id": "reporter", "label": "Reporter", "role": "Writes the final briefing with KPIs.", "kind": "terminal"},
              {"id": "__end__", "label": "End", "role": "Run complete", "kind": "terminal"}]
    edges = [{"from": "__start__", "to": "supervisor", "kind": "normal"}]
    for aid in AGENT_IDS:
        if aid != "environment":
            edges.append({"from": "supervisor", "to": aid, "kind": "conditional"})
    edges.append({"from": "supervisor", "to": "reporter", "kind": "conditional"})
    edges.append({"from": "solar_planner", "to": "environment", "kind": "normal"})
    edges.append({"from": "environment", "to": "solar_planner", "kind": "loop"})
    edges.append({"from": "environment", "to": "supervisor", "kind": "conditional"})
    for aid in AGENT_IDS:
        if aid not in ("solar_planner", "environment"):
            edges.append({"from": aid, "to": "supervisor", "kind": "normal"})
    edges.append({"from": "reporter", "to": "__end__", "kind": "normal"})
    return {"nodes": nodes, "edges": edges}
