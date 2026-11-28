# ADR-0007. Wire Omp panels to existing stores via TurnPanels

- **Status:** accepted
- **Date:** 2026-11-23
- **Deciders:** A03
- **Task:** T836d-arch

## Context and Problem Statement

AC-44 requires 5 panels with live rows from real stores, 0 stubs. TurnPanels already models exactly these 5 (turn-panels.ts). Planner lookups exist (hook.ts) but panels are gated by panels.informationPanels.

## Decision Drivers

AC-43 AC-44; NFR-19 NFR-20 NFR-21; no new stores

## Considered Options

- reuse TurnPanels with flag on
- build new panel stores
- hardcode fixture rows

## Decision Outcome

Chosen option: "Render Substrate Knowledge Skills Lessons Teachable Moments via existing TurnPanels adapters (substrateBriefToPanel knowledgeLookupToPanel skillsLookupToPanel lessonsLookupToPanel momentsLookupToPanel) fed by fetchBrief Greptile teach recall; no stub panels".

### Positive Consequences

- Five real-store panels (AC-44) with honest empty states, 0 stubs
- Second full-prompt section satisfies AC-43 without changing the existing section

### Negative Consequences

- Panels depend on planner lookups having run; absent lookups show empty state, not fabricated rows

## Consequences

Second full-prompt section added beneath existing section in omp-render; panels show live rows or honest empty states; secret-scan 0; kickoff retains tracker row creation
