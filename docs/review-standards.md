# Review standards — Tab6a

- Kind: `review.standards`
- Version: 1.0.0
- Task: `Tab6a-arch`
- Correlation: `ab6a76d6-3e64-4867-8476-b7acb5c4dee0`
- Owner: A03
- Consumer: A09
- Path note: no path was named in the assignment. This file is `docs/review-standards.md` by the A03 convention.

These rules restate ADR-0001, ADR-0002, ADR-0003, and the blueprint. They are not new decisions.

The layer proof and the cycle proof are fixtures, not the design graph. `arch_layer_violations` on one allowed edge and one upward edge returned `violation_count: 1` and `violations: ["secret-scan (core) -> omp-session-gate (host)"]`. `arch_cycle_check` on a two-module loop returned `has_cycle: true` and `cyclic_components: ["model-router, tot-prd"]`.

## RS-1 Layer order

Rationale: blueprint section 3. Check: modules depend only on the same layer or a later layer. Order is `host`, `workflow`, `core`. An upward edge is a defect. The fixture above is the expected failure shape.

## RS-2 No cycles

Rationale: blueprint fitness section. Check: the eight design modules have no cycle. A two-module loop is a defect, as the fixture shows.

## RS-3 Fan-out budget

Rationale: blueprint. Check: no container relates to more than 4 other containers. Observed design maximum is 3.

## RS-4 Session gate

Rationale: ADR-0001. Check: a plannable primary Omp prompt does not return `pendingMessage()`, does not raise `raceMs` above 25000, does not set `maxRunMs` as the wait, and does not record `UPLIFT_WAIT_EXCEEDED` as a timeout failure. A complete uplift before 300000 ms is success.

## RS-5 PRD and models

Rationale: ADR-0002. Check: Chain-of-Thought sub-issue rows remain. The PRD count is 0 until Tree-of-Thought finishes. Graph-of-Thought and Chain-of-Thought use the selected model. Tree-of-Thought uses the cheapest priced callable model. No new price client is added.

## RS-6 Connection set

Rationale: ADR-0003. Check: the required id set is the 18 CLI ids. `vscode` is not required. `gemini` returns `GSD_RETIRED_RUNTIME`. `pi` and `omp` are distinct. A missing entry is `PLUGIN_AGENT_MISSING`, not `connected`.

## RS-7 Ship gate

Rationale: US-4 and assumption A-3. Check: Execute stays at 0 while a blocking clarification is unanswered or no complete uplift exists. Ship stays at 0 until 1 operator confirmation after Verify.

## RS-8 Secrets

Rationale: NFR-S1 and NFR-C1. Check: delivered uplift XML and each Code Blocked PRD have 0 secret-scan matches. A match is not waivable by A09. Route it to A10.

## RS-9 Contract pin

Rationale: contract 1.0.0. Check: consumers use `contracts/ultrathink-plugin-tab6a.openapi.json` at the digest A03 publishes. Do not add a public HTTP server for that file.

## RS-10 Error codes

Rationale: NFR-I1. Check: `UPLIFT_WAIT_EXCEEDED`, `PRD_NO_PRICE`, `PRD_NO_SELECTED_MODEL`, and `PLUGIN_AGENT_MISSING` stay byte-identical ASCII tokens matching `[A-Z0-9_]{1,40}`. Operator prose is not concatenated into them.
