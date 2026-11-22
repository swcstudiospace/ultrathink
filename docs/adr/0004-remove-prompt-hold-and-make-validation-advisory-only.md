# ADR-0004. Remove prompt hold and make validation advisory-only

- **Status:** accepted
- **Date:** 2026-11-22
- **Deciders:** A03
- **Supersedes:** ADR-0003
- **Task:** Tf0b0-arch

## Context and Problem Statement

ADR-0003 retained CompletionGate with STOP hold: session cannot start while plan is generating and STOP hold releases only on a validated GoT+CoT plan; that hold existed only for Codeblocked PRD long generation and now must go per Tf0b0-req US-006..US-009 AC-16..AC-23

## Decision Drivers

US-006..US-009 AC-16..AC-23; NFR-08 5000 ms 0 STOP texts; KEEP closeSubIssue advisory validation fail-open skips aside delivery

## Considered Options

- keep hold with shorter window (rejected: still blocks prompt)
- keep polling with advisory note (rejected: polling timers and blocked flags remain)
- delete hold and make advisory (chosen)

## Decision Outcome

Chosen option: "Delete GATE_HOLD/PENDING/gateHoldPartial/GATE_WAITING/gateWaitingBlocked/NO_PLAN/planFailedNotice/EARLY_RELEASE + boundedWait/deferred held branch and completion-gate waiting_for_plan polling hold; prompts proceed immediately (plan inline-if-ready else aside, validation advisory-only, session never STOP-blocked)".

- Prompts start 1 turn at once with 0 STOP texts (AC-16, AC-17, NFR-08 5000 ms); session never STOP-blocked and handler returns immediately.
- Late plan arrives as exactly 1 aside message carrying plan text, turn count stays 1 (AC-18); ready plan arrives inline with 0 aside duplicates (AC-19).
- Validation failure yields 1 advisory note and 0 blocked turns (AC-20); pass yields 1 execution context with matching hash to 1 worker group (AC-21).
- 0 hold symbols (GATE_HOLD, gateHoldPartial, GATE_WAITING, gateWaitingBlocked, NO_PLAN, planFailedNotice, EARLY_RELEASE, PENDING) and 0 polling timers/boundedWait helpers remain (AC-22, AC-23).
- CompletionGate retained as advisory validator (validateArtifacts, planGateHash, planGateAllowed, watchdog); waiting_for_plan blocking and poll budget removed, gate state value kept non-blocking for transition compatibility.

- ADR-0003 Positive Consequence 'Session still cannot start while the plan is generating; confirm dialog or STOP hold releases only on a validated GoT+CoT plan' is superseded and no longer in force; dialog/hold doc language must be removed (AC-24, AC-25).
- Callers importing deleted hold symbols or relying on STOP texts compile- or test-fail until updated in file-disjoint slices (intended break, caught by NFR-08/AC-28/AC-29 gates).
- Advisory-only validation may release a low-quality plan context; mitigated by 1 advisory note surfacing checklist problems without blocking work.

## Consequences

Prompts start 1 turn at once with 0 STOP texts; late plan arrives as 1 aside with turn count 1; validation failure yields 1 advisory note and 0 blocked turns; 0 hold symbols and 0 polling timers/boundedWait remain; ADR-0003 STOP-hold consequence superseded; CompletionGate retained as advisory validator (validateArtifacts/planGateHash/planGateAllowed kept, waiting_for_plan blocking removed)
