"""Day-ahead optimiser tools for the State Optimiser (stdlib only, deterministic).

96 x 15-minute slots for tomorrow (slot 0 = 00:00). Tariff, battery and pre-cool
limits mirror ../js/config.js. Pipeline:

1. campus_profile()   inflexible demand + flexible loads at their natural times
2. solar_profile()    PV output from installed kWp x weather shape (seeded noise)
3. place_flex_loads() move shiftable energy (e-buses, pumps, EVs, pre-cooling)
                      into the cheapest slots (solar surplus first)
4. battery_dp()       dynamic programming over SOC (1.875 % steps) minimising
                      import cost - export credit + battery wear, under a grid
                      import cap; cap_search() picks the cap that minimises
                      energy cost + daily share of the demand charge.
"""
from __future__ import annotations

import math
import random

SLOTS = 96
DT = 0.25  # h per slot

TARIFF = {"normal": 8.0, "solar": 6.4, "peak": 9.6, "export": 3.0}
DEMAND_RS_KVA_MONTH = 400.0
DEMAND_RS_KW_DAY = DEMAND_RS_KVA_MONTH / 30.0  # daily proxy (unity PF assumed)
CO2_KG_PER_KWH = 0.71
BATTERY = {"capacity_kwh": 400.0, "max_kw": 150.0, "wear_rs_kwh": 1.5, "soc_min": 0.10, "soc_max": 0.95, "eff": 0.92}
PRECOOL = {"kw": 35.0, "minutes": 90, "reliability": 0.8, "rebound": 0.10}
COMFORT = (22.0, 27.0)


def t_of(slot: int) -> str:
    m = (slot * 15) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def slot_of(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return (int(h) * 60 + int(m)) // 15


def tariff_at(slot: int) -> float:
    h = slot * DT
    if 18 <= h < 22:
        return TARIFF["peak"]
    if 9 <= h < 17:
        return TARIFF["solar"]
    return TARIFF["normal"]


def _interp(points: list[tuple[float, float]], h: float) -> float:
    for (h0, v0), (h1, v1) in zip(points, points[1:]):
        if h0 <= h <= h1:
            return v0 + (v1 - v0) * (h - h0) / (h1 - h0) if h1 > h0 else v1
    return points[-1][1]


# Inflexible campus demand (kW) by hour: hostels, labs, lighting, servers, the
# non-flexible part of HVAC. Flexible loads are added separately.
_BASE_SHAPE = [
    (0, 196), (5, 190), (6, 205), (7.5, 225), (8.75, 285), (10, 318), (12, 330),
    (13, 322), (15, 328), (17, 300), (17.75, 262), (18.25, 250), (19, 244), (19.75, 240),
    (20.5, 228), (21.5, 210), (22.5, 196), (24, 196),
]


def flexible_loads(pump1_kw: float = 15.0) -> list[dict]:
    """Shiftable loads with their natural (do-nothing) start, allowed windows and size."""
    return [
        {"id": "EBUS-1", "kind": "ebus", "kw": 60.0, "slots": 8, "natural": "18:00",
         "windows": [("10:30", "15:30"), ("21:00", "23:45")], "why": "needs 120 kWh before the 07:30 run; parked 10:30-15:30 between trips"},
        {"id": "EBUS-2", "kind": "ebus", "kw": 60.0, "slots": 8, "natural": "18:15",
         "windows": [("10:30", "15:30"), ("21:00", "23:45")], "why": "needs 120 kWh before the 07:30 run; parked 10:30-15:30 between trips"},
        {"id": "PUMP-1", "kind": "pump", "kw": pump1_kw, "slots": 8, "natural": "06:00",
         "windows": [("05:00", "17:00")], "why": "2 h fill of the 50 kL tank, tank stays above 30 %"},
        {"id": "PUMP-2", "kind": "pump", "kw": 15.0, "slots": 8, "natural": "17:00",
         "windows": [("09:00", "20:00")], "why": "2 h fill of the 50 kL tank, tank stays above 30 %"},
        {"id": "EV-1", "kind": "ev", "kw": 7.4, "slots": 8, "natural": "08:30", "windows": [("08:30", "16:30")], "why": "staff car parked 08:30-17:00"},
        {"id": "EV-2", "kind": "ev", "kw": 7.4, "slots": 8, "natural": "08:30", "windows": [("08:30", "16:30")], "why": "staff car parked 08:30-17:00"},
        {"id": "EV-3", "kind": "ev", "kw": 7.4, "slots": 8, "natural": "08:45", "windows": [("08:30", "16:30")], "why": "staff car parked 08:30-17:00"},
        {"id": "EV-4", "kind": "ev", "kw": 7.4, "slots": 8, "natural": "08:45", "windows": [("08:30", "16:30")], "why": "staff car parked 08:30-17:00"},
    ]


# Thermal shifts: load removed from a hot/expensive window and pre-loaded earlier.
def thermal_shifts() -> list[dict]:
    return [
        {"id": "AHU-A", "kw": PRECOOL["kw"], "from": "17:00", "to": "11:00", "slots": 6, "rebound": PRECOOL["rebound"],
         "why": "pre-cool Main Block slab 11:00-12:30 on solar, coast through 17:00-18:30"},
        {"id": "HVAC-BD", "kw": 60.0, "from": "19:00", "to": "15:00", "slots": 6, "rebound": PRECOOL["rebound"],
         "why": "pre-cool hostels 15:00-16:30 before students return, coast through 19:00-20:30"},
    ]


def campus_profile(pump1_kw: float = 15.0, seed: int = 7) -> dict:
    rnd = random.Random(seed)
    base = []
    for s in range(SLOTS):
        h = s * DT + DT / 2
        base.append(round(_interp(_BASE_SHAPE, h) * (1 + rnd.uniform(-0.012, 0.012)), 2))
    # thermal loads at their natural times live inside the base shape (we add the
    # shiftable chunk explicitly so it can be moved)
    therm = [0.0] * SLOTS
    for sh in thermal_shifts():
        a = slot_of(sh["from"])
        for k in range(sh["slots"]):
            therm[a + k] += sh["kw"]
    flex = flexible_loads(pump1_kw)
    flex_kw = [0.0] * SLOTS
    for ld in flex:
        a = slot_of(ld["natural"])
        for k in range(ld["slots"]):
            flex_kw[(a + k) % SLOTS] += ld["kw"]
    demand = [round(base[s] + therm[s] + flex_kw[s], 2) for s in range(SLOTS)]
    return {"base_kw": base, "thermal_kw": therm, "flex_kw": flex_kw, "demand_kw": demand, "flex": flex}


WEATHER = {"sunny": (0.80, 0.03), "cloudy": (0.50, 0.30), "monsoon": (0.30, 0.25)}


def solar_profile(kwp: float = 900.0, weather: str = "sunny", seed: int = 11) -> list[float]:
    peak, noise = WEATHER.get(weather, WEATHER["sunny"])
    rnd = random.Random(seed + {"sunny": 0, "cloudy": 1, "monsoon": 2}.get(weather, 0))
    out = []
    for s in range(SLOTS):
        h = s * DT + DT / 2
        x = (h - 6.25) / 12.0  # sunrise 06:15, sunset 18:15
        shape = math.sin(math.pi * x) ** 1.25 if 0 < x < 1 else 0.0
        f = 1.0 + rnd.uniform(-noise, noise * 0.5) if shape > 0 else 1.0
        out.append(round(max(0.0, kwp * peak * shape * f), 2))
    return out


def _window_slots(windows) -> list[int]:
    out = []
    for a, b in windows:
        out.extend(range(slot_of(a), slot_of(b) + 1))
    return sorted(set(out))


def place_flex_loads(base_kw: list[float], thermal_kw: list[float], flex: list[dict], solar_kw: list[float]) -> dict:
    """Greedy, deterministic placement: biggest loads first, each into the contiguous
    block with the lowest marginal cost given the running net load (surplus solar
    is worth only the 3.0 export credit, imports cost the slot tariff, plus a
    peak penalty)."""
    load = [base_kw[s] for s in range(SLOTS)]
    moves = []
    # thermal shifts: move the chunk, add rebound
    for sh in thermal_shifts():
        a, b = slot_of(sh["from"]), slot_of(sh["to"])
        for k in range(sh["slots"]):
            load[b + k] += sh["kw"] * (1 + sh["rebound"])
        moves.append({"asset": sh["id"], "kw": sh["kw"], "from": f"{sh['from']}-{t_of(a + sh['slots'])}",
                      "to": f"{sh['to']}-{t_of(b + sh['slots'])}", "kwh": round(sh["kw"] * sh["slots"] * DT, 1),
                      "rebound_kwh": round(sh["kw"] * sh["rebound"] * sh["slots"] * DT, 1), "why": sh["why"]})
    del thermal_kw  # thermal natural load is replaced by the shifted version above

    def marginal(s: int, kw: float) -> float:
        net0 = load[s] - solar_kw[s]
        net1 = net0 + kw
        cost = 0.0
        # part absorbed from surplus, part imported
        absorbed = min(kw, max(0.0, -net0))
        imported = kw - absorbed
        cost += absorbed * TARIFF["export"] + imported * tariff_at(s)
        if net1 > 200:  # discourage building new peaks
            cost += (net1 - 200) * 0.02
        return cost

    for ld in sorted(flex, key=lambda d: -d["kw"]):
        allowed = set(_window_slots(ld["windows"]))
        best = None
        for start in sorted(allowed):
            blk = [start + k for k in range(ld["slots"])]
            if not all(x in allowed and x < SLOTS for x in blk):
                continue
            c = sum(marginal(x, ld["kw"]) for x in blk)
            if best is None or c < best[0] - 1e-9:
                best = (c, start)
        start = best[1] if best else slot_of(ld["natural"])
        for k in range(ld["slots"]):
            load[(start + k) % SLOTS] += ld["kw"]
        moves.append({"asset": ld["id"], "kw": ld["kw"], "from": f"{ld['natural']}-{t_of(slot_of(ld['natural']) + ld['slots'])}",
                      "to": f"{t_of(start)}-{t_of(start + ld['slots'])}", "kwh": round(ld["kw"] * ld["slots"] * DT, 1),
                      "rebound_kwh": 0.0, "why": ld["why"]})
    return {"demand_kw": [round(x, 2) for x in load], "moves": moves}


def battery_dp(net_kw: list[float], cap_kw: float | None = None, soc0: float = 0.5, step_frac: float = 0.01875,
               export_rs: float = TARIFF["export"]) -> dict | None:
    """DP over SOC. net_kw = demand - solar (positive = import before battery).
    Returns None if the import cap is infeasible."""
    B = BATTERY
    cap = B["capacity_kwh"]
    step = cap * step_frac
    n = int(round((B["soc_max"] - B["soc_min"]) / step_frac))
    eta = math.sqrt(B["eff"])
    kmax = int(B["max_kw"] * DT / step + 1e-9)
    i0 = int(round((soc0 - B["soc_min"]) / step_frac))
    INF = float("inf")
    tar = [tariff_at(s) for s in range(SLOTS)]
    # precompute per-delta battery grid-side energy
    deltas = list(range(-kmax, kmax + 1))
    gside = {}
    for d in deltas:
        e = d * step
        gside[d] = e / eta if d > 0 else e * eta  # kWh drawn from bus (+) or delivered (-)
    # backward DP: V[s][i] = min cost from slot s with soc index i
    V = [INF] * (n + 1)
    for i in range(n + 1):
        V[i] = 0.0 if i >= i0 else INF  # end of day SOC >= start
    policy = [None] * SLOTS
    for s in range(SLOTS - 1, -1, -1):
        nk = net_kw[s] * DT
        tr = tar[s]
        lim = cap_kw * DT if cap_kw is not None else INF
        Vn = [INF] * (n + 1)
        pol = [0] * (n + 1)
        # cost per delta independent of i
        dcost = {}
        for d in deltas:
            g = nk + gside[d]
            if g > lim + 1e-9:
                continue
            c = g * tr if g >= 0 else g * export_rs
            if d < 0:
                c += -gside[d] * B["wear_rs_kwh"]
            dcost[d] = c
        items = list(dcost.items())
        for i in range(n + 1):
            best, bd = INF, 0
            for d, c in items:
                j = i + d
                if 0 <= j <= n:
                    v = c + V[j]
                    if v < best:
                        best, bd = v, d
            Vn[i], pol[i] = best, bd
        V = Vn
        policy[s] = pol
    if V[i0] == INF:
        return None
    i = i0
    batt, soc, grid = [], [], []
    for s in range(SLOTS):
        d = policy[s][i]
        bus = gside[d] / DT  # kW, + charging
        batt.append(round(-bus, 2))  # + discharging (to the bus), as in the UI
        i += d
        soc.append(round(B["soc_min"] + i * step_frac, 4))
        grid.append(round(net_kw[s] + bus, 2))
    return {"battery_kw": batt, "soc": soc, "grid_kw": grid, "energy_cost": round(_energy_cost(grid, batt), 2)}


def _energy_cost(grid: list[float], batt: list[float]) -> float:
    c = 0.0
    for s, g in enumerate(grid):
        e = g * DT
        c += e * tariff_at(s) if e >= 0 else e * TARIFF["export"]
        if batt[s] > 0:
            c += batt[s] * DT * BATTERY["wear_rs_kwh"]
    return c


def evaluate(grid: list[float], batt: list[float] | None = None) -> dict:
    batt = batt or [0.0] * SLOTS
    energy = _energy_cost(grid, batt)
    imp = sum(max(0.0, g) * DT for g in grid)
    exp = sum(max(0.0, -g) * DT for g in grid)
    peak = max(grid)
    demand = max(0.0, peak) * DEMAND_RS_KW_DAY
    wear = sum(max(0.0, b) * DT for b in batt) * BATTERY["wear_rs_kwh"]
    return {"cost_rs": round(energy + demand, 0), "energy_rs": round(energy - wear, 0), "demand_rs": round(demand, 0),
            "wear_rs": round(wear, 0), "peak_kw": round(peak, 1),
            "evening_peak_kw": round(max(grid[72:88]), 1), "import_kwh": round(imp, 0),
            "co2_kg": round(imp * CO2_KG_PER_KWH, 0), "export_kwh": round(exp, 0)}


def cap_search(net_kw: list[float]) -> dict:
    """Find the grid-import cap that minimises energy cost + daily demand-charge share."""
    base_peak = max(net_kw)
    lo, hi = 0.0, base_peak
    free = battery_dp(net_kw, None)
    if battery_dp(net_kw, lo) is not None:
        hi = lo
    else:
        for _ in range(7):  # bisection on feasibility (about 3 kW resolution)
            mid = (lo + hi) / 2
            if battery_dp(net_kw, mid) is not None:
                hi = mid
            else:
                lo = mid
    cands = sorted({round(hi + 0.5, 1), round(hi + 8, 1), round(hi + 20, 1), round(hi + 40, 1)})
    tried = []
    best = None
    for c in cands + [None]:
        r = free if c is None else battery_dp(net_kw, c)
        if r is None:
            continue
        ev = evaluate(r["grid_kw"], r["battery_kw"])
        tried.append({"cap_kw": c, "cost_rs": ev["cost_rs"], "peak_kw": ev["peak_kw"]})
        if best is None or ev["cost_rs"] < best[0]["cost_rs"]:
            best = (ev, r, c)
    ev, r, c = best
    return {"result": r, "eval": ev, "cap_kw": c, "min_feasible_cap_kw": round(hi, 1), "tried": tried}


def auto_off_profile() -> list[float]:
    """kW saved by switching off empty rooms: timetable gaps 09:00-17:45, hostel common areas 18:00-22:00."""
    out = []
    for s in range(SLOTS):
        h = s * DT
        if 9 <= h < 17.75:
            out.append(16.0 if (h % 2) < 1 else 10.0)  # more gaps in alternate periods
        elif 18 <= h < 22:
            out.append(8.0)
        else:
            out.append(0.0)
    return out


def solve_day(weather: str = "sunny", kwp: float = 900.0, pump1_kw: float = 15.0, export_rs: float = TARIFF["export"],
              soc0: float = 0.5, seed: int = 7) -> dict:
    prof = campus_profile(pump1_kw, seed)
    solar = solar_profile(kwp, weather, seed + 4)
    # baseline: loads at natural times, battery idle
    base_grid = [round(prof["demand_kw"][s] - solar[s], 2) for s in range(SLOTS)]
    baseline = evaluate(base_grid)
    # battery only
    bo = cap_search(base_grid)
    # HUKUM: shift loads, then battery
    # room auto-off in timetable gaps (CCTV + Wi-Fi occupancy, 10 min empty -> off)
    autooff = auto_off_profile()
    base_ao = [round(prof["base_kw"][s] - autooff[s], 2) for s in range(SLOTS)]
    placed = place_flex_loads(base_ao, prof["thermal_kw"], prof["flex"], solar)
    placed["moves"].append({"asset": "ROOMS", "kw": max(autooff), "from": "timetable gaps", "to": "off",
                            "kwh": round(sum(autooff) * DT, 1), "rebound_kwh": 0.0,
                            "why": "empty classrooms and labs switched off after 10 min (CCTV + Wi-Fi occupancy)"})
    net = [round(placed["demand_kw"][s] - solar[s], 2) for s in range(SLOTS)]
    opt = cap_search(net)
    r = opt["result"]
    schedule = [{"slot": s, "t": t_of(s), "solar_kw": solar[s], "demand_kw": placed["demand_kw"][s],
                 "baseline_demand_kw": prof["demand_kw"][s], "battery_kw": r["battery_kw"][s],
                 "grid_kw": r["grid_kw"][s], "soc": r["soc"][s], "tariff": tariff_at(s)} for s in range(SLOTS)]
    pct = lambda a, b: round(100.0 * (a - b) / a, 1) if a else 0.0
    return {
        "baseline": baseline,
        "battery_only": dict(bo["eval"], saving_pct=pct(baseline["cost_rs"], bo["eval"]["cost_rs"]), cap_kw=bo["cap_kw"]),
        "optimised": opt["eval"],
        "saving_pct": pct(baseline["cost_rs"], opt["eval"]["cost_rs"]),
        "cap_kw": opt["cap_kw"], "cap_tried": opt["tried"],
        "moves": placed["moves"], "schedule": schedule,
        "solar_kwh": round(sum(solar) * DT, 0), "auto_off_kwh": round(sum(autooff) * DT, 0), "demand_kwh": round(sum(prof["demand_kw"]) * DT, 0),
        "baseline_peak_t": t_of(max(range(SLOTS), key=lambda s: base_grid[s])),
    }
