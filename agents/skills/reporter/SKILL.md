---
name: reporter
description: Turns whatever agent outputs exist into a short briefing. Use at the end of every run.
---

# Reporter agent

Implementation: `agents/nodes/reporter.py`

## When to use
Turns whatever agent outputs exist into a short briefing. Use at the end of every run.

## How it works
Tolerate missing or partial agent outputs; produce headline, sections and KPIs.

## Outputs
headline, sections, kpis

## Rules
- Nothing changes on the campus without human approval (except in automate mode).
- Tolerate missing inputs from other agents and say what is missing.
