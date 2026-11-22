# Architecture Blueprint: Remove Codeblocked PRD / Tree-of-Thought (ToT)

- Branch: `feat/state-refresh-2026-11-25` at `2d9c1e2` (no reset to main `e461875`)
- Intro commits (history untouched): `cd2882d` / `656711e` (#107) plus follow-ups `3ae8867`/`7cb305f`, `f95568d`/`a0a8501`, `f84ce7f`, `62c9657`, `5f5de69`, `11d32ba`
- ADRs: ADR-0002 (remove ToT), ADR-0003 (keep CompletionGate without PRD verdicts), both `accepted`
- A02 spec: US-001..US-005, AC-1..AC-15; judgments KEEP CompletionGate, DELETE phase-114 dir

## 1. C4 containers (post-excision)

```
[omp-host] --(reads verdict)--> [completion-gate]
[omp-host] --(flight)--> [hook]
[hook] --(runThink)--> [think-pipeline GoT+CoT]
[hook] --(tracker rows)--> [tracker-gateway]
[think-pipeline] --(settings)--> [config]
[think-pipeline] --(uplift XML)--> [uplift]
```

Deleted containers: `tot-stage`, `prd-sync` (+ their edges). Fitness: `arch_c4_fanout` — 9 containers, 9 relations, max fan-out 3, budget 4, over_budget=[], isolated=[] (SUCCESS).

## 2. Layering

`layer_order` (outermost → innermost): `host, hook, think, track, config, uplift`

Assignments: omp-host, completion-gate → `host`; hook → `hook`; think-pipeline, tot-stage(deleted) → `think`; prd-sync(deleted), tracker-gateway → `track`; config → `config`; uplift → `uplift`.

Edges: omp-host→completion-gate, omp-host→hook, hook→think-pipeline, hook→tracker-gateway, think-pipeline→config, think-pipeline→uplift (tot-stage/prd-sync edges deleted). `arch_layer_violations`: 9 checked, 0 violations. `arch_cycle_check`: has_cycle=false, 9 nodes. `shared_verdict` [info,info] → `pass`.

## 3. Pre-ToT pipeline shape (restore target)

`src/think/pipeline.ts` exports only `runThink` (GoT `buildGraph` + CoT `fillNode`/`repairPass`). No `runToT` import, no PRD stage, no `<PRDS>` block in uplift XML. Release = uplift XML + GoT graph + issue/sub-issue rows present (gate codes `empty`, `truncated`, `missing_child`, `no_xml`, `{name}_short`, `rows_pending`, `tracking_incomplete`, `nodes_degraded`, `degraded` + watchdog). No UI surface (A04 confirm: no panel, dialog, or progress stage for PRDs remains).

## 4. File-disjoint excision lists (one owner per file, no two implementers share a file)

### Slice S1 think/tot (owner A05-think)
- DELETE: `src/think/tot/` (escape.ts/generator.ts/index.ts/runner.ts/stage.ts/template.ts/types.ts + all `*.test.ts` 13 files)
- EDIT: `src/think/pipeline.ts` — remove `runToT` references only if present (currently GoT+CoT only; verify by grep)

### Slice S2 track sync (owner A05-track)
- DELETE: `src/track/prd-sync.ts`, `src/track/prd-sync.test.ts`, `src/track/prd-types.ts`, `src/track/prd-sync-hardening.test.ts`
- KEEP: `src/track/gateway.ts`, `create.ts`, `plan.ts`, `render.ts` (non-PRD tracker behavior untouched)

### Slice S3 hooks/hosts (owner A05-hooks)
- DELETE: `src/claude/hook-tot.ts`, `src/claude/hook-tot.test.ts`
- EDIT: `src/claude/hook.ts` — remove ToT block (~lines 1981-2040 `stage("tot"...)`, `totPending` clarify-skip at ~1642, `TotSeams` import `deps.tot`, `totHoldReason`/`verifyPrdPresence`)
- EDIT: `src/host/completion-gate.ts` — remove `TotManifest`/`SyncSummary` imports, `GateExpected.prds`, `GateObserved.prds*`, `GateArtifacts.prd/prdSync/prdPresence`, verdict codes `prds_failed/prds_sync_failed/prds_sync_pending/prds_not_in_trackers`; keep all non-PRD codes + watchdog
- EDIT: `src/host/omp.ts` — remove `flight.prd` (lines ~404, 1163, 1759, 3115, 3329-3341), `PrdOutcome` import, `prdRefusal` warning; keep flight auto-wait
- EDIT: `src/host/completion-gate.test.ts`, `omp-flight.test.ts`, `omp-insights-integration.test.ts`, `omp-test.helpers.ts` — delete PRD-gating tests only

### Slice S4 uplift/config (owner A05-config)
- EDIT: `src/config/think.ts` — remove `mergeTot` + `think.tot` (keep GoT merge)
- EDIT: `src/config.ts` — remove `TotConfig` type, `ThinkSettings.tot`, `DEFAULT_TOT_CONFIG` (~lines 198-290)
- EDIT: `src/config.test.ts` — remove `think.tot` describe block (~2638-2691); keep `models.tot is removed` doctor test as orphan-config pattern reference
- EDIT: `src/doctor/config-check.ts` — treat `think.tot` like `models.tot` (warn ignored); add test
- EDIT: `src/env-registry.ts`, `.env.example`, `docs/environment.md`, `docs/configuration.md` — remove TOT/PRD env + `think.tot`/`models.tot` docs
- VERIFY: `src/route-defaults.ts` — no tot entries remain (cheapest-model already gone)

### Slice S5 docs/tests (owner A06)
- DELETE: `docs/how-to/code-blocked-prds.md`, `.planning/phases/114-tree-of-thought-prds-on-the-selected-model-placed-inside-the/` (5 files)
- KEEP withdrawn annotations: `.planning/ROADMAP.md` line `114 withdrawn 2026-11-21`, milestone `milestones/v1.24-*` (no re-execute phase 114)
- EDIT: `docs/architecture.md`, `docs/tracking.md`, `docs/how-to/use-ultrathink-in-chat.md` — delete PRD/ToT sections only
- KEEP: `docs/ultrathink-prd-density.md`? DELETE (PRD content); confirm with A02 if ambiguous

### Out of scope (never touch)
`CHANGELOG.md` history, `bin/ultrathink-runtime-install`, `docs/runtime-install.md`, `docs/agent-matrix.md`, `docs/gsd-core-findings.md`, `src/host/omp-flight` auto-wait logic beyond `flight.prd` removal.

## 5. NFR allocation (AC-1..AC-15)

`arch_nfr_allocation` coverage 100% (7/7, fully_allocated=true):

| NFR | Kind | Binding | Limit |
|-----|------|---------|-------|
| NFR-01 | quantitative | AC-1 file-absent | 0 files |
| NFR-02 | quantitative | AC-2 grep residual | 0 matches |
| NFR-03 | quantitative | tsc --noEmit | 0 errors |
| NFR-04 | quantitative | vitest failures | 0 failures |
| NFR-05 | quantitative | retained gate codes | ≥7 codes |
| NFR-06 | quantitative | hook-e2e pre-ToT release | 1 pass |
| NFR-07 | quantitative | phase-114 remaining | 0 files |

## 6. Residual-grep criteria (post-excision, must be empty)

```sh
grep -rInE 'Tree-of-Thought|TreeOfThought|runTot|TotManifest|PrdOutcome|TotSeams|prd-sync|prd-types|hook-tot|<PRDS|code-blocked|think\.tot' src hooks docs .planning --include='*.ts' --include='*.md' --include='*.json' | grep -v 'docs/adr/0002\|docs/adr/0003\|docs/blueprint\|CHANGELOG' # must print nothing
grep -n 'prds_failed\|prds_sync_failed\|prds_sync_pending\|prds_not_in_trackers' src/host/completion-gate.ts # must print nothing
ls src/think/tot src/track/prd-*.ts .planning/phases/114-* docs/how-to/code-blocked-prds.md 2>&1 # all absent
```

## 7. Fitness functions (CI)

- F1 `arch_c4_fanout` on §1 model: max fan-out ≤ 4, no isolated containers.
- F2 `arch_layer_violations` on §2: 0 violations.
- F3 `arch_cycle_check` on §2: acyclic.
- F4 residual-grep (§6): 0 matches.
- F5 `tsc --noEmit` + `vitest run` (narrowed to hook/gate/config/tot-deleted suites): 0 failures.

## 8. Threat model (STRIDE summary for A10)

Removed PRDs eliminate S (tracker write spoofing via PRD), T (PRD content tampering), R/D (ledger replay) surface; residual risk = gate watchdog mis-config (low, existing tests). No new trust boundary introduced; no A10 co-sign required beyond standard review. Supply-chain: SBOM unchanged; allowlist: no new first-party deps; license: unchanged AGPL.
