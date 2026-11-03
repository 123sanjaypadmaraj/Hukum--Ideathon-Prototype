---
name: negotiator
description: Multi-campus negotiator that verifies export credit and trades midday surplus between campuses. Use after the optimiser has a schedule.
---

# Negotiator agent

Implementation: `agents/nodes/negotiator.py`

## When to use
Multi-campus negotiator that verifies export credit and trades midday surplus between campuses. Use after the optimiser has a schedule.

## How it works
Take midday surplus (10:00-15:00 export) and price a trade or credit.

## Outputs
surplus kWh, trade terms

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
