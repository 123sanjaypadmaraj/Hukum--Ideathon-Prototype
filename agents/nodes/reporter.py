"""Reporter: turns whatever agent outputs exist into a short briefing. Owner: core.

Returns {"report": {"headline", "sections":[{"agent","title","bullets"}], "kpis":{}}}.
Defensive: every agent key may be missing or partial.
"""
from __future__ import annotations


def _d(x) -> dict:
    return x if isinstance(x, dict) else {}


def _l(x) -> list:
    return x if isinstance(x, list) else []


def _num(x, nd=1):
    try:
        return round(float(x), nd)
    except (TypeError, ValueError):
        return None


def _rs(x) -> str:
    v = _num(x, 0)
    return "n/a" if v is None else f"Rs {int(v):,}"


def _n(x) -> str:
    v = _num(x, 1)
    if v is None:
        return "?"
    return f"{int(v):,}" if v == int(v) else f"{v:,}"


def _add(bullets, cond, text):
    if cond:
        bullets.append(text)


def build_report(state) -> dict:
    sections, kpis = [], {}

    b = _d(state.get("building"))
    if b:
        roof, bld = _d(b.get("roof")), _d(b.get("building"))
        bl = []
        _add(bl, bld.get("name"), f"Building: {bld.get('name')} ({bld.get('floors', '?')} floors, "
                                  f"{_n(bld.get('footprint_m2'))} m2 footprint).")
        _add(bl, roof.get("usable_m2") is not None, f"Usable roof {_n(roof.get('usable_m2'))} m2 of "
                                                    f"{_n(roof.get('area_m2'))} m2; up to {_n(roof.get('max_kwp'))} kWp.")
        _add(bl, b.get("rooms"), f"{len(_l(b.get('rooms')))} rooms, {len(_l(b.get('circuits')))} circuits, "
                                 f"{len(_l(b.get('equipment')))} equipment items mapped.")
        _add(bl, b.get("confidence") is not None, f"Model confidence {_num(b.get('confidence'), 2)}; "
                                                  f"{len(_l(b.get('open_questions')))} open question(s).")
        _add(bl, b.get("summary"), str(b.get("summary")))
        if roof.get("max_kwp") is not None:
            kpis["roof_max_kwp"] = roof.get("max_kwp")
        sections.append({"agent": "mapping", "title": "Building model", "bullets": bl or ["Building model created."]})

    sp = _d(state.get("solar_plan"))
    if sp:
        bl = []
        _add(bl, sp.get("kwp") is not None, f"{_n(sp.get('kwp'))} kWp, {sp.get('panels', '?')} panels at "
                                            f"{_n(sp.get('tilt_deg'))} deg tilt, azimuth {_n(sp.get('azimuth_deg'))} deg.")
        _add(bl, sp.get("yield_kwh_year") is not None, f"Yield {_n(sp.get('yield_kwh_year'))} kWh/year "
                                                       f"({_n(sp.get('specific_yield'))} kWh/kWp).")
        _add(bl, sp.get("capex_rs") is not None, f"Capex {_rs(sp.get('capex_rs'))}, savings "
                                                 f"{_rs(sp.get('savings_rs_year'))}/year, payback {_n(sp.get('payback_years'))} years.")
        _add(bl, sp.get("battery_kwh"), f"Battery {_n(sp.get('battery_kwh'))} kWh; self-consumption "
                                        f"{_n(sp.get('self_consumption_pct'))}%.")
        _add(bl, sp.get("summary"), str(sp.get("summary")))
        for k, kk in (("kwp", "solar_kwp"), ("payback_years", "solar_payback_years"),
                      ("yield_kwh_year", "solar_yield_kwh_year"), ("capex_rs", "solar_capex_rs")):
            if sp.get(k) is not None:
                kpis[kk] = sp.get(k)
        sections.append({"agent": "solar_planner", "title": "Rooftop solar plan", "bullets": bl or ["Solar plan drafted."]})

    ev = _d(state.get("env_review"))
    if ev:
        its = state.get("plan_iterations") or ev.get("iteration")
        bl = [f"Plan reviewed over {its or '?'} iteration(s); final verdict: "
              f"{'approved' if ev.get('approved') else 'not approved'}."]
        issues = _l(ev.get("issues"))
        _add(bl, issues, f"{len(issues)} issue(s) on the final draft: "
                         + "; ".join(str(_d(i).get("text", i)) for i in issues[:3]))
        _add(bl, ev.get("co2_avoided_t_year") is not None, f"CO2 avoided {_n(ev.get('co2_avoided_t_year'))} t/year; "
                                                           f"carbon payback {_n(ev.get('carbon_payback_years'))} years.")
        _add(bl, ev.get("water_l_year") is not None, f"Panel cleaning water {_n(ev.get('water_l_year'))} L/year.")
        kpis["plan_iterations"] = its
        kpis["env_approved"] = bool(ev.get("approved"))
        if ev.get("co2_avoided_t_year") is not None:
            kpis["co2_avoided_t_year"] = ev.get("co2_avoided_t_year")
        sections.append({"agent": "environment", "title": "Environmental review", "bullets": bl})

    sh = _d(state.get("solar_health"))
    if sh:
        strings = _l(sh.get("strings"))
        bad = [s for s in strings if _d(s).get("status") in ("degraded", "fault")]
        bl = []
        _add(bl, sh.get("pr") is not None, f"Performance ratio {sh.get('pr')} ({_n(sh.get('actual_kwh'))} of "
                                           f"{_n(sh.get('expected_kwh'))} kWh expected).")
        _add(bl, strings, f"{len(bad)} of {len(strings)} strings degraded or faulted.")
        _add(bl, sh.get("soiling_loss_pct") is not None, f"Soiling loss {_n(sh.get('soiling_loss_pct'))}%; cleaning "
                                                         f"{'due' if sh.get('cleaning_due') else 'not due'}.")
        _add(bl, sh.get("summary"), str(sh.get("summary")))
        if sh.get("pr") is not None:
            kpis["solar_pr"] = sh.get("pr")
        sections.append({"agent": "solar_health", "title": "Solar health", "bullets": bl or ["Solar health checked."]})

    fa = _d(state.get("faults"))
    if fa:
        wos = _l(fa.get("work_orders"))
        p1 = [w for w in wos if _d(w).get("priority") == "P1"]
        bl = [f"{len(wos)} work order(s), {len(p1)} priority P1."]
        for w in wos[:3]:
            w = _d(w)
            bl.append(f"{w.get('id', '?')} {w.get('priority', '')}: {w.get('issue', '')} - {w.get('action', '')}".strip())
        _add(bl, fa.get("predictive"), f"{len(_l(fa.get('predictive')))} asset(s) flagged by predictive maintenance.")
        _add(bl, fa.get("summary"), str(fa.get("summary")))
        kpis["work_orders"] = len(wos)
        sections.append({"agent": "fault_maintenance", "title": "Faults and maintenance", "bullets": bl})

    ba = _d(state.get("bill_audit"))
    if ba:
        finds = _l(ba.get("findings"))
        bl = [f"{len(_l(ba.get('bills')))} bill(s) audited, {len(finds)} finding(s)."]
        for f in finds[:3]:
            f = _d(f)
            bl.append(f"{f.get('month', '')} {f.get('code', '')}: {f.get('text', '')} ({_rs(f.get('impact_rs'))})".strip())
        _add(bl, ba.get("recoverable_rs") is not None, f"Overcharge {_rs(ba.get('overcharge_rs'))}; "
                                                       f"recoverable {_rs(ba.get('recoverable_rs'))}.")
        _add(bl, ba.get("summary"), str(ba.get("summary")))
        if ba.get("recoverable_rs") is not None:
            kpis["bill_recoverable_rs"] = ba.get("recoverable_rs")
        sections.append({"agent": "bill_auditor", "title": "Bill audit", "bullets": bl})

    mk = _d(state.get("market"))
    if mk:
        trades = _l(mk.get("trades"))
        gain = 0.0
        for t in trades:
            gain += _num(_d(t).get("gain_rs"), 2) or 0.0
        ec = _d(mk.get("export_check"))
        bl = [f"{len(trades)} trade(s) with partner campuses, total gain {_rs(gain)}."]
        _add(bl, ec, f"Export credit: {_n(ec.get('credited_kwh'))} of {_n(ec.get('metered_export_kwh'))} kWh credited; "
                     f"shortfall {_rs(ec.get('shortfall_rs'))} ({ec.get('verdict', 'n/a')}).")
        _add(bl, mk.get("summary"), str(mk.get("summary")))
        kpis["market_gain_rs"] = round(gain)
        if ec.get("shortfall_rs") is not None:
            kpis["export_shortfall_rs"] = ec.get("shortfall_rs")
        sections.append({"agent": "negotiator", "title": "Export credit and campus trades", "bullets": bl})

    op = _d(state.get("optimiser"))
    if op:
        base, opt = _d(op.get("baseline")), _d(op.get("optimised"))
        bl = []
        _add(bl, op.get("saving_pct") is not None, f"Tomorrow's cost {_rs(base.get('cost_rs'))} -> "
                                                   f"{_rs(opt.get('cost_rs'))} ({_n(op.get('saving_pct'))}% saving).")
        _add(bl, base.get("peak_kw") is not None, f"Peak demand {_n(base.get('peak_kw'))} kW -> {_n(opt.get('peak_kw'))} kW.")
        _add(bl, op.get("summary"), str(op.get("summary")))
        if op.get("saving_pct") is not None:
            kpis["optimiser_saving_pct"] = op.get("saving_pct")
        sections.append({"agent": "optimiser", "title": "24 h optimisation", "bullets": bl or ["Schedule optimised."]})

    co = _d(state.get("control"))
    if co:
        acts = _l(co.get("actions"))
        by: dict = {}
        for a in acts:
            s = _d(a).get("status", "planned")
            by[s] = by.get(s, 0) + 1
        bl = [f"{len(acts)} action(s) in {co.get('pilot_mode', '?')} mode: "
              + (", ".join(f"{v} {k}" for k, v in by.items()) or "none") + "."]
        _add(bl, co.get("safety"), f"{len(_l(co.get('safety')))} safety rule(s) checked.")
        _add(bl, co.get("summary"), str(co.get("summary")))
        kpis["control_actions"] = len(acts)
        sections.append({"agent": "control", "title": "Control actions", "bullets": bl})

    return {"sections": sections, "kpis": kpis}


def fallback_headline(kpis: dict, n: int) -> str:
    parts = []
    if "solar_kwp" in kpis:
        p = f"{_n(kpis['solar_kwp'])} kWp rooftop plan"
        if kpis.get("solar_payback_years") is not None:
            p += f" with {_n(kpis['solar_payback_years'])}-year payback"
        parts.append(p)
    if "optimiser_saving_pct" in kpis:
        parts.append(f"{_n(kpis['optimiser_saving_pct'])}% cost saving tomorrow")
    if "bill_recoverable_rs" in kpis:
        parts.append(f"{_rs(kpis['bill_recoverable_rs'])} recoverable on bills")
    if "work_orders" in kpis:
        parts.append(f"{kpis['work_orders']} work orders")
    if not parts:
        return f"HUKUM team finished: {n} agent report(s) ready."
    return "HUKUM briefing: " + ", ".join(parts) + "."


def run(state, ctx) -> dict:
    ctx.emit("thought", "Collecting every agent's output into one briefing.")
    rep = build_report(state)
    fb = fallback_headline(rep["kpis"], len(rep["sections"]))
    headline = ctx.llm.think(
        "reporter",
        system="You write the one-sentence headline of a campus-energy briefing for the principal of NHCE Bengaluru.",
        payload={"kpis": rep["kpis"], "sections": [s["title"] for s in rep["sections"]]},
        fallback=fb,
    )
    ctx.emit("result", headline, {"kpis": rep["kpis"]})
    return {"report": {"headline": headline, "sections": rep["sections"], "kpis": rep["kpis"]}}
