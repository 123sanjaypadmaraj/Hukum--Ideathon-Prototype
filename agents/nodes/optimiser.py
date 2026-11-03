"""State Optimiser: solves tomorrow's 96 x 15-min slots for minimum cost.

Levers: pre-cooling (AHU-A, hostel HVAC), pump and EV / e-bus charging windows,
room auto-off, and a battery dispatch found by dynamic programming over SOC.
Compares against do-nothing and battery-only.
"""
from __future__ import annotations

from ..tools import ops_tools as ops
from ..tools import optim_tools as ot


def _pump1_kw(building) -> tuple[float, str]:
    m = ops.measured_overrides(building).get("PUMP-1")
    if m and 0 < m < 15:
        return m, f"PUMP-1 modelled at its measured {m:g} kW (HUKUM Scan / NILM), not the 15 kW nameplate"
    return 15.0, "PUMP-1 modelled at its 15 kW nameplate"


def run(state, ctx):
    sc = state.get("scenario") or {}
    weather = sc.get("weather") if sc.get("weather") in ot.WEATHER else "sunny"
    day = sc.get("day") or "tomorrow"
    kwp = 900.0
    extra = 0.0
    plan, env = state.get("solar_plan") or {}, state.get("env_review") or {}
    ctx.emit("thought", f"Solving {day} as 96 slots of 15 minutes, weather '{weather}'. Objective: tariff cost minus export credit, plus battery wear and the daily share of the demand charge.")
    if plan.get("kwp"):
        if env.get("approved"):
            extra = float(plan["kwp"])
            ctx.emit("thought", f"Environmental Engineer approved the {extra:.0f} kWp solar plan. Tomorrow still runs on the installed 900 kWp; I also solve the day with the new array to show its operating value.")
        else:
            ctx.emit("warning", f"Solar plan of {float(plan['kwp']):.0f} kWp is not approved yet, so only the installed 900 kWp is modelled.")
    p1, p1_note = _pump1_kw(state.get("building"))
    ctx.emit("thought", p1_note + ".")

    sol = ctx.tool("solve_day_ahead", ot.solve_day, weather=weather, kwp=kwp, pump1_kw=p1)
    b, bo, o = sol["baseline"], sol["battery_only"], sol["optimised"]

    ctx.emit("result", f"Do-nothing: Rs {b['cost_rs']:,.0f}, grid peak {b['peak_kw']:.0f} kW at {sol['baseline_peak_t']}, exports {b['export_kwh']:,.0f} kWh at only Rs 3.0.")
    ctx.emit("result", f"Battery only (DP, no load shifting): Rs {bo['cost_rs']:,.0f} (-{bo['saving_pct']:.1f} %), peak {bo['peak_kw']:.0f} kW.")
    moved = [m for m in sol["moves"] if m["to"] != m["from"]]
    shifts = "; ".join(f"{m['asset']} {m['from']} -> {m['to']}" for m in moved if m["asset"] in ("AHU-A", "HVAC-BD", "EBUS-1", "EBUS-2", "PUMP-1", "PUMP-2"))
    ctx.emit("thought", f"Load shifts into solar hours: {shifts}.")
    ctx.emit("result", f"HUKUM plan: Rs {o['cost_rs']:,.0f} (-{sol['saving_pct']:.1f} %), evening peak {b['evening_peak_kw']:.0f} -> {o['evening_peak_kw']:.0f} kW, CO2 {b['co2_kg']:,.0f} -> {o['co2_kg']:,.0f} kg.")

    # Market cross-reference: trades sell part of the midday export above the 3.0 credit
    mk = state.get("market") or {}
    market_credit = 0.0
    if mk.get("trades"):
        for t in mk["trades"]:
            net = float(t.get("seller_net_rs") or (float(t.get("price_rs") or 3.0) - 0.55))
            market_credit += float(t.get("kwh") or 0) * max(0.0, net - ot.TARIFF["export"])
        market_credit = round(min(market_credit, o["export_kwh"] * 3.0), 0)
        ctx.emit("thought", f"Negotiator cleared {sum(float(t.get('kwh') or 0) for t in mk['trades']):,.0f} kWh of inter-campus trades: Rs {market_credit:,.0f} more than exporting at 3.0 (kept separate from the headline).")

    sched = [{k: s[k] for k in ("slot", "t", "solar_kw", "demand_kw", "battery_kw", "grid_kw", "soc", "tariff", "baseline_demand_kw")} for s in sol["schedule"]]
    dis = [s for s in sched if s["battery_kw"] > 1]
    chg = [s for s in sched if s["battery_kw"] < -1]
    constraints = [
        f"Battery SOC kept within 10-95 % of 400 kWh, |power| <= 150 kW, round-trip efficiency 92 %, wear Rs 1.5/kWh; ends the day at or above the starting 50 % SOC",
        f"Grid import capped at {sol['cap_kw']:.0f} kW (cap chosen by search: energy cost + Rs 13.3/kW-day demand-charge share)" if sol["cap_kw"] else "No import cap needed",
        "Comfort 22-27 C: pre-cooling limited to 35 kW x 90 min on AHU-A and 60 kW x 90 min on hostel HVAC, 10 % rebound energy added, 80 % reliability assumed",
        "E-buses get their full 120 kWh each before the 07:30 run; staff EVs charged while parked 08:30-17:00",
        "Pumps run 2 h each inside their windows; tanks stay above 30 %",
        "Critical loads (data centre, Sanjeevini health centre, CCTV control room) are never shifted or shed",
        "Room auto-off only after 10 min empty on both CCTV and Wi-Fi; CSE-LAB2 excluded while its camera is obstructed",
    ]
    summary = (f"Tomorrow ({weather}): do-nothing Rs {b['cost_rs']:,.0f} vs HUKUM Rs {o['cost_rs']:,.0f} (-{sol['saving_pct']:.1f} %); "
               f"battery alone gets -{bo['saving_pct']:.1f} %. Evening peak {b['evening_peak_kw']:.0f} -> {o['evening_peak_kw']:.0f} kW. "
               f"Battery charges {chg[0]['t'] if chg else '-'}-{chg[-1]['t'] if chg else '-'} on solar and discharges in the 18:00-22:00 peak.")
    fallback = summary
    summary = ctx.llm.think("optimiser", system="You are the State Optimiser for a campus energy system. In two plain sentences, explain tomorrow's plan. Use only the numbers given.",
                            payload={"baseline": b, "optimised": o, "battery_only": bo, "moves": sol["moves"][:8]}, fallback=fallback) or fallback
    with_new = None
    if extra:
        ns = ot.solve_day(weather=weather, kwp=kwp + extra, pump1_kw=p1)
        with_new = {"kwp": kwp + extra, "baseline_cost_rs": ns["baseline"]["cost_rs"], "optimised_cost_rs": ns["optimised"]["cost_rs"],
                    "saving_pct": ns["saving_pct"], "extra_saving_vs_today_rs": round(o["cost_rs"] - ns["optimised"]["cost_rs"], 0)}
        ctx.emit("result", f"With the approved +{extra:.0f} kWp array: HUKUM day cost Rs {ns['optimised']['cost_rs']:,.0f}, a further Rs {with_new['extra_saving_vs_today_rs']:,.0f} per sunny day.")
        summary += f" Once the approved {extra:.0f} kWp is built, the same plan costs Rs {ns['optimised']['cost_rs']:,.0f} per sunny day."
    ctx.handoff("control", f"{len(dis)} discharge slots, {len(chg)} charge slots and {len(moved)} load moves to turn into actions")
    return {"optimiser": {
        "objective": "minimise tariff cost - export credit + battery wear + daily demand-charge share, within comfort and safety limits",
        "horizon_slots": ot.SLOTS,
        "weather": weather, "solar_kwp": kwp,
        "baseline": b,
        "optimised": dict(o, market_credit_rs=market_credit),
        "battery_only": bo,
        "with_new_solar": with_new,
        "saving_pct": sol["saving_pct"],
        "moves": sol["moves"],
        "schedule": sched,
        "constraints": constraints,
        "summary": summary,
    }}
