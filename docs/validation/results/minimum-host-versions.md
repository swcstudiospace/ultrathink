# Minimum host versions (AC3)

Date: 2026-11-13. Checkout: `611e926` (origin/main, the version-floor commit #91).

## Summary

- No host documents a minimum supported version. Five contracts say "not documented" (`docs/plugin-research/host-contracts.md:89` Omp, `:115` Hermes, `:138` Prime-Agent, `:194` Grok Build, `:226` Muse). The Claude Code contract gives feature minimums only, with no base version (`:163`).
- The floors in `adapters/version-floor.ts:13-18` are the versions observed while writing those contracts (`host-contracts.md:65`). They are not tested minimums.
- No host has a validated lower bound. No live run exercised any version below its floor, so no floor is proven to be the lowest working version.
- Live status is per host below. Muse's floor has no live run at all. Prime-Agent's lifecycle was never exercised.

Status terms:

- **Verified at floor**: a live run on exactly the floor version passed its install, load, and invoke steps.
- **Partially verified at floor**: a live run on the floor version passed some steps; the rest failed or were blocked.
- **Unverified at floor**: no live run on the floor version.

## Per-host table

| Host | Floor | Floor source | Version read live | Live run on floor | Live outcome | Status |
|---|---|---|---|---|---|---|
| omp | 18.19.0 | `adapters/version-floor.ts:18` | `omp/18.19.0` | Yes | Pass: interactive steps 1-10 (install through uninstall). Headless steps 6 and 7 not reachable. | Partially verified at floor. Minimum not verified. |
| claude-code | 2.1.322 | `adapters/version-floor.ts:13` | `2.1.322` | Yes | Install, load, uninstall pass. First invoke blocked by login and API credit. Invoke passed only after a rerun with a copied login: reply `ok`, graph not degraded. | Partially verified at floor. The file's top-line verdict is Fail, from the first invoke. |
| grok-build | 1.0.77 | `adapters/version-floor.ts:14` | `1.0.77` | Yes | Install, inventory, disable/enable, uninstall pass. Load not run (interactive only). Invoke: hook ran (`success`), but the headless run refused a tool approval; no answer produced. | Partially verified at floor. |
| hermes | v0.23.1 | `adapters/version-floor.ts:16` | `v0.23.1` | Yes | Install (symlink), validate, enable, `/ultrathink-lessons` pass. `plugins remove` exits 1 for a symlinked install. | Partially verified at floor. |
| muse | 1.4.14 | `adapters/version-floor.ts:15` | `1.4.18` | No | Live runs were on 1.4.18, above the floor. The floor 1.4.14 is the earlier runbook observation. Install without the experimental gate exited non-zero on 3 of 3 attempts; a later retry in a fresh home exited 0 without it. | Unverified at floor. |
| prime-agent | 0.10.2 | `adapters/version-floor.ts:17` | `0.10.2` (`prime-agent -v`) | Version only | Step 1 (list) only. Blocked at step 2; no install performed. | Version observed live. Lifecycle unverified. |

## Evidence per host

### omp (floor 18.19.0)

- Floor: `adapters/version-floor.ts:18`. Contract: `host-contracts.md:89` (minimum not documented; dev pin `@oh-my-pi/pi-ai ^18.14.0` is not a host minimum).
- Live version: `docs/validation/results/omp.md:34-39` (`omp --version` → `omp/18.19.0`). `docs/install/omp.md:5` records the same.
- Live result: `omp.md` header `Pass`; Run 1 covers steps 1-10. A banner advertised 18.20.0 and was not acted on (`omp.md:398`).
- Runtime wiring: `adapters/cli.ts` HOSTS has no `omp` entry, and `src/host/omp.ts` builds the command port without `observedVersion`. The Omp floor is **not enforced** at `611e926`. A fail-closed floor was attempted on PR #93 and dropped by decision; it is not on main.

### claude-code (floor 2.1.322)

- Floor: `adapters/version-floor.ts:13`. Contract: `host-contracts.md:163` (feature minimums only, no base version). Adapter recorded constant: `adapters/claude-code/index.ts:72`.
- Runtime read: `adapters/cli.ts` HOSTS, `versionCommand: "claude"`, runs `claude --version`.
- Live version: `docs/validation/results/claude-code.md:3,5` (`2.1.322 (Claude Code)`).
- Live result: header `Fail` at line 7 (step 6 invoke blocked by login and credit). The rerun with a copied login (lines 128-152) reached the planner, which returned a degraded graph stage. The live recheck at lines 154-185 returned reply `ok`, `subtype: success`, graph not degraded.
- Side effect seen in that rerun (not an AC3 matter): the tracking stage created Linear issues in team `Spectrum Web Co`. The result file records it; all 56 (SPE-31017 through SPE-31072) were then set to Canceled.

### grok-build (floor 1.0.77)

- Floor: `adapters/version-floor.ts:14`. Contract: `host-contracts.md:194`. Adapter recorded constant: `adapters/grok-build/index.ts:41`.
- Runtime read: `adapters/cli.ts` HOSTS, `versionCommand: "grok"`.
- Live version: `docs/validation/results/grok-build.md:5` (`grok 1.0.77 (50ca579fa996) [stable]`).
- Live result: header `Fail (incomplete)` at line 7. Invoke rerun section (later in the file) shows the `user_prompt_submit` hook ran with status `success`; the follow-up plan-read bash call needed approval, and `grok -p` cannot grant it, so no answer was produced.
- Trust state was set by `--trust` and is not observable from the host (`grok-build.md`, "Trust decision").

### hermes (floor v0.23.1)

- Floor: `adapters/version-floor.ts:16`. Contract: `host-contracts.md:115`. Adapter recorded constant: `adapters/hermes/index.ts:61`.
- Runtime read: `adapters/cli.ts` HOSTS, `versionCommand: "hermes"`. The `v` prefix is ignored by the parser.
- Live version: `docs/validation/results/hermes.md:5` (`Hermes Agent v0.23.1 (2026.9.24)`).
- Live result: header `FAIL` at line 8. Step 10 (`hermes plugins remove ultrathink`) exits 1 for the symlinked install (`hermes.md:147-152`). Runbook step 11 removed the link by hand.

### muse (floor 1.4.14)

- Floor: `adapters/version-floor.ts:15`. Contract: `host-contracts.md:226` (minimum not documented; "plugins work from 1.3.0" is an unverified community claim). Adapter recorded constant: `adapters/muse/index.ts:40`.
- Runtime read: `adapters/cli.ts` HOSTS, `versionCommand: "muse"`.
- Live version: `docs/validation/results/muse.md:6` (`Muse Code 1.4.18 (1.4.18-R8587.1)`; "Runbook observed 1.4.14; not matched"). `docs/install/muse.md:5` also records 1.4.18 as the verified version.
- Live result: FAIL. Install without the experimental gate exited 1 on 3 of 3 attempts. The gated install succeeded on the second attempt. A later retry in a fresh home with no concurrent writers exited 0 without the gate. The hook fires after approval (correction recorded in `muse.md`).
- No live run used 1.4.14. The floor therefore has no live evidence.

### prime-agent (floor 0.10.2)

- Floor: `adapters/version-floor.ts:17`. Contract: `host-contracts.md:138` (current public repo is Rust). Adapter recorded constant: `adapters/prime-agent/index.ts:57`.
- Runtime read: `adapters/cli.ts` HOSTS, `versionCommand: "prime-agent"`, which runs `prime-agent --version`. The live run read the version with `-v`; `--version` was not observed on this host.
- Live version: `docs/validation/results/prime-agent.md:5` (`prime-agent -v` → `0.10.2`).
- Live result: `Fail (blocked at step 2: install source syntax UNVERIFIED; no install performed)` (`prime-agent.md:8`). Only step 1 (`package list`, `No packages installed.`) ran.

## Gaps

1. No host has a tested lower bound. Any "minimum" statement needs a run below the floor.
2. Muse: no live run on the 1.4.14 floor. The 1.4.18 runs are above it.
3. Prime-Agent: the install, load, and invoke lifecycle is unverified. `docs/validation/results/prime-agent.md` says no install was performed. `milestone-audit.md` AC5 is Partial for this reason; the earlier unrecorded `/ultrathink-status` check is not evidence.
4. Prime-Agent: `prime-agent --version` (the form the CLI calls) is not recorded live; the run used `-v`.
5. Hermes: a symlinked install cannot be removed with `hermes plugins remove` (step 10 FAIL).
6. Omp: the floor is not enforced in production at `611e926` (see omp evidence).

AC3 status: **Partial**. Floors are recorded and each host's live status is stated above. No host has a validated minimum version.
