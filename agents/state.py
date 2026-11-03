"""Shared LangGraph state for the HUKUM agent team. THIS FILE IS THE CONTRACT.

Every agent node reads what it needs and returns ONLY its own keys (partial
update). `messages` is append-only (reducer = operator.add) and is written by
the node runner from ctx.emit(); nodes never return `messages` themselves.

All money is in Indian rupees (Rs), energy kWh, power kW. Campus = NHCE,
Bengaluru (see ../js/config.js for the tariff: normal 8.0, solar hours 9-17
6.4, peak 18-22 9.6, export 3.0 Rs/kWh).
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict


class Message(TypedDict, total=False):
    agent: str          # node id, e.g. "mapping"
    kind: str           # "thought" | "tool" | "result" | "handoff" | "warning" | "llm"
    text: str           # plain English, no emojis
    data: Any           # optional JSON-serialisable payload (tool args/results)
    t: float            # unix time, filled by the runner


class HukumState(TypedDict, total=False):
    # ---- request -------------------------------------------------------
    goal: str                    # user's request in plain English
    mode: str                    # "full" | "plan_solar" | "operate" | "audit" | "custom"
    agents: list[str]            # for mode "custom": which agents to run
    scenario: dict               # {"weather": "sunny"|"cloudy"|"monsoon", "day": "2026-11-03",
                                 #  "pilot_mode": "shadow"|"approve"|"automate", "campuses": [...]}
    # ---- routing (supervisor) -----------------------------------------
    route: list[str]             # agents still to run, in order (supervisor pops from the front)
    done: list[str]              # agents that have finished
    next: str                    # node to go to next (set by supervisor)
    # ---- trace -----------------------------------------------------------
    messages: Annotated[list[Message], operator.add]

    # ---- agent outputs (each agent owns exactly one key) -----------------
    building: dict
    # mapping -> {
    #   "site": {"name","lat","lon"}, "building": {"id","name","floors","footprint_m2","height_m"},
    #   "roof": {"area_m2","usable_m2","segments":[{"index","pitch_deg","azimuth_deg","area_m2","sunshine_hours"}],
    #            "max_panels","panel_watts","max_kwp","source"},
    #   "irradiance": {"ghi_kwh_m2_day","source"},
    #   "rooms": [{"id","floor","name","area_m2","type","seats","confidence"}],
    #   "circuits": [{"id","panel","room","confidence"}],
    #   "equipment": [{"id","kind","rated_kw","measured_kw","room"}],
    #   "open_questions": [str], "sources": [str], "confidence": float }

    solar_plan: dict
    # solar_planner -> {"iteration": int, "kwp": float, "panels": int, "tilt_deg": float, "azimuth_deg": float,
    #   "segments_used": [int], "setback_m": float, "yield_kwh_year": float, "specific_yield": float,
    #   "capex_rs": float, "savings_rs_year": float, "payback_years": float, "self_consumption_pct": float,
    #   "battery_kwh": float, "history": [ {iteration, kwp, change, reason} ] }

    env_review: dict
    # environment -> {"iteration": int, "approved": bool, "issues": [{"code","severity":"block"|"warn","text","fix"}],
    #   "co2_avoided_t_year": float, "embodied_co2_t": float, "carbon_payback_years": float,
    #   "water_l_year": float, "notes": [str]}

    plan_iterations: int         # incremented by solar_planner each pass (loop guard: max 4)

    solar_health: dict
    # solar_health -> {"pr": float, "expected_kwh": float, "actual_kwh": float, "soiling_loss_pct": float,
    #   "strings": [{"id","inverter","kw","expected_kw","ratio","status":"ok"|"degraded"|"fault","diagnosis"}],
    #   "inverters": [{"id","status","efficiency","temp_c","alarms":[str]}], "cleaning_due": bool, "summary": str}

    faults: dict
    # fault_maintenance -> {"work_orders": [{"id","asset","priority":"P1"|"P2"|"P3","issue","evidence","action",
    #   "due","est_cost_rs","energy_at_risk_kwh"}], "predictive": [{"asset","risk","rul_days","signal"}], "summary": str}

    bill_audit: dict
    # bill_auditor -> {"bills": [{"month","units_kwh","amount_rs","demand_kva"}],
    #   "findings": [{"code","month","text","impact_rs","evidence","action"}],
    #   "overcharge_rs": float, "recoverable_rs": float, "tariff_check": dict, "summary": str}

    market: dict
    # negotiator -> {"export_price_rs": float, "grid_import_rs": float,
    #   "campuses": [{"id","name","surplus_kwh","deficit_kwh","bid_rs","ask_rs"}],
    #   "trades": [{"seller","buyer","kwh","price_rs","window","gain_rs"}],
    #   "export_check": {"metered_export_kwh","credited_kwh","credited_rs","expected_rs","shortfall_rs","verdict"},
    #   "summary": str}

    control: dict
    # control -> {"pilot_mode": str, "actions": [{"id","t","asset","action","kw","reason","status":
    #   "planned"|"pending_approval"|"approved"|"rejected"|"executed"|"shadow"}], "safety": [str], "summary": str}

    optimiser: dict
    # optimiser -> {"objective": str, "horizon_slots": 96,
    #   "baseline": {"cost_rs","peak_kw","co2_kg","export_kwh"}, "optimised": {...same},
    #   "saving_pct": float, "schedule": [{"slot","t","solar_kw","demand_kw","battery_kw","grid_kw","soc"}],
    #   "constraints": [str], "summary": str}

    approvals: list[dict]        # human-in-the-loop decisions recorded by the server on resume
    report: dict                 # reporter -> {"headline","sections":[{"agent","title","bullets":[str]}],"kpis":{...}}


# Every agent node id, in display order. Labels/roles shown in the UI.
AGENTS = [
    ("mapping", "Mapping Agent", "Builds the building model from blueprints, Google Solar API, Open Buildings, OSM, RoomPlan, CCTV and meters (HUKUM Scan)."),
    ("solar_planner", "Solar Planner", "Sizes and lays out rooftop solar + battery, yield and payback."),
    ("environment", "Environmental Engineer", "Reviews every solar plan in a loop: setbacks, shading, structure, CO2, water, glare. Sends it back until it passes."),
    ("solar_health", "Solar Health Agent", "Performance ratio, string-level faults, soiling and inverter health."),
    ("fault_maintenance", "Fault & Maintenance Agent", "Turns anomalies into prioritised work orders and predicts failures."),
    ("bill_auditor", "Bill Auditor", "Checks utility bills against meter data and the tariff; finds overcharges."),
    ("negotiator", "Multi-Campus Negotiator", "Verifies export credit and trades surplus solar between campuses at a fair price."),
    ("control", "Control Agent", "Turns plans into safe actions on rooms, HVAC, pumps, EVs and battery; respects the pilot mode."),
    ("optimiser", "State Optimiser", "Solves the next 24 h (96 slots) for minimum cost within comfort and safety limits."),
]
AGENT_IDS = [a[0] for a in AGENTS]
