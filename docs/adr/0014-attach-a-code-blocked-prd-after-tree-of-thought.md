# ADR-0002. Attach a Code Blocked PRD after Tree-of-Thought

- **Status:** accepted
- **Date:** 2026-11-16
- **Deciders:** A03
- **Task:** Tab6a-arch

## Context and Problem Statement

US-2 adds a Code Blocked PRD after Chain-of-Thought. The term is assumption A-1. src/track/plan.ts already writes one Sub-Issue row per Chain-of-Thought step. No price catalog exists in this repository. A new pricing service would be novel infrastructure.

## Decision Drivers

US-2; AC-6 to AC-12; NFR-S1; NFR-C1; NFR-I1; assumptions A-1 and A-2.

## Considered Options

- Replace Chain-of-Thought rows with the PRD
- Call a new pricing API
- Attach the PRD only after Tree-of-Thought using a caller-supplied published price catalog

## Decision Outcome

Chosen option: "Keep existing Chain-of-Thought sub-issue rows and attach one Code Blocked PRD only after Tree-of-Thought finishes, using the selected model for Graph-of-Thought and Chain-of-Thought and the cheapest priced callable model for Tree-of-Thought.".

### Positive Consequences

- Existing Chain-of-Thought rows stay. The PRD is one extra document per node that had at least one recorded step. Tests can supply prices without a network call.

### Negative Consequences

- A model with no published input price is ignored. If none remain, zero PRDs are written and the code is PRD_NO_PRICE.

## Consequences

A05 adds the PRD beside existing sub-issue rows. Empty selected model yields PRD_NO_SELECTED_MODEL and zero PRDs. No priced callable model yields PRD_NO_PRICE and zero PRDs. No new network dependency.
