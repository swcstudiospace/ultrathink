# Harness FSM — operator guide

The Ultrathink plugin's phase loop (`src/workflow/phase-loop.ts`) is the harness state machine. Pure transition decisions live in `applyAttempt` / `applyShipConfirmation`; side effects (store load/save, HTTP) run only after a valid transition.

## States (`PhaseLifecycle`, derived via `deriveLifecycle`)

| State | Meaning | Next events |
|-------|---------|-------------|
| ready | loop created, no phase attempted | attempt(Discuss) |
| discussing / planning / executing / verifying | phase recorded, next in order pending | attempt(next) / (verifying: confirmShip, recordAudit, open) |
| awaiting-decision | HTIL entry open, blocks close | resolve(HTIL) |
| blocked | Verify recorded, fail audit and no pass audit | confirmShip, recordAudit, open(HTIL) |
| paused | checkpoint stored (pause/kill) | restore |
| failed | corrupt record quarantined (never derived from state) | — (operator repair) |
| completed | Ship recorded, loop closed | cleanup |
| cleaned-up | terminal; durable cleanup done | — (terminal) |

`phaseLoopStatus(state, checkpoint?)` returns current state, completed stages, active blocker `{id, owner}`, attempt counts (`execute` / `ship` / `operatorConfirmations`) and `nextEvents`. Terminal states accept no phase events.

## Status shape (Slice 1)

`phaseLoopStatus(row, checkpoint?, now?)` returns `PhaseLoopStatus`: `lifecycle`, `completedStages`, active blocker `{id, owner}`, attempt counts, `transitionMetrics`, `recentTransitions` (last 5), `signals`, `nextEvents`, and `closedBy` when set.

- `closedBy` echo — the record the accepted close was recorded against: `{kind: "audit" | "validation" | "override", recordId, recordedAt}`. `recordId` is the audit/validation id or the override's `decisionId`; `recordedAt` is the audit's `recordedAt` or the override's `decidedAt`. Absent until a close is accepted.
- `signals.decisions` — output-only per-decision liveness and quorum, derived from the recorded owner decisions. Present only when the loop records overrides (`row.overrides`); never persisted. One entry per recorded decision:
  - `decisionId` — the override's id.
  - `live` — whether the decision may still close or defer at the status clock (`now`). Revoked decisions are never live; expiry is enforced against `now`, so without a clock a decision reads as live unless revoked.
  - `quorumHave` / `quorumRequired` — distinct approver ids collected vs required (default 1). A decision recorded without `approvals` counts its owner as the single approval.
  - `expiresAt` — echo of the decision's `expiresAt`, when one was recorded.
  - `revoked` — whether a revocation marker (`revokedAt`/`revokedBy`/`revokeReason`, any one) is present.
  - `refusals` — every reason the decision cannot close or defer at the status clock (invalid `expiresAt`/`quorumRequired`, revocation, expiry, quorum shortfall). Empty means the decision is live and holds quorum.
- Refused transitions are durable when recorded with `recordRefusals` — a transition records only when the caller supplies `opts.at`; accepted transitions always record, refused ones record only when `recordRefusals: true`. A recorded refusal is persisted like any transition (bounded ring, `transitionMetrics.refused`, `recentTransitions`) and carries `refusalCodes`; a refused transition without `recordRefusals` still saves nothing.

## Events, guards, errors

- `attemptPhase` — order-only growth; Ship refused; Execute needs 1 complete uplift + 0 unanswered blocking clarifications.
- `confirmShip` — needs Verify last + passing recorded audit cited by id (or complete owner override) + no open HTIL.
- `open` / `resolve` — HTIL lifecycle (LIFE-05); Ship-closed only via merge-gate reconcile (`afterShip`).
- `recordAudit` (LIFE-02) — ledger close cites by id.
- `checkpointPhaseLoop` / `restorePhaseLoop` (LIFE-04) — pause/kill resume; corrupt → `PhaseLoopCorruptError` / `quarantined`, bytes preserved.
- `cleanupPhaseLoop` — requires completed + `closedBy`; throws `FsmError` (`guard`/`rejection`) otherwise.

Illegal transitions return `GateOutcome { accepted:false, refusals }` naming current state, event and legal events, and leave persisted state byte-identical. `FsmError` (new throwing APIs) carries `{ kind: rejection|guard|transient|unrecoverable, state, event, legalEvents }`.

## Persistence & recovery

One JSON per runtimeId (`phase-loop-store.ts`): 0700 dir, 0600 file, temp+fsync+rename, directory fsync. Records carry `schemaVersion` (current `1`, set on first accepted transition; legacy records migrate on write, untouched records read as-is). Transition history appends `{at, from, event, to, accepted, refusals}` when the caller supplies `opts.at`; bounded to 50 entries; refused attempts record nothing (they change nothing).

Restart mid-phase resumes from the last durably persisted stage; completed steps are not re-run. Corrupt/missing/legacy state is never silently reinterpreted — it quarantines or reads with defaults, and requires an explicit recovery event.

## Recovery cheat sheet

| Situation | Action |
|-----------|--------|
| `PhaseLoopCorruptError` / quarantined | operator repair (`RuntimeRepair`), then restore; never overwrite the quarantined copy |
| Close refused | read `refusals`; record audit / resolve HTIL / supply override, retry `confirmShip` |
| HTIL open | `resolve(done)` with evidenceId, or `resolve(deferred)` with decisionId |
| Kill/crash | `restorePhaseLoop` returns paused state + checkpoint; continue from there |
| Missing/corrupt ROADMAP | degraded diagnostic; do not fabricate phases |
