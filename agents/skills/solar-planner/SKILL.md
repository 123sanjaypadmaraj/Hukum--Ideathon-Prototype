---
name: solar-planner
description: Designs the rooftop solar and battery plan and revises it until it passes review. Use after mapping, or when the environment agent sends the plan back.
---

# Solar Planner agent

Implementation: `agents/nodes/solar_planner.py`

## When to use
Designs the rooftop solar and battery plan and revises it until it passes review. Use after mapping, or when the environment agent sends the plan back.

## How it works
Size panels and storage per roof, estimate yield, revise on reviewer feedback.

## Outputs
solar plan, yield estimate

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
