---
name: environment
description: Environmental engineer that reviews the solar plan for shading, tilt, heat, dust and carbon impact. Use as the reviewer in the solar loop.
---

# Environment agent

Implementation: `agents/nodes/environment.py`

## When to use
Environmental engineer that reviews the solar plan for shading, tilt, heat, dust and carbon impact. Use as the reviewer in the solar loop.

## How it works
Approve or return the plan with specific objections; loop ends when the plan passes.

## Outputs
review verdict, carbon savings

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
