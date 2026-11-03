"""Multi-campus market tools: export-credit check and a 15-minute double auction.

Standard library only, deterministic. Prices in Rs/kWh.

Assumption (to confirm with BESCOM / KERC open-access and wheeling rules):
moving power between NHCE campuses over the BESCOM network costs a wheeling +
open-access charge of about 1.1 Rs/kWh, shared equally by seller and buyer.
"""
from __future__ import annotations

import math
import random

EXPORT_RS = 3.0
WHEELING_RS = 1.1
SLOT_H = 0.25
WINDOW = ("10:00", "15:00")


def export_check(metered_kwh: float = 1860.0, credited_kwh: float = 1410.0, rate: float = EXPORT_RS,
                 period: str = "last month") -> dict:
    expected = round(metered_kwh * rate, 0)
    credited = round(credited_kwh * rate, 0)
    short = round(expected - credited, 0)
    gap_pct = 100.0 * (metered_kwh - credited_kwh) / metered_kwh if metered_kwh else 0.0
    if gap_pct <= 1.0:
        verdict = "ok: credit matches the export meter within 1 %"
    elif gap_pct <= 3.0:
        verdict = "minor gap: within meter tolerance, watch next month"
    else:
        verdict = f"under-credited by {metered_kwh - credited_kwh:,.0f} kWh ({gap_pct:.1f} %): dispute"
    return {"period": period, "metered_export_kwh": round(metered_kwh, 0), "credited_kwh": round(credited_kwh, 0),
            "credited_rs": credited, "expected_rs": expected, "shortfall_rs": short, "gap_pct": round(gap_pct, 1),
            "verdict": verdict,
            "action": "Raise a dispute with BESCOM (net-metering cell), attach the 15-min export meter logs and the bidirectional meter register photo" if gap_pct > 3 else "No action"}


def campuses(seller_surplus_kwh: float, seed: int = 3) -> list[dict]:
    """Seller + three buyers. Buyers' bids sit between export credit and their import tariff."""
    return [
        {"id": "nhce-main", "name": "NHCE main campus (Marathahalli ORR)", "role": "seller", "surplus_kwh": round(seller_surplus_kwh, 0),
         "deficit_kwh": 0, "ask_rs": 4.2, "bid_rs": None, "import_rs": 6.4,
         "note": "midday solar surplus after HUKUM load shifting and battery charging"},
        {"id": "nhce-hostels", "name": "NHCE hostels (Kadubeesanahalli)", "role": "buyer", "surplus_kwh": 0, "deficit_kwh": 310,
         "ask_rs": None, "bid_rs": 6.6, "import_rs": 8.0, "note": "LT hostel tariff, laundry and water heating at midday"},
        {"id": "partner-school", "name": "Partner school campus (Marathahalli)", "role": "buyer", "surplus_kwh": 0, "deficit_kwh": 220,
         "ask_rs": None, "bid_rs": 6.2, "import_rs": 7.6, "note": "school day ends 15:30, no rooftop solar"},
        {"id": "partner-pu", "name": "Partner PU college (Whitefield)", "role": "buyer", "surplus_kwh": 0, "deficit_kwh": 260,
         "ask_rs": None, "bid_rs": 5.8, "import_rs": 7.2, "note": "small 40 kWp array, still importing at midday"},
    ]


def _slot_shape(n: int) -> list[float]:
    # midday bell: more surplus at 12:00-13:30
    w = [math.sin(math.pi * (k + 0.5) / n) ** 1.5 for k in range(n)]
    s = sum(w)
    return [x / s for x in w]


def clear_market(camps: list[dict], wheeling_rs: float = WHEELING_RS, export_rs: float = EXPORT_RS, seed: int = 3) -> dict:
    """Double auction per 15-min slot 10:00-15:00. Merit order: highest buyer value
    (import tariff) served first. Price per pair = midpoint of the seller's
    opportunity (export credit) and the buyer's import tariff, then each side
    carries half the wheeling charge. A pair trades only if both gain."""
    rnd = random.Random(seed)
    seller = next(c for c in camps if c["role"] == "seller")
    buyers = sorted([c for c in camps if c["role"] == "buyer"], key=lambda c: -c["import_rs"])
    n = 20  # 10:00-15:00
    shape = _slot_shape(n)
    sup = [seller["surplus_kwh"] * shape[k] for k in range(n)]
    dem = {b["id"]: [b["deficit_kwh"] / n * (1 + rnd.uniform(-0.15, 0.15)) for _ in range(n)] for b in buyers}
    agg = {}
    for k in range(n):
        left = sup[k]
        for b in buyers:
            if left <= 1e-6:
                break
            mid = (export_rs + b["import_rs"]) / 2
            seller_net = mid - wheeling_rs / 2
            buyer_net = mid + wheeling_rs / 2
            if seller_net <= export_rs or buyer_net >= b["import_rs"]:
                continue
            if b["bid_rs"] is not None and buyer_net > b["bid_rs"] + 1e-9:
                # buyer will not pay more than its bid: settle at bid if seller still gains
                buyer_net = b["bid_rs"]
                seller_net = buyer_net - wheeling_rs
                if seller_net <= export_rs:
                    continue
            if seller.get("ask_rs") is not None and seller_net < seller["ask_rs"] - 1e-9:
                continue
            q = min(left, dem[b["id"]][k])
            left -= q
            a = agg.setdefault(b["id"], {"kwh": 0.0, "price": buyer_net, "seller_net": seller_net, "first": k, "last": k,
                                         "import_rs": b["import_rs"], "name": b["name"]})
            a["kwh"] += q
            a["last"] = k
    trades = []
    seller_gain = buyer_gain = 0.0
    for bid, a in agg.items():
        kwh = round(a["kwh"], 0)
        sg = kwh * (a["seller_net"] - export_rs)
        bg = kwh * (a["import_rs"] - a["price"])
        seller_gain += sg
        buyer_gain += bg
        t0, t1 = 10 * 60 + a["first"] * 15, 10 * 60 + (a["last"] + 1) * 15
        trades.append({"seller": seller["name"], "buyer": a["name"], "buyer_id": bid, "kwh": kwh,
                       "price_rs": round(a["price"], 2), "seller_net_rs": round(a["seller_net"], 2),
                       "window": f"{t0 // 60:02d}:{t0 % 60:02d}-{t1 // 60:02d}:{t1 % 60:02d}",
                       "gain_rs": round(sg + bg, 0), "seller_gain_rs": round(sg, 0), "buyer_gain_rs": round(bg, 0)})
    sold = sum(t["kwh"] for t in trades)
    return {"trades": trades, "sold_kwh": round(sold, 0), "unsold_kwh": round(seller["surplus_kwh"] - sold, 0),
            "seller_gain_rs": round(seller_gain, 0), "buyer_gain_rs": round(buyer_gain, 0),
            "total_gain_rs": round(seller_gain + buyer_gain, 0), "slots": n,
            "assumption": f"wheeling + open-access charge {wheeling_rs} Rs/kWh, split equally (assumption: confirm with BESCOM / KERC rules)"}
