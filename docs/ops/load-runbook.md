<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 SWC Studio
-->

# Load runbook: planning pipeline under load

How to prove that the planning pipeline (uplift, Graph of Thought, node fills, clarifying questions, tracking, persistence) keeps delivering real plans, and says so honestly when it cannot, on a loaded machine. The proof is a deterministic, fault-injecting harness in `services/ultrathink/chaos/pipeline/`. It extends the chaos framework described in [section 18 of the service runbook](runbook-ultrathink.md#18-chaos-experiments); it does not repeat its gates, history format or exit codes, which apply here unchanged. For what a user sees when a stage falls back, read the [degradation ladder](../architecture.md#degradation-ladder) and [Troubleshooting: Planning degraded](../troubleshooting.md#planning-degraded).

Run every command from the repository root. The harness needs no credentials, no network and no model: it sends varied prompts through the real planning code against a scripted fake provider, so a run spends no tokens.

## What a run does

1. Optionally starts CPU pressure (`--pressure`).
2. Sends the scenario's prompts, `concurrency` at a time, through the real hook entry (`runPromptSubmit`). Each prompt carries a unique fixed-width nonce (`pl-<seed>-<6 digit index>`, for example `pl-12-000165`, so no nonce is a prefix of another and a field cap that clips one cannot turn it into another prompt's nonce) and gets its own temporary state directory. Each prompt is judged by the oracle as soon as it completes and then reduced to its verdict, so the run does not hold every record, spec and context until the end. A bounded share of the batch, a quarter of it and at most 10 prompts, goes through the real Omp native planner instead, on a fake runtime. The prompts vary: empty, whitespace, tiny, typical, near the 200 000-character `uplift.maxChars` limit, over it, a lone surrogate, markup, and text holding `$&`, `$$`, `` $` `` and `$'`.
3. Waits for the fault injector to go quiet, then sends one probe prompt, an ordinary one planned after the load with the faults off.
4. Checks the ten invariants below for every prompt, scores the run with the existing `scoreRun`, and appends one line to the history file.

The scripted provider answers each stage correctly (strict uplift XML, a 5 to 8 node graph, 5 to 8 step fills, clarification JSON) unless a fault rule says otherwise. The effects a rule can apply are `ok`, `delay` (followed by an `after` effect), `error` (a status and an optional `Retry-After`), `network`, `empty`, `truncate`, `garbage` and `hang` (resolves only on abort). All waits use an injected clock and abortable sleep, so a run is fast and does not depend on wall-clock timing. The seed is part of the scenario, so a run is repeatable.

## Commands

```bash
# list the five scenarios: id, title, prompts, concurrency
bun run chaos -- pipeline templates

# run one scenario with its recorded size and seed
bun run chaos -- pipeline run smoke
bun run chaos -- pipeline run nominal
bun run chaos -- pipeline run stress
bun run chaos -- pipeline run spike
bun run chaos -- pipeline run recovery

# resize, reseed, redirect the history, add CPU pressure
bun run chaos -- pipeline run smoke --prompts 20 --concurrency 4 --seed 7
bun run chaos -- pipeline run nominal --history /tmp/pipeline-history.jsonl
bun run chaos -- pipeline run smoke --pressure

# the mean, trend and latest score of a scenario from the history
bun run chaos -- pipeline score nominal
bun run chaos -- pipeline score nominal --history /tmp/pipeline-history.jsonl

# hold CPU pressure on its own, beside another job (see "Soak" for the repeated-window procedure)
bun run chaos -- pipeline pressure --workers 4 --seconds 300
```

The scenarios and the sizes they ship with:

| Scenario | Prompts | Concurrency | Seed | Faults |
|---|---|---|---|---|
| `smoke` | 50 | 5 | 11 | none; unit-test size |
| `nominal` | 500 | 25 | 12 | none |
| `stress` | 2 000 | 100 | 13 | every 4th prompt's fills fail 429 with `Retry-After: 2` (25 percent of prompts), and the first fill of every 5th prompt fails 503 |
| `spike` | 1 000 | 100 | 14 | every 3rd uplift is delayed 1.5 s and then fails 429 with `Retry-After: 1`; every 7th graph reply is garbage; then the probe prompt |
| `recovery` | 5 | 1 | 15 | none; a probe prompt after the load whose real-clock latency must be back within 1.25 times the `nominal` baseline plus 250 ms (`baselineOf: nominal`) |

Run `recovery` after a `nominal` run in the same history: it reads the latest recorded real probe latency (`details.probeRealMs`) of `nominal` from the history and compares against it. With no recorded `nominal` run there is no baseline and the latency comparison is not made. A `nominal` run recorded before the real-clock figure existed offers only its scripted-clock observation, which is then the baseline.

Flags of `pipeline run <id>`:

| Flag | Effect |
|---|---|
| `--prompts N` | Replaces the scenario's prompt count. |
| `--concurrency C` | Replaces its concurrency. |
| `--seed S` | Replaces its seed. A resized run is validated by the scenario parser, so a bad value names its field. |
| `--history PATH` | The history file. Default: `<ULTRATHINK_STATE_DIR>/chaos/history.jsonl`, or `/var/lib/ultrathink/chaos/history.jsonl` when `ULTRATHINK_STATE_DIR` is unset. `score` reads the same file. |
| `--pressure` | Runs CPU workers beside the load (see below). |
| `--watchdog-ms MS` | Replaces the per-prompt watchdog budget (1 000 to 3 600 000 ms, validated like the other resize flags). See "The watchdog" below. |
| `--trace-heap` | Prints `heap prompts=<n> heapUsed=<MiB> rss=<MiB>` after a forced full collection every 100 completed prompts, then `heap slope: <KiB/prompt> over <n> samples`. A slope above about 100 KiB per prompt means the code under test retains memory per prompt. |
| `--provider real` | Sends the prompts to the live engine instead of the scripted provider (see the real-provider section). |
| `--max-calls N` | With `--provider real` only: the most provider calls the run may make. Default 40. |

The output is one line, `<id> via pipeline: PASSED|FAILED, score <n>, …`, one `pass <invariant>` or `fail <invariant>` line per hypothesis, and `recorded seq <n> in <history path>`. Exit codes are the framework's: 0 when every hypothesis passed, 1 when one failed, 2 for a usage error or a refused gate.

## The ten invariants

Each invariant is checked for every prompt, and a failure names the prompt. They appear in this order in the output and in the history.

| Id | Holds when |
|---|---|
| `terminal` | The run has exactly the prompts the scenario asked for, and every one ended planned (with a session record) or skipped with a deterministic reason; none threw, and no provider call is still pending. A prompt aborted by the watchdog is a finding, not a pass: it is accepted only when an injected `hang` fault targeted that prompt (on any stage, also behind a `delay`) or the scenario sets `allowAborts`. The planned count must also reach the share the corpus asks for: the prompts that are not blank (the generated cycle skips 2 of every 16, its `empty` and `whitespace` kinds), minus the prompts an injected hang aborted. The observation breaks the statuses down, for example `2000/2000 terminal: 1750 planned, 250 skipped (by design), 0 aborted`; the history record's `details` hold the per-reason skip counts (`skipped:empty`), the watchdog budget and the abort count. The reasons are the hook's `empty`, `trivial`, `command`, `already-uplifted`, `graph-reference`, `skip-once`, `disabled`, `extension` and `steer`, the Omp and Hermes `precheck-<reason>` codes (`precheck-trivial`, `precheck-command`, `precheck-already-uplifted`, `precheck-graph-reference`, `precheck-skip-once`, `precheck-disabled`, `precheck-empty`, `precheck-extension`, `precheck-steer` and `precheck-passthrough`), and `max-calls`. |
| `original` | The user's text is preserved byte for byte in the spec. |
| `uplift` | A malformed uplift is never counted as a success: a `source: "llm"` result is a complete uplift with a known root and no fallback reason, and a fallback has a reason and is listed as a degraded `uplift`. |
| `degraded` | Every stage that fell back is listed in the record's `degraded` and shown in the plan notice, and a reply that was not a successful call is never accepted as a real fill. |
| `cot` | Every real fill carries 5 to 8 steps and a conclusion. |
| `isolation` | No other prompt's nonce appears in a prompt's record, spec, context, tracker rows or completer payloads. A token that is only a clipped start of the prompt's own nonce is not a leak. |
| `resources` | After the run's own report has been reduced to verdicts and the heap fully collected, the JS heap is within 64 MiB plus 64 KiB per prompt of the baseline taken before the run (the base is the scenario's optional `resourceSlackMiB`), and handles, child processes and leftover state files and locks are back to the baseline. The resident set size is printed with it but does not decide the verdict: it includes memory the allocator has not returned. |
| `recovery` | The probe prompt, sent after the load with the faults off, plans from the model with nothing degraded; with a baseline, its latency on the real clock is no more than 1.25 times the baseline's real probe latency plus 250 ms. The scripted provider's clock only moves when a wait is injected, so it reads 0 for a fault-free probe and is printed only as information. The observation reads `probe latency real <ms> baseline <ms or none> ratio <r or n/a> (virtual <ms>)`, and the history record's `details` hold `probeRealMs` and `probeVirtualMs`. |
| `persisted` | Every persisted state file parses. |
| `calls` | The provider calls per prompt stay inside the retry budget: one attempt plus the fill retries plus the single repair attempt per node, times three on the Omp path, and one per uplift or graph call and two per clarify call. |

## Pass criteria

A scenario passes when the command exits 0: all ten invariants pass, the score is 100, and, with `--pressure`, the `pressure` hypothesis passes as well. Any failing invariant is a regression to fix; do not rerun until it goes away. Faults make prompts degrade by design (the `stress` and `spike` fixtures inject them), so a degraded prompt is not a failure. A degraded stage that is not listed and shown is: that is the `degraded` invariant.

## The watchdog

Every prompt runs under a real-time watchdog that aborts it when it has not finished within the budget: it is the hang detector, so it measures real time on purpose and is never swallowed. The budget is the scenario's `watchdogMs` when set, else the larger of 120 s and 4 s per concurrent slot (so `concurrency` 100 gets 400 s), and `--watchdog-ms` replaces either. A run prints `watchdog budget <ms> ms, aborts <n>` before its verdict, and records both in the history `details`. The driver yields a timer turn after every prompt: the hook path is microtasks and synchronous file work, and without that turn a wide batch starved every timer (Bun also runs chained `setImmediate` callbacks ahead of due timers, so the turn is a `setTimeout`), which aborted Omp-path prompts that were only waiting for the loop. A prompt that the watchdog aborts without an injected `hang` targeting it fails the `terminal` invariant; on a host so loaded that prompts really exceed the budget, rerun with a larger `--watchdog-ms` to tell starvation from a hang, and do not loosen the invariant.

## CPU pressure

`--pressure` starts Bun Workers that spin in 10 ms duty-cycle slices (no new dependency), an optional memory ballast and an event-loop stall sampler. Unless the scenario names its own pressure, it uses every CPU at full duty and stops itself after 15 minutes at most. When the run ends it reports the CPU it actually achieved: process CPU time divided by wall time since the helper started.

The run fails with `pressure-not-applied: achieved CPU ratio <r> is below the floor 0.5` when the achieved ratio is under the floor. That figure is the host's, not the harness's: on a machine that is already loaded (a load average well above the CPU count, other agents building or testing) the workers get less than their share, and the helper cannot make the host deliver more. It means the pressure the run asked for was not applied, not that the pipeline failed. Rerun when the host is calmer, or run without `--pressure`: the gate scenarios are deterministic without it, and pressure runs are advisory but recorded. `pipeline run` takes no worker count or floor; to try other values, hold pressure with `pipeline pressure --workers N --floor R` and run the scenario in another shell.

`pipeline pressure --workers N --seconds S [--memory-mb M] [--floor R]` holds full-duty pressure for `S` seconds (at most 3600) so another job can run beside it, then prints `pressure held Ns: cpuMs … wallMs … ratio …`. It exits 0 when the ratio met the floor (default 0.5), and 2 with `pressure not applied` on stderr when it did not. The ratio is CPU seconds per wall second, so a value above 1 means more than one core's worth of pressure; the workers stop when the window ends, so a job that outlasts the window runs unpressured for the rest of its time (see "Soak").

## Running against a real provider

`--provider real` runs the same driver against the engine that `selectEngine` resolves for the Claude Code host (a CLI has no Omp runtime), through the same counters, fault wrapper and call cap. It exists to confirm the harness's picture against a real model, not for load.

It is double-gated, and each gate refuses before any engine is called:

1. The flag `--provider real`, and
2. `ULTRATHINK_CHAOS_REAL=1` in the environment of the CLI process (exactly `1`).

It also refuses the `stress` and `spike` scenarios, whose size would spend credentials at load, stops at `--max-calls` (default 40), and prints `calls made: N (cap M, reached)` at the end. A run that reaches the cap cannot send its probe, so its `recovery` invariant is not judged.

```bash
ULTRATHINK_CHAOS_REAL=1 bun run chaos -- pipeline run smoke --provider real --max-calls 40
```

Warning: this uses your real credentials (the `claude` plan login, or whatever the selected engine resolves) and spends real tokens against your plan's usage limit, up to the cap. Run it by hand, on a machine you own, never in CI and never from a script that loops. The text a real engine returns carries no nonce, so the nonce-presence check is skipped on this path.

## Unregistered variables

Two variables are intentionally not in the environment registry, so `docs/environment.md` does not list them. This runbook is their documentation.

| Variable | Scope | Effect |
|---|---|---|
| `ULTRATHINK_CHAOS_REAL` | The chaos CLI | `1` is the second gate of `--provider real`. Anything else leaves the real provider refused. |
| `ULTRATHINK_TEST_TIMEOUT_SCALE` | Test setup (`src/test.setup.ts`, loaded by `bunfig.toml`) | A number above 0 that multiplies the 30 s default per-test timeout. Without it the factor is the one-minute load average divided by the CPU count, at least 1. It sets timeouts only. Bun 1.4.0 applies a preload's default timeout to the first test file of a run only, so suites that spawn children carry explicit budgets of their own. |

## Recorded results

Recorded on commit `e3097be` on a shared 8-CPU host (one-minute load average 28.93 when the first run started), with `--history` pointing at `.planning/phases/100-load-proof-and-closeout/load-history.jsonl` (six records, seq 1 to 6). Each row is transcribed from the run log `load-run.log` next to it and from that history file; the score and mean are read back with `pipeline score <id> --history <that file>`. Every run exited 0, printed `PASSED, score 100` and `pass` for all ten invariants (the `--pressure` run also printed `pass pressure`). The `Planned` column is how many of the prompts the oracle counted as planned (the `original`, `uplift`, `degraded` and `cot` invariants are checked over those, for example 436/436 in `nominal`); the others ended skipped or aborted with a status the `terminal` invariant accepts (all 500 of 500 were terminal), which is what the deterministic skip rules do to the varied prompt corpus.

| Scenario | Prompts | Concurrency | Faults | Score | Planned | Probe outcome | Wall | Max RSS | History |
|---|---|---|---|---|---|---|---|---|---|
| `smoke` | 50 | 5 | none | 100 | 42 | passed | 13.28 s | 147 532 KB | seq 1 |
| `nominal` | 500 | 25 | none | 100 | 436 | passed | 109.92 s | 183 764 KB | seq 2 |
| `recovery` | 5 | 1 | none (probe batch after `nominal`) | 100 | 3 | passed | 1.33 s | 82 848 KB | seq 3 |
| `stress` | 2 000 | 100 | 429 on every 4th prompt's fills, 503 on every 5th prompt's first fill | 100 | 1 750 | passed | 267.82 s | 301 216 KB | seq 4 |
| `spike` | 1 000 | 100 | slow then 429 on every 3rd uplift, garbage on every 7th graph | 100 | 874 | passed | 108.31 s | 225 908 KB | seq 5 |
| `nominal --pressure` | 500 | 25 | none, with full-duty pressure on every CPU (the scenario names none, so the helper uses all of them) | 100 | 436 | passed | 117.18 s | 214 500 KB | seq 6 |

The probe outcome is the `recovery` invariant: the probe prompt planned from the model with nothing degraded. Its recorded observation is `0` in every run: the harness measures it on its virtual clock, so there was no latency to compare with the 1.25 times baseline, and the invariant rests on the probe's outcome alone. Per-run figures the oracle recorded:

| Run | `terminal` | `isolation` | `resources` (after the run, against the baseline before it) | `calls` |
|---|---|---|---|---|
| `smoke` | 50/50 | 42 prompts, 0 leaks | heap +4 MiB, rss +93 MiB, handles +0, files 0, peak in flight 5 | 51/51 within budget |
| `nominal` | 500/500 | 436 prompts, 0 leaks | heap +7 MiB, rss +117 MiB, handles +0, files 0, peak in flight 20 | 501/501 |
| `recovery` | 5/5 | 3 prompts, 0 leaks | heap +5 MiB, rss +32 MiB, handles +0, files 0, peak in flight 1 | 6/6 |
| `stress` | 2000/2000 | 1750 prompts, 0 leaks | heap +17 MiB, rss +166 MiB, handles +0, files 0, peak in flight 81 | 2001/2001 |
| `spike` | 1000/1000 | 874 prompts, 0 leaks | heap +9 MiB, rss +126 MiB, handles +0, files 0, peak in flight 97 | 1001/1001 |
| `nominal --pressure` | 500/500 | 436 prompts, 0 leaks | heap +6 MiB, rss +116 MiB, handles +0, files 0, peak in flight 20 | 501/501 |

Pressure applied during the `nominal --pressure` run (seq 6): the `pressure` hypothesis passed with an achieved CPU ratio of 4.785 against the floor of 0.5. `pipeline score` after the six runs: `smoke`, `recovery`, `stress` and `spike` have one run each, mean 100, latest 100; `nominal` has two runs (seq 2 and 6), mean 100, trend slope 0, latest 100.

## Soak: the load-flaky test files under pressure

The soak proves that the test files that used to fail only on a loaded host (`atomic`, `audit-segments`, `audit-verify`, `session mark`, the doctor commands, `pstack-check`, `engine-label-safety`) pass repeatedly while the host is under CPU pressure. `audit-watch.test.ts` is hardened by the same seam and is proved in focused runs, not in the loop.

The procedure is one script that holds the pressure helper in repeated 300 s windows in the background while twenty iterations of the seven files run in the foreground, and stops on the first failing iteration. The helper's window must be at least as long as one loop iteration; otherwise the tail of an iteration runs unpressured and the soak proves less than it claims. An iteration took 105 to 170 s here, so 300 s covers it. Run it from the repository root:

```bash
FILES="src/claude/atomic.test.ts services/ultrathink/obs/audit-segments.test.ts services/ultrathink/obs/audit-verify.test.ts src/mcp/cli.test.ts src/uplift/commands.test.ts src/doctor/pstack-check.test.ts src/host/engine-label-safety.test.ts"
LOG=/tmp/soak-20.log
DONE=/tmp/soak20.done
rm -f "$DONE" "$LOG"
(
  while [ ! -f "$DONE" ]; do
    echo "pressure window $(date -u +%T)" >> "$LOG"
    bun run chaos -- pipeline pressure --workers 4 --seconds 300 >> "$LOG" 2>&1
    echo "pressure window exit=$?" >> "$LOG"
  done
) &
PRESSURE=$!
pass=0
for i in $(seq 1 20); do
  start=$(date +%s)
  if bun test --timeout 240000 $FILES > "/tmp/soak-run-$i.out" 2>&1; then
    pass=$((pass + 1))
    echo "run $i PASS $(( $(date +%s) - start )) s load $(cut -d' ' -f1 /proc/loadavg)" >> "$LOG"
  else
    echo "run $i FAIL $(( $(date +%s) - start )) s load $(cut -d' ' -f1 /proc/loadavg)" >> "$LOG"
    grep -E '^\(fail\)|^ *[0-9]+ (pass|fail)|error:' "/tmp/soak-run-$i.out" | head -20 >> "$LOG"
    break
  fi
done
touch "$DONE"
echo "soak runs passed: $pass of 20" >> "$LOG"
wait "$PRESSURE" 2>/dev/null
```

Every window's last lines must read `pressure held 300s: … ratio <r>` with `pressure window exit=0`; an exit 2 (`pressure not applied`) means the host delivered less than the floor and that window proves nothing. The soak passes when the log ends with `soak runs passed: 20 of 20`. Do not run the loop while another heavy job (a full `bun test`, a build) holds the host, so that a failure is attributable to the files.

Recorded result: soak started 2026-10-29T08:47:46Z on commit `e3097be`, 8 CPUs, one-minute load average 34.99 at the start, ended 09:31:48Z with `soak runs passed: 20 of 20`. Each run executed the same 273 tests: 273 pass, 0 fail, in all 20. The load column is the one-minute load average read when that run ended.

| Run | Result | Time | Load | Tests |
|---|---|---|---|---|
| 1 | PASS | 124 s | 9.00 | 273 pass, 0 fail |
| 2 | PASS | 132 s | 8.92 | 273 pass, 0 fail |
| 3 | PASS | 111 s | 25.46 | 273 pass, 0 fail |
| 4 | PASS | 118 s | 31.87 | 273 pass, 0 fail |
| 5 | PASS | 117 s | 11.18 | 273 pass, 0 fail |
| 6 | PASS | 131 s | 11.65 | 273 pass, 0 fail |
| 7 | PASS | 142 s | 29.07 | 273 pass, 0 fail |
| 8 | PASS | 134 s | 24.42 | 273 pass, 0 fail |
| 9 | PASS | 149 s | 8.85 | 273 pass, 0 fail |
| 10 | PASS | 170 s | 19.92 | 273 pass, 0 fail |
| 11 | PASS | 159 s | 51.85 | 273 pass, 0 fail |
| 12 | PASS | 138 s | 11.24 | 273 pass, 0 fail |
| 13 | PASS | 122 s | 5.84 | 273 pass, 0 fail |
| 14 | PASS | 124 s | 22.73 | 273 pass, 0 fail |
| 15 | PASS | 105 s | 21.04 | 273 pass, 0 fail |
| 16 | PASS | 151 s | 17.05 | 273 pass, 0 fail |
| 17 | PASS | 146 s | 19.28 | 273 pass, 0 fail |
| 18 | PASS | 129 s | 46.02 | 273 pass, 0 fail |
| 19 | PASS | 122 s | 33.06 | 273 pass, 0 fail |
| 20 | PASS | 116 s | 10.73 | 273 pass, 0 fail |

Pressure delivered, as the helper measured it (nine 300 s windows, 4 workers on 8 CPUs, floor 0.5; every window exited 0):

| Window start (UTC) | cpuMs | wallMs | Ratio |
|---|---|---|---|
| 08:47:46 | 778 552 | 300 011 | 2.5951 |
| 08:52:47 | 805 781 | 300 011 | 2.6858 |
| 08:57:48 | 670 569 | 300 002 | 2.2352 |
| 09:02:48 | 650 878 | 300 077 | 2.1690 |
| 09:07:49 | 572 158 | 300 385 | 1.9047 |
| 09:12:50 | 712 774 | 300 002 | 2.3759 |
| 09:17:52 | 769 537 | 300 004 | 2.5651 |
| 09:22:53 | 738 589 | 300 010 | 2.4619 |
| 09:27:54 | 832 657 | 300 071 | 2.7749 |

## Closeout record (v1.21)

What the gates produced, transcribed from the orchestrator's runs. A value that has not been produced is `pending` with the command that produces it; nothing is estimated.

### GATE-01: static gates and tests

Run by the orchestrator on the milestone code before the last documentation commit (commit `e3097be` for the load runs):

| Gate | Command | Result |
|---|---|---|
| Types | `bun run check` | exit 0 |
| Service types | `bun run check:services` | exit 0 |
| Lint | `bun run lint` | exit 0, 0 errors; 64 infos, which already exist on `origin/main` |
| Dead code | `bun run deadcode` | exit 0 |
| Environment docs | `bun scripts/render-env-docs.ts --check` | current |
| Hermes bridge | `python3 hosts/hermes/bridge_test.py` | OK |
| Prime Agent bridge | `python3 hosts/prime-agent/bridge_test.py` | 17 tests OK |
| Full local suite, pre-integration tree | `bun test` | 8 048 pass, 12 skip, 0 fail, 1 237 s |
| Full local suite, final tree | `bun test` | 8 092 pass, 12 skip, 2 fail |
| Pull request CI | the CI checks on the pull request | pending: PR CI |

The two failures on the final tree are known load-sensitive tests, not passes. Neither is touched by this milestone; each passed 3 of 3 times when run alone, and each failed only while the host's load average was above 30: `plugins/omp-token-opt/src/remote-sink.test.ts` (`close returns within about timeoutMs`) and `services/ultrathink/mcp/conformance.test.ts` (`a line over 1 MiB is refused …`). The full suite is not a local gate on this host; CI on the pull request is, and it has not run yet.

### GATE-02: load and soak

The five scenarios at full size, the `nominal --pressure` run and the 20-run soak are recorded in "Recorded results" and "Soak" above: every scenario scored 100 with all ten invariants passing, and 20 of 20 soak runs passed under measured pressure (ratio 1.9047 to 2.7749).

### GATE-03: milestone audit

pending. The audit must list the unverified claims, the deferred findings and the owner decisions, from the milestone audit run (`/gsd:audit-milestone`). What it has to carry from the findings file:

- Owner policies kept: no default planning deadline on Omp (the 25 s race is delivery-only), one model per flight, every stage fails open; a retry never changes model, route or effort.
- Deferred by decision, not built: a machine-wide model-call gate across processes (L12-08); default per-call deadlines for the Claude, Grok and Muse CLI routes (L5-02) and for the hosted service (L9-01 keeps 0, with a warning); retention on by default (L8-12); the Hermes plan-deadline redesign (L7-07 c); every LOW finding.
- Suspected and unproven: L5-09, L8-13, L4-06. Performance, not load-critical: L9-09, L9-10, L12-09, L12-13.
- Known gap: a journal or job that records no principal is visible only to an owner-class caller and to a stdio host. The client tools addressed by an explicit session id (`ultrathink_result`, `ultrathink_answer`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_status`) do not check the principal: the session UUID is the only protection there.

### GATE-04: review, merge and sync

pending. Greptile 5 of 5 on the exact head with no open threads, CI green, merge, then the live checkout synced to `main` and STATE written, all through `ultrathink-ship`.
