# Milestone audit: six-host plugin work

Audited at commit ab6fcf9 on branch plugin-core-slice (PR #89). Each criterion lists the verdict and the evidence it rests on. A criterion passes only when the evidence in the repo or the recorded CI run shows it.

Overall verdict: **not complete**. Four criteria fail and four are partial.

| AC | Criterion | Verdict | Evidence |
|---|---|---|---|
| AC1 | Omp passes golden fixtures with zero diff | **Pass** | `bun test/golden/omp/capture.ts --out <tmp>` then `diff -rq test/golden/omp/fixtures <tmp>`: zero diff across 16 files, re-run after each Omp change (environment, clock, sync filesystem, command routing). |
| AC2 | Core has no host SDK imports, enforced in CI | **Pass** | `tooling/boundary/check-core-boundary.ts` exits 0; CI step "Core dependency boundary" runs it on every push (ci.yml). |
| AC3 | Each of the five named hosts has an adapter with a documented contract (source and version) | **Partial** | Adapters exist for Hermes, Prime-Agent, Claude Code, Grok Build, and Muse (adapters/*/index.ts, 52 tests). Contracts with source and observed version are in docs/plugin-research/host-contracts.md. Minimum supported versions are "not documented" for every host. Wiring into the host entry points is not done. |
| AC4 | Every adapter passes the shared conformance suite; non-CI hosts have a recorded manual result | **Fail** | Conformance subjects exist for all six hosts and pass (91 tests), but they check declarations on disk, not live behavior. The manual runbook (docs/validation/manual-matrix.md) has no recorded results. |
| AC5 | Install, load, invoke, uninstall work in each host, with lifecycle states observable | **Fail** | Not run. Read-only validators pass for Claude Code, Grok, Muse, and Hermes; Prime-Agent has no validator. No host install, load, invoke, or uninstall was executed. |
| AC6 | Missing-capability fallbacks are tested for each flag that any adapter sets false | **Partial** | core/tests/contract tests every flag's fallback. No per-adapter test runs a flag-false case through a real adapter. |
| AC7 | Generated manifests match the source, and a drift test fails on divergence | **Partial** | `gen:manifests` and the CI "Manifest drift" step fail on any difference in plugin/generated. No test seeds a divergence to prove the failure path. Only five of six hosts are generated; Prime-Agent and Grok have no native manifest format to map to. |
| AC8 | Strict typecheck, lint, and format in CI for new and modified code; no skipped tests without a recorded decision | **Pass** | `bun run check` covers the new roots; CI runs biome with --error-on-warnings and `bun test`. No skipped tests. |
| AC9 | No credentials in logs, fixtures, manifests, or snapshots; CI secret scan | **Partial** | CI "Credential scan" step runs over new paths and is clean. The scanner's assignment rule only matches quoted values, so unquoted values in .env-style files are not covered. The provider-key patterns still apply. |
| AC10 | STATE.md and ROADMAP.md reflect completed phases; the audit records pass or fail | **Fail** | .planning/ROADMAP.md and STATE.md are not updated for this milestone, and .planning/ is gitignored, so they are not in the PR. This audit records the verdicts. |
| AC11 | Install and usage docs for all six hosts, with known limitations | **Pass** | docs/install/{omp,hermes,prime-agent,claude-code,grok-build,muse}.md each list requirements, install, verify, reload, uninstall, permissions, and known limitations. |

## Open decisions that affect the verdicts

- **Cursor** is a verified host in plugin/source and has a map and generated manifest, but it is not one of the six requested hosts (AC3 scope).
- **Prime-Agent and Grok Build** have no native manifest format, so they have no map and no generated manifest (AC7 scope).
- **Host wiring:** the adapters are not composed with a real runner or entry point in any host (AC3, AC5).
- **Live validation:** the manual runbook is in place, but no results are recorded (AC4, AC5).

## Not verified here

- Minimum supported host versions (not documented by any host).
- Hermes private import: hosts/hermes/bridge.py reads `_resolve_hook_callback_timeout` from hermes_cli.plugins. Hermes exposes no public equivalent (checked against v0.23.1).
