# Requirements Spec: Swarm×Ultrathink Race — Force-Injection, Force-Stop, Order Gate (Tdfe6-req)

Correlation: `dfe6b075-b574-47af-9556-0c7845221d85`
Version: 1.0.0
Status: VALIDATED (PII clean, ambiguity 0.25, INVEST 6/6, GWT missing 0, manual 0%, traceability 100%, NFR complete; evidence in handover)
Source brief: `docs/requirements/brief-Tdfe6-req.md`. This spec states what and how well only: no architecture, code, schema, or schedule.

## 1. Measured evidence: where the plan is lost (root assumption, proven from code)

- Single prompt entry: `pi.on("before_agent_start", ...)` in `src/host/omp.ts` (line 4037). It awaits Swarm auto-run (`maybeAutoRun`, line 4065) before creating any planning flight (`launchPlan`, line 4090). When a lane starts, `if (lane) return;` (line 4074) returns without a plan, and `autoRunSpawn` cancels the pending flight with `SUPERSEDED` and arms the quick suppression (lines 3787–3793). The uplift therefore never runs or is cancelled on the exact prompts that need it.
- Late plans depend on one channel: when planning is unsettled at the race deadline, the flight is `deferred` and the turn starts immediately (lines 4152–4156, 4166–4181); the whole plan then follows as exactly one `aside` message. A replaced, cancelled, or superseded flight "delivers nothing" (lines 1895–1896, 1995–2006), and session switch/shutdown cancels every flight (`SESSION_ENDED`, lines 2015–2032). A new prompt starts a new flight that supersedes the old one, so the late aside for the old plan is suppressed — the plan lands in a dead channel.
- Swarm dispatch is otherwise uncapped by planning: `filterSpawnable` + `spawnGuarded` run inside `autoRunSpawn` (lines 3763–3773) with no check that any uplift has landed. Skips are silent ("Every skip is silent", lines 3702–3713), and a failed spawn is swallowed (`return false`, lines 3795–3798).
- Claude host (`src/claude/hook.ts`): the plan reaches the session only as `hookSpecificOutput.additionalContext` on the one `UserPromptSubmit` response (line 142). There is no retry channel if that single delivery is missed.
- Conclusion: the plan is lost at the conjunction of (a) auto-run winning the `before_agent_start` ordering, (b) the single deferred-aside delivery being cancelled on supersede/switch, and (c) no order gate between dispatch and injection. The fix must attack all three, not one.

## 2. Functional requirements

### FR-1 — Force-injection independent of orchestration
On uplift completion, the full uplifted prompt reaches the session chat with 100% of its characters and updates the TODO list, regardless of orchestration state, retrying on failure with each attempt logged. Verified by AC-60 and AC-61 in `docs/acceptance.md`.

### FR-2 — No silent loss
Every delivery outcome is one named state from the closed set {injected, retrying, drained, timed-out, dropped-with-reason}; an outcome of dropped-with-reason names the reason in the log within 1 attempt of the retry budget ending. Verified by AC-62 and AC-69.

### FR-3 — Force-stop with bounded graceful drain
A new user prompt stops or cleanly finishes running orchestration within a 30-second drain bound, with 0 kills of in-flight writes; when the bound elapses, 1 timed-out state is recorded and the new prompt proceeds. Verified by AC-63 and AC-64.

### FR-4 — Order gate (hard rule)
Subagent dispatch stays at 0 until the injection confirmation for that prompt exists, with 1 held reason recorded per refused attempt; after confirmation, dispatch proceeds. Verified by AC-65 and AC-66.

### FR-5 — Race pinned by automated checks
The mid-flight completion and new-prompt-during-uplift scenarios each run as automated race checks asserting 1 injected prompt, 1 drained orchestration, and 0 lost plans. Verified by AC-67 and AC-68.

## 3. Non-functional requirements

NFR-28 (perf), NFR-29 (security), NFR-30 (a11y), NFR-31 (i18n), NFR-32 (compliance) in `docs/requirements/nfr.md`. Each carries a numeric target and a named verifier; unmeasurable NFRs are rejected, never published.

## 4. Verification contract

`bun run check`, `bun test`, biome, and knip are green on the branch; the two race scenarios are cited with their counts in the pull request; CI is green before merge. No latency SLO is claimed for the uplift itself: duration stays bounded by model and tracker behaviour, not by this change.

## 5. Assumptions and open questions

- A1: the brief tail "no prompt" is read as "no prompt loss" (see cleaned brief). If a different tail was intended, a `requirements.change` is required.
- A2: the 30-second drain bound and the closed state set are assumptions of this spec; A03 may tighten the bound, never remove it.
- OQ1: which Linear/Notion rows carry this work is owned by A01 dispatch; tracker closure requires gateway evidence for whatever set is assigned, 0 bypass writes.

## 6. Out of scope

Architecture design (A03), product code (A05/A06), schema and migrations (A07), release execution (A12).

## 7. Traceability

Stories US-031..US-036 in `docs/requirements/stories.md`; 10 acceptance criteria (AC-60..AC-69) in `docs/acceptance.md`; NFR-28..NFR-32 in `docs/requirements/nfr.md`; links in `docs/requirements/traceability.md`. MoSCoW (6 stories, at or under 20): Must US-031, US-032, US-033, US-034, US-035; Should US-036. WSJF supplementary order: US-034, US-036, US-032, US-031, US-033, US-035.
