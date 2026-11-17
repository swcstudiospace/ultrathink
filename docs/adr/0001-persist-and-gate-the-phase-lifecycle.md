# ADR 0001: Persist and gate the phase lifecycle

- Status: Proposed
- Phase: 109 (design only). Implementation: phase 110 (LIFE-01, LIFE-04), phase 111 (LIFE-02, LIFE-05), phase 112 (LIFE-03).
- Numbering: this is ADR 0001 on main. The earlier Tab6a ADRs were never merged; they are retired and their numbers are not carried forward.
- State machine: `docs/architecture/phase-lifecycle.md`.

## Status

Proposed. This ADR changes no code. It is not accepted until the owner approves it.

## Context

### Implementation before phase 110

On main, before phase 110, `src/workflow/phase-loop.ts` kept the phase state in memory only. The `loops` map was the sole store, and its comment said nothing is persisted. Phase 110 keeps that map for calls that pass no store (`loops`, L120; comment, L116-119). The state is a prefix of the order Discuss, Plan, Execute, Verify, Ship (`PHASE_ORDER`, L7). Execute is gated on one complete uplift and zero unanswered blocking clarifications (`applyAttempt`, L170-173). Ship starts only through `confirmShip`, which needs one operator confirmation that follows a recorded Verify on a connected runtime (`applyShipConfirmation`, L227-231).

### Problems (from SPE-10128 research)

1. **Close without audit.** Milestones have closed through `override_closeout` and `accepted_tech_debt`. The research records phase 108 as closed without VERIFICATION.md. The v1.22 audit recorded `gaps_found` plus tech debt. On main, `confirmShip` checks no audit, and Verify has no guard beyond order and connection (`applyAttempt`, L165-169).
2. **Concurrent writers.** Several sessions and worktrees write STATE.md and ROADMAP.md. The research records reconciliation from backups and divergent worktrees.
3. **No checkpoint on interrupt.** A kill or pause loses phase progress beyond the tracker rows, because the phase state exists only in the `loops` map.
4. **Human items pass silently.** `human_needed` items (live-infrastructure evidence, human verifiers) stay open with no explicit record. The research records v1.15 as still open for this reason.

The research cites `phase-loop.ts:74-93` and `:100-113`. Those ranges do not match main's 104-line file. Line numbers in this ADR refer to the phase 111 file (414 lines).

## Decision

Phase lifecycle state is persisted, gated, and checkpointed. Each part maps to one requirement in `.planning/REQUIREMENTS.md`.

1. **Persist at every transition (LIFE-01).** Each accepted transition and each counter change commits the `PhaseLoopState` to durable storage before the call returns. Refused attempts write nothing. A restart reads the same state. The storage backend is not decided here.
2. **Checkpoint on kill or pause; restore on resume (LIFE-04).** A pause or a catchable kill writes a checkpoint. Resume restores the latest checkpoint and reports what was restored: phase order, execute and ship starts, and operator confirmations. A hard kill writes no checkpoint, so resume falls back to the last transition committed under part 1.
3. **Close needs an audit; an override needs an owner decision (LIFE-02).** A phase or milestone close requires a recorded audit or validation result. An override requires a recorded owner decision. The close references the record by ID. This ADR specifies the in-repo gate. The milestone-complete gate is out of repo.
4. **Human items are explicit HTIL entries (LIFE-05).** A human-verification or owner-gated item becomes an HTIL entry with an ID, an owner, and a state. An open entry blocks close. Only a recorded owner decision can defer it. Entries never pass silently.
5. **One guarded writer for STATE.md and ROADMAP.md (LIFE-03).** Only one writer changes these two files. A concurrent write fails loudly, and phase 112 covers this with a test. This repository defines the contract. The writer lives in gsd-core and is out of repo. The mechanism (lease, file lock, or other) is not decided here.

## Consequences

### Positive

- A restart or resume returns the same phase state, and the operator sees what was restored.
- A phase cannot close without a recorded audit or a recorded owner decision.
- Human items are visible and countable. Open items are listed rather than left in STATE notes.
- One writer makes a concurrent STATE or ROADMAP edit fail at once, instead of reconciling it later.

### Negative

- Every transition now performs a durable write, so store latency and failures affect the loop.
- Phase 110 chose a file-per-runtime JSON store and an optional checkpoint field on each record (see `docs/architecture/phase-lifecycle.md`). The research's candidates (substrate events, a local snapshot cache) were not chosen.
- A hard kill writes no checkpoint. Work in flight since the last committed transition is lost.
- Close becomes stricter. Existing override practice needs an owner-decision record. Parked phases (108) and open milestones (v1.15) stay open until their items have records. This ADR changes no existing artifacts; retroactive fixes are out of scope.
- The `resetPhaseLoopStateForTests` hook (L411-413) and the in-memory tests must change once the store is persistent.
- Phase 111 landed the change: `confirmShip` now requires a passing audit or an override, and the close is recorded in `closedBy`. See `docs/architecture/phase-lifecycle.md`.

### Out of this repository

- **Milestone-complete gate (LIFE-02).** Lives in gsd-core at `/root/.agents/gsd-core`. This repository specifies only the in-repo phase close gate.
- **Single writer for STATE.md and ROADMAP.md (LIFE-03).** Lives in gsd-core at `/root/.agents/gsd-core`. This repository specifies the contract and the concurrent-write acceptance test.
- The internals of both are not designed here.
