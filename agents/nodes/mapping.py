"""Mapping Agent: builds the Main Block model from the HUKUM Scan pipeline
(Google Solar API, Open Buildings, OSM, irradiance, DXF, IFC, plan OCR, SLD,
RoomPlan, nameplates, CCTV, NILM, Wi-Fi, timetable) and asks humans only
about what it is not sure of."""
from __future__ import annotations

import os

from ..tools import mapping_tools as mt


def run(state, ctx):
    ctx.emit("thought", "Building one model of the Main Block: outside first (roof, footprint, sun), then drawings, the phone walkthrough, cameras and the meter.")
    scan = ctx.tool("load_scan_model", mt.load_scan)
    if not scan:
        ctx.emit("warning", "scan_model.json is missing or unreadable; using the built-in Main Block geometry only.")

    site = (scan.get("model") or {}).get("site") or mt.SITE
    solar_live = irr_live = None
    if os.getenv("HUKUM_LIVE") == "1":
        try:
            solar_live = ctx.tool("google_solar_find_closest", mt.live_solar, lat=site.get("lat", mt.SITE["lat"]), lon=site.get("lon", mt.SITE["lon"]))
        except Exception as e:  # noqa: BLE001
            ctx.emit("warning", f"Live Solar API call failed ({type(e).__name__}: {str(e)[:80]}); using the recorded scan instead.")
        try:
            irr_live = ctx.tool("open_meteo_archive", mt.live_irradiance, lat=site.get("lat", mt.SITE["lat"]), lon=site.get("lon", mt.SITE["lon"]))
        except Exception as e:  # noqa: BLE001
            ctx.emit("warning", f"Live Open-Meteo call failed ({type(e).__name__}); using the Bengaluru long-term mean.")

    b = mt.build_building(scan, solar_live, irr_live)
    roof, bld, ir = b["roof"], b["building"], b["irradiance"]
    counts = scan.get("counts") or {}
    fc = b["source_fact_counts"]

    segs = roof["segments"]
    seg_txt = "; ".join(f"segment {s['index']} {s['area_m2']} m2 at {s['pitch_deg']} deg pitch, azimuth {s['azimuth_deg']} deg" for s in segs) or "no segments"
    ctx.emit("result", f"Solar API roof: {seg_txt}. Max layout {roof['max_panels']} panels x {roof['panel_watts']} W = {roof['max_kwp']} kWp (imagery {roof.get('quality') or 'unknown'}).", {"segments": segs})
    ctx.emit("result", f"Open Buildings outline {bld['footprint_m2']} m2, height {bld['height_m']} m -> {int(bld['height_m'] // 3.5)} storeys; OSM names it '{bld['name']}' on the {b['site']['name']} campus with {b['nearby_roads'][0]['name']} about {int(b['nearby_roads'][0]['distance_m'])} m to the south.")
    ctx.emit("result", f"Irradiance {ir['ghi_kwh_m2_day']} kWh/m2/day ({ir['source']}).")
    ctx.emit("result", f"Inside: DXF gave {counts.get('dxf_rooms', 0)} rooms and {fc.get('dxf', 0)} facts, IFC {counts.get('ifc_spaces', 0)} spaces, scanned plan {counts.get('plan_rooms', 0)} rooms with 1 OCR label fixed, single-line diagram {counts.get('sld_lines', 0)} circuits.")
    ctx.emit("result", f"Walkthrough: RoomPlan {counts.get('roomplan_rooms', 0)} rooms, {counts.get('nameplates', 0)} nameplates read; {counts.get('cameras', 0)} CCTV cameras mapped by homography; NILM found {counts.get('nilm_events', 0)} step events ({counts.get('nilm_paired', 0)} on/off pairs); Wi-Fi {counts.get('wifi_aps', 0)} APs; timetable {counts.get('timetable_sessions', 0)} sessions.")
    al = b["alignment"]
    if al:
        ctx.emit("result", f"Alignment: drawing to footprint RMS {al.get('drawing_to_footprint_rms_m')} m (rotation {al.get('drawing_rotation_deg')} deg), walkthrough to drawing RMS {al.get('walkthrough_to_drawing_rms_m')} m.")

    z = roof["zones"]
    ctx.emit("thought", f"Usable roof: {z['inner_after_setback_m2']} m2 inside a {z['setback_m']} m edge setback, minus {z['plant_m2']} m2 of pump and AHU plant zones, stair tower roof excluded -> {roof['usable_m2']} m2.", z)

    s = b["scan_summary"]
    if s:
        ctx.emit("result", f"Fused {sum(fc.values())} facts into {s.get('total')} statements: {s.get('auto')} accepted automatically ({s.get('autoPct')}%), {s.get('open')} need a person.")
    if b["open_questions"]:
        ctx.emit("thought", f"{len(b['open_questions'])} questions for a human instead of guessing: " + " | ".join(b["open_questions"][:6]), {"open_questions": b["open_questions"]})
    ctx.handoff("solar_planner", f"roof model ready, {roof['usable_m2']} m2 usable of {roof['area_m2']} m2, confidence {round(b['confidence'] * 100)}%")
    return {"building": b}
