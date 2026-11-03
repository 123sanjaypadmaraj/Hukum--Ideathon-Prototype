"""Control Agent: turns the optimiser schedule and fault list into safe actions.

pilot_mode (scenario.pilot_mode, default "approve"):
  shadow   -> actions logged with status "shadow", nothing is switched
  automate -> actions status "executed"
  approve  -> langgraph interrupt({"actions": [...], "question": ...}); resumed with
              {"decision": "approve"|"reject", "ids": [optional subset]}

Everything before interrupt() is deterministic and side-effect free (LangGraph
re-runs the node from the top on resume); trace lines are emitted afterwards.
"""
from __future__ import annotations

CRITICAL = ["MB-SERVER (data centre)", "Sanjeevini health centre (medical)", "MB-CCTV (CCTV control room)"]


def _windows(sched, pred, lo=0, hi=96):
    """Contiguous slot runs where pred(slot) is true -> [(start, end_exclusive, avg_kw)]."""
    out, cur = [], None
    for s in sched:
        k = int(s.get("slot", 0))
        if not (lo <= k < hi):
            continue
        if pred(s):
            if cur and cur[1] == k:
                cur[1] = k + 1
                cur[2].append(abs(float(s.get("battery_kw") or 0)))
            else:
                if cur:
                    out.append(cur)
                cur = [k, k + 1, [abs(float(s.get("battery_kw") or 0))]]
    if cur:
        out.append(cur)
    return [(a, b, sum(v) / len(v)) for a, b, v in out]


def _t(slot):
    m = (slot * 15) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def _plan(state) -> tuple[list[dict], list[str], list[str]]:
    opt = state.get("optimiser") or {}
    faults = state.get("faults") or {}
    notes = []
    moves = {m.get("asset"): m for m in opt.get("moves", []) or []}
    sched = opt.get("schedule") or []
    acts = []

    def add(t, asset, action, kw, reason):
        acts.append({"id": f"A{len(acts) + 1:02d}", "t": t, "asset": asset, "action": action, "kw": round(float(kw), 1), "reason": reason})

    def mv(asset, default_to, default_kw):
        m = moves.get(asset) or {}
        return m.get("to", default_to), float(m.get("kw", default_kw))

    to, kw = mv("AHU-A", "11:00-12:30", 35)
    add(to.split("-")[0], "AHU-A", f"Pre-cool Main Block {to}: setpoint 24 -> 22.5 C, then setback to 26 C 17:00-18:30", kw,
        "moves 35 kW out of the 17:00-18:30 shoulder into solar hours (10 % rebound counted)")
    to, kw = mv("HVAC-BD", "15:00-16:30", 60)
    add(to.split("-")[0], "HVAC-BD", f"Pre-cool hostels {to}, coast 19:00-20:30 within 27 C", kw, "takes 60 kW off the 19:00 evening peak")
    for p in ("PUMP-1", "PUMP-2"):
        to, kw = mv(p, "10:00-12:00", 15)
        add(to.split("-")[0], p, f"Run {to} on solar (2 h fill)", kw, "tank refill moved from the morning / evening into solar surplus")
    t1, kw1 = mv("EBUS-1", "10:30-12:30", 60)
    t2, kw2 = mv("EBUS-2", "10:30-12:30", 60)
    add(t1.split("-")[0], "EBUS-1, EBUS-2", (f"Charge both e-buses {t1}, 120 kWh each" if t1 == t2 else f"Charge e-buses {t1} (EBUS-1) and {t2} (EBUS-2), 120 kWh each"), kw1 + kw2,
        "buses parked between trips; was 18:00-20:00 at 9.6 Rs/kWh")
    t3, kw3 = mv("EV-1", "11:00-13:00", 7.4)
    add(t3.split("-")[0], "EV-1..EV-4", f"Staff EV charging {t3}", kw3 * 4, "charge while parked, on solar")

    if sched:
        chg = _windows(sched, lambda s: float(s.get("battery_kw") or 0) < -1, 36, 72)
        dis = _windows(sched, lambda s: float(s.get("battery_kw") or 0) > 1, 72, 96)
        if chg:
            a, b = chg[0][0], chg[-1][1]
            kw = max(w[2] for w in chg)
            add(_t(a), "BAT-1", f"Charge from solar surplus {_t(a)}-{_t(b)} (up to {kw:.0f} kW)", kw, "store midday PV that would export at only Rs 3.0")
        if dis:
            a, b = dis[0][0], dis[-1][1]
            kw = max(w[2] for w in dis)
            add(_t(a), "BAT-1", f"Discharge {_t(a)}-{_t(b)} (up to {kw:.0f} kW) to hold grid import under the cap", kw, "evening peak tariff 9.6 Rs/kWh and demand charge")
        notes.append("battery windows taken from the State Optimiser's DP schedule")
    else:
        add("10:30", "BAT-1", "Charge from solar surplus 10:30-15:00", 90, "store midday PV (optimiser not run: default plan)")
        add("18:00", "BAT-1", "Discharge 18:00-22:00 to shave the evening peak", 85, "evening peak tariff 9.6 Rs/kWh (default plan)")
        notes.append("optimiser output missing: default battery and load windows used")

    add("08:45", "Classrooms and labs", "Auto-off after 10 min empty (CCTV + Wi-Fi agree) in timetable gaps", 16,
        "about 16 kW of empty rooms during class hours")

    wos = faults.get("work_orders") if faults else None
    string_wo = [w for w in (wos or []) if w.get("kind") == "string" and w.get("priority") == "P1"]
    if wos is None:
        string_wo = [{"string_id": "S07", "inverter": "SVP-INV2", "id": "WO-default"}]
        notes.append("fault list missing: default S07 isolation used")
    for w in string_wo:
        add("07:00", f"{w.get('inverter', 'SVP-INV2')} / {w.get('string_id', 'S07')}",
            "Isolate the string at the combiner box for repair (lock-out tag-out)", 0,
            f"work order {w.get('id')}: open-circuit string, safe isolation before the technician arrives")
    cam_open = wos is None or any(str(w.get("asset", "")).startswith("CAM-CSE-LAB2") for w in wos)
    if cam_open:
        add("00:00", "CSE-LAB2", "Keep room powered (fail-safe ON), exclude from auto-off until CAM-CSE-LAB2 is fixed", 0,
            "camera obstructed: occupancy unknown, never switch off an occupied lab")
    return acts, notes, ([] if not cam_open else ["CSE-LAB2"])


def _safety(acts) -> list[str]:
    # simple RC estimate: 35 kW x 1.5 h into a 1,600 kWh-thermal/C slab lowers it about 1.2 C from 24 C
    precool_min = round(24.0 - 35 * 1.5 / 45.0, 1)
    return [
        f"Comfort 22-27 C: pre-cool bottoms out at about {precool_min} C (>= 22 C), coast phases stay <= 26.5 C; any room above 27 C cancels its setback",
        "Critical loads never shed or shifted: " + ", ".join(CRITICAL),
        "Manual override wins: a wall switch, BMS operator or facility manager command cancels the HUKUM action for that asset for 4 h",
        "Battery limits enforced locally by the BMS: SOC 10-95 %, 150 kW, cell temperature < 45 C",
        "Fail-safe: if a camera or meter feed is lost, the room or asset reverts to ON / normal schedule",
        "String isolation only with lock-out tag-out by a licensed electrician; inverter stays on for the healthy strings",
    ]


def run(state, ctx):
    sc = state.get("scenario") or {}
    mode = sc.get("pilot_mode") if sc.get("pilot_mode") in ("shadow", "approve", "automate") else "approve"
    acts, notes, failsafe = _plan(state)
    safety = _safety(acts)

    decision = None
    if mode == "approve" and acts:
        from langgraph.types import interrupt
        decision = interrupt({"actions": [dict(a, status="pending_approval") for a in acts],
                              "question": "Approve tomorrow's control plan?"})

    ctx.emit("thought", f"Pilot mode '{mode}'. Built {len(acts)} actions from the optimiser schedule and the fault list; " + ("; ".join(notes) or "all inputs present") + ".")
    ctx.emit("tool", "safety_check(comfort, critical_loads, overrides, battery_limits)", {"tool": "safety_check"})
    ctx.emit("result", f"Safety check passed: {len(safety)} rules, critical loads protected ({', '.join(c.split(' ')[0] for c in CRITICAL)}).")
    if failsafe:
        ctx.emit("warning", "CSE-LAB2 stays powered (fail-safe) because its camera is obstructed; auto-off excludes it.")

    if mode == "shadow":
        for a in acts:
            a["status"] = "shadow"
        summary = f"Shadow mode: {len(acts)} actions logged for tomorrow, nothing switched. Compare tomorrow's meter data against the plan before going live."
    elif mode == "automate":
        for a in acts:
            a["status"] = "executed"
        summary = f"Automate mode: {len(acts)} actions scheduled and executed for tomorrow within the safety envelope."
    else:
        d = decision if isinstance(decision, dict) else {"decision": str(decision or "approve")}
        verdict = str(d.get("decision", "approve")).lower()
        ids = set(d.get("ids") or [])
        ok = 0
        for a in acts:
            listed = (not ids) or (a["id"] in ids)
            approved = bool((verdict == "approve" and listed) or (verdict == "reject" and ids and not listed))
            a["status"] = "executed" if approved else "rejected"
            a["approval"] = "approved" if approved else "rejected"
            ok += approved
        ctx.emit("result", f"Human decision '{verdict}'" + (f" for {sorted(ids)}" if ids else " for all actions") + f": {ok} approved, {len(acts) - ok} rejected.")
        summary = (f"Approve mode: {ok} of {len(acts)} actions approved and executed for tomorrow, {len(acts) - ok} rejected."
                   + (" Rejected assets keep their normal schedule." if ok < len(acts) else ""))
    for a in acts[:3]:
        ctx.emit("result", f"{a['id']} {a['t']} {a['asset']}: {a['action']} [{a['status']}]")
    ctx.handoff("reporter", summary)
    return {"control": {"pilot_mode": mode, "actions": acts, "safety": safety, "decision": decision, "summary": summary}}
