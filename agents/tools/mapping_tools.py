"""Mapping tools: read the HUKUM Scan model (agents/data/scan_model.json, made by
export_scan.mjs from the in-browser pipeline) and turn it into the `building`
state slice. Optional live mode (HUKUM_LIVE=1) asks the Google Solar API and
Open-Meteo directly and falls back to the file on any error.

Standard library only, deterministic.
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "scan_model.json"

SITE = {"name": "New Horizon College of Engineering", "lat": 12.93385, "lon": 77.69275}

# Main Block roof geometry (metres), consistent with js/scan/samples.js
# OUTLINE_LOCAL and js/building.js (MB roof: MB-PUMP and MB-AHU are 10 x 10 m).
MAIN_W, MAIN_D = 52.0, 29.0          # main roof rectangle
STAIR_W, STAIR_D = 8.0, 3.0          # stair tower on the NE corner
SETBACK_M = 1.2                       # fire / maintenance access strip at the roof edge
PLANT_CLEARANCE_M = 0.5               # service strip on one long side of each plant room
ROAD = {"name": "Outer Ring Road", "side": "south", "distance_m": 110.0}

SOURCE_LABELS = {
    "solar-api": "Google Solar API",
    "open-buildings": "Open Buildings 2.5D",
    "osm": "OpenStreetMap",
    "irradiance": "Irradiance (NASA POWER / Open-Meteo)",
    "dxf": "CAD blueprint (DXF)",
    "ifc": "BIM model (IFC)",
    "plan-ocr": "Scanned plan OCR",
    "sld-ocr": "Single-line diagram OCR",
    "roomplan": "RoomPlan walkthrough",
    "nameplate": "Nameplate OCR",
    "cctv": "CCTV homography",
    "nilm": "NILM on block meter",
    "wifi": "Wi-Fi AP logs",
    "timetable": "Timetable",
    "align": "ICP alignment",
}


def load_scan(path: str | None = None) -> dict:
    """Load the exported scan model; returns {} when the file is missing or broken."""
    try:
        with open(path or DATA, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def roof_zones(plant: list[dict] | None = None) -> dict:
    """Usable roof area: main rectangle minus the 1.2 m edge setback, minus the
    plant rooms (plus a 0.5 m service strip), stair tower roof excluded."""
    plant = plant or [{"id": "MB-PUMP", "w_m": 10, "h_m": 10}, {"id": "MB-AHU", "w_m": 10, "h_m": 10}]
    gross = MAIN_W * MAIN_D + STAIR_W * STAIR_D
    inner = (MAIN_W - 2 * SETBACK_M) * (MAIN_D - 2 * SETBACK_M)
    setback_loss = MAIN_W * MAIN_D - inner
    zones = [{"id": p["id"], "area_m2": round((p["w_m"] + PLANT_CLEARANCE_M * 2) * (p["h_m"]), 1)} for p in plant]
    plant_m2 = sum(z["area_m2"] for z in zones)
    usable = inner - plant_m2
    return {
        "gross_m2": round(gross, 1),
        "inner_after_setback_m2": round(inner, 1),
        "setback_loss_m2": round(setback_loss, 1),
        "stair_roof_m2": STAIR_W * STAIR_D,
        "plant_zones": zones,
        "plant_m2": round(plant_m2, 1),
        "usable_m2": round(usable, 1),
        "setback_m": SETBACK_M,
    }


def _get_json(url: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "HUKUM/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def live_solar(lat: float, lon: float) -> dict:
    """Google Solar API buildingInsights:findClosest -> the same `solar` shape as the file."""
    key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GOOGLE_MAPS_API_KEY is not set")
    q = urllib.parse.urlencode({"location.latitude": lat, "location.longitude": lon, "requiredQuality": "LOW", "key": key})
    j = _get_json(f"https://solar.googleapis.com/v1/buildingInsights:findClosest?{q}")
    sp = j.get("solarPotential") or {}
    segs = [{
        "index": i, "pitch_deg": s.get("pitchDegrees"), "azimuth_deg": s.get("azimuthDegrees"),
        "area_m2": round((s.get("stats") or {}).get("areaMeters2", 0.0), 1),
        "sunshine_hours": ((s.get("stats") or {}).get("sunshineQuantiles") or [None] * 6)[5],
    } for i, s in enumerate(sp.get("roofSegmentStats") or [])]
    cfgs = sp.get("solarPanelConfigs") or []
    watts = sp.get("panelCapacityWatts") or 400
    n = sp.get("maxArrayPanelsCount") or 0
    return {
        "segments": segs, "roofArea": (sp.get("wholeRoofStats") or {}).get("areaMeters2"),
        "maxPanels": n, "panelWatts": watts, "maxKWp": round(n * watts / 1000, 1),
        "yearlyDcKWh": cfgs[-1].get("yearlyEnergyDcKwh") if cfgs else None,
        "sunshineHours": sp.get("maxSunshineHoursPerYear"), "quality": j.get("imageryQuality"),
    }


def live_irradiance(lat: float, lon: float) -> dict:
    """Open-Meteo archive: mean daily shortwave radiation over 2024 -> kWh/m2/day."""
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "start_date": "2024-01-01", "end_date": "2024-12-31",
                                "daily": "shortwave_radiation_sum", "timezone": "Asia/Kolkata"})
    j = _get_json(f"https://archive-api.open-meteo.com/v1/archive?{q}")
    vals = [v for v in (j.get("daily") or {}).get("shortwave_radiation_sum", []) if v is not None]
    if not vals:
        raise RuntimeError("Open-Meteo returned no data")
    return {"ghiKWhPerDay": round(sum(vals) / len(vals) / 3.6, 2), "source": "Open-Meteo archive 2024 (live)"}


def build_building(scan: dict, solar: dict | None = None, irradiance: dict | None = None) -> dict:
    """Shape the scan model into the `building` state slice (see state.py)."""
    model = scan.get("model") or {}
    b = model.get("building") or {}
    sol = solar or scan.get("solar") or {}
    ir = irradiance or scan.get("irradiance") or {"ghiKWhPerDay": 5.35, "source": "Bengaluru long-term mean (NASA POWER)"}
    fp = scan.get("footprint") or {}
    zones = roof_zones(scan.get("roof_plant"))
    summary = scan.get("summary") or {}
    total = summary.get("total") or 0
    auto = summary.get("auto") or 0

    rooms = [{
        "id": r.get("id"), "floor": r.get("floor"), "name": r.get("name"), "area_m2": r.get("area"),
        "type": r.get("type"), "seats": r.get("seats"), "confidence": r.get("confidence"),
    } for r in model.get("rooms") or []]
    circuits = [{"id": c.get("id"), "panel": c.get("panel"), "room": c.get("room"), "confidence": c.get("confidence")}
                for c in model.get("circuits") or []]
    measured = {"PUMP-1": None, "PUMP-2": None}
    equipment = [{
        "id": e.get("id"), "kind": e.get("kind"), "rated_kw": e.get("ratedKW"),
        "measured_kw": e.get("runningKW") if e.get("runningKW") is not None else measured.get(e.get("id")),
        "room": e.get("room"),
    } for e in model.get("equipment") or []]

    return {
        "site": {**SITE, **{k: v for k, v in (model.get("site") or {}).items() if k in ("name", "lat", "lon") and v}},
        "building": {
            "id": b.get("id", "MB"), "name": b.get("name", "Main Block"), "floors": b.get("floors", 3),
            "footprint_m2": b.get("footprintM2") or fp.get("area_m2") or MAIN_W * MAIN_D + STAIR_W * STAIR_D,
            "height_m": b.get("heightM") or fp.get("height_m") or 11.6,
        },
        "roof": {
            "area_m2": sol.get("roofArea") or zones["gross_m2"],
            "usable_m2": zones["usable_m2"],
            "segments": sol.get("segments") or [],
            "max_panels": sol.get("maxPanels") or 0,
            "panel_watts": sol.get("panelWatts") or 400,
            "max_kwp": sol.get("maxKWp") or 0.0,
            "yearly_dc_kwh": sol.get("yearlyDcKWh"),
            "quality": sol.get("quality"),
            "zones": zones,
            "source": "Google Solar API buildingInsights" + (" (live)" if solar else " (HUKUM Scan sample)"),
        },
        "irradiance": {"ghi_kwh_m2_day": ir.get("ghiKWhPerDay", 5.35), "source": ir.get("source", "")},
        "rooms": rooms,
        "circuits": circuits,
        "equipment": equipment,
        "nearby_roads": [ROAD],
        "alignment": scan.get("align") or {},
        "open_questions": [q.get("title", "") for q in scan.get("review") or []],
        "review": scan.get("review") or [],
        "planted_problems": scan.get("planted") or [],
        "sources": [SOURCE_LABELS.get(k, k) for k in (scan.get("source_fact_counts") or {})],
        "source_fact_counts": scan.get("source_fact_counts") or {},
        "scan_summary": summary,
        "confidence": round(auto / total, 3) if total else 0.0,
    }
