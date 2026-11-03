---
name: solar-health
description: Checks installed solar for underperformance against expected output. Use for monitoring existing panels and inverters.
---

# Solar Health agent

Implementation: `agents/nodes/solar_health.py`

## When to use
Checks installed solar for underperformance against expected output. Use for monitoring existing panels and inverters.

## How it works
Compare measured and expected generation, flag soiling, shading or inverter faults.

## Outputs
health score, flagged arrays

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
