"""Fault & Maintenance Agent: anomalies -> prioritised work orders + failure prediction."""
from __future__ import annotations

from ..tools import ops_tools as ops

_RANK = {"P1": 0, "P2": 1, "P3": 2}


def _due(scenario: dict, days: int) -> str:
    import datetime as dt
    try:
        d0 = dt.date.fromisoformat(str(scenario.get("day")))
    except (TypeError, ValueError):
        d0 = dt.date(2026, 11, 3)
    return (d0 + dt.timedelta(days=days)).isoformat()


def run(state, ctx):
    sc = state.get("scenario") or {}
    ctx.emit("thought", "Collecting anomalies from Solar Health, the HUKUM Scan model and the Bill Auditor, then ranking them by safety and rupees at risk.")

    solar, src = ctx.tool("triage_solar_faults", ops.solar_work_orders, solar_health=state.get("solar_health"))
    if not state.get("solar_health"):
        ctx.emit("warning", "Solar Health has not reported yet; using the last fleet snapshot (S07 on SVP-INV2 open, S12 degraded, SVP-INV4 hot).")
    equip, _ = ctx.tool("check_nameplate_vs_nilm", ops.equipment_work_orders, building=state.get("building"))
    cams = ops.camera_work_orders(state.get("building"))
    ctx.emit("thought", f"HUKUM Scan open questions give {len(cams)} items: an obstructed camera in CSE-LAB2 and a circuit drawn in the wrong room.")
    cap = ops.capacitor_work_order(state.get("bill_audit"))
    if cap:
        ctx.emit("thought", f"Bill Auditor's power-factor penalty points at the capacitor bank: Rs {cap['rs_at_risk_month']:,.0f} per month at risk.")

    orders = solar + equip + cams + ([cap] if cap else [])
    orders.sort(key=lambda w: (_RANK[w["priority"]], -(w["energy_at_risk_kwh"] * ops.TARIFF_AVG_RS + w.get("rs_at_risk_month", 0))))
    work_orders = []
    for i, w in enumerate(orders, 1):
        rs = round(w["energy_at_risk_kwh"] * ops.TARIFF_AVG_RS + w.get("rs_at_risk_month", 0), 0)
        work_orders.append({"id": f"WO-{1100 + i}", "asset": w["asset"], "priority": w["priority"], "issue": w["issue"],
                            "evidence": w["evidence"], "action": w["action"], "due": _due(sc, w["due_days"]),
                            "est_cost_rs": w["est_cost_rs"], "energy_at_risk_kwh": w["energy_at_risk_kwh"],
                            "rs_at_risk_month": rs, "kind": w.get("kind"),
                            **({"string_id": w["string_id"], "inverter": w["inverter"]} if w.get("string_id") else {})})

    pred = ctx.tool("predict_failures", ops.predictive)
    hi = [p for p in pred if p["risk"] == "high"]
    if hi:
        ctx.emit("warning", f"{hi[0]['asset']}: {hi[0]['signal']}. Estimated {hi[0]['rul_days']} days to failure; book the bearing change in the December vacation.")

    p1 = [w for w in work_orders if w["priority"] == "P1"]
    rs_month = sum(w["rs_at_risk_month"] for w in work_orders)
    kwh_month = sum(w["energy_at_risk_kwh"] for w in work_orders)
    for w in p1:
        ctx.emit("result", f"{w['id']} P1 {w['asset']}: {w['action'].split(',')[0]} (due {w['due']}).")
    fallback = (f"{len(work_orders)} work orders ({len(p1)} P1): about {kwh_month:,.0f} kWh and Rs {rs_month:,.0f} per month at risk. "
                f"Top items: {', '.join(w['asset'] for w in work_orders[:3])}. "
                f"Predictive: {', '.join(f'{p['asset']} {p['rul_days']} d' for p in pred[:3])}.")
    summary = ctx.llm.think("fault_maintenance", system="You are a campus maintenance planner. Summarise the work orders in two plain sentences using only the numbers given.",
                            payload={"work_orders": work_orders[:6], "predictive": pred}, fallback=fallback) or fallback
    ctx.handoff("control", "isolate faulty PV strings and keep CSE-LAB2 fail-safe ON until its camera is fixed")
    return {"faults": {"work_orders": work_orders, "predictive": pred, "rs_at_risk_month": rs_month,
                       "energy_at_risk_kwh": kwh_month, "sources": [src, "HUKUM Scan", "bill_auditor" if cap else "-"],
                       "summary": summary}}
