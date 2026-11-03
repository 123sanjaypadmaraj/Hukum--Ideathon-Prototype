"""Operations tools: fault triage, predictive maintenance and the BESCOM HT bill audit.

Standard library only, deterministic (seeded). Used by nodes/fault_maintenance.py
and nodes/bill_auditor.py.
"""
from __future__ import annotations

import random
import re

TARIFF_AVG_RS = 7.4          # blended energy rate used to value kWh at risk
SOLAR_RS = 6.4
EXPORT_RS = 3.0
DEMAND_RS_KVA = 400.0
CONTRACT_KVA = 500.0
SOLAR_YIELD_KWH_PER_KW_DAY = 4.6   # Bengaluru, used to value lost PV output

# ---------------------------------------------------------------- faults

DEFAULT_SOLAR_HEALTH = {
    "pr": 0.74,
    "soiling_loss_pct": 6.2,
    "cleaning_due": True,
    "strings": [
        {"id": "S07", "inverter": "SVP-INV2", "kw": 0.4, "expected_kw": 9.6, "ratio": 0.04, "status": "fault",
         "diagnosis": "open circuit: string current near zero while neighbours produce (blown fuse or MC4 connector)"},
        {"id": "S12", "inverter": "SVP-INV3", "kw": 7.9, "expected_kw": 9.6, "ratio": 0.82, "status": "degraded",
         "diagnosis": "18 % low, steady through the day: likely cell degradation or a bypass diode failure"},
    ],
    "inverters": [
        {"id": "SVP-INV1", "status": "ok", "efficiency": 0.975, "temp_c": 48, "alarms": []},
        {"id": "SVP-INV2", "status": "warning", "efficiency": 0.962, "temp_c": 51, "alarms": ["string S07 low current"]},
        {"id": "SVP-INV4", "status": "warning", "efficiency": 0.948, "temp_c": 71, "alarms": ["heat-sink over temperature, derating"]},
    ],
}


def solar_work_orders(solar_health: dict | None) -> tuple[list[dict], str]:
    """Work orders from solar_health (or defaults mirroring the planted faults)."""
    sh = solar_health if isinstance(solar_health, dict) and (solar_health.get("strings") or solar_health.get("inverters")) else None
    src = "solar_health agent" if sh else "default fleet snapshot (solar_health not run)"
    sh = sh or DEFAULT_SOLAR_HEALTH
    out = []
    soiled: dict[str, list[dict]] = {}
    for st in sh.get("strings", []) or []:
        status = st.get("status", "ok")
        if status == "ok":
            continue
        if "soil" in str(st.get("diagnosis", "")).lower() and status != "fault":
            blk = str(st.get("id", "?")).split("-")[0] if "-" in str(st.get("id", "")) else str(st.get("inverter", "PV")).split("-")[0]
            soiled.setdefault(blk, []).append(st)
            continue
        exp = float(st.get("expected_kw") or 9.6)
        got = float(st.get("kw") or 0.0)
        lost_kw = max(0.0, exp - got)
        kwh30 = round(lost_kw * SOLAR_YIELD_KWH_PER_KW_DAY / 0.8 * 30 * 0.75, 0)  # ~5 peak-equivalent h/day
        fault = status == "fault"
        out.append({
            "asset": f"{st.get('inverter', 'INV')} / string {st.get('id', '?')}",
            "priority": "P1" if fault else "P2",
            "issue": ("String fault: " if fault else "Degraded string: ") + str(st.get("diagnosis") or status),
            "evidence": f"string at {got:.1f} kW vs {exp:.1f} kW expected (ratio {float(st.get('ratio') or (got / exp if exp else 0)):.2f}); source: {src}",
            "action": ("Isolate the string at the combiner box, check the fuse and MC4 connectors, IV-curve test, re-energise"
                       if fault else "IV-curve trace and thermal-camera scan of the string; replace failed bypass diode or module"),
            "due_days": 1 if fault else 7,
            "est_cost_rs": 2500 if fault else 6000,
            "energy_at_risk_kwh": kwh30,
            "kind": "string", "string_id": st.get("id"), "inverter": st.get("inverter"),
        })
    days = sh.get("days_since_cleaning") or {}
    for blk, sts in soiled.items():
        lost_kw = sum(max(0.0, float(x.get("expected_kw") or 0) - float(x.get("kw") or 0)) for x in sts)
        ratio = sum(float(x.get("ratio") or 0) for x in sts) / len(sts)
        d = days.get(blk)
        out.append({
            "asset": f"{blk} PV array ({len(sts)} strings)",
            "priority": "P2",
            "issue": f"Soiling: uniform {100 * (1 - ratio):.0f} % loss on all {len(sts)} {blk} strings" + (f", {d} days since last cleaning" if d else ""),
            "evidence": f"string ratios {min(float(x.get('ratio') or 0) for x in sts):.2f}-{max(float(x.get('ratio') or 0) for x in sts):.2f} with normal voltage; {lost_kw:.1f} kW lost at midday; source: {src}",
            "action": f"Clean the {blk} array before 09:00 (dry brush / low-water robot), then move it to a 21-day cleaning cycle",
            "due_days": 2,
            "est_cost_rs": 4500,
            "energy_at_risk_kwh": round(lost_kw * SOLAR_YIELD_KWH_PER_KW_DAY / 0.8 * 30 * 0.75, 0),
            "kind": "soiling",
        })
    for inv in sh.get("inverters", []) or []:
        temp = float(inv.get("temp_c") or 0)
        eff = float(inv.get("efficiency") or 0.97)
        alarms = inv.get("alarms") or []
        hot = temp >= 65
        if not hot and eff >= 0.955 and inv.get("status") in (None, "ok"):
            continue
        if not hot and all(("string" in a.lower() or "soil" in a.lower()) for a in alarms) and eff >= 0.955:
            continue  # alarm already covered by a string / soiling work order
        out.append({
            "asset": inv.get("id", "INV"),
            "priority": "P2",
            "issue": "Inverter running hot and derating" if hot else "Inverter efficiency below spec",
            "evidence": f"heat-sink {temp:.0f} C, efficiency {eff * 100:.1f} %, alarms: {', '.join(alarms) or 'none'}; source: {src}",
            "action": "Clean the inverter air filters and fan, check the enclosure ventilation, re-torque DC terminals",
            "due_days": 3,
            "est_cost_rs": 1800,
            "energy_at_risk_kwh": round((0.975 - eff) * 225 * SOLAR_YIELD_KWH_PER_KW_DAY * 30 + (40 if hot else 0) * 3, 0),
            "kind": "inverter",
        })
    soil = float(sh.get("soiling_loss_pct") or 0)
    if not soiled and (sh.get("cleaning_due") or soil >= 4):
        kwh30 = round(900 * SOLAR_YIELD_KWH_PER_KW_DAY * 30 * soil / 100, 0)
        out.append({
            "asset": "PV array (all roofs)",
            "priority": "P3" if soil < 6 else "P2",
            "issue": f"Soiling loss {soil:.1f} %",
            "evidence": f"performance ratio {float(sh.get('pr') or 0):.2f}, clean-reference cell gap {soil:.1f} %; source: {src}",
            "action": "Dry-brush / low-water cleaning before 09:00 (water-saving robot on Main Block)",
            "due_days": 5,
            "est_cost_rs": 9000,
            "energy_at_risk_kwh": kwh30,
            "kind": "soiling",
        })
    return out, src


def measured_overrides(building: dict | None) -> dict:
    """{equipment id: measured kW} from building.equipment, or parsed from an open
    question like 'Nameplate says 15 kW, the meter sees 8.25 kW' (HUKUM Scan
    planted this on PUMP-1)."""
    out = {}
    b = building if isinstance(building, dict) else {}
    for e in b.get("equipment") or []:
        try:
            m = float(e.get("measured_kw"))
            if m > 0:
                out[str(e.get("id"))] = m
        except (TypeError, ValueError):
            pass
    for q in b.get("open_questions") or []:
        q = str(q)
        nums = re.findall(r"(\d+(?:\.\d+)?)\s*kW", q)
        if len(nums) >= 2 and ("meter" in q.lower() or "nilm" in q.lower() or "measured" in q.lower()):
            ids = re.findall(r"\b((?:PUMP|AHU|EV|EBUS|HVAC)-[A-Z0-9]+)\b", q)
            target = ids[0] if ids else "PUMP-1"
            out.setdefault(target, float(nums[1]))
    return out


def equipment_work_orders(building: dict | None) -> tuple[list[dict], str]:
    eq = (building or {}).get("equipment") if isinstance(building, dict) else None
    src = "mapping agent (HUKUM Scan NILM)" if eq else "HUKUM Scan defaults"
    eq = [dict(e) for e in eq] if eq else [{"id": "PUMP-1", "kind": "pump", "rated_kw": 15.0, "measured_kw": 8.25, "room": "MB-PUMP"}]
    over = measured_overrides(building)
    for e in eq:
        if e.get("measured_kw") in (None, 0) and str(e.get("id")) in over:
            e["measured_kw"] = over[str(e.get("id"))]
    out = []
    for e in eq:
        rated, meas = e.get("rated_kw"), e.get("measured_kw")
        try:
            rated, meas = float(rated), float(meas)
        except (TypeError, ValueError):
            continue
        if rated <= 0 or meas <= 0 or e.get("kind") in ("solar", "battery"):
            continue
        ratio = meas / rated
        if ratio < 0.7 and e.get("kind") in ("pump", "hvac", "motor", "fan", None):
            run_h = 2 * 365 / 12  # 2 h/day
            extra_h = run_h * (1 / ratio - 1)  # longer runtime to move the same water
            out.append({
                "asset": e.get("id", "?"),
                "priority": "P2",
                "issue": f"Draws {meas:g} kW against a {rated:g} kW nameplate ({ratio * 100:.0f} %): throttled valve, worn impeller or wrong nameplate",
                "evidence": f"NILM step of {meas:g} kW matched to {e.get('id')} in {e.get('room', '?')}; nameplate OCR {rated:g} kW; source: {src}",
                "action": "Inspect discharge valve position and impeller, log flow and head; correct the nameplate in the model if the pump was replaced",
                "due_days": 7,
                "est_cost_rs": 3500,
                "energy_at_risk_kwh": round(meas * extra_h * 0.5, 0),
                "kind": "equipment",
            })
    return out, src


def camera_work_orders(building: dict | None) -> list[dict]:
    qs = (building or {}).get("open_questions") if isinstance(building, dict) else None
    texts = [q if isinstance(q, str) else str(q) for q in (qs or [])]
    cam = [q for q in texts if "cam" in q.lower() or "obstruct" in q.lower() or "blocked" in q.lower() or "CSE-LAB2" in q]
    evidence = ("Scan asks: '" + cam[0] + "' - CAM-CSE-LAB2 counts 0 people while Wi-Fi shows 30+ devices during the 10:00-13:00 booking") if cam else "CAM-CSE-LAB2 counts 0 people while Wi-Fi shows 30+ devices in CSE-LAB2 during the 10:00-13:00 booking (HUKUM Scan default)"
    out = [{
        "asset": "CAM-CSE-LAB2",
        "priority": "P2",
        "issue": "Camera obstructed (projector screen): occupancy for CSE-LAB2 is blind",
        "evidence": evidence,
        "action": "Re-aim or relocate the camera below the screen line; until fixed, CSE-LAB2 stays fail-safe ON (no auto-off)",
        "due_days": 2,
        "est_cost_rs": 800,
        "energy_at_risk_kwh": round(6.0 * 3 * 22, 0),  # ~6 kW of auto-off savings lost on ~3 h/day
        "kind": "camera",
    }]
    circ = [q for q in texts if "DB-MB-1" in q or "circuit" in q.lower()]
    if circ or not texts:
        out.append({
            "asset": "DB-MB-1/C6",
            "priority": "P3",
            "issue": "Circuit tag drawn in the wrong room on the DXF (drawing disagrees with the single-line diagram)",
            "evidence": ("Scan asks: '" + circ[0] + "' - DXF tag and single-line diagram disagree") if circ else "DXF tag DB-MB-1/C6 sits in a different room than the SLD feeds (HUKUM Scan default)",
            "action": "Electrician to trace C6 with a tone tracer and confirm; update the drawing and the room-circuit map before auto-off uses it",
            "due_days": 10,
            "est_cost_rs": 600,
            "energy_at_risk_kwh": 0.0,
            "kind": "drawing",
        })
    return out


def capacitor_work_order(bill_audit: dict | None) -> dict | None:
    finds = (bill_audit or {}).get("findings") if isinstance(bill_audit, dict) else None
    pf = [f for f in (finds or []) if str(f.get("code", "")).upper().startswith("PF")]
    if finds is not None and not pf:
        return None
    f = pf[0] if pf else {"month": "Apr", "impact_rs": 20750, "evidence": "average power factor 0.86 vs 0.90 limit"}
    return {
        "asset": "APFC capacitor bank (Main LT panel)",
        "priority": "P1",
        "issue": "Power-factor correction not holding: capacitor stages failed or contactor stuck",
        "evidence": f"{f.get('month', 'Apr')} bill: {f.get('evidence', '')}; penalty Rs {float(f.get('impact_rs') or 0):,.0f}" + ("" if pf else " (bill_auditor not run, default)"),
        "action": "Test each capacitor stage (kVAr and current), replace failed cells, check the APFC relay set-point (target PF 0.97)",
        "due_days": 3,
        "est_cost_rs": 22000,
        "energy_at_risk_kwh": 0.0,
        "rs_at_risk_month": float(f.get("impact_rs") or 20750),
        "kind": "capacitor",
    }


def predictive(seed: int = 21) -> list[dict]:
    rnd = random.Random(seed)
    vib = [round(2.1 + 0.045 * d + rnd.uniform(-0.05, 0.05), 2) for d in range(0, 60, 10)]
    oil = [round(61 + 0.12 * d + rnd.uniform(-0.4, 0.4), 1) for d in range(0, 60, 10)]
    return [
        {"asset": "AHU-A compressor", "risk": "high", "rul_days": 38,
         "signal": f"vibration RMS {vib[0]} -> {vib[-1]} mm/s over 50 days (ISO 10816 alarm 4.5 mm/s); bearing wear trend"},
        {"asset": "BAT-1 (400 kWh)", "risk": "low", "rul_days": 2900,
         "signal": "state of health 94 % after 610 cycles; cell spread 18 mV; on track for 80 % at ~8 years"},
        {"asset": "Main transformer 1000 kVA", "risk": "medium", "rul_days": 120,
         "signal": f"top-oil temperature {oil[0]} -> {oil[-1]} C at similar load; schedule oil DGA test and radiator cleaning"},
        {"asset": "PUMP-2", "risk": "low", "rul_days": 400, "signal": "motor current stable at 14.6 kW, no harmonics growth"},
    ]


# ---------------------------------------------------------------- bill audit

MONTHS = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]
# energy per month (MWh): semester, vacation (Dec, May-Jun), monsoon (Jul-Sep)
_UNITS_MWH = [124, 104, 121, 118, 127, 129, 96, 99, 113, 117, 115, 126]
_SOLAR_SHARE_DAY = 0.34   # share of consumption in 09-17 solar hours
_TOD_REBATE_RS = 1.6      # 8.0 - 6.4
ENERGY_RS = 8.0
FIXED_MISC_RS = 21500     # meter rent, tax-free fixed items


def synth_bills(seed: int = 5) -> dict:
    """12 monthly HT bills + matching meter (AMR) data, with five planted errors."""
    rnd = random.Random(seed)
    bills, meter = [], []
    for i, m in enumerate(MONTHS):
        units = round(_UNITS_MWH[i] * 1000 * (1 + rnd.uniform(-0.01, 0.01)))
        md = round(392 + 0.14 * (units / 1000 - 95) + rnd.uniform(-6, 12), 0)
        md = min(md, 418)
        pf = round(0.955 + rnd.uniform(-0.01, 0.012), 3)
        export = round(1450 + rnd.uniform(-180, 260)) if m not in ("Jul", "Aug") else round(700 + rnd.uniform(-100, 100))
        solar_hours = round(units * _SOLAR_SHARE_DAY)
        meter.append({"month": m, "units_kwh": units, "md_kva": md, "pf": pf, "export_kwh": export, "solar_hours_kwh": solar_hours, "reading": "actual"})
        billed_units, billed_md, billed_export, tod, reading, pf_pen = units, max(md, 0.85 * CONTRACT_KVA), export, solar_hours * _TOD_REBATE_RS, "actual", 0.0
        if m == "Apr":   # (a) PF penalty: capacitor bank failed
            meter[-1]["pf"] = pf = 0.86
        if m == "Feb":   # (b) export not credited
            meter[-1]["export_kwh"] = export = 1860
            billed_export = 0
        if m == "Aug":   # (c) estimated reading, about 6 % high
            billed_units = round(units * 1.062)
            reading = "estimated"
        if m == "Oct":   # (d) demand billed on full contract demand
            meter[-1]["md_kva"] = md = 410
            billed_md = CONTRACT_KVA
        if m == "Jan":   # (e) TOD rebate missing
            tod = 0.0
        if pf < 0.90:
            pf_pen = round(billed_units * ENERGY_RS * 0.01 * (0.90 - pf) * 100 / 2, 0)
        amount = billed_units * ENERGY_RS + billed_md * DEMAND_RS_KVA - tod - billed_export * EXPORT_RS + pf_pen + FIXED_MISC_RS
        bills.append({"month": m, "units_kwh": billed_units, "amount_rs": round(amount, 0), "demand_kva": billed_md,
                      "recorded_md_kva": md, "pf": pf, "pf_penalty_rs": pf_pen, "export_credit_kwh": billed_export,
                      "tod_rebate_rs": round(tod, 0), "reading": reading})
    return {"bills": bills, "meter": meter, "contract_kva": CONTRACT_KVA}


def audit_bills(data: dict) -> dict:
    bills, meter = data["bills"], data["meter"]
    cd = data.get("contract_kva", CONTRACT_KVA)
    findings = []
    checked = {"months": len(bills), "rules": ["energy units vs AMR", "billing demand = max(MD, 85 % CD)", "PF >= 0.90",
                                                "net-metering export credit", "TOD solar-hours rebate", "actual vs estimated reading"]}
    for b, mt in zip(bills, meter):
        m = b["month"]
        if b["pf_penalty_rs"] > 0:
            findings.append({"code": "PF_PENALTY", "month": m,
                             "text": f"Power-factor penalty of Rs {b['pf_penalty_rs']:,.0f}: average PF {b['pf']:.2f} is below the 0.90 limit",
                             "impact_rs": b["pf_penalty_rs"],
                             "evidence": f"meter PF {mt['pf']:.2f} (other months 0.95-0.97); kVArh rose while kWh was flat, pointing at the APFC capacitor bank",
                             "action": "Not a billing error: fix the capacitor bank (work order to Fault & Maintenance) to stop repeat penalties",
                             "recoverable": False, "handoff": "fault_maintenance"})
        if mt["export_kwh"] > 0 and b["export_credit_kwh"] == 0:
            rs = mt["export_kwh"] * EXPORT_RS
            findings.append({"code": "EXPORT_NOT_CREDITED", "month": m,
                             "text": f"Solar export of {mt['export_kwh']:,} kWh not credited under net metering",
                             "impact_rs": rs,
                             "evidence": f"bidirectional meter export register {mt['export_kwh']:,} kWh; bill shows 0 kWh export credit",
                             "action": "Claim Rs {:,.0f} credit with BESCOM net-metering cell; Negotiator to verify export credits every month".format(rs),
                             "recoverable": True, "handoff": "negotiator"})
        if b["reading"] == "estimated" or b["units_kwh"] > mt["units_kwh"] * 1.02:
            over = b["units_kwh"] - mt["units_kwh"]
            rs = over * ENERGY_RS
            findings.append({"code": "ESTIMATED_READING", "month": m,
                             "text": f"Estimated (not actual) reading: billed {b['units_kwh']:,} kWh vs {mt['units_kwh']:,} kWh on the AMR meter (+{100 * over / mt['units_kwh']:.1f} %)",
                             "impact_rs": rs, "evidence": "bill reading status 'estimated (meter not accessible)'; HUKUM 15-min meter log is complete for the month",
                             "action": "Submit the AMR log and ask for revision to actual units", "recoverable": True})
        billing_md = max(mt["md_kva"], 0.85 * cd)
        if b["demand_kva"] > billing_md + 1:
            over = b["demand_kva"] - billing_md
            rs = over * DEMAND_RS_KVA
            findings.append({"code": "DEMAND_OVERBILLED", "month": m,
                             "text": f"Demand charge billed on {b['demand_kva']:.0f} kVA; recorded MD was {mt['md_kva']:.0f} kVA so billing demand should be max(MD, 85 % of {cd:.0f}) = {billing_md:.0f} kVA",
                             "impact_rs": rs, "evidence": f"meter MD register {mt['md_kva']:.0f} kVA; overbilled {over:.0f} kVA x Rs {DEMAND_RS_KVA:.0f}",
                             "action": "Claim refund of the excess demand charge", "recoverable": True})
        exp_tod = mt["solar_hours_kwh"] * _TOD_REBATE_RS
        if b["tod_rebate_rs"] < exp_tod * 0.5:
            rs = exp_tod - b["tod_rebate_rs"]
            findings.append({"code": "TOD_REBATE_MISSING", "month": m,
                             "text": f"TOD rebate for solar-hours consumption not applied ({mt['solar_hours_kwh']:,} kWh between 09:00 and 17:00)",
                             "impact_rs": round(rs, 0), "evidence": f"Rs {_TOD_REBATE_RS}/kWh rebate shown on every other bill; 0 this month",
                             "action": "Claim the TOD rebate with the 15-min interval data", "recoverable": True})
    overcharge = round(sum(f["impact_rs"] for f in findings), 0)
    recoverable = round(sum(f["impact_rs"] for f in findings if f.get("recoverable")), 0)
    return {"findings": findings, "overcharge_rs": overcharge, "recoverable_rs": recoverable, "tariff_check": checked}
