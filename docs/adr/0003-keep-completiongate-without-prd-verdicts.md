# ADR-0003. Keep CompletionGate without PRD verdicts

- **Status:** accepted
- **Date:** 2026-11-22
- **Deciders:** A03
- **Task:** T1750-arch

## Context and Problem Statement

CompletionGate predates ToT and guards the plan-generating race (ULTRATHINK_GATE, 7 non-PRD verdict codes depend on it); only the PRD-gating inputs are ToT-specific

## Decision Drivers

A02 judgment KEEP CompletionGate; pre-ToT release path must still wait for whole plan

## Considered Options

- delete CompletionGate entirely (rejected: reintroduces plan-generating race)
- keep PRD gating (rejected: retains ToT surface)

## Decision Outcome

Chosen option: "Keep src/host/completion-gate.ts and omp.ts flight auto-wait; detach only 4 PRD verdict codes (prds_failed, prds_sync_failed, prds_sync_pending, prds_not_in_trackers) and prd/prdSync/prdPresence inputs".

### Positive Consequences

- Session still cannot start while the plan is generating; confirm dialog or STOP hold releases only on a validated GoT+CoT plan.
- Retained verdict codes: empty, truncated, missing_child, no_xml, {name}_short, rows_pending, tracking_incomplete, nodes_degraded, degraded (plus watchdog/inactivity behavior) — 7 non-PRD codes per A02.
- `GateExpected.prds`, `GateObserved.prds*`, `GateArtifacts.prd/prdSync/prdPresence` inputs and `TotManifest`/`SyncSummary` imports are removed from completion-gate.ts and omp.ts flight.prd.
 
 ### Negative Consequences
 
- Callers passing `prd`/`prdSync` to the gate typecheck-fail after excision (intended compile-time break, caught by NFR-03/04).
- PRD-count progress lines in omp.ts/hook.ts stages are deleted with the stage.

## Consequences

Gate validates uplift XML, GoT graph, issue/sub-issue rows only; session releases without PRDs
