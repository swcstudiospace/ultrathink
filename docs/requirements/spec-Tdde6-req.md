# Requirements Spec: Dense 500-line XML Prompts via Double Uplift (Tdde6-req)

Correlation: `dde6accb-e288-424f-8913-cb429e5f88ef`
Version: 1.0.0
Status: VALIDATED (PII clean, ambiguity 0.0, INVEST 6/6, GWT missing 0, manual 0%, traceability 100%, NFR complete; see handover for tool evidence)
Source brief: Restore dense 500-line XML prompts via Double Uplift.

## 1. Measured evidence (do not assume)

- Session XMLs at `/root/.omp/agent/ultrathink/sessions/*.xml`: 263 files, min 51 lines, median 327, max 1464; only 35 of 263 are 500+ lines and 177 are under 400. Older sessions ran about 520+ lines and current ones rebuild around 300; the measured median 327 confirms the loss is system-wide, not a single bad sample.
- Older branches: `backup/local-main-pre-restore` (e461875) carries 93 changed files vs main, mostly the services tree plus `src/host/omp-ui.test.ts`; `backup/pr53-guards` (fadf28f) changes only `plugins/omp-token-opt` bench and parity test. Neither branch holds a denser prompt set, so the loss is in the current pipeline stages, not in a missing older file: FR-1 measures each stage (graph fill, CoT fill, uplift, graph injection) with line counts before changing any stage.
- Current pipeline (`src/think/pipeline.ts` `runThink`, 527 lines): buildGraph (1 prompt) + fillNode per graph node (5-8 CoT prompts, 7 default) + uplift (1 prompt) = 1+7+1 = 9 prompts. The second uplift pass is the documented 10th prompt: 1 graph + 7 node chains + 2 uplifts = 10. FR-4 requires this accounting to be written down where a reader can find it.
- `src/uplift/xml.ts` (164 lines) already enforces required children (SYSTEM_ROLE, CONTEXT/APP_CONTEXT, SCOPE, CONSTRAINTS, ACCEPTANCE_CRITERIA) and `src/uplift/prompt.ts` (62 lines) sets the density bar. `src/host/omp-render.ts` line 1208 documents the full prompt section beneath the plan summary and `src/host/omp-render.panels.test.ts` lines 184-209 pin it. PR #261 behavior is therefore a frozen constraint: FR-6 keeps it.

## 2. Functional requirements

### FR-1 — Measure before changing
Each pipeline stage emits and records its line count (graph nodes, per-node rationale/conclusion, uplift XML, final injected XML) so the stage where density drops is named with numbers in 1 sample run. Verified by the density-loss criterion in `docs/acceptance.md`.

### FR-2 — Double Uplift sequence
The normal-mode run order is: GoT graph -> per-node CoT (5-8 steps each, MIN_STEPS 5 / MAX_STEPS 8) -> first uplift XML with rationales -> tracker completion (Linear Issues/Sub-Issues authoritative, Notion rows linked) -> ISSUES injected into the XML -> second full uplift over the enriched XML -> final XML-tagged prompt. Verified by the second-uplift criterion in `docs/acceptance.md`.

### FR-3 — Final density bar
The final prompt in normal mode carries about 500 or more lines of XML, preserves 100% of node rationales and conclusions, and carries the Linked-issues references. Verified by the density criterion in `docs/acceptance.md`.

### FR-4 — 10th-prompt accounting
The prompt-count accounting (1 graph + 7 node chains + 2 uplifts = 10 at defaults; 1 + N + 2 for N in 5..8) is documented in code and in the final prompt's accounting line, naming provider-limit and cost implications. Verified by the accounting criterion in `docs/acceptance.md`.

### FR-5 — No pre-final dispatch
No specialist or swarm dispatch starts before the final prompt lands. Verified by the dispatch-gate criterion in `docs/acceptance.md`.

### FR-6 — PR #261 presentation preserved
In normal mode the complete final prompt renders in one section beneath the plan summary with 100% of characters preserved and 0 truncation; tracker links render per node. Verified by the presentation criterion in `docs/acceptance.md`.

### FR-7 — Trackers and merge
Linear (authoritative) and Notion rows for this work are updated through the gateway with 1 evidence comment per closed row; `bun run check`, test, lint, and knip are green; 1 pull request to main exists with CI green before merge. Verified by the closure criterion in `docs/acceptance.md`.

## 3. Non-functional requirements

NFR-23 (perf), NFR-24 (security), NFR-25 (a11y), NFR-26 (i18n), NFR-27 (compliance): see `docs/requirements/nfr.md`. Each carries a numeric target and a named verifier; unmeasurable NFRs are rejected, never published.

## 4. Verification contract

`bun run check` (tsc), `bun test`, `bun run lint` (biome), and `knip` are green on the branch; sample final XML line count (about 500) is cited in the pull request; CI is green before merge. No latency SLO is claimed for the planning run itself: duration is bounded by model and tracker behaviour, not by this change.

## 5. Assumptions and open questions

- A1 (recorded): the brief's "Defaults 1+7+1=9" matches the code (1 graph + 7 CoT at defaults + 1 uplift); the 10th prompt is the second uplift. If a different 10th prompt was intended, a `requirements.change` is required.
- A2 (recorded): "about 500 lines" means 500 or more lines for the final XML in normal mode, not exactly 500.
- A3 (recorded): Linear stays authoritative for issue state; Notion mirrors links. If Michael wants Notion authoritative, a `requirements.change` is required.
- OQ1: which Linear/Notion issue set carries this work is owned by A01 dispatch; FR-7 requires gateway closure for whatever set is assigned, 0 bypass writes.

## 6. Out of scope

Architecture design (A03), product code (A05/A06), schema and migrations (A07), release execution (A12). This spec defines what and how well only.

## 7. Traceability

Stories US-024..US-030 in `docs/requirements/stories.md`; 7 acceptance criteria in `docs/acceptance.md`; NFR-23..NFR-27 in `docs/requirements/nfr.md`; links in `docs/requirements/traceability.md`. MoSCoW priority (7 stories, at or under 20): Must US-024, US-025, US-026, US-028, US-029, US-030; Should US-027. WSJF supplementary order: US-024, US-027, US-028, US-029, US-025, US-026, US-030.
