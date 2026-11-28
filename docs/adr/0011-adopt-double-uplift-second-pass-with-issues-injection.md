# ADR-0011. Adopt Double Uplift second pass with ISSUES injection

- **Status:** accepted
- **Date:** 2026-11-23
- **Deciders:** A03
- **Task:** Tdde6-arch

## Context and Problem Statement

TBD — describe the forces at play.

## Decision Drivers

- TBD

## Considered Options

- Run GoT graph, per-node CoT, first uplift XML, tracker completion, ISSUES injection, second full uplift, final XML prompt at 500+ lines; prompts total 1+N+2=10 at N=7; keep PR261 full-prompt-beneath with 0 truncation and 0 dispatch before final prompt

## Decision Outcome

Chosen option: "Run GoT graph, per-node CoT, first uplift XML, tracker completion, ISSUES injection, second full uplift, final XML prompt at 500+ lines; prompts total 1+N+2=10 at N=7; keep PR261 full-prompt-beneath with 0 truncation and 0 dispatch before final prompt".

### Positive Consequences

- TBD

### Negative Consequences

- TBD

## Consequences

TBD — note follow-up tasks for A05/A06/A07/A11.
