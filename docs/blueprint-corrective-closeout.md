# Architecture Blueprint: Corrective Closeout (T8751-arch)

- Branch: `removal/tot-codeblocked-prd`
- Prior blueprint: `docs/blueprint-nonblocking-closeout.md` (US-006..US-012, AC-16..AC-29, NFR-08..NFR-12, ADR-0004)
- This blueprint: US-013..US-017, AC-30..AC-40, NFR-13..NFR-17, ADR-0005 (refines ADR-0004, completes ADR-0002; supersedes neither)
- A02 spec: `docs/requirements/spec-T8751-req.md`, agreed brief `docs/requirements/brief-T8751-req.md`, criteria `docs/acceptance.md` AC-30..AC-40, NFRs `docs/requirements/nfr.md` NFR-13..NFR-17
- Contract: `contracts/omp-host-nonblocking.json` (OpenAPI 3.1.0, info.version 1.1.0, 3 operations)
- Correlation: 8751d51d-f16a-447f-bba5-2773493f4b03
- Scope note: no code implementation in this task. A05 implements per §5; A08 verifies AC-30..AC-40. No new infrastructure, no new first-party dependency (L2, NFR-17).

## 1. C4 containers (corrective closeout, unchanged from prior blueprint)

```
[omp-host] --(advisory consult)--> [completion-gate]
[omp-host] --(flight, non-blocking)--> [hook]
[hook] --(runThink GoT+CoT)--> [think-pipeline]
[hook] --(tracker rows)--> [tracker-gateway]
[think-pipeline] --(settings)--> [config]
[think-pipeline] --(uplift XML)--> [uplift]
[omp-host] --(aside delivery: plan and tracker notice)--> [tracker-gateway-aside]
```

Containers for fitness checks (7): `omp-host`, `completion-gate`, `hook`, `think-pipeline`, `tracker-gateway`, `config`, `uplift`.
Relations for fitness checks (6): `omp-host -> completion-gate` (advisory, never blocks), `omp-host -> hook` (flight, non-blocking), `hook -> think-pipeline` (`runThink`), `hook -> tracker-gateway` (`closeSubIssue`, KEEP), `think-pipeline -> config` (settings), `think-pipeline -> uplift` (XML).
Aside delivery is realized inside `omp-host` via `plan-store`/`carrier` and surfaced as `tracker-gateway` aside rows; it is not a separate container in the fitness check, so it cannot inflate fan-out. `arch_c4_fanout` — 7 containers, 6 relations, max fan-out 2, budget 4, over_budget=[], isolated=[] (SUCCESS).

Deleted in this closeout (implementation slice, not containers): `src/host/uplift-gate.ts` + test, `src/track/code-blocked-prd.ts` + test. Verified by grep: the only imports of either module path are each deleted file's own test (`src/host/uplift-gate.test.ts:12`, `src/track/code-blocked-prd.test.ts:9`); 0 imports outside the 4-file set. Their `redactSecrets`/`checkUpliftXml` dependencies remain reachable through live modules and are not deleted.

## 2. Layering

`layer_order` (outermost -> innermost): `host`, `hook`, `think`, `track`, `config`, `uplift`.

Assignments: `omp-host`, `completion-gate` -> `host`; `hook` -> `hook`; `think-pipeline` -> `think`; `tracker-gateway` -> `track`; `config` -> `config`; `uplift` -> `uplift`.

Edges: `omp-host -> completion-gate`, `omp-host -> hook`, `hook -> think-pipeline`, `hook -> tracker-gateway`, `think-pipeline -> config`, `think-pipeline -> uplift`. `arch_layer_violations`: 6 checked, 0 violations, unassigned=[]. `arch_cycle_check`: has_cycle=false, 7 nodes, cyclic_components=[]. `shared_verdict` [info,info] -> `pass`.

## 3. Advisory wording spec (UX, for A05/A06)

### 3.1 Scope of the ban

The ban applies to the **incomplete-plan path only**: `completion-gate` partial verdicts (`rows_pending`, `tracking_incomplete`, `{name}_short`, `nodes_degraded`, `degraded`) and the `omp` handling of `gate.state === "partial_failure"`, plus the prompt-time tracker-pending notice. Fatal verdicts (`empty`, `truncated`, unclosed root) keep their existing unusable-plan notice; this spec does not rename fatal-path wording. Non-plan uses of the banned words elsewhere (for example the `ExtensionAPI.confirm` port declaration, insight-lesson confirmation) are out of scope and must not be renamed.

### 3.2 Banned strings on the incomplete-plan path (AC-33)

Case-insensitive, whole-word match against the rendered advisory text **and** the source strings that produce it on that path: `STOP`, `hold`, `confirm`, `proceed`. A grep for these words inside a longer identifier (for example `gateStalled` helper name) is not a user-facing violation, but the helper's rendered output must not contain them. Note the current `gateStalled` output (`Ultrathink stopped planning: ... Continue with the user's request as written.`) contains `stopped`, which matches `STOP` case-insensitively: on the partial-failure branch A05 must stop routing through `gateStalled` and use §3.3 instead. Other `gateStalled` call sites (fatal, delivery failure, session-model change) are out of scope for this ban.

### 3.3 Approved templates

- Partial verdicts (one per `validateArtifacts` run, problems joined by `; `):

  ```
  Plan note: {detail}. The request continues as written.
  ```

  Example: `Plan note: 2 tracker rows were never confirmed; tracking finished partial. The request continues as written.`
  The template contains 0 banned words, is plain text with 0 color-only meanings (NFR-15), uses en-US with 0 locale-dependent formats (NFR-16), and names the missing items without a dialog or decision step.
- Tracker-pending notice, **aside only** (never in the prompt-turn message, AC-34/AC-35):

  ```
  Plan note: {N} tracker rows are still pending. The request continues as written.
  ```

  Delivered exactly once as the aside; the prompt-turn message carries 0 tracker-pending notices and `trackerNoticeDelivery` is `aside` (or `none` when there is no notice).

### 3.4 Delivery rules

| AC | Rule |
|---|---|
| AC-32 | `validateArtifacts` on tracker-row failure reports 1 advisory note and 0 blocked turns; returns in <= 1000 ms (NFR-13). |
| AC-33 | 0 banned strings on the incomplete-plan path (rendered text + producing source strings). |
| AC-34 | Prompt with pending tracker rows: 0 tracker-pending notices in the prompt-turn message; 1 aside carries the notice. |
| AC-35 | 0 tracker-pending notice call sites execute before the turn starts. |

### 3.5 Worked examples (for A08 test fixtures)

- Partial: `detail = "2 tracker rows were never confirmed"` -> `Plan note: 2 tracker rows were never confirmed. The request continues as written.` (banned-word scan: clean).
- Partial, multi-problem: `detail = "2 tracker rows were never confirmed; tracking finished partial"` -> single note, problems joined by `; `, 0 blocked turns.
- Tracker aside: `N = 2` -> `Plan note: 2 tracker rows are still pending. The request continues as written.` as aside; prompt-turn message contains no tracker-pending text.

## 4. Contract (api.contract, additive 1.1.0)

`contracts/omp-host-nonblocking.json`, OpenAPI 3.1.0, info.version 1.1.0 (base 1.0.0, minor bump, `arch_semver_bump` compliant=true), 3 operations (`arch_contract_ops` operations=3: POST /prompt, GET /plan, POST /validate). Additive optional response fields only: `trackerNoticeDelivery` enum `none|aside` on POST /prompt, `advisoryKind` enum `partial|fatal|none` on POST /validate (`arch_field_breaks` response: breaking_change=false, additive=[advisoryKind, trackerNoticeDelivery]). `arch_contract_check.py --file ... --base <1.0.0 copy>`: verdict `pass`, breaking=[], findings=[], skipped=[]. Consumers: A05 (implement), A06 (docs wording), A08 (verify). No breaking change; no L3 approval needed. NFR bindings NFR-08..NFR-17 are in `info.x-nfr-bindings`.

## 5. File-disjoint slices for implementers (one owner per file, no two share a file)

### Slice S1 delete dead modules (owner A05-delete)
- DELETE (after re-verifying 0 imports outside the set): `src/host/uplift-gate.ts`, `src/host/uplift-gate.test.ts`, `src/track/code-blocked-prd.ts`, `src/track/code-blocked-prd.test.ts`. Verify first: `grep -rInE 'uplift-gate|code-blocked-prd' src --include='*.ts'` must show only the two deleted test files importing their own module (AC-30, AC-31).

### Slice S2 gate advisory (owner A05-gate)
- EDIT: `src/host/completion-gate.ts` — partial verdicts (`rows_pending`, `tracking_incomplete`, `{name}_short`, `nodes_degraded`, `degraded`) stay `severity: "partial"` and map to 1 advisory note, 0 blocked turns, <= 1000 ms (AC-32, NFR-13). Do not change fatal severities (`empty`, `truncated`, unclosed root).
- EDIT: `src/host/omp.ts` — `partial_failure` branch (`gateDelivery`, currently `gateStalled('plan incomplete: ...')`): render §3.3 template, route no banned words, deliver as advisory note; do not route this branch through `gateStalled`. Move any prompt-time tracker-pending notice out of the prompt-turn message into the aside (§3.3, AC-34, AC-35).
- EDIT: `src/host/completion-gate.test.ts`, `src/host/omp.test.ts`, `omp-flight.test.ts`, `omp-endpoint.test.ts`, `omp-insights-integration.test.ts`, `omp-test.helpers.ts`, `omp-delivery.test.ts` — update affected assertions to the advisory contract (1 advisory note, 0 blocked turns, banned-word clean, aside-only tracker notice). Do not delete these test files; only the 2 S1 test files are deleted.

### Slice S3 gates + closure (owner A05/A01/A08)
- GATES: tokenOpt standalone, full `bun test`, `tsc --noEmit`, `biome`, `knip`, residual greps (§7) — 0 failures, 1 green summary line (AC-36, AC-37, AC-38).
- CLOSE Linear ToT/Codeblocked sets with 1 evidence comment per issue, 0 open (AC-39). UPDATE PR `removal/tot-codeblocked-prd -> main` with 1 plugin-reload note, 0 open review threads (AC-40).

Out of scope (never touch): GoT+CoT think pipeline behavior; tracker closeout mechanics (`closeSubIssue`); fail-open skips; aside delivery mechanism itself; `CHANGELOG.md` history; runtime install scripts; fatal-verdict wording; `ExtensionAPI.confirm` port and insight-lesson confirmation (outside §3.1 scope).

## 6. NFR allocation (AC-30..AC-40)

`arch_nfr_allocation` coverage 100% (5/5, fully_allocated=true):

| NFR | Kind | Binding | Limit |
|-----|------|---------|-------|
| NFR-13 | quantitative | POST /validate blockedTurns, latency | 1000 ms |
| NFR-14 | quantitative | POST /validate + POST /prompt secret-scan | 0 findings |
| NFR-15 | quantitative | advisory notes plain-text dialog-free | 0 color-only meanings |
| NFR-16 | quantitative | shipped strings en-US | 0 locale formats |
| NFR-17 | quantitative | change dependency diff, AGPL retention | 0 new deps |

No assumed defaults required; all NFRs carry numbers in `docs/requirements/nfr.md`. Prior NFR-08..NFR-12 bindings are unchanged in contract 1.1.0.

## 7. Residual-grep criteria (post-closeout, must be empty)

```sh
grep -rInE 'uplift-gate|code-blocked-prd' src --include='*.ts' # must print nothing (AC-31, AC-38)
# incomplete-plan path rendered text and producing strings: 0 banned words (AC-33)
grep -rInE '\b(STOP|hold|confirm|proceed)\b' src/host/completion-gate.ts # must print nothing
# omp.ts partial_failure branch + prompt-time tracker notice: 0 banned words, aside-only (AC-33..AC-35)
```

## 8. Fitness functions (CI)

- F1 `arch_c4_fanout` on §1 model: max fan-out <= 4, no isolated containers (currently 2).
- F2 `arch_layer_violations` on §2: 0 violations.
- F3 `arch_cycle_check` on §2: acyclic.
- F4 residual-grep (§7): 0 matches.
- F5 tokenOpt standalone + full `bun test` + `tsc --noEmit` + `biome` + `knip`: 0 failures, 1 green summary line (AC-36, AC-37).
- F6 `arch_contract_check` on `contracts/omp-host-nonblocking.json`: verdict `pass`, 0 breaking, 3 operations.

## 9. Threat model (STRIDE summary for A10)

Deleting the uplift gate removes its `WAIT_BOUND_MS`/hold-status surface (T: gate-status spoofing, D: 600 s wait pressure). Advisory-only partial verdicts remove the prompt-time tracker notice disclosure (I: pending-row detail in the prompt turn) while keeping 1 aside note; residual risk = advisory validation releasing a low-quality plan context (low, mitigated by the advisory note naming every partial problem; fatal verdicts still block release). No new trust boundary; no A10 co-sign required beyond standard review. Supply-chain: 0 new first-party dependencies (NFR-17); SBOM unchanged; dependency allowlist: no additions; licence: AGPL-3.0-or-later retained for 100% of changed files; OSV risk feed: unknown (no scan evidence in handover, marked unknown, never assumed clean).

Tech stack (tech.stack.selection): Bun + TypeScript (existing golden path, catalog miss = none); datastore file JSON `phase-loop-store`/`plan-store` (existing, no new infra); messaging aside `sendMessage`/`appendEntry` (existing, no new service); auth host `ExtensionAPI` (existing).

## 10. ADR set

- ADR-0002 (accepted): Remove Tree-of-Thought and Codeblocked PRD — completed by ADR-0005 for the 4 residual dead modules; not superseded.
- ADR-0003 (superseded by ADR-0004): Keep CompletionGate without PRD verdicts — STOP-hold consequence superseded.
- ADR-0004 (accepted): Remove prompt hold and make validation advisory-only — refined by ADR-0005 for partial verdicts and aside-only tracker notice; not superseded.
- ADR-0005 (accepted, supersedes none): Delete dead uplift gate and code-blocked PRD modules and make incomplete plan advisory only. `arch_adr_slug` slug `delete-dead-uplift-gate-and-code-blocked-prd-modules-and-mak`; `arch_adr_transition` proposed->accepted allowed=true; `arch_adr.py --list`: ADR-0005 missing_sections=[]; overall index verdict `fail` solely from pre-existing ADR-0001 (`persist-and-gate-the-phase-lifecycle`) missing sections, documented in the prior blueprint §9 and out of scope here.
