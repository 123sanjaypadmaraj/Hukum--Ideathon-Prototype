"""Environmental Engineer: reviews every solar plan (fire access, plant zones,
structure, glare, wind, CO2, water) and sends it back until it passes."""
from __future__ import annotations

from ..tools import solar_tools as st


def run(state, ctx):
    plan = state.get("solar_plan") or {}
    building = state.get("building") or {}
    if not plan.get("config"):
        ctx.emit("warning", "There is no solar plan to review yet; asking the Solar Planner for one.")
        ctx.handoff("solar_planner", "nothing to review")
        return {"env_review": {"iteration": 0, "approved": False, "issues": [{"code": "NO_PLAN", "severity": "block", "text": "No solar plan in state.", "fix": "Run the Solar Planner first."}],
                               "co2_avoided_t_year": 0.0, "embodied_co2_t": 0.0, "carbon_payback_years": 0.0, "water_l_year": 0.0, "notes": []}}

    it = plan.get("iteration", 1)
    ctx.emit("thought", f"Reviewing plan pass {it}: {plan.get('kwp')} kWp, {plan.get('tilt_deg')} deg, setback {plan.get('setback_m')} m. Roof envelope first; glare and wind only once row positions are fixed.")
    r = ctx.tool("review_plan", st.review_plan, plan=plan, building=building)
    ctx.emit("result", f"Stage {r['stage']} review ({'roof envelope' if r['stage'] == 1 else 'array design'}): {sum(i['severity'] == 'block' for i in r['issues'])} block, {sum(i['severity'] == 'warn' for i in r['issues'])} warn.")
    for i in r["issues"]:
        ctx.emit("warning" if i["severity"] == "block" else "thought", f"{i['severity'].upper()} {i['code']}: {i['text']} Fix: {i['fix']}")
    ctx.emit("result", f"Carbon: avoids {r['co2_avoided_t_year']} t CO2/yr at {st.GRID_CO2_KG_KWH} kg/kWh; embodied {r['embodied_co2_t']} t ({st.EMBODIED_KG_PER_KWP} kg/kWp + ballast) -> carbon payback {r['carbon_payback_years']} years. Cleaning water {r['water_l_year']:,} L/yr.")

    conditions = [f"{i['code']}: {i['fix']}" for i in r["issues"] if i["severity"] == "warn"]
    if r["approved"]:
        fallback = (f"Approved at pass {it} with {len(conditions)} conditions. The array keeps the fire access strip and plant zones clear, "
                    f"glare toward the road is controlled, ballast meets IS 875 Part 3, and it pays back its embodied carbon in about {r['carbon_payback_years']} years.")
    else:
        blocks = [i["code"] for i in r["issues"] if i["severity"] == "block"]
        fallback = f"Sent back at pass {it}: {', '.join(blocks)} must be fixed before I can sign. Warnings stay as conditions."
    note = ctx.llm.think("environment", system="You are a rooftop solar environmental and safety engineer in Bengaluru. In two plain sentences, give your verdict on this plan. No new numbers.",
                         payload={"plan": {k: plan.get(k) for k in ("iteration", "kwp", "tilt_deg", "setback_m")}, "issues": r["issues"], "approved": r["approved"]},
                         fallback=fallback)
    ctx.emit("llm" if note != fallback else "thought", note)
    review = {
        "iteration": it, "approved": r["approved"], "issues": r["issues"],
        "co2_avoided_t_year": r["co2_avoided_t_year"], "embodied_co2_t": r["embodied_co2_t"],
        "carbon_payback_years": r["carbon_payback_years"], "water_l_year": r["water_l_year"],
        "notes": [note] + (["Conditions: " + "; ".join(conditions)] if r["approved"] and conditions else []),
        "conditions": conditions if r["approved"] else [], "stage": r["stage"],
        "structural": r["structural"], "wind": r["wind"], "glare": r["glare"],
    }
    if r["approved"]:
        ctx.handoff("supervisor", f"plan pass {it} approved with {len(conditions)} conditions")
    else:
        ctx.handoff("solar_planner", "plan blocked, revise and resubmit")
    return {"env_review": review}
