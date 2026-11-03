---
name: supervisor
description: Plans the run: builds the agent route from the pilot mode or goal and hands control to the next agent. Use at the start of every HUKUM run and after each agent finishes.
---

# Supervisor agent

Implementation: `agents/nodes/supervisor.py`

## When to use
Plans the run: builds the agent route from the pilot mode or goal and hands control to the next agent. Use at the start of every HUKUM run and after each agent finishes.

## How it works
Choose the order (mapping, solar_planner, environment, solar_health, fault_maintenance, bill_auditor, negotiator, optimiser, control). Never route to environment directly; it is reached through the solar loop. Finish with the reporter.

## Outputs
route, next

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
