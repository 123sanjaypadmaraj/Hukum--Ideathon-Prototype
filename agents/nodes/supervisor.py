"""Supervisor: builds the route from the mode (or the goal, with a real LLM) and
hands control to the next agent. Owner: core.

Returns {"route": [...remaining], "next": "<agent id>" | "reporter"}.
"environment" is never put in the route: it is reached through the solar loop
(solar_planner -> environment -> solar_planner ... -> supervisor).
"""
from __future__ import annotations

from ..ctx import OfflineLLM
from ..state import AGENT_IDS

# Canonical execution order (optimiser plans before control acts).
ORDER = ["mapping", "solar_planner", "environment", "solar_health", "fault_maintenance",
         "bill_auditor", "negotiator", "optimiser", "control"]

MODE_ROUTES = {
    "full": ["mapping", "solar_planner", "solar_health", "fault_maintenance", "bill_auditor",
             "negotiator", "optimiser", "control"],
    "plan_solar": ["mapping", "solar_planner"],
    "operate": ["solar_health", "fault_maintenance", "optimiser", "control"],
    "audit": ["bill_auditor", "negotiator", "solar_health"],
}

LABELS = {
    "mapping": "Mapping", "solar_planner": "Solar Planner", "environment": "Environmental Engineer",
    "solar_health": "Solar Health", "fault_maintenance": "Fault & Maintenance", "bill_auditor": "Bill Auditor",
    "negotiator": "Multi-Campus Negotiator", "control": "Control", "optimiser": "State Optimiser",
}

WHY = {
    "mapping": "build the building model first so every other agent works from the same roof, rooms and meters",
    "solar_planner": "size the rooftop array; the Environmental Engineer reviews each draft until it passes",
    "solar_health": "check how the existing array is performing",
    "fault_maintenance": "turn anomalies into work orders",
    "bill_auditor": "check the utility bills against meter data and the tariff",
    "negotiator": "verify export credit and trade surplus with partner campuses",
    "optimiser": "plan tomorrow's 96 slots for minimum cost",
    "control": "turn the plan into safe actions under the pilot mode",
}


def normalise(ids) -> list[str]:
    """Validate, de-duplicate, drop environment (loop-only), sort into canonical order."""
    seen = []
    for a in ids or []:
        a = str(a).strip()
        if a in AGENT_IDS and a not in seen:
            seen.append(a)
    if "environment" in seen and "solar_planner" not in seen:
        seen.append("solar_planner")  # the engineer needs a plan to review
    return [a for a in ORDER if a in seen and a != "environment"]


def default_route(state) -> list[str]:
    mode = state.get("mode") or "full"
    if mode == "custom":
        r = normalise(state.get("agents") or [])
        return r or list(MODE_ROUTES["full"])
    return list(MODE_ROUTES.get(mode, MODE_ROUTES["full"]))


def _plan_route(state, ctx) -> list[str]:
    fallback = default_route(state)
    mode = state.get("mode") or "full"
    if mode == "custom" or isinstance(ctx.llm, OfflineLLM):
        return fallback
    obj = ctx.llm.json(
        "supervisor",
        system=("You are the supervisor of a team of campus-energy agents. Pick which agents should run, in order, "
                f"to satisfy the user's goal. Valid agent ids: {[a for a in ORDER if a != 'environment']}. "
                "The environment agent runs automatically after solar_planner. "
                'Return {"route": [ids], "why": str}.'),
        payload={"goal": state.get("goal", ""), "mode": mode, "default_route": fallback},
        fallback={"route": fallback},
    )
    picked = normalise(obj.get("route") if isinstance(obj.get("route"), list) else [])
    # The mode is a promise to the user ("Full: every agent"): the model may add
    # agents the goal calls for, but never drop one the chosen mode includes.
    extra = [a for a in picked if a not in fallback]
    if extra:
        ctx.emit("thought", "The goal also needs: " + ", ".join(LABELS.get(a, a) for a in extra) + ".")
    return normalise(fallback + picked)


def run(state, ctx) -> dict:
    first = state.get("route") is None
    if first:
        route = _plan_route(state, ctx)
        names = ", ".join(LABELS.get(a, a) for a in route)
        loop = (" The Environmental Engineer will review every solar draft in a loop (max 4 passes)."
                if "solar_planner" in route else "")
        fallback = (f"Goal: {state.get('goal') or 'run the campus energy team'}. "
                    f"Mode '{state.get('mode') or 'full'}', so the plan is: {names}.{loop}")
        text = ctx.llm.think("supervisor",
                             system="You are the HUKUM supervisor. Explain the plan of agents to the user in 2 sentences.",
                             payload={"goal": state.get("goal"), "route": route}, fallback=fallback)
        ctx.emit("thought", text, {"route": route})
    else:
        route = list(state.get("route") or [])
        last = (state.get("done") or [None])[-1]
        if last:
            ctx.emit("thought", f"{LABELS.get(last, last)} finished. {len(route)} agent(s) left in the plan.")

    if route:
        nxt, rest = route[0], route[1:]
        ctx.handoff(nxt, WHY.get(nxt, "next step in the plan"))
    else:
        nxt, rest = "reporter", []
        ctx.emit("handoff", "All agents finished. Handing over to the reporter for the final briefing.",
                 {"to": "reporter"})
    return {"route": rest, "next": nxt}
