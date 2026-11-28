# CONTEXT — claude-ultrathink (Wave 1 discovery)

Ref: SPE-39903 https://linear.app/swcstudio/issue/SPE-39903/n3-generate-sota-quality-and-fsm-options

## 1. Required commands (from package.json scripts + .github/workflows)

package.json `scripts` (root, `bun` >= 1.2):

- `bun test` → `bun test` (+ `ULTRATHINK_SMOKE_SERVICE=1` in CI)
- `bun run check` → `bunx --package typescript@5.9.3 tsc --noEmit`
- `bun run check:services` → `bunx --package typescript@5.9.3 tsc --noEmit -p services/ultrathink/tsconfig.json`
- `bun run lint` → `biome check --error-on-warnings .`
- `bun run deadcode` → `knip --include exports,types`
- `bun run verify` → `bun run check && bun run lint && bun run deadcode && bun test && python3 hosts/hermes/bridge_test.py && python3 hosts/prime-agent/bridge_test.py`
- `bun run grep-gate` → `bun run scripts/grep-gate.ts`
- `bun run policy:check` → `bash policy/check.sh`
- `bun run compliance` → `bun policy/compliance-report.ts --root .`
- `bun tooling/schema/validate.ts` — plugin source + manifest schema validation (CI step)
- `bun tooling/boundary/check-core-boundary.ts` — core dependency boundary (CI step)
- `bun tooling/secret-scan/scan.ts core adapters conformance tools tooling plugin docs/plugin-research docs/install test/golden` — credential scan (CI step)
- `python3 hosts/hermes/bridge_test.py`, `python3 hosts/prime-agent/bridge_test.py` — bridge tests (CI steps)

CI (.github/workflows/):

- `ci.yml` — matrix `bun: [1.2.x, latest]`; latest leg runs `check`, `check:services`, `lint`, changed-files `biome format`, `deadcode`, `bun test`, `gen:manifests` drift, schema validation, boundary, secret-scan, both bridge tests; conformance job per adapter (`bun test conformance --test-name-pattern "$SUBJECT"`)
- `security-scan.yml` — `Dependency audit`, `License policy` (both via trusted `origin/main` copy of `scripts/security-gate.ts` with `--root . --root plugins/omp-token-opt`), `Semgrep` (`.semgrep/rules`, SARIF upload)
- `codeql.yml` — `Analyze (javascript-typescript)`, `Analyze (python)` (build-mode none)
- `policy.yml` — `bash policy/check.sh` + compliance summary
- `release.yml` — `verify` (ancestry + tag/manifest/changelog + gates + evidence artifact) then `release` (write-only, no repo code)

## 2. Branch protection evidence

- Required check names (`.github/security-policy.json` `requiredChecks`, 6 total): `Dependency audit`, `License policy`, `Semgrep`, `Analyze (javascript-typescript)`, `Analyze (python)`, `Check and test (Bun latest)`.
- Enforcement: `scripts/security-gate.ts` `checks` subcommand gates releases on those check-runs (`repos/$REPO/commits/$SHA/check-runs`, every name must be completed `success` for that SHA); `release.yml` collects them into `security-evidence/checks.ndjson` and fails non-zero before release.
- Ancestry gate (promotion only through a PR merged into main): `release.yml` "Verify tagged commit is on main (trusted gate)" runs trusted-main `scripts/security-gate.ts ancestry --sha "$SHA"` before any release; lesson: check `gh api compare` before release.
- Status: repo-internal note (`adapters/install.ts` SC1) records that a repository administrator marks the six `requiredChecks` names as required on `main` in branch protection — until then no check blocks a merge (BLOCKED external).

## 3. FSM inventory (phase loop)

| File | Role |
|---|---|
| `src/workflow/phase-loop.ts` | Pure FSM: gates, transitions, HTIL, audits, cleanup, checkpoint/restore |
| `src/workflow/phase-loop-store.ts` | Durable store: `PhaseLoopStore` interface, `fileStore`, quarantine, digest/CAS |
| `src/host/omp-phase.ts` | OMP host side: `recordGsdPhase`, `openHtilEntries`, `restoreSessionPhases`, pause/kill checkpoints |
| `src/ship/cli.ts` | Ship CLI: `confirmPhaseMerge` phase-record merge gate, `recordReviewAudit`, `cleanupPhaseRecord`, `stepResolve`/`stepRepairRuntime` |

Current SOTA features (all present in repo):

- **CAS (compare-and-swap)**: `PhaseLoopStore.digest` + `saveIfUnchanged` (`phase-loop-store.ts:59-66`); `commitStoreMutation` reloads and reapplies up to `CAS_ATTEMPTS = 3` on a lost race so a duplicate event is refused on the fresh row, never committed twice (`phase-loop.ts:530-600`).
- **Durable refused transitions**: `TransitionOptions.recordRefusals` + `TransitionRecord.refusals` codes (`phase-loop.ts:158-175,247-253`); accepted transitions always record when `at` is present, refused ones only when `recordRefusals` is true; bounded ring `MAX_TRANSITIONS = 50` with cumulative `transitionStats { attempts, accepted, refused }` counters (`phase-loop.ts:491-528`); `FsmError` kinds `rejection | guard | transient | unrecoverable` (`phase-loop.ts:178-204`).
- **HTIL SLA / escalation**: `HTIL_SLA_HOURS = { critical: 4, high: 24, normal: 72 }` (`phase-loop.ts:839`); `open`/`resolve` lifecycle LIFE-05 (`phase-loop.ts:847-956`); `escalateHtilEntry` to a new owner, refused once Ship-closed (`phase-loop.ts:964-996`); ship-side `resolve <phase>` closes `verification:<phase directory>` under the phase-record lock with owner-allowlist check (`ship/cli.ts:1275-1315`).
- **Cleanup authorization**: `CleanupAuthorization { actor, reason, allowedActors? }` with `actor === cleanedBy` match + optional allowlist + mandatory reason (`phase-loop.ts:1068-1173`); guard requires completed Ship-closed loop with recorded `closedBy`; terminal `cleaned-up` state rejects further phase events; ship `cleanupPhaseRecord` skips records without a close or already cleaned up (`ship/cli.ts:757-784`).

## 4. Decisions (q1/q2/q3)

- **q1 — scope: all outstanding** (no deferrals; every outstanding item stays in scope).
- **q2 — migration: allowed** (migration work is permitted where needed).
- **q3 — hardening: full hardening default** (ship the fully hardened option, not the minimal one).
