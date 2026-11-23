---
name: poteto-autonomous
description: Catch-all autonomous runner: pstack-native equivalent of gsd-autonomous. Picks a poteto-mode playbook per phase type, spawns one background Task subagent per wave unit, keeps GSD ownership of TodoWrite/.planning/verify. Use for long unattended runs and multi-phase milestones.
---

# Poteto autonomous

Catch-all autonomous runner that works like `gsd-autonomous` but is pstack-native. It never advances a phase on its own: the GSD phase loop keeps ownership of `TodoWrite`, `.planning/` state, and verification.

The pstack source of truth lives in the `pstack` plugin cache at
`~/.cursor/plugins/cache/cursor-public/pstack/<rev>/skills/poteto-mode/`
(v0.15.46, MIT, `github.com/cursor/plugins`). If the cache moves, resolve the
current revision by globbing `~/.cursor/plugins/cache/cursor-public/pstack/*/skills/poteto-mode/`.

## Mandatory reading before dispatch

Read, in this order, before spawning or writing any code:

1. `poteto-mode/SKILL.md` — the operator's style: goal restatement, data-shape-first, fan-out/swarm discipline, unwinding to the smallest change.
2. `poteto-mode/worker.md` — the worker bar every subagent inherits: first-line kickoff rule, "no worse than its base," reversible-choice autonomy, PR title/body conventions.
3. The selected playbook (next section) in full.

Do not delegate earlier than these reads. The phase loop may summarize them for
the user, but the reads themselves are blocking.

## Playbook selection

Pick one playbook per phase type, per unit, every time:

| Phase type | Playbook |
| --- | --- |
| feature | `playbooks/feature.md` |
| bug-fix | `playbooks/bug-fix.md` |
| refactoring | `playbooks/refactoring.md` |
| investigation | `playbooks/investigation.md` |
| multi-phase known work (a planned DAG of dependent units) | `playbooks/multi-phase-plan.md` |
| long unattended autonomous runs | `playbooks/autonomous-run.md` |

Phase-type priority: if a phase is both multi-phase and autonomous, run
`multi-phase-plan` for the DAG and `autonomous-run` for the unattended execution
of each unit. An investigation is read-only and never becomes a code change
inside this skill; hand it back for re-routing to bug-fix or feature.

Stub and placeholder playbooks never satisfy a unit. If the selected playbook's
body is missing or unusable, stop that unit as blocked and report which file was
absent — never improvise its steps.

## Fleet capability gate

Before any dispatch, check for a `## PSTACK subagent fleet` block in the phase
PLAN's context or in `.planning/STATE.md`:

- **Present** — the fleet is enabled. Dispatch pstack playbook units to Task
  subagents exactly as below.
- **Absent** — the fleet is not installed or not approved. Fall back to the GSD
  executor and reviewer for this phase. Record the fallback (`fleet block absent`)
  in the phase SUMMARY's provenance section and proceed there.

Never silently invent fleet capability: the block, or the fallback, must be named
in the SUMMARY.

No dispatch happens before the phase PLAN exists: without a phase PLAN context
(fleet block or recorded fallback), spawn 0 subagents and record `blocked: no
phase PLAN`.

Each phase resolves into a typed fleet outcome
(`ok|disabled|unresolvable|forced-off|blocked`, contract
`contracts/pstack-dispatch.openapi.json@1.3.0` `FleetOutcome`). Fail-open is
the default: any non-`ok` state falls back to vanilla and the reason is
recorded in SUMMARY. Only an explicit override fails closed (phase stops,
named reason, 0 vanilla units): `ULTRATHINK_PSTACK_STRICT=1`,
`pstack.strict: true` in the user config, or `--pstack-required`.

## Dispatch

Spawn one `Task` subagent per wave unit, all in a single message, each with
`run_in_background:true`. Do not start a sequential chain of agents when a wave
can run in parallel. Each wave is one message; the next wave waits for all units
of the current wave to land.

Every subagent brief starts with this exact first line:

```
Read <player-dir>/worker.md before anything else.
```

where `<player-dir>` is the absolute path of the `poteto-mode` skill folder
resolved from the plugin cache above. Keep the rest of the brief to the goal,
the task, the unit's acceptance bar, and the absolute path of `poteto-mode/SKILL.md`
(the worker needs it to resolve leaf skills). A worker brief carries one unit only —
never a whole phase. Wave DAGs stay multiple units; the mapping tool/graph that
schedules them does not compress them into one agent.

## Phase loop and ownership

- **GSD owns the loop.** TodoWrite, phase transitions, `.planning/STATE.md`,
  phase artifacts (CONTEXT/PLAN/SUMMARY), verification, and the only-to-advance
  user gates stay with the phase owner. A pstack unit never mutates planning state.
- **Units own their change.** Each worker changes only the files its unit names,
  nothing outside its slice, and delivers the acceptance bar in its kickoff.
- Merge each landed wave's results, verify the units against their bars, then
  proceed to the next wave or the next phase. A failed unit is retried inside
  its playbook's rules; a phase never advances on a red unit.

## Provenance

Record per-unit provenance into the phase SUMMARY before the phase is marked
complete: for every wave unit, its phase type, skill and playbook used (or
`GSD executor/reviewer fallback` with the `## PSTACK subagent fleet` absence
noted), and its outcome (landed, blocked, or failed with reason). A phase without
a provenance section is not done.

Also emit one summary line per completed phase in the data-contract shape,
e.g. `phase=execute playbook=feature fleet=tdd outcome=landed units=1/1
fallback=none` — record it with the fleet outcome (`state/fallback/strict`)
so a phase without provenance is never marked done.
