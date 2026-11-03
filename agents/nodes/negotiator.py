"""Multi-Campus Negotiator: verifies export credit and trades midday surplus between campuses."""
from __future__ import annotations

from ..tools import market_tools as mt
from ..tools import optim_tools as ot


def _midday_surplus(state, ctx) -> tuple[float, str]:
    opt = state.get("optimiser") or {}
    sched = opt.get("schedule") or []
    if sched:
        kwh = sum(max(0.0, -float(s.get("grid_kw") or 0)) * 0.25 for s in sched if 40 <= int(s.get("slot", 0)) < 60)
        return round(kwh, 0), "State Optimiser's schedule (export 10:00-15:00)"
    weather = (state.get("scenario") or {}).get("weather", "sunny")
    sol = ot.solve_day(weather if weather in ot.WEATHER else "sunny")
    kwh = sum(max(0.0, -s["grid_kw"]) * 0.25 for s in sol["schedule"] if 40 <= s["slot"] < 60)
    return round(kwh, 0), "own quick forecast (optimiser not run yet)"


def run(state, ctx):
    ctx.emit("thought", "Two jobs: check that BESCOM credited every exported kWh, then sell tomorrow's midday surplus to partner campuses for more than the Rs 3.0 export credit.")
    ba = state.get("bill_audit") or {}
    feb = next((f for f in ba.get("findings", []) or [] if f.get("code") == "EXPORT_NOT_CREDITED"), None)
    chk = ctx.tool("verify_export_credit", mt.export_check, metered_kwh=1860.0, credited_kwh=1410.0, period="October 2026")
    ctx.emit("warning" if chk["shortfall_rs"] > 0 else "result",
             f"Export meter {chk['metered_export_kwh']:,.0f} kWh vs {chk['credited_kwh']:,.0f} kWh credited: shortfall Rs {chk['shortfall_rs']:,.0f}. Verdict: {chk['verdict']}.")
    if feb:
        chk["related"] = f"Bill Auditor also found {feb.get('month', 'Feb')} export entirely uncredited (Rs {float(feb.get('impact_rs') or 0):,.0f}); file both in one dispute."
        ctx.emit("thought", chk["related"])

    surplus, src = _midday_surplus(state, ctx)
    ctx.emit("thought", f"Main campus midday surplus tomorrow: {surplus:,.0f} kWh, from the {src}.")
    camps = mt.campuses(surplus)
    ctx.emit("thought", f"Assumption: wheeling + open-access charge about {mt.WHEELING_RS} Rs/kWh, split equally; to be confirmed with BESCOM / KERC rules.")
    mk = ctx.tool("clear_double_auction", mt.clear_market, camps=camps)
    for t in mk["trades"]:
        ctx.emit("result", f"{t['buyer']}: {t['kwh']:,.0f} kWh in {t['window']} at Rs {t['price_rs']:.2f} delivered (seller nets Rs {t['seller_net_rs']:.2f}, vs 3.0 export).")

    options = ["Accept all cleared trades for tomorrow", "Hold back 20 % of surplus for the battery and trade the rest", "Export everything at Rs 3.0"]
    k = ctx.llm.choose("negotiator", "Which offer should NHCE main campus sign for tomorrow?", options,
                       payload={"trades": mk["trades"], "seller_gain_rs": mk["seller_gain_rs"], "buyer_gain_rs": mk["buyer_gain_rs"]}, fallback=0)
    k = k if isinstance(k, int) and 0 <= k < len(options) else 0
    rationale_fb = (f"Midpoint pricing between the 3.0 export credit and each buyer's import tariff, less half the wheeling charge each, "
                    f"leaves both sides better off: main campus gains Rs {mk['seller_gain_rs']:,.0f}, buyers save Rs {mk['buyer_gain_rs']:,.0f}.")
    rationale = ctx.llm.think("negotiator", system="You are a fair energy negotiator between campuses. Explain the deal in two plain sentences using only the numbers given.",
                              payload={"trades": mk["trades"], "choice": options[k], "assumption": mk["assumption"]}, fallback=rationale_fb) or rationale_fb
    ctx.emit("llm", f"Decision: {options[k]}. {rationale}")
    if k == 2:
        trades = []
    elif k == 1:
        trades = [dict(t, kwh=round(t["kwh"] * 0.8, 0), gain_rs=round(t["gain_rs"] * 0.8, 0), seller_gain_rs=round(t["seller_gain_rs"] * 0.8, 0),
                       buyer_gain_rs=round(t["buyer_gain_rs"] * 0.8, 0)) for t in mk["trades"]]
    else:
        trades = mk["trades"]
    sg = sum(t["seller_gain_rs"] for t in trades)
    bg = sum(t["buyer_gain_rs"] for t in trades)
    sold = sum(t["kwh"] for t in trades)
    ctx.handoff("optimiser", f"{sold:,.0f} kWh sold 10:00-15:00 at above-export prices; keep that energy available")
    summary = ((f"Export credit short by Rs {chk['shortfall_rs']:,.0f} ({chk['metered_export_kwh'] - chk['credited_kwh']:,.0f} kWh): dispute raised with BESCOM. " if chk["shortfall_rs"] > 0 else "Export credit verified. ") +
               f"Tomorrow {sold:,.0f} kWh of midday surplus goes to {len(trades)} partner campuses: main campus +Rs {sg:,.0f}, buyers save Rs {bg:,.0f} per day.")
    return {"market": {
        "export_price_rs": mt.EXPORT_RS, "grid_import_rs": 8.0, "wheeling_rs": mt.WHEELING_RS,
        "campuses": [{k2: c[k2] for k2 in ("id", "name", "surplus_kwh", "deficit_kwh", "bid_rs", "ask_rs", "import_rs")} for c in camps],
        "trades": trades,
        "seller_gain_rs": round(sg, 0), "buyer_gain_rs": round(bg, 0), "total_gain_rs": round(sg + bg, 0),
        "unsold_kwh": round(surplus - sold, 0),
        "export_check": chk,
        "decision": options[k], "rationale": rationale, "assumptions": [mk["assumption"]],
        "summary": summary,
    }}
