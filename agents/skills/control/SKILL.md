---
name: control
description: Turns the optimiser schedule and fault list into safe actions, pausing for human approval in approve mode. Use last; the only agent that changes anything.
---

# Control agent

Implementation: `agents/nodes/control.py`

## When to use
Turns the optimiser schedule and fault list into safe actions, pausing for human approval in approve mode. Use last; the only agent that changes anything.

## How it works
Modes: shadow (log only), approve (interrupt and wait for yes/no), automate (execute). Never touch critical loads: data centre, Sanjeevini health centre, CCTV control room.

## Outputs
actions with status

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
