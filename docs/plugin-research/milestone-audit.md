# Milestone audit: six-host plugin work

Audited at commit 5f76f14 on branch plugin-core-slice (PR #89). This supersedes the audit written at ab6fcf9. Each criterion lists the verdict and the evidence it rests on. A criterion passes only when the evidence in the repo or a recorded CI run shows it.

Overall verdict: **not complete**. AC4 and AC5 fail until the manual runbook results are recorded.

| AC | Criterion | Verdict | Evidence |
|---|---|---|---|
| AC1 | Omp passes golden fixtures with zero diff | **Pass** | `bun test/golden/omp/capture.ts --out <tmp>` then `diff -rq test/golden/omp/fixtures <tmp>` shows zero diff across 16 files, re-run after each Omp change. |
| AC2 | Core has no host SDK imports, enforced in CI | **Pass** | `tooling/boundary/check-core-boundary.ts` exits 0; CI step "Core dependency boundary" runs it. |
| AC3 | Each of the five named hosts has an adapter with a documented contract (source and version) | **Partial** | Adapters for all five exist (adapters/*/index.ts, tests pass). Contracts with source and observed version are in docs/plugin-research/host-contracts.md. Minimum supported versions are "not documented" for every host. Wiring: Claude Code and Grok (command files), Prime-Agent (ctl), and Hermes (control) call the adapter CLI. Muse's command files do too; its planning hook stays on the engine by design (accepted). |
| AC4 | Every adapter passes the shared conformance suite; non-CI hosts have a recorded manual result | **Fail** | Conformance subjects pass (suite green) but check declarations on disk, not live behavior. Live results are recorded for all six hosts in `docs/validation/results/`: Omp passes; Claude Code and Grok Build are partial (hook fires, no final answer); Hermes and Muse fail; Prime-Agent is blocked on the undocumented install source form. |
| AC5 | Install, load, invoke, uninstall work in each host, with lifecycle states observable | **Fail** | Omp passes end to end. Claude Code, Grok Build: install and uninstall pass, invoke partial. Hermes: symlink removal refused by the CLI. Muse: install and approve pass, no prompt-hook event observable. Prime-Agent: not installed (source form). |
| AC6 | Missing-capability fallbacks are tested for each flag that any adapter sets false | **Partial** | docs/plugin-research and core/tests/contract test every flag's fallback. No adapter-level test runs a flag-false case end to end. |
| AC7 | Generated manifests match the source, and a drift test fails on divergence | **Partial** | `gen:manifests` and the CI "Manifest drift" step fail on any difference in plugin/generated. No test seeds a divergence. Five hosts are generated; Prime-Agent and Grok are unmapped by design (no native manifest format). |
| AC8 | Strict typecheck, lint, and format in CI for new and modified code; no skipped tests without a recorded decision | **Pass** | `bun run check` covers the new roots; CI runs biome with --error-on-warnings and `bun test`. |
| AC9 | No credentials in logs, fixtures, manifests, or snapshots; CI secret scan | **Partial** | CI "Credential scan" step is clean. The scanner's assignment rule matches only quoted values, so unquoted .env-style values are not covered. |
| AC10 | STATE.md and ROADMAP.md reflect completed phases; the audit records pass or fail | **Fail** | .planning/ROADMAP.md and STATE.md are not updated for this milestone, and .planning/ is gitignored, so they are not in the PR. This audit records the verdicts. |
| AC11 | Install and usage docs for all six hosts, with known limitations | **Pass** | docs/install/{omp,hermes,prime-agent,claude-code,grok-build,muse}.md each list requirements, install, verify, reload, uninstall, permissions, and known limitations. |

## Changes since ab6fcf9

- Cursor removed from the six-host set.
- Adapter CLI `bin/ultrathink-adapter` added: pass-through arguments and `--raw`. Raw output is the full child stdout; the 4096-character cap applies only to the JSON envelope.
- Hermes, Prime-Agent, and Claude Code command surfaces route through the CLI. Hermes errors now read "command failed" (accepted).
- Prime-Agent runs with ULTRATHINK_HOST=prime-agent; its state directory was checked read-only.

## Open decisions and limits

- Live validation (AC4, AC5): recorded in `docs/validation/results/`. Remaining: Prime-Agent source form, Hermes removal of symlinked plugins, Muse hook observability, Claude and Grok full invoke answers.
- Prime-Agent and Grok Build: unmapped by design.
- Minimum supported host versions: not documented by any host.
- Hermes private import: hosts/hermes/bridge.py reads `_resolve_hook_callback_timeout` from hermes_cli.plugins. No public equivalent exists in v0.23.1.
