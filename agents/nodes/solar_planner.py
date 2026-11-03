"""Solar Planner: sizes the Main Block rooftop array and revises it every time
the Environmental Engineer sends it back (loop guard: 4 passes)."""
from __future__ import annotations

import math

from ..tools import mapping_tools as mt
from ..tools import solar_tools as st

BASE = {"source": "solar_api_max", "tilt_deg": 15, "azimuth_deg": 197, "setback_m": 0.0, "exclude_plant": False,
        "include_stair_roof": True, "glass": "standard", "road_rows_ew": False, "drop_road_rows": False,
        "ballast_kg_m2": 30, "edge_ballast_kg_m2": 30, "battery_kwh": 0}

GLARE_OPTIONS = [
    "Lower the tilt to 10 deg, use anti-glare glass and turn the rows nearest the road east-west (keeps the panels)",
    "Drop the two rows nearest the road and keep 15 deg south (loses about 18 kWp)",
]


def _quote(issue: dict) -> str:
    t = issue.get("text", "")
    return f'Engineer ({issue.get("code")}): "{t[:220]}{"..." if len(t) > 220 else ""}"'


def _revise(cfg: dict, issues: list[dict], ctx, roof: dict) -> list[tuple[str, dict]]:
    """Apply a fix for every blocking issue; returns (change, issue) pairs."""
    changes = []
    for i in issues:
        code = i.get("code")
        if code == "FIRE_SETBACK":
            cfg.update(setback_m=1.2, include_stair_roof=False, source="geometric")
            changes.append(("Added a 1.2 m clear strip on every roof edge and dropped the 24 m2 stair-tower roof.", i))
        elif code == "PLANT_ZONE":
            cfg.update(exclude_plant=True, source="geometric")
            changes.append(("Removed panels over MB-PUMP and MB-AHU plus a 0.5 m service strip (220 m2).", i))
        elif code == "GLARE_ORR":
            k = ctx.llm.choose("solar_planner", "The engineer blocked the plan for glare toward the Outer Ring Road. Which fix keeps the most energy while removing the hazard?",
                               GLARE_OPTIONS, payload={"issue": i, "tilt_deg": cfg.get("tilt_deg")}, fallback=0)
            k = k if k in (0, 1) else 0
            if k == 0:
                cfg.update(tilt_deg=10, glass="anti-glare", road_rows_ew=True)
                changes.append(("Tilt 15 -> 10 deg, anti-glare glass on the road-side rows, and those rows turned east-west.", i))
            else:
                cfg.update(drop_road_rows=True)
                changes.append(("Dropped the two rows nearest the Outer Ring Road; kept 15 deg south elsewhere.", i))
    if any(i.get("code") == "WIND_UPLIFT" for i in issues):
        w = st.wind_check(cfg)          # re-check with the new tilt / orientation
        edge = int(math.ceil(w["required_edge_kg_m2"] / 5.0) * 5)
        inner = max(30, int(math.ceil(w["required_interior_kg_m2"] / 5.0) * 5))
        old = (cfg.get("edge_ballast_kg_m2"), cfg.get("ballast_kg_m2"))
        cfg.update(edge_ballast_kg_m2=edge, ballast_kg_m2=inner)
        wi = next(i for i in issues if i.get("code") == "WIND_UPLIFT")
        changes.append((f"Ballast raised from {old[0]}/{old[1]} to {edge}/{inner} kg/m2 (edge/interior) for the new layout.", wi))
    return changes


def run(state, ctx):
    it = int(state.get("plan_iterations") or 0) + 1
    building = state.get("building") or {}
    if not building.get("roof"):
        ctx.emit("warning", "No building model in state; loading the HUKUM Scan roof directly.")
        building = mt.build_building(mt.load_scan())
    roof = building["roof"]
    ghi = (building.get("irradiance") or {}).get("ghi_kwh_m2_day", st.GHI_DEFAULT)
    prev = state.get("solar_plan") or {}
    review = state.get("env_review") or {}
    history = list(prev.get("history") or [])

    if it == 1 or not prev.get("config"):
        cfg = dict(BASE)
        ctx.emit("thought", f"Pass {it}: starting from the Solar API maximum layout, {roof.get('max_panels')} panels on every roof segment at 15 deg, to show the ceiling before the engineer trims it.")
        changes = [("Solar API maximum array over all segments, 15 deg south, no setbacks.", None)]
    else:
        cfg = dict(prev["config"])
        blocks = [i for i in review.get("issues") or [] if i.get("severity") == "block"] if review.get("iteration") == prev.get("iteration") else []
        ctx.emit("thought", f"Pass {it}: the engineer returned pass {prev.get('iteration')} with {len(blocks)} blocking issue(s): {', '.join(i.get('code', '?') for i in blocks) or 'none'}. Revising.")
        changes = _revise(cfg, blocks, ctx, roof) or [("No blocking issues to fix; plan re-issued unchanged.", None)]

    lay = ctx.tool("layout_array", st.layout, cfg=cfg, roof=roof)
    econ = ctx.tool("yield_and_payback", st.economics, cfg=cfg, lay=lay, ghi=ghi)
    for change, issue in changes:
        history.append({"iteration": it, "kwp": lay["kwp"], "change": change,
                        "reason": _quote(issue) if issue else "First draft: the largest array the Solar API says fits."})
        ctx.emit("thought", f"Change: {change}" + (f" Because {_quote(issue)}" if issue else ""))

    prev_lay = prev.get("layout") or {}
    if prev_lay.get("pitch_m") and lay.get("pitch_m") and lay["pitch_m"] < prev_lay["pitch_m"]:
        ctx.emit("thought", f"Lower tilt shortens the 09:00 winter-solstice shadow, so the row pitch drops from {prev_lay['pitch_m']} to {lay['pitch_m']} m and {lay['panels'] - prev_lay.get('panels', 0)} more panels fit in the same zone.")
    ctx.emit("result", f"{lay['panels']} panels = {lay['kwp']} kWp at {cfg['tilt_deg']} deg; {econ['yield_kwh_year']:,} kWh/yr ({econ['specific_yield']} kWh/kWp, GHI {ghi} x 365 x PR {st.PR} x orientation {econ['orientation_factor']}).")
    ctx.emit("result", f"Capex Rs {econ['capex_rs'] / 1e5:.1f} lakh, saves Rs {econ['savings_rs_year'] / 1e5:.1f} lakh/yr ({econ['self_consumption_pct']}% used in the Main Block at 6.4 Rs/kWh, the rest exported at 3.0) -> payback {econ['payback_years']} years.")
    ctx.emit("thought", f"No new battery: the campus already has {st.EXISTING_BATTERY_KWH} kWh and {econ['self_consumption_pct']}% of this array is used on site.")
    plan = {
        "iteration": it, "kwp": lay["kwp"], "panels": lay["panels"], "tilt_deg": cfg["tilt_deg"], "azimuth_deg": cfg["azimuth_deg"],
        "segments_used": [0, 1] if cfg.get("include_stair_roof") else [0], "setback_m": cfg["setback_m"],
        "yield_kwh_year": econ["yield_kwh_year"], "specific_yield": econ["specific_yield"], "capex_rs": econ["capex_rs"],
        "savings_rs_year": econ["savings_rs_year"], "payback_years": econ["payback_years"],
        "self_consumption_pct": econ["self_consumption_pct"], "battery_kwh": cfg.get("battery_kwh", 0),
        "history": history, "config": cfg, "layout": lay, "economics": econ,
    }
    ctx.handoff("environment", f"plan pass {it}, {lay['kwp']} kWp, for review")
    return {"solar_plan": plan, "plan_iterations": it}
