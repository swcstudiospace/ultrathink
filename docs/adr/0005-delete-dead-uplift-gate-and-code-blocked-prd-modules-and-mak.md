# ADR-0005. Delete dead uplift gate and code-blocked PRD modules and make incomplete plan advisory only

- **Status:** accepted
- **Date:** 2026-11-22
- **Deciders:** A03
- **Task:** T8751-arch

## Context and Problem Statement

Corrective closeout T8751-req US-013..US-017 AC-30..AC-40 NFR-13..NFR-17: 4 dead modules remain on removal/tot-codeblocked-prd, partial gate verdicts still reach the user through blocking wording, and the tracker-pending notice still surfaces at prompt time

## Decision Drivers

US-013 dead modules removed; US-014 incomplete plan advises only; US-015 no tracker-pending notice at prompt time; NFR-13 1000 ms 0 blocked turns; NFR-17 0 new deps

## Considered Options

- keep dead modules for history (rejected: unreachable code, knip/residual-grep risk)
- keep blocking wording with a dialog (rejected: violates AC-33 dialog-free advisory)
- rename partial verdicts but keep prompt-time tracker notice (rejected: violates AC-34/AC-35)

## Decision Outcome

Chosen option: "DELETE src/host/uplift-gate.ts, src/host/uplift-gate.test.ts, src/track/code-blocked-prd.ts, src/track/code-blocked-prd.test.ts after zero-import verification; completion-gate/omp incomplete-plan path (partial verdicts rows_pending, tracking_incomplete, count shorts, degraded) becomes advisory-only with approved wording and no STOP/hold/confirm/proceed language; omp tracker-pending notice moves to aside-only; fatal verdicts (empty, truncated, unclosed root) stay fatal".

### Positive Consequences

- Dead code removed: 0 of 4 files exist and 0 imports of removed paths remain (AC-30, AC-31); knip and residual-grep risk eliminated.
- Partial verdicts yield 1 advisory note and 0 blocked turns within 1000 ms (AC-32, NFR-13); session never stops on an incomplete plan.
- Advisory wording is dialog-free and plain text (NFR-15); tracker-pending notice arrives only as 1 aside (AC-34, AC-35).

### Negative Consequences

- Callers importing the deleted modules fail to compile or test until updated (intended break, caught by tsc/bun gates AC-36, AC-37).
- Advisory-only validation may release a low-quality plan context; mitigated by the 1 advisory note naming every partial problem.
- This ADR refines ADR-0004 (advisory-only validation) and completes ADR-0002 (ToT/Codeblocked removal) for the 4 residual dead modules; it does not supersede either.

## Consequences

0 of 4 files exist, 0 imports of removed paths (AC-30, AC-31); partial verdicts yield 1 advisory note and 0 blocked turns in 1000 ms (AC-32, NFR-13); 0 banned words on incomplete-plan path (AC-33); 0 tracker-pending notices in prompt-turn message and 1 aside carries it (AC-34, AC-35); contract omp-host-nonblocking 1.1.0 additive (trackerNoticeDelivery, advisoryKind) with NFR-08..NFR-17 bindings
