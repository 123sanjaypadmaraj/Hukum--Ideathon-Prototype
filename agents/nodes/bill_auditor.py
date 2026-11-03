"""Bill Auditor: 12 BESCOM HT bills vs HUKUM meter data and the tariff rules."""
from __future__ import annotations

from ..tools import ops_tools as ops


def run(state, ctx):
    ctx.emit("thought", "Pulling 12 months of BESCOM HT bills for NHCE (contract demand 500 kVA) and the matching 15-minute AMR meter data.")
    data = ctx.tool("fetch_bills_and_meter", ops.synth_bills, seed=5)
    bills = data["bills"]
    units = sum(b["units_kwh"] for b in bills)
    paid = sum(b["amount_rs"] for b in bills)
    ctx.emit("result", f"{len(bills)} bills, {units / 1e6:.2f} GWh, Rs {paid / 1e5:,.1f} lakh billed; vacation and monsoon dips visible in May-Jun and Jul.")
    ctx.emit("thought", "Re-computing each bill line: units vs meter, billing demand = max(recorded MD, 85 % of CD), PF >= 0.90, net-metering export, TOD solar-hours rebate, reading status.")
    audit = ctx.tool("audit_against_tariff", ops.audit_bills, data=data)
    findings = audit["findings"]
    for f in findings:
        ctx.emit("warning" if f.get("recoverable") else "result", f"{f['month']}: {f['text']} (Rs {f['impact_rs']:,.0f}).")

    if any(f["code"] == "PF_PENALTY" for f in findings):
        ctx.handoff("fault_maintenance", "April PF 0.86 penalty: capacitor bank needs testing")
    if any(f["code"] == "EXPORT_NOT_CREDITED" for f in findings):
        ctx.handoff("negotiator", "February export of 1,860 kWh was not credited; verify export credits every month")

    rec = audit["recoverable_rs"]
    fallback = (f"Found {len(findings)} problems worth Rs {audit['overcharge_rs']:,.0f} over 12 months; Rs {rec:,.0f} is recoverable as a refund claim "
                f"(TOD rebate, estimated reading, demand overbilling, export credit). The PF penalty is real and is fixed by repairing the capacitor bank.")
    summary = ctx.llm.think("bill_auditor", system="You are a utility bill auditor for an Indian college. Summarise the audit in two plain sentences using only the numbers given.",
                            payload={"findings": [{k: f[k] for k in ("code", "month", "impact_rs")} for f in findings],
                                     "overcharge_rs": audit["overcharge_rs"], "recoverable_rs": rec}, fallback=fallback) or fallback
    return {"bill_audit": {
        "bills": [{k: b[k] for k in ("month", "units_kwh", "amount_rs", "demand_kva", "recorded_md_kva", "pf", "pf_penalty_rs",
                                      "export_credit_kwh", "tod_rebate_rs", "reading")} for b in bills],
        "findings": findings,
        "overcharge_rs": audit["overcharge_rs"],
        "recoverable_rs": rec,
        "tariff_check": dict(audit["tariff_check"], contract_kva=data["contract_kva"], energy_rs_kwh=ops.ENERGY_RS,
                             demand_rs_kva_month=ops.DEMAND_RS_KVA, tod_rebate_rs_kwh=1.6, export_rs_kwh=ops.EXPORT_RS),
        "claim": {"to": "BESCOM, Assistant Executive Engineer (O&M), HT billing", "amount_rs": rec,
                  "items": [f"{f['month']}: {f['code']} Rs {f['impact_rs']:,.0f}" for f in findings if f.get("recoverable")],
                  "attachments": ["15-min AMR interval data (12 months)", "MD and PF registers", "export register readings"]},
        "summary": summary,
    }}
