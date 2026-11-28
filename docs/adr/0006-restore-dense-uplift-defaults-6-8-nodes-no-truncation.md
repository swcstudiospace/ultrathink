# ADR-0006. Restore dense uplift defaults 6-8 nodes no truncation

- **Status:** accepted
- **Date:** 2026-11-23
- **Deciders:** A03
- **Task:** T836d-arch

## Context and Problem Statement

Brief requires 6-8 nodes, per-node 5-8 steps, 9 prompts, no truncation in normal mode (AC-41 AC-42 NFR-18). Current MIN_NODES=5 and prompt text say 5-8. config.uplift.maxChars already defaults to 0 meaning no limit.

## Decision Drivers

AC-41 AC-42; NFR-18 3000ms; keep existing Uplifted Prompt section unchanged

## Considered Options

- raise MIN_NODES to 6 and keep maxChars 0
- raise maxChars to a positive ceiling
- leave defaults unchanged

## Decision Outcome

Chosen option: "MIN_NODES 5 to 6, GRAPH_SYSTEM_PROMPT 5-8 to 6-8 nodes, keep MIN_STEPS 5 MAX_STEPS 8, keep uplift maxChars 0 (no truncation) so dense 9-prompt output never truncates by default".

### Positive Consequences

- Dense graph by default, matches AC-41 (6-8 nodes, 5-8 steps, 9 prompts)
- No truncation in normal mode (maxChars 0), matches AC-42 (0 truncation markers)

### Negative Consequences

- Larger prompts cost more tokens; bounded by existing fill retry and flight throttle

## Consequences

Dense default bound to component budget think-pipeline.dense_plan_render_ms; explicit maxChars caps remain opt-in; test fixtures assert 6-8 nodes
