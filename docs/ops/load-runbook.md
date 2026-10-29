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

# hold CPU pressure on its own, beside another job
bun run chaos -- pipeline pressure --workers 4 --seconds 1800
```

The scenarios and the sizes they ship with:

| Scenario | Prompts | Concurrency | Seed | Faults |
|---|---|---|---|---|
| `smoke` | 50 | 5 | 11 | none; unit-test size |
| `nominal` | 500 | 25 | 12 | none |
| `stress` | 2 000 | 100 | 13 | every 4th prompt's fills fail 429 with `Retry-After: 2` (25 percent of prompts), and the first fill of every 5th prompt fails 503 |
| `spike` | 1 000 | 100 | 14 | every 3rd uplift is delayed 1.5 s and then fails 429 with `Retry-After: 1`; every 7th graph reply is garbage; then the probe prompt |
| `recovery` | 5 | 1 | 15 | none; a probe batch after the load whose latency must be back within 1.25 times the `nominal` baseline (`baselineOf: nominal`) |

Run `recovery` after a `nominal` run in the same history: it reads the latest recorded probe time of `nominal` from the history and compares against it. With no recorded `nominal` run there is no baseline and the latency comparison is not made.

Flags of `pipeline run <id>`:

| Flag | Effect |
|---|---|
| `--prompts N` | Replaces the scenario's prompt count. |
| `--concurrency C` | Replaces its concurrency. |
| `--seed S` | Replaces its seed. A resized run is validated by the scenario parser, so a bad value names its field. |
| `--history PATH` | The history file. Default: `<ULTRATHINK_STATE_DIR>/chaos/history.jsonl`, or `/var/lib/ultrathink/chaos/history.jsonl` when `ULTRATHINK_STATE_DIR` is unset. `score` reads the same file. |
| `--pressure` | Runs CPU workers beside the load (see below). |
| `--trace-heap` | Prints `heap prompts=<n> heapUsed=<MiB> rss=<MiB>` after a forced full collection every 100 completed prompts, then `heap slope: <KiB/prompt> over <n> samples`. A slope above about 100 KiB per prompt means the code under test retains memory per prompt. |
| `--provider real` | Sends the prompts to the live engine instead of the scripted provider (see the real-provider section). |
| `--max-calls N` | With `--provider real` only: the most provider calls the run may make. Default 40. |

The output is one line, `<id> via pipeline: PASSED|FAILED, score <n>, …`, one `pass <invariant>` or `fail <invariant>` line per hypothesis, and `recorded seq <n> in <history path>`. Exit codes are the framework's: 0 when every hypothesis passed, 1 when one failed, 2 for a usage error or a refused gate.

## The ten invariants

Each invariant is checked for every prompt, and a failure names the prompt. They appear in this order in the output and in the history.

| Id | Holds when |
|---|---|
| `terminal` | The run has exactly the prompts the scenario asked for, and every one ended planned (with a session record), aborted, or skipped with a deterministic reason; none threw, and no provider call is still pending. The reasons are the hook's `empty`, `trivial`, `command`, `already-uplifted`, `graph-reference`, `skip-once`, `disabled`, `extension` and `steer`, the Omp and Hermes `precheck-<reason>` codes (`precheck-trivial`, `precheck-command`, `precheck-already-uplifted`, `precheck-graph-reference`, `precheck-skip-once`, `precheck-disabled`, `precheck-empty`, `precheck-extension`, `precheck-steer` and `precheck-passthrough`), and `max-calls`. |
| `original` | The user's text is preserved byte for byte in the spec. |
| `uplift` | A malformed uplift is never counted as a success: a `source: "llm"` result is a complete uplift with a known root and no fallback reason, and a fallback has a reason and is listed as a degraded `uplift`. |
| `degraded` | Every stage that fell back is listed in the record's `degraded` and shown in the plan notice, and a reply that was not a successful call is never accepted as a real fill. |
| `cot` | Every real fill carries 5 to 8 steps and a conclusion. |
| `isolation` | No other prompt's nonce appears in a prompt's record, spec, context, tracker rows or completer payloads. A token that is only a clipped start of the prompt's own nonce is not a leak. |
| `resources` | After the run's own report has been reduced to verdicts and the heap fully collected, the JS heap is within 64 MiB plus 64 KiB per prompt of the baseline taken before the run (the base is the scenario's optional `resourceSlackMiB`), and handles, child processes and leftover state files and locks are back to the baseline. The resident set size is printed with it but does not decide the verdict: it includes memory the allocator has not returned. |
| `recovery` | The probe prompt, sent after the load with the faults off, plans from the model with nothing degraded; with a baseline, it takes no more than 1.25 times the baseline's probe time. |
| `persisted` | Every persisted state file parses. |
| `calls` | The provider calls per prompt stay inside the retry budget: one attempt plus the fill retries plus the single repair attempt per node, times three on the Omp path, and one per uplift or graph call and two per clarify call. |

## Pass criteria

A scenario passes when the command exits 0: all ten invariants pass, the score is 100, and, with `--pressure`, the `pressure` hypothesis passes as well. Any failing invariant is a regression to fix; do not rerun until it goes away. Faults make prompts degrade by design (the `stress` and `spike` fixtures inject them), so a degraded prompt is not a failure. A degraded stage that is not listed and shown is: that is the `degraded` invariant.

## CPU pressure

`--pressure` starts Bun Workers that spin in 10 ms duty-cycle slices (no new dependency), an optional memory ballast and an event-loop stall sampler. Unless the scenario names its own pressure, it uses every CPU at full duty and stops itself after 15 minutes at most. When the run ends it reports the CPU it actually achieved: process CPU time divided by wall time since the helper started.

The run fails with `pressure-not-applied: achieved CPU ratio <r> is below the floor 0.5` when the achieved ratio is under the floor. That figure is the host's, not the harness's: on a machine that is already loaded (a load average well above the CPU count, other agents building or testing) the workers get less than their share, and the helper cannot make the host deliver more. It means the pressure the run asked for was not applied, not that the pipeline failed. Rerun when the host is calmer, or run without `--pressure`: the gate scenarios are deterministic without it, and pressure runs are advisory but recorded. `pipeline run` takes no worker count or floor; to try other values, hold pressure with `pipeline pressure --workers N --floor R` and run the scenario in another shell.

`pipeline pressure --workers N --seconds S [--memory-mb M] [--floor R]` holds full-duty pressure for `S` seconds (at most 3600) so another job can run beside it, then prints `pressure held Ns: cpuMs … wallMs … ratio …`. It exits 0 when the ratio met the floor (default 0.5), and 2 with `pressure not applied` on stderr when it did not.

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

One row per scenario. Each value comes from the output of the command in the last column and the line `recorded seq <n> in <history path>` that it prints; the score, the probe outcome and the history entry are read back with `pipeline score <id>` or from that file. A row that has not been recorded yet names the command that produces it and says so; no number is estimated here.

| Scenario | Prompts | Concurrency | Faults | Score | Probe outcome | History | Produced by |
|---|---|---|---|---|---|---|---|
| `smoke` | 50 | 5 | none | not yet recorded | not yet recorded | not yet recorded | `bun run chaos -- pipeline run smoke` |
| `nominal` | 500 | 25 | none | not yet recorded | not yet recorded | not yet recorded | `bun run chaos -- pipeline run nominal` |
| `stress` | 2 000 | 100 | 429 on every 4th prompt's fills, 503 on every 5th prompt's first fill | not yet recorded | not yet recorded | not yet recorded | `bun run chaos -- pipeline run stress` |
| `spike` | 1 000 | 100 | slow then 429 on every 3rd uplift, garbage on every 7th graph | not yet recorded | not yet recorded | not yet recorded | `bun run chaos -- pipeline run spike` |
| `recovery` | 5 | 1 | none (probe batch after `nominal`) | not yet recorded | not yet recorded | not yet recorded | `bun run chaos -- pipeline run recovery`, after `nominal` |
