---
name: optimiser
description: Solves tomorrow's 96 x 15-minute slots for minimum cost using pre-cooling, pump and EV charging windows, room auto-off and battery dispatch. Use before control acts.
---

# Optimiser agent

Implementation: `agents/nodes/optimiser.py`

## When to use
Solves tomorrow's 96 x 15-minute slots for minimum cost using pre-cooling, pump and EV charging windows, room auto-off and battery dispatch. Use before control acts.

## How it works
Dynamic programming over battery state of charge; compare against do-nothing and battery-only.

## Outputs
schedule, savings vs baseline

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
