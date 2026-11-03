"""Solar Health Agent: performance ratio, string-level faults, soiling and
inverter health for the existing campus PV fleet (MB, SVP, NSB)."""
from __future__ import annotations

from ..tools import solar_tools as st


def run(state, ctx):
    scenario = state.get("scenario") or getattr(ctx, "scenario", None) or {}
    weather = scenario.get("weather", "sunny") if isinstance(scenario, dict) else "sunny"
    if weather not in st.INSOLATION:
        weather = "sunny"
    ctx.emit("thought", f"Checking the existing {sum(k for _, k, _ in st.FLEET)} kWp fleet (MB 400, SVP 250, NSB 250 kWp; 6 inverters, 36 strings of 25 kWp) against what today's {weather} sky should give.")
    h = ctx.tool("fleet_health", st.fleet_health, weather=weather, seed=2026)
    ctx.emit("result", f"Performance ratio {h['pr']:.2f} vs target {h['target_pr']:.2f}: {h['actual_kwh']:,} of {h['expected_kwh']:,} kWh expected today. Lost {h['lost_kwh_day']} kWh = Rs {h['lost_rs_day']:,}/day at 6.4 Rs/kWh.", {"loss_breakdown_kwh": h["loss_breakdown_kwh"]})

    bad = [s for s in h["strings"] if s["status"] != "ok"]
    fault = [s for s in bad if s["status"] == "fault"]
    nsb = [s for s in bad if s["id"].startswith("NSB")]
    other = [s for s in bad if s["status"] == "degraded" and not s["id"].startswith("NSB")]
    for s in fault:
        ctx.emit("warning", f"FAULT {s['id']} on {s['inverter']}: {s['kw']} kW vs {s['expected_kw']} expected. {s['diagnosis']}")
    if nsb:
        ctx.emit("warning", f"SOILING NSB: all {len(nsb)} strings about {round((1 - sum(s['ratio'] for s in nsb) / len(nsb)) * 100)}% low with the same shape. {nsb[0]['diagnosis']} Cleaning due.")
    for s in other:
        ctx.emit("warning", f"DEGRADED {s['id']}: ratio {s['ratio']}, {s['v']} V. {s['diagnosis']}")
    for inv in h["inverters"]:
        if inv["id"] == "MB-INV1":
            ctx.emit("warning", f"{inv['id']}: {'; '.join(inv['alarms'])}.")
    ok_inv = [i["id"] for i in h["inverters"] if i["status"] == "ok"]
    ctx.emit("result", f"Healthy: {len(h['strings']) - len(bad)} of {len(h['strings'])} strings; inverters {', '.join(ok_inv)} normal.")

    br = h["loss_breakdown_kwh"]
    summary = (f"PR {h['pr']:.2f} vs {h['target_pr']:.2f} target; {h['lost_kwh_day']} kWh (Rs {h['lost_rs_day']:,}) lost today. "
               f"Biggest losses: NSB soiling {br['NSB soiling']} kWh (clean now, 41 days since last), SVP-INV2 string S07 open {br['SVP-S07 open string']} kWh (replace fuse), "
               f"MB-INV1 overheating at 71 C {br['MB-INV1 derating']} kWh (clean fan and filter), MB-S12 suspected PID or cracked module {br['MB-S12 PID / cracked module']} kWh (IV and EL test).")
    ctx.handoff("fault_maintenance", "1 fault, 1 soiled block, 1 hot inverter and 1 degraded string need work orders")
    out = {k: h[k] for k in ("pr", "expected_kwh", "actual_kwh", "soiling_loss_pct", "strings", "inverters", "cleaning_due")}
    out.update({"summary": summary, "target_pr": h["target_pr"], "lost_kwh_day": h["lost_kwh_day"], "lost_rs_day": h["lost_rs_day"],
                "loss_breakdown_kwh": br, "days_since_cleaning": h["days_since_cleaning"], "weather": weather, "kwp": h["kwp"]})
    return {"solar_health": out}
