# ADR-0001. Hold the Omp primary session outside the handler cap

- **Status:** accepted
- **Date:** 2026-11-16
- **Deciders:** A03
- **Task:** Tab6a-arch

## Context and Problem Statement

US-1 requires the primary Omp session to wait for one complete uplift before work begins. A stall from 300000 ms to 600000 ms is intended progress, not a timeout failure. src/host/omp.ts lines 6-8 and 1447 race delivery at 25000 ms and inject a pending note because the host drops a handler result after 30s. A pending note is not the start of work.

## Decision Drivers

US-1; AC-1 to AC-5; NFR-P1; NFR-A1; NFR-I1; assumption A-6; no minimum delay; subagent sessions stay outside US-1.

## Considered Options

- Block inside before_agent_start for 600000 ms
- Keep the 25000 ms pending note and aside
- Session gate that returns before the host cap and releases one work turn only with a complete uplift

## Decision Outcome

Chosen option: "Return from before_agent_start before the 30s host cap, do not inject a pending note, and release the first work turn only when one complete uplift is in context, or record UPLIFT_WAIT_EXCEEDED at 600001 ms with zero work turns.".

### Positive Consequences

- A stall of 300000 ms to 600000 ms stays a progress status. A complete uplift before 300000 ms is still success. The host 30s handler cap is not raised.

### Negative Consequences

- The handler cannot block for 10 minutes. A05 must release the work turn by a later delivery, not by awaiting inside before_agent_start past 30s.

## Consequences

A05 changes delivery in src/host/omp.ts only. maxRunMs stays 0. The 600000 ms bound is a gate clock, not a planner timeout. A complete uplift before 300000 ms is success.
