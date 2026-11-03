---
name: mapping
description: Builds the campus model (buildings, rooms, loads) from scan data, plans and CCTV without a survey. Use first, whenever the building model is missing or stale.
---

# Mapping agent

Implementation: `agents/nodes/mapping.py`

## When to use
Builds the campus model (buildings, rooms, loads) from scan data, plans and CCTV without a survey. Use first, whenever the building model is missing or stale.

## How it works
Read the scan export, reconcile rooms and equipment tags, report gaps and confidence.

## Outputs
building model, gaps

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
