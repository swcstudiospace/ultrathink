# Requirements Spec: pstack Autonomy Uplift inside gsd-autonomous (T3b18-req)

Correlation: `3b18f741-390c-4422-bdd2-4b18499c4490`
Version: 1.0.0
Status: VALIDATED (lint + GWT + INVEST + ambiguity gates green; see evidence in handover)
Source brief: reprogram the pstack flow at production grade; Michael wants Ultrathink to run `/poteto-mode` autonomously inside the `gsd-autonomous` workflow; invert the current subagent-slot bridge into the workflow driving pstack autonomously.

## 1. Context and frozen constraints (do not re-prove)

- pstack v0.15.46 is installed; the fleet resolver and PSTACK roster are shipped via `src/claude/output.ts` (roster rendering threaded into prompt context) and `src/claude/hook.ts` (`pstackRosterFor`, fail-open, byte-identical when off).
- The resolver chain is `src/pstack/subagents.ts` (`resolveSubagentFleet`, `renderSubagentRoster`, never throws) over `src/cursor/pstack.ts` (`resolvePstack`, `skillPath`, `buildBlock`, `detectStage`). This spec reuses that chain; it defines no second resolver and no second roster format.
- `skills/poteto-autonomous/SKILL.md` is the existing autonomous runner (playbook-per-phase-type, one background Task subagent per wave unit, GSD owns TodoWrite/.planning/verify). The uplift binds it to `gsd-autonomous` instead of running as a side skill.
- `gsd-autonomous` at `~/.agents/gsd-core/workflows/autonomous.md` drives phases discuss → plan → execute with Skill() flat invocations and pauses only for explicit user decisions (grey-area acceptance, blockers, validation requests); it re-reads ROADMAP.md after each phase.

## 2. Functional requirements

### FR-1 — Workflow drives poteto-mode playbooks inside gsd-autonomous
Inside `gsd-autonomous`, each phase's execute step dispatches the playbook selected for that phase type via the existing fleet resolver. Phase-type to playbook mapping follows `PLAYBOOK_ROUTES` in `src/pstack/subagents.ts`: discuss → `investigation`, plan → `multi-phase-plan`, execute → `feature`, review → `shipping`. The fleet roster supplies the per-stage subagent skills (e.g. `how` under discuss, `architect`/`arena` under plan, `tdd` under execute, `interrogate`/`no-comments` under review) from the same `DEFAULT_MAPPING` the resolver already applies.

Note on brief wording: the brief abbreviates the router as discuss=`how`, plan=`multi-phase-plan`, execute=`feature`, review=`shipping`. `how` is a roster skill of the discuss stage, not the discuss playbook; the discuss playbook is `investigation` per `PLAYBOOK_ROUTES`. A03/A05 must not invent a `how` playbook; this note is a recorded assumption, not a scope change.

### FR-2 — Fail-open degrade, fail-closed only on explicit override
When pstack is absent, disabled, or unresolvable, `gsd-autonomous` continues with vanilla behaviour and records the fallback reason in the phase SUMMARY provenance. Only an explicit user override (a `--pstack-required`-style flag or `pstack` config strictness) changes the failure mode to fail-closed: the phase stops as blocked and names the resolution reason. The default never blocks a run because of a missing plugin cache.

### FR-3 — Orchestration order: autonomy lives inside phases
Session planning (`/ultrathink` uplift) completes first; Swarm orchestration starts after the uplifted prompt lands. Poteto autonomy executes inside phases (per-unit dispatch within discuss/plan/execute/review), never before the plan exists. No subagent dispatch occurs before the phase PLAN context exists.

### FR-4 — Ownership and wave discipline (unchanged from poteto-autonomous)
GSD owns the loop: TodoWrite, `.planning/` state, phase artifacts, verification, and phase-advance gates stay with the phase owner. Each wave spawns one background subagent per unit in a single message; a phase never advances on a red unit; a failed unit retries inside its playbook's rules. A missing or unusable playbook body stops that unit as blocked with the absent file named; improvising steps is forbidden.

### FR-5 — Observability: one-line summary per phase
Each completed phase emits exactly 1 summary line naming its playbook, its fleet (or the fallback reason), and its outcome, and records per-unit provenance (phase type, playbook, outcome) in the phase SUMMARY before the phase is marked complete. Silent truncation is forbidden: any cap that elides context is surfaced with an explicit marker, as `truncateXml` already does for RATIONALE bodies.

### FR-6 — Typed contracts and explicit failure states
The uplift introduces typed contracts (fleet resolution states, per-phase dispatch records, fallback reasons) with explicit states: ok, disabled, unresolvable, forced-off, blocked. Every failure path yields a named reason; no path yields an empty or ambiguous outcome.

### FR-7 — Tracker closure via gateway
Linear Issues/Sub-Issues and Notion node TODOs are updated for this work, with node TODOs closed only through the gateway (`closeSubIssue` path in `src/track/gateway.ts`); no direct tracker writes bypass the gateway.

## 3. Non-functional requirements

NFR-18 (perf), NFR-19 (security), NFR-20 (a11y), NFR-21 (i18n), NFR-22 (compliance): see `docs/requirements/nfr.md`. Each carries a numeric target and a named verifier; unmeasurable NFRs are rejected, never published.

## 4. Verification contract

`bun run check` (tsc), `biome check --error-on-warnings`, `knip --include exports,types`, and `bun test` are green on the branch; a pull request to main exists; CI is green before merge. This section names checks, never timings: no latency SLO is claimed for the autonomous run itself, because phase duration is bounded by model and tracker behaviour, not by this change.

## 5. Assumptions and open questions

- A1 (recorded): pstack absent → vanilla `gsd-autonomous` continues; this is the brief's recorded assumption and FR-2 encodes it as the default.
- A2 (recorded): the brief's discuss=`how` shorthand denotes the discuss-stage `how` skill; the discuss playbook is `investigation` per `PLAYBOOK_ROUTES`. If Michael intended a `how` playbook, a `requirements.change` is required; scope is not silently widened.
- OQ1: the exact flag name for the explicit override (FR-2) is left to A03/A05; the requirement is that an explicit, user-set flag exists and the default is fail-open.
- OQ2: which Linear/Notion issue set carries this work is owned by A01 dispatch; FR-7 requires gateway closure for whatever set is assigned, 0 bypass writes.

## 6. Out of scope

Architecture design (A03), product code (A05/A06), schema and migrations (A07), release execution (A12). This spec defines what and how well only.

## 7. Traceability

Stories US-018..US-023 in `docs/requirements/stories.md`; criteria AC-41..AC-52 in `docs/acceptance.md`; NFR-18..NFR-22 in `docs/requirements/nfr.md`; links in `docs/requirements/traceability.md`.
