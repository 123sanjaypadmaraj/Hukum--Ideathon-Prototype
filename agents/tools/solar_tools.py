"""Solar planning, environmental review and PV fleet health tools.

Deterministic, standard library only. Simple, stated physics:
- sun position (declination + hour angle) for Bengaluru, 13.0 N;
- plane-of-array gain from a cosine model (beam on the tilted plane + isotropic
  diffuse) over four representative days;
- row spacing from the 09:00 winter-solstice shadow;
- wind uplift per IS 875 Part 3 (basic wind speed 33 m/s for Bengaluru);
- tariff from js/config.js (solar hours 6.4, export 3.0 Rs/kWh).
"""
from __future__ import annotations

import math
import random

LAT = 12.93
GHI_DEFAULT = 5.35            # kWh/m2/day, Bengaluru long-term mean
PR = 0.78                     # performance ratio used for planning
PANEL_W, PANEL_L, PANEL_WATTS = 1.045, 1.879, 400   # m, m, W (Solar API panel)
PANEL_AREA = PANEL_W * PANEL_L
PACKING = 0.80                # walkways every 4 rows, cable trays, inverter pads
CAPEX_RS_PER_KWP = 42000
TARIFF_SOLAR, TARIFF_EXPORT = 6.4, 3.0
GRID_CO2_KG_KWH = 0.71        # grid emission factor (Southern grid, CEA-style baseline)
EMBODIED_KG_PER_KWP = 1100    # modules + inverters + racking, stated assumption
BALLAST_CO2_KG_PER_KG = 0.10  # precast concrete blocks
CLEAN_L_PER_M2, CLEANS_PER_YEAR = 2.0, 20
EXISTING_BATTERY_KWH = 400    # campus battery (js/config.js), already installed

# IS 875 Part 3: Bengaluru basic wind speed and factors for a ~13 m roof.
VB = 33.0
K1, K2, K3 = 1.0, 0.94, 1.0   # 50-year life, terrain category 3 at ~13 m, flat site
MODULE_RACK_KG_M2 = 15.0      # module + racking self weight per m2 of module
CP_UPLIFT = {                 # net uplift coefficients for ballasted arrays
    ("south", 15): {"edge": 0.90, "interior": 0.50},
    ("south", 10): {"edge": 0.70, "interior": 0.40},
    ("ew", 10): {"edge": 0.50, "interior": 0.30},
}
ROOF_IMPOSED_KN_M2 = 1.5      # IS 875 Part 2, accessible flat roof


# ---------------------------------------------------------------- sun + yield
def sun_position(day: int, hour: float, lat: float = LAT) -> tuple[float, float]:
    """Solar altitude and azimuth (deg, azimuth from north, clockwise) at local solar time."""
    decl = math.radians(23.45 * math.sin(math.radians(360 * (284 + day) / 365)))
    h = math.radians(15 * (hour - 12))
    phi = math.radians(lat)
    sin_alt = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(h)
    alt = math.asin(max(-1.0, min(1.0, sin_alt)))
    cos_az = (math.sin(decl) - math.sin(alt) * math.sin(phi)) / max(1e-9, math.cos(alt) * math.cos(phi))
    az = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    if h > 0:
        az = 360 - az
    return math.degrees(alt), az


def poa_factor(tilt: float, azimuth: float) -> float:
    """Annual plane-of-array irradiance relative to horizontal (cosine model)."""
    t, a = math.radians(tilt), math.radians(azimuth)
    poa = horiz = 0.0
    for day in (80, 172, 266, 355):
        for k in range(48):
            hour = 6 + k * 0.25
            alt, az = sun_position(day, hour)
            if alt <= 2:
                continue
            s = math.sin(math.radians(alt))
            ghi = s ** 1.15
            beam_h, diff_h = 0.68 * ghi, 0.32 * ghi
            zen = math.radians(90 - alt)
            cos_inc = math.cos(zen) * math.cos(t) + math.sin(zen) * math.sin(t) * math.cos(math.radians(az) - a)
            poa += beam_h / s * max(0.0, cos_inc) + diff_h * (1 + math.cos(t)) / 2
            horiz += ghi
    return poa / horiz


def orientation_factor(tilt: float, azimuth: float, ew_share: float = 0.0) -> float:
    """Blend south rows and east-west rows; east-west adds 3% for mutual shading and
    mismatch. Below 12 deg rain washes modules less well: 1.5% extra soiling."""
    south = poa_factor(tilt, azimuth)
    ew = (poa_factor(tilt, 90) + poa_factor(tilt, 270)) / 2 * 0.97
    soiling = 0.985 if tilt < 12 else 1.0
    return (south * (1 - ew_share) + ew * ew_share) * soiling


def row_pitch(tilt: float) -> float:
    """Row-to-row distance so the 09:00 winter-solstice shadow just clears the next row."""
    alt, az = sun_position(355, 9.0)
    h = PANEL_L * math.sin(math.radians(tilt))
    shadow = h / math.tan(math.radians(alt)) * abs(math.cos(math.radians(az - 180)))
    return PANEL_L * math.cos(math.radians(tilt)) + shadow


def ew_pitch(tilt: float) -> float:
    """Back-to-back east-west pair: two module lengths plus a 0.3 m walk gap, per two modules."""
    return (2 * PANEL_L * math.cos(math.radians(tilt)) + 0.3) / 2


def layout(cfg: dict, roof: dict) -> dict:
    """Panels and kWp for a layout config on the roof model from the Mapping Agent."""
    z = roof.get("zones") or {}
    if cfg.get("source") == "solar_api_max":
        n = int(roof.get("max_panels") or 452)
        gross = float(roof.get("area_m2") or 1530.5)
        return {"panels": n, "kwp": round(n * PANEL_WATTS / 1000, 1), "array_m2": round(gross, 1), "road_panels": int(n * 0.14),
                "pitch_m": None, "ew_panels": 0, "note": "Solar API maximum array over every roof segment"}
    area = float(z.get("inner_after_setback_m2", 1319.4)) if cfg.get("setback_m", 0) >= 1.2 else float(roof.get("area_m2") or 1530.5)
    if cfg.get("exclude_plant", False):
        area -= float(z.get("plant_m2", 220.0))
    tilt = cfg.get("tilt_deg", 15)
    pitch = row_pitch(tilt)
    dens_s = 1 / (PANEL_W * pitch) * PACKING
    road_band = 5.0 * 27.6            # southern ~5 m band east of the plant rooms (two rows)
    if cfg.get("drop_road_rows"):
        area -= road_band
        road_band = 0.0
    road_dens = (1 / (PANEL_W * ew_pitch(tilt)) * PACKING) if cfg.get("road_rows_ew") else dens_s
    road_panels = int(road_band * road_dens)
    main_panels = int((area - road_band) * dens_s)
    n = main_panels + road_panels
    return {"panels": n, "kwp": round(n * PANEL_WATTS / 1000, 1), "array_m2": round(area, 1), "pitch_m": round(pitch, 2),
            "road_panels": road_panels, "ew_panels": road_panels if cfg.get("road_rows_ew") else 0,
            "note": f"{area:.0f} m2 array zone, row pitch {pitch:.2f} m, packing {PACKING}"}


def daily_profiles():
    """Normalised hourly PV shape (sums to 1 per day) and Main Block demand in kW."""
    pv = []
    for hr in range(24):
        alt, _ = sun_position(80, hr + 0.5)
        pv.append(max(0.0, math.sin(math.radians(alt))) ** 1.15 if alt > 0 else 0.0)
    s = sum(pv)
    pv = [x / s for x in pv]
    weekday = [25, 25, 25, 25, 25, 25, 30, 40, 60, 95, 110, 120, 120, 118, 120, 110, 90, 70, 45, 35, 30, 28, 25, 25]
    return pv, weekday


def self_consumption(kwp: float, yield_kwh_year: float) -> dict:
    """Hour-by-hour comparison of PV against Main Block demand over a year of day types."""
    pv_shape, wk = daily_profiles()
    day_kwh = yield_kwh_year / 365
    types = [("weekday, term", 200, 1.0), ("saturday", 44, 0.6), ("sunday/holiday", 61, 0.3), ("vacation weekday", 60, 0.45)]
    used = total = 0.0
    for _, days, k in types:
        for hr in range(24):
            p = pv_shape[hr] * day_kwh
            d = wk[hr] * k
            used += min(p, d) * days
            total += p * days
    return {"self_kwh": round(used), "export_kwh": round(total - used), "self_pct": round(100 * used / total, 1) if total else 0.0,
            "demand_note": "Main Block 60-120 kW in teaching hours, 25 kW at night; Saturday x0.6, Sunday x0.3, vacations x0.45"}


def economics(cfg: dict, lay: dict, ghi: float = GHI_DEFAULT) -> dict:
    tilt, az = cfg.get("tilt_deg", 15), cfg.get("azimuth_deg", 197)
    ew_share = lay["ew_panels"] / lay["panels"] if lay["panels"] else 0.0
    f = orientation_factor(tilt, az, ew_share)
    y = lay["kwp"] * ghi * 365 * PR * f
    sc = self_consumption(lay["kwp"], y)
    extras = {}
    if cfg.get("glass") == "anti-glare":
        extras["anti-glare glass on road rows"] = round(lay["road_panels"] * PANEL_WATTS / 1000 * 1500)
    if cfg.get("road_rows_ew"):
        extras["east-west racking"] = round(lay["ew_panels"] * 900)
    ballast_kg = ballast_mass(cfg, lay)
    extra_ballast = max(0.0, ballast_kg - lay["panels"] * PANEL_AREA * 30.0)
    if extra_ballast > 0:
        extras["extra ballast blocks"] = round(extra_ballast * 12)
    capex = lay["kwp"] * CAPEX_RS_PER_KWP + sum(extras.values()) + cfg.get("battery_kwh", 0) * 18000
    savings = sc["self_kwh"] * TARIFF_SOLAR + sc["export_kwh"] * TARIFF_EXPORT
    return {
        "orientation_factor": round(f, 4), "yield_kwh_year": round(y), "specific_yield": round(y / lay["kwp"]) if lay["kwp"] else 0,
        "capex_rs": round(capex), "capex_extras": extras, "savings_rs_year": round(savings),
        "payback_years": round(capex / savings, 2) if savings else None, "self_consumption_pct": sc["self_pct"],
        "self_kwh": sc["self_kwh"], "export_kwh": sc["export_kwh"], "ballast_kg": round(ballast_kg),
    }


def ballast_mass(cfg: dict, lay: dict) -> float:
    m2 = lay["panels"] * PANEL_AREA
    edge_share = 0.3
    return m2 * (cfg.get("edge_ballast_kg_m2", 30) * edge_share + cfg.get("ballast_kg_m2", 30) * (1 - edge_share))


# ---------------------------------------------------------------- environmental review
def wind_check(cfg: dict) -> dict:
    vz = VB * K1 * K2 * K3
    pz = 0.6 * vz ** 2                     # N/m2
    tilt = cfg.get("tilt_deg", 15)
    key = ("south", 15 if tilt > 12 else 10)
    cps = {"south": CP_UPLIFT[key]}
    if cfg.get("road_rows_ew"):
        cps["ew"] = CP_UPLIFT[("ew", 10)]
    need = {}
    for k, cp in cps.items():
        for zone in ("edge", "interior"):
            need[f"{k}_{zone}"] = round(max(0.0, 1.5 * cp[zone] * pz / 9.81 - MODULE_RACK_KG_M2), 1)
    need_edge = max(v for k, v in need.items() if k.endswith("edge"))
    need_int = max(v for k, v in need.items() if k.endswith("interior"))
    have_edge, have_int = cfg.get("edge_ballast_kg_m2", 30), cfg.get("ballast_kg_m2", 30)
    return {"vz_m_s": round(vz, 1), "pz_n_m2": round(pz), "required_edge_kg_m2": need_edge, "required_interior_kg_m2": need_int,
            "provided_edge_kg_m2": have_edge, "provided_interior_kg_m2": have_int,
            "ok": have_edge >= need_edge and have_int >= need_int}


def structural_check(cfg: dict, lay: dict) -> dict:
    m2 = lay["panels"] * PANEL_AREA
    mass = m2 * MODULE_RACK_KG_M2 + ballast_mass(cfg, lay)
    area = max(1.0, lay["array_m2"])
    kn_m2 = mass * 9.81 / 1000 / area
    return {"dead_load_kn_m2": round(kn_m2, 2), "total_t": round(mass / 1000, 1), "imposed_allowance_kn_m2": ROOF_IMPOSED_KN_M2,
            "share_of_allowance_pct": round(100 * kn_m2 / ROOF_IMPOSED_KN_M2)}


def footprint_numbers(lay: dict, econ: dict) -> dict:
    co2 = econ["yield_kwh_year"] * GRID_CO2_KG_KWH / 1000
    emb = (lay["kwp"] * EMBODIED_KG_PER_KWP + econ["ballast_kg"] * BALLAST_CO2_KG_PER_KG) / 1000
    water = lay["panels"] * PANEL_AREA * CLEAN_L_PER_M2 * CLEANS_PER_YEAR
    return {"co2_avoided_t_year": round(co2, 1), "embodied_co2_t": round(emb, 1),
            "carbon_payback_years": round(emb / co2, 2) if co2 else None, "water_l_year": round(water)}


def review_plan(plan: dict, building: dict | None = None) -> dict:
    """Staged engineering review. Stage 1 (roof envelope) must pass before the
    detailed array checks (glare, wind), because row positions change."""
    building = building or {}
    cfg = plan.get("config") or {}
    lay = plan.get("layout") or layout(cfg, (building.get("roof") or {}))
    issues = []
    stage = 1
    if cfg.get("setback_m", 0) < 1.2:
        issues.append({"code": "FIRE_SETBACK", "severity": "block",
                       "text": f"Panels run to the parapet with a {cfg.get('setback_m', 0)} m setback. NBC 2016 fire access and the KSPCB/BBMP rooftop guidance expect a clear access strip at the roof edge for fire-fighters and maintenance.",
                       "fix": "Keep a 1.2 m clear strip along every roof edge and drop the stair-tower roof."})
    if not cfg.get("exclude_plant", False):
        issues.append({"code": "PLANT_ZONE", "severity": "block",
                       "text": "Panels are drawn over the MB-AHU chiller and MB-PUMP plant zones: condenser exhaust heat cuts module output and blocks service access to the pumps and chiller.",
                       "fix": "Exclude both plant rooms plus a 0.5 m service strip (about 220 m2)."})
    st = structural_check(cfg, lay)
    issues.append({"code": "STRUCTURAL", "severity": "warn",
                   "text": f"Modules, racking and ballast add {st['total_t']} t, about {st['dead_load_kn_m2']} kN/m2 over the array zone ({st['share_of_allowance_pct']}% of the {ROOF_IMPOSED_KN_M2} kN/m2 roof allowance). Looks fine on paper, but the slab was not designed for it.",
                   "fix": "Get a structural engineer's certificate for the slab before installation."})
    wind = glare = None
    if not any(i["severity"] == "block" for i in issues):
        stage = 2
        road = (building.get("nearby_roads") or [{"name": "Outer Ring Road", "distance_m": 110}])[0]
        south_road_rows = not cfg.get("drop_road_rows") and not cfg.get("road_rows_ew")
        glare = {"road": road["name"], "distance_m": road.get("distance_m", 110), "tilt_deg": cfg.get("tilt_deg"),
                 "glass": cfg.get("glass", "standard"), "risk": "low"}
        if south_road_rows and (cfg.get("tilt_deg", 15) >= 12 or cfg.get("glass", "standard") == "standard"):
            glare["risk"] = "high"
            issues.append({"code": "GLARE_ORR", "severity": "block",
                           "text": f"The southern rows at {cfg.get('tilt_deg')} deg with standard glass reflect low morning and evening sun toward the {road['name']} about {int(road.get('distance_m', 110))} m away. For traffic safety I am raising this from warn to block.",
                           "fix": "Lower the tilt to 10 deg, use anti-glare glass, and turn the rows nearest the road east-west (or drop those rows)."})
        else:
            issues.append({"code": "GLARE_ORR", "severity": "warn",
                           "text": f"Glare toward the {road['name']} is now low (rows nearest the road are {'removed' if cfg.get('drop_road_rows') else 'east-west with anti-glare glass'}).",
                           "fix": "Confirm with a glare study on the final layout and a site check after commissioning."})
        wind = wind_check(cfg)
        if not wind["ok"]:
            issues.append({"code": "WIND_UPLIFT", "severity": "block",
                           "text": f"IS 875 Part 3: basic wind speed {VB:.0f} m/s gives {wind['vz_m_s']} m/s and {wind['pz_n_m2']} N/m2 at roof height. The {cfg.get('tilt_deg')} deg ballasted rows need {wind['required_edge_kg_m2']} kg/m2 at the edges and {wind['required_interior_kg_m2']} kg/m2 inside; the plan has {wind['provided_edge_kg_m2']} and {wind['provided_interior_kg_m2']}.",
                           "fix": "Increase edge-zone ballast (or add wind deflectors) to meet the uplift with a 1.5 safety factor."})
        else:
            issues.append({"code": "WIND_UPLIFT", "severity": "warn",
                           "text": f"Ballast meets IS 875 Part 3 uplift ({wind['provided_edge_kg_m2']} kg/m2 edge vs {wind['required_edge_kg_m2']} needed).",
                           "fix": "Re-check ballast positions after the first monsoon."})
    econ = plan.get("economics") or economics(cfg, lay, (building.get("irradiance") or {}).get("ghi_kwh_m2_day", GHI_DEFAULT))
    fp = footprint_numbers(lay, econ)
    if stage == 2:
        issues.append({"code": "WATER", "severity": "warn",
                       "text": f"Module cleaning needs about {fp['water_l_year']:,} L a year ({CLEAN_L_PER_M2:.0f} L/m2 x {CLEANS_PER_YEAR} cleans).",
                       "fix": "Use harvested rainwater or RO reject water, not borewell water."})
    approved = not any(i["severity"] == "block" for i in issues)
    return {"approved": approved, "stage": stage, "issues": issues, "structural": st, "wind": wind, "glare": glare, **fp}


# ---------------------------------------------------------------- PV fleet health
FLEET = [("MB", 400, ["MB-INV1", "MB-INV2"]), ("SVP", 250, ["SVP-INV1", "SVP-INV2"]), ("NSB", 250, ["NSB-INV1", "NSB-INV2"])]
INSOLATION = {"sunny": 5.8, "cloudy": 3.9, "monsoon": 3.0}
TARGET_PR = 0.80


def fleet_health(weather: str = "sunny", seed: int = 2026) -> dict:
    """Seeded one-day string-level measurements vs expected, with planted faults."""
    rng = random.Random(seed)
    h = INSOLATION.get(weather, 5.8)
    g_noon = {"sunny": 920, "cloudy": 610, "monsoon": 480}.get(weather, 920)
    t_amb = {"sunny": 31.0, "cloudy": 27.0, "monsoon": 24.0}.get(weather, 31.0)
    t_cell = t_amb + g_noon * 0.028
    derate = 1 - 0.0037 * (t_cell - 25)
    bos = TARGET_PR / 0.905          # wiring, mismatch, inverter so a healthy plant sits at PR 0.80
    strings, inverters = [], []
    for block, kwp_block, invs in FLEET:
        n = int(kwp_block / 25)
        for i in range(n):
            sid = f"S{i + 1:02d}"
            inv = invs[0] if i < n // 2 else invs[1]
            exp_kw = 25 * g_noon / 1000 * derate * 0.97
            ratio = 1 + rng.gauss(0, 0.012)
            status, diag = "ok", "Within 3% of its neighbours."
            v, a = 620 + rng.gauss(0, 3), 0.0
            if block == "SVP" and sid == "S07":
                ratio, status, diag, v = 0.0, "fault", "0 A while the other strings on SVP-INV2 carry full current, open-circuit voltage normal: blown string fuse or open connector.", 742.0
            elif block == "NSB":
                ratio *= 0.88
                diag = "Uniform 12% loss on every NSB string with normal voltage and an irradiance sensor that agrees with MB: soiling. Last cleaning 41 days ago."
                status = "degraded"
            elif inv == "MB-INV1":
                ratio *= 0.955
                diag = "Normal at the DC side; loss is in MB-INV1 (efficiency drop and thermal derating)."
            elif block == "MB" and sid == "S12":
                ratio, status, v = 0.84 * ratio, "degraded", 568.0
                diag = "Voltage 8% low at normal current: one or more bypass diodes active. Looks like PID or a cracked module; IV-curve and EL test needed."
            kw = exp_kw * max(0.0, ratio)
            a = kw * 1000 / v if v else 0.0
            strings.append({"id": f"{block}-{sid}", "inverter": inv, "kw": round(kw, 2), "expected_kw": round(exp_kw, 2),
                            "ratio": round(max(0.0, ratio), 3), "status": status, "diagnosis": diag,
                            "v": round(v, 1), "a": round(a, 2), "kwp": 25})
    for block, _, invs in FLEET:
        for inv in invs:
            st = [s for s in strings if s["inverter"] == inv]
            eff, temp, alarms, status = round(0.975 + rng.gauss(0, 0.002), 3), round(t_amb + 17 + rng.gauss(0, 1.5), 1), [], "ok"
            if inv == "MB-INV1":
                eff, temp, status = 0.935, 71.0, "warning"
                alarms = ["Heatsink over-temperature 71 C (limit 70 C)", "Output derating active", "Efficiency 93.5% vs 97.5% rated: cooling fan or air filter clogged"]
            if inv == "SVP-INV2":
                status = "warning"
                alarms = ["String S07 input 0 A (string fuse / open circuit)"]
            if any(s["status"] == "degraded" for s in st) and status == "ok":
                status = "warning" if block == "NSB" else "ok"
                if block == "NSB":
                    alarms = ["Yield 12% below model on all strings (soiling)"]
            inverters.append({"id": inv, "status": status, "efficiency": eff, "temp_c": temp, "alarms": alarms,
                              "kw": round(sum(s["kw"] for s in st), 1), "expected_kw": round(sum(s["expected_kw"] for s in st), 1)})
    kwp = sum(k for _, k, _ in FLEET)
    expected_kwh = kwp * h * TARGET_PR
    ratio_all = sum(s["ratio"] * s["kwp"] for s in strings) / kwp
    actual_kwh = expected_kwh * ratio_all
    pr = actual_kwh / (kwp * h)
    lost = expected_kwh - actual_kwh

    def loss_of(pred):
        return sum((1 - s["ratio"]) * s["kwp"] * h * TARGET_PR for s in strings if pred(s))
    breakdown = {
        "SVP-S07 open string": round(loss_of(lambda s: s["id"] == "SVP-S07")),
        "NSB soiling": round(loss_of(lambda s: s["id"].startswith("NSB"))),
        "MB-INV1 derating": round(loss_of(lambda s: s["inverter"] == "MB-INV1")),
        "MB-S12 PID / cracked module": round(loss_of(lambda s: s["id"] == "MB-S12")),
    }
    return {
        "weather": weather, "kwp": kwp, "insolation_kwh_m2": h, "cell_temp_c": round(t_cell, 1),
        "pr": round(pr, 3), "target_pr": TARGET_PR, "expected_kwh": round(expected_kwh), "actual_kwh": round(actual_kwh),
        "lost_kwh_day": round(lost), "lost_rs_day": round(lost * TARIFF_SOLAR), "loss_breakdown_kwh": breakdown,
        "soiling_loss_pct": 12.0, "days_since_cleaning": {"MB": 9, "SVP": 14, "NSB": 41}, "cleaning_due": True,
        "strings": strings, "inverters": inverters,
    }
