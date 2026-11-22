# Architecture Blueprint: Non-blocking Closeout (Tf0b0-arch)

- Branch: `removal/tot-codeblocked-prd` at `a2d676b` (ToT excision already landed, -7104 lines)
- Prior blueprint: `docs/blueprint-tot-excision.md` (US-001..US-005, AC-1..AC-15, NFR-01..NFR-07, ADR-0002/0003)
- This blueprint: US-006..US-012, AC-16..AC-29, NFR-08..NFR-12, ADR-0004 superseding ADR-0003 STOP-hold consequence
- A02 spec: `docs/requirements/spec.md` (draft for gate review), `docs/acceptance.md` (14 criteria AC-16..AC-29), `docs/requirements/nfr.md` (NFR-08..NFR-12), `docs/requirements/traceability.json` (12/12)
- Contract: `contracts/omp-host-nonblocking.json` (OpenAPI 3.1.0, info.version 1.0.0, 3 operations)
- Correlation: f0b0e21f-f469-46da-9609-3c4030a11d7f

## 1. C4 containers (non-blocking closeout)

```
[omp-host] --(advisory consult)--> [completion-gate]
[omp-host] --(flight, non-blocking)--> [hook]
[hook] --(runThink GoT+CoT)--> [think-pipeline]
[hook] --(tracker rows)--> [tracker-gateway]
[think-pipeline] --(settings)--> [config]
[think-pipeline] --(uplift XML)--> [uplift]
[omp-host] --(aside delivery)--> [tracker-gateway-aside]
```

Containers for fitness checks (7): `omp-host`, `completion-gate`, `hook`, `think-pipeline`, `tracker-gateway`, `config`, `uplift`.
Relations for fitness checks (6): `omp-host -> completion-gate` (advisory, never blocks), `omp-host -> hook` (flight, non-blocking), `hook -> think-pipeline` (`runThink`), `hook -> tracker-gateway` (`closeSubIssue`, KEEP), `think-pipeline -> config` (settings), `think-pipeline -> uplift` (XML).
Aside delivery is realized inside `omp-host` via `plan-store`/`carrier` and surfaced as `tracker-gateway` aside rows; it is not a separate container in the fitness check, so it cannot inflate fan-out. `arch_c4_fanout` — 7 containers, 6 relations, max fan-out 2, budget 4, over_budget=[], isolated=[] (SUCCESS).

Deleted from prior containers: `tot-stage`, `prd-sync` (already deleted). Deleted in this closeout (implementation slices, not containers): hold texts `GATE_HOLD`, `PENDING`, `gateHoldPartial`, `GATE_WAITING`, `gateWaitingBlocked`, `NO_PLAN`, `planFailedNotice`, `EARLY_RELEASE`; `boundedWait` helper and deferred held branch in `src/host/omp.ts`; `waiting_for_plan` polling hold (poll budget, blocked flag, plan provider, polling timers) in `src/host/completion-gate.ts`.

## 2. Layering

`layer_order` (outermost -> innermost): `host`, `hook`, `think`, `track`, `config`, `uplift`.

Assignments: `omp-host`, `completion-gate` -> `host`; `hook` -> `hook`; `think-pipeline` -> `think`; `tracker-gateway` -> `track`; `config` -> `config`; `uplift` -> `uplift`.

Edges: `omp-host -> completion-gate`, `omp-host -> hook`, `hook -> think-pipeline`, `hook -> tracker-gateway`, `think-pipeline -> config`, `think-pipeline -> uplift`. `arch_layer_violations`: 6 checked, 0 violations, unassigned=[]. `arch_cycle_check`: has_cycle=false, 7 nodes, cyclic_components=[]. `shared_verdict` [info,info] -> `pass`.

## 3. Post-closeout pipeline shape (restore target)

`src/think/pipeline.ts` exports only `runThink` (GoT `buildGraph` + CoT `fillNode`/`repairPass`). No `runToT`, no PRD stage, no `<PRDS>` in uplift XML (unchanged from excision). Release condition changes from blocking to advisory:

- Prompt submitted while planning runs: handler returns 0 STOP texts and starts 1 turn without confirm step (AC-16); 1 aside delivery scheduled, 0 STOP texts (AC-17); handler returns in <= 5000 ms (NFR-08).
- Plan finishes after prompt: 1 aside message carries plan text, turn count stays 1 (AC-18).
- Plan ready at prompt time: 1 inline message carries plan, 0 aside duplicates (AC-19).
- Plan fails checklist: session proceeds with 1 advisory note, 0 blocked turns (AC-20).
- Plan passes: 1 execution context with matching hash (`planGateHash`) issued to 1 worker group (AC-21).
- `CompletionGate` retained as advisory validator: `validateArtifacts`, `planGateHash`, `planGateAllowed`, watchdog kept; `waiting_for_plan` state value kept non-blocking for transition compatibility (medium confidence per spec assumptions §7), polling timers, poll budget, blocked flag, plan provider removed. `GateState` chain `discovering -> ... -> waiting_for_plan -> plan_validated -> ready` becomes advisory pass-through, never a STOP gate.
- KEEP: `closeSubIssue`, advisory gate validation, fail-open skips (`deliberateSkip`/`DELIBERATE_SKIP_REASONS`), aside delivery mechanism. DELETE: hold/wait texts, `boundedWait`, polling timers, blocked flags, dialog/hold doc language (AC-24, AC-25).
- No UI surface: no panel, dialog, or progress stage for PRDs or holds remains (unchanged from excision; A04 confirms).

## 4. File-disjoint slices for implementers (one owner per file, no two share a file)

### Slice S1 host handler (owner A05-omp)
- EDIT: `src/host/omp.ts` — delete `PENDING`, `GATE_HOLD`, `gateHoldPartial`, `GATE_WAITING`, `gateWaitingBlocked`, `NO_PLAN`, `planFailedNotice`, `EARLY_RELEASE` (lines 448-511); delete `boundedWait` helper and deferred held branch; replace held-result paths with immediate turn start + aside scheduling; keep `gateStalled`, `STORE_UNREADABLE`/`STORE_UNWRITABLE`, `DELIBERATE_SKIP_REASONS`/`deliberateSkip`.
- EDIT: `src/host/omp-render.ts` — remove `PENDING_TYPE` renderer only if gated on hold texts (verify by grep; keep generic aside renderer).

### Slice S2 gate (owner A05-gate)
- EDIT: `src/host/completion-gate.ts` — remove `waiting_for_plan` polling hold: timers, poll budget, blocked flag, plan provider; keep `validateArtifacts`, `planGateHash`, `planGateAllowed`, watchdog, verdict codes `empty`, `truncated`, `missing_child`, `no_xml`, `{name}_short`, `rows_pending`, `tracking_incomplete`, `nodes_degraded`, `degraded`; gate state value retained non-blocking.

### Slice S3 tests (owner A05-tests)
- EDIT: `src/host/omp-flight.test.ts`, `omp-insights-integration.test.ts`, `omp-endpoint.test.ts`, `omp.test.ts`, `omp-test.helpers.ts`, `completion-gate.test.ts` — delete hold-assertion tests, rewrite to non-blocking contract (0 STOP texts, 1 turn, 1 aside/inline, 1 advisory note 0 blocked turns).

### Slice S4 docs (owner A06)
- EDIT: `docs/architecture.md`, `docs/install.md`, `docs/troubleshooting.md`, `docs/configuration.md` — delete dialog/hold phrases, describe immediate start with aside delivery (4 files, AC-25).
- KEEP: `CHANGELOG.md` history, `bin/ultrathink-runtime-install`, `docs/runtime-install.md`.

### Slice S5 Linear + release (owner A01/A08)
- CLOSE with evidence comments (serialized-by-removal for human/owner items, never faked): SPE-35422..SPE-35427, SPE-35369..SPE-35375, PRD carriers with `ultrathink:prd` markers; verify 0 open ToT/PRD remain (AC-26, AC-27).
- GATES: `tsc --noEmit`, `biome`, `knip`, targeted `bun` tests; residual greps empty (AC-28, AC-29); update PR `removal/tot-codeblocked-prd -> main` with evidence.

Out of scope (never touch): GoT+CoT think pipeline behavior; tracker closeout mechanics (`closeSubIssue`); fail-open skips; aside delivery mechanism itself; `CHANGELOG.md` history; runtime install scripts.

## 5. NFR allocation (AC-16..AC-29)

`arch_nfr_allocation` coverage 100% (5/5, fully_allocated=true):

| NFR | Kind | Binding | Limit |
|-----|------|---------|-------|
| NFR-08 | quantitative | POST /prompt handler latency, 0 STOP texts | 5000 ms |
| NFR-09 | quantitative | aside-delivery secret-scan, 100% redaction | 0 findings |
| NFR-10 | quantitative | terminal messages dialog-free, 0 color-only | 0 violations |
| NFR-11 | quantitative | shipped strings en-US, 0 locale formats | 0 violations |
| NFR-12 | quantitative | change dependency diff, AGPL retention | 0 new deps |

No assumed defaults required; all NFRs carry numbers in `docs/requirements/nfr.md`.

## 6. Residual-grep criteria (post-closeout, must be empty)

```sh
grep -rInE 'GATE_HOLD|gateHoldPartial|GATE_WAITING|gateWaitingBlocked|NO_PLAN|planFailedNotice|EARLY_RELEASE|PENDING' src/host/omp.ts src/host/completion-gate.ts --include='*.ts' | grep -v 'test' # must print nothing (AC-22)
grep -rInE 'boundedWait|waiting_for_plan.*poll|pollBudget|gate\.blocked' src/host --include='*.ts' # must print nothing (AC-23)
grep -rInE 'dialog|hold' docs/architecture.md docs/install.md docs/troubleshooting.md docs/configuration.md # hold/dialog phrases must be gone (AC-24)
grep -rInE 'Tree-of-Thought|TreeOfThought|runTot|TotManifest|PrdOutcome|TotSeams|prd-sync|prd-types|hook-tot|<PRDS|code-blocked|think\.tot' src hooks docs .planning --include='*.ts' --include='*.md' --include='*.json' | grep -v 'docs/adr/0002\|docs/adr/0003\|docs/adr/0004\|docs/blueprint' # must print nothing (excision, kept)
```

## 7. Fitness functions (CI)

- F1 `arch_c4_fanout` on §1 model: max fan-out <= 4, no isolated containers (currently 2).
- F2 `arch_layer_violations` on §2: 0 violations.
- F3 `arch_cycle_check` on §2: acyclic.
- F4 residual-grep (§6): 0 matches.
- F5 `tsc --noEmit` + `biome` + `knip` + targeted `bun` tests (omp/gate suites): 0 errors, 1 green summary line (AC-28, AC-29).
- F6 `arch_contract_check` on `contracts/omp-host-nonblocking.json`: verdict `pass`, 0 breaking, 3 operations.

## 8. Threat model (STRIDE summary for A10)

Removed holds eliminate S (STOP-hold spoofing via delayed plan), T (hold text tampering), I (plan in flight disclosure via dialog), D (polling pressure) surface; residual risk = advisory validation releasing low-quality plan context (low, mitigated by 1 advisory note; existing watchdog tests). No new trust boundary; no A10 co-sign required beyond standard review. Supply-chain: SBOM unchanged; allowlist: 0 new first-party deps (NFR-12); licence: AGPL retained for 100% of changed files.

Supply-chain rows (tech.stack.selection): Runtime Bun + TypeScript (existing golden path, catalog miss = none); datastore file JSON `phase-loop-store`/`plan-store` (existing, no new infra); messaging aside `sendMessage`/`appendEntry` (existing, no new service); auth host `ExtensionAPI` (existing). SBOM required; dependency allowlist entry: no additions; licence compatibility: AGPL-3.0-or-later unchanged; OSV risk feed: unknown (no scan evidence in handover, marked unknown, never assumed clean).

## 9. ADR set

- ADR-0002 (accepted): Remove Tree-of-Thought and Codeblocked PRD — not superseded by this closeout.
- ADR-0003 (superseded by ADR-0004): Keep CompletionGate without PRD verdicts — STOP-hold consequence superseded.
- ADR-0004 (accepted, supersedes ADR-0003): Remove prompt hold and make validation advisory-only.
- ADR-0001 (proposed, pre-existing): Persist and gate the phase lifecycle — `arch_adr --list` verdict `fail` solely from ADR-0001 missing sections (`Context and Problem Statement`, `Decision Outcome`); ADR-0004 `missing_sections` = [].
