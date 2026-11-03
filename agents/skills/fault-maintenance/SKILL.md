---
name: fault-maintenance
description: Finds equipment faults and schedules maintenance for pumps, AHUs, batteries and other loads. Use when readings drift from nameplate values.
---

# Fault Maintenance agent

Implementation: `agents/nodes/fault_maintenance.py`

## When to use
Finds equipment faults and schedules maintenance for pumps, AHUs, batteries and other loads. Use when readings drift from nameplate values.

## How it works
Compare measured loads with nameplate data, rank faults by cost and risk.

## Outputs
fault list, maintenance schedule

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
